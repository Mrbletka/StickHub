# hub/dataapi: the data API (job 3a)

Apps read and write their data through the hub, never as plain files (design `docs/VAULT-DESIGN.md` 8.1). Built and
tested, **not wired into the hub yet** (3b: procman starts apps with `HUB_DATA_SOCKET` + `HUB_DATA_TOKEN`; 3c: the
Notebook and the sample apps use `hub/appkit/hubfs.mjs`). No lock screen yet (job 4): the server asks `getStore()`.

| File | What |
|---|---|
| `server.mjs` | `createDataApi({socketPath, getStore, limits?})` -> `{issue(appId), revoke(appId), notify(vaultPath, kind, id?), close()}` |
| `routes.mjs` | the routes; app paths in and out |
| `paths.mjs` | app path checks, the `<appId>/` prefix, `ApiError` |
| `tokens.mjs` | one random token per app (32 bytes, base64url), `timingSafeEqual` |
| `events.mjs` | per-app ring buffer of change events, long poll |
| `errors.mjs` | store error code -> HTTP status |

## Wire format
HTTP/1.1 over a Unix socket. Every request: `Authorization: Bearer <token>`. A request with an `Origin` header is
refused (403). Answers: JSON, or raw bytes for `read`. App paths only, like `notes/a.md`.

