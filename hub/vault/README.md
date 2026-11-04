# hub/vault: the encrypted vault (build step 1 of v1)

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

Use: `parseHeader(text)` -> `unlockWithPassphrase(h, pass)` or `unlockWithPaperCode(h, code)` (the MAC is checked
inside) -> `subkeys(dk, h.vaultId, h.epoch)` -> `sealVx` / `openVx` / streams. Zero the data key and subkeys on lock.

## Word list credit
`wordlist-eff-large.txt` is the **EFF Large Wordlist for Passphrases** by the **Electronic Frontier Foundation**
(EFF), https://www.eff.org/dice (file: https://www.eff.org/files/2016/07/18/eff_large_wordlist.txt), licensed under
**CC BY 3.0 US**, https://creativecommons.org/licenses/by/3.0/us/.
Changed for StickHub: the dice numbers were removed and comment lines with this credit were added at the top; the
7776 words and their order are unchanged (a test rebuilds the original file and checks its sha256).
