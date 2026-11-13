-- One row for each jump reported: the thing used, where, and about where it leads (see key() in src/reports.js).
CREATE TABLE IF NOT EXISTS jumps (
	key TEXT PRIMARY KEY,
	k TEXT NOT NULL, id INTEGER NOT NULL, op INTEGER NOT NULL,
	ax INTEGER NOT NULL, ay INTEGER NOT NULL, ap INTEGER NOT NULL,
	fx INTEGER NOT NULL, fy INTEGER NOT NULL, fp INTEGER NOT NULL,
	tx INTEGER NOT NULL, ty INTEGER NOT NULL, tp INTEGER NOT NULL,
	reports INTEGER NOT NULL, people INTEGER NOT NULL,
	first_day TEXT NOT NULL, last_day TEXT NOT NULL, version TEXT NOT NULL
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
