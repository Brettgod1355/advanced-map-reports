# Advanced Map reports

Ways around Old School RuneScape that players took and that the [Advanced Map](https://github.com/Brettgod1355/Advanced-Map)
plugin for RuneLite has no transport for yet, collected from players who turn on the plugin's optional
"Report missing transports" setting. The grouped reports are public: see the page this repository serves, or
[`docs/data/reports.json`](docs/data/reports.json).

Website showing data found missing from the map:
https://brettgod1355.github.io/advanced-map-reports/

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
  database (`schema.sql`), and every half hour writes the rows to `docs/data/reports.json` in this repository when
  they changed.
- `docs/`: the page GitHub Pages serves. It reads `data/reports.json` and `data/names.json`, and asks the Worker
  when it last synced (`GET /synced`) for its "Last sync" line.
- **Statuses.** Each row has a status: New, Investigating, Added to map or Ignoring. Rows marked Added to map or
  Ignoring are hidden on the page until "Show added and ignored" is ticked, and a row keeps its status when it is
  reported again. Only the plugin's author can set one: "Author sign-in" on the page goes to GitHub and back
  (`GET /login`, `GET /callback`), the Worker checks that the account is the one in `ADMIN_ID`, and the page then
  gets a sign-in good for 30 days, kept in that browser. Signed in, the page reads the rows live (`GET /rows`) and
  each row has a dropdown (`POST /status`). The sign-in asks GitHub for no permissions; GitHub's token is used to
  ask which account it is and then dropped. Any other account is turned away and nothing about it is kept.

Nothing reported is added to the map by itself: a row is checked against the game before it becomes a transport.

## Setting it up

Everything below runs on the free plans of GitHub and Cloudflare. You need Node 20 or newer (`node --version`).

1. **The page.** This repository is public, with GitHub Pages on the `main` branch, folder `/docs` (Settings →
   Pages). It is served at `https://brettgod1355.github.io/advanced-map-reports/`.
2. **A Cloudflare account and its workers.dev address.** Sign up at <https://dash.cloudflare.com/sign-up> (free).
   In the dashboard open **Workers & Pages** once: Cloudflare asks you to pick a `workers.dev` subdomain, for
   example `brettg`. Every Worker you deploy is then served at `https://<worker name>.<subdomain>.workers.dev`.
3. **Log Wrangler in.** In a terminal, in this repository's `worker/` folder:
   `npx wrangler login`. A browser tab opens; allow access. `npx wrangler whoami` then shows your account.
4. **The database.** Still in `worker/`:
   - `npx wrangler d1 create advanced-map-reports`. It prints a `database_id`; put it in `wrangler.toml` in place
     of `REPLACE_WITH_THE_D1_DATABASE_ID`.
   - `npx wrangler d1 execute advanced-map-reports --remote --file=schema.sql` creates the three tables.
5. **The GitHub token**, so the Worker can write `docs/data/reports.json` every half hour. On GitHub: Settings →
   Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token. Name it
   `advanced-map-reports worker`; Repository access: **Only select repositories** → this one; Permissions →
   Repository permissions → **Contents: Read and write** (nothing else). Pick an expiry and note it in your
   calendar. Copy the token, then `npx wrangler secret put GITHUB_TOKEN` and paste it when asked. The token is
   kept by Cloudflare only: never put it in a file here.
6. **The salt**, the secret that makes a sender's one-day mark impossible to turn back into an address:
   `npx wrangler secret put SALT` and paste any long random text (for example the output of
   `node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"`). Nobody needs to know it, you included.
7. **Deploy.** `npx wrangler deploy`. It prints the Worker's address,
   `https://advanced-map-reports.<subdomain>.workers.dev`, and the schedule (every half hour).
8. **Check it.** Open that address in a browser: it answers "Advanced Map reports. The data is public: see the
   repository." Send one test report from a terminal (a ladder by Lumbridge Castle into its cellar):

   ```
   curl -i -X POST https://advanced-map-reports.<subdomain>.workers.dev/report -H "content-type: application/json" -d "{\"v\":\"1.2\",\"k\":\"o\",\"id\":14880,\"op\":1,\"at\":[3209,3216,0],\"from\":[3210,3216,0],\"to\":[3210,9616,0]}"
   ```

   It answers `204`. `npx wrangler d1 execute advanced-map-reports --remote --command "SELECT * FROM jumps"` shows
   the row; delete it with `--command "DELETE FROM jumps"` before real reports come in. The page shows rows after
   the next half-hourly write (or run it at once from the dashboard: the Worker → Settings → Trigger events → the cron →
   "Trigger").
9. **The plugin.** The address with `/report` on the end goes in the plugin's `TransportReports.URL`.
10. **The author's sign-in**, for setting statuses on the page.
    - On GitHub: Settings → Developer settings → **OAuth Apps** → New OAuth App. Application name:
      `Advanced Map reports`. Homepage URL: `https://brettgod1355.github.io/advanced-map-reports/`. Authorization
      callback URL: the Worker's address with `/callback` on the end,
      `https://advanced-map-reports.<subdomain>.workers.dev/callback`. Leave "Enable Device Flow" off. Register.
    - The app's page shows its **Client ID**. In `worker/`: `npx wrangler secret put GITHUB_CLIENT_ID` and paste it.
    - **Generate a new client secret** on the same page, copy it, then
      `npx wrangler secret put GITHUB_CLIENT_SECRET` and paste it. Like the token, it is kept by Cloudflare only.
    - `wrangler.toml` holds the two things that are not secret: `SITE`, the page's address, and `ADMIN_ID`, the
      numeric id of the one GitHub account that may sign in (the number before the `+` in that account's noreply
      address, or `id` at `https://api.github.com/users/<name>`).
    - A database made before statuses needs its new column and table once:
      `npx wrangler d1 execute advanced-map-reports --remote --command "ALTER TABLE jumps ADD COLUMN status TEXT NOT NULL DEFAULT ''"`
      and `npx wrangler d1 execute advanced-map-reports --remote --file=schema.sql` (it only adds what is missing).
    - `npx wrangler deploy`, then open the page and click "Author sign-in" at the bottom.

## Tests

`cd worker && npm test` (Node 20 or newer; nothing to install). They cover the checks, the grouping, the public
file, the sign-in and the status routes, with a stand-in for the database and for GitHub's answers. Taking a
report into the real database is not covered by tests.

## The names file

`docs/data/names.json` holds each named object's and NPC's name and menu options by id, read from the game's
cache. It is written again when the game adds things; an id it does not have shows as "id 12345" on the page.
The names and options are Jagex's; everything else here is under the license in `LICENSE`.
