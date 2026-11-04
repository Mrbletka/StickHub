import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, inline, linkKind } from '../public/js/markdown.mjs';

test('all HTML is escaped', () => {
  const html = render('<script>alert(1)</script>\n# <img src=x onerror=alert(1)>\n**<b>"x"</b>**\n- <i>\n`<code>`\n```\n</pre><script>\n```');
  assert.doesNotMatch(html, /<script|<img|<b>|<i>|<\/pre><script/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /<strong>&lt;b&gt;&quot;x&quot;&lt;\/b&gt;<\/strong>/);
});

test('links: only web, anchors and notes; javascript: and friends are blocked', () => {
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:x', ' javascript:x', 'vbscript:x',
    'data:text/html,x', '//evil.example/x', 'file:///etc/passwd']) {
    assert.equal(linkKind(bad), null, bad);
  }
  assert.equal(linkKind('https://example.com'), 'web');
  assert.equal(linkKind('mailto:a@b.c'), 'web');
  assert.equal(linkKind('#top'), 'anchor');
  assert.equal(linkKind('other.md'), 'note');
  assert.doesNotMatch(inline('[x](javascript:alert(1))'), /href/);
  assert.match(inline('[x](https://a.b/?q="><script>)'), /href="https:\/\/a\.b\/\?q=&quot;&gt;&lt;script&gt;"/);
  assert.match(inline('[x](https://a.b)'), /target="_blank" rel="noopener noreferrer"/);
  assert.match(inline('[next](Ideas/next.md)'), /data-note="Ideas\/next\.md"/);
  assert.match(inline('[a "b"](x.md)'), />a &quot;b&quot;</);
});

test('remote images are never loaded', () => {
  assert.doesNotMatch(inline('![cat](https://evil.example/track.png)'), /<img/);
  assert.doesNotMatch(inline('![x](data:image/svg+xml;base64,PHN2Zz4=)'), /<img/, 'svg data is not allowed');
  assert.match(inline('![dot](data:image/png;base64,iVBORw0KGgo=)'), /<img src="data:image\/png;base64,iVBORw0KGgo=" alt="dot">/);
});

test('blocks: headings, lists, checkboxes, quotes, code, rules', () => {
  const html = render('# Title\n\nSome *it* and **bold** and ~~old~~ and snake_case_name.\nline two\n\n- a\n  - b\n- [ ] todo\n- [x] done\n\n1. one\n2. two\n\n> quote\n\n---\n```\ncode <x>\n```');
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<p>Some <em>it<\/em> and <strong>bold<\/strong> and <del>old<\/del> and snake_case_name\.<br>line two<\/p>/);
  assert.match(html, /<ul><li>a<ul><li>b<\/li><\/ul><\/li><li class="task"><input type="checkbox" data-line="7"> todo<\/li><li class="task"><input type="checkbox" data-line="8" checked> done<\/li><\/ul>/);
  assert.match(html, /<ol><li>one<\/li><li>two<\/li><\/ol>/);
  assert.match(html, /<blockquote><p>quote<\/p><\/blockquote>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<pre><code>code &lt;x&gt;<\/code><\/pre>/);
});
