# StickHub - AGENT-GUIDE (read fully before coding)

Working name: StickHub (rename freely). Owner: Fabian. Greenfield project. Ignore any older projects.

## Goal
A personal hub for my Node.js apps and games that lives on a USB stick.
Plug the stick into my phone and within seconds the hub opens full-screen (installed PWA). One tap starts any app.
The stick is the carrier and a backup. Git (this repo) is the master for code. The phone works from its git clone and syncs data with the stick.
Every app can use a different engine (node server, static files, more later).
Phone first. A Windows launcher comes later: design for it, do not build it yet.

## How I work
- The agent commits and pushes to my PUBLIC GitHub repo. I `git pull` on my phone (Termux) and test there. No update scripts.
- The agent cannot run Termux or touch the stick. Everything Termux- or stick-specific sits behind small adapter
  modules (`platform/termux.mjs`, `stick.mjs`) with fakes, so the rest is testable with `node --test` anywhere. Target Node 24.
- Anything that must be tested on the phone goes in `probes/`. Every message that needs a phone test ends with ONE command
  to paste in Termux, like `cd ~/StickHub && git pull && sh probes/run-all.sh`. The script copies its output to the
  clipboard (`termux-clipboard-set`). I paste the result back.

## Hard rules
- Zero dependencies: Node.js built-ins only. No npm packages, no build step, no native addons, no CDN. Vanilla HTML/CSS/JS in the browser.
- Node 24 (v24.22.1 on the phone). ESM (.mjs) everywhere. No package.json needed.
- Works fully offline.
- Tests with node:test (`node --test`). They must pass on the phone.
- Small files (about 400 lines max), clear modules, JSDoc on public functions, explicit error handling, no silent catches.
- Never `shell: true`, never eval. Spawn with argument arrays. Every external command call has a timeout.
- Secrets (the access token) live outside the synced tree (~/.stickhub/) and never go on the stick.
- The repo is PUBLIC. Never commit secrets, tokens, saves, logs, device IDs, volume UUIDs or personal data.
  `.gitignore` covers data/, .trash/, logs/, sync-state.json, stick.json, *.part, *.tmp, .stickhub/.

## Target environment (measured, do not guess)
- Phone: OPPO A6 Pro 5G (CPH2781), Android 16 / ColorOS 16. Dimensity 6300: 2 fast + 6 slow cores, 8 GB RAM, weak GPU.
- Screen 1080x2372, about 423x930 CSS px, DPR 2.55, 120 Hz.
- Runs in Termux (F-Droid build 0.119.0-beta.3), aarch64, no root. Home: /data/data/com.termux/files/home. Ports 1024+ only.
- Termux tools available: termux-usb, termux-open-url, termux-notification, termux-toast, termux-clipboard-set, termux-wake-lock, termux-setup-storage (Termux:API is installed).
- Two fast cores: keep CPU light. Few timers, no busy loops, no recursive fs.watch. ColorOS may freeze background apps.

## The stick (measured)
- 64 GB exFAT (57 GB free), mounted at /storage/<volume-uuid> (FUSE). Termux can read AND write there after `termux-setup-storage`.
- /storage itself is NOT listable (permission denied) but /storage/<UUID>/... works. Candidate roots: `readlink ~/storage/external-*`.
  Never hardcode the UUID (it is detected at runtime): find the stick by the marker file HUB/stick.json.
- The mount is noexec (nothing on the stick runs directly: always `node file.mjs`). The underlying mount has dirsync, so directory operations are slow: batch work, avoid thousands of tiny files.
- exFAT: no symlinks, no permission bits, case-insensitive, forbidden characters <>:"/\|?*, unreliable mtimes. Never use mtime for sync: use size + sha256. App ids are [a-z0-9-] only.
- The stick can be pulled at any moment. Every write to the stick: write name.part, fsync, rename. Keep a journal so an interrupted sync resumes or rolls back.

