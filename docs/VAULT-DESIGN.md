# Encrypted vault: design (draft for review)

Status: **design only, nothing is built.** Claude and Fabian review this first.
Keystore and Node crypto facts were measured on the phone by probe 9 (docs/PROBES.md, run 7) and are marked **(p9)**.
Numbers marked "measured" come from docs/PROBES.md; "estimate" means not measured yet. Not known yet: what is in front
after the touch in the fingerprint box (section 5); the hub brings its page back either way.

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
- Being forced to unlock (by a person or by law).
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
  cannot be reliably overwritten). See open question 8.
- Nothing is "unhackable". The goal is: a lost stick, or a lost locked phone, does not give away the data.

### What a stick finder can still see
That this is a StickHub stick with a vault; the code snapshot (including which apps exist); how many key slots of each
type there are and the passphrase's KDF settings; the total size of the vault (padded) and the number of encrypted
files; roughly when and how much was written (exFAT times, file sizes); the random install id (`dev-...`) in `HUB/.lock`.
Not visible: file names, folders, how many files each app has, single file sizes, file contents, device names.

## 3. Building blocks (node:crypto, zero dependencies)
| Job | Primitive (standard) | Node | Settings |
|---|---|---|---|
| Passphrase -> key | Argon2id (RFC 9106) | `crypto.argon2('argon2id', ...)`, Node 24 | m = 256 MiB, t = 3, p = 4: 0.9 s and 310 MB peak on the phone **(p9)**. RFC 9106's second option (64 MiB) takes only 0.2 s there, so we afford 4x the memory. Stored per slot |
| Passphrase -> key if Argon2id is missing | scrypt (RFC 7914) | `crypto.scrypt` | N = 2^17, r = 8, p = 1 (128 MiB): 0.54 s on the phone **(p9)**. Only for a device without Argon2id |
| High-entropy secret -> key, subkeys | HKDF-SHA256 (RFC 5869) | `crypto.hkdf` | 32-byte output, labels below |
| Encrypt and authenticate | AES-256-GCM, 96-bit nonce, 128-bit tag | `createCipheriv('aes-256-gcm')` | 206 MB/s on the phone **(p9)**, 10x the stick. ChaCha20-Poly1305 is a bit faster there (271 MB/s), but AES-GCM is also in WebCrypto and crypto is not the bottleneck |
| Long files | STREAM (Hoang et al. 2015), as in `age`: 64 KiB segments, nonce = 11-byte segment number + 1-byte "last" flag | AES-256-GCM per segment | per-file key, so nonces never repeat |
| Content ids, header MAC | HMAC-SHA256 | `createHmac` | keys derived from the data key |
| Hide sizes | Padmé padding (Nikitin et al., PETS 2019), at most 12% extra | - | minimum 64 KiB per file |
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
- Passphrase normalized with NFKC (Polish letters typed on another keyboard give the same bytes), then Argon2id with a
  16-byte random salt and `associatedData = vault id + slot id` (or scrypt with the salt). The slot records its KDF.
- The KDF settings are read from the stick before unlocking, so they are checked: Argon2id m <= 1 GiB, t <= 10,
  p <= 8; scrypt N <= 2^20. Anything else is refused (a tampered stick must not make the phone run out of memory).
- This slot is what a stick finder attacks offline. Argon2id makes each guess slow and memory-heavy (256 MiB per
  guess, on any hardware), but a short or common passphrase still falls. Rule proposal: at least 5 random words or 20 characters (open question 5).

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
- Started from the background while StickHub is in front, the box works (fingerprint accepted, sign ok, 4.3 s), but
  Android **switches to the Termux:API app** to show it (Fabian, after the run). Not known yet: what is in front
  after the touch, so the hub always brings its page back.

The build:
- Key: RSA-2048, `generate -u 30` (open question 1).
- Unlock: first try `sign` (1.2 s). If the phone was unlocked in the last 30 s (you usually unlock it, then plug in
  the stick or tap the widget), that is all: no extra touch. If `sign` gives nothing:
  `termux-fingerprint -t "Unlock StickHub"`, then `sign` again, then `termux-open-url` to bring StickHub back to the
  front (the box switched to the Termux:API app).
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
fallback, if the Keystore could not be trusted at all, stays: passphrase at every hub start, no device slot.

## 6. File format

### 6.1 Layout
~~~
<stick root>/START-HERE.txt   plain: what this is and how to add a new phone (no secrets)
HUB/
  stick.json                  plain, as now, plus "vault": 1 (format 2)
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
Folder names start with `_`, which no app id can, so today's sync skips them as "not an app folder" (but see open
question 7: an old hub could still write plain data next to them).

