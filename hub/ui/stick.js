// Stick part of the UI: the status chip text and the stick sheet (sync progress, Sync now, Cancel, conflicts).

/** Escape text for HTML. */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const RESULT = {
  ok: 'done', cancelled: 'cancelled (sync again to finish)', interrupted: 'stopped: the stick was removed (sync again to finish)',
  locked: 'stick busy (another device is syncing)', failed: 'failed',
};

/**
 * Chip text and style for the top bar.
 * @param {object} st  stick status from the server
 * @param {number} running  running apps
 * @returns {{text: string, cls: string}} cls: '' | 'ok' | 'warn' | 'bad'
 */
export function chipFor(st, running) {
  const pre = running ? `${running} running · ` : '';
  if (!st || st.state === 'none') return { text: `${pre}No stick`, cls: '' };
  if (st.state === 'blank') return { text: `${pre}Stick has no HUB`, cls: 'warn' };
  if (st.state === 'bad') return { text: `${pre}Stick problem`, cls: 'bad' };
  if (st.sync?.running) return { text: `${pre}Syncing ${st.sync.done || 0}/${st.sync.total || '…'}`, cls: 'ok' };
  if (st.last && st.last.result !== 'ok') return { text: `${pre}Sync not finished`, cls: 'warn' };
  if (st.conflicts?.length) return { text: `${pre}${st.conflicts.length} conflict${st.conflicts.length > 1 ? 's' : ''}`, cls: 'warn' };
  if (st.code?.state === 'different') return { text: `${pre}Stick has other code`, cls: 'warn' };
  if (st.pending?.length) return { text: `${pre}Stick · data waits`, cls: 'ok' };
  return { text: `${pre}Stick connected`, cls: 'ok' };
}

/**
 * Fill the stick sheet.
 * @param {(sel: string) => HTMLElement} $
 * @param {object} st  stick status
 */
export function fillStickSheet($, st) {
  const lines = [];
  const add = (text, cls = '') => lines.push(`<li class="${cls}">${text}</li>`);
  if (!st || st.state === 'none') {
    $('#stick-name').textContent = 'No stick';
    add('Plug in the stick. The hub finds it by itself.');
  } else if (st.state === 'blank') {
    $('#stick-name').textContent = 'Stick without HUB';
    add('This stick has no HUB folder yet. In Termux run:<br><code>node hub/cli.mjs stick init --name "My stick"</code>');
  } else if (st.state === 'bad') {
    $('#stick-name').textContent = 'Stick problem';
    add(esc(st.error || 'HUB/stick.json cannot be read.'), 'bad');
  } else {
    $('#stick-name').textContent = st.name || 'Stick';
    if (st.portable) add('The hub runs from this stick. Nothing to sync.');
    add(esc(st.code?.message || (st.commit ? `Code on the stick: ${st.commit.slice(0, 7)} (${st.codeState})` : 'No code on the stick yet.')),
      st.code?.state === 'different' || st.code?.state === 'dirty' ? 'warn' : '');
    if (st.codeState === 'partial' && !st.sync?.running) add('The code copy on the stick is not finished. Sync to finish it.', 'warn');
    if (st.last) {
      const when = new Date(st.last.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      add(`Last sync ${esc(when)}: ${esc(RESULT[st.last.result] || st.last.result)}${st.last.resumed ? ' (finished an earlier one)' : ''}`
        + (st.last.result === 'ok' ? ` · ${st.last.copied} copied, ${st.last.trashed} to trash` : ''), st.last.result === 'ok' ? '' : 'warn');
      for (const e of st.last.errors || []) add(esc(e), 'bad');
      if (st.last.skipped) add(`${st.last.skipped} file(s) skipped (odd names, too big or changed during sync).`, 'warn');
    }
    if (st.pending?.length) add(`Waits until the app stops: ${esc(st.pending.join(', '))}`);
    if (st.conflicts?.length) {
      add(`Both sides changed these files. The phone's version kept the name; the stick's version is the copy below. Delete the one you do not need:<br>${st.conflicts.map((c) => `<code>data/${esc(c)}</code>`).join('<br>')}`, 'warn');
    }
  }
  if (st?.error && st.state !== 'bad') add(esc(st.error), 'bad');
  $('#stick-info').innerHTML = lines.join('');

  const sync = st?.sync || {};
  $('#stick-progress').hidden = !sync.running;
  if (sync.running) {
    const pct = sync.totalBytes ? Math.round((sync.bytes / sync.totalBytes) * 100) : sync.total ? Math.round((sync.done / sync.total) * 100) : 0;
    $('#stick-bar').style.width = `${Math.min(100, pct)}%`;
    const phase = { scan: 'Checking files…', code: 'Copying code', data: 'Copying data', finish: 'Finishing…', done: 'Finishing…' }[sync.phase] || sync.phase;
    $('#stick-progress-text').textContent = `${phase} ${sync.total ? `${sync.done}/${sync.total}` : ''} ${sync.current || ''}`.trim();
  }
  const connected = st?.state === 'connected' && !st.portable;
  $('#stick [data-act="sync"]').disabled = !connected || !!sync.running;
  $('#stick [data-act="cancel"]').disabled = !sync.running;
}