## Verify first (do not build on these assumptions)
Probes in `probes/`, all run by `sh probes/run-all.sh` (result goes to the clipboard):
1. Does re-running `termux-setup-storage` after re-plugging the stick refresh the ~/storage/external-* links?
2. Can `termux-open-url` open Chrome from a background process? (Needs "Display over other apps" for Termux, maybe a ColorOS background pop-up permission.)
3. Cost of polling `termux-usb -l` every 3 s (time per call, battery). Poll slower if it is heavy.
4. Write/rename/fsync speed on the stick for 1 big file and for 500 small files.
5. Does fsync + rename behave sanely on this FUSE exFAT mount?

## Repo, phone and stick layout
~~~
StickHub/             the git repo = master for code
  hub/                core code (server, engines, ui, watcher, cli, platform adapters)
  apps/<id>/          one folder per app (app.json + files); apps live in this repo for now
  probes/             phone-only measurements
  test/               node:test suites
~~~
- Phone: the git clone (for example ~/StickHub, never on the stick) is the working copy. Phone-only, git-ignored:
  data/<id>/, logs/, sync-state.json, .trash/.
- Stick:
~~~
HUB/                  on the stick
  stick.json          marker + identity {id, name, created} + commit (git hash of the code snapshot)
  hub/  apps/         snapshot of the tracked files at that commit (no .git)
  data/<id>/          saves and user data per app (never overwritten by code sync)
  runtime/            optional portable Node for Windows (later)
  .trash/<date>/      deleted files go here, never hard-deleted
~~~
Run modes on the phone. In both, the hub and its apps run from the clone: nothing from the stick is ever run or
imported on the phone.
(1) Phone copy (default): app data in the clone's data/, synced with the stick.
(2) Data on the stick (setting `dataOnStick`, default off for now): app data lives on the stick.
(3) Portable mode (phase 4, not built): a device without the clone runs the code from the stick.

## Data on the stick (dataOnStick)
- `node hub/cli.mjs open --data-on-stick`, or the setting `dataOnStick: true` (the watcher uses it), starts the hub from
  the clone with HUB_DATA_DIR = <stick>/HUB/data/<id>/. A hub running the other way is restarted.
- On the stick: the app data, the code snapshot (backup, copied phone -> stick as before) and the plug-in journal
  (HUB/.journal.json from an interrupted sync, HUB/.running.json = the data is in use).
  On the phone: the token and settings (~/.stickhub/), the logs, the watcher. No data sync in this mode.
- Plug-in (hub/livedata.mjs): finish an interrupted sync; if HUB/.running.json is still there (pulled while in use),
  report it and remove leftover *.part files in HUB/data; mark the stick as in use; point the apps' data at it.
- The hub checks every 0.5 s. Stick gone: apps get SIGTERM with a 1.2 s grace (all stopped within 2 s), the page shows
  "Stick removed", the hub keeps running. Stick back: the screen goes away; apps start again only when tapped.
- No stick: no app starts; the page shows "Plug in the stick".
- The byte-for-byte check of code on the stick (hub/portable-check.mjs: git blob hashes, extra-file check, list of
  differences) is reserved for portable mode. It is not used on the phone.

The hub also works with no stick plugged in. A setting `requireStick` makes it refuse to start without the stick (cartridge feel).

## App manifest (apps/<id>/app.json)
~~~json
{ "id": "deep-dig", "name": "Deep Dig", "icon": "icon.png", "engine": "node-server",
  "entry": "server.js", "port": "auto", "args": [], "env": {}, "version": "0.1.0" }
~~~
- Relative paths only, no "..". Validate strictly. One broken app must never break the hub: show the error on its tile.
- The app gets env: PORT, HUB_APP_ID, HUB_APP_DIR, HUB_DATA_DIR (= data/<id>).
- Saves: an app saves to HUB_DATA_DIR through its own server. Browser storage (IndexedDB, localStorage) is NOT synced.

