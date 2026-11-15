import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import worker from '../src/index.js';
import { session } from '../src/reports.js';

const SITE = 'https://example.github.io/reports/';
const HOST = 'https://receiver.example';

/** A stand-in for the D1 database: the jumps rows, the meta notes, and only the statements these routes run. */
function database(rows, notes = {}) {
	const run = (sql, values) => {
		if (sql === 'UPDATE jumps SET status = ?2 WHERE key = ?1') {
			const row = rows.find((r) => r.key === values[0]);
			if (row) {
				row.status = values[1];
			}
			return { meta: { changes: row ? 1 : 0 } };
		}
		if (sql.startsWith('INSERT INTO meta (name, value) VALUES (?1, ?2)')) {
			notes[values[0]] = values[1];
			return { meta: { changes: 1 } };
		}
		if (sql.startsWith('DELETE FROM seen') || sql.startsWith('DELETE FROM senders')) {
			return { meta: { changes: 0 } };
		}
		throw new Error('not expected: ' + sql);
	};
	const all = (sql) => {
		if (sql === 'SELECT * FROM jumps') {
			return { results: rows };
		}
		if (sql === 'SELECT name, value FROM meta') {
			return { results: Object.entries(notes).map(([name, value]) => ({ name, value })) };
		}
		throw new Error('not expected: ' + sql);
	};
	const statement = (sql, values = []) => ({
		bind: (...bound) => statement(sql, bound),
		run: async () => run(sql, values),
		all: async () => all(sql),
	});
	return { prepare: (sql) => statement(sql), batch: async (list) => Promise.all(list.map((s) => s.run())) };
}

const row = (key, status) => ({
	key, k: 'o', id: 1987, op: 1, ax: 2509, ay: 3493, ap: 0, fx: 2510, fy: 3494, fp: 0, tx: 2512, ty: 3481, tp: 0,
	reports: 1, people: 1, first_day: '2026-11-15', last_day: '2026-11-15', version: '1.2', status,
});

function setting(rows = []) {
	return {
		DB: database(rows), SALT: 'a long random secret', SITE, ADMIN_ID: '50088793',
		GITHUB_CLIENT_ID: 'client-id', GITHUB_CLIENT_SECRET: 'client-secret',
	};
}

const ask = (env, path, init) => worker.fetch(new Request(HOST + path, init), env);
const signedIn = async (env, id = '50088793', until = Date.now() + 60000) => ({
	authorization: 'Bearer ' + await session(id, until, env.SALT),
});

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

/** GitHub's two answers: the code traded for a token, and whose token it is. */
function github(id, seen = []) {
	globalThis.fetch = async (url, init) => {
		seen.push({ url: String(url), init });
		if (String(url) === 'https://github.com/login/oauth/access_token') {
			return Response.json({ access_token: 'gho_onetime' });
		}
		assert.equal(String(url), 'https://api.github.com/user');
		assert.equal(init.headers.authorization, 'Bearer gho_onetime');
		return Response.json({ id, login: 'whoever' });
	};
	return seen;
}

test('the owner\'s routes turn away everyone without the owner\'s sign-in', async () => {
	const env = setting([row('a', '')]);
	for (const headers of [
		{},
		{ authorization: 'Bearer nonsense' },
		// another account's sign-in, were one ever made; one that ran out; one signed with another secret
		await signedIn(env, '12345'),
		await signedIn(env, '50088793', Date.now() - 1),
		{ authorization: 'Bearer ' + await session('50088793', Date.now() + 60000, 'another secret') },
	]) {
		assert.equal((await ask(env, '/rows', { headers })).status, 401, JSON.stringify(headers));
		const post = await ask(env, '/status', { method: 'POST', headers, body: '{"key":"a","status":"ignored"}' });
		assert.equal(post.status, 401);
	}
	assert.equal((await env.DB.prepare('SELECT * FROM jumps').all()).results[0].status, '');
});

test('the half-hourly run notes when it synced, and when it last wrote', async () => {
	const env = { ...setting([row('a', 'added')]), GITHUB_REPO: 'someone/reports', GITHUB_TOKEN: 'token' };
	const times = async () => (await ask(env, '/synced')).json();
	assert.deepEqual(await times(), { synced: null, changed: null });

	// nothing in the repository yet: the file is written, with the row's status and key in it
	let stored = null;
	const puts = [];
	globalThis.fetch = async (url, init = {}) => {
		assert.equal(String(url), 'https://api.github.com/repos/someone/reports/contents/docs/data/reports.json');
		if (init.method === 'PUT') {
			stored = JSON.parse(init.body).content;
			puts.push(stored);
			return Response.json({});
		}
		return stored === null ? new Response('', { status: 404 }) : Response.json({ sha: 'abc', content: stored });
	};
	const run = async () => {
		const waited = [];
		await worker.scheduled({}, env, { waitUntil: (work) => waited.push(work) });
		await Promise.all(waited);
	};
	await run();
	assert.equal(puts.length, 1);
	const written = JSON.parse(atob(puts[0]));
	assert.deepEqual([written[0].key, written[0].status], ['a', 'added']);
	const first = await times();
	assert.ok(first.synced > 0 && first.changed === first.synced);

	// the same rows half an hour later: nothing is written, the sync is noted, the last change stays
	await new Promise((done) => setTimeout(done, 5));
	await run();
	assert.equal(puts.length, 1);
	const second = await times();
	assert.ok(second.synced > first.synced);
	assert.equal(second.changed, first.changed);

	// a run that cannot reach the repository notes nothing
	globalThis.fetch = async () => new Response('', { status: 500 });
	await assert.rejects(run());
	assert.deepEqual(await times(), second);
});

