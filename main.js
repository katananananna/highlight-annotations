'use strict';
/* Highlight Annotations V1 — clean, general-purpose annotations (no build step). */
const O = require('obsidian');
const { Plugin, PluginSettingTab, Setting, Modal, Notice, MarkdownView, ItemView, TFile, setIcon, editorInfoField } = O;
const { ViewPlugin, Decoration, WidgetType, hoverTooltip } = require('@codemirror/view');
const { StateEffect } = require('@codemirror/state');

const VERSION = '1.0.0';
const VIEW_TYPE = 'ha7-annotations';
const MAX_SELECTION = 4000;
const CONTEXT_CHARS = 48;
const OUTLINE_DEBOUNCE_MS = 300;
const SELECTION_DELAY_MS = 200;
const repaint = StateEffect.define();

const COLORS = [
  { id: 'yellow', label: 'Yellow' },
  { id: 'green', label: 'Green' },
  { id: 'blue', label: 'Blue' },
  { id: 'pink', label: 'Pink' },
  { id: 'purple', label: 'Purple' },
  { id: 'orange', label: 'Orange' },
];
const COLOR_IDS = new Set(COLORS.map(c => c.id));
// Earlier category names → colours, so older annotations keep a sensible tint.
const LEGACY_CATEGORY_COLOR = {
  note: 'yellow', technique: 'blue', theme: 'purple', imagery: 'green',
  structure: 'orange', context: 'orange', vocab: 'pink', question: 'pink',
};
const DEFAULTS = { autoOpen: true, defaultColor: 'yellow', style: 'fill', strength: 35, markers: true };

const clone = x => JSON.parse(JSON.stringify(x));
const uid = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
const clampNum = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) ? Number(v) : d));

/* ---------- Data ---------- */

function locate(src, a) {
  if (!a.text) return -1;
  const hits = [];
  let p = 0;
  while ((p = src.indexOf(a.text, p)) >= 0) { hits.push(p); p += a.text.length; }
  if (hits.length === 1) return hits[0];
  const before = a.before || '', after = a.after || '';
  if (!before && !after) return -1;
  const matches = hits.filter(h =>
    src.slice(Math.max(0, h - before.length), h) === before &&
    src.slice(h + a.text.length, h + a.text.length + after.length) === after);
  return matches.length === 1 ? matches[0] : -1;
}

function sanitizeNote(n) {
  if (!n || typeof n.text !== 'string' || !n.text.trim()) return null;
  return { id: typeof n.id === 'string' ? n.id : uid(), text: n.text, at: Number(n.at) || Date.now() };
}

function sanitizeItem(a) {
  if (!a || typeof a.id !== 'string' || typeof a.text !== 'string' || !a.text) return null;
  let notes;
  if (Array.isArray(a.notes)) {
    notes = a.notes.map(sanitizeNote).filter(Boolean);
  } else {
    // Migrate earlier data: single comment + device tags become separate notes.
    notes = [];
    const at = a.updated || a.created || Date.now();
    if (typeof a.comment === 'string' && a.comment.trim()) notes.push({ id: uid(), text: a.comment.trim(), at });
    if (Array.isArray(a.tags) && a.tags.length) notes.push({ id: uid(), text: a.tags.join(', '), at });
  }
  const color = COLOR_IDS.has(a.color) ? a.color : (LEGACY_CATEGORY_COLOR[a.category] || 'yellow');
  return {
    id: a.id, text: a.text, before: a.before || '', after: a.after || '',
    color, notes, created: a.created || Date.now(), updated: a.updated || Date.now(),
  };
}

function sanitizeSettings(raw) {
  const s = { ...DEFAULTS };
  if (typeof raw?.autoOpen === 'boolean') s.autoOpen = raw.autoOpen;
  if (COLOR_IDS.has(raw?.defaultColor)) s.defaultColor = raw.defaultColor;
  if (raw?.style === 'fill' || raw?.style === 'underline') s.style = raw.style;
  if (raw?.strength !== undefined) s.strength = clampNum(raw.strength, 10, 70, DEFAULTS.strength);
  if (typeof raw?.markers === 'boolean') s.markers = raw.markers;
  return s;
}

/* ---------- DOM helpers ---------- */

