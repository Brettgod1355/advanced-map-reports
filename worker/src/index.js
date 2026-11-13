// The receiver: takes reports from Advanced Map's optional setting, keeps them grouped in a D1 database, and once a
// day writes the grouped rows to docs/data/reports.json in the public repository, which the page shows.
// Needs: a D1 database bound as DB (schema.sql), the secrets SALT and GITHUB_TOKEN, and the variable GITHUB_REPO
// ("owner/name"). See the README.
import { PER_DAY, clean, day, file, key, mark } from './reports.js';

const MAX_BODY = 512;
const FILE = 'docs/data/reports.json';

const reply = (status, text) => new Response(text, { status, headers: { 'content-type': 'text/plain' } });

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
async function publish(env) {
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

export default {
	async fetch(request, env) {
		const { pathname } = new URL(request.url);
		if (request.method === 'POST' && pathname === '/report') {
			return take(request, env);
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
