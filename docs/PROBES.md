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
- Plan: the watcher polls mountinfo (cheap) and uses `termux-usb` only as a hint, if at all. Depends on probe 1 (re-run).

### 2. Opening the browser
- Foreground: page opened after 2.0 s. **Background (Termux not in front): Chrome opened by itself after 1.5 s.**
- Notification with a tap action: works (opened when tapped).
- So the watcher can call `termux-open-url` directly; the notification stays as the fallback.

### 1. Unplug and re-plug
- Run 1 was not valid: the probe compared with the wrong snapshot and recorded the unplug, not the re-plug.
- What it did show: after unplug the `external-1` link stays but points nowhere; `termux-setup-storage` then
  removes it, and it showed something on screen (you answered "y"). Its question ("rebuild ~/storage?") is
  answered by sending `y` on stdin.
- Fixed probe: re-run with `sh probes/run-all.sh --only 1`.
