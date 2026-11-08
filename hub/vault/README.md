# hub/vault: the encrypted vault (v1 steps 1 and 2)

Crypto building blocks for the vault designed in `docs/VAULT-DESIGN.md`. `node:crypto` only, zero dependencies,
standard primitives only. Nothing here logs; errors are `VaultError` with a `code` and a message that never contains
a key, a passphrase, a paper code or any other input value.

| File | What |
|---|---|
| `errors.mjs` | `VaultError` and its codes |
| `bytes.mjs` | `zero()`, strict base64url, 16-byte file id <-> 26-character base32 file name |
| `kdf.mjs` | Argon2id (256 MiB, t=3, p=4) / scrypt fallback, limits checked before any KDF runs, HKDF-SHA256, NFKC |
| `keys.mjs` | the data key (a Buffer: `zero()` it on lock) and its subkeys (header MAC, content ids, file keys) |
| `papercode.mjs` | the paper code: generate, format, parse (forgiving), check characters |
| `words.mjs` | generated passphrases: 5 words, uniform choice by rejection sampling |
| `slots.mjs` | passphrase and recovery slots: AES-256-GCM wrap of the data key; strict slot schema (device slots: schema only, v2) |
| `header.mjs` | `vault.json`: build, strict parse (before any KDF), MAC, unlock with passphrase or paper code |
| `vx.mjs` | `.vx` files (packs, index): STREAM segments, per-file keys, Padme padding; buffers and streams |
| `vfs.mjs` | file I/O for the store, with a guard for fault injection (unplug tests) |
| `replica.mjs` | one vault folder: header copies, index scan (newest valid wins; a cache of older files for cleanup), index commit, a new vault |
| `indexfile.mjs` | index and pack contents, checked field by field after decryption |
| `vxread.mjs`, `store-read.mjs` | range reads (only the needed segments), one pack at a time (`withPack`), whole reads, 4 MiB chunked reads |
| `store-ops.mjs` | file operations on a draft (check first, then change) |
| `packs.mjs` | packs and the next index for a commit (decoded back once before it is written) |
| `queue.mjs` | the write queue: one thing at a time; changes of the same tick share one commit |
| `cleanup.mjs`, `compact.mjs` | cleanup (full or light) in capped runs; compaction by size tiers (at most 12 packs per call, each segment read once) |
| `maintain.mjs` | maintenance in steps: each step its own queue item, so a save waits for one step at most |
| `verify.mjs`, `export.mjs` | `vault verify` and `vault export` (CLI in `hub/cli-vault.mjs`) |
| `store.mjs` | the store API: `Store.create`, `openVaultFolder`, read/write/move/trash/maintain/verify |

Use: `parseHeader(text)` -> `unlockWithPassphrase(h, pass)` or `unlockWithPaperCode(h, code)` (the MAC is checked
inside) -> `subkeys(dk, h.vaultId, h.epoch)` -> `sealVx` / `openVx` / streams. Zero the data key and subkeys on lock.

## In the hub (job 4): `hub/lock/`
| File | What |
|---|---|
| `service.mjs` | the vault's state in the hub (none, locked, unlocking, unlocked, locking), unlock by passphrase or paper code (one at a time; a lock wins), the lock in steps, auto-lock |
| `limiter.mjs` | the unlock rate limit of design 7.9 (`~/.stickhub/vault/attempts.json`), with an injectable clock |
| `routes.mjs` | `GET /api/vault`, `POST /api/vault/unlock`, `/lock`, `/heartbeat` |

The store opens only through `VaultService.unlock()` (the lock screen); `store.flush()` finishes the commit in
progress for the lock, `store.close()` zeroes the keys. `vault setup` (`hub/cli-setup.mjs`) makes a new vault in
`~/.stickhub/vault-dev`. The page side is `hub/ui/vaultlock.js`.

## Word list credit
`wordlist-eff-large.txt` is the **EFF Large Wordlist for Passphrases** by the **Electronic Frontier Foundation**
(EFF), https://www.eff.org/dice (file: https://www.eff.org/files/2016/07/18/eff_large_wordlist.txt), licensed under
**CC BY 3.0 US**, https://creativecommons.org/licenses/by/3.0/us/.
Changed for StickHub: the dice numbers were removed and comment lines with this credit were added at the top; the
7776 words and their order are unchanged (a test rebuilds the original file and checks its sha256).
