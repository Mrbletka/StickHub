# StickHub

A personal hub for Node.js apps and games that lives on a USB stick. Phone first (Termux on Android).
Zero dependencies: Node 24 built-ins only, no build step. Read `AGENT-GUIDE.md` first.

## Run
```sh
node hub/server.mjs          # http://127.0.0.1:8787/  (Ctrl+C stops the hub and all apps)
node --test                  # all tests
sh probes/run-all.sh         # phone-only measurements (Termux), result goes to the clipboard
```

## On the phone (first time)
```sh
cd ~/StickHub && node hub/cli.mjs doctor        # what is missing (termux-api, storage, widget, stick, ...) and how to fix it
cd ~/StickHub && node hub/cli.mjs open          # starts the hub in the background and opens it (logged in)
node hub/cli.mjs widget install                 # home-screen shortcuts for Termux:Widget
```
1. Install the app: in Chrome's menu tap **Add to Home screen** / **Install app**. It then opens full screen.
2. Add the widget: long-press the home screen > Widgets > Termux:Widget > **StickHub**.
3. One tap on **StickHub** starts the watcher and opens the hub. With the watcher running, plugging in the stick opens the
   hub by itself. After a phone restart (or if Android closes Termux) tap **StickHub** again.
4. "Log in to StickHub" on screen? Run `node hub/cli.mjs login --open` (a one-time link, valid about 60 s).

Settings (optional) in `~/.stickhub/settings.json`: `{ "requireStick": false, "autoPull": false }`.
`requireStick`: no stick, no hub. `autoPull`: the watcher runs `git pull --ff-only` on plug-in.

## Use
- Tap a tile: the app starts (if needed) and opens full screen. The round Home button (drag it anywhere) or Android back returns.
- Long-press a tile (right-click on a PC): Open, Restart, Stop, Logs.
- A broken app shows "Broken" on its tile; long-press it to see why.
- Tap the chip at the top: stick status, sync progress, Sync now, Cancel, conflicts.

## App data on the stick
```sh
node hub/cli.mjs open --data-on-stick   # or { "dataOnStick": true } in ~/.stickhub/settings.json (default off)
```
The hub and its apps still run from the clone; only the app data (`HUB_DATA_DIR`) lives on the stick in
`HUB/data/<id>/`, so no data sync is needed. Pull the stick and the apps stop within 2 s, the page shows
"Stick removed", the hub keeps running; plug it back in and carry on. No stick: "Plug in the stick".

## Stick and sync
```sh
node hub/cli.mjs stick status                      # what is plugged in
node hub/cli.mjs stick init --name "My stick"      # create HUB/ (never touches an existing HUB/ without --force)
node hub/cli.mjs sync plan                         # what would be copied (changes nothing)
node hub/cli.mjs sync run [all|data|code]          # Ctrl+C cancels safely; run again to finish
node hub/cli.mjs code pull-from-stick [--yes]      # explicit stick -> phone code copy (clean clone only)
node hub/cli.mjs login [--open]                    # fresh one-time login link
node hub/cli.mjs open                              # start the hub if needed, open it
node hub/cli.mjs hub stop                          # stop the hub and its apps
node hub/cli.mjs watch start|stop|status           # the watcher
```

## Encrypted vault (being built)
```sh
node hub/cli.mjs vault verify <vault-folder> [--quick] [--paper] [--json]   # check everything, write nothing
node hub/cli.mjs vault export <vault-folder> <dest-folder> [--paper]        # decrypt all notes to plain files
node hub/cli.mjs vault dev-create [<folder>]   # DEV ONLY: a test vault (default ~/.stickhub/vault-dev)
node hub/cli.mjs open --vault [<folder>]       # DEV ONLY: type the passphrase, the hub runs with the vault open
```
**DEV ONLY until the lock screen (job 4).** `dev-create` shows a generated 5-word passphrase and a paper code once on
the terminal, asks you to type the passphrase back, and only then writes the vault. `open --vault` asks for the
passphrase (no echo) and starts the hub with the vault open in its memory: apps with `"data": "hubfs"` read and write
through the data API (`~/.stickhub/run/data.sock`); apps that still want plain files show why on their tile and do
not start; the plain data sync leaves `data/` alone. Without `--vault` the hub works as before. No sync of the vault
to the stick yet (job 5), no lock screen, no auto-lock.
Both ask for the passphrase (or with `--paper` the paper code) on the terminal, with no echo; never as an argument.
`export` refuses a folder on the stick, inside the vault, inside this clone, or one that is not empty. The exported
files are **not encrypted**: delete them when you no longer need them. See `docs/VAULT-DESIGN.md`.
- The hub finds the stick by itself (`/proc/self/mountinfo`, every 2 s) and syncs on plug-in and after an app stops.
- Code: git is the master. Only `hub/` and `apps/` go to the stick, and only when the clone has no uncommitted
  changes and the stick has an older commit. A different or newer commit on the stick is never overwritten.