function el(parent, tag, cls, text) {
  const n = parent.ownerDocument.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  parent.appendChild(n);
  return n;
}
function btn(parent, label, fn, cls = '') {
  const b = el(parent, 'button', `ha7-b ${cls}`.trim(), label);
  b.type = 'button';
  b.addEventListener('click', fn);
  return b;
}
function iconBtn(parent, icon, label, fn, cls = '') {
  const b = btn(parent, '', fn, `ha7-icon ${cls}`);
  setIcon(b, icon);
  b.setAttribute('aria-label', label);
  return b;
}
function swatches(parent, active, onPick) {
  const row = el(parent, 'div', 'ha7-swatches');
  row.setAttribute('role', 'radiogroup');
  row.setAttribute('aria-label', 'Highlight colour');
  for (const c of COLORS) {
    const s = btn(row, '', () => onPick(c.id), `ha7-swatch ha7-c-${c.id}`);
    s.dataset.color = c.id;
    s.setAttribute('role', 'radio');
    s.setAttribute('aria-label', c.label);
    s.setAttribute('aria-checked', String(c.id === active));
  }
  return row;
}
function autoGrow(t) { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 220) + 'px'; }

/* ---------- Editor widgets ---------- */

class MarkerWidget extends WidgetType {
  constructor(id, count, color) { super(); this.id = id; this.count = count; this.color = color; }
  eq(o) { return o.id === this.id && o.count === this.count && o.color === this.color; }
  toDOM(view) {
    const s = view.dom.ownerDocument.createElement('span');
    s.className = `ha7-marker ha7-c-${this.color}`;
    s.dataset.ha7 = this.id;
    s.textContent = String(this.count);
    s.setAttribute('aria-label', this.count === 1 ? '1 note' : `${this.count} notes`);
    return s;
  }
  ignoreEvent() { return false; }
}

/* ---------- Modals ---------- */

class EditorModal extends Modal {
  constructor(p, path, id, done) { super(p.app); this.p = p; this.path = path; this.id = id; this.done = done; }
  onOpen() {
    this.modalEl.addClass('ha7-modal', 'ha7-ui');
    const a = (this.p.data.notes[this.path] || []).find(x => x.id === this.id);
    if (!a) { this.close(); new Notice('Annotation no longer exists.'); return; }
    this.p.editor(this.contentEl, { path: this.path, item: a, close: () => this.close() });
  }
  onClose() { this.contentEl.empty(); this.done?.(); }
}

class Manager extends Modal {
  constructor(p) { super(p.app); this.p = p; this.query = ''; this.color = 'all'; }
  onOpen() {
    this.modalEl.addClass('ha7-manager', 'ha7-ui');
    const c = this.contentEl;
    c.empty();
    el(c, 'div', 'ha7-title', 'Annotations');
    const search = el(c, 'input', 'ha7-search');
    search.type = 'search';
    search.placeholder = 'Search';
    search.setAttribute('aria-label', 'Search annotations');
    search.oninput = () => { this.query = search.value; this.render(); };
    this.filters = el(c, 'div', 'ha7-filters');
    this.list = el(c, 'div', 'ha7-list');
    this.render();
    setTimeout(() => search.focus(), 30);
  }
  render() {
    const all = Object.entries(this.p.data.notes).flatMap(([path, items]) => items.map(a => ({ path, a })));
    this.p.colorFilter(this.filters, all.map(x => x.a), this.color, id => { this.color = id; this.render(); });
    this.list.replaceChildren();
    const q = this.query.toLowerCase();
    let count = 0;
    for (const { path, a } of all) {
      if (this.color !== 'all' && a.color !== this.color) continue;
      if (![path, a.text, ...a.notes.map(n => n.text)].join(' ').toLowerCase().includes(q)) continue;
      count++;
      const row = this.p.itemCard(this.list, a, {
        meta: path.replace(/\.md$/, '').split('/').pop(),
        onOpen: async () => {
          const f = this.p.app.vault.getAbstractFileByPath(path);
          if (f instanceof TFile) { await this.p.app.workspace.getLeaf(false).openFile(f); this.close(); }
          else new Notice('Note not found. You can still edit or delete this annotation.');
        },
        onEdit: () => new EditorModal(this.p, path, a.id, () => this.render()).open(),
      });
      row.title = path;
    }
    if (!count) el(this.list, 'div', 'ha7-empty', q || this.color !== 'all' ? 'No results' : 'No annotations yet');
  }
  onClose() { this.contentEl.empty(); }
}

/* ---------- Sidebar ---------- */

