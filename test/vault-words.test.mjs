// Generated passphrases: the EFF word list (complete, credited) and uniform word choice by rejection sampling.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { wordList, uniformIndex, generatePassphrase, WORDLIST_FILE } from '../hub/vault/words.mjs';

const ROOT = join(import.meta.dirname, '..');

test('the word list is the EFF large list: 7776 unique words in the original order', () => {
  const w = wordList();
  assert.equal(w.length, 7776);
  assert.equal(new Set(w).size, 7776);
  assert.equal(w[0], 'abacus');
  assert.equal(w[7775], 'zoom');
  // The original file is "<dice>\t<word>\n" for dice 11111..66666: rebuilding it must give its published sha256.
  const dice = [];
  for (let i = 0; i < 7776; i++) dice.push([4, 3, 2, 1, 0].reduce((s, p) => s + String(Math.floor(i / 6 ** p) % 6 + 1), ''));
  const original = w.map((x, i) => `${dice[i]}\t${x}\n`).join('');
  assert.equal(createHash('sha256').update(original).digest('hex'), 'addd35536511597a02fa0a9ff1e5284677b8883b83e986e43f15a3db996b903e');
});

test('the EFF is credited next to the word file and in the README, with source, license and the change', () => {
  for (const text of [readFileSync(WORDLIST_FILE, 'utf8'), readFileSync(join(ROOT, 'hub', 'vault', 'README.md'), 'utf8'),
    readFileSync(join(ROOT, 'README.md'), 'utf8')]) {
    assert.match(text, /Electronic Frontier Foundation/);
    assert.match(text, /https:\/\/www\.eff\.org\/dice/);
    assert.match(text, /CC BY 3\.0 US/);
    assert.match(text, /https:\/\/creativecommons\.org\/licenses\/by\/3\.0\/us\//);
    assert.match(text, /dice numbers (were )?removed/i);
  }
});

test('uniformIndex throws away values that would bias the result', () => {
  // 7776 * 8 = 62208 is the largest multiple below 65536: 62208..65535 must be rejected, not reduced modulo.
  const seq = [65535, 62208, 62207];
  const fake = () => { const b = Buffer.alloc(2); b.writeUInt16BE(seq.shift()); return b; };
  assert.equal(uniformIndex(7776, fake), 62207 % 7776);
  assert.equal(seq.length, 0, 'two values were rejected');
  assert.equal(uniformIndex(1, () => Buffer.from([0xff, 0xff])), 0);
  assert.throws(() => uniformIndex(0), { code: 'BAD_INPUT' });
  assert.throws(() => uniformIndex(65537), { code: 'BAD_INPUT' });
});

test('word counts over many draws look uniform', () => {
  const counts = new Array(7776).fill(0);
  for (let i = 0; i < 7776 * 20; i++) counts[uniformIndex(7776)]++;
  const max = Math.max(...counts);
  // Mean 20; a count above 60 has a chance far below 1e-9 under a uniform choice.
  assert.ok(max < 60, `max count ${max}`);
});

test('a generated passphrase is 5 words from the list, joined by single spaces', () => {
  const list = new Set(wordList());
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const p = generatePassphrase();
    const words = p.split(' ');
    assert.equal(words.length, 5);
    assert.ok(words.every((x) => list.has(x)));
    seen.add(p);
  }
  assert.equal(seen.size, 50);
  assert.equal(generatePassphrase({ words: 3 }).split(' ').length, 3);
});
