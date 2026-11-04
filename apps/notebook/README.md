# Notebook

StickHub app `notebook` (engine `node-server`, fixed port 4110, `atomicData: true`).
Notes are plain files in real folders: `HUB_DATA_DIR/vault/`. No database, no index file, so the vault
syncs with the stick file by file and opens anywhere (any editor, any PC).

## Use
- **Explorer**: a drawer in portrait (button or swipe right near the left edge), a sidebar on wide screens.
  Tap a folder to open it, tap a note to edit it. Long-press (right-click with a mouse) for the menu:
  New note, New folder, Rename, Duplicate, Move to…, Select several, Delete.
- **Move by drag**: long-press a row, then move the finger onto a folder (mouse: just drag). Hovering on a closed
  folder opens it; the list scrolls near its edges.
- **Delete** moves to `vault/.deleted/<date>/<time> <original folder>/`. Explorer menu > Recently deleted: restore or empty.
- **Filter** box: names that contain the text. **Quick open** (magnifier, Ctrl+P): fuzzy search by name.
- **Sort** by name or by last change. Files named `*.conflict-*` (made by the hub sync when both sides changed) show ⚠.
- **Editor**: autosave 800 ms after you stop typing and when the app is hidden. Preview renders Markdown
  (headings, bold, italic, lists, checkboxes, code, links). Monospace font in the ⋮ menu. Ctrl+S, Ctrl+E.
- **Changes from the sync**: on focus the tree reloads. A clean open note reloads; an edited one shows
  "changed somewhere else" with Load theirs / Keep mine.

## Rules
- Names must work on exFAT and Windows: no / \\ : * ? " < > |, no control characters, no reserved names (CON, NUL, COM1…),
  no trailing dot or space, max 200 characters, no two names that differ only in upper/lower case.
  `.part` / `.tmp` endings are not allowed (the hub sync skips them).
- Limits: a note up to 1 MB, the vault up to 5,000 files.
- Nothing in the vault is ever imported or run: notes are data (the vault may live on the stick).
- Writes are atomic (`name.part`, fsync, rename) and unchanged content is never rewritten. That is why the hub may sync
  this app's data while it runs (`atomicData`).
- UI state (open tabs, open folders, sort, recents) is in localStorage, never in the vault. The fixed port keeps it.
- The API checks Host, Origin on every write and Sec-Fetch-Site; no CORS headers; every path stays inside the vault
  (resolved, prefix-checked) and symlinks are never followed. The page has a strict CSP; only the hub may frame it.
- Markdown preview: all HTML escaped, links only for http(s)/mailto/relative notes, no images from the web.

## Files
`server.mjs` HTTP + guards · `lib/vault.mjs` all file operations · `lib/atomic.mjs` atomic writes ·
`public/js/` names (shared with the server), markdown, tree, dnd, editor, dialogs, main · `test/` node:test.

Run alone: `PORT=4110 node server.mjs` (vault in ./data/vault). Later: full-text search, tags, pins, [[wiki links]], conflict compare.