## Doctor
`node hub/cli.mjs doctor [--json]` (hub/doctor.mjs) checks Node and git versions, termux-api (commands and the
Termux:API app), storage permission, the Termux:Widget shortcuts, the stick, the hub port, the watcher, token and
settings, and prints what is missing with the fix. Read-only. Each check is a small function with its outside effects
passed in (test/doctor.test.mjs fakes a phone). It is the base of the setup guide for a new phone: add a check there
whenever setup gets a new step.

## Making apps
- Start every app with `node hub/cli.mjs new <id> --engine node-server|static [--name "Name"]`. It makes apps/<id>/ with
  app.json, a starter, a placeholder icon.svg and a README.md with the rules. It never overwrites an existing folder.
- node-server apps: listen on process.env.PORT at 127.0.0.1, keep saves in process.env.HUB_DATA_DIR through the app's own
  server (the starter has GET/PUT /api/save with atomic writes), stop cleanly on SIGTERM, Node built-ins only,
  run alone with `PORT=4100 node server.mjs`.
- static apps: files only, no saves.
- Never import or require anything from HUB_DATA_DIR (in the hub or in an app): data is data, never code.
  It may live on the stick. A test (test/app-rules.test.mjs) checks every app for this.
- `"port": <number>` = fixed port (never handed to another app): use it when the app keeps UI state in localStorage.
- `"atomicData": true` only if the app writes data exclusively with temp file + rename: then sync copies its data
  while it runs (no "pending").
- Browser storage (localStorage, IndexedDB) is not synced, so no saves there.
- Apps open full screen in the hub player (iframe, own port). Phone first: about 423x930 CSS px, touch, no hover.
  Weak GPU, two fast cores: 2D canvas or light WebGL, aim for 60 fps.
- Use relative URLs inside an app (`fetch('api/save')`, not `/api/save` with a host), so it also works when run alone.

## Engines (hub/engines/<id>.mjs)
Contract: `export default { id, validate(manifest) -> string[] errors, async start(ctx) -> { port, url, stop(), exit?, pid? } }`.
v1: `node-server` (spawn process.execPath with entry, wait until the port accepts TCP, health check) and `static` (built-in static server: correct MIME, Range requests, no path traversal, optional SPA fallback).
Adding an engine = adding one file. Leave room for cli, custom command and game-specific engines.

## Hub core
- Hub port is fixed: 127.0.0.1:8787 (fixed so the PWA origin stays stable; fail loudly if taken). App ports 4100-4199.
- One server for UI + API (JSON + SSE): list apps, start/stop/restart, status, live logs, stick + sync status. No framework.
- Process manager: spawn, track, graceful stop (SIGTERM, then SIGKILL), no zombies, ring-buffer logs, clean up on hub exit.
  Leftovers after a hard kill of the hub: app PIDs + exact command lines are saved in ~/.stickhub/apps-running.json;
  the next hub start stops a saved PID only if /proc/<pid>/cmdline still matches. Never kill by PID alone.
- Security (a web page in my browser can try to call 127.0.0.1): check Host, Origin and Sec-Fetch-Site, launch only apps
  from validated manifests, never run commands taken from API input. Token: random per install in ~/.stickhub/token.json,
  sent as the X-Hub-Token header on every API call (open: /api/ping, /api/auth/exchange, app icons). NO cookies: cookies on
  127.0.0.1 reach every app port. The browser keeps the token in localStorage (per origin, port included). URLs only ever
  carry a one-time login code (~60 s, used once) that the hub page swaps for the token; `hub login` prints or opens a fresh one.
  EventSource cannot send headers, so the page reads the event stream with fetch().

