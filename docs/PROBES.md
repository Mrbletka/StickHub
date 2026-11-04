# Probe results (measured on the phone)

Run: `sh probes/run-all.sh` (all) or `sh probes/run-all.sh --only 1` (one probe). The volume UUID is written as `<uuid>` here.

## Run 1 - 2026-11-03 (Node 24.22.1, Termux 0.119.0-beta.3, 64 GB exFAT stick)

### Where the stick is
- `/proc/self/mountinfo` is readable and shows the stick three times: `/mnt/media_rw/<uuid>` (exfat),
  `/storage/<uuid>` (fuse) and `/mnt/user/0/<uuid>` (fuse). All `rw,nosuid,nodev,noexec,noatime`.
- The volume root `/storage/<uuid>` is writable. The `~/storage/external-1` link points to the app folder
  `/storage/<uuid>/Android/data/com.termux/files`, which is also writable. HUB/ goes in the root.
- `os.cpus()` returns an empty list on this phone. Never size thread pools from it.

### 5. File system
| Check | Result |
|---|---|
| `.part` + fsync + rename, hash matches | ok |
| rename over an existing file | ok |
| fsync on a directory | ok |
| `wx` (O_EXCL) lock file | ok, second open fails with EEXIST |
| case | insensitive; a case-only rename does nothing (name stays) |
| Polish and 200-char names | ok |
| `:` and `?` in names | EPERM |
| symlink | EACCES |
| chmod | ignored (always 770) |
| run a file directly | EACCES (noexec) |
| mtime | set/read back exact; a new file's mtime was 41 ms off the clock |
| rename / remove a folder | ok |

Rules that follow: rename case changes through a temp name; reject names with forbidden characters before writing.

### 4. Speed
| | Stick | Phone |
|---|---|---|
| 64 MB write + fsync | 308 + 3015 ms = 19 MB/s | 200 MB/s |
| 2 KB file, `.part` + fsync + rename | 165 ms each (500 files: 91 s) | 5 ms |
| 2 KB file, plain write | 57 ms each | 2.7 ms |
| delete one small file | 40 ms | 0.1 ms |
| readdir 1000 files | 189 ms | 10 ms |
| read + hash 500 small | 2.2 s | 1.1 s |

Every directory operation (create, rename, delete) costs about 50 ms on the stick; big files are fine.
So: copy only changed files, keep the file count low, and keep the hash manifest of the stick in one file
instead of re-hashing the whole stick on each sync.

### 3. Polling cost
- `termux-usb -l`: 1.16 s per call (wall), 50 ms CPU in Termux plus work in the Termux:API app.
  Every 3 s that is busy 39% of the time: too heavy.
- Reading `/proc/self/mountinfo`: 0.7 ms. Checking the `~/storage` links: 1.7 ms.
- Decision: the watcher polls mountinfo, not `termux-usb` (see run 2).

### 2. Opening the browser
- Foreground: page opened after 2.0 s. **Background (Termux not in front): Chrome opened by itself after 1.5 s.**
- Notification with a tap action: works (opened when tapped).
- So the watcher can call `termux-open-url` directly; the notification stays as the fallback.

### 1. Unplug and re-plug
- Run 1 was not valid: the probe compared with the wrong snapshot and recorded the unplug, not the re-plug.
- What it did show: after unplug the `external-1` link stays but points nowhere; `termux-setup-storage` then
  removes it, and it showed something on screen (you answered "y"). Its question ("rebuild ~/storage?") is
  answered by sending `y` on stdin.
- Fixed probe: see run 2 below.

## Run 2 - 2026-11-04: probe 1 (unplug and re-plug), fixed probe
Times are ms after the prompt, so they include how fast you moved.
- Unplug: mount gone from mountinfo and root unreadable at 2840 ms; `termux-usb -l` empty at 3481 ms.
  The `external-1` link stays but points nowhere.
