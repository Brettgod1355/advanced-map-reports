// What a report must look like, how reports are grouped, and what is published. No network or storage here, so it
// can be tested with plain Node (worker/test).

/**
 * The plugin's trip rule: onto the other map, or more than this many tiles in one go (a run covers 2). Short ways
 * count too, like the Baxtorian Falls log raft's 13 tiles (was 24 until 2026-11-15).
 */
export const JUMP = 3;
/** The object or NPC used must be this near where the player stood. */
export const USED_REACH = 8;
/** One sender may post this many reports a day. */
export const PER_DAY = 60;
/**
 * What the owner marks a row as on the page: '' is new. The page hides "added" (the map has it now) and "ignored"
 * (not a way, or not one for the map) until they are asked for; a row keeps its status when it is reported again.
 */
export const STATUSES = ['', 'investigating', 'added', 'ignored'];
/** How long a sign-in lasts: 30 days. */
export const SESSION_MILLIS = 30 * 86400000;
/** The surface map's rows of regions (Advanced Map's MapArea.SURFACE); everything else is the other map. */
const SURFACE_ROWS = [30, 65];

const isInt = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
const isTile = (t) => Array.isArray(t) && t.length === 3 && isInt(t[0], 0, 16383) && isInt(t[1], 0, 16383)
	&& isInt(t[2], 0, 3);
const surface = (t) => (t[1] >> 6) >= SURFACE_ROWS[0] && (t[1] >> 6) <= SURFACE_ROWS[1];
const flat = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));

/**
 * A report as the plugin sends it, checked: { v, k, id, op, at, from, to }. Numbers only apart from the version, so
 * nothing typed by anyone can reach the public page. Returns the cleaned report, or null when it is not one.
 *   v     the plugin's version, "1.2" or "1.2.1"
 *   k     "o" an object was used, "n" an NPC
 *   id    its id in the game
 *   op    which of its menu options, 1 to 5
 *   at    its tile [x, y, plane]
 *   from  where the player stood [x, y, plane]
 *   to    where the player arrived [x, y, plane]
 */
export function clean(body) {
	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		return null;
	}
	const { v, k, id, op, at, from, to } = body;
	if (typeof v !== 'string' || !/^\d{1,3}(\.\d{1,3}){0,2}$/.test(v) || (k !== 'o' && k !== 'n')
		|| !isInt(id, 0, 200000) || !isInt(op, 1, 5) || !isTile(at) || !isTile(from) || !isTile(to)) {
		return null;
	}
	// a trip, begun beside what was used: anything else is not what the plugin sends
	const jumped = surface(from) !== surface(to) || flat(from, to) > JUMP;
	if (!jumped || surface(at) !== surface(from) || flat(at, from) > USED_REACH) {
		return null;
	}
	return { v, k, id, op, at: at.slice(), from: from.slice(), to: to.slice() };
}

/**
 * The row a report is counted on: the thing used, where it is, and about where it leads. An NPC walks, so its tile is
 * taken to the 8-tile square; arrivals scatter by a tile or two, so they are taken to the 8-tile square too.
 */
export function key(report) {
	const cell = (t) => `${t[0] >> 3},${t[1] >> 3},${t[2]}`;
	const at = report.k === 'n' ? cell(report.at) : report.at.join(',');
	return `${report.k}:${report.id}:${report.op}:${at}:${cell(report.to)}`;
}

/** The day a moment falls on, UTC, "2026-11-13". */
export function day(millis) {
	return new Date(millis).toISOString().slice(0, 10);
}

/**
 * A sender's mark for one day: a hash of the address, the day and a secret. It tells two reports of one day from the
 * same sender apart from two senders', cannot be turned back into the address, and is a different mark the next day.
 */
export async function mark(address, dayText, salt) {
	const bytes = new TextEncoder().encode(`${dayText}|${salt}|${address}`);
	const hash = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(hash)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A stored row as the public file shows it: no mark, no address, days and not times. Its key names the row when the
 * owner sets its status.
 */
export function published(row) {
	return {
		key: row.key, k: row.k, id: row.id, op: row.op,
		at: [row.ax, row.ay, row.ap], from: [row.fx, row.fy, row.fp], to: [row.tx, row.ty, row.tp],
		reports: row.reports, people: row.people, first: row.first_day, last: row.last_day, v: row.version,
		status: row.status || '',
	};
}

/** The public file: the most reported first, then the newest; always the same text for the same rows. */
export function file(rows) {
	const out = rows.map(published);
	out.sort((a, b) => b.people - a.people || b.reports - a.reports || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0)
		|| a.id - b.id || a.at.join().localeCompare(b.at.join()));
	return JSON.stringify(out, null, 1) + '\n';
}

const base64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
	.replace(/[+]/g, '-').replace(/[/]/g, '_').replace(/=+$/, '');

async function signature(text, secret) {
	const signer = await crypto.subtle.importKey('raw', new TextEncoder().encode('session|' + secret),
		{ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	return base64url(await crypto.subtle.sign('HMAC', signer, new TextEncoder().encode(text)));
}

/**
 * A sign-in for the page to keep: GitHub's numeric user id and the moment it runs out, signed with the receiver's
 * secret so that nobody else can make or change one. "50088793.1765000000000.<signature>".
 */
export async function session(id, until, secret) {
	if (!secret) {
		throw new Error('no secret to sign with');
	}
	const body = id + '.' + until;
	return body + '.' + await signature(body, secret);
}

/** Whose sign-in a token is: the user id, or null when it is not one of ours, was changed, or has run out. */
export async function sessionId(token, now, secret) {
	const parts = typeof token === 'string' ? token.split('.') : [];
	if (!secret || parts.length !== 3 || !/^[0-9]{1,20}$/.test(parts[0]) || !/^[0-9]{1,16}$/.test(parts[1])) {
		return null;
	}
	const want = await signature(parts[0] + '.' + parts[1], secret);
	if (want.length !== parts[2].length) {
		return null;
	}
	// every character is compared, so how long a wrong signature takes says nothing about where it went wrong
	let differ = 0;
	for (let i = 0; i < want.length; i++) {
		differ |= want.charCodeAt(i) ^ parts[2].charCodeAt(i);
	}
	return differ === 0 && Number(parts[1]) > now ? parts[0] : null;
}
