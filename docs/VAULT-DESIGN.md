# Encrypted vault: design (reviewed)

Status: **design only, nothing is built.** Reviewed by Claude and Fabian on 2026-11-04; the decisions are in
section 0 and are folded into the sections below.
Keystore and Node crypto facts were measured on the phone by probe 9 (docs/PROBES.md, runs 7 and 8) and are marked
**(p9)**. Numbers marked "measured" come from docs/PROBES.md; "estimate" means not measured yet.

## 0. Decisions after review
| # | Decision |
|---|---|
| 1 | Device slot: result B as designed (RSA-2048, `-u 30`, try `sign` first, fingerprint box only if needed). The only fallback is **passphrase at every start**; no soft slot |
| 2 | The phone copy is encrypted too |
| 3 | Apps use the data API. The client looks like normal file functions (`readFile`, `writeFile`, `readdir`, `rename`, `mkdir`, `rm`, `stat`), so a port is one small change. `hub new` gives new apps the client by default. Plain files when an app runs alone |
| 4 | Auto-lock after 5 min with no visible hub page; also lock when the stick is pulled in data-on-stick mode |
| 5 | The hub generates a passphrase of 5 random words by default (EFF large word list, 7776 words, CC BY 3.0 US, with attribution). An own passphrase only with 20+ characters |
| 6 | Argon2id m = 256 MiB, t = 3, p = 4 (0.9-1.2 s on the phone). The limits in 4.2 stay |
| 7 | A vaulted stick gets a new marker (format 2), so an old hub ignores it |
| 8 | Plain data left on the flash chips from before the vault stays a known limit. Fabian decides about a fresh stick |
| 9 | Paper code: 28 characters. Using it always shows a NEW paper code. Rekey only on request |
| 10 | Vault trash: 30 days |
| 11 | App browser state that holds names is cleared on lock |
| 12 | Windows/portable, offline new phone, WebAuthn: later, not now |
| A | Two releases. **v1** = passphrase + paper code only, end to end (store, data API, Notebook port, sync, migration, lock). **v2** = device slot. v2 must not block v1 |
| B | `vault export <folder>` (decrypt everything to plain files in a folder Fabian names) and `vault verify` (read and check every file) come early, in build step 2. Before the first migration: a plain backup tar on the phone, its path printed; doctor warns while it exists |
| C | Hard lock: `vault lock --hard` and a Termux:Widget shortcut **StickHub lock**: lock and delete this phone's device secret (and its Keystore key). Then only the passphrase or the paper code opens the vault until the phone enrolls again. Reason: a fingerprint can be forced; a passphrase in the head is harder |
| D | Passphrase and paper-code fields: Chrome must not offer to save them, Gboard must not learn them (section 7.9). Checked by hand in probe 10 |
| E | A Keystore signature counts only if it is exactly 256 bytes, never by exit code |
| F | Unlock attempts on the hub API are rate-limited (section 7.9) |
| G | p9: the fingerprint box has no pattern button, so the pattern fallback is the lock screen. Run 8 (clear questions): the box shows on top of StickHub and StickHub is in front after the touch, so the page is brought back only if it does not report itself visible (section 5) |

## 1. Summary
- Today the app data on the stick (`HUB/data/`) is plain files. Whoever finds the stick reads everything.
- With the vault, `HUB/data/` holds only encrypted files and wrapped keys. File names, folder structure, file count and
  exact sizes are hidden. The code snapshot (`HUB/hub/`, `HUB/apps/`) stays plain.
- One random **data key** encrypts everything. Three kinds of **key slots** each wrap that data key:
  passphrase (Argon2id), device key (Android Keystore, opened by fingerprint or pattern), recovery code (paper).
- The phone copy uses the same encrypted format, so "locked" means nothing is readable on the phone either.
  Plain data exists only in memory: in the hub, in the app that uses it, and in its page in Chrome.
- Apps no longer read and write plain files. They ask the hub (a small data API over a private socket). This is the
  biggest change for apps; the Notebook must be ported.
- A change never edits an encrypted file in place. It writes new encrypted files, then one small index file. The newest
  index that decrypts is the truth. That makes every write atomic on the exFAT stick, and a sync costs a few file
  writes instead of one per file.

Fixed decisions (from the brief, not reopened here): all of `HUB/data/` locked, code plain; three slot types wrapping
one random data key; fingerprint and pattern only open the device key on that phone and are never the only secret;
unlock once at hub start, auto-lock after idle, locked = nothing readable; new device via START-HERE.txt and one
command; `node:crypto` only, standard primitives; malware on an unlocked phone and forced unlock are out of scope.

## 2. Threat model

### What we protect
App data (notes, saves) and its metadata (file names, folders, sizes, how many files).