class OutlineView extends ItemView {
  constructor(leaf, p) { super(leaf); this.p = p; this.color = 'all'; }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Annotations'; }
  getIcon() { return 'highlighter'; }
  async onOpen() { this.render(); }
  async onClose() { this.contentEl.empty(); }
  render() {
    const root = this.contentEl;
    root.empty();
    root.addClass('ha7-outline', 'ha7-ui');
    const md = this.p.currentMarkdown();
    if (!md?.file) { el(root, 'div', 'ha7-empty', 'Open a note to see its annotations'); return; }
    const path = md.file.path;
    const cm = md.editor?.cm;
    const placed = cm ? this.p.ranges(cm) : [];
    const placedIds = new Set(placed.map(a => a.id));
    const orphans = (this.p.data.notes[path] || []).filter(a => !placedIds.has(a.id));
    const all = [...placed, ...orphans];

    const head = el(root, 'div', 'ha7-outline-head');
    const titles = el(head, 'div', 'ha7-outline-titles');
    el(titles, 'div', 'ha7-title', md.file.basename);
    el(titles, 'div', 'ha7-sub', all.length === 1 ? '1 annotation' : `${all.length} annotations`);
    const tools = el(head, 'div', 'ha7-tools');
    iconBtn(tools, 'share', 'Export to note', () => this.p.exportNote(path));
    iconBtn(tools, 'search', 'All annotations', () => new Manager(this.p).open());

    if (!all.length) {
      el(root, 'div', 'ha7-empty', 'Select text in the note to highlight it or add a note.');
      return;
    }
    this.p.colorFilter(el(root, 'div', 'ha7-filters'), all, this.color, id => { this.color = id; this.render(); });
    const list = el(root, 'div', 'ha7-list');
    const show = a => this.color === 'all' || a.color === this.color;
    for (const a of placed.filter(show)) {
      this.p.itemCard(list, a, {
        onOpen: () => this.p.jumpTo(md, a),
        onEdit: () => new EditorModal(this.p, path, a.id).open(),
      });
    }
    const lost = orphans.filter(show);
    if (lost.length) {
      el(list, 'div', 'ha7-section', 'Text no longer found');
      for (const a of lost) this.p.itemCard(list, a, { orphan: true, onEdit: () => new EditorModal(this.p, path, a.id).open() });
    }
  }
}

/* ---------- Settings ---------- */

class Settings extends PluginSettingTab {
  constructor(p) { super(p.app, p); this.p = p; }
  display() {
    const c = this.containerEl, p = this.p, s = p.data.settings;
    c.empty();
    new Setting(c).setName('All annotations').setDesc('Search, edit or delete annotations across every note.')
      .addButton(b => b.setButtonText('Open').onClick(() => new Manager(p).open()));
    new Setting(c).setName('Show toolbar when selecting text')
      .setDesc('Off: use the command “Annotate selection” instead.')
      .addToggle(x => x.setValue(s.autoOpen).onChange(v => p.setting('autoOpen', v)));
    new Setting(c).setName('Default colour').addDropdown(x => x
      .addOptions(Object.fromEntries(COLORS.map(k => [k.id, k.label])))
      .setValue(s.defaultColor).onChange(v => p.setting('defaultColor', v)));
    new Setting(c).setName('Highlight style').addDropdown(x => x
      .addOptions({ fill: 'Fill', underline: 'Underline' })
      .setValue(s.style).onChange(v => p.setting('style', v)));
    new Setting(c).setName('Highlight strength').addSlider(x => x
      .setLimits(10, 70, 1).setValue(s.strength).setDynamicTooltip().onChange(v => p.setting('strength', v)));
    new Setting(c).setName('Note count after highlights')
      .addToggle(x => x.setValue(s.markers).onChange(v => p.setting('markers', v)));
    new Setting(c).setName('Old highlight cleanup')
      .setDesc('Preview first. Backs up the note before removing ALL == delimiters and old plugin markers.')
      .addButton(x => x.setButtonText('Review…').onClick(() => p.cleanup()));
    el(c, 'p', 'setting-item-description', `Version ${VERSION}. Annotations live in this plugin’s data.json — back it up with your notes.`);
  }
}

/* ---------- Plugin ---------- */

