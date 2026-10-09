-- Idempotent part of the schema upgrade: created with IF NOT EXISTS, mirrors
-- VitalsDbHelper.createTables() / ensureSchema() which run on every open.
-- The additive ALTER TABLE / records rebuild are guarded in Java by hasColumn() and only
-- run once, so they are NOT part of this idempotency fixture.
CREATE TABLE IF NOT EXISTS samples_v3_noop (x TEXT);
DROP TABLE IF EXISTS samples_v3_noop;
CREATE INDEX IF NOT EXISTS records_sample_time ON records(sample_id,time);
CREATE INDEX IF NOT EXISTS records_time ON records(time);
CREATE INDEX IF NOT EXISTS records_type_code ON records(type_code);
CREATE TABLE IF NOT EXISTS records_archive (id INTEGER PRIMARY KEY, sample_id TEXT, sample_name TEXT NOT NULL DEFAULT '', time TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', barcode TEXT, slot INTEGER, status TEXT, task_id TEXT, extra_json TEXT NOT NULL DEFAULT '{}', operator TEXT, source TEXT, type_code TEXT);
