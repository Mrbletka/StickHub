# Vault v1 fixture: TEST ONLY

Every key, passphrase and paper code in this folder is **public test data**, made from a fixed seed by
`test/vault-fixture.test.mjs`. It is not a secret and must never protect real data. The KDF settings here are tiny
(1 MiB) on purpose, so the test runs fast; real vaults use 256 MiB.

- `inputs.json`: the test data key, passphrase, paper code and what the files contain.
- `vault.json`: a header with a passphrase slot and a recovery slot.
- `<26 characters>.vx`: one index file and one pack file.

Do not edit or delete these files: later versions must keep reading them. A new format version gets a new fixture
folder.
