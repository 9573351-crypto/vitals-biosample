#!/usr/bin/env pwsh
<#
  Independent schema/upgrade verification using the real sqlite3 binary.

  What it does:
    1) seeds a legacy v3 database from .local-ci/sqlite-check/v3-seed.sql (1 sample + 1 record);
    2) applies .local-ci/sqlite-check/new-ddl.sql - the new-schema DDL transcribed from
       VitalsDbHelper.java (SAMPLES_COLUMNS / RECORDS_COLUMNS constants, createTables() indexes,
       ensureSchema() addColumn calls, records rebuild via records_next);
    3) asserts resulting shape, preserved data, CHECK constraints, ISO normalization and archive path.

  Honest scope note: this is NOT a substitute for connectedDebugAndroidTest. It cannot exercise WAL,
  Android transaction semantics, or the Java-side photo externalization. It independently proves the
  schema DDL and migration SQL, which is the highest-risk part of this change set.
  The DDL is a hand-transcribed fixture (not regex-extracted) because the implementation builds some
  statements by string concatenation, so literal extraction silently truncates them.
#>
$ErrorActionPreference = 'Stop'
$sqlite = 'D:\download3\AndroidSdk\platform-tools\sqlite3.exe'
$work = Join-Path $PSScriptRoot 'sqlite-check'
$seedFile = Join-Path $work 'v3-seed.sql'
$ddlFile = Join-Path $work 'new-ddl.sql'
$db = Join-Path $work 'migrate.db'

foreach ($required in @($sqlite, $seedFile, $ddlFile)) {
    if (-not (Test-Path $required)) { throw "missing: $required" }
}
Remove-Item $db -Force -ErrorAction SilentlyContinue

function Query([string]$text) { (& $sqlite $db $text) -join "`n" }
function RunFile([string]$path) { & $sqlite $db ".read `"$path`"" }
$script:failed = 0
function Assert([string]$name, [bool]$cond, [string]$detail) {
    if ($cond) { Write-Host "PASS $name" } else { Write-Host "FAIL $name -- $detail"; $script:failed++ }
}
function WriteSql([string]$name, [string]$text) {
    $path = Join-Path $work $name
    [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
    return $path
}

RunFile $seedFile
Assert "legacy v3 database seeded (1 sample, 1 record)" ((Query "SELECT (SELECT COUNT(*) FROM samples)||'/'||(SELECT COUNT(*) FROM records);") -eq '1/1') "seed failed"
Assert "legacy schema has no photo_path" ((Query "SELECT COUNT(*) FROM pragma_table_info('samples') WHERE name='photo_path';") -eq '0') "unexpected"
Assert "legacy schema has no source" ((Query "SELECT COUNT(*) FROM pragma_table_info('records') WHERE name='source';") -eq '0') "unexpected"

RunFile $ddlFile

$samplesCols = @((Query "SELECT name FROM pragma_table_info('samples');") -split "`n")
foreach ($column in @('photo_path', 'photo_hash', 'thumb')) {
    Assert "samples new column $column present after upgrade" ($samplesCols -contains $column) ($samplesCols -join ',')
}
$recordsCols = @((Query "SELECT name FROM pragma_table_info('records');") -split "`n")
foreach ($column in @('operator', 'source', 'type_code')) {
    Assert "records new column $column present after upgrade" ($recordsCols -contains $column) ($recordsCols -join ',')
}
Assert "records keeps AUTOINCREMENT primary key" ((Query "SELECT COUNT(*) FROM pragma_table_info('records') WHERE name='id' AND pk=1;") -eq '1') "pk missing"
Assert "records rebuilt table keeps FK to samples" ([int](Query "SELECT COUNT(*) FROM pragma_foreign_key_list('records');") -ge 1) "fk missing"
Assert "records.slot bounds CHECK present" ((Query "SELECT sql FROM sqlite_master WHERE name='records';") -match 'slot BETWEEN 1 AND 5') "check missing"

$indexNames = (Query "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%';") -join ','
Assert "index records_time exists" ($indexNames -match 'records_time') $indexNames
Assert "index records_type_code exists" ($indexNames -match 'records_type_code') $indexNames

Assert "legacy sample row preserved through rebuild" ((Query "SELECT COUNT(*) FROM samples WHERE sample_id='S1';") -eq '1') "lost"
Assert "legacy record row preserved through table rebuild" ((Query "SELECT COUNT(*) FROM records WHERE sample_id='S1';") -eq '1') "lost"
Assert "record content preserved after rebuild" ((Query "SELECT detail FROM records WHERE sample_id='S1';") -eq 'legacy record') "content changed"
Assert "legacy base64 photo still in photo column (file move happens in Java)" ((Query "SELECT photo FROM samples WHERE sample_id='S1';") -match 'base64') "lost"
Assert "db_meta legacy_s_extra preserved" ((Query "SELECT value FROM db_meta WHERE key='legacy_s_extra';") -match 'samplesSeeded') "lost"
Assert "env history preserved in extra_json" ((Query "SELECT extra_json FROM samples WHERE sample_id='S1';") -match 'env') "lost"

RunFile (WriteSql 'iso.sql' "UPDATE records SET time=replace(time,' ','T') WHERE time LIKE '____-__-__ __:__';")
Assert "time normalized to ISO 8601" ((Query "SELECT time FROM records WHERE sample_id='S1';") -eq '2026-10-01T08:00') (Query "SELECT time FROM records;")

$rejected = $false
try { RunFile (WriteSql 'bad-source.sql' "UPDATE records SET source='bogus';") } catch { $rejected = $true }
Assert "source CHECK rejects invalid enum" $rejected "accepted (constraint missing?)"
RunFile (WriteSql 'good-source.sql' "UPDATE records SET source='hardware';")
Assert "source CHECK accepts valid enum" ((Query "SELECT source FROM records;") -eq 'hardware') "write failed"

RunFile (WriteSql 'archive.sql' "INSERT INTO records_archive (id,sample_id,sample_name,time,type,detail) SELECT id,sample_id,sample_name,time,type,detail FROM records; DELETE FROM records;")
Assert "oldest record can be moved into records_archive" ((Query "SELECT COUNT(*) FROM records_archive;") -eq '1') "archive failed"
Assert "records row removed after archiving" ((Query "SELECT COUNT(*) FROM records;") -eq '0') "delete failed"

# Idempotency: only the IF NOT EXISTS part of the upgrade is expected to be re-runnable
# (the additive ALTER TABLE / records rebuild are guarded by hasColumn() in Java and run once).
$again = $true
try { RunFile (Join-Path $work 'idempotent-ddl.sql') } catch { $again = $false }
Assert "re-applying idempotent DDL succeeds" $again "re-run failed"

Write-Host ""
Write-Host "TOTAL failed = $failed"
if ($failed -gt 0) { exit 1 }
