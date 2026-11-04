// Drag and drop for the Explorer: a ghost label follows the finger, folders light up as targets,
// the list scrolls near its edges, and a closed folder opens after hovering on it for a moment.

const EDGE = 56;
const HOVER_OPEN_MS = 700;

export class Dnd {
  /**
   * @param {HTMLElement} treeEl
   * @param {HTMLElement} ghost
   * @param {{canDrop: (paths: string[], dir: string) => boolean, drop: (paths: string[], dir: string) => void,
   *   expand: (dir: string) => void}} hooks
   */
  constructor(treeEl, ghost, hooks) {
    this.tree = treeEl;
    this.ghost = ghost;
    this.hooks = hooks;
    this.active = null;
  }

  /** Start dragging these paths. */
  start(paths, label, x, y) {
    this.active = { paths, x, y, target: null, hoverDir: null, hoverSince: 0 };
    this.ghost.textContent = label;
    this.ghost.hidden = false;
    this.move(x, y);
    this.#scrollLoop();
  }

  /** The finger moved. */
  move(x, y) {
    const a = this.active;
    if (!a) return;
    a.x = x;
    a.y = y;
    this.ghost.style.left = `${x}px`;
    this.ghost.style.top = `${y}px`;
    const target = this.#targetAt(x, y);
    this.#mark(target);
    a.target = target;
    // Hover on a closed folder: open it.
    if (target?.row?.classList.contains('dir') && !target.row.classList.contains('open')) {
      if (a.hoverDir !== target.dir) { a.hoverDir = target.dir; a.hoverSince = performance.now(); } else if (performance.now() - a.hoverSince > HOVER_OPEN_MS) {
        a.hoverDir = null;
        this.hooks.expand(target.dir);
      }
    } else a.hoverDir = null;
  }

  /** The finger was lifted: drop if over a valid folder. */
  end() {
    const a = this.active;
    this.cancel();
    if (a?.target && this.hooks.canDrop(a.paths, a.target.dir)) this.hooks.drop(a.paths, a.target.dir);
  }

  /** Stop without dropping. */
  cancel() {
    this.active = null;
    this.ghost.hidden = true;
    this.#mark(null);
  }

  // Which folder is under the point: a folder row, the folder of a file row, or the top level (empty area).
  #targetAt(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el || !this.tree.contains(el)) return null;
    const row = el.closest('.row');
    if (!row) return { dir: '', row: null };
    const path = row.dataset.path;
    if (row.dataset.type === 'dir') return this.hooks.canDrop(this.active.paths, path) ? { dir: path, row } : null;
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const parentRow = dir ? this.tree.querySelector(`.row[data-path="${CSS.escape(dir)}"]`) : null;
    return this.hooks.canDrop(this.active.paths, dir) ? { dir, row: parentRow } : null;
  }

  #mark(target) {
    this.tree.querySelector('.row.drop')?.classList.remove('drop');
    this.tree.classList.toggle('drop-root', !!target && target.dir === '' && !target.row);
    target?.row?.classList.add('drop');
  }

  // Scroll the list while the finger is near its top or bottom edge.
  #scrollLoop() {
    const a = this.active;
    if (!a) return;
    const r = this.tree.getBoundingClientRect();
    let dy = 0;
    if (a.y < r.top + EDGE) dy = -Math.ceil((r.top + EDGE - a.y) / 4);
    else if (a.y > r.bottom - EDGE) dy = Math.ceil((a.y - (r.bottom - EDGE)) / 4);
    if (dy) { this.tree.scrollTop += dy; this.move(a.x, a.y); }
    requestAnimationFrame(() => this.#scrollLoop());
  }
}
