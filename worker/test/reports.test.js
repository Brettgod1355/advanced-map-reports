import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STATUSES, clean, day, file, key, mark, session, sessionId } from '../src/reports.js';

const good = { v: '1.2', k: 'o', id: 14880, op: 1, at: [3209, 3216, 0], from: [3210, 3216, 0], to: [3210, 9616, 0] };

test('a report is numbers in range and a real jump', () => {
	assert.deepEqual(clean(good), good);
	assert.deepEqual(clean({ ...good, extra: 'ignored', name: '<b>rude</b>' }), good);
	for (const bad of [
		null, [], 'text', { ...good, v: '1.2 <script>' }, { ...good, v: 12 }, { ...good, k: 'x' },
		{ ...good, id: -1 }, { ...good, id: 1.5 }, { ...good, id: '14880' }, { ...good, op: 0 }, { ...good, op: 6 },
		{ ...good, at: [3209, 3216] }, { ...good, to: [3210, 99999, 0] }, { ...good, from: [3210, 3216, 4] },
		// a walk or a run, not a trip
		{ ...good, to: [3213, 3219, 0] },
		// what was used is nowhere near where the player stood
		{ ...good, at: [3300, 3216, 0] },
	]) {
		assert.equal(clean(bad), null, JSON.stringify(bad));
	}
	// a long way on one map is a trip too (a boat), and so is a short one (a raft, a ferry of a few tiles)
	assert.notEqual(clean({ ...good, to: [3210 + 25, 3216, 0] }), null);
	assert.notEqual(clean({ ...good, to: [3214, 3216, 0] }), null);
});

test('reports of one way share a row', () => {
	assert.equal(key(good), 'o:14880:1:3209,3216,0:401,1202,0');
	// arriving a tile or two away is the same way
	assert.equal(key({ ...good, to: [3212, 9618, 0] }), key(good));
	assert.notEqual(key({ ...good, op: 2 }), key(good));
	assert.notEqual(key({ ...good, at: [3208, 3216, 0] }), key(good));
	// an NPC walks about: its tile is taken to the 8-tile square
	const npc = { ...good, k: 'n' };
	assert.equal(key({ ...npc, at: [3214, 3220, 0] }), key(npc));
});

test('a sender is one mark a day and another the next', async () => {
	const today = await mark('203.0.113.7', '2026-11-13', 'salt');
	assert.match(today, /^[0-9a-f]{24}$/);
	assert.equal(await mark('203.0.113.7', '2026-11-13', 'salt'), today);
	assert.notEqual(await mark('203.0.113.7', '2026-11-14', 'salt'), today);
	assert.notEqual(await mark('203.0.113.8', '2026-11-13', 'salt'), today);
	assert.notEqual(await mark('203.0.113.7', '2026-11-13', 'other'), today);
	assert.equal(day(Date.UTC(2026, 10, 13, 23, 59)), '2026-11-13');
});

test('the public file has no marks and the most reported first', () => {
	const row = (id, people, reports, last) => ({
		key: 'k', k: 'o', id, op: 1, ax: 1, ay: 2, ap: 0, fx: 3, fy: 4, fp: 0, tx: 5, ty: 6, tp: 0,
		reports, people, first_day: '2026-11-01', last_day: last, version: '1.2', mark: 'never shown',
	});
	const text = file([row(1, 1, 9, '2026-11-13'), row(2, 3, 3, '2026-11-02'), row(3, 1, 9, '2026-11-14')]);
	const rows = JSON.parse(text);
	assert.deepEqual(rows.map((r) => r.id), [2, 3, 1]);
	assert.deepEqual(Object.keys(rows[0]), ['key', 'k', 'id', 'op', 'at', 'from', 'to', 'reports', 'people', 'first', 'last', 'v',
		'status']);
	// a row from before statuses is new; a marked one says so
	assert.equal(rows[0].status, '');
	assert.equal(JSON.parse(file([{ ...row(1, 1, 1, '2026-11-13'), status: 'ignored' }]))[0].status, 'ignored');
	assert.deepEqual(rows[0].to, [5, 6, 0]);
	assert.ok(!text.includes('never shown'));
	assert.equal(file([]), '[]\n');
});

test('a sign-in is good for its account until it runs out, and cannot be made or changed without the secret', async () => {
	const until = Date.UTC(2026, 11, 15);
	const token = await session('50088793', until, 'secret');
	assert.match(token, /^50088793[.][0-9]+[.][0-9A-Za-z_-]{43}$/);
	assert.equal(await sessionId(token, until - 1, 'secret'), '50088793');
	assert.equal(await sessionId(token, until, 'secret'), null);
	assert.equal(await sessionId(token, until - 1, 'another'), null);
	// another account, or a later end, under the same signature
	const [id, end, sign] = token.split('.');
	assert.equal(await sessionId(['1', end, sign].join('.'), until - 1, 'secret'), null);
	assert.equal(await sessionId([id, String(until * 2), sign].join('.'), until - 1, 'secret'), null);
	for (const bad of [null, undefined, 42, '', 'a.b.c', id + '.' + end, id + '.' + end + '.', token + 'x']) {
		assert.equal(await sessionId(bad, until - 1, 'secret'), null, String(bad));
	}
	// no secret set on the receiver: nothing is signed with a guessable one, and nothing passes
	await assert.rejects(session('50088793', until, undefined));
	assert.equal(await sessionId(token, until - 1, undefined), null);
	assert.equal(await sessionId(token, until - 1, ''), null);
	assert.deepEqual(STATUSES, ['', 'investigating', 'added', 'ignored']);
});
