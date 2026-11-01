// The month-by-month installments of an advance, as editable amounts (an equal split at first).
// Used by "Add advance" and "Edit advance" in Payroll. The amounts must add up to the advance.
import { L, esc, money, fmtMonth } from '../core/utils.js';
import { advanceSchedule } from '../services/requests.js';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const keyOf = (v) => `${r2(v.amount)}|${Math.max(1, Math.min(60, Math.round(Number(v.installments) || 1)))}|${v.startMonth || ''}`;

/**
 * scheduleEditor(host, initial?, initialVals?) → { sync(vals), get(), ok() }
 *  - sync({ amount, installments, startMonth }): call it whenever the form changes; the equal split is rebuilt only when
 *    one of those three changed, so the amounts the admin typed stay.
 *  - get(): [{ month, amount }]   ok(): the amounts add up to the advance
 */
export function scheduleEditor(host, initial = null, initialVals = null) {
  let rows = initial && initial.length ? initial.map(s => ({ month: s.month, amount: r2(s.amount) })) : [];
  let key = rows.length && initialVals ? keyOf(initialVals) : '';
  let vals = initialVals || { amount: 0, installments: 1, startMonth: '' };
  const sum = () => r2(rows.reduce((s, x) => s + x.amount, 0));

  function foot() {
    const el = host.querySelector('[data-foot]'); if (!el) return;
    const total = r2(vals.amount), diff = r2(total - sum());
    el.innerHTML = Math.abs(diff) <= 0.01
      ? `<span style="color:var(--ok)"><i class="fas fa-circle-check"></i> ${L('المجموع', 'Total')} <b class="num">${esc(money(sum(), false))}</b></span>`
      : `<span style="color:var(--bad)"><i class="fas fa-triangle-exclamation"></i> ${L('المجموع', 'Total')} <b class="num">${esc(money(sum(), false))}</b> ${L('من', 'of')} <b class="num">${esc(money(total, false))}</b> — ${diff > 0 ? L('ناقص', 'short by') : L('زيادة', 'over by')} <b class="num">${esc(money(Math.abs(diff), false))}</b></span>`;
  }
  function draw() {
    host.innerHTML = rows.length ? `<div class="label mb-8">${L('جدول الأقساط — عدّل المبلغ بتاع أي شهر', 'Installment schedule — change any month\'s amount')}</div>
      <div style="max-height:260px;overflow:auto;border:1px solid var(--border);border-radius:12px;padding:6px 12px">
        ${rows.map((r, i) => `<div class="row between" style="padding:6px 0;gap:12px;${i ? 'border-top:1px solid var(--border)' : ''}"><span>${esc(fmtMonth(r.month))}</span><input class="input num" type="number" min="0" step="0.01" data-i="${i}" value="${r.amount}" style="max-width:150px"></div>`).join('')}
      </div>
      <div class="row between mt-8" style="flex-wrap:wrap;gap:8px"><div data-foot></div><button type="button" class="btn btn-sm" data-eq><i class="fas fa-equals"></i> ${L('توزيع متساوي', 'Split equally')}</button></div>` : '';
    foot();
  }
  const rebuild = () => { rows = r2(vals.amount) > 0 && vals.startMonth ? advanceSchedule(vals.amount, Math.max(1, Math.min(60, Math.round(Number(vals.installments) || 1))), vals.startMonth) : []; draw(); };

  host.addEventListener('input', (e) => {
    const i = e.target && e.target.dataset ? e.target.dataset.i : undefined;
    if (i === undefined) return;
    rows[Number(i)].amount = r2(e.target.value);
    foot();
  });
  host.addEventListener('click', (e) => { if (e.target.closest('[data-eq]')) rebuild(); });
  draw();

  return {
    sync(v) {
      vals = v;
      const k = keyOf(v);
      if (k !== key) { key = k; rebuild(); } else foot();
    },
    get: () => rows.map(r => ({ month: r.month, amount: r2(r.amount) })),
    ok: () => rows.length > 0 && Math.abs(r2(vals.amount) - sum()) <= 0.01
  };
}
