// A small Markdown renderer for note previews. No DOM, so it runs in Node tests too.
// Safety: every piece of text is HTML-escaped; links only for http(s), mailto and plain relative paths
// (javascript:, data:, vbscript: ... are shown as text); images never load from the web (only data:image/...).
// Supports: headings, paragraphs (line breaks kept), bold, italic, ~~strike~~, `code`, ``` fenced code,
// lists (nested by indent), [ ] / [x] checkboxes, > quotes, --- rules, [links](url).

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escape text for HTML (text and attribute values). */
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

/**
 * What kind of link target this is: 'web' (http/https/mailto), 'anchor' (#x), 'note' (relative path) or null (blocked).
 * Control characters and spaces are removed before looking for a scheme, so "java\tscript:" is caught too.
 */
export function linkKind(url) {
  const u = String(url).replace(/[\u0000- \u007f]/g, '');
  if (!u) return null;
  if (/^(https?:\/\/|mailto:)/i.test(u)) return 'web';
  if (/^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith('//')) return null; // any other scheme, or protocol-relative
  if (u.startsWith('#')) return 'anchor';
  return 'note';
}

const SAFE_IMAGE = /^data:image\/(png|gif|jpeg|webp);base64,[a-z0-9+/=]+$/i;

/** Inline Markdown -> HTML. depth stops runaway nesting. */
export function inline(text, depth = 0) {
  if (depth > 6) return esc(text);
  let out = '';
  let i = 0;
  const n = text.length;
  const until = (close, from) => text.indexOf(close, from);
  while (i < n) {
    const c = text[i];
    if (c === '\\' && i + 1 < n && /[\\`*_[\]()#+\-.!~>]/.test(text[i + 1])) { out += esc(text[i + 1]); i += 2; continue; }
    if (c === '`') {
      const end = until('`', i + 1);
      if (end > i) { out += `<code>${esc(text.slice(i + 1, end))}</code>`; i = end + 1; continue; }
    }
    if (c === '!' && text[i + 1] === '[') {
      const m = /^!\[([^\]]*)\]\(([^)\s]*)\)/.exec(text.slice(i));
      if (m) {
        out += SAFE_IMAGE.test(m[2]) ? `<img src="${esc(m[2])}" alt="${esc(m[1])}">`
          : `<span class="img-off" title="Images from the web are not loaded">[image: ${esc(m[1] || 'no name')}]</span>`;
        i += m[0].length;
        continue;
      }
    }
    if (c === '[') {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(text.slice(i));
      if (m) {
        const kind = linkKind(m[2]);
        const label = inline(m[1], depth + 1);
        if (kind === 'web') out += `<a href="${esc(m[2])}" target="_blank" rel="noopener noreferrer">${label}</a>`;
        else if (kind === 'anchor') out += `<a href="${esc(m[2])}">${label}</a>`;
        else if (kind === 'note') out += `<a href="#" data-note="${esc(m[2])}">${label}</a>`;
        else out += `${label} <span class="link-off">(${esc(m[2])})</span>`;
        i += m[0].length;
        continue;
      }
    }
    const pair = text.startsWith('**', i) ? '**' : text.startsWith('__', i) ? '__' : text.startsWith('~~', i) ? '~~' : null;
    if (pair) {
      const end = until(pair, i + 2);
      if (end > i + 2) {
        const tag = pair === '~~' ? 'del' : 'strong';
        out += `<${tag}>${inline(text.slice(i + 2, end), depth + 1)}</${tag}>`;
        i = end + 2;
        continue;
      }
    }
    // _italic_ only at a word start, so snake_case_names stay as they are.
    if ((c === '*' || (c === '_' && !/[A-Za-z0-9]/.test(text[i - 1] || ''))) && text[i + 1] && text[i + 1] !== ' ') {
      const end = until(c, i + 1);
      if (end > i + 1 && text[end - 1] !== ' ') {
        out += `<em>${inline(text.slice(i + 1, end), depth + 1)}</em>`;
        i = end + 1;
        continue;
      }
    }
    out += ESC[c] || c;
    i++;
  }
  return out;
}

const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;

/**
 * Markdown -> HTML.
 * @param {string} src
 * @param {number} [depth]  for quotes inside quotes
 * @returns {string}
 */
export function render(src, depth = 0) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  const flush = () => { if (para.length) { out.push(`<p>${para.map((l) => inline(l)).join('<br>')}</p>`); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      flush();
      const body = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i]);
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) { flush(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); continue; }
    if (/^\s{0,3}>/.test(line)) {
      flush();
      const quote = [];
      for (; i < lines.length && /^\s{0,3}>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
      i--;
      out.push(`<blockquote>${depth < 5 ? render(quote.join('\n'), depth + 1) : esc(quote.join('\n'))}</blockquote>`);
      continue;
    }
    if (LIST.test(line)) {
      flush();
      const start = i;
      for (; i < lines.length && LIST.test(lines[i]); i++);
      out.push(renderList(lines.slice(start, i), start));
      i--;
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    para.push(line);
  }
  flush();
  return out.join('\n');
}

// Consecutive list lines -> nested <ul>/<ol>. Indent decides the level. Checkboxes carry their source line.
function renderList(items, firstLine) {
  let html = '';
  const stack = [];
  items.forEach((line, k) => {
    const [, ind, mark, rest] = LIST.exec(line);
    const indent = ind.replace(/\t/g, '  ').length;
    const tag = /\d/.test(mark) ? 'ol' : 'ul';
    while (stack.length && indent < stack.at(-1).indent) html += `</li></${stack.pop().tag}>`;
    if (!stack.length || indent > stack.at(-1).indent) { stack.push({ indent, tag }); html += `<${tag}>`; } else html += '</li>';
    const task = /^\[( |x|X)\]\s+(.*)$/.exec(rest);
    html += task
      ? `<li class="task"><input type="checkbox" data-line="${firstLine + k}"${task[1] === ' ' ? '' : ' checked'}> ${inline(task[2])}`
      : `<li>${inline(rest)}`;
  });
  while (stack.length) html += `</li></${stack.pop().tag}>`;
  return html;
}