module.exports = class Annotations extends Plugin {
  async onload() {
    const raw = await this.loadData();
    this.data = { settings: sanitizeSettings(raw?.settings), notes: {}, backups: Array.isArray(raw?.backups) ? raw.backups : [] };
    if (raw?.notes && typeof raw.notes === 'object') {
      for (const [path, items] of Object.entries(raw.notes)) {
        if (Array.isArray(items) && items.length) this.data.notes[path] = items.map(sanitizeItem).filter(Boolean);
      }
    }
    this.queueWrite = Promise.resolve();
    this.views = new Set();
    this.cache = new WeakMap();
    this.rev = 0; this.box = null; this.timer = null; this.outlineTimer = null;
    this.down = false; this.suppressUntil = 0; this.lastMd = null;
    this.applyLook();

    this.addSettingTab(new Settings(this));
    this.registerView(VIEW_TYPE, leaf => new OutlineView(leaf, this));
    this.addRibbonIcon('highlighter', 'Annotations', () => this.showOutline());
    this.addCommand({ id: 'annotate', name: 'Annotate selection', editorCallback: (editor, view) => {
      const cm = view.editor?.cm;
      if (cm) this.openSelection(cm, true); else new Notice('This editor is not supported.');
    } });
    this.addCommand({ id: 'outline', name: 'Show annotations sidebar', callback: () => this.showOutline() });
    this.addCommand({ id: 'manage', name: 'Search all annotations', callback: () => new Manager(this).open() });
    this.addCommand({ id: 'export', name: 'Export annotations of current note', callback: () => {
      const md = this.currentMarkdown();
      if (md?.file) this.exportNote(md.file.path); else new Notice('Open a note first.');
    } });
    this.addCommand({ id: 'cleanup', name: 'Review old highlight cleanup', callback: () => this.cleanup() });

    this.registerEditorExtension(this.editorExtensions());

    this.registerDomEvent(document, 'mousedown', e => {
      if (this.box && !this.box.node.contains(e.target)) this.close('blur');
    }, true);
    this.registerDomEvent(document, 'mouseup', () => { this.down = false; });
    this.registerDomEvent(document, 'keydown', e => { if (e.key === 'Escape' && this.box) { e.preventDefault(); this.close('cancel'); } });
    this.registerDomEvent(window, 'resize', () => this.close('blur'));
    this.registerEvent(this.app.workspace.on('active-leaf-change', leaf => {
      this.close('blur');
      if (leaf?.view instanceof MarkdownView) { this.lastMd = leaf.view; this.renderOutline(); }
    }));
    this.registerEvent(this.app.workspace.on('editor-change', () => this.renderOutlineSoon()));
    this.registerEvent(this.app.vault.on('rename', (file, old) => {
      if (this.data.notes[old]) this.change(d => { d.notes[file.path] = d.notes[old]; delete d.notes[old]; }).catch(() => {});
    }));
    this.app.workspace.onLayoutReady(() => { this.lastMd = this.app.workspace.getActiveViewOfType(MarkdownView); this.renderOutline(); });
  }

  onunload() {
    this.close('cancel');
    clearTimeout(this.outlineTimer);
    document.body.classList.remove('ha7-underline');
    document.body.style.removeProperty('--ha7-strength');
  }

  applyLook() {
    const s = this.data.settings;
    document.body.classList.toggle('ha7-underline', s.style === 'underline');
    document.body.style.setProperty('--ha7-strength', String(clampNum(s.strength, 10, 70, DEFAULTS.strength) / 100));
  }

  /* ----- CodeMirror ----- */

  editorExtensions() {
    const p = this;
    const viewPlugin = ViewPlugin.fromClass(class {
      constructor(v) { this.v = v; p.views.add(v); this.decorations = p.build(v); }
      update(u) {
        if (u.docChanged || u.transactions.some(t => t.effects.some(e => e.is(repaint)))) this.decorations = p.build(u.view);
        if (u.docChanged && p.box?.view === u.view && p.box.isNew) p.close('blur');
        if (u.selectionSet) p.schedule(u.view);
      }
      destroy() { p.views.delete(this.v); if (p.box?.view === this.v) p.close('cancel'); }
    }, {
      decorations: x => x.decorations,
      eventHandlers: {
        mousedown(e, v) {
          if (e.button !== 0) return false;
          const target = e.target.closest?.('[data-ha7]');
          if (target) {
            const a = p.ranges(v).find(r => r.id === target.dataset.ha7);
            if (a) {
              e.preventDefault(); e.stopPropagation();
              p.down = false; clearTimeout(p.timer); p.suppressUntil = Date.now() + 400;
              setTimeout(() => p.openExisting(v, a), 0);
              return true;
            }
          }
          p.down = true;
          return false;
        },
        mouseup(e, v) { p.down = false; if (!e.target.closest?.('[data-ha7]')) p.schedule(v); return false; },
        keyup(e, v) { if (e.key === 'Shift' || e.key.startsWith('Arrow')) p.schedule(v); return false; },
      },
    });
    const hover = hoverTooltip((v, pos, side) => {
      if (p.box) return null;
      const a = p.ranges(v).find(r => pos >= r.from && pos <= r.to && !(pos === r.from && side < 0) && !(pos === r.to && side > 0));
      if (!a || !a.notes.length) return null;
      return { pos: a.from, end: a.to, above: true, create: view => ({ dom: p.hoverCard(view, a) }) };
    }, { hoverTime: 300 });
    return [viewPlugin, hover];
  }

  hoverCard(view, a) {
    const dom = view.dom.ownerDocument.createElement('div');
    dom.className = `ha7-tip ha7-c-${a.color}`;
    for (const n of a.notes) el(dom, 'div', 'ha7-tip-note', n.text);
    el(dom, 'div', 'ha7-tip-hint', 'Click highlight to edit');
    return dom;
  }

  path(v) {
    try {
      const info = editorInfoField ? v.state.field(editorInfoField, false) : null;
      if (info?.file) return info.file.path;
    } catch (_) { /* fall through to leaf scan */ }
    for (const l of this.app.workspace.getLeavesOfType('markdown')) if (l.view.editor?.cm === v) return l.view.file?.path;
    return null;
  }

  ranges(v) {
    const path = this.path(v);
    if (!path) return [];
    const cached = this.cache.get(v);
    if (cached && cached.doc === v.state.doc && cached.rev === this.rev && cached.path === path) return cached.items;
    const source = v.state.doc.toString();
    const items = (this.data.notes[path] || [])
      .map(a => { const from = locate(source, a); return { ...a, from, to: from + a.text.length }; })
      .filter(a => a.from >= 0)
      .sort((x, y) => x.from - y.from);
    this.cache.set(v, { doc: v.state.doc, rev: this.rev, path, items });
    return items;
  }

  build(v) {
    const markers = this.data.settings.markers;
    const decos = [];
    for (const a of this.ranges(v)) {
      decos.push(Decoration.mark({ class: `ha7-mark ha7-c-${a.color}`, attributes: { 'data-ha7': a.id } }).range(a.from, a.to));
      if (markers && a.notes.length) decos.push(Decoration.widget({ widget: new MarkerWidget(a.id, a.notes.length, a.color), side: 1 }).range(a.to));
    }
    return Decoration.set(decos, true);
  }

  refresh() {
    this.rev++;
    for (const v of this.views) {
      try { v.dispatch({ effects: repaint.of(null) }); } catch (e) { console.warn('Annotation redraw:', e); }
    }
    this.renderOutline();
  }

  change(fn) {
    const task = this.queueWrite.catch(() => {}).then(async () => {
      const next = clone(this.data);
      fn(next);
      await this.saveData(next);
      this.data = next;
      this.applyLook();
      this.refresh();
    });
    this.queueWrite = task;
    return task.catch(e => { console.error(e); new Notice('Could not save annotations. Your previous saved data was kept.'); throw e; });
  }

  setting(k, v) { this.change(d => { d.settings[k] = v; }).catch(() => {}); }

  /* ----- Popovers ----- */

  schedule(v) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.data.settings.autoOpen || this.down || this.box || Date.now() < this.suppressUntil || !v.hasFocus) return;
      this.openSelection(v, false);
    }, SELECTION_DELAY_MS);
  }

  selectionInfo(v, manual) {
    const s = v.state.selection;
    const fail = msg => { if (manual) new Notice(msg); return null; };
    if (s.ranges.length !== 1 || s.main.empty) return fail('Select some text first.');
    const { from, to } = s.main;
    const text = v.state.doc.sliceString(from, to);
    if (!text.trim()) return null;
    if (text.length > MAX_SELECTION) return fail(`Selection is too long (max ${MAX_SELECTION} characters).`);
    const path = this.path(v);
    if (!path) return null;
    return { from, to, text, path };
  }

  openSelection(v, manual) {
    const sel = this.selectionInfo(v, manual);
    if (!sel) return;
    const existing = this.ranges(v).find(a => sel.from < a.to && sel.to > a.from);
    if (existing) { if (manual) this.openExisting(v, existing); return; }
    const ctx = { ...sel, snapshot: v.state.doc, view: v };
    const node = this.popover(v, sel.from, sel.to, true);
    if (!node) return;
    if (manual) this.mountEditor(node, ctx);
    else this.mountToolbar(node, ctx);
  }

  openExisting(v, a) {
    this.close('blur');
    const path = this.path(v);
    if (!path) return;
    const item = (this.data.notes[path] || []).find(x => x.id === a.id);
    if (!item) return;
    const node = this.popover(v, a.from, a.to, false);
    if (node) this.mountEditor(node, { path, item, view: v });
  }

  popover(v, from, to, isNew) {
    const start = v.coordsAtPos(from), end = v.coordsAtPos(to) || start;
    if (!start) return null;
    this.close('blur');
    const doc = v.dom.ownerDocument;
    const node = doc.createElement('div');
    node.className = 'ha7-pop ha7-ui';
    node.setAttribute('role', 'dialog');
    doc.body.appendChild(node);
    this.box = { node, view: v, isNew, anchor: { start, end }, onBlur: null };
    return node;
  }

  place() {
    if (!this.box) return;
    const { node, anchor } = this.box;
    const win = node.ownerDocument.defaultView;
    const rect = node.getBoundingClientRect();
    const gap = 10;
    const below = anchor.end.bottom + gap;
    const top = below + rect.height > win.innerHeight - 12 ? anchor.start.top - rect.height - gap : below;
    node.style.left = Math.max(12, Math.min(anchor.start.left, win.innerWidth - rect.width - 12)) + 'px';
    node.style.top = Math.max(12, top) + 'px';
  }

  close(reason) {
    clearTimeout(this.timer);
    const box = this.box;
    if (box) {
      this.box = null;
      if (reason === 'blur') box.onBlur?.();
      box.node.remove();
    }
    this.down = false;
    this.suppressUntil = Date.now() + 250;
  }

  mountToolbar(node, ctx) {
    node.classList.add('ha7-toolbar');
    node.setAttribute('aria-label', 'Highlight');
    node.addEventListener('mousedown', e => { if (e.target === node) e.preventDefault(); });
    swatches(node, null, async color => {
      this.close('cancel');
      await this.saveAnnotation(ctx, { color, notes: [] }).catch(() => {});
    });
    el(node, 'span', 'ha7-divider');
    const add = btn(node, '', () => { node.replaceChildren(); node.classList.remove('ha7-toolbar'); this.mountEditor(node, ctx); }, 'ha7-pill-btn');
    setIcon(el(add, 'span', 'ha7-pill-icon'), 'message-square-plus');
    el(add, 'span', '', 'Note');
    this.place();
  }

  mountEditor(node, ctx) {
    node.setAttribute('aria-label', ctx.item ? 'Edit annotation' : 'New annotation');
    const handle = this.editor(node, { ...ctx, close: () => this.close('cancel') });
    if (this.box?.node === node) this.box.onBlur = () => handle.commit(true);
    this.place();
    setTimeout(() => this.place(), 0);
  }

  /* ----- Shared editor (popover + modal) ----- */

  editor(root, ctx) {
    const { item } = ctx;
    let color = item?.color ?? this.data.settings.defaultColor;
    let notes = (item?.notes ?? []).map(n => ({ ...n }));
    let busy = false, armed = false, done = false;

    root.classList.add('ha7-editor');
    const setColor = id => {
      color = id;
      COLORS.forEach(c => root.classList.toggle(`ha7-c-${c.id}`, c.id === id));
      root.querySelectorAll('.ha7-swatch').forEach(s => s.setAttribute('aria-checked', String(s.dataset.color === id)));
    };

    const head = el(root, 'div', 'ha7-head');
    swatches(head, color, setColor);
    if (item) {
      const del = btn(head, '', () => {
        if (!armed) { armed = true; del.classList.add('is-armed'); del.textContent = 'Remove?'; return; }
        commit(false, true);
      }, 'ha7-icon ha7-remove');
      setIcon(del, 'trash-2');
      del.setAttribute('aria-label', 'Remove highlight');
    }

    el(root, 'div', 'ha7-quote', item?.text ?? ctx.text);
    const list = el(root, 'div', 'ha7-notes');

    const renderNotes = () => {
      list.replaceChildren();
      notes.forEach((n, i) => {
        const row = el(list, 'div', 'ha7-note');
        const body = el(row, 'div', 'ha7-note-text', n.text);
        body.tabIndex = 0;
        body.setAttribute('role', 'button');
        body.setAttribute('aria-label', 'Edit note');
        const startEdit = () => {
          const t = el(row, 'textarea', 'ha7-input');
          t.value = n.text;
          row.replaceChild(t, body);
          autoGrow(t);
          t.focus();
          const finish = keep => {
            if (!t.isConnected) return;
            const v = t.value.trim();
            if (keep) notes = v ? notes.map((x, j) => (j === i ? { ...x, text: v, at: Date.now() } : x)) : notes.filter((_, j) => j !== i);
            renderNotes();
          };
          t.oninput = () => autoGrow(t);
          t.onblur = () => finish(true);
          t.onkeydown = e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); finish(true); compose.focus(); }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
          };
        };
        body.addEventListener('click', startEdit);
        body.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); startEdit(); } });
        iconBtn(row, 'x', 'Delete note', () => { notes = notes.filter((_, j) => j !== i); renderNotes(); }, 'ha7-note-del');
      });
    };

    const compose = el(root, 'textarea', 'ha7-input ha7-compose');
    compose.rows = 1;
    compose.placeholder = notes.length ? 'Add another note' : 'Add a note';
    compose.setAttribute('aria-label', 'Add a note');
    compose.oninput = () => autoGrow(compose);
    const pushCompose = () => {
      const v = compose.value.trim();
      if (!v) return false;
      notes = [...notes, { id: uid(), text: v, at: Date.now() }];
      compose.value = '';
      compose.placeholder = 'Add another note';
      autoGrow(compose);
      renderNotes();
      return true;
    };
    compose.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); commit(false); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); pushCompose(); }
    });

    const foot = el(root, 'div', 'ha7-foot');
    const status = el(foot, 'span', 'ha7-hint', '↵ add · ⌘↵ save');
    status.setAttribute('aria-live', 'polite');
    const actions = el(foot, 'div', 'ha7-actions');
    btn(actions, 'Cancel', () => { done = true; ctx.close(); }, 'ha7-text-btn');
    btn(actions, 'Done', () => commit(false), 'ha7-text-btn ha7-strong');

    async function commit(fromBlur, remove = false) {
      if (busy || done) return;
      pushCompose();
      const changed = !item || remove || color !== item.color || JSON.stringify(notes) !== JSON.stringify(item.notes);
      // A brand-new annotation dismissed by clicking away with nothing written is not saved.
      if (fromBlur && (!changed || (!item && !notes.length))) return;
      if (!changed) { done = true; ctx.close(); return; }
      busy = true;
      if (!fromBlur) status.textContent = remove ? 'Removing…' : 'Saving…';
      try {
        if (remove) await self.removeAnnotation(ctx.path, item.id);
        else if (item) await self.updateAnnotation(ctx.path, item.id, { color, notes });
        else await self.saveAnnotation(ctx, { color, notes });
        done = true;
        if (!fromBlur) ctx.close();
      } catch (e) {
        busy = false;
        if (fromBlur) new Notice('Annotation not saved: ' + e.message);
        else status.textContent = 'Not saved — ' + e.message;
      }
    }
    const self = this;

    setColor(color);
    renderNotes();
    setTimeout(() => { compose.focus(); }, 40);
    return { commit: fromBlur => commit(fromBlur) };
  }

  /* ----- Persistence ----- */

  saveAnnotation(ctx, { color, notes }) {
    const { view, snapshot, path, text, from, to } = ctx;
    if (view.state.doc !== snapshot || this.path(view) !== path) {
      new Notice('The note changed — reselect the text and try again.');
      return Promise.reject(Error('note changed'));
    }
    return this.change(d => {
      const list = d.notes[path] || [];
      const src = snapshot.toString();
      const overlaps = list.some(a => { const at = locate(src, a); return at >= 0 && from < at + a.text.length && to > at; });
      if (overlaps) throw Error('This text overlaps an existing highlight.');
      const now = Date.now();
      d.notes[path] = [...list, {
        id: uid(), text, color, notes,
        before: snapshot.sliceString(Math.max(0, from - CONTEXT_CHARS), from),
        after: snapshot.sliceString(to, Math.min(snapshot.length, to + CONTEXT_CHARS)),
        created: now, updated: now,
      }];
    });
  }

  updateAnnotation(path, id, patch) {
    return this.change(d => {
      const list = d.notes[path] || [];
      if (!list.some(a => a.id === id)) throw Error('Annotation was removed.');
      d.notes[path] = list.map(a => (a.id === id ? { ...a, ...patch, updated: Date.now() } : a));
    });
  }

  removeAnnotation(path, id) {
    return this.change(d => {
      const list = (d.notes[path] || []).filter(a => a.id !== id);
      if (list.length) d.notes[path] = list; else delete d.notes[path];
    }).then(() => new Notice('Highlight removed.'));
  }

  /* ----- Lists (sidebar + manager) ----- */

  colorFilter(container, items, active, onPick) {
    container.replaceChildren();
    const used = COLORS.filter(c => items.some(a => a.color === c.id));
    if (used.length < 2) return;
    const all = btn(container, 'All', () => onPick('all'), 'ha7-filter');
    all.setAttribute('aria-pressed', String(active === 'all'));
    for (const c of used) {
      const b = btn(container, '', () => onPick(c.id), `ha7-filter ha7-filter-dot ha7-c-${c.id}`);
      b.setAttribute('aria-label', c.label);
      b.setAttribute('aria-pressed', String(active === c.id));
    }
  }

  itemCard(list, a, { meta, onOpen, onEdit, orphan } = {}) {
    const card = el(list, 'div', `ha7-item ha7-c-${a.color}${orphan ? ' is-orphan' : ''}`);
    if (onOpen) {
      card.tabIndex = 0;
      card.addEventListener('click', onOpen);
      card.addEventListener('keydown', e => { if (e.key === 'Enter') onOpen(); });
    }
    if (meta) el(card, 'div', 'ha7-item-meta', meta);
    el(card, 'div', 'ha7-item-quote', a.text);
    for (const n of a.notes) el(card, 'div', 'ha7-item-note', n.text);
    if (onEdit) iconBtn(card, 'pencil', 'Edit', e => { e.stopPropagation(); onEdit(); }, 'ha7-item-edit');
    return card;
  }

  currentMarkdown() {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active) return active;
    if (this.lastMd?.file && this.app.workspace.getLeavesOfType('markdown').some(l => l.view === this.lastMd)) return this.lastMd;
    return this.app.workspace.getLeavesOfType('markdown')[0]?.view || null;
  }

  async showOutline() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
  }

  renderOutline() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      try { leaf.view.render?.(); } catch (e) { console.warn('Annotation sidebar:', e); }
    }
  }

  renderOutlineSoon() {
    clearTimeout(this.outlineTimer);
    this.outlineTimer = setTimeout(() => this.renderOutline(), OUTLINE_DEBOUNCE_MS);
  }

  jumpTo(md, a) {
    const ed = md.editor;
    if (!ed) return;
    const from = ed.offsetToPos(a.from), to = ed.offsetToPos(a.to);
    this.suppressUntil = Date.now() + 600;
    this.app.workspace.setActiveLeaf(md.leaf, { focus: true });
    ed.setSelection(from, to);
    ed.scrollIntoView({ from, to }, true);
  }

  async exportNote(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) { new Notice('Note not found.'); return; }
    const source = await this.app.vault.cachedRead(file);
    const items = (this.data.notes[path] || [])
      .map(a => ({ ...a, pos: locate(source, a) }))
      .sort((x, y) => (x.pos < 0) - (y.pos < 0) || x.pos - y.pos);
    if (!items.length) { new Notice('This note has no annotations.'); return; }
    const lines = [`Annotations from [[${file.path.replace(/\.md$/, '')}|${file.basename}]]`, ''];
    for (const a of items) {
      lines.push(...a.text.split('\n').map(l => `> ${l}`), '');
      for (const n of a.notes) lines.push(`- ${n.text.replace(/\n/g, '\n  ')}`);
      if (a.pos < 0) lines.push('- _(text no longer found in the note)_');
      lines.push('', '---', '');
    }
    const folder = file.parent && file.parent.path !== '/' ? file.parent.path + '/' : '';
    let target = `${folder}${file.basename} (annotations).md`;
    for (let i = 2; this.app.vault.getAbstractFileByPath(target); i++) target = `${folder}${file.basename} (annotations ${i}).md`;
    try {
      const created = await this.app.vault.create(target, lines.join('\n'));
      await this.app.workspace.getLeaf('tab').openFile(created);
      new Notice(`Exported to ${target}`);
    } catch (e) {
      console.error(e);
      new Notice('Export failed: ' + e.message);
    }
  }

  /* ----- Legacy cleanup (unchanged behaviour) ----- */

  cleanup() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file) { new Notice('Open the affected note first.'); return; }
    const path = view.file.path, original = view.editor.getValue();
    const clean = original.replace(/%%ha2?:[A-Za-z0-9+/=]+%%/g, '').replace(/==/g, '');
    const modal = new Modal(this.app);
    modal.onOpen = () => {
      el(modal.contentEl, 'h2', '', 'Review old highlight cleanup');
      el(modal.contentEl, 'p', '', `Note: ${path}. This removes ALL native == delimiters and old plugin markers. Current annotations are kept. A full note-text backup is stored in plugin data before the edit.`);
      el(modal.contentEl, 'p', '', `Characters removed: ${original.length - clean.length}. Nothing is changed until you confirm.`);
      const row = el(modal.contentEl, 'div', 'modal-button-container');
      const ok = el(row, 'button', 'mod-warning', 'Back up and clean this note');
      ok.addEventListener('click', async () => {
        if (view.file?.path !== path || view.editor.getValue() !== original) { new Notice('The note changed. Review again.'); return; }
        try {
          await this.change(d => { d.backups.push({ path, text: original, created: Date.now() }); });
          if (view.editor.getValue() !== original) { new Notice('Note changed during backup; no cleanup applied.'); return; }
          const last = view.editor.lastLine();
          view.editor.replaceRange(clean, { line: 0, ch: 0 }, { line: last, ch: view.editor.getLine(last).length });
          modal.close();
          new Notice('Old markup removed. Backup is in plugin data.');
        } catch (_) { /* change() already showed a notice */ }
      });
      el(row, 'button', '', 'Cancel').addEventListener('click', () => modal.close());
    };
    modal.open();
  }
};