### 6.2 Header (`vault.json`)
~~~json
{ "stickhubVault": 1,
  "body": "{\"vault\":\"<16 B>\",\"epoch\":1,\"hseq\":4,\"slots\":[ ... ]}",
  "mac": "<HMAC-SHA256(K_header, body)>" }
~~~
Slots inside `body` (binary values in base64url):
~~~
{ "id": <16 B>, "type": "passphrase", "kdf": { "alg": "argon2id", "m": 65536, "t": 3, "p": 4, "salt": <16 B> }, "nonce": <12 B>, "wrapped": <48 B> }
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
file key = HKDF-SHA256(K_file, salt = file id (from the file name), info = kind + vault id + epoch)
plaintext of all segments = length (4 bytes) + payload + zero padding up to Padmé(size), at least 64 KiB
~~~
- The key comes from the name, so renaming or swapping files makes them fail to decrypt. A cut-short file fails
  (no segment marked "last"); extra bytes after the last segment are refused.
- Reading part of a big file decrypts only the 64 KiB segments it needs.
- **Pack** payload: a table of contents (deflated JSON: for each blob its content id, offset, length, and a hint of
  path and time, used only by a repair tool if every index is lost) followed by the blobs. A pack is at most 32 MiB;
  a bigger file spans several packs.
- **Index** payload: deflated JSON (section 6.4). Compressing the index before encryption is fine here: nobody can
  inject chosen text into it and watch sizes.
- A `.vx` file is written once and never changed. It is written directly under its final random name (no `.part`):
  until an index points to it, it does not exist for the vault. Unreferenced files are removed by the cleanup (8.6).

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
1. Update every device first (`git pull`), so no old hub writes plain data to the stick (open question 7).
2. In the hub: **Set up the vault** (or `node hub/cli.mjs vault setup`). Doctor checks: stick, Termux:API, screen lock.
3. Choose the passphrase (typed twice, strength hint). Argon2id runs (0.9 s on the phone, p9).
4. The paper code is shown once; you write it down and type two groups back.
5. This phone's device slot is enrolled: Keystore key made (`-u 30`), fingerprint asked, two signatures compared
   (section 4.3).
6. Migration: a normal plain sync first, so phone and stick agree. Then every file goes into the phone replica, the
   stick replica is written, and **every file is read back and compared** with the original. Only then the plain
   copies are removed: phone `data/`, `.trash/`, `sync-state.json`; stick `HUB/data/<app>/` and `HUB/.trash/*/data/`.
   Old hub logs with file names are cleared. Interrupted: the next start continues; plain files stay until the
   check passes.
7. `START-HERE.txt` is written to the stick.
Writes: header (2 copies) on both sides, packs and index on both sides, the device files in `~/.stickhub/vault/`.

### 7.2 Unlock (daily)
1. The hub starts locked (widget, or the watcher at plug-in). The page shows the lock screen; no app can start.
2. If this phone has a device slot, the hub starts the unlock at once, in parallel with opening the page:
   `termux-keystore sign` (no touch if the phone was unlocked in the last 30 s; else the fingerprint box, which
   switches to the Termux:API app, then sign again and bring the page back) -> HKDF -> unwrap DK -> check the header MAC ->
   read the newest index (phone replica; in data-on-stick mode the stick's) -> tiles.
3. Cancelled or failed: buttons **Fingerprint**, **Passphrase**, **Paper code**.
4. Phone copy mode needs no stick to unlock. After unlocking, a plugged-in stick syncs in the background.
The header copy on the phone lets the unlock start before the stick is even seen.

### 7.3 Auto-lock
- Lock when no hub page has been visible for **5 minutes** (the page sends a heartbeat every 30 s while visible; a
  hidden, closed or frozen page stops sending). The hub page cannot see touches inside an app's iframe (another
  origin), so visibility is the signal (open question 4).
- Also lock: **Lock** button, `node hub/cli.mjs vault lock`, hub stop, and in data-on-stick mode when the stick is pulled.
- Locking: finish the commit in progress, stop all apps (SIGTERM, 1.2 s grace, as for "Stick removed"), close data API
  sessions, zero key buffers, drop the index. The page shows the lock screen; the player iframes are removed.
- A crash or ColorOS killing Termux locks too: the keys only ever lived in that process.
- While locked, the hub API shows no data names (no conflict lists, no sync details with paths).

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
2. The code unwraps DK. You must then set a new passphrase, and a **new paper code** is shown (the old one was just
   typed on a device). This device is enrolled if it was not.
3. If the paper may have been seen by someone else: choose **Also replace the data key** (rekey, 7.7).

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

