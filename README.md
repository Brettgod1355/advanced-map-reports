# Advanced Map reports

Ways around Old School RuneScape that players took and that the [Advanced Map](https://github.com/Brettgod1355/Advanced-Map)
plugin for RuneLite has no transport for yet, collected from players who turn on the plugin's optional
"Report missing transports" setting. The grouped reports are public: see the page this repository serves, or
[`docs/data/reports.json`](docs/data/reports.json).

## What is collected

A report is seven numbers and the plugin's version:

| Field | Meaning |
|---|---|
| `k` | `o` an object was used, `n` an NPC |
| `id` | its id in the game |
| `op` | which of its menu options, 1 to 5 |
| `at` | its tile: x, y, floor |
| `from` | the tile the player stood on |
| `to` | the tile the player arrived at |
| `v` | the plugin's version |

No name, no account id and nothing typed is sent. The receiver sees the sender's IP address, as any website does.
It uses the address only to make a mark that lasts one day, so that one sender counts once a day for a way and
cannot post more than 60 reports a day. The address is never stored or logged, and the marks are deleted after two
days. Names and menu options on the page are looked up from the game's data by id (`docs/data/names.json`).

The setting is off by default and warns before it turns on.

## How it works

- `worker/`: a Cloudflare Worker. `POST /report` checks a report (`src/reports.js`), counts it on its row in a D1
  database (`schema.sql`), and once a day writes the rows to `docs/data/reports.json` in this repository.
- `docs/`: the page GitHub Pages serves. It reads `data/reports.json` and `data/names.json`.

Nothing reported is added to the map by itself: a row is checked against the game before it becomes a transport.

## Setting it up

1. Make this repository public and turn on GitHub Pages for the `main` branch, folder `/docs`.
2. In `worker/`: `npx wrangler d1 create advanced-map-reports`, put the id it prints in `wrangler.toml`, then
   `npx wrangler d1 execute advanced-map-reports --remote --file=schema.sql`.
3. Make a fine-grained GitHub token that can write the contents of this one repository and nothing else, then
   `npx wrangler secret put GITHUB_TOKEN`. Make up a long random text and `npx wrangler secret put SALT`.
4. Check `GITHUB_REPO` in `wrangler.toml`, then `npx wrangler deploy`. The address it prints, with `/report` on
   the end, is where the plugin sends.

## Tests

`cd worker && npm test` (Node 20 or newer; nothing to install). They cover the checks, the grouping and the public
file. The parts that talk to the database and to GitHub are not covered by tests.

## The names file

`docs/data/names.json` holds each named object's and NPC's name and menu options by id, read from the game's
cache. It is written again when the game adds things; an id it does not have shows as "id 12345" on the page.
The names and options are Jagex's; everything else here is under the license in `LICENSE`.
