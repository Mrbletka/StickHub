# StickHub

A personal hub for Node.js apps and games that lives on a USB stick. Phone first (Termux on Android).
Zero dependencies: Node 24 built-ins only, no build step. Read `AGENT-GUIDE.md` first.

## Run
```sh
node hub/server.mjs          # http://127.0.0.1:8787/  (Ctrl+C stops the hub and all apps)
node --test                  # all tests
sh probes/run-all.sh         # phone-only measurements (Termux), result goes to the clipboard
```

## Use
- Tap a tile: the app starts (if needed) and opens.
- Long-press a tile (right-click on a PC): Open, Restart, Stop, Logs.
- A broken app shows "Broken" on its tile; long-press it to see why.
- Tap the chip at the top: stick status, sync progress, Sync now, Cancel, conflicts.

## Stick and sync
```sh
node hub/cli.mjs stick status                      # what is plugged in
node hub/cli.mjs stick init --name "My stick"      # create HUB/ (never touches an existing HUB/ without --force)
node hub/cli.mjs sync plan                         # what would be copied (changes nothing)
node hub/cli.mjs sync run [all|data|code]          # Ctrl+C cancels safely; run again to finish
node hub/cli.mjs code pull-from-stick [--yes]      # explicit stick -> phone code copy (clean clone only)
```
- The hub finds the stick by itself (`/proc/self/mountinfo`, every 2 s) and syncs on plug-in and after an app stops.
- Code: git is the master. Only `hub/` and `apps/` go to the stick, and only when the clone has no uncommitted
  changes and the stick has an older commit. A different or newer commit on the stick is never overwritten.
- Data (`data/<app-id>/`): both ways, three-way by hash. Both sides changed: the phone's file keeps the name, the
  stick's version is kept as `name.conflict-<time>.ext` on both sides. Deleted files go to `.trash/<date>/`.
- A running app's data waits ("pending") and syncs when the app stops.
- Apps save through their own server into `HUB_DATA_DIR`. Browser storage (localStorage, IndexedDB) is not synced.
- On a PC (or for tests) `STICKHUB_MOUNTS=/path/one:/path/two` makes folders act as sticks.

## Add an app
Make `apps/<id>/app.json` (id: a-z, 0-9, "-"; must match the folder name):
```json
{ "id": "deep-dig", "name": "Deep Dig", "icon": "icon.svg", "engine": "node-server",
  "entry": "server.mjs", "port": "auto", "args": [], "env": {}, "version": "0.1.0" }
```
- `node-server`: the hub runs `entry` with its own Node. Listen on `process.env.PORT` at 127.0.0.1.
  Keep saves in `process.env.HUB_DATA_DIR`. Exit cleanly on SIGTERM. Optional `"health": "/path"`.
- `static`: the hub serves the folder `entry` (default: the app folder). `"spa": true` sends unknown paths to index.html.
- The app gets `PORT`, `HUB_APP_ID`, `HUB_APP_DIR`, `HUB_DATA_DIR`. Then reload the hub page
  (or `curl -X POST http://127.0.0.1:8787/api/apps/reload`).

## Layout
```
hub/server.mjs        entry: UI + API on 127.0.0.1:8787
hub/api.mjs           JSON + SSE routes under /api/
hub/procman.mjs       start/stop/restart, status, ports, ring-buffer logs
hub/engines/*.mjs     one file per engine (node-server, static)
hub/manifest.mjs      app.json validation
hub/static-files.mjs  static serving (MIME, Range, ETag, no traversal, SPA)
hub/cli.mjs           command line: stick, sync, code pull-from-stick
hub/stick.mjs         find, validate and init the stick; the sync lock
hub/sync/             scan, plan, run (journal, resume, cancel), hub service, safe names, file ops
hub/platform/         adapters: volumes (mountinfo), git
hub/ui/               the web UI (vanilla)
apps/                 the apps (tap-counter, pocket-timer are samples)
probes/               phone-only measurements, results in docs/PROBES.md
test/                 node:test suites
```

## API
| Method | Path | |
|---|---|---|
| GET | /api/status | hub info, commit, engines |
| GET | /api/apps | all apps with status |
| POST | /api/apps/reload | re-read apps/ |
| POST | /api/apps/:id/start, /stop, /restart | returns the app |
| GET | /api/apps/:id/logs?after=N | recent log lines |
| GET | /api/apps/:id/icon | the app icon |
| GET | /api/stick | stick and sync status |
| POST | /api/sync?what=all\|data\|code | start a sync in the background |
| POST | /api/sync/cancel | cancel the running sync |
| GET | /api/events[?logs=:id] | SSE: `apps`, `app`, `status`, `log` |
