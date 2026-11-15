-- One row for each jump reported: the thing used, where, and about where it leads (see key() in src/reports.js).
CREATE TABLE IF NOT EXISTS jumps (
	key TEXT PRIMARY KEY,
	k TEXT NOT NULL, id INTEGER NOT NULL, op INTEGER NOT NULL,
	ax INTEGER NOT NULL, ay INTEGER NOT NULL, ap INTEGER NOT NULL,
	fx INTEGER NOT NULL, fy INTEGER NOT NULL, fp INTEGER NOT NULL,
	tx INTEGER NOT NULL, ty INTEGER NOT NULL, tp INTEGER NOT NULL,
	reports INTEGER NOT NULL, people INTEGER NOT NULL,
	first_day TEXT NOT NULL, last_day TEXT NOT NULL, version TEXT NOT NULL,
	-- what the owner marked it as on the page: '' new, 'investigating', 'added', 'ignored' (STATUSES in src/reports.js).
	-- A database made before 2026-11-15 gets the column with:
	--   ALTER TABLE jumps ADD COLUMN status TEXT NOT NULL DEFAULT '';
	status TEXT NOT NULL DEFAULT ''
);
-- Who reported a jump on a day, as a one-day mark (never the address): so one sender counts once a day for a jump.
-- Rows older than two days are deleted.
CREATE TABLE IF NOT EXISTS seen (
	key TEXT NOT NULL, day TEXT NOT NULL, mark TEXT NOT NULL,
	PRIMARY KEY (key, day, mark)
);
-- How many reports a sender posted on a day, by the same one-day mark. Deleted with the above.
CREATE TABLE IF NOT EXISTS senders (
	day TEXT NOT NULL, mark TEXT NOT NULL, n INTEGER NOT NULL,
	PRIMARY KEY (day, mark)
);
-- When the half-hourly run last finished ("synced") and last wrote the public file ("changed"), in milliseconds:
-- the page shows them as its "Last sync".
CREATE TABLE IF NOT EXISTS meta (
	name TEXT PRIMARY KEY, value TEXT NOT NULL
);
