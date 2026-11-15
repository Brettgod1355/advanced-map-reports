// The receiver: takes reports from Advanced Map's optional setting, keeps them grouped in a D1 database, and once a
// day writes the grouped rows to docs/data/reports.json in the public repository, which the page shows.
// The owner signs in with GitHub on the page and sets each row's status there (GET /login, GET /callback, GET /rows,
// POST /status); nobody else can. GET /synced tells the page when the rows were last written.
// Needs: a D1 database bound as DB (schema.sql), the secrets SALT, GITHUB_TOKEN, GITHUB_CLIENT_ID and
// GITHUB_CLIENT_SECRET, and the variables GITHUB_REPO ("owner/name"), SITE and ADMIN_ID. See the README.
import { PER_DAY, SESSION_MILLIS, STATUSES, clean, day, file, key, mark, session, sessionId } from './reports.js';

const MAX_BODY = 512;
const FILE = 'docs/data/reports.json';

const AGENT = 'advanced-map-reports';
/** The cookie that ties a sign-in's return from GitHub to the browser that began it. */
const STATE = 'state';

const reply = (status, text, headers) => new Response(text, { status, headers: { 'content-type': 'text/plain', ...headers } });

/** Lets the page's scripts, and no other site's, call the owner's routes from a browser. */
const cors = (env) => ({
	'access-control-allow-origin': new URL(env.SITE).origin,
	'access-control-allow-headers': 'authorization, content-type',
	'access-control-allow-methods': 'GET, POST, OPTIONS',
	'access-control-max-age': '86400',
	vary: 'origin',
});

/** Back to the page with the outcome after its "#", which browsers keep to themselves: it is never sent to a server. */
const back = (env, outcome) => new Response(null, {
	status: 302,
	headers: {
		location: env.SITE + '#' + outcome,
		'set-cookie': STATE + '=; Max-Age=0; Path=/callback; HttpOnly; Secure; SameSite=Lax',
		'cache-control': 'no-store',
		'referrer-policy': 'no-referrer',
	},
});

/** Sends the browser to GitHub to say who it is. No permissions are asked for: only the account's public identity. */
function login(request, env) {
	if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
		return reply(503, 'sign-in is not set up');
	}
	const state = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
	const to = new URL('https://github.com/login/oauth/authorize');
	to.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
	to.searchParams.set('redirect_uri', new URL('/callback', request.url).href);
	to.searchParams.set('state', state);
	to.searchParams.set('allow_signup', 'false');
	return new Response(null, {
		status: 302,
		headers: {
			location: to.href,
			'set-cookie': STATE + '=' + state + '; Max-Age=600; Path=/callback; HttpOnly; Secure; SameSite=Lax',
			'cache-control': 'no-store',
		},
	});
}

/**
 * GitHub sends the browser back here. Its code is traded for a token, the token answers one question (which account
 * is this?) and is dropped: it is never stored or sent on. Only the owner's account gets a sign-in for the page.
 */
async function callback(request, env) {
	const url = new URL(request.url);
	const code = url.searchParams.get('code') || '';
	const state = url.searchParams.get('state') || '';
	const cookie = (request.headers.get('cookie') || '').split(/; */).find((c) => c.startsWith(STATE + '='));
	if (!code || !/^[0-9a-f]{32}$/.test(state) || !cookie || cookie.slice(STATE.length + 1) !== state) {
		return back(env, 'signin=failed');
	}
	const asked = await fetch('https://github.com/login/oauth/access_token', {
		method: 'POST',
		headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': AGENT },
		body: JSON.stringify({
			client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code,
			redirect_uri: new URL('/callback', request.url).href,
		}),
	});
	const token = asked.ok ? (await asked.json()).access_token : null;
	if (typeof token !== 'string' || !token) {
		return back(env, 'signin=failed');
	}
	const who = await fetch('https://api.github.com/user', {
		headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'user-agent': AGENT },
	});
	const id = who.ok ? (await who.json()).id : null;
	if (!Number.isInteger(id) || !env.ADMIN_ID || String(id) !== env.ADMIN_ID) {
		return back(env, 'signin=denied');
	}
	return back(env, 'session=' + await session(env.ADMIN_ID, Date.now() + SESSION_MILLIS, env.SALT));
}

/** True for a request carrying the owner's sign-in, still good. */
async function owner(request, env) {
	const header = request.headers.get('authorization') || '';
	const id = header.startsWith('Bearer ') ? await sessionId(header.slice(7), Date.now(), env.SALT) : null;
	return id !== null && id === env.ADMIN_ID;
}

/** The rows as they are right now, for the signed-in owner: the public file lags by up to half an hour. */
async function rows(env) {
	const { results } = await env.DB.prepare('SELECT * FROM jumps').all();
	return new Response(file(results), {
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(env) },
	});
}

/** Sets one row's status: { key, status }. The next half-hourly write puts it in the public file. */
async function setStatus(request, env) {
	const text = await request.text();
	let body = null;
	try {
		body = text.length <= MAX_BODY ? JSON.parse(text) : null;
	} catch (e) {
		body = null;
	}
	if (body === null || typeof body !== 'object' || typeof body.key !== 'string' || !STATUSES.includes(body.status)) {
		return reply(400, 'not a status', cors(env));
	}
	const done = await env.DB.prepare('UPDATE jumps SET status = ?2 WHERE key = ?1').bind(body.key, body.status).run();
	return reply(done.meta.changes > 0 ? 204 : 404, done.meta.changes > 0 ? null : 'no such row', cors(env));
}