| Request | Body | Answer |
|---|---|---|
| `POST /v1/tree` | `{path?, depth?}` (no path = the app's whole folder; `depth: 1` = direct children only, 1 to 64) | `{entries: [{path, kind: 'f'\|'d', mtime, size?, id?}]}` |
| `POST /v1/stat` | `{path}` | one entry |
| `POST /v1/read` | `{path, start?, end?}` | raw bytes; headers `x-hub-id`, `x-hub-size` |
| `PUT /v1/write?path=<url-encoded>` | raw bytes; header `x-hub-if-match: <id>` or `none` (must not exist) | `{id, size}` |
| `POST /v1/mkdir` | `{path}` (parents too) | `{}` |
| `POST /v1/move` | `{from, to, ifMatch?}` (files and folders; the target must not exist) | `{}` |
| `POST /v1/remove` | `{paths: [...]}` (1 to 1000, to the vault trash) | `{}` |
| `GET /v1/events?since=N` | - | `{seq, lost, events: [{seq, kind: write\|remove\|move\|mkdir, path, id?, from?}]}` |

Events: the last 1000 per app. Without `since` the answer is the current `seq` at once. With `since` it waits up to
25 s for a first new event. `lost: true` when `since` is older than the buffer or newer than any seq (the hub
restarted): list again. Only changes made through the API are events; `notify()` is the hook for sync (job 5).
No restore, no trash list, no verify for apps.

## Paths
Refused with 400 `BAD_PATH`: empty, absolute, `.` or `..` segments, empty segments, backslash, NUL and control
characters, names the sync rules refuse (`hub/sync/safe-path.mjs`), longer than 240 characters with the app id.
Then the store's own check runs, then `<appId>/` is put in front. A path that starts with another app's id lands
inside the caller's folder. Names that differ only in case: 409 `CASE_CLASH`.

## Limits
| Limit | Value |
|---|---|
| socket path | 107 bytes (sun_path); longer: `SOCKET_PATH_TOO_LONG` at start |
| run dir / socket mode | 0700 / 0600 |
| header size | 16 KiB |
| write body | 32 MiB (413 above); JSON bodies 1 MiB |
| tree answer | 20,000 entries (413 above: ask for a smaller folder) |
| connections | 64 at once (more are closed); the client keeps at most 8 per app |
| request timeout | 60 s to send the whole request (a stalled body is cut off) |
| long poll | 25 s |
| events kept | 1000 per app |

## Errors
JSON `{code, message}`. Messages are fixed texts: never a token, a vault path or a value.

| Code | Status |
|---|---|
| `UNAUTHORIZED` (missing, wrong, malformed, revoked: one text) | 401 |
| `ORIGIN` | 403 |
| `NOT_FOUND`, `NO_ROUTE` | 404 |
| `EXISTS`, `CONFLICT` (ifMatch failed), `CASE_CLASH` | 409 |
| `BAD_PATH`, `BAD_INPUT`, `NOT_DIR`, `IS_DIR` | 400 |
| `TOO_BIG` | 413 |
| `LOCKED` (`getStore()` is null; every route, after the token check) | 423 |
| `NEEDS_REPAIR`, `WRITE_FAILED`, `STORE_BROKEN`, `CLOSED` | 503 |
| `TOO_MANY_PACKS` | 507 |
| `BAD_VX`, `BAD_INDEX`, `PACK_MISSING`, anything else (`INTERNAL`) | 500 |

## The client: hub/appkit/hubfs.mjs
One file, `node:` imports only (a test checks). `readFile(p, enc?)`, `writeFile(p, data, {ifMatch})` (returns
`{id, size}`), `readdir(p, {withFileTypes})`, `rename`, `mkdir(p, {recursive})`, `rm(p, {recursive, force})`,
`stat(p)` (`isFile()`, `isDirectory()`, `size`, `id`, `mtimeMs`), `tree(prefix, {depth?})`, `watch({since?, signal?})`.
With `HUB_DATA_SOCKET` + `HUB_DATA_TOKEN` it talks to the hub; without them it uses plain files under
`HUB_DATA_DIR` or `./data` (same functions, same errors, atomic writes, sha256 ids). `createHubFs({socket, token,
dir, maxInFlight, timeoutMs})` makes one with given settings (`token` may be a function).

Many calls at once (socket mode): at most 8 requests are in flight (`maxInFlight`); the rest wait in a queue, first
come first served, so `Promise.all` over 300 reads or writes works (the hub closes connections above 64). Changes to
one path (`writeFile`, `rename` from and to, `rm`, `mkdir`) reach the hub in the order they were called, even when a
big write is still being sent; a read is not ordered against a change it did not wait for (as with `node:fs`).
Every request ends within `timeoutMs` (60 s): a stalled one fails with `EIO` (`hubCode: 'TIMEOUT'`) and frees its
place in the queue. A write that timed out may still have landed. `watch()` has its own connection, outside the 8.

Error codes: `ENOENT`, `EEXIST`, `ENOTEMPTY`, `EISDIR`, `ENOTDIR`, `EFBIG`, `EINVAL` (bad path or input), `EACCES`
(401/403), `EIO` (503, 500, hub away), `ELOCKED` (423), `ECONFLICT` (ifMatch failed). The hub's code is in
`err.hubCode`.

Differences from `node:fs/promises`:
- Paths are app-relative strings with `/` only; `''` or `'.'` is the app's root for `readdir` and `tree`. No file
  handles, streams, `appendFile`, permissions, links or times you can set.
- `rename` onto an existing file or folder fails with `EEXIST` (node replaces a file). Folders move with their
  contents; a folder cannot move into itself (`EINVAL`).
- `writeFile` creates missing parent folders and returns `{id, size}`; `ifMatch: 'none'` means "must not exist".
- `rm` of an empty folder works without `recursive` (node needs it); a folder with contents needs `recursive`
  (`ENOTEMPTY`). In the hub, `rm` moves to the vault trash.
- `mkdir` without `recursive` on an existing folder: `EEXIST`, as node; with `recursive` an existing file is `EEXIST`.
- `stat().id` is the content id (hub: HMAC; plain files: sha256, computed by reading the file). `mtimeMs` is the
  hub's clock.
- `readdir` lists one folder and nothing below it: one request with `depth: 1` (hub), one directory read (plain
  files). It never reads a file. `tree()` entries carry `id` in the hub; in plain-file mode they have **no `id`**
  (it would mean reading every file of the subtree): ask `stat(path)` for it. `tree(p, {depth: 1})` is the same
  listing with sizes.
- Plain-file mode: `ifMatch` is checked, then written; two processes can still race. `watch()` sees only changes made
  through this process.
- Files up to 32 MiB through the API.

## Honest limits
- Any process of the same Android user can open the socket. It still needs a token. Tokens live in the app's
  environment, and `/proc/<pid>/environ` is readable by that same user. Malware on an unlocked phone is out of scope
  (design section 2).
- Tokens live only in memory; a hub restart gives every app a new one.
