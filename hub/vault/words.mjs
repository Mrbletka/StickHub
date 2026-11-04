// Generated passphrases (decision 5): 5 random words from the EFF large word list (7776 words, about 64.6 bits).
// Word list: wordlist-eff-large.txt, by the Electronic Frontier Foundation, https://www.eff.org/dice,
// CC BY 3.0 US (https://creativecommons.org/licenses/by/3.0/us/). Dice numbers removed; see the file's header.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fail } from './errors.mjs';

export const WORDLIST_FILE = join(import.meta.dirname, 'wordlist-eff-large.txt');
export const WORDLIST_SIZE = 7776;
export const PASSPHRASE_WORDS = 5;

let cache = null;

/**
 * The word list (7776 unique lower-case words, some with one hyphen), read once and checked.
 * @returns {readonly string[]}
 */
export function wordList() {
  if (cache) return cache;
  const words = readFileSync(WORDLIST_FILE, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (words.length !== WORDLIST_SIZE || new Set(words).size !== WORDLIST_SIZE || !words.every((w) => /^[a-z]+(-[a-z]+)?$/.test(w))) {
    fail('BAD_INPUT', `${WORDLIST_FILE}: not the expected list of ${WORDLIST_SIZE} unique words`);
  }
  cache = Object.freeze(words);
  return cache;
}

/**
 * A uniform random integer in [0, n) by rejection sampling on 16-bit values: values at or above the largest
 * multiple of n are thrown away, so there is no modulo bias.
 * @param {number} n  1 to 65536
 * @param {(n: number) => Buffer} [random]  for tests only
 */
export function uniformIndex(n, random = randomBytes) {
  if (!Number.isInteger(n) || n < 1 || n > 65536) fail('BAD_INPUT', 'uniformIndex: n must be 1 to 65536');
  const limit = 65536 - (65536 % n);
  for (;;) {
    const x = random(2).readUInt16BE(0);
    if (x < limit) return x % n;
  }
}

/**
 * A new passphrase: 5 words joined by single spaces (some words contain a hyphen, so the separator is a space).
 * @param {{words?: number, random?: (n: number) => Buffer}} [o]
 * @returns {string}
 */
export function generatePassphrase(o = {}) {
  const n = o.words ?? PASSPHRASE_WORDS;
  if (!Number.isInteger(n) || n < 1 || n > 20) fail('BAD_INPUT', 'generatePassphrase: words must be 1 to 20');
  const list = wordList();
  return Array.from({ length: n }, () => list[uniformIndex(list.length, o.random)]).join(' ');
}