async function take(request, env) {
	const text = await request.text();
	if (text.length > MAX_BODY) {
		return reply(413, 'too long');
	}
	let report;
	try {
		report = clean(JSON.parse(text));
	} catch (e) {
		report = null;
	}
	if (report === null) {
		return reply(400, 'not a report');
	}
	const now = Date.now();
	const today = day(now);
	// the address is used for this one-day mark and nothing else: it is never stored or logged
	const sender = await mark(request.headers.get('cf-connecting-ip') || '', today, env.SALT);
	const count = await env.DB.prepare(
		'INSERT INTO senders (day, mark, n) VALUES (?1, ?2, 1) ON CONFLICT (day, mark) DO UPDATE SET n = n + 1 RETURNING n')
		.bind(today, sender).first('n');
	if (count > PER_DAY) {
		return reply(429, 'enough for today');
	}
	const id = key(report);
	const fresh = await env.DB.prepare('INSERT OR IGNORE INTO seen (key, day, mark) VALUES (?1, ?2, ?3)')
		.bind(id, today, sender).run();
	const person = fresh.meta.changes > 0 ? 1 : 0;
	const { k, op, at, from, to, v } = report;
	await env.DB.prepare(
		`INSERT INTO jumps (key, k, id, op, ax, ay, ap, fx, fy, fp, tx, ty, tp, reports, people, first_day, last_day, version)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 1, ?14, ?15, ?15, ?16)
		 ON CONFLICT (key) DO UPDATE SET reports = reports + 1, people = people + ?14, last_day = ?15, version = ?16,
		 fx = ?8, fy = ?9, fp = ?10, tx = ?11, ty = ?12, tp = ?13`)
		.bind(id, k, report.id, op, at[0], at[1], at[2], from[0], from[1], from[2], to[0], to[1], to[2], person, today, v)
		.run();
	return reply(204, null);
}

/** Writes the grouped rows to the repository when they differ from what is there, and forgets old one-day marks. */
async function write(env) {
	const cutoff = day(Date.now() - 2 * 86400000);
	await env.DB.batch([
		env.DB.prepare('DELETE FROM seen WHERE day < ?1').bind(cutoff),
		env.DB.prepare('DELETE FROM senders WHERE day < ?1').bind(cutoff),
	]);
	const { results } = await env.DB.prepare('SELECT * FROM jumps').all();
	const text = file(results);
	const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${FILE}`;
	const headers = {
		authorization: `Bearer ${env.GITHUB_TOKEN}`,
		accept: 'application/vnd.github+json',
		'user-agent': 'advanced-map-reports',
	};
	const now = await fetch(url, { headers });
	let sha;
	if (now.ok) {
		const there = await now.json();
		sha = there.sha;
		const old = new TextDecoder().decode(Uint8Array.from(atob(there.content.replace(/\n/g, '')), (c) => c.charCodeAt(0)));
		if (old === text) {
			return 'unchanged';
		}
	} else if (now.status !== 404) {
		throw new Error(`reading ${FILE}: ${now.status}`);
	}
	const bytes = new TextEncoder().encode(text);
	let binary = '';
	for (const b of bytes) {
		binary += String.fromCharCode(b);
	}
	const put = await fetch(url, {
		method: 'PUT',
		headers,
		body: JSON.stringify({ message: `Reports: ${results.length} jumps (${day(Date.now())})`, content: btoa(binary), sha }),
	});
	if (!put.ok) {
		throw new Error(`writing ${FILE}: ${put.status}`);
	}
	return 'written';
}

/**
 * The half-hourly run: the file is written when the rows changed, and the moment is noted for the page's "Last
 * sync" (and "last changed", when it wrote). A run that fails notes nothing.
 */
async function publish(env) {
	const outcome = await write(env);
	const now = String(Date.now());
	const note = (name) => env.DB.prepare(
		'INSERT INTO meta (name, value) VALUES (?1, ?2) ON CONFLICT (name) DO UPDATE SET value = ?2').bind(name, now);
	await env.DB.batch(outcome === 'written' ? [note('synced'), note('changed')] : [note('synced')]);
	return outcome;
}

/** When the half-hourly run last finished and when it last wrote the file, for the page: { synced, changed }. */
async function synced(env) {
	const { results } = await env.DB.prepare('SELECT name, value FROM meta').all();
	const at = (name) => {
		const row = results.find((r) => r.name === name);
		return row ? Number(row.value) : null;
	};
	return new Response(JSON.stringify({ synced: at('synced'), changed: at('changed') }), {
		headers: { 'content-type': 'application/json', 'cache-control': 'max-age=60', ...cors(env) },
	});
}

export default {
	async fetch(request, env) {
		const { pathname } = new URL(request.url);
		if (request.method === 'POST' && pathname === '/report') {
			return take(request, env);
		}
		if (request.method === 'GET' && pathname === '/synced') {
			return synced(env);
		}
		if (request.method === 'GET' && pathname === '/login') {
			return login(request, env);
		}
		if (request.method === 'GET' && pathname === '/callback') {
			return callback(request, env);
		}
		if (pathname === '/rows' || pathname === '/status') {
			if (request.method === 'OPTIONS') {
				return new Response(null, { status: 204, headers: cors(env) });
			}
			if (!await owner(request, env)) {
				return reply(401, 'sign in', cors(env));
			}
			if (request.method === 'GET' && pathname === '/rows') {
				return rows(env);
			}
			if (request.method === 'POST' && pathname === '/status') {
				return setStatus(request, env);
			}
		}
		if (request.method === 'GET' && pathname === '/') {
			return reply(200, 'Advanced Map reports. The data is public: see the repository.');
		}
		return reply(404, 'not found');
	},
	async scheduled(event, env, ctx) {
		ctx.waitUntil(publish(env));
	},
};