## UI (vanilla, mobile-first, installable PWA)
- Dark, AMOLED black. Big tile grid: icon, name, status dot. Tap = start (if needed) and open. Long-press = menu (stop, restart, logs).
- Player: a running app opens full screen in an iframe inside the hub page, with a small floating (draggable) Home button
  (default: middle of the left edge, because apps often have a menu in the top corners).
  The hub's viewport has interactive-widget=resizes-content, so the soft keyboard shrinks the player and the app.
  Android back = Home. Apps keep their own port = own origin, so they cannot read the hub token. Same host = same site,
  so Chrome does not partition their storage. (Not a reverse proxy under /app/<id>/: that would put every app on the
  hub's origin, next to the token.)
- Status chip: stick connected / syncing / conflicts / stick has a different commit. A tile whose data waits for sync shows "pending".
- "Sync now" button. Short "Stick connected" animation on plug-in.
- Safe-area insets, no hover-only features, CSS animations only, no heavy WebGL.
- PWA: manifest (standalone; hub/ui/icons: icon-192 + icon-512 "any", icon-maskable-512 "maskable", the owner's art:
  do not regenerate; bump CACHE in hub/ui/sw.js when they change), service worker caching the shell, friendly offline page ("Hub is not running") when the server is down.

## Sync
Code and data are separate groups. `sync plan` (dry run) first, then `sync run`.
- Code (hub/, apps/): git is the master. Phone -> stick copies a snapshot of the tracked files (`git ls-files`, no .git)
  and writes the commit hash into stick.json. Automatic on plug-in ONLY if the clone has no uncommitted changes AND the
  stick's commit is an older commit of the phone's history (`git merge-base --is-ancestor`). If the stick has a different
  or newer commit: never overwrite, show it in the UI. Git calls go through the platform adapter (argument arrays, timeout).
  Stick -> phone code copy is an explicit command only. The watcher never pulls from GitHub by itself
  (setting `autoPull`, default false).
- Data (data/): two-way, three-way by hash. sync-state.json keeps the last synced hash per file. Only one side changed:
  copy it. Both changed: keep both (name.conflict-<time>) and show it in the UI. Deletions go to .trash.
  Runs automatically on plug-in and after an app stops, plus the "Sync now" button. A running app's data/<id> is skipped
  and marked "pending"; it syncs when the app stops.
- Stick speed (docs/PROBES.md): ~50 ms per directory operation, ~165 ms per safely written small file, 19 MB/s for big files.
  Copy only changed files, keep the stick's hash list in one file, never re-hash the whole stick on each sync.
- Verify every copy by hash. Limit parallelism (FUSE is slow). Show progress. Ignore .git, *.part, *.tmp, node_modules.
- Lock file on the stick (HUB/.lock: device id + time) with stale-lock detection.
- Sync runs in the background, shows progress and can be cancelled. A cancelled or interrupted run is safe to resume:
  every file write is atomic (.part, fsync, rename), and every step is re-checked by hash on the next run.
- Everything on the stick is untrusted input: reject "..", absolute paths and odd names, accept only app ids [a-z0-9-],
  limit file sizes and file counts. Nothing from the stick is ever run or imported on the phone (also not with
  dataOnStick: the code always comes from the clone).
- `stick init` never touches an existing HUB/ or any other file on the stick unless --force is passed.

## Watcher (phone only, hub/watcher.mjs, runs in Termux)
- Poll `/proc/self/mountinfo` every ~2 s (0.7 ms per read). `termux-usb -l` is too heavy to poll (1.2 s per call).
  On a new /storage/<uuid> mount: look for <mount>/HUB/stick.json. The stick is writable about 1 s after the USB device
  appears, with no `termux-setup-storage` (measured; it also pops up a screen). Run it only once, at install.
- Found: start the hub if it is not running, sync data, open `termux-open-url http://127.0.0.1:8787/?t=<token>`.
  Stick removed: stop writing, finish or roll back the journal, update status.
- Run under `termux-wake-lock`. CLI: `node hub/cli.mjs watch start|stop|status`.
- Start with one tap: `node hub/cli.mjs widget install` writes ~/.shortcuts/tasks/StickHub (Termux:Widget). Termux:Boot
  is not installed, so after a phone restart or Termux being killed the watcher must be started again (tap the widget).
- If opening Chrome from the background fails, show a termux-notification with a tap action instead.

## Build order (stop after each phase and report)
A finished phase is recorded here with its commit hash (no git tags).
1. Core + engines (node-server, static) + UI + 2 sample apps. Done when `node hub/server.mjs` shows the grid, start/stop works and ports are freed.
   **Done: 3b45c50** (tested on the phone 2026-11-04).
2. Stick layout + sync CLI (plan, run, conflicts, trash, unplug-safe). Test with a simulated interrupted copy.
   **Done: b306b14** (tested on the phone and the real stick 2026-11-04, unplug mid-sync included; docs/PROBES.md run 3).
3. PWA + watcher + token security. Done when: plug in -> hub open in 10 s or less.
   **Done: f8da240** (tested on the phone 2026-11-04: plug in -> open and logged in 6.6 s, as the installed app; docs/PROBES.md run 4).
4. Windows launcher + portable Node: **design only, later**. Not now. Portable mode runs code from the stick and must use
   hub/portable-check.mjs first.

Now: real apps, one at a time, built inside the hub with `node hub/cli.mjs new` (see "Making apps").
- App #1 Notebook (apps/notebook): notes as plain files in HUB_DATA_DIR/vault, VS Code-style Explorer. See its README.
  **Done: 09c5942** (tested on the phone 2026-11-04). Later: full-text search, tags, pins, [[wiki links]], conflict compare view.

Encrypted vault: docs/VAULT-DESIGN.md (reviewed; decisions in its section 0, build order in section 11).
v1 = passphrase + paper code end to end; v2 = device slot (fingerprint). Build one step at a time and stop after each.
- v1 step 1, crypto building blocks in hub/vault/ (KDFs, slots, paper code, generated passphrases, header, .vx files):
  **Done: 4640777** (tests only; nothing is wired into the hub yet; all 160 tests pass on the phone 2026-11-04). 
- v1 step 2, part 1 (store core, API, range reads, limits, cleanup in hub/vault/): **Done: 56e54c0** (tests only;
  not wired into the hub; all 190 tests pass on the phone 2026-11-04).
- v1 step 2, part 2: fixes C1-C4 (f219982), `vault verify` / `vault export` (1dd1b93), trash and compaction with
  maintain() (abf92c4), probe 10 store part (this commit; phone run pending). Next: the probe 10 numbers, then step 3.
- Store rules: a .vx file is never changed in place; index files are committed by rename; the newest index that
  decrypts wins; every new index is decoded once before it is written. Cleanup runs only inside the store's write
  queue, at two levels: FULL (packs too) only when nothing is damaged; LIGHT (index .part files and valid index files
  beyond the 2 newest, never packs, damaged files or headers) when an index file or a header copy is damaged; none
  at all when the order of the indexes is unclear. maintain() (purge 30-day trash, compact, clean up) runs after the
  first commit of a session and every 16 commits. Compaction never runs while there are problems. At 200 files in
  _index commits are refused (NEEDS_REPAIR). File times are never used.
- `node hub/cli.mjs vault verify|export` (hub/cli-vault.mjs): passphrase only from the terminal (no echo), never argv,
  env or a file; export never writes plain files on a stick, in the vault folder or in this clone.
- Vault rules: node:crypto and standard primitives only, no invented crypto. Never log or print key material,
  passphrases or paper codes; a VaultError message never contains an input value (test/vault-nosecrets.test.mjs).
  zero() keys when done. KDF settings and everything else read from a stick are checked before any KDF runs.
- test/fixtures/vault-v1/ is a format fixture with TEST ONLY keys: never edit it; later versions must keep reading it.
  `node --test` runs every .mjs file under test/, so fixture writers live inside their test behind an env var
  (STICKHUB_WRITE_FIXTURE=1), never as a separate script there.

## Delivery
- Small, logical commits with clear messages (imperative: "Add ...", "Fix ..."). Push to main after each working step.
- Record the end of each phase under "Build order" with its commit hash. No git tags.
- After each push: the exact commands to run on the phone and the expected output.
- Short explanations, simple English.
