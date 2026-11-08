# Notebook

StickHub app `notebook` (engine `node-server`, fixed port 4110, `"data": "hubfs"`, `atomicData: true`).
Notes are files in folders under `vault/` in the app's data, kept through `lib/hubfs.mjs` (design 8.5):
- **hub with the vault on** (`node hub/cli.mjs open --vault`, DEV ONLY now): in the hub's encrypted vault. Nothing
  readable on the disk; rename, move and delete are index operations (fast, even on the stick).
- **otherwise**: plain files in `HUB_DATA_DIR/vault/` (or `./data/vault/` when run alone), synced with the stick file
  by file, readable with any editor. No database, no index file.
"Vault" here is just the notes folder's name; the hub's encrypted vault is a different thing.

## Use
- **Explorer**: a drawer in portrait (button or swipe right near the left edge), a sidebar on wide screens.
  Tap a folder to open it, tap a note to edit it. Long-press (right-click with a mouse) for the menu:
  New note, New folder, Rename, Duplicate, Move to…, Select several, Delete.
- **Move by drag**: long-press a row, then move the finger onto a folder (mouse: just drag). Hovering on a closed
  folder opens it; the list scrolls near its edges.
- **Delete** moves to `vault/.deleted/<date>/<time> <original folder>/`. Explorer menu > Recently deleted: restore or
  empty. In the hub, Empty puts them into the vault's own trash (kept 30 days, not shown here yet).
- **Filter** box: names that contain the text. **Quick open** (magnifier, Ctrl+P): fuzzy search by name.
- **Sort** by name or by last change. Files named `*.conflict-*` (made by the hub sync when both sides changed) show ⚠.
- **Editor**: autosave 800 ms after you stop typing and when the app is hidden. Preview renders Markdown
  (headings, bold, italic, lists, checkboxes, code, links). Monospace font in the ⋮ menu. Ctrl+S, Ctrl+E.
- **Changes from elsewhere**: while the page is visible it follows the hub's change events (`GET /api/changes`, a long
  poll; "lost" = list again), and on focus the tree reloads too. A clean open note reloads; an edited one shows
  "changed somewhere else" with Load theirs / Keep mine. A save sends the note's content id (`ifMatch`), so a change
  that lands at the same moment is never overwritten. Plain files: only the focus check sees the sync's changes.

## Rules
- Names must work on exFAT and Windows: no / \\ : * ? " < > |, no control characters, no reserved names (CON, NUL, COM1…),
  no trailing dot or space, max 120 characters (the vault's limit; was 200), a whole path at most 194, no two names
  that differ only in upper/lower case.
  `.part` / `.tmp` endings are not allowed (the hub sync skips them).
- Limits: a note up to 1 MB, the vault up to 5,000 files.
- Nothing in the vault is ever imported or run: notes are data (the vault may live on the stick).
- Writes are atomic (hub: one commit; plain files: `name.<random>.part`, fsync, rename) and unchanged content is never
  rewritten. That is why the hub may sync this app's data while it runs (`atomicData`).
- UI state (open tabs, open folders, sort, recents) is in localStorage, never in the vault. The fixed port keeps it.
  It holds note names.
- Errors never show the vault folder, the socket or the token (hubfs errors are fixed texts).
- The API checks Host, Origin on every write and Sec-Fetch-Site; no CORS headers; every path stays inside the vault
  (resolved, prefix-checked) and symlinks are never followed. The page has a strict CSP; only the hub may frame it.
- Markdown preview: all HTML escaped, links only for http(s)/mailto/relative notes, no images from the web.

## Files
`server.mjs` HTTP + guards · `lib/vault.mjs` all note operations (on hubfs) · `lib/changes.mjs` change events for the
page · `lib/hubfs.mjs` a copy of `hub/appkit/hubfs.mjs` (never edit it here) · `public/js/` names (shared with the
server), markdown, tree, dnd, editor, dialogs, main · `test/` node:test, every test in both modes (`test/modes.mjs`).

Run alone, from this folder: `PORT=4110 node server.mjs` (notes in ./data/vault). Later: full-text search, tags,
pins, [[wiki links]], conflict compare.
