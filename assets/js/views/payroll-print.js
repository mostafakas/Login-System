// Payroll → an official, printable statement (A4 landscape): company header, summary, the month's salaries grouped by
// department with subtotals, and the signature blocks (accountant, general manager) + the company stamp.
// It opens the browser's print dialog, where "Save as PDF" gives the PDF.
import { L, esc, isAr, money, fmtMonth } from '../core/utils.js';
import { session, now } from '../core/session.js';
import { toMs } from '../core/fb.js';
import { payStatus, payStatusLabel } from '../services/payroll.js';

const sum = (arr, f) => arr.reduce((s, x) => s + (Number(f(x)) || 0), 0);
const m = (n) => esc(money(n, false));

export function printPayroll({ month, items, run }) {
  const list = items.slice().sort((a, b) => (a.department || '').localeCompare(b.department || '', 'ar') || (a.name || '').localeCompare(b.name || '', 'ar'));
  if (!list.length) return false;
  const dir = isAr ? 'rtl' : 'ltr', start = isAr ? 'right' : 'left', end = isAr ? 'left' : 'right';
  const who = (session.profile && session.profile.name) || session.email;
  const stamp = new Date(now()).toLocaleString(isAr ? 'ar-EG-u-nu-latn' : 'en-GB', { dateStyle: 'long', timeStyle: 'short' });
  const built = run && run.builtAt ? new Date(toMs(run.builtAt)).toLocaleDateString(isAr ? 'ar-EG-u-nu-latn' : 'en-GB') : '—';
  const logo = new URL('assets/img/logo-full.png', location.href).href;
  const extras = (i) => (Number(i.allowances) || 0) + (Number(i.regularity) || 0) + (Number(i.kpi) || 0);
  const bonus = (i) => (Number(i.bonus) || 0) + (Number(i.incentive) || 0);
  const depts = [...new Set(list.map(i => i.department || L('بدون قسم', 'No department')))];
  let n = 0;
  const tot = (rows, cls = 'sub', label = '') => `<tr class="${cls}"><td colspan="3">${esc(label)}</td>
    <td>${m(sum(rows, i => i.basic))}</td><td>${m(sum(rows, extras))}</td><td>${m(sum(rows, bonus))}</td><td>${m(sum(rows, i => i.overtime))}</td>
    <td>${m(sum(rows, i => i.gross))}</td><td class="neg">${m(sum(rows, i => i.deductions))}</td><td class="net">${m(sum(rows, i => i.net))}</td><td colspan="2"></td></tr>`;
  const body = depts.map(d => {
    const rows = list.filter(i => (i.department || L('بدون قسم', 'No department')) === d);
    return `<tr class="dept"><td colspan="12">${esc(d)} <span>(${rows.length})</span></td></tr>${rows.map(i => {
      const parts = [[L('تأخير', 'Late'), i.lateDeduction], [L('غياب', 'Absence'), (i.absenceDeduction || 0) + (i.unpaidDeduction || 0)], [L('سلفة', 'Advance'), i.advance], [L('ثابتة', 'Fixed'), i.fixed],
        [L('أخرى', 'Other'), sum(i.otherDeductions || [], x => x.amount) + (Number(i.remoteDeduction) || 0) + (Number(i.earlyDeduction) || 0)]].filter(x => Number(x[1]) > 0);
      return `<tr><td class="c">${++n}</td>
        <td class="nm"><b>${esc(i.name)}</b><small>${esc(i.title || '')}${i.freelancer ? ` · ${L('فريلانسر', 'Freelancer')}` : ''}</small></td>
        <td class="pay">${esc(i.payTo || '—')}</td>
        <td>${m(i.basic)}</td><td>${m(extras(i))}</td><td>${m(bonus(i))}</td>
        <td>${Number(i.overtime) ? `${m(i.overtime)}<small>${esc(i.overtimeHours || 0)} ${L('س', 'h')}</small>` : '—'}</td>
        <td><b>${m(i.gross)}</b></td>
        <td class="neg">${Number(i.deductions) ? `${m(i.deductions)}<small>${parts.map(([a, v]) => `${esc(a)} ${m(v)}`).join(' · ')}</small>` : '—'}</td>
        <td class="net">${m(i.net)}</td>
        <td class="c st ${payStatus(i)}">${esc(payStatusLabel(payStatus(i)))}</td>
        <td class="sig"></td></tr>`;
    }).join('')}${depts.length > 1 ? tot(rows, 'sub', `${L('إجمالي', 'Subtotal')} ${d}`) : ''}`;
  }).join('');
  const tile = (label, v, cls = '') => `<div class="tile ${cls}"><span>${esc(label)}</span><b>${esc(v)}</b></div>`;
  const doc = `<!doctype html><html dir="${dir}" lang="${isAr ? 'ar' : 'en'}"><head><meta charset="utf-8"><title>${esc(L('كشف رواتب', 'Payroll'))} ${esc(fmtMonth(month))}</title>
<style>
  @page { size: A4 landscape; margin: 12mm 10mm 16mm; @bottom-center { content: counter(page) " / " counter(pages); font: 9px Tahoma, sans-serif; color: #6b7394; } }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; font: 11px/1.45 'Segoe UI', Tahoma, Arial, sans-serif; color: #1b2140; }
  .head { display: flex; align-items: center; gap: 16px; padding-bottom: 10px; border-bottom: 3px solid #1b1bdb; }
  .head img { height: 46px; }
  .head .t { flex: 1; } .head h1 { margin: 0; font-size: 20px; color: #0f1b4d; } .head p { margin: 2px 0 0; color: #6b7394; font-size: 11px; }
  .meta { text-align: ${end}; font-size: 10.5px; color: #6b7394; line-height: 1.6; } .meta b { color: #1b2140; }
  .tiles { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin: 12px 0; }
  .tile { border: 1px solid #d5daea; border-top: 3px solid #1b1bdb; border-radius: 6px; padding: 7px 10px; background: #f6f8fd; }
  .tile span { display: block; font-size: 10px; color: #6b7394; } .tile b { font-size: 15px; color: #0f1b4d; } .tile.neg b { color: #c62828; } .tile.ok b { color: #1e8e3e; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; } tr { page-break-inside: avoid; }
  th { background: #0f1b4d; color: #fff; font-size: 10.5px; padding: 7px 5px; border: 1px solid #0f1b4d; text-align: center; }
  td { border: 1px solid #d5daea; padding: 5px 6px; text-align: ${end}; vertical-align: middle; font-variant-numeric: tabular-nums; }
  td small { display: block; color: #6b7394; font-size: 9px; font-weight: normal; }
  td.c { text-align: center; } td.nm { text-align: ${start}; } td.nm b { font-size: 11.5px; } td.pay { text-align: ${start}; font-size: 10px; color: #4a5278; }
  td.neg { color: #c62828; } td.net { font-weight: 700; color: #1e8e3e; background: #f1faf4; }
  td.st { font-size: 9.5px; font-weight: 700; } td.st.pending { color: #b26a00; } td.st.approved { color: #1b1bdb; } td.st.paid { color: #1e8e3e; } td.st.sent { color: #00796b; }
  td.sig { width: 78px; }
  tr:nth-child(even) td:not(.net) { background: #fafbfe; }
  tr.dept td { background: #eef1fb; color: #1b1bdb; font-weight: 700; text-align: ${start}; font-size: 11.5px; border-color: #c9d0ea; } tr.dept span { color: #6b7394; font-weight: normal; }
  tr.sub td { background: #e9edf9; font-weight: 700; color: #0f1b4d; } tr.sub td:first-child { text-align: ${start}; }
  tr.grand td { background: #0f1b4d; color: #fff; font-weight: 700; font-size: 12px; border-color: #0f1b4d; } tr.grand td.neg, tr.grand td.net { color: #fff; background: #0f1b4d; }
  .notes { margin-top: 10px; font-size: 10px; color: #6b7394; }
  .sigs { display: grid; grid-template-columns: 1fr 1fr 190px; gap: 22px; margin-top: 26px; page-break-inside: avoid; align-items: end; }
  .sigbox { text-align: center; } .sigbox .role { font-weight: 700; font-size: 12px; color: #0f1b4d; margin-bottom: 4px; }
  .sigbox .area { height: 70px; border-bottom: 1.5px solid #1b2140; } .sigbox .lines { margin-top: 6px; font-size: 10.5px; color: #4a5278; line-height: 2; text-align: ${start}; }
  .stamp { height: 150px; width: 150px; margin: 0 auto; border: 2px dashed #9aa3c7; border-radius: 50%; display: flex; align-items: center; justify-content: center; text-align: center; color: #9aa3c7; font-size: 11px; font-weight: 700; }
  .foot { margin-top: 14px; padding-top: 6px; border-top: 1px solid #d5daea; font-size: 9px; color: #9aa3c7; display: flex; justify-content: space-between; }
</style></head><body>
  <div class="head"><img src="${esc(logo)}" alt="" onerror="this.style.display='none'"><div class="t"><h1>${esc(L('كشف رواتب شهر', 'Payroll statement'))} ${esc(fmtMonth(month))}</h1><p>AL MASTER · ${esc(L('كشف مرتبات الموظفين', 'Employee salaries'))}</p></div>
    <div class="meta">${esc(L('تاريخ الإصدار', 'Issued'))}: <b>${esc(stamp)}</b><br>${esc(L('آخر حساب', 'Last calculated'))}: <b>${esc(built)}</b><br>${esc(L('أُعدّ بواسطة', 'Prepared by'))}: <b>${esc(who)}</b></div></div>
  <div class="tiles">
    ${tile(L('عدد الموظفين', 'Employees'), String(list.length))}${tile(L('إجمالي الرواتب', 'Total gross'), money(sum(list, i => i.gross)))}
    ${tile(L('إجمالي الاستقطاعات', 'Total deductions'), money(sum(list, i => i.deductions)), 'neg')}${tile(L('صافي المطلوب صرفه', 'Net payable'), money(sum(list, i => i.net)), 'ok')}
    ${tile(L('أوفر تايم', 'Overtime'), money(sum(list, i => i.overtime)))}
  </div>
  <table><thead><tr><th style="width:26px">#</th><th>${esc(L('الموظف', 'Employee'))}</th><th>${esc(L('طريقة الدفع', 'Pay to'))}</th><th>${esc(L('الأساسي', 'Basic'))}</th><th>${esc(L('بدلات وانتظام وKPI', 'Allowances · regularity · KPI'))}</th>
    <th>${esc(L('مكافآت وحوافز', 'Bonus'))}</th><th>${esc(L('أوفر تايم', 'Overtime'))}</th><th>${esc(L('الإجمالي', 'Gross'))}</th><th>${esc(L('الاستقطاعات', 'Deductions'))}</th><th>${esc(L('الصافي', 'Net'))}</th><th>${esc(L('الحالة', 'Status'))}</th><th>${esc(L('توقيع المستلم', 'Receipt signature'))}</th></tr></thead>
    <tbody>${body}${tot(list, 'grand', L('الإجمالي العام', 'Grand total'))}</tbody></table>
  <p class="notes">${esc(L('كل المبالغ بالجنيه المصري. الصافي = الإجمالي − الاستقطاعات. الاستقطاعات تشمل التأخير والغياب والإجازات بدون أجر وأقساط السلف والخصومات الثابتة واليدوية.', 'All amounts in EGP. Net = gross − deductions. Deductions include lateness, absence, unpaid leave, advance installments, and fixed and manual deductions.'))}</p>
  <div class="sigs">
    <div class="sigbox"><div class="role">${esc(L('المحاسب', 'Accountant'))}</div><div class="area"></div><div class="lines">${esc(L('الاسم', 'Name'))}: ..................................<br>${esc(L('التاريخ', 'Date'))}: ..................................</div></div>
    <div class="sigbox"><div class="role">${esc(L('المدير العام', 'General Manager'))}</div><div class="area"></div><div class="lines">${esc(L('الاسم', 'Name'))}: ..................................<br>${esc(L('التاريخ', 'Date'))}: ..................................</div></div>
    <div class="sigbox"><div class="role">${esc(L('ختم الشركة', 'Company stamp'))}</div><div class="stamp">${esc(L('مكان الختم', 'Stamp here'))}</div></div>
  </div>
  <div class="foot"><span>AL MASTER HR</span><span>${esc(L('كشف الرواتب', 'Payroll'))} · ${esc(fmtMonth(month))}</span></div>
</body></html>`;
  // print from a hidden frame: no pop-up blockers, and the dialog offers "Save as PDF"
  const fr = document.createElement('iframe');
  fr.style.cssText = 'position:fixed;inset:auto 0 0 auto;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(fr);
  const w = fr.contentWindow;
  w.document.open(); w.document.write(doc); w.document.close();
  const go = () => { try { w.focus(); w.print(); } finally { setTimeout(() => fr.remove(), 60000); } };
  const imgs = [...w.document.images];
  Promise.all(imgs.map(im => (im.complete ? 1 : new Promise(r => { im.onload = im.onerror = r; })))).then(() => setTimeout(go, 150));
  return true;
}
