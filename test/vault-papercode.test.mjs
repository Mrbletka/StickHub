// Paper code (design 4.4): format, forgiving input, and the check characters catching every single wrong character
// and every swap of two neighbours (tested exhaustively, on several codes).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePaperCode, formatPaperCode, parsePaperCode, paperCodeFromSecret, ALPHABET, CODE_CHARS } from '../hub/vault/papercode.mjs';
import { fixedRandom } from './vault-helpers.mjs';

const codes = (() => {
  const r = fixedRandom('papercode test');
  return [generatePaperCode(), generatePaperCode(), ...Array.from({ length: 6 }, () => generatePaperCode(r)),
    paperCodeFromSecret('0'.repeat(26)), paperCodeFromSecret('Z'.repeat(26))];
})();

test('a code is 28 Crockford characters, shown as 7 groups of 4', () => {
  for (const c of codes) {
    assert.match(c, /^[0-9A-HJKMNP-TV-Z]{28}$/);
    assert.match(formatPaperCode(c), /^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{4}$/);
    assert.equal(parsePaperCode(formatPaperCode(c)), c.slice(0, 26));
    assert.equal(paperCodeFromSecret(c.slice(0, 26)), c);
  }
  assert.equal(new Set(codes).size, codes.length);
  assert.ok(!/[ILOU]/.test(ALPHABET));
});

test('typing is forgiving: lower case, I and L = 1, O = 0, spaces and dashes', () => {
  const c = paperCodeFromSecret('1100110011001100110011001A');
  const typed = formatPaperCode(c).toLowerCase().replace(/1/g, (_, i) => (i % 2 ? 'l' : 'I')).replace(/0/g, 'o');
  assert.equal(parsePaperCode(typed), c.slice(0, 26));
  assert.equal(parsePaperCode(` ${c.slice(0, 7)} ${c.slice(7, 20)}\t-${c.slice(20)} `), c.slice(0, 26));
  assert.equal(parsePaperCode(c.replace(/(.{4})/g, '$1--')), c.slice(0, 26));
});

test('every single wrong character is caught', () => {
  for (const c of codes) {
    for (let i = 0; i < CODE_CHARS; i++) {
      for (const ch of ALPHABET) {
        if (ch === c[i]) continue;
        const bad = c.slice(0, i) + ch + c.slice(i + 1);
        assert.throws(() => parsePaperCode(bad), { code: 'BAD_CODE' }, `position ${i}`);
      }
    }
  }
});

test('every swap of two neighbours is caught', () => {
  for (const c of codes) {
    for (let i = 0; i < CODE_CHARS - 1; i++) {
      if (c[i] === c[i + 1]) continue; // swapping equal characters changes nothing
      const bad = c.slice(0, i) + c[i + 1] + c[i] + c.slice(i + 2);
      assert.throws(() => parsePaperCode(bad), { code: 'BAD_CODE' }, `swap at ${i}`);
    }
  }
});

test('wrong length and characters that cannot be in a code are refused', () => {
  const c = codes[0];
  assert.throws(() => parsePaperCode(c.slice(0, 27)), { code: 'BAD_CODE' });
  assert.throws(() => parsePaperCode(`${c}0`), { code: 'BAD_CODE' });
  assert.throws(() => parsePaperCode(`U${c.slice(1)}`), { code: 'BAD_CODE' });
  assert.throws(() => parsePaperCode(`*${c.slice(1)}`), { code: 'BAD_CODE' });
  assert.throws(() => parsePaperCode(''), { code: 'BAD_CODE' });
  assert.throws(() => parsePaperCode(null), { code: 'BAD_CODE' });
  assert.throws(() => parsePaperCode('x'.repeat(500)), { code: 'BAD_CODE' });
  // check characters worth 1021..1023 never come from a real code
  assert.throws(() => parsePaperCode(`${c.slice(0, 26)}ZZ`), { code: 'BAD_CODE' });
});

test('error messages never repeat the typed code', () => {
  const c = codes[2];
  const bad = c.slice(0, 5) + (c[5] === 'A' ? 'B' : 'A') + c.slice(6);
  try {
    parsePaperCode(bad);
    assert.fail('should throw');
  } catch (e) {
    assert.equal(e.code, 'BAD_CODE');
    for (let i = 0; i + 4 <= 28; i++) assert.ok(!e.message.includes(bad.slice(i, i + 4)), 'no part of the code in the message');
  }
});
