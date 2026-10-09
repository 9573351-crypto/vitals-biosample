-- New-schema DDL fixture, transcribed verbatim from VitalsDbHelper.java:
--   SAMPLES_COLUMNS / RECORDS_COLUMNS constants, createTables() index statements,
--   ensureSchema() addColumn calls, and the records rebuild path (records_next).
-- Applied in the same order the implementation uses for a legacy (pre-v4-columns) database.
PRAGMA foreign_keys=OFF;

-- 1) samples: new photo columns via ALTER TABLE (ensureSchema addColumn)
ALTER TABLE samples ADD COLUMN photo_path TEXT;
ALTER TABLE samples ADD COLUMN photo_hash TEXT;
ALTER TABLE samples ADD COLUMN thumb TEXT;

-- 2) records: rebuild required because the new source column carries a CHECK constraint
DROP TABLE IF EXISTS records_next;
CREATE TABLE records_next (id INTEGER PRIMARY KEY AUTOINCREMENT, sample_id TEXT, sample_name TEXT NOT NULL DEFAULT '', time TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', barcode TEXT, slot INTEGER CHECK(slot IS NULL OR (typeof(slot)='integer' AND slot BETWEEN 1 AND 5)), status TEXT CHECK(status IS NULL OR status IN ('in','out')), task_id TEXT, operator TEXT, source TEXT CHECK(source IS NULL OR source IN ('manual','hardware','scanner','system')), type_code TEXT, extra_json TEXT NOT NULL DEFAULT '{}', FOREIGN KEY(sample_id) REFERENCES samples(sample_id) ON DELETE SET NULL);
INSERT INTO records_next (id,sample_id,sample_name,time,type,detail,barcode,slot,status,task_id,extra_json) SELECT id,sample_id,sample_name,time,type,detail,barcode,slot,status,task_id,extra_json FROM records;
DROP TABLE records;
ALTER TABLE records_next RENAME TO records;

-- 3) indexes
CREATE INDEX IF NOT EXISTS records_sample_time ON records(sample_id,time);
CREATE INDEX IF NOT EXISTS records_time ON records(time);
CREATE INDEX IF NOT EXISTS records_type_code ON records(type_code);