### 7.8 When the device key stops working
Screen lock removed, Termux:API data cleared, new phone, or a Termux:API update that changes `sign`: the device slot fails with a clear
message ("This phone's key is gone"). Unlock with the passphrase; the old slot is replaced by a new one.

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
- A small client module for apps wraps this with file-like functions. When an app runs alone
  (`PORT=4110 node server.mjs`), the same module uses plain files in `./data`, as today.
- `HUB_DATA_DIR` is not given to apps once the vault is on. An app that still wants it shows a clear error on its
  tile instead of starting (one broken app never breaks the hub). The `app-rules` test checks every app.
- Every write is atomic by construction, so every app behaves like `atomicData: true` and sync no longer waits for
  apps to stop ("pending" goes away).

### 8.2 The atomic write on encrypted files
An encrypted file is never changed in place. A change:
1. encrypts the new content into a new pack under a new random name, fsync;
2. writes a new index file (seq + 1) under a new random name, fsync;
3. later (idle), deletes the old index file and unreferenced packs.
The newest index that decrypts is the truth. Pulled out after step 1: the pack is garbage, the old index still rules.
During step 2: the torn index fails to decrypt, the previous one rules. Several writes that arrive together share one
pack and one index (group commit). The header is the only file changed in place: `.part`, fsync, rename, two copies.

### 8.3 Costs on the exFAT stick
| Action | Plain files today (measured) | Vault (estimate, to be measured by probe 10) |
|---|---|---|
| One Notebook save, data on the stick | 1 safe write, about 165 ms | new pack + new index: about 2 x 120-180 ms; a burst of saves = one commit |
| Sync 120 changed small files | 15.5 s (129 ms per file) | 1 pack + 1 index on the stick: well under 1 s plus the bytes at 19 MB/s |
| Delete 120 files | 14.1 s (moved to `.trash`) | index only: about 0.2 s |
| Rename a folder of 300 notes | 300 renames | index only |
| Find what changed on the stick | read and hash every file | read one index file |
| Open (read the index) | - | one ~200 KB file: about 0.1 s |
So the vault is slower than today only for a single save in data-on-stick mode (about 2x), and much faster for
everything that touches many files.

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
idempotent, as today). The trash keeps deleted files for 30 days, then compaction drops them (open question 10).
Code sync (`hub/`, `apps/`, git decides) is unchanged and stays plain. Triggers stay as now (plug-in, Sync now);
because a data sync now costs a few file writes, a later step can also sync a few seconds after each change while
the stick is plugged in.

### 8.5 Notebook
- Its `lib/vault.mjs` (all file operations) is ported to the data client: `list` and `index` become one `tree()`
  call, the write's `base` check becomes `ifMatch` with the content id (today it already compares a content hash),
  rename/move/duplicate become index operations (fast, even on the stick), `.deleted/` stays a folder in its namespace.
- Limits stay: a note up to 1 MB, 5,000 files.
- `*.conflict-*` files and "changed somewhere else" work as today (the `events` call replaces looking at the files).
- Its UI state in localStorage (open tabs, recent notes) contains note names, outside the vault (open question 11).
- The name "vault" inside the Notebook (`HUB_DATA_DIR/vault/`) is a different thing; it may be renamed to avoid
  confusion.

### 8.6 Compaction and cleanup
- Runs when unlocked and idle (and at lock, if quick), inside the hub's write queue, one pack at a time, cancellable.
- Merges small packs and packs with mostly dead data into packs of about 8 MiB; drops trash older than 30 days.
- Removes `.vx` files no index refers to (leftovers of a pull or crash) and old index files beyond the 2 newest.
- Pulled out mid-compaction: the new pack is garbage, the old packs are still referenced. Nothing is lost.

## 9. Speed: plug-in to open in 10 s or less
"Open" = the hub page shows the tiles, unlocked.
| Step | Measured today | With the vault |
|---|---|---|
| USB -> stick mounted | about 1 s (run 2) | same |
| Mounted -> watcher sees it | 0-2 s (poll every 2 s) | 0-1 s: poll every 1 s (one read costs 0.7 ms) |
| Stick found -> hub started (cold) | 1.0-1.1 s (runs 4, 6) | same |
| Stick found -> page open, logged in | about 2-3 s (runs 4, 6) | same, in parallel with the unlock |
| Keystore sign (phone unlocked in the last 30 s) | - | 1.1-1.3 s **(p9)** |
| Otherwise: failed sign, fingerprint box and touch, sign again, bring the page back | - | 1.2 + about 3 + 1.2 + 1.5-2 s (`termux-fingerprint` 3.2 s with the touch, **p9**; `termux-open-url` 1.5-2 s, run 1) |
| Unwrap DK, check header | - | under 10 ms (HKDF 32 us on the phone, **p9**) |
| Read + decrypt the index | - | about 0.1-0.2 s on the stick (estimate) |
| **Plug-in -> open** | **6.6 s** (phone copy), **9.1 s** (data on the stick, cold hub) | see the two cases below |

