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

## Run 7 - 2026-11-04: probe 9, Keystore and crypto for the vault (code 6aaf9fb)
Node 24.22.1 with OpenSSL 3.6.5, termux-api 0.60.0. Only sha256 prefixes of signatures were printed.

### Node crypto
| Check | Result |
|---|---|
| Argon2id, scrypt, HKDF-SHA256, AES-256-GCM, ChaCha20-Poly1305 against the RFC test vectors | all ok |
| AES-256-GCM-SIV round trip, tampering detected | ok |
| Argon2id m=19 MiB t=2 p=1 | 68 ms |
| Argon2id m=64 MiB t=3, p = 1 / 2 / 4 | 347 / 271 / 212 ms |
| Argon2id m=128 MiB t=3 p=4 | 362 ms |
| Argon2id m=256 MiB t=3 p=4 | 910 ms, peak memory 310 MB |
| scrypt r=8 p=1, N = 2^15 / 2^16 / 2^17 | 142 / 265 / 539 ms |
| AES-256-GCM, 64 KiB segments | 206 MB/s |
| ChaCha20-Poly1305, 64 KiB segments | 271 MB/s |
| SHA-256 | 1118 MB/s |
| HKDF-SHA256 | 32 us |

### termux-keystore and termux-fingerprint
| Check | Result |
|---|---|
| installed, Termux:API answers | yes; one call (list, sign) 1.1-1.3 s, generate 1.3-1.7 s |
| RSA-2048 key | inside secure hardware |
| sign output | 256 raw bytes on stdout; `verify` accepts that file |
| same challenge -> same signature (SHA256withRSA) | yes: 2 signatures (no-auth key) and 5 (auth key, across locks and unlocks) |
| EC-256 (SHA256withECDSA) | different each time (random, as expected) |
| key with `-u 15` | auth required, enforced by secure hardware |
| 19 s after the last unlock | refused: **no output, exit 0** |
| right after a fingerprint unlock, and again at once | signs; no prompt |
| 19 s later | refused |
| `termux-fingerprint` success (3.2 s with the touch), then sign | signs: the prompt opens the window |
| the fingerprint box | options `-t -d -s -c`; **no pattern button**, fingerprint only (Fabian checked after the run with `termux-fingerprint -t "Test"`) |
| right after a pattern unlock (lock screen) | signs |
| `termux-fingerprint` started while StickHub was in front | Android **switched to the Termux:API app** to show the box (Fabian, after the run); success after 4.3 s, sign ok |
| test keys | deleted (3 left by an interrupted earlier run were deleted first) |

### Decision
The Keystore gate is a time window only: a key signs for N seconds after a fingerprint or pattern unlock, or after a
successful `termux-fingerprint`. Device slot in docs/VAULT-DESIGN.md section 5: RSA-2048 with `-u 30`; try `sign`
first, show the fingerprint box only when it gives nothing, then bring the hub page back (the box takes the screen
away from StickHub); the adapter accepts exactly 256 bytes. Pattern fallback: unlock the phone with the pattern on the
lock screen, then tap Unlock in the hub within 30 s. Passphrase slot: Argon2id
256 MiB, t=3, p=4 (0.9 s). AES-256-GCM stays (10x the stick's speed).

## Run 8 - 2026-11-04: probe 9 again, clear questions (code 146cb6d)
Same phone and versions as run 7. Every result of run 7 repeated; what is new or different:
| Check | Result |
|---|---|
| Argon2id m=256 MiB t=3 p=4 | 1154 ms (run 7: 910 ms), peak memory 308 MB |
| AES-256-GCM / ChaCha20-Poly1305, 64 KiB segments | 256 / 238 MB/s (run 7: 206 / 271) |
| right after a fingerprint unlock | signs (2.6 s for that call); no fingerprint box while signing |
| `termux-fingerprint` (in front) | success, 3.5 s with the touch; **no pattern button** (confirms Fabian's check) |
| `termux-fingerprint` started while StickHub was in front | success after 3.3 s; the box showed **on top of StickHub**; **StickHub in front after the touch** |
| same signature every time | yes (5 signatures, auth key) |
| test keys | deleted (3 left by an earlier interrupted run deleted first) |

Run 7's "switched to the Termux:API app" came from an unclear question; run 8 is taken as the answer. The vault design
keeps one safety net: if the hub page does not report itself visible within 2 s after the box, the hub reopens it.

## Vault v1 step 1 on the phone - 2026-11-04 (code 43f913a)
`node --test`: 160 tests, 159 pass, 0 fail, 1 skipped (the fixture writer, by design), 23 s.

## Vault v1 step 2, part 1 (store) on the phone - 2026-11-04 (code ac569b2)
`node --test`: 190 tests, 189 pass, 0 fail, 1 skipped (the fixture writer, by design), 26 s.

## Run 9 - 2026-11-04: probe 10, the vault store on the stick (code 27fb91c)
`node --test` passed first (the command runs the probe only then). Throwaway vaults, random keys.
| Step | Stick (exFAT) | Phone (control) |
|---|---|---|
| create a vault | 600 ms | 40 ms |
| open, empty | 40 ms | 10 ms |
| one 2 KB save (30 in a row) | median 236 ms, p95 245 ms (207-247) | median 19 ms, p95 40 ms |
| cleanup after those 30 saves (29 index files removed) | 1193 ms | 219 ms |
| burst of 50 saves in one tick | 230 ms, 1 commit | 45 ms, 1 commit |
| 5 MB file write / read | 469 / 92 ms | 128 / 234 ms |
| open with 230 notes | 32 ms | 39 ms |
| index file (230 notes) | 65,560 bytes (the 64 KiB minimum) | same |
| folder fsync | works | works |
| problems | none | none |

Pull test: 12 saves finished, the 13th failed with WRITE_FAILED (stick pulled). After re-plugging, `p10-check.mjs`:
the vault opened with the **old state** (the last finished save), no problems, 13 index files; a **full** cleanup removed
11 index and 11 pack files; a full verify said OK; the test vault was removed.

What it means:
- One save on the stick costs about 236 ms (plain safe write today: 165 ms): 1.4x, at the low end of the estimate.
- A burst of 50 saves is one commit: 230 ms instead of about 50 x 130-165 ms = 6.5-8 s file by file.
- A cleanup costs about 40 ms per removed file on the stick; maintain() every 16 commits removes about 15 index files,
  so about 0.6 s in the write queue now and then.
- Open stays far under the 10 s budget (32 ms with 230 notes).