test('the signed-in owner reads the rows as they are and sets a status', async () => {
	const env = setting([row('a', ''), row('b', 'investigating')]);
	const headers = await signedIn(env);
	const live = await ask(env, '/rows', { headers });
	assert.equal(live.status, 200);
	assert.equal(live.headers.get('access-control-allow-origin'), 'https://example.github.io');
	assert.deepEqual((await live.json()).map((r) => [r.key, r.status]), [['a', ''], ['b', 'investigating']]);

	const set = (body) => ask(env, '/status', { method: 'POST', headers, body: JSON.stringify(body) });
	assert.equal((await set({ key: 'a', status: 'added' })).status, 204);
	assert.equal((await set({ key: 'b', status: '' })).status, 204);
	assert.deepEqual((await (await ask(env, '/rows', { headers })).json()).map((r) => r.status), ['added', '']);
	// a status that is not one of the four, a row that is not there, and something that is no request at all
	assert.equal((await set({ key: 'a', status: 'done<script>' })).status, 400);
	assert.equal((await set({ key: 'a' })).status, 400);
	assert.equal((await set({ key: 'nowhere', status: 'added' })).status, 404);
	assert.equal((await ask(env, '/status', { method: 'POST', headers, body: 'x'.repeat(600) })).status, 400);
	// the browser's question before it sends the sign-in from the page
	const allowed = await ask(env, '/status', { method: 'OPTIONS' });
	assert.equal(allowed.status, 204);
	assert.match(allowed.headers.get('access-control-allow-headers'), /authorization/);
});

test('signing in goes to GitHub with a state the return must bring back', async () => {
	const env = setting();
	const sent = await ask(env, '/login');
	assert.equal(sent.status, 302);
	const to = new URL(sent.headers.get('location'));
	assert.equal(to.origin + to.pathname, 'https://github.com/login/oauth/authorize');
	assert.equal(to.searchParams.get('client_id'), 'client-id');
	assert.equal(to.searchParams.get('redirect_uri'), HOST + '/callback');
	// no permissions are asked for
	assert.equal(to.searchParams.get('scope'), null);
	const state = to.searchParams.get('state');
	assert.match(state, /^[0-9a-f]{32}$/);
	assert.match(sent.headers.get('set-cookie'), new RegExp('^state=' + state + '; .*HttpOnly; Secure; SameSite=Lax$'));
	// not set up yet: no trip to GitHub
	assert.equal((await ask({ ...env, GITHUB_CLIENT_SECRET: undefined }, '/login')).status, 503);
});

test('only the owner\'s account comes back signed in', async () => {
	const env = setting([row('a', '')]);
	const state = 'ab'.repeat(16);
	const back = (query, cookie) => ask(env, '/callback?' + query, { headers: cookie ? { cookie } : {} });

	const seen = github(50088793);
	const owner = await back('code=abc&state=' + state, 'other=1; state=' + state);
	assert.equal(owner.status, 302);
	const landed = owner.headers.get('location');
	assert.ok(landed.startsWith(SITE + '#session=50088793.'), landed);
	// GitHub's token is not in what the browser gets, and the sign-in opens the owner's routes
	assert.ok(!landed.includes('gho_onetime'));
	assert.equal(JSON.parse(seen[0].init.body).client_secret, 'client-secret');
	const headers = { authorization: 'Bearer ' + landed.slice(landed.indexOf('=') + 1) };
	assert.equal((await ask(env, '/rows', { headers })).status, 200);

	github(424242);
	const other = await back('code=abc&state=' + state, 'state=' + state);
	assert.equal(other.headers.get('location'), SITE + '#signin=denied');

	// a return that did not begin in this browser, or without a code: GitHub is not even asked
	const asked = github(50088793);
	for (const [query, cookie] of [
		['code=abc&state=' + state, null],
		['code=abc&state=' + state, 'state=' + 'cd'.repeat(16)],
		['code=abc&state=', 'state='],
		['state=' + state, 'state=' + state],
	]) {
		assert.equal((await back(query, cookie)).headers.get('location'), SITE + '#signin=failed', query);
	}
	assert.equal(asked.length, 0);
});