The unlock starts as soon as the hub runs, in parallel with the page opening (2-3 s after the stick is found), and
from the header copy on the phone, so it does not wait for the stick.
- **Fast path** (the phone was unlocked in the last 30 s, the usual case when you pick it up and plug in the stick):
  one sign, 1.2 s, hidden behind the page load. Plug-in -> open stays close to today: about 6.6-9.5 s (estimate).
- **Fingerprint-box path** (unlocked longer ago): about 7-7.5 s after the hub starts, because the box switches to
  the Termux:API app and the page must be brought back. Plug-in -> open about 12-15 s (estimate): **over the goal**,
  and the screen jumps StickHub -> Termux:API -> StickHub.
To avoid or shorten the fingerprint-box path:
1. Keep the hub running and unlocked: the widget tap starts it and unlocks it on the fast path (you just unlocked the
   phone to tap). Plug-in then needs no unlock at all, unless the hub auto-locked.
2. Poll mountinfo every 1 s instead of 2 s (0.7 ms per read): 0.5 s less on average.
3. Option: try the sign before opening the page. That costs about 1 s on the fast path, but on the box path the
   screen goes Termux:API -> StickHub only once (open question 1).
4. Probe 10 (after the build) measures both paths and what is in front after the touch.
The passphrase path is slower (typing + 0.9 s Argon2id) and is not the daily path.

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
- **Phone**: probe 10 after the build: plug-in to open with the fingerprint, one save on the stick, sync of 120
  changed notes, compaction, pull mid-save.

## 11. Build order (proposal, after the review)
1. `hub/vault/` crypto helpers: KDFs, slot wrap/unwrap, `.vx` files, paper code. Tests and fixtures.
2. Store: header, index, packs, commit, cleanup, compaction. Unplug tests.
3. Data API + client module; port the sample apps, then the Notebook.
4. Sync between replicas (reusing `planData`), migration, rollback check.
5. Keystore adapter (try sign, else `termux-fingerprint`, then sign), lock screen, setup, devices page, CLI (`vault setup|status|lock|devices|...`),
   doctor checks (Termux:API, screen lock, Argon2id).
6. START-HERE.txt and `cli.mjs setup` for new phones. Probe 10 on the phone.

## 12. Open questions
1. **Device slot** (p9: time window, opened by the fingerprint or the pattern). (a) Fast path with `-u 30` (no touch
   if the phone was unlocked in the last 30 s), or always show the fingerprint box (then `-u 10`; plug-in -> open about
   12-15 s)? (b) At plug-in: open the page and try the sign at the same time (fastest when no box is needed), or
   sign first and open the page after (about 1 s slower then, but on the box path the screen does not jump back
   and forth)?
2. **Phone copy encrypted too** (this design) so "locked" holds on the phone? The alternative keeps plain files on
   the phone and apps unchanged, but then only the stick is locked.
3. **Apps use the data API** instead of `HUB_DATA_DIR` (Notebook port, sample apps). Agreed?
4. **Auto-lock**: 5 min with no visible hub page? Lock when the stick is pulled in data-on-stick mode?
5. **Passphrase rule**: own passphrase of at least 5 words or 20 characters, or the hub generates words (needs a
   word list in the repo, about 2,000-8,000 words)?
6. **Argon2id settings**: 256 MiB, t = 3, p = 4 (0.9 s, 310 MB peak on the phone)? Or 512 MiB (about 2 s, more
   memory pressure, and ColorOS may close other apps)?
7. **Old hub versions**: "update every device before setup" enough, or rename the stick marker so an old hub ignores
   a vaulted stick entirely (it would otherwise still copy plain phone data into `HUB/data/<app>/`)?
8. **Flash remnants**: data stored plain on this stick before the vault may stay on its chips. Set up the vault on a
   fresh stick and retire the old one?
9. **Paper code**: 28 characters (130 bits + 2 check characters) OK? Always rekey when it is used, or only on request?
10. **Vault trash**: keep deleted files 30 days?
11. **Browser state with names** (Notebook's open tabs and recents in localStorage): move into the vault (then it
    syncs between phones), clear on lock, or accept?
12. **Later**: Windows / portable mode with passphrase only; a new phone without internet (code from the stick, with
    `portable-check.mjs`); a device slot through WebAuthn in Chrome (a prompt per use, but the passkey syncs to the
    Google account). None of these now.
