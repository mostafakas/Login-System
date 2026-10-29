// People dropdowns with photos. Any <select data-people> whose option values are emails is upgraded to a
// custom dropdown (avatar + name, with search). The native <select> stays in the DOM (hidden) and remains the
// source of truth, so existing code that reads .value or listens to "change" keeps working unchanged.
import { esc, L } from './utils.js';
import { avatar } from './ui.js';
import { person, onDirectory } from '../services/directory.js';

const instances = new Set();
let openInst = null;

function avatarFor(value, label) {
  const p = value && person(value);
  if (p) return avatar(p, 'sm');
  if (!value) return `<span class="avatar sm psel-ico" aria-hidden="true"><i class="fas fa-users"></i></span>`;
  return avatar({ name: label }, 'sm');
}

function enhance(sel) {
  if (sel._psel || sel.multiple) return;
  const wrap = document.createElement('div');
  wrap.className = 'psel' + (sel.classList.contains('select-sm') ? ' psel-sm' : '');
  if (sel.style.minWidth) wrap.style.minWidth = sel.style.minWidth;
  if (sel.style.width) wrap.style.width = sel.style.width;
  if (sel.style.maxWidth) wrap.style.maxWidth = sel.style.maxWidth;
  wrap.innerHTML = `<button type="button" class="select psel-btn" aria-haspopup="listbox" aria-expanded="false"></button>`;
  sel.parentNode.insertBefore(wrap, sel);
  sel.classList.add('psel-native'); sel.tabIndex = -1; sel.setAttribute('aria-hidden', 'true');
  const btn = wrap.firstChild;
  let pop = null;

  const current = () => { const o = sel.options[sel.selectedIndex]; return o ? { v: o.value, t: o.textContent.trim() } : { v: '', t: '' }; };
  const refresh = () => {
    const c = current();
    btn.disabled = sel.disabled;
    btn.innerHTML = `${avatarFor(c.v, c.t)}<span class="psel-txt">${esc(c.t || '—')}</span><i class="fas fa-chevron-down psel-caret"></i>`;
  };
  const close = () => {
    if (!pop) return;
    pop.remove(); pop = null; btn.setAttribute('aria-expanded', 'false');
    if (openInst === inst) openInst = null;
  };
  const pick = (v) => {
    close();
    if (sel.value !== v) { sel.value = v; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    refresh(); btn.focus();
  };
  const place = () => {
    const r = btn.getBoundingClientRect();
    const below = window.innerHeight - r.bottom, h = Math.min(pop.scrollHeight, 320);
    pop.style.minWidth = Math.max(r.width, 220) + 'px';
    pop.style.insetInlineStart = 'auto';
    const rtl = getComputedStyle(document.documentElement).direction === 'rtl';
    const w = pop.offsetWidth;
    let left = rtl ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    pop.style.left = left + 'px';
    pop.style.top = (below < h + 12 && r.top > below ? r.top - h - 6 : r.bottom + 6) + 'px';
  };
  const open = () => {
    if (sel.disabled) return;
    if (openInst) openInst.close();
    const opts = [...sel.options];
    pop = document.createElement('div');
    pop.className = 'psel-pop';
    const withSearch = opts.length > 7;
    pop.innerHTML = `${withSearch ? `<div class="psel-search"><i class="fas fa-magnifying-glass"></i><input type="text" placeholder="${esc(L('بحث بالاسم…', 'Search by name…'))}" autocomplete="off"></div>` : ''}
      <div class="psel-list" role="listbox">${opts.map(o => `<button type="button" class="psel-opt${o.value === sel.value ? ' on' : ''}" role="option" data-v="${esc(o.value)}" data-q="${esc(o.textContent.trim().toLowerCase())}">${avatarFor(o.value, o.textContent.trim())}<span class="psel-txt">${esc(o.textContent.trim())}</span>${o.value === sel.value ? '<i class="fas fa-check psel-tick"></i>' : ''}</button>`).join('')}
      <div class="psel-none" hidden>${esc(L('مفيش نتايج', 'No results'))}</div></div>`;
    document.body.appendChild(pop);
    btn.setAttribute('aria-expanded', 'true');
    place();
    const items = [...pop.querySelectorAll('.psel-opt')];
    const on = pop.querySelector('.psel-opt.on'); if (on) on.scrollIntoView({ block: 'nearest' });
    pop.addEventListener('click', (e) => { const b = e.target.closest('.psel-opt'); if (b) pick(b.dataset.v); });
    const input = pop.querySelector('input');
    if (input) {
      input.focus();
      input.addEventListener('input', () => {
        const q = input.value.trim().toLowerCase(); let n = 0;
        items.forEach(b => { const hit = !q || b.dataset.q.includes(q); b.hidden = !hit; if (hit) n++; });
        pop.querySelector('.psel-none').hidden = n > 0;
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); const f = items.find(b => !b.hidden); if (f) pick(f.dataset.v); }
      });
    }
    pop.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const vis = items.filter(b => !b.hidden), i = vis.indexOf(document.activeElement);
      const nx = vis[e.key === 'ArrowDown' ? Math.min(vis.length - 1, i + 1) : Math.max(0, i - 1)];
      if (nx) nx.focus();
    });
    openInst = inst;
  };
  btn.addEventListener('click', () => (pop ? close() : open()));
  btn.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  // keep the custom button in sync with the native select
  sel.addEventListener('change', refresh);
  new MutationObserver(refresh).observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'selected'] });
  const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  Object.defineProperty(sel, 'value', { configurable: true, get() { return d.get.call(this); }, set(v) { d.set.call(this, v); refresh(); } });

  const inst = { sel, wrap, refresh, close, get isOpen() { return !!pop; } };
  instances.add(inst);
  sel._psel = inst;
  refresh();
}

function scan(root) {
  if (!root || root.nodeType !== 1) return;
  if (root.matches && root.matches('select[data-people]')) enhance(root);
  root.querySelectorAll && root.querySelectorAll('select[data-people]').forEach(enhance);
}

export function initPeopleSelects() {
  if (initPeopleSelects.done) return; initPeopleSelects.done = true;
  scan(document.body);
  new MutationObserver((muts) => {
    muts.forEach(m => m.addedNodes.forEach(scan));
    instances.forEach(i => { if (!i.sel.isConnected) { i.close(); i.wrap.remove(); instances.delete(i); } });
  }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('mousedown', (e) => {
    if (openInst && !e.target.closest('.psel-pop') && !openInst.wrap.contains(e.target)) openInst.close();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openInst) openInst.close(); });
  window.addEventListener('resize', () => openInst && openInst.close());
  window.addEventListener('scroll', (e) => { if (openInst && !(e.target.closest && e.target.closest('.psel-pop'))) openInst.close(); }, true);
  onDirectory(() => instances.forEach(i => i.refresh()));
}