- Data (`data/<app-id>/`): both ways, three-way by hash. Both sides changed: the phone's file keeps the name, the
  stick's version is kept as `name.conflict-<time>.ext` on both sides. Deleted files go to `.trash/<date>/`.
- A running app's data waits ("pending") and syncs when the app stops.
- Apps save through their own server into `HUB_DATA_DIR`. Browser storage (localStorage, IndexedDB) is not synced.
- On a PC (or for tests) `STICKHUB_MOUNTS=/path/one:/path/two` makes folders act as sticks.

## Add an app
```sh
node hub/cli.mjs new deep-dig --engine node-server --name "Deep Dig"   # or --engine static
```
This makes `apps/deep-dig/` with app.json, a starter (the node-server one saves through `/api/save` into
`HUB_DATA_DIR`), a placeholder icon and a README with the rules. The running hub shows the new tile at once.

By hand: make `apps/<id>/app.json` (id: a-z, 0-9, "-"; must match the folder name):
```json
{ "id": "deep-dig", "name": "Deep Dig", "icon": "icon.svg", "engine": "node-server",
  "entry": "server.mjs", "port": "auto", "args": [], "env": {}, "version": "0.1.0" }
```
- `node-server`: the hub runs `entry` with its own Node. Listen on `process.env.PORT` at 127.0.0.1.
  Keep saves in `process.env.HUB_DATA_DIR`. Exit cleanly on SIGTERM. Optional `"health": "/path"`.
- `static`: the hub serves the folder `entry` (default: the app folder). `"spa": true` sends unknown paths to index.html.
- `"port": 4110` gives an app a fixed port (other apps never get it), so its localStorage survives restarts.
- `"atomicData": true`: the app writes its data only with temp file + rename, so sync may copy it while the app runs.
- `"data"`: how the app keeps data. `"hubfs"`: through `lib/hubfs.mjs` (works with and without the vault);
  `"files"`: plain files in `HUB_DATA_DIR` (cannot start while the vault is on); `"none"`: no data. Default:
  `"none"` for static apps, `"files"` for the others.
- The app gets `PORT`, `HUB_APP_ID`, `HUB_APP_DIR`, and `HUB_DATA_DIR` (no vault) or `HUB_DATA_SOCKET` +
  `HUB_DATA_TOKEN` (vault on, `"data": "hubfs"` apps only; a new token each start). Then reload the hub page
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
hub/platform/         adapters: volumes (mountinfo), Termux actions, git
hub/watcher.mjs       opens the hub when the stick is plugged in
hub/auth.mjs          token and one-time login codes
hub/vault/            encrypted vault: crypto and the store (not wired into the hub yet; see docs/VAULT-DESIGN.md)
hub/proc.mjs          leftover app processes after a hard kill (checked by /proc/<pid>/cmdline)
hub/ui/player.js      full-screen app player; hub/ui/sw.js + offline.html: PWA
hub/ui/               the web UI (vanilla)
apps/                 the apps (tap-counter, pocket-timer are samples)
probes/               phone-only measurements, results in docs/PROBES.md
test/                 node:test suites
```

## API
Every call needs the header `X-Hub-Token`, except `GET /api/ping`, `POST /api/auth/exchange` and app icons.

| Method | Path | |
|---|---|---|
| GET | /api/ping | is the hub running (open) |
| POST | /api/auth/exchange | body `{"code"}`: one-time code -> token (open) |
| POST | /api/auth/code | a fresh one-time login link |
| POST | /api/hub/stop | stop the hub and its apps |
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

## Credits
- `hub/vault/wordlist-eff-large.txt`: the **EFF Large Wordlist for Passphrases** by the
  **Electronic Frontier Foundation**, https://www.eff.org/dice, licensed under **CC BY 3.0 US**,
  https://creativecommons.org/licenses/by/3.0/us/. Changed: the dice numbers were removed and a credit header was
  added; the words and their order are unchanged.