### In scope
| Threat | What protects | Result |
|---|---|---|
| Stick lost or stolen; the finder copies it and has unlimited time and computers | Everything in `HUB/data/` is AES-256-GCM. The data key is wrapped three ways: passphrase (Argon2id, slow and memory-heavy per guess), device key (lives in the phone's secure hardware, never on the stick), recovery code (130 random bits) | Unreadable. The weakest point is the passphrase: a short or common one can be guessed offline. See section 4.2 |
| Stick tampered while away (files changed, swapped, cut short, deleted) | Every encrypted file is authenticated; keys and nonces are bound to the file's id; the header has a MAC | Detected, never silently accepted. Deleting files is a denial of service; the phone copy is the backup |
| Stick rolled back to an older copy of itself | Each phone remembers the newest index number it saw on the stick | Detected by any phone that synced before. A brand-new device cannot tell |
| Phone lost or stolen, screen locked | Phone copy encrypted; nothing runs in Termux without unlocking the screen; the device key refuses unless the phone was unlocked (fingerprint or pattern) in the last 30 s **(p9)**; Android limits wrong pattern tries (growing waits) | Unreadable without unlocking the phone, the passphrase or the paper code. If the hub was unlocked when the phone was taken, the data key is in memory until auto-lock (section 7.3) |
| A copy of the phone's Termux folder (a backup, a tar on the stick or in a cloud) | The device key stays in the phone's secure hardware; the copy holds only a helper secret | Useless without that phone: the key is inside secure hardware **(p9)** |
| Pulling the stick at any moment, crashes, ColorOS killing Termux | Copy-on-write: new files first, then the index; the newest valid index wins | Old state or new state, never a broken one. Leftovers are cleaned up at the next open |
| A web page in Chrome trying to reach the data | Apps reach data only through a Unix socket in `~/.stickhub/` (no TCP, so no browser can connect) with a per-app token; hub API token as today | Refused |
| One app reading another app's data | The token decides the namespace `<app-id>/`; every path is checked | Refused |

### Out of scope (honest limits)
- Malware, root, or any other process running as Termux on an **unlocked** phone. It can read the hub's memory, use
  the device key during its time window, or record the passphrase. No design here stops that.
- Being forced to unlock (by a person or by law). Partial help: the hard lock (7.3) removes the fingerprint path, so
  only a passphrase in your head or the paper code opens the vault.
- Attacks on the phone's hardware or Android itself (TEE bugs, lock-screen bypass, cold-boot, chip-off forensics).
- Key material in memory: JavaScript cannot pin memory; keys may be copied by the garbage collector or written to
  swap (ColorOS "RAM expansion" swaps to the phone's storage). We zero key buffers on lock, as best effort only.
- The code is plain and comes from GitHub. A bad commit (or a stolen GitHub account) could steal the passphrase on the
  next `git pull`. `autoPull` stays off by default.
- A tampered stick can lie in START-HERE.txt (for example, a different download command). Only run the command if it
  points to `github.com/Mrbletka/StickHub`.
- The paper code is as safe as the place it is kept. Paper code + stick = all data.
- Chrome and the keyboard: Gboard may learn words you type in notes; screenshots; apps' own browser storage
  (section 8.5). Data API answers are sent with `Cache-Control: no-store`.
- Plain data written to the stick **before** the vault may still be on its flash chips after migration (a USB stick
  cannot be reliably overwritten). A known limit; Fabian decides about a fresh stick (decision 8).
- Nothing is "unhackable". The goal is: a lost stick, or a lost locked phone, does not give away the data.

### What a stick finder can still see
That this is a StickHub stick with a vault; the code snapshot (including which apps exist); how many key slots of each
type there are and the passphrase's KDF settings; the total size of the vault (padded) and the number of encrypted
files; roughly when and how much was written (exFAT times, file sizes); the random install id (`dev-...`) in `HUB/.lock`.
Not visible: file names, folders, how many files each app has, single file sizes, file contents, device names.

## 3. Building blocks (node:crypto, zero dependencies)
| Job | Primitive (standard) | Node | Settings |
|---|---|---|---|
| Passphrase -> key | Argon2id (RFC 9106) | `crypto.argon2('argon2id', ...)`, Node 24 | m = 256 MiB, t = 3, p = 4: 0.9-1.2 s and 310 MB peak on the phone **(p9)**. RFC 9106's second option (64 MiB) takes only 0.2 s there, so we afford 4x the memory. Stored per slot |
| Passphrase -> key if Argon2id is missing | scrypt (RFC 7914) | `crypto.scrypt` | N = 2^17, r = 8, p = 1 (128 MiB): 0.54 s on the phone **(p9)**. Only for a device without Argon2id |
| High-entropy secret -> key, subkeys | HKDF-SHA256 (RFC 5869) | `crypto.hkdf` | 32-byte output, labels below |
| Encrypt and authenticate | AES-256-GCM, 96-bit nonce, 128-bit tag | `createCipheriv('aes-256-gcm')` | 206 MB/s on the phone **(p9)**, 10x the stick. ChaCha20-Poly1305 is a bit faster there (271 MB/s), but AES-GCM is also in WebCrypto and crypto is not the bottleneck |
| Long files | STREAM (Hoang et al. 2015), as in `age`: 64 KiB segments, nonce = 11-byte segment number + 1-byte "last" flag | AES-256-GCM per segment | per-file key, so nonces never repeat |
| Content ids, header MAC | HMAC-SHA256 | `createHmac` | keys derived from the data key |
| Hide sizes | Padmé padding (Nikitin et al., PETS 2019): at most 12% extra in general, at most about 3% for the sizes used here (64 KiB and up) | - | minimum 64 KiB per file |
| Randomness | OS random | `crypto.randomBytes` | - |
| Device key | RSA-2048, PKCS#1 v1.5 signature with SHA-256 (deterministic) | `termux-keystore sign`: 256 raw bytes, 1.1-1.3 s per call **(p9)** | key inside secure hardware, never leaves the phone |

On the phone (Node 24.22.1, OpenSSL 3.6.5) all of these give the published RFC answers (Argon2id, scrypt, HKDF,
AES-GCM, ChaCha20-Poly1305) **(p9)**. HKDF takes 32 us, SHA-256 runs at 1.1 GB/s.

## 4. Key hierarchy
~~~
passphrase  --NFKC--> Argon2id(salt, m, t, p, ad = vault id + slot id) ----> KEK_pass --+
paper code  --------> HKDF-SHA256(salt, info = "...recovery" + ids) ------> KEK_rec  --+-- AES-256-GCM unwrap --> DK
Keystore signature of the slot's challenge + device secret                              |
            --------> HKDF-SHA256(salt, info = "...device" + ids) --------> KEK_dev  --+

DK (32 random bytes, one per epoch)
  --HKDF--> K_header  (HMAC of the header)
  --HKDF--> K_id      (HMAC content ids: dedupe and three-way sync)
  --HKDF--> K_file    --HKDF(salt = file id)--> one key per encrypted file (packs and index files)
~~~

### 4.1 Data key (DK)
- 32 bytes from `randomBytes`. Never written anywhere unwrapped. Exists only in the hub's memory while unlocked.
- Subkeys: `HKDF-SHA256(ikm = DK, salt = vault id + epoch, info = "StickHub vault v1 " + purpose)`.
- **Epoch**: a number that goes up when the data key is replaced (rekey, section 7.7). Slots belong to one epoch.
- Each slot wraps DK with `AES-256-GCM(KEK, random 12-byte nonce, DK)`. The AAD is
  `"StickHub vault v1 slot" + vault id + epoch + slot id + the slot's own settings`, so a slot cannot be moved to
  another vault or slot, and changed settings make it fail instead of doing something weaker.

### 4.2 Passphrase slot (a)
- Exactly one. Works on any device with the hub (the "any device" slot). The phone's Node has Argon2id **(p9)**, as
  do official Node 24 builds (Windows later). For a device without it, the slot would be made with scrypt instead.
- Passphrase canonical form (decided): NFKC (Polish letters typed on another keyboard give the same bytes), trim both
  ends, collapse every run of whitespace (spaces, tabs, newlines, no-break spaces) to one space, no case folding.
  Then Argon2id with a
  16-byte random salt and `associatedData = vault id + slot id` (or scrypt with the salt). The slot records its KDF.
- The KDF settings are read from the stick before unlocking, so they are checked: Argon2id m <= 1 GiB, t <= 10,
  p <= 8; scrypt N <= 2^20. Anything else is refused (a tampered stick must not make the phone run out of memory).
- This slot is what a stick finder attacks offline. Argon2id makes each guess slow and memory-heavy (256 MiB per
  guess, on any hardware), but a short or common passphrase still falls. So (decision 5):
  - By default the hub **generates** the passphrase: 5 words from the EFF large word list (7776 words, about
    64.6 bits), picked by rejection sampling on 16-bit random values (uniform, no modulo bias), joined by spaces. The list ships as `hub/vault/wordlist-eff-large.txt` with the words only (the
    dice numbers removed); it is licensed CC BY 3.0 US, so the file header and the README credit the Electronic
    Frontier Foundation, link the source and the license, and say what was changed.
  - An own passphrase is accepted only with 20 or more characters (counted in the canonical form).
- KDF: Argon2id m = 256 MiB, t = 3, p = 4 (decision 6).

### 4.3 Device slot (b) **(p9)**
- One per enrolled phone. The phone keeps two things, never on the stick, never in git:
  1. an RSA-2048 key in the Android Keystore (inside secure hardware), made by `termux-keystore generate -u 30`, which
     signs only in the 30 s after a fingerprint or pattern unlock (section 5), and
  2. a 32-byte **device secret** in `~/.stickhub/vault/<vault id>.json` (mode 600), with the key's alias and the slot id.
- The slot on the stick holds a random 32-byte challenge and a salt. To open it:
  `sig = Keystore sign(challenge, SHA256withRSA)`; `KEK_dev = HKDF-SHA256(ikm = sig + device secret, salt,
  info = "StickHub vault v1 device" + vault id + slot id)`; unwrap DK.
- This needs the signature to be **the same every time** for the same challenge. RSA PKCS#1 v1.5 is deterministic by
  its math; ECDSA is not (random), so EC keys cannot be used. **p9**: 5 signatures of one challenge, across locks and
  unlocks, were identical; two ECDSA signatures differed. Enrolling still signs twice and refuses the slot if they
  differ. The signature is never stored or logged.
- `sign` prints the 256 raw signature bytes. When the key is not open it prints **nothing and still exits 0** **(p9)**,
  so the adapter accepts exactly 256 bytes and treats anything else as "not unlocked".
- The fingerprint and the 9-dot pattern are never an input to any key derivation. Android checks them (with growing
  waits after wrong tries) and then allows the Keystore key to sign. A pattern has about 390,000 combinations, but an
  attacker with only the stick has nothing to try them against: the secret is the hardware key in that one phone.
- Why the device secret too: defence in depth. If the Keystore ever signed without the user (a Termux:API change),
  the slot would still need a file from that phone's private storage.
- Android deletes Keystore keys that need user auth when the screen lock is turned off (per Android docs; to confirm).
  Clearing the Termux:API app's data, reinstalling Termux or a factory reset also lose it. Then the slot fails and
  the passphrase is used once to enroll again (section 7.8). Losing a device slot never loses data.

### 4.4 Recovery slot (c): the paper code
- Exactly one. 26 random characters from the Crockford base32 alphabet (`0-9 A-Z` without `I L O U`) = 130 bits,
  plus 2 check characters, written as 7 groups of 4: `K7QX-2M9D-...`. Typing is forgiving: lower case, `I`/`L` = 1,
  `O` = 0, spaces and dashes ignored.
- The check characters are a typo check, not crypto: the sum of (position x value) over the 26 characters, modulo
  the prime 1021 (like an ISBN check digit). That catches every single wrong character and every swap of two
  neighbours, before any key work.
- `KEK_rec = HKDF-SHA256(ikm = the 26 characters in canonical form, salt, info = "StickHub vault v1 recovery" + vault id + slot id)`.
  No slow KDF is needed: 2^130 guesses are out of reach.
- Shown once, in the hub page, at setup. Never stored, never logged, no copy button (clipboard history), no
  screenshot (asked not to). Then you type two groups back to show it is written down.

### 4.5 What lives where
| Thing | Where | Never |
|---|---|---|
| DK | hub memory while unlocked | on any disk, in logs, in the browser |
| Wrapped DK (slots), KDF settings | header on the stick and on each phone | - |
| Passphrase | your head; hub memory briefly while unlocking (best effort, section 2) | stored anywhere |
| Paper code | paper, at home (not with the stick) | phone, stick, clipboard, photos |
| Keystore key | phone secure hardware (Termux:API's keystore) | exportable at all |
| Device secret, key alias | `~/.stickhub/vault/` on that phone | stick, git, backups you share |
| Plain file contents and names | hub and app memory, the page in Chrome | stick, phone files, logs |

## 5. Device slot: what probe 9 showed, and the build
Measured **(p9, termux-api 0.60.0)**:
- `termux-keystore` works. One call (list, sign) takes 1.1-1.3 s; making a key 1.3-1.7 s. The keys are inside
  secure hardware; for a key made with `-u N` the auth is required and enforced by that hardware.
- It is a **time window only**: the key signs for N seconds after the phone was unlocked with the fingerprint or the
  pattern, and refuses after that. No prompt shows when it signs.
- A successful `termux-fingerprint` (the "fingerprint box") also opens the window. It takes a title (`-t`), so it
  can say "Unlock StickHub". The box has **no pattern button**: fingerprint only (Fabian checked with
  `termux-fingerprint -t "Test"`).
- Started from the background while StickHub is in front, the box works (fingerprint accepted, sign ok, 3.3-4.3 s).
  Run 8, with clear questions: the box shows **on top of StickHub**, and **StickHub is in front after the touch**.
  (Run 7 had reported a switch to the Termux:API app; its question was unclear. Run 8 is taken as the answer.)

The build:
- Key: RSA-2048, `generate -u 30` (decision 1).
- Unlock: first try `sign` (1.2 s). If the phone was unlocked in the last 30 s (you usually unlock it, then plug in
  the stick or tap the widget), that is all: no extra touch. If `sign` gives nothing:
  `termux-fingerprint -t "Unlock StickHub"`, then `sign` again. Safety net for run 7's report: if the hub page does
  not report itself visible (7.3 heartbeat) within 2 s after the touch, the hub calls `termux-open-url` once.
- Pattern instead of the finger (the box has none): lock the phone and unlock it with the pattern (p9: this opens
  the window), then tap **Unlock** in the hub within 30 s; its first `sign` then works. The lock screen says so:
  "Finger not working? Lock the phone, unlock it with your pattern, then tap Unlock."
- Cancelled or failed: the passphrase or the paper code.

Honest strength:
- The key never leaves the phone's secure hardware: the stick alone, or a copy of Termux's files, is useless.
- The fingerprint or pattern gates the key only through time. Any process running as Termux can sign during the
  30 s after **any** unlock of the phone, even a normal one, with no prompt. That matters only for malware on the
  phone (out of scope); a person who holds your unlocked phone can open the hub anyway.
- A locked phone cannot run Termux, and after 30 s the key refuses until the next unlock.

If it ever stops working (a Termux:API update changes the output, signatures stop being the same, the key is gone),
the device slot fails, the passphrase opens the vault, and the phone enrolls again (section 7.8). The safest
fallback, if the Keystore could not be trusted at all, stays: passphrase at every hub start, no device slot. There is
no "soft" slot (decision 1).
- A signature counts only if `sign` gave exactly 256 bytes; the exit code is ignored (decision E).
- Still to measure in probe 10 (v2): plug-in to open on both paths, and how often the safety net is needed. Until
  then: try the sign and open the page at the same time.

## 6. File format

### 6.1 Layout
~~~
<stick root>/START-HERE.txt   plain: what this is and how to add a new phone (no secrets)
HUB/
  stick-v2.json               plain marker of a vaulted stick (format 2): same fields as stick.json plus "vault": 1.
                              There is no stick.json, so an old hub sees no stick and touches nothing (decision 7)
  hub/ apps/ .index.json      code snapshot, plain, unchanged
  data/                       THE VAULT
    vault.json                header: slots, KDF settings, header MAC
    vault.bak.json            second copy of the header
    _index/<id>.vx            encrypted index (the 2 newest are kept)
    _packs/<id>.vx            encrypted packs (file contents)
  .lock .journal.json .running.json    plain, as now (no names inside)
  .trash/<date>/code/         code only; deleted data goes to the vault's own trash

Phone (phone copy mode): ~/StickHub/data/ has the same layout (the phone replica).
Phone (data-on-stick mode): ~/StickHub/data/vault.json only (a header copy, so unlock can start before the stick).
~/.stickhub/vault/<vault id>.json    device secret + Keystore alias + slot id (mode 600); in data-on-stick mode
                                     also the last stick index number seen (for the rollback check)
~/.stickhub/run/data.sock            data API socket (apps -> hub)
~~~
`<id>` = 26 random lower-case base32 characters (128 bits). Names say nothing about the content.
Folder names start with `_`, which no app id can. The new hub reads `stick-v2.json` first and `stick.json` for sticks
without a vault. An old hub looks only for `stick.json`, so it finds nothing: no sync, no plain data written. (Its
`stick init --force` could still write a new `stick.json`; START-HERE.txt and the README say to update first.)

### 6.2 Header (`vault.json`)
~~~json
{ "stickhubVault": 1,
  "body": "{\"vault\":\"<16 B>\",\"epoch\":1,\"hseq\":4,\"slots\":[ ... ]}",
  "mac": "<HMAC-SHA256(K_header, body)>" }
~~~
Slots inside `body` (binary values in base64url):
~~~
{ "id": <16 B>, "type": "passphrase", "kdf": { "alg": "argon2id", "m": 262144, "t": 3, "p": 4, "salt": <16 B> }, "nonce": <12 B>, "wrapped": <48 B> }
{ "id": <16 B>, "type": "device", "sign": "SHA256withRSA", "challenge": <32 B>, "salt": <32 B>, "nonce": ..., "wrapped": ... }
{ "id": <16 B>, "type": "recovery", "salt": <32 B>, "nonce": ..., "wrapped": ... }
~~~
- `body` is a string, so the MAC covers exact bytes (no JSON re-ordering problems).
- Before unlocking, `body` is untrusted: max 64 KiB, strict schema, at most 1 passphrase + 1 recovery + 8 device
  slots, KDF limits from 4.2. After unlocking, the MAC is checked. A wrong MAC: try `vault.bak.json`, then the phone's
  copy; never write with a header that failed its MAC.
- Device names, dates and "last used" are not in the header; they are in the encrypted index.
- `hseq` goes up on every header change. The stick's header is the master: key changes (section 7) are made only with
  the stick plugged in, written to the stick first, then copied to the phones. Phones take a header with a higher
  `hseq` (same or newer epoch) only after its MAC checks.
- Written safely: `.part`, fsync, rename; first `vault.json`, then `vault.bak.json`.

### 6.3 Encrypted files (`.vx`): packs and index files
~~~
8-byte plain header: "SHVX" | version 1 | kind ('P' pack, 'I' index) | 0 0
then segments: AES-256-GCM(file key, nonce = segment number (11 bytes) + last flag (1 byte),
                           64 KiB of plaintext (the last one shorter), AAD = the 8-byte header) + 16-byte tag
file key = HKDF-SHA256(K_file, salt = file id (from the file name),
                       info = "StickHub vault v1 file" 0x00 | kind letter | vault id | epoch (4 bytes))
plaintext of all segments = length (4 bytes) + payload + zero padding up to max(64 KiB, Padmé(4 + length))
~~~
- The key comes from the name, so renaming or swapping files makes them fail to decrypt. A cut-short file fails
  (no segment marked "last"); extra bytes after the last segment are refused.
- Reading part of a big file decrypts only the 64 KiB segments it needs.
- **Pack** payload: the blobs, then a table of contents (deflated JSON: for each blob piece its content id, part,
  offset, length, and a hint of path and time, used by part reads and by a repair tool if every index is lost), then
  the table's length (4 bytes). A pack is at most 32 MiB (31 MiB of blobs); a bigger file spans several packs.
- **Index** payload: deflated JSON (section 6.4). Compressing the index before encryption is fine here: nobody can
  inject chosen text into it and watch sizes.
- A `.vx` file is written once and never changed. A **pack** is written directly under its final random name (no
  `.part`): until an index points to it, it does not exist for the vault. An **index** file is written as
  `<id>.vx.part`, fsync, then renamed to `<id>.vx` (the commit point), so a `.vx` index that does not decrypt is always
  damage, never a pulled stick. Unreferenced files are removed by the cleanup (8.6).

### 6.4 Index content
~~~js
{ v: 1, vault, replica, epoch, seq, time,             // seq goes up by 1 per index written on this replica
  files: { "<app>/<path>": { kind: 'f' | 'd', id, size, mtime, extents: [[pack, offset, length], ...] } },
  trash: [ { path, id, size, mtime, deletedAt, extents } ],
  packs: { "<pack id>": { size, live } },             // live bytes, for compaction
  peers: { "<replica id>": { base: { "<path>": id }, seenSeq, seenEpoch, lastSync } },   // three-way sync base
  devices: { "<slot id>": { name, created, lastUsed } } }
~~~
- `id` = `HMAC-SHA256(K_id, content)`: the content id. Same content = same id, so a duplicate or a moved file
  costs no space, and sync compares ids instead of hashing files on the stick.
- Folders are entries of kind `'d'` (the Notebook has empty folders).
- Paths follow today's rules (`relOk`: exFAT/Windows names, 120 chars per name, 240 per path, depth 16) even though
  they never touch a file system: export to plain files and Windows stay possible.
- About 150 bytes per file: 5,000 notes is about 750 KB of JSON, roughly 150-250 KB after deflate (estimate).

### 6.5 Hiding names and sizes: what leaks
| | Hidden? |
|---|---|
| File and folder names, which app owns what | yes: only inside the encrypted index |
| How many files | yes, after compaction (many files share a pack); between compactions the number of new packs shows how many saves happened |
| Exact file sizes | mostly: Padmé leaves a size class (at most 12% wide), and anything under 64 KiB looks the same |
| Total vault size | no (padded total is visible) |
| When and how much was written | no (exFAT times, new file sizes) |

### 6.6 Everything on the stick is untrusted
As today: names checked, sizes and counts limited (index file <= 16 MiB, pack <= 32 MiB + padding, at most 10,000
packs, index JSON validated field by field after decryption), nothing is ever run or imported. Decryption failures are
reported with the file's random name only.

## 7. Flows
Key changes (setup, add device, change passphrase, new paper code, remove device) need the stick plugged in.

### 7.1 Setup (once, on the phone that has the data today)
1. Update this phone (`git pull`). Other devices with an old hub ignore the vaulted stick (new marker, 6.1) until
   they are updated.
2. In the hub: **Set up the vault** (or `node hub/cli.mjs vault setup`). Doctor checks: stick, Termux:API, screen lock.
3. The hub shows a generated 5-word passphrase (or you type your own, 20+ characters, twice). Argon2id runs (0.9 s on
   the phone, p9).
4. The paper code is shown once; you write it down and type two groups back.
5. v2 only: this phone's device slot is enrolled: Keystore key made (`-u 30`), fingerprint asked, two signatures
   compared (section 4.3). In v1 there is no device slot.
6. Migration: a normal plain sync first, so phone and stick agree. Then a **plain backup tar** of the phone's `data/`
   is written to `~/stickhub-plain-backup-<date>.tar` (Termux home, never on the stick, never in the clone); its path
   is printed, and the doctor warns while it exists ("plain copy of your data: delete it when the vault works").
   Then every file goes into the phone replica, the stick replica is written, and **every file is read back and
   compared** with the original. Only then the plain copies are removed: phone `data/`, `.trash/`, `sync-state.json`; stick `HUB/data/<app>/` and `HUB/.trash/*/data/`.
   Old hub logs with file names are cleared. Interrupted: the next start continues; plain files stay until the
   check passes. The backup tar stays until you delete it.
7. `vault verify` runs once on both replicas. `START-HERE.txt` and `stick-v2.json` are written; `stick.json` is
   removed last.
Writes: header (2 copies) on both sides, packs and index on both sides, the backup tar; in v2 also the device files in
`~/.stickhub/vault/`.

### 7.2 Unlock (daily)
1. The hub starts locked (widget, or the watcher at plug-in). The page shows the lock screen; no app can start.
2. If this phone has a device slot, the hub starts the unlock at once, in parallel with opening the page:
   `termux-keystore sign` (no touch if the phone was unlocked in the last 30 s; else the fingerprint box, which
   shows on top of StickHub, then sign again; the page is brought back only if it is not visible) -> HKDF -> unwrap DK -> check the header MAC ->
   read the newest index (phone replica; in data-on-stick mode the stick's) -> tiles.
3. Cancelled or failed: buttons **Fingerprint**, **Passphrase**, **Paper code**. In v1, and after a hard lock, only
   **Passphrase** and **Paper code**.
4. Phone copy mode needs no stick to unlock. After unlocking, a plugged-in stick syncs in the background.
The header copy on the phone lets the unlock start before the stick is even seen.

### 7.3 Auto-lock
- Lock when no hub page has been visible for **5 minutes** (the page sends a heartbeat every 30 s while visible; a
  hidden, closed or frozen page stops sending). The hub page cannot see touches inside an app's iframe (another
  origin), so visibility is the signal (decision 4).
- Also lock: **Lock** button, `node hub/cli.mjs vault lock`, hub stop, and in data-on-stick mode when the stick is pulled.
- **Hard lock** (decision C, v2): `node hub/cli.mjs vault lock --hard`, or the Termux:Widget shortcut **StickHub lock**
  (`widget install` writes it to `~/.shortcuts/tasks/`). It locks, then deletes this phone's device secret and its
  Keystore key. Until the phone enrolls again (passphrase, 7.8), only the passphrase or the paper code opens the
  vault. Use it when someone could force your finger. In v1 there is no device secret, so it is a normal lock.
- Locking: finish the commit in progress, stop all apps (SIGTERM, 1.2 s grace, as for "Stick removed"), close data API
  sessions, zero key buffers, drop the index. The page shows the lock screen; the player iframes are removed.
- A crash or ColorOS killing Termux locks too: the keys only ever lived in that process.
- While locked, the hub API shows no data names (no conflict lists, no sync details with paths).
- App browser state that holds names is cleared on lock (decision 11, section 8.5).

### 7.4 Add a device
1. On the new phone: install Termux and Termux:API (both from F-Droid), open the stick in Files, open `START-HERE.txt`.
2. Copy its one command into Termux:
   `pkg install -y nodejs git termux-api && git clone https://github.com/Mrbletka/StickHub ~/StickHub && node ~/StickHub/hub/cli.mjs setup`
3. `setup` (first launch) creates the device account (`~/.stickhub/`: install id, token, settings), runs
   `termux-setup-storage` once, runs the doctor, installs the widget, starts the watcher and the hub, opens the page.
4. The page says "New phone: unlock once with the passphrase". The passphrase opens the stick's header.
5. The device slot is enrolled (as in 7.1 step 5); you give the phone a name. The new slot is written to the stick's
   header (`hseq` + 1), then the phone copy is made by a first sync.
Code comes from GitHub, never from the stick, so a tampered stick cannot run code on the new phone, as long as the
command is the real one (section 2).

### 7.5 Recover with the paper code
For a forgotten passphrase, or when no device can unlock.
1. Lock screen: **Paper code**; type the 28 characters. The check characters point at a typo first.
2. The code unwraps DK. A **new paper code** is always shown (the old one was just typed on a device) and the old
   recovery slot is replaced. If the passphrase was forgotten, set a new one too. v2: this device is enrolled if it
   was not.
3. No rekey by default. Only on request: **Also replace the data key** (rekey, 7.7), for example if the paper may
   have been seen by someone else (decision 9).

### 7.6 Change the passphrase
1. Unlocked, plus the current passphrase or a fresh fingerprint (someone at an unlocked hub must not lock you out).
2. New passphrase -> new salt -> new passphrase slot; `hseq` + 1; written to the stick, then the phones.
3. Limit: an old copy of the header (another phone not synced yet, an old copy of the stick) still opens with the old
   passphrase, with the same DK. If the old passphrase may be known to someone: choose **Also replace the data key**.

### 7.7 Remove a lost device (rekey)
Removing only the lost phone's slot does nothing: that phone has its own copy of the header and its own replica. So
removing a device always replaces the data key.
1. On another device, unlocked, stick plugged in: **Devices** -> the lost phone -> **Remove**. Asks for the passphrase.
2. New DK2, epoch + 1. New passphrase slot (from the passphrase just typed). Paper code: type the current one to keep
   it, or get a new one. This device gets a new device slot. Other phones' slots are dropped (we cannot open their
   keys from here): each of them unlocks once with the passphrase, which re-enrolls it.
3. Everything is re-encrypted under DK2 (a compaction into new packs, first on the stick, then on this phone), then a
   new index and header are committed, then all DK1 files are deleted. About data size / 19 MB/s on the stick plus
   ~0.2 s per pack (estimate: 100 MB in about 10 s). Interrupted: the old state stays valid until the new header is
   written; the next start continues.
4. Another phone that still has epoch 1 sees "The vault was re-keyed. Unlock with the passphrase": it opens the
   stick's new header, merges its own epoch-1 replica into DK2 (it can still read it) and deletes the old files.
What stays possible: whoever can unlock the lost phone can read what was on it until it was lost. Nothing written
after the rekey.

### 7.8 When the device key stops working (v2)
Screen lock removed, Termux:API data cleared, new phone, or a Termux:API update that changes `sign`: the device slot fails with a clear
message ("This phone's key is gone"). Unlock with the passphrase; the old slot is replaced by a new one.

### 7.9 Typing the passphrase and the paper code (decisions D, F)
- Only the hub's own lock screen asks for them, never an app (apps are stopped while locked).
- Fields: `type="password"` (masked; Android keyboards, Gboard included, do not learn from password fields),
  `autocomplete="off"`, `autocapitalize="off"`, `autocorrect="off"`, `spellcheck="false"`, a random `name` and `id`
  per page load, no username field and no `<form>` submit (the value is read by script, sent with `fetch`, and the
  field is cleared at once), so Chrome has nothing to offer to save. Probe 10 checks by hand: no "Save password?",
  no word suggestions, nothing learned afterwards.
- Rate limit on the hub API (all callers together): the first 5 failed unlocks are free, then each next try waits
  twice as long (2 s, 4 s ... up to 5 min). The count lives in `~/.stickhub/vault/attempts.json`, so a hub restart does
  not reset it; a good unlock resets it. This only slows guessing at the phone; an offline attack on a copied stick
  meets Argon2id instead.

## 8. Apps, Notebook, sync and atomic writes

### 8.1 Apps ask the hub for their data
Plain files on the phone would break "locked = nothing readable", and Termux has no FUSE (no root) to fake a file
system. So:
- The hub serves a small **data API** over a Unix socket (`~/.stickhub/run/data.sock`). Each app process gets
  `HUB_DATA_SOCKET` and a random `HUB_DATA_TOKEN` per start; browsers cannot reach a Unix socket at all.
- Calls (namespace = the app's own `<app-id>/`): `tree(prefix)`, `stat`, `read(path, range)`, `write(path, data,
  ifMatch)` (atomic replace, returns the new content id), `mkdir`, `move(from, to, ifMatch)` (files or whole folders),
  `remove(paths)` (to the vault trash), `events` (what changed, for "changed somewhere else"). Errors: 404, 409
  (ifMatch failed or exists), 413, 423 (locked).
- The client module (`hub/appkit/hubfs.mjs`) looks like `node:fs/promises` for what apps use (decision 3):
  `readFile`, `writeFile` (atomic), `readdir` (with `withFileTypes`), `rename`, `mkdir`, `rm`, `stat`, with the same
  argument order and fs-style error codes (`ENOENT`, `EEXIST`, `ENOTEMPTY`). Extras: an `ifMatch` option on writes,
  `tree(prefix)` and `watch()` for changes. Porting an app is mostly changing the import from `node:fs/promises` to
  `./lib/hubfs.mjs`.
- `node hub/cli.mjs new` copies the client into every new app (`lib/hubfs.mjs`) and the starter uses it. A test checks
  that every app's copy equals the source.
- When an app runs alone (`PORT=4110 node server.mjs`), the client uses plain files in `./data`, as today.
- `HUB_DATA_DIR` is not given to apps once the vault is on. An app that still wants it shows a clear error on its
  tile instead of starting (one broken app never breaks the hub). The `app-rules` test checks every app.
- Every write is atomic by construction, so every app behaves like `atomicData: true` and sync no longer waits for
  apps to stop ("pending" goes away).

### 8.2 The atomic write on encrypted files
An encrypted file is never changed in place. A change:
1. encrypts the new content into a new pack under a new random name, fsync;
2. writes a new index file (seq + 1) as `<id>.vx.part`, fsync, renames it to `<id>.vx`, fsyncs the folder;
3. later, cleanup deletes old index files, `.part` leftovers and unreferenced packs (by itself every 4 commits, in small steps).
The newest index that decrypts is the truth. Pulled out after step 1: the pack is garbage, the old index still rules.
During step 2: the `.part` is ignored, the previous index rules. A failed write marks the open store broken; the next
open reads the truth from the disk. Several writes that arrive together share one
pack and one index (group commit). The header is the only file changed in place: `.part`, fsync, rename, two copies.

### 8.3 Costs on the exFAT stick
| Action | Plain files today (measured) | Vault (measured, probe 10, PROBES.md run 9) |
|---|---|---|
| One Notebook save, data on the stick | 1 safe write, about 165 ms | median 236 ms, p95 245 ms (new pack + new index) |
| 50 saves at once | about 50 x 130-165 ms = 6.5-8 s | 230 ms: one commit |
| 5 MB file | 64 MB at 19 MB/s measured | write 469 ms, read 92 ms |
| Sync 120 changed small files | 15.5 s (129 ms per file) | not measured yet; one commit like the burst above, plus the bytes |
| Delete 120 files, rename a folder of 300 notes | 14.1 s; 300 renames | one commit, index only (no pack): at most about 0.24 s |
| Find what changed on the stick | read and hash every file | read one index file |
| Open (read the index) | - | 40 ms empty, 32 ms with 230 notes (index 64 KiB) |
| Cleanup | - | about 40-55 ms per removed file (29 index files: 1.2 s) |
| maintain() after 100 piled-up saves | - | 10 s; a save behind it waited 13.6 s (run 10, one big task) |
| the same, in steps (job 2b) | - | 21.6 s in 29 steps; a save behind it waited 553 ms (run 11; target < 1.5 s met). Job 2c: run 12 pending (target about 10-12 s) |
| steady state: 100 saves, automatic maintenance on | - | median 390 ms, p95 1610 ms, max 1702 ms (run 11; target max < 1.5 s missed). Job 2c: run 12 pending |
Run 10 showed a save waiting behind the whole maintain() task. Job 2b cuts maintenance into steps (8.6): a save
waits for at most one step, about 10 deleted files (0.55 s on the stick) or one compaction call.
So the vault is slower than today only for a single save in data-on-stick mode (1.4x), and much faster for
everything that touches many files. Pull test: pulled mid-saves, the stick reopened with the last finished save, no
problems, cleanup and verify fine.

### 8.4 Three-way sync between the phone and the stick
Both replicas use the same DK, so sync runs while unlocked.
1. Take `HUB/.lock` (as now). Write `HUB/.journal.json` (counts only) so an interrupted sync is reported.
2. Read the stick's newest index; the phone's is in memory. **Rollback check**: if the stick's `seq` (or epoch) is
   lower than `peers[stick].seenSeq` in the phone's index, stop and ask ("The stick's data is older than last time").
3. Plan with today's `planData()` unchanged: phone map and stick map are `path -> {size, hash: content id}`, the base
   is `peers[stick].base` (this replaces `sync-state.json`, which held plain names on the phone).
   - Only one side changed: copy it. Both changed the same way: just remember it.
   - Both changed differently: the phone's version keeps the name; the stick's is kept as `name.conflict-<time>.ext`
     on both sides (today's `conflictRel`). The Notebook shows it with ⚠.
   - Deleted on one side: on the other side the file moves into the vault trash (index `trash`); changed on the
     other side: the change wins. As today.
4. Copy: the content the stick lacks (by content id) is re-encrypted into one new pack (several if > 32 MiB), then
   one new stick index. Then the same towards the phone, then the phone index with the new base and `seenSeq`.
5. Remove the journal, release the lock.
Pulled out mid-sync: whatever index was committed rules; the next sync plans again and finishes (the plan is
idempotent, as today). The trash keeps deleted files for 30 days, then compaction drops them (decision 10).
Code sync (`hub/`, `apps/`, git decides) is unchanged and stays plain. Triggers stay as now (plug-in, Sync now);
because a data sync now costs a few file writes, a later step can also sync a few seconds after each change while
the stick is plugged in.

### 8.5 Notebook
- Its `lib/vault.mjs` (all file operations) is ported to the client: mostly the import changes; `list` and `index`
  can use one `tree()` call, the write's `base` check becomes `ifMatch` with the content id (today it already compares a content hash),
  rename/move/duplicate become index operations (fast, even on the stick), `.deleted/` stays a folder in its namespace.
- Limits stay: a note up to 1 MB, 5,000 files.
- `*.conflict-*` files and "changed somewhere else" work as today (the `events` call replaces looking at the files).
- Its UI state in localStorage (open tabs, recent notes) contains note names, so it is cleared on lock (decision 11).
  How, for every app that keeps names in browser storage: (1) before the hub stops an app (lock, stick pulled, stop),
  the hub page loads that app's `/__hub/clear` in a hidden frame; the client's server helper answers it with
  `Clear-Site-Data: "storage"`, which makes Chrome drop that origin's storage; (2) the app page also stores the app's
  start id next to its state and drops the state when the id changed (covers a crash, where step 1 never ran).
  Probe 10 checks that Chrome honours `Clear-Site-Data` on `http://127.0.0.1:<port>`.
- The name "vault" inside the Notebook (`HUB_DATA_DIR/vault/`) is a different thing; it may be renamed to avoid
  confusion.

### 8.6 Compaction and cleanup
- Runs inside the store's write queue, as `maintain()`: purge trash older than 30 days (store clock), compact if worth
  it, then clean up. The store starts it after the first commit of a session and then every 4 commits, in steps
  (below); with nothing to do it does no I/O.
- Compaction (`compact.mjs`, one commit per call, stoppable between packs), by size tiers (job 2c): a pack whose
  live bytes are under 50% of its size is a candidate any time (that frees dead space). A mostly live pack under
  1 MiB sits in a **size tier** by its live bytes: tier 0 under 4 KiB, tier 1 under 16 KiB, tier 2 under 64 KiB,
  tier 3 under 256 KiB, tier 4 under 1 MiB (x4 per tier). Only a tier with at least 4 packs is merged, lowest tier
  first. 4 packs of a tier make a pack of a higher tier, so a pack that was just merged is not rewritten until its
  own tier is full again, and a byte moves about once per tier. Packs of 1 MiB and more that are mostly live stay.
  It runs with a full tier, at least 4 mostly dead packs, or 4 MiB of dead bytes in them; cheapest first, up to
  16 MiB of live bytes and 12 packs per call. Cost bound (test `vault-store-tiers`): 300 saves of 2 KB over 20 notes,
  alone or on top of 230 notes, move at most 8x the saved bytes (5 tiers, plus at most one move when a pack falls
  under 50% live, which is smaller than the dead bytes it frees); measured 2.7x. Before tiers, each automatic run in
  a vault under 1 MiB rewrote all live notes (on top of 230 notes about 58x the saved bytes). At most 3 packs per
  tier stay unmerged, so a small vault keeps up to about 15 packs in use.
- Reading for compaction (job 2c): each chosen pack is opened once and only the pieces that move are read, in offset
  order, so each segment is decrypted at most once and segments without a moving piece are not read (compaction
  reads at most the bytes ever written to `_packs`). Every segment is authenticated (AES-GCM, STREAM, length
  checked in segment 0); every moving piece must be listed in its pack's table of contents under its content id,
  offset and length; when **every** piece of a file moves, the file's content id (HMAC) is checked as before. **A file
  that only partly moves is no longer read whole, so its whole-file content id is not checked during compaction**
  (its moving pieces are still authenticated and checked against the table of contents; `vault verify` checks
  every content id). The live pieces move into new packs of about 8 MiB; extents of files and trash are updated; a
  piece shared by several files (dedupe) moves once; a file over several packs moves piece by piece and keeps its
  part numbers. The old packs stay while the previous index uses them; a later full cleanup
  removes them. Never while there are problems (full cleanup would be refused, so new packs would only fill the disk).
- `emptyTrash(ids?)` removes trash entries for good (all, or some); `purgeTrash()` the ones older than 30 days.
- Removes `.vx` files no index refers to (leftovers of a pull or crash) and old index files beyond the 2 newest.
- Two levels (job 2 part 2, C1). **Full** does all of the above, only when nothing is damaged. **Light** runs when an
  index file or a header copy is damaged: it removes only index `.part` files and valid index files beyond the 2
  newest valid ones, never packs, damaged files or headers, so index files cannot pile up until open fails. Neither
  runs when the order is unclear (the newest index on disk is not the store's, two share a number, replicas mixed).
- At 200 files in `_index` new commits are refused (`NEEDS_REPAIR`: run `vault verify`, then `vault export`); reads,
  verify and export keep working. Open refuses more than 256.
- Pulled out mid-compaction: the new pack is garbage, the old packs are still referenced. Nothing is lost.

**Maintenance in small steps (job 2b).** On the stick a deleted file costs about 55 ms, and run 10 showed a save
waiting 13.6 s behind one big `maintain()`. So maintenance is cut into steps, and a save waits for at most one step:
- **Capped cleanup runs.** One run deletes at most `cleanupMax` files (default 10) and says `more: true` when work is
  left. The order is unchanged: index `.part` files, valid index files beyond the 2 newest, unused packs, header
  `.part` files, and the header backup completion last (it counts as one unit of the cap). Every run starts with its
  own scan and the same checks as before; the only thing carried from one run to the next is the index cache below,
  which never decides the 2 newest indexes.
- **Bounded compaction.** One call reads at most `maxPacks` packs (default 12) and at most `maxBytes` live bytes
  (16 MiB), and makes one commit.
- **Steps.** A step is one unit of work: a due trash purge (one commit), one compaction call, or one capped cleanup
  run. `maintain()` and `cleanup()` still finish the job for their caller and return one merged result (counts
  summed, plus `steps`), but each step is its own item in the write queue, queued only after the previous step
  finished. Saves that arrive meanwhile are already in the queue, so they go first. A chain ends when nothing is
  left, or when a run is blocked, busy (reads in progress) or fails. It never spins: compaction steps continue only
  while the number of packs in use or the dead bytes go down; cleanup steps do at most as much work as the chain's
  first cleanup run saw (a run reports `left`, the units it saw and did not do), so saves that arrive all the time
  cannot keep a chain going (it ends with `more: true`; the next maintenance takes the rest); and every chain stops
  after 50,000 steps.
- **Automatic maintenance.** The same triggers (the first commit of a session, then every `autoCleanupEvery`
  commits, now 4 by default) queue one step at the tail; a step that leaves work queues the next step at the tail.
  Only one automatic chain runs at a time, and it gives way to an explicit `maintain()` or `cleanup()`: it does not
  start while one runs, and a running one ends (its queued step is dropped, or it queues none). Each chain has at
  most one step in the queue, so a save waits for at most one step per running chain (once: the end of a running
  automatic step plus the first explicit step). `status().maintaining` is true while the automatic chain runs. Its
  errors go to `status().lastCleanup`, never to a save.
- **close()** waits for the step that is running and for everything callers queued (saves, explicit tasks).
  Automatic steps that have not started are dropped, a running one queues no successor, and an explicit `maintain()`
  or `cleanup()` stops after its current step. So `close()` takes at most about one step.
- **The 200-file guard** runs one capped cleanup run inside the commit, then refuses if still at the limit.
- **Unfinished header writes** (`#dirty`) are cleared only by a full run that ended with `more: false`.
- **Index cache (job 2c).** Run 11 showed the repeated scans doubling the total work of a big backlog (21.6 s
  instead of 10.0 s on the stick): every capped run decrypted all index files again. So the store keeps the decoded
  older index files by name and size between cleanup runs (`replica.scanIndexes` with a cache; cleanup only). Rules:
  every run still lists `_index` and does its own block checks; a new name, or a name with another size, is decoded;
  a cached entry that ends up among the 2 newest is decoded again, until the 2 newest valid indexes of the run are
  fresh, so the pack rule ("the 2 newest valid indexes of this run's scan") never trusts the cache; only older files
  come from it, and those are only ever deleted; a file that fails to decrypt is never cached; a gone name is
  dropped. An entry holds only size, seq and replica. Open, `verify` and `export` always read everything fresh.
  What the cache cannot see: an older file changed in place with the same size after this store read it (our code
  never does that; a name is written once). A fresh open or `verify` sees it. Measured on a container disk (backlog
  of 102 index + 97 pack files): one big run 255 ms, capped runs before 1296 ms, with the cache 410 ms.
- **Run 11 (before job 2c)** missed two targets: the steady state (max 1.7 s on the stick: each automatic run in a
  small vault rewrote all live notes) and the worst-case total (21.6 s: repeated scans). Job 2c (tiers, reading
  each segment once, the index cache) is for both; run 12 measures it.

## 9. Speed: plug-in to open in 10 s or less
"Open" = the hub page shows the tiles, unlocked.
| Step | Measured today | With the vault |
|---|---|---|
| USB -> stick mounted | about 1 s (run 2) | same |
| Mounted -> watcher sees it | 0-2 s (poll every 2 s) | 0-1 s: poll every 1 s (one read costs 0.7 ms) |
| Stick found -> hub started (cold) | 1.0-1.1 s (runs 4, 6) | same |
| Stick found -> page open, logged in | about 2-3 s (runs 4, 6) | same, in parallel with the unlock |
| Keystore sign (phone unlocked in the last 30 s) | - | 1.1-1.3 s **(p9)** |
| Otherwise: failed sign, fingerprint box and touch, sign again | - | 1.2 + about 3.5 + 1.2 s (`termux-fingerprint` 3.3-3.5 s with the touch, **p9**); + 1.5-2 s only if the safety net reopens the page |
| Unwrap DK, check header | - | under 10 ms (HKDF 32 us on the phone, **p9**) |
| Read + decrypt the index | - | about 0.1-0.2 s on the stick (estimate) |
| **Plug-in -> open** | **6.6 s** (phone copy), **9.1 s** (data on the stick, cold hub) | see the two cases below |

The unlock starts as soon as the hub runs, in parallel with the page opening (2-3 s after the stick is found), and
from the header copy on the phone, so it does not wait for the stick.
- **Fast path** (the phone was unlocked in the last 30 s, the usual case when you pick it up and plug in the stick):
  one sign, 1.2 s, hidden behind the page load. Plug-in -> open stays close to today: about 6.6-9.5 s (estimate).
- **Fingerprint-box path** (unlocked longer ago): about 6 s after the hub starts; the box shows on top of StickHub.
  Plug-in -> open about 10-13 s (estimate): **at or over the goal**.
To avoid or shorten the fingerprint-box path:
1. Keep the hub running and unlocked: the widget tap starts it and unlocks it on the fast path (you just unlocked the
   phone to tap). Plug-in then needs no unlock at all, unless the hub auto-locked.
2. Poll mountinfo every 1 s instead of 2 s (0.7 ms per read): 0.5 s less on average.
3. Probe 10 (after the build) measures both paths.
The passphrase path is slower (typing + 0.9 s Argon2id). In **v1** that is the only path, so v1 does not meet the
10 s goal on a cold start; it does when the hub is already unlocked (plug-in then adds no unlock). The goal is for v2.

## 10. Tests
All `node:test`, all must pass on the phone. The Keystore and Termux:API sit behind an adapter
(`platform/keystore.mjs`) with a fake: a deterministic fake signer (HMAC of the challenge), a random one (to test
the refusal), and one that prints nothing and exits 0 (what `termux-keystore sign` does when the window is closed, p9).
- **Known answers**: Argon2id (RFC 9106), scrypt (RFC 7914), HKDF (RFC 5869), AES-256-GCM, ChaCha20-Poly1305 (RFC
  8439) on the device itself; Argon2id tests skip with a clear message where it is missing (scrypt path tested).
- **Fixtures**: a small vault made with fixed keys and nonces, committed under `test/fixtures/` (test keys only).
  Reading it must keep working in later versions and on Windows.
- **Slots**: each type wraps and unwraps; wrong secret fails; changing any byte of salt, nonce, wrapped key, KDF
  settings, slot id, vault id or epoch fails; a slot cannot be moved to another vault or slot; KDF limits refuse a
  huge memory setting; non-deterministic fake signer -> enrollment refused.
- **Paper code**: format and grouping; every single-character typo and every swap of neighbours is caught by the
  check characters; `I L O`, lower case, spaces and dashes accepted.
- **`.vx` files**: round trip at 0 bytes, 1 byte, 64 KiB +- 1, a few MiB; cutting the file at every segment edge,
  flipping any byte, swapping two segments, swapping two files' names, adding bytes at the end: all refused.
  Padmé sizes as expected.
- **Header**: MAC catches any change; bad JSON or schema refused before any KDF runs; falls back to the backup copy.
- **Store**: newest valid index wins; torn newest -> previous; group commit; dedupe; folders; trash and restore.
- **Unplug**: the existing fault injection in `fsx` (`guard`) kills the write at every step of save, sync, migration,
  rekey and compaction; reopening always gives the old or the new state, never an error, and cleanup removes the rest.
- **Sync**: today's `planData` tests stay; vault-level tests with two replicas in temp folders (`STICKHUB_MOUNTS`):
  both changed -> conflict copy on both sides; delete vs change; rollback of the stick detected.
- **Data API**: no token / wrong token refused; app A cannot reach app B (`..`, absolute paths, case tricks);
  `ifMatch`; 423 when locked; `no-store` headers; the client's plain-files mode for apps run alone.
- **Lock**: fake clock; no visible page for 5 min -> locked; apps stopped; key buffers zeroed; the API answers with no
  names while locked.
- **No secrets in output**: unlock, setup, recovery and sync with a recording logger: no passphrase, paper code, DK,
  signature, device secret or file name appears in logs or API errors.
- **Migration and rekey**: all files verified before plain copies go; after a rekey no DK1 file is left and DK1 opens
  nothing; an interrupted run continues.
- **Passphrase generator**: always 5 words from the list, uniform (`randomInt`), list has exactly 7776 unique words;
  own passphrases under 20 characters refused.
- **Export and verify**: export writes every file with its name and content; verify reports a flipped byte in any
  pack or index; export refuses a folder inside the clone or on the stick.
- **Marker**: a vaulted stick has `stick-v2.json` and no `stick.json`; today's `findStick` sees it as blank.
- **Rate limit**: waits double after 5 failures, survive a restart, reset after success.
- **Hard lock**: the device secret and Keystore key are gone; the device slot fails; the passphrase still opens.
- **Keystore adapter**: 0, 255 and 257 bytes = not unlocked, whatever the exit code.
- **Phone**: probe 10 after the build (v1 part first): one save on the stick, sync of 120 changed notes, compaction,
  pull mid-save, the field checks of 7.9, `Clear-Site-Data`; v2 part: plug-in to open with the fingerprint, and whether the
  safety net (page reopened after the box) is ever needed.

## 11. Build order
**v1: passphrase + paper code, end to end.** No device slot; nothing in v1 waits for v2.
1. `hub/vault/` crypto helpers: Argon2id (256 MiB, limits), slot wrap/unwrap for passphrase and paper code, `.vx`
   files, paper code, passphrase generator with the EFF word list and its attribution. Tests and fixtures.
2. Store: header, index, packs, commit, cleanup, compaction, 30-day trash. **`vault export <folder>` and
   `vault verify`** here, so every later step can be checked and undone. Unplug tests.
3. Data API + fs-like client (`hub/appkit/hubfs.mjs`), `hub new` uses it by default; port the sample apps, then the
   Notebook (including clearing browser state on lock).
4. Lock and unlock: lock screen with the safe fields (7.9), rate limit, auto-lock (5 min, stick pulled), CLI
   `vault setup|status|lock|export|verify`, doctor checks (Argon2id, plain backup tar present).
5. Sync between replicas (reusing `planData`), rollback check, the `stick-v2.json` marker.
6. Migration (plain backup tar first, verify, then remove plain copies), change passphrase, new paper code, rekey on
   request, START-HERE.txt and `cli.mjs setup` for a new phone (passphrase). Probe 10, v1 part, on the phone.

### v1 step 1: built (commit 4640777)
Crypto building blocks in `hub/vault/` (overview in `hub/vault/README.md`). Tests only: nothing is wired into the hub.
KDFs (Argon2id 256 MiB t=3 p=4, scrypt fallback, limits checked before running, HKDF, NFKC), passphrase and recovery
slots, paper code, generated passphrases (EFF list, credited), header build / strict parse / MAC / unlock, `.vx`
files on buffers and streams, `zero()`. 60 new tests, including the RFC known answers, a fixture vault
(`test/fixtures/vault-v1/`, TEST ONLY) and a recording test that finds no secret in any output or error.

Exact encodings (the design left them open; the fixture now freezes them):
- Binary values in JSON: base64url without padding, canonical only (one spelling per value). `.vx` file names: RFC 4648
  base32, lower case, 26 characters, canonical only.
- Subkeys: `HKDF-SHA256(DK, salt = vault id | epoch (4 bytes), info = "StickHub vault v1 header" / "... content-id" /
  "... file")`.
- Slot AAD: `"StickHub vault v1 slot" 0x00 | vault id | epoch (4 bytes) | slot id | the slot without id, nonce and
  wrapped as JSON with a fixed key order`. `wrapped` = AES-GCM ciphertext (32 bytes) | tag (16 bytes).
- Passphrase key: Argon2id(NFKC passphrase, salt, associated data = vault id | slot id), 32 bytes; scrypt the same
  without associated data. Recovery key: `HKDF-SHA256(ikm = the 26 canonical characters as ASCII, salt,
  info = "StickHub vault v1 recovery" 0x00 | vault id | slot id)`.
- `.vx` file key and padding: section 6.3 (now exact).
- `vault.json`: compact JSON `{"stickhubVault":1,"body":"...","mac":"..."}` plus a newline; MAC =
  HMAC-SHA256(K_header, body as UTF-8).

Deviations and choices, with the reason:
1. scrypt limits: besides N <= 2^20 also r <= 32, p <= 4 and memory (128 x N x r) <= 1 GiB, so a tampered stick cannot
   make scrypt huge through r or p either.
2. Argon2id's lower limit is its own minimum (m >= 8 x p KiB). No minimum strength is enforced: on reading, weaker
   settings only give a different key; on making a slot, the hub always uses the default (tests pass tiny settings).
3. Generated passphrases are joined by spaces, not hyphens: 4 EFF words contain a hyphen (drop-down, felt-tip,
   t-shirt, yo-yo). One can be as short as 19 characters (5 x 3 + 4); the 20-character rule is for own passphrases.
4. Words are picked by explicit rejection sampling (as the review asked) instead of `crypto.randomInt`; both are
   uniform.
5. A v1 hub parses device slots (schema of 6.2) without opening them, so it can still read a v2 header and open it
   with the passphrase or the paper code.
6. A header or `.vx` file of a newer format version gives `UNSUPPORTED` ("update this hub"), not "damaged".
7. A sealing stream needs the payload size up front (it is in segment 0). The data API knows the size of every write;
   a write without a known size must be spooled first (step 3).
8. Opening streams hand out payload bytes as each 64 KiB segment is authenticated; the end of the file is checked at
   the end. A user of the stream must throw the result away if the stream errors.
9. Left for later steps: reading a byte range of a `.vx` file, the header fallbacks (`vault.bak.json`, the phone's
   copy), the rate limit, everything about the device slot.

### v1 step 2 (store core, API, reading, limits, cleanup): built (commits 129513d, aaee2ee, 56e54c0)
Done in job 2, parts B1-B5 (`vault export` / `vault verify`, compaction and the store probe come next).
`hub/vault/`: `vfs.mjs` (guarded file I/O), `replica.mjs` (header copies, index scan, index commit, new replica),
`indexfile.mjs` (index and pack contents, checked field by field), `vxread.mjs` (range reads), `store-ops.mjs`
(file operations on a draft), `packs.mjs`, `cleanup.mjs`, `store.mjs` (the API). Later in job 2: `store-read.mjs`
(reads), `queue.mjs` (the write queue: one thing at a time, changes of the same tick as one commit), `compact.mjs`
(compaction and maintain), `verify.mjs`, `export.mjs`. 28 new tests: store, limits,
cleanup, unplug at every step of a save, a group commit, a cleanup and a header write, and the store in the
no-secrets test.

Store API (async; changes go through one write queue; changes of the same moment share one commit):
`Store.create(dir, {headerText, dk})`, `openVaultFolder(dir, unlock)`, `tree(prefix)`, `stat(path)`,
`read(path, {start, end})`, `write(path, data, {ifMatch})` (ifMatch null = create only), `mkdir(path)`,
`move(from, to, {ifMatch})`, `remove(paths)` -> trash ids, `restore(tids, {to})`, `listTrash()`, `cleanup()`,
`writeHeader(text)`, `status()` (counts, problems, last cleanup; no names), `close()`.

Deviations and choices, with the reason:
1. Index files go through `.part` + rename (6.3 said no `.part`). Without it, a stick pulled during a save leaves a
   torn `.vx` index that looks exactly like damage, and the safety rule would then stop every later cleanup. Packs
   keep the no-`.part` write. Cost: one rename more per commit on the stick (to be measured by the store probe).
2. The pack's table of contents is at the end, not the start: the blob offsets are then known before it is written.
3. Full cleanup refuses when **any** index file is damaged, not only "the newest": an unreadable file has no
   readable number, so nobody can prove it is older. It also re-reads and MAC-checks both header copies when it runs.
   Since part 2 (C1) a **light** cleanup still removes index files then (8.6), so one damaged file cannot make the
   folder fill up.
4. Open never writes. Leftovers are removed by cleanup, which the store queues by itself; the counter starts from what
   is on the disk at open (index files beyond the 2 newest, plus `.part` files), because Termux can end a session
   at any time (C1: 26 short sessions used to make open fail).
5. A store with problems (damaged index, header copy) still opens, reads and writes; full cleanup and compaction are
   refused and `status().problems` says why (each reason once). At 200 index files commits stop (`NEEDS_REPAIR`).
   Repair is a later tool.
10. Found in part 2: a piece shared by several files (dedupe) was counted once per file in the pack's live bytes,
   so such an index failed its own check on the next open. Fixed (each piece counts once); every new index is now
   decoded and compared before it is written, and that check is what found it. A path such as `__proto__` was lost
   from the index (C2); writing the content a file already has no longer makes a commit (C3); folder listings stop
   after the limit + 1 names (C4).
6. Writing a file creates its missing parent folders. Names that differ only in case are refused (exFAT, Windows,
   export). Paths follow `relOk` (120 characters per name, 240 per path, depth 16).
7. Part reads check the piece against the pack's table of contents; whole reads check the content id (HMAC).
8. Limits besides 6.6: 100,000 files, 100,000 trash entries, 64 extents per file, 256 MiB per file, an index inflates
   to at most 64 MiB, at most 256 files in `_index` and 20,000 in `_packs`.
9. Files whose names are not canonical vault names are never touched, in `_index`, `_packs` or the folder itself.

### v1 step 2, part 2: fixes C1-C4 and `vault verify` / `vault export` (D)
- C1-C4 (commit f219982): see 8.6 and deviation 10 above.
- `vault verify <folder> [--quick] [--paper] [--json]` (`hub/vault/verify.mjs`, `hub/cli-vault.mjs`): no writes.
  Quick: both header copies parse, pass the MAC and are equal; every index decrypts and passes its checks; every pack a
  valid index uses exists with the right size. Full (default): also decrypts every segment of those packs, reads their
  tables of contents and checks every file and trash entry of the newest index against its content id. Output: counts
  and random file names only. Exit 1 on any problem. Missing packs plus a newer index on disk (the running hub cleaned
  up) -> it checks once more.
- `vault export <folder> <dest> [--paper]` (`hub/vault/export.mjs`): the destination is checked before the passphrase
  is asked (missing or empty; not inside the vault folder, not inside this clone, not on a mounted volume). Files are
  read in 4 MiB chunks (`store.readChunks`, content id checked after the last chunk), written as `<name>.part` and
  renamed only after the check; empty folders are created; every path is checked to stay inside the destination. A
  pack missing because the running hub cleaned up -> one reopen with the same data key (`store.reopen()`, no KDF); a
  second miss is damage. Exit 1 on any failure.
- The passphrase or paper code is read on the terminal in raw mode with no echo (`hub/cli-prompt.mjs`: typing, paste,
  bracketed paste, Backspace, Ctrl-U, Ctrl-C; escape sequences ignored). A stdin that is not a terminal is refused.

### v1 step 2, part 2: trash and compaction (E)
Built as described in 8.6: `emptyTrash`, `purgeTrash`, `compact({maxBytes, signal})`, `maintain()` (replaces the plain
automatic cleanup). The commit path is shared: compaction and trash purging commit through the same pack + index
`.part` + rename steps as a save. Tests: 300 saves over 20 notes then `maintain()` (at most 3 live packs, every note
reads back), unplug at every step of a compaction, trash at 29 and 31 days with a fake clock, dedupe kept, a file
over several packs, a read started before the compaction commit (this process's cleanup waits for running reads),
no compaction while there are problems, a cancelled compaction writes nothing, `maintain()` with nothing to do writes
nothing.

### v1 step 2b: maintenance in small steps: built
As described in 8.6 (`maintain.mjs`, capped `runCleanup`, `compact({maxPacks})`). Tests (`vault-store-steps`):
cleanupMax 1 with a backlog of 30 files and saves all the time (no save more than one deletion behind, verify OK,
`maintain()` ends), the same with automatic steps after every commit, unplug at every step of a stepped
`maintain()`, blocked (another writer between steps) and busy (a read opened between steps) end the chain after
one deletion, `close()` does not wait for pending steps, the automatic chain gives way to `maintain()`; compaction
reads at most 12 packs per call. Probe 10 gained the stepped worst case, the steady state with automatic
maintenance on, and the pull test with automatic maintenance on.

### v1 step 2c: faster maintenance: built
As described in 8.6: size tiers (`compact.tierOf`), compaction reads each chosen pack once (`PackReader.withPack`,
each segment decrypted at most once), and the index cache for cleanup runs. On a container disk probe 10 went from
steady p95 248 ms / max 426 ms to 29 / 33 ms, and the worst-case maintain from 1977 ms to 663 ms. Stick: run 12.

**v2: device slot.**
7. Keystore adapter (exactly 256 bytes), enroll, unlock (try `sign`, else fingerprint box, then sign; reopen the page only if not visible),
   pattern hint on the lock screen, devices page, remove a device (rekey), `vault lock --hard` and the **StickHub
   lock** widget. Probe 10, v2 part: plug-in to open on both paths.

## 12. Still open
All twelve review questions are decided (section 0). Left for later measurement, not for design:
1. Probe 10 (v1): `Clear-Site-Data` on `http://127.0.0.1:<port>` in Chrome; the field checks of 7.9; vault costs on
   the stick.
2. Probe 10 (v2): plug-in to open on both paths; whether the page ever needs reopening after the fingerprint box.
3. Fabian: whether to move to a fresh stick before migrating (decision 8).
4. Decided (job 2, Part A): trim both ends, collapse whitespace runs to one space, no case folding (4.2).
