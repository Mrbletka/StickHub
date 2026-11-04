// The paper code (recovery slot, design 4.4): 26 random characters from the Crockford base32 alphabet (130 bits)
// plus 2 check characters, written as 7 groups of 4.
// The check characters are a typo check, not crypto: sum of (position x value) over the 26 characters, modulo the
// prime 1021, written as 2 base32 characters. Every single wrong character and every swap of two neighbours changes
// that sum by a non-zero amount smaller than 1021, so it is always caught before any key work.

import { randomBytes } from 'node:crypto';
import { fail } from './errors.mjs';

export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford: no I, L, O, U
export const SECRET_CHARS = 26;
export const CODE_CHARS = 28;
const MOD = 1021;

/** Sum of (position x value) mod 1021 over the 26 values (positions 1..26). */
function checkValue(vals) {
  let s = 0;
  for (let i = 0; i < SECRET_CHARS; i++) s += (i + 1) * vals[i];
  return s % MOD;
}

/**
 * A new paper code, canonical form: 28 characters, no dashes.
 * @param {(n: number) => Buffer} [random]  for tests only
 * @returns {string}
 */
export function generatePaperCode(random = randomBytes) {
  const r = random(SECRET_CHARS);
  if (!Buffer.isBuffer(r) || r.length !== SECRET_CHARS) fail('BAD_INPUT', 'random: wrong size');
  const vals = [...r].map((b) => b & 31); // 256 is a multiple of 32: no bias
  const c = checkValue(vals);
  return [...vals, Math.floor(c / 32), c % 32].map((v) => ALPHABET[v]).join('');
}

/**
 * The full 28-character canonical code for 26 secret characters (adds the check characters).
 * @param {string} secret  26 canonical characters (from parsePaperCode)
 */
export function paperCodeFromSecret(secret) {
  if (typeof secret !== 'string' || !new RegExp(`^[${ALPHABET}]{${SECRET_CHARS}}$`).test(secret)) fail('BAD_INPUT', 'paper code secret: 26 characters expected');
  const vals = [...secret].map((ch) => ALPHABET.indexOf(ch));
  const c = checkValue(vals);
  return secret + ALPHABET[Math.floor(c / 32)] + ALPHABET[c % 32];
}

/**
 * Show a canonical code as 7 groups of 4: "K7QX-2M9D-...".
 * @param {string} code  28 canonical characters
 */
export function formatPaperCode(code) {
  if (typeof code !== 'string' || code.length !== CODE_CHARS) fail('BAD_INPUT', 'paper code: 28 characters expected');
  return code.match(/.{4}/g).join('-');
}

/**
 * Read a typed paper code. Forgiving: lower case, I and L = 1, O = 0, spaces and dashes ignored.
 * Throws BAD_CODE (no key work happens) for a wrong length, a character that cannot be in a code, or a typo.
 * @param {unknown} text
 * @returns {string} the 26 secret characters in canonical form (the input of the recovery key derivation)
 */
export function parsePaperCode(text) {
  if (typeof text !== 'string' || text.length > 200) fail('BAD_CODE', 'The paper code must be 28 characters.');
  const s = text.replace(/[\s-]/g, '').toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0');
  if (s.length !== CODE_CHARS) fail('BAD_CODE', `The paper code must be 28 characters (this has ${s.length}).`);
  const vals = [...s].map((ch) => ALPHABET.indexOf(ch));
  if (vals.includes(-1)) fail('BAD_CODE', 'The paper code has a character that cannot be in it.');
  const given = vals[26] * 32 + vals[27];
  if (given >= MOD || given !== checkValue(vals)) fail('BAD_CODE', 'The paper code has a typo. Check it again.');
  return s.slice(0, SECRET_CHARS);
}
