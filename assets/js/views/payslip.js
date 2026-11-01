// Branded, printable payslip: employee details, attendance summary, every earning and deduction explained,
// net pay in figures and words, and the transfer receipt.
import { L, esc, money, fmtMonth, fmtMin, fmtHours, num, fmtDate, isAr } from '../core/utils.js';
import { modal, toast, toastErr, confirmDialog } from '../core/ui.js';
import { toMs, read } from '../core/fb.js';
import { person, nameOf } from '../services/directory.js';
import { PAY_STATUS, payStatus, payStatusLabel, loadProof, removeDeduction, restoreDeduction } from '../services/payroll.js';
import { partLabel, violationText } from '../services/salary.js';

// ---------- amount in Arabic words ("فقط ثمانية عشر ألفاً وخمسمائة جنيه مصري لا غير") ----------
const ONES = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة', 'عشرة', 'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر'];
const TENS = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
const HUNDREDS = ['', 'مائة', 'مائتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة', 'ستمائة', 'سبعمائة', 'ثمانمائة', 'تسعمائة'];
function under1000(n) {
  const h = Math.floor(n / 100), r = n % 100, out = [];
  if (h) out.push(HUNDREDS[h]);
  if (r) out.push(r < 20 ? ONES[r] : (r % 10 ? `${ONES[r % 10]} و${TENS[Math.floor(r / 10)]}` : TENS[Math.floor(r / 10)]));
  return out.join(' و');
}
function scale(n, one, two, few, many) { // 1 ألف · 2 ألفان · 3-10 آلاف · 11-99 ألفاً · 100+ by the last two digits
  if (n === 1) return one;
  if (n === 2) return two;
  const r = n % 100;
  return `${under1000(n)} ${r >= 3 && r <= 10 ? few : (r >= 11 ? many : one)}`;
}
function arWords(n) {
  if (!n) return 'صفر';
  const parts = [];
  const m = Math.floor(n / 1e6), t = Math.floor((n % 1e6) / 1000), rest = n % 1000;
  if (m) parts.push(scale(m, 'مليون', 'مليونان', 'ملايين', 'مليوناً'));
  if (t) parts.push(scale(t, 'ألف', 'ألفان', 'آلاف', 'ألفاً'));
  if (rest) parts.push(under1000(rest));
  return parts.join(' و');
}
export function amountInWords(v) {
  const x = Math.round((Number(v) || 0) * 100);
  const pounds = Math.floor(x / 100), piasters = x % 100;
  if (!isAr) return '';
  return `فقط ${arWords(pounds)} جنيه مصري${piasters ? ` و${arWords(piasters)} قرشاً` : ''} لا غير`;
}
/** Stable, readable reference, e.g. PS-202609-4F2A */
const payslipRef = (i) => { let h = 0; for (const c of String(i.email)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return `PS-${String(i.month).replace('-', '')}-${h.toString(16).slice(-4).toUpperCase().padStart(4, '0')}`; };

export function payslipHTML(i, opts = {}) {
  const p = person(i.email) || {};
  const s = payStatus(i);
  const a = i.att || {};
  const canCut = !!opts.edit && !['paid', 'sent'].includes(s);   // the admin may cancel a deduction until the salary is transferred
  const line = (label, v, sub = '', neg = false, key = '') => `<tr><td>${esc(label)}${sub ? `<div class="xs muted">${esc(sub)}</div>` : ''}</td><td class="num" style="white-space:nowrap;color:${neg ? 'var(--bad)' : 'inherit'}">${canCut && key ? `<button class="btn btn-ghost btn-icon btn-sm no-print" data-cut="${esc(key)}" data-label="${esc(label)}" data-amt="${Number(v) || 0}" title="${L('حذف الخصم', 'Cancel this deduction')}" style="color:var(--bad)"><i class="fas fa-trash"></i></button> ` : ''}${neg ? '−' : ''}${esc(money(v, false))}</td></tr>`;
  const earnings = [
    [i.freelancer ? L('الراتب (فريلانسر)', 'Salary (freelancer)') : L('الراتب الأساسي', 'Basic salary'), i.basic, ''],
    ...((i.allowanceLines || []).length ? i.allowanceLines.map(x => [x.name || L('بدل', 'Allowance'), x.amount, L('بدل ثابت', 'Fixed allowance')]) : (i.allowances ? [[L('البدلات', 'Allowances'), i.allowances, '']] : [])),
    ...(i.regularity ? [[L('بدل الانتظام', 'Regularity'), i.regularity, '']] : []),
    ...(i.kpiFull || i.kpi ? [['KPI', i.kpi || 0, i.kpiMode === 'pct' ? L(`${i.kpiValue}% من ${money(i.kpiFull, false)}`, `${i.kpiValue}% of ${money(i.kpiFull, false)}`) : (i.kpiMode === 'amt' ? L(`من ${money(i.kpiFull, false)}`, `of ${money(i.kpiFull, false)}`) : '')]] : []),
    ...(i.bonus ? [[L('مكافأة', 'Bonus'), i.bonus, '']] : []), ...(i.incentive ? [[L('حوافز', 'Incentive'), i.incentive, '']] : []),
    // overtime: one line per day off worked — hours × the value of an hour
    ...(i.overtimeLines || []).map(o => [L('أوفر تايم', 'Overtime'), o.amount, L(`${fmtDate(o.date)} · ${num(o.hours, 2)} ساعة × ${money(o.rate, false)}${o.multiplier && o.multiplier !== 1 ? ` × ${o.multiplier}` : ''}`, `${fmtDate(o.date)} · ${num(o.hours, 2)} h × ${money(o.rate, false)}${o.multiplier && o.multiplier !== 1 ? ` × ${o.multiplier}` : ''}`)])
  ];
  const fromParts = (l) => Object.entries(l.amounts || {}).map(([p, v]) => `${partLabel(p)} ${money(v, false)}`).join(' + ');
  const violationRows = (i.violations || []).map(l => [violationText(l), l.total, `${fmtDate(l.date)}${Object.keys(l.amounts || {}).length > 1 ? ` · ${fromParts(l)}` : ''}`, `${l.date}|${l.kind}`]);
  const rate = Number(i.dayRate) || 0;
  const advSub = (() => {
    const r = (i.advanceRefs || [])[0];
    if (!r || !r.total) return '';
    const per = r.perMonth || r.amount || 1, idx = Math.round((r.paidBefore || 0) / per) + 1, left = Math.max(0, r.total - (r.paidBefore || 0) - r.amount);
    const months = r.startMonth ? ` (${fmtMonth(r.startMonth)}${r.endMonth && r.endMonth !== r.startMonth ? ` ← ${fmtMonth(r.endMonth)}` : ''})` : '';
    return L(`قسط ${idx}${r.count ? ` من ${r.count}` : ''}${months} — سلفة ${money(r.total, false)}، المتبقي بعده ${money(left, false)}`, `Installment ${idx}${r.count ? ` of ${r.count}` : ''}${months} — advance ${money(r.total, false)}, ${money(left, false)} left after it`);
  })();
  const deds = [
    ...(i.fixed ? [[L('خصومات ثابتة (تأمينات...)', 'Fixed deductions (insurance…)'), i.fixed, '', 'fixed']] : []),
    ...(i.violations ? violationRows : [ // salaries calculated before the per-employee rules
      ...(i.absenceDeduction ? [[L('غياب', 'Absence'), i.absenceDeduction, L(`${num(i.absenceDays, 1)} يوم × ${money(rate, false)} أجر اليوم`, `${num(i.absenceDays, 1)} day(s) × ${money(rate, false)} day rate`)]] : []),
      ...(i.lateDeduction ? [[L('تأخير', 'Lateness'), i.lateDeduction, L(`${fmtMin(i.lateMinutes)} إجمالي · ${num(i.lateDays, 2)} يوم خصم`, `${fmtMin(i.lateMinutes)} total · ${num(i.lateDays, 2)} day(s) deducted`)]] : [])
    ]),
    ...(i.unpaidDeduction ? [[L('إجازة بدون أجر', 'Unpaid leave'), i.unpaidDeduction, L(`${num(i.unpaidDays)} يوم × ${money(rate, false)}`, `${num(i.unpaidDays)} day(s) × ${money(rate, false)}`), 'unpaid']] : []),
    ...(i.advance ? [[L('قسط سلفة', 'Advance installment'), i.advance, advSub]] : []),
    ...((i.otherDeductions || []).map((d, n) => [d.reason || L('خصم', 'Deduction'), d.amount, L('خصم إضافي', 'Other deduction'), `od:${n}`]))
  ];
  const waivedRows = canCut ? (i.waived || []) : [];
  const info = (label, v) => v ? `<div><span class="xs muted">${esc(label)}</span><b>${esc(v)}</b></div>` : '';
  const stat = (label, v) => `<div class="ps-stat"><b class="num">${v}</b><span>${esc(label)}</span></div>`;
  const hire = i.hireDate || p.hireDate;
  return `<div class="payslip">
    <div class="ps-head">
      <img src="assets/img/logo-full.png" alt="AL MASTER" style="height:28px;width:auto">
      <div style="text-align:end"><b style="font-size:17px">${L('قسيمة راتب', 'Payslip')} — ${esc(fmtMonth(i.month))}</b>
        <div class="xs muted num" dir="ltr">${esc(payslipRef(i))}</div>
        <span class="pay-badge ${PAY_STATUS[s].cls} mt-4"><i class="fas ${PAY_STATUS[s].icon}"></i>${esc(payStatusLabel(s))}</span></div></div>

    ${!['paid', 'sent'].includes(s) ? `<div class="alert warn mt-8"><i class="fas fa-circle-info"></i><span>${L('قسيمة مبدئية: الراتب لسه ما اتحوّلش وممكن الأرقام تتعدّل لحد الاعتماد.', 'Preliminary payslip: the salary is not transferred yet and the figures may still change until approval.')}</span></div>` : ''}
    <div class="ps-info">
      ${info(L('الموظف', 'Employee'), i.name)}${info(L('المسمى الوظيفي', 'Job title'), i.title || p.title)}${info(L('القسم', 'Department'), i.department || p.department)}
      ${info(L('تاريخ التعيين', 'Hire date'), hire ? fmtDate(hire) : '')}${info(L('طريقة التحويل', 'Paid to'), i.payTo)}${info(L('تاريخ التحويل', 'Transfer date'), i.paidAt ? fmtDate(toMs(i.paidAt)) : '')}
    </div>

    ${i.att ? `<div class="label mb-8">${L('ملخص الحضور', 'Attendance summary')}</div>
    <div class="ps-stats">
      ${stat(L('أيام العمل المطلوبة', 'Working days'), num(a.planned || 0))}${stat(L('حضور', 'Present'), `${num(a.present || 0)}${a.remote ? `<small> (${num(a.remote)} ${L('أونلاين', 'remote')})</small>` : ''}`)}
      ${stat(L('إجازات', 'Leave'), num(a.leave || 0))}${stat(L('غياب', 'Absent'), num(a.absent || 0))}
      ${stat(L('تأخير', 'Lateness'), a.lateMinutes ? esc(fmtMin(a.lateMinutes)) : '0')}${a.workMs ? stat(L('ساعات الشغل', 'Work hours'), esc(fmtHours(a.workMs))) : ''}
    </div>` : ''}

    <div class="grid g-2 mt-16">
      <div><div class="label mb-8" style="color:var(--ok)">${L('المستحقات', 'Earnings')}</div><table class="table ps-table"><tbody>${earnings.map(([l, v, sub]) => line(l, v, sub)).join('')}
        <tr class="ps-total"><td>${L('إجمالي المستحقات', 'Total earnings')}</td><td class="num">${esc(money(i.gross, false))}</td></tr></tbody></table></div>
      <div><div class="label mb-8" style="color:var(--bad)">${L('الاستقطاعات', 'Deductions')}</div><table class="table ps-table"><tbody>${deds.length ? deds.map(([l, v, sub, key]) => line(l, v, sub, true, key)).join('') : `<tr><td colspan="2" class="muted">${L('لا يوجد', 'None')}</td></tr>`}
        <tr class="ps-total"><td>${L('إجمالي الاستقطاعات', 'Total deductions')}</td><td class="num">${esc(money(i.deductions, false))}</td></tr></tbody></table></div>
    </div>

    ${waivedRows.length ? `<div class="mt-16 no-print"><div class="label mb-8">${L('خصومات اتلغت (الموظف مش شايفها)', 'Cancelled deductions (hidden from the employee)')}</div>
      <table class="table ps-table"><tbody>${waivedRows.map(w => `<tr><td><span style="text-decoration:line-through" class="muted">${esc(w.label || w.key)}</span></td><td class="num" style="white-space:nowrap"><span class="muted" style="text-decoration:line-through">${esc(money(w.amount, false))}</span> <button class="btn btn-sm" data-uncut="${esc(w.key)}"><i class="fas fa-rotate-left"></i> ${L('استرجاع', 'Restore')}</button></td></tr>`).join('')}</tbody></table></div>` : ''}

    <div class="hero mt-16" style="padding:18px 22px"><div class="row between" style="flex-wrap:wrap;gap:8px"><span>${L('صافي الراتب', 'Net pay')}</span><b class="num" style="font-size:26px">${esc(money(i.net))}</b></div>
      ${amountInWords(i.net) ? `<div class="small" style="opacity:.85;margin-top:6px">${esc(amountInWords(i.net))}</div>` : ''}</div>
    ${i.note ? `<div class="alert info mt-16"><i class="fas fa-comment"></i><div>${esc(i.note)}</div></div>` : ''}

    ${i.proof ? `<div class="mt-16"><div class="label mb-8">${L('إثبات التحويل', 'Proof of transfer')}</div>
      <div class="ps-proof">
        ${i.proof.thumb ? `<button class="ps-proof-img" data-proof title="${L('تكبير', 'Enlarge')}"><img src="${esc(i.proof.thumb)}" alt=""></button>` : `<button class="btn" data-proof><i class="fas fa-file-pdf"></i> ${L('فتح الإيصال', 'Open receipt')}</button>`}
        <div class="small">${i.paidAt ? `<div>${L('اتحوّل يوم', 'Transferred on')} <b>${esc(fmtDate(toMs(i.paidAt)))}</b></div>` : ''}${i.paidBy ? `<div class="muted">${L('بواسطة', 'By')} ${esc(nameOf(i.paidBy))}</div>` : ''}${i.proof.note ? `<div class="muted">${L('ملاحظة:', 'Note:')} ${esc(i.proof.note)}</div>` : ''}</div>
      </div></div>` : ''}

    <div class="print-only" style="margin-top:40px"><div class="row between"><div style="text-align:center"><div style="border-bottom:1px solid #999;width:180px;height:30px"></div><span class="xs">${L('توقيع الموظف', 'Employee signature')}</span></div><div style="text-align:center"><div style="border-bottom:1px solid #999;width:180px;height:30px"></div><span class="xs">${L('الموارد البشرية / المالية', 'HR / Finance')}</span></div></div></div>
    <p class="xs muted" style="margin-top:20px;text-align:center">AL MASTER TECHNOLOGY · almaster.tech · ${L('صدرت يوم', 'Issued')} ${esc(fmtDate(toMs(i.sentAt) || Date.now()))}</p>
  </div>`;
}

/** opts.edit (payroll page, admin): a trash button on every deduction + restore for the cancelled ones */
export function openPayslip(item, opts = {}) {
  let cur = item;
  const m = modal({
    title: `${L('قسيمة راتب', 'Payslip')} — ${fmtMonth(item.month)}`, icon: 'fa-receipt', size: 'wide',
    body: payslipHTML(item, opts),
    foot: `<button class="btn" data-close>${L('إغلاق', 'Close')}</button><button class="btn btn-primary" id="pp"><i class="fas fa-print"></i> ${L('طباعة / PDF', 'Print / PDF')}</button>`
  });
  m.$('#pp').onclick = () => {
    document.body.classList.add('printing-modal');
    setTimeout(() => { window.print(); document.body.classList.remove('printing-modal'); }, 50);
  };
  const wire = () => {
    const pb = m.$('[data-proof]');
    if (pb) pb.onclick = async () => {
      pb.classList.add('loading');
      try {
        const url = await loadProof(cur.proof);
        if (/^image\//.test(cur.proof.mime || '')) modal({ title: L('إيصال التحويل', 'Transfer receipt'), icon: 'fa-receipt', size: 'wide', body: `<div style="text-align:center"><img src="${url}" alt="" style="max-width:100%;max-height:70vh;border-radius:12px;margin:auto"></div>`, foot: `<a class="btn btn-primary" href="${url}" download="${esc(cur.proof.name || 'receipt.jpg')}"><i class="fas fa-download"></i> ${L('تحميل', 'Download')}</a>` });
        else { const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.download = cur.proof.name || 'receipt.pdf'; document.body.appendChild(a); a.click(); a.remove(); }
      } catch (ex) { toastErr(ex); } finally { pb.classList.remove('loading'); }
    };
    // recalculate the salary, then redraw the slip with the new total and net
    const apply = async (b, job, done) => {
      b.classList.add('loading');
      try {
        await job();
        cur = await read('payroll_items', cur.id);
        m.$('.modal-body').innerHTML = payslipHTML(cur, opts); wire();
        toast(done);
      } catch (ex) { toastErr(ex); b.classList.remove('loading'); }
    };
    m.$$('[data-cut]').forEach(b => b.onclick = async () => {
      const label = b.dataset.label || '', amount = Number(b.dataset.amt) || 0;
      const ok = await confirmDialog({
        title: L('حذف الخصم؟', 'Cancel this deduction?'),
        message: L(`${label}\n${money(amount, false)}\n\nالراتب هيتحسب تاني لوحده، والقسيمة اللي عند الموظف هتتعدّل.`, `${label}\n${money(amount, false)}\n\nThe salary is recalculated and the employee's payslip is updated.`),
        okText: L('احذف الخصم', 'Cancel deduction'), okClass: 'btn-danger'
      });
      if (ok) apply(b, () => removeDeduction(cur, { key: b.dataset.cut, label, amount }), L('اتحذف الخصم والراتب اتعدّل', 'Deduction cancelled, salary updated'));
    });
    m.$$('[data-uncut]').forEach(b => b.onclick = () => apply(b, () => restoreDeduction(cur, b.dataset.uncut), L('رجع الخصم والراتب اتعدّل', 'Deduction restored, salary updated')));
  };
  wire();
  return m;
}