- Re-plug: USB device seen at 7047 ms (slow loop, ~1.2 s steps), mounted at 7969 ms, root readable 8024 ms,
  root writable 8104 ms, old link works again 8120 ms. So about 1 s from USB to a writable stick.
- **Without `termux-setup-storage` everything works again**: same mount path, root writable, old link fine.
- `termux-setup-storage` takes 1.1 s and shows something on screen. Not needed for the stick.

### Decision
The watcher reads `/proc/self/mountinfo` every ~2 s, finds `/storage/<uuid>` mounts and checks `HUB/stick.json`.
No `termux-usb` polling, no `termux-setup-storage` (only once, at install, for storage permission).

## Run 3 - 2026-11-04: probe 6, phase 2 sync on the real stick (code b306b14)
| Step | Result |
|---|---|
| A first full sync (36 files: code + data) | ok, 5.6 s |
| B 120 new data files (2-20 KB) | ok, 15.5 s = 129 ms per file |
| C cancel after 10 files | cancelled cleanly; next sync finished the other 30 (5.0 s) |
| D pulled out mid-sync | stopped with EIO on a rename, 22 files done, nothing broken |
| D stick back after re-plug | 6.2 s (includes your hands) |
| D sync after re-plug | finished the interrupted sync: 98 files, 15.6 s |
| D one more sync | copied 0 (0.7 s), no .part files left |
| E delete 120 files on the phone | moved to the stick .trash: 14.1 s (118 ms per file) |

Every file written to the stick costs about 120-160 ms, as the speed probe predicted. An unplug mid-write gives EIO;
the run stops, and the next run finishes the work with no leftovers.

## Run 4 - 2026-11-04: probe 7, phase 3 end to end (code f8da240)
Hub stopped first (worst case: the watcher has to start it). Times from pressing Enter and plugging in the stick.
| Step | Result |
|---|---|
| plug in -> hub page open and logged in | **6.6 s** (goal: 10 s or less) |
| stick found -> hub started | 1.1 s |
| stick found -> termux-open-url returned | 2.3 s |
| opened as | the installed StickHub app (no browser bar) |
| player full screen with Home button | yes |
| Android back -> tiles | yes |
| Home button -> tiles | yes |
| hub stopped -> "Hub is not running" page | yes |

The rest of the 6.6 s is the mount (~1 s after USB), the 2 s poll, and the page loading and redeeming its login code.

## Run 5 - 2026-11-04: probe 8, app data on the stick (code 60397ec)
| Step | Result |
|---|---|
| Enter -> page open and logged in | 17.6 s, but the watcher found the stick only at the end of that; stick found -> page open: 1.2 s (hub already running) |
| note written in the Notebook | landed on the stick (data/notebook/vault/Facet.md) |
| pull -> hub saw it | 0.35 s after the mount vanished |
| apps stopped | 45 ms; the hub kept running; "Stick removed" shown |
| plug back -> data on the stick again | 0.8 s; the pull was reported; apps not restarted by themselves |

The 17.6 s is mostly the time before the stick was mounted and seen (probe 1 measured about 1 s from USB to mount,
plus up to 2 s polling), so it needs a re-run to tell. Test fix: procman test start timeout 1.5 s -> 6 s (the phone is
slower under load: "nothing answered on port 47101 in time").

## Run 6 - 2026-11-04: probe 8 again, app data on the stick (code ad97a84)
| Step | Result |
|---|---|
| Enter -> page open and logged in (hub cold start) | **9.1 s** (goal 10 s); stick found -> hub started 1.0 s -> page open 2.2 s |
| note written in the Notebook | landed on the stick |
| pull -> hub saw it | 12 ms after the mount vanished |
| apps stopped | 54 ms; the hub kept running; "Stick removed" shown |
| plug back -> data on the stick again | 2.3 s; the pull was reported; apps not restarted by themselves |

Run 5's 17.6 s was the stick showing up late, not the hub. Data-on-stick mode is ready; it stays off until the owner
switches it on (dataOnStick in ~/.stickhub/settings.json).
