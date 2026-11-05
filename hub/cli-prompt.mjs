// Ask for a secret (passphrase, paper code) on the terminal with no echo. Raw mode: typing, paste (also bracketed
// paste), Backspace, Ctrl-U (clear) and Ctrl-C (cancel) work; arrow keys and other escape sequences are ignored.
// Never reads a secret from argv, the environment or a file: the caller refuses a stdin that is not a terminal.

import { StringDecoder } from 'node:string_decoder';

const MAX = 1024;

/** Error when the person pressed Ctrl-C (or Ctrl-D on an empty line). */
export class PromptCancelled extends Error {
  constructor() { super('Cancelled.'); this.code = 'CANCELLED'; }
}

/**
 * @param {string} question  e.g. "Passphrase: "
 * @param {{input?: NodeJS.ReadStream, output?: NodeJS.WritableStream}} [o]  output: where the question goes (stderr)
 * @returns {Promise<string>}
 */
export function readSecret(question, o = {}) {
  const input = o.input || process.stdin;
  const output = o.output || process.stderr;
  const raw = typeof input.setRawMode === 'function';
  if (raw) input.setRawMode(true); // before the question: what is typed after it is never echoed
  output.write(question);
  const decoder = new StringDecoder('utf8');
  let chars = [];
  let esc = ''; // inside an escape sequence
  return new Promise((resolve, reject) => {
    const finish = (err) => {
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      if (raw) input.setRawMode(false);
      input.pause();
      output.write('\n');
      if (err) reject(err); else resolve(chars.join(''));
      chars = [];
    };
    const onEnd = () => finish(new PromptCancelled());
    const onData = (buf) => {
      for (const ch of decoder.write(buf)) {
        if (esc) { // CSI: ESC [ params final(0x40-0x7e); SS3: ESC O x (arrows on some terminals); other: ESC x
          esc += ch;
          if (esc.length === 2 && ch !== '[' && ch !== 'O') esc = '';
          else if (esc.length === 3 && esc[1] === 'O') esc = '';
          else if (esc.length > 2 && esc[1] === '[' && ch >= '@' && ch <= '~') esc = '';
          continue;
        }
        if (ch === '\u001b') { esc = ch; continue; }
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003' || (ch === '\u0004' && !chars.length)) return finish(new PromptCancelled());
        if (ch === '\u007f' || ch === '\b') { chars.pop(); continue; }
        if (ch === '\u0015') { chars = []; continue; }
        if (ch < ' ') continue;
        if (chars.length < MAX) chars.push(ch);
      }
      return undefined;
    };
    input.on('data', onData);
    input.on('end', onEnd);
    input.resume();
  });
}
