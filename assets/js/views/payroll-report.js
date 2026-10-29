// Payroll → Excel: a formatted workbook (ExcelJS, loaded on demand) with everything about the month's salaries:
//   Summary · Payroll sheet · Attendance & commitment · Overtime · Deductions detail · Advances.
// If ExcelJS can't be loaded the plain export (views/export.js) is used instead.
import { L, isAr, fmtMonth } from '../core/utils.js';
import { session, now } from '../core/session.js';
import { toMs } from '../core/fb.js';
import { person } from '../services/directory.js';
import { payStatus, payStatusLabel } from '../services/payroll.js';
import { violationText } from '../services/salary.js';
import { toast } from '../core/ui.js';

let loading = null;
function loadExcelJS() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  if (!loading) loading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js';
    s.onload = () => (window.ExcelJS ? resolve(window.ExcelJS) : reject(new Error('exceljs')));
    s.onerror = () => { loading = null; reject(new Error('exceljs-load')); };
    document.head.appendChild(s);
  });
  return loading;
}

// ---------- look ----------
const C = { navy: 'FF0F1B4D', brand: 'FF1B1BDB', soft: 'FFEEF1FB', zebra: 'FFF6F8FD', line: 'FFD5DAEA', total: 'FFDDE3F6', white: 'FFFFFFFF', text: 'FF1B2140', muted: 'FF6B7394', bad: 'FFC62828', ok: 'FF1E8E3E', warn: 'FFB26A00' };
const STATUS_COLOR = { pending: 'FFB26A00', approved: 'FF1B1BDB', paid: 'FF1E8E3E', sent: 'FF00796B' };
const MONEY = '#,##0.00', HOURS = '0.00', INT = '0';
const FONT = 'Calibri';
const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const side = (argb = C.line) => ({ style: 'thin', color: { argb } });
const box = (argb) => ({ top: side(argb), bottom: side(argb), left: side(argb), right: side(argb) });
const colLetter = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const sum = (arr, f) => arr.reduce((s, x) => s + (Number(f(x)) || 0), 0);
const hoursOf = (ms) => r2((Number(ms) || 0) / 3600000);

function sheet(wb, name, { freeze = null, tab = C.brand, landscape = true } = {}) {
  const ws = wb.addWorksheet(name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31), {
    views: [{ rightToLeft: isAr, showGridLines: false, ...(freeze ? { state: 'frozen', xSplit: freeze.x || 0, ySplit: freeze.y || 0 } : {}) }],
    properties: { tabColor: { argb: tab } },
    pageSetup: { orientation: landscape ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } }
  });
  return ws;
}
function banner(ws, row, text, cols, { size = 16, bg = C.navy, height = 34 } = {}) {
  ws.mergeCells(row, 1, row, cols);
  const c = ws.getCell(row, 1);
  c.value = text; c.fill = fill(bg); c.font = { name: FONT, size, bold: true, color: { argb: C.white } };
  c.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(row).height = height;
}
function note(ws, row, text, cols) {
  ws.mergeCells(row, 1, row, cols);
  const c = ws.getCell(row, 1); c.value = text; c.font = { name: FONT, size: 10, color: { argb: C.muted } }; c.alignment = { horizontal: 'center', vertical: 'middle' };
}
function section(ws, row, text, cols) {
  ws.mergeCells(row, 1, row, cols);
  const c = ws.getCell(row, 1); c.value = text; c.fill = fill(C.soft);
  c.font = { name: FONT, size: 12, bold: true, color: { argb: C.brand } }; c.alignment = { horizontal: isAr ? 'right' : 'left', vertical: 'middle', indent: 1 };
  c.border = { bottom: { style: 'medium', color: { argb: C.brand } } };
  ws.getRow(row).height = 24;
}
/**
 * A table. cols: [{ h, w, v(row, i), fmt, sum, align, color(row) }]. Returns the row after the table (and its totals).
 * Totals are real SUM formulas (the cached value is filled in too, so viewers that don't recalculate still show it).
 */
function table(ws, top, cols, rows, { totals = true, filter = false } = {}) {
  cols.forEach((c, i) => { if (c.w) ws.getColumn(i + 1).width = Math.max(ws.getColumn(i + 1).width || 0, c.w); });
  const head = ws.getRow(top); head.height = 32;
  cols.forEach((c, i) => {
    const cell = head.getCell(i + 1); cell.value = c.h; cell.fill = fill(C.navy);
    cell.font = { name: FONT, size: 11, bold: true, color: { argb: C.white } }; cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; cell.border = box(C.navy);
  });
  rows.forEach((r, ri) => {
    const row = ws.getRow(top + 1 + ri); row.height = 21;
    cols.forEach((c, i) => {
      const cell = row.getCell(i + 1); const v = c.v(r, ri);
      cell.value = v === undefined || v === null ? '' : v;
      if (c.fmt) cell.numFmt = c.fmt;
      cell.font = { name: FONT, size: 11, color: { argb: (c.color && c.color(r, v)) || C.text }, bold: !!c.bold };
      cell.alignment = { horizontal: c.align || (c.fmt ? 'right' : (isAr ? 'right' : 'left')), vertical: 'middle', wrapText: !!c.wrap, indent: c.fmt ? 0 : 1 };
      cell.border = box(); if (ri % 2) cell.fill = fill(C.zebra);
    });
  });
  let next = top + 1 + rows.length;
  if (totals && rows.length) {
    const tr = ws.getRow(next); tr.height = 24;
    cols.forEach((c, i) => {
      const cell = tr.getCell(i + 1);
      if (i === 0 && !c.sum) cell.value = L('الإجمالي', 'Total');
      else if (c.sum) { const col = colLetter(i + 1); cell.value = { formula: `SUM(${col}${top + 1}:${col}${top + rows.length})`, result: r2(sum(rows, (r) => c.v(r))) }; if (c.fmt) cell.numFmt = c.fmt; }
      cell.fill = fill(C.total); cell.font = { name: FONT, size: 11, bold: true, color: { argb: C.navy } };
      cell.alignment = { horizontal: c.sum ? 'right' : 'center', vertical: 'middle' }; cell.border = { top: { style: 'medium', color: { argb: C.navy } }, bottom: side(C.navy), left: side(), right: side() };
    });
    next++;
  }
  if (filter && rows.length) ws.autoFilter = { from: { row: top, column: 1 }, to: { row: top, column: cols.length } };
  return next + 1;
}
/** a KPI tile over two columns: small label, big value */
function tile(ws, row, col, label, value, fmt, color = C.navy) {
  ws.mergeCells(row, col, row, col + 1); ws.mergeCells(row + 1, col, row + 1, col + 1);
  const a = ws.getCell(row, col), b = ws.getCell(row + 1, col);
  a.value = label; a.font = { name: FONT, size: 10, bold: true, color: { argb: C.muted } }; a.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  b.value = value; if (fmt) b.numFmt = fmt; b.font = { name: FONT, size: 18, bold: true, color: { argb: color } }; b.alignment = { horizontal: 'center', vertical: 'middle' };
  [col, col + 1].forEach(cc => { ws.getCell(row, cc).fill = fill(C.soft); ws.getCell(row + 1, cc).fill = fill(C.soft); });
  ws.getCell(row, col).border = { top: { style: 'medium', color: { argb: C.brand } }, left: side(), right: side() };
  ws.getCell(row, col + 1).border = { top: { style: 'medium', color: { argb: C.brand } }, right: side() };
  ws.getCell(row + 1, col).border = { bottom: side(), left: side(), right: side() };
  ws.getCell(row + 1, col + 1).border = { bottom: side(), right: side() };
  ws.getRow(row).height = 22; ws.getRow(row + 1).height = 34;
}

// ---------- the report ----------
export async function exportPayrollReport({ month, items, run }) {
  const X = await loadExcelJS();
  const list = items.slice().sort((a, b) => (a.department || '').localeCompare(b.department || '', 'ar') || (a.name || '').localeCompare(b.name || '', 'ar'));
  const wb = new X.Workbook();
  wb.creator = 'AL MASTER HR'; wb.created = new Date(); wb.title = `Payroll ${month}`;
  const monthName = fmtMonth(month);
  const who = (session.profile && session.profile.name) || session.email;
  const stamp = new Date(now()).toLocaleString(isAr ? 'ar-EG-u-nu-latn' : 'en-GB');
  const dedOther = (i) => sum(i.otherDeductions || [], d => d.amount);
  const dedAbsence = (i) => (Number(i.absenceDeduction) || 0);
  const transferred = list.filter(i => ['paid', 'sent'].includes(payStatus(i)));

  // ===== 1. summary =====
  {
    const ws = sheet(wb, L('الملخص', 'Summary'), { tab: C.navy, landscape: false });
    for (let c = 1; c <= 8; c++) ws.getColumn(c).width = 17;
    banner(ws, 1, `AL MASTER — ${L('كشف رواتب', 'Payroll')} ${monthName}`, 8, { size: 18, height: 40 });
    note(ws, 2, `${L('اتعمل في', 'Created')}: ${stamp} · ${L('بواسطة', 'by')}: ${who} · ${L('آخر حساب', 'last calculated')}: ${run && run.builtAt ? new Date(toMs(run.builtAt)).toLocaleString(isAr ? 'ar-EG-u-nu-latn' : 'en-GB') : '—'}`, 8);
    tile(ws, 4, 1, L('عدد الموظفين', 'Employees'), list.length, INT);
    tile(ws, 4, 3, L('إجمالي الرواتب', 'Total gross'), r2(sum(list, i => i.gross)), MONEY, C.brand);
    tile(ws, 4, 5, L('إجمالي الاستقطاعات', 'Total deductions'), r2(sum(list, i => i.deductions)), MONEY, C.bad);
    tile(ws, 4, 7, L('صافي المطلوب صرفه', 'Net payable'), r2(sum(list, i => i.net)), MONEY, C.ok);
    tile(ws, 7, 1, L('الأساسي', 'Basic'), r2(sum(list, i => i.basic)), MONEY);
    tile(ws, 7, 3, L('بدلات + انتظام + KPI', 'Allowances + regularity + KPI'), r2(sum(list, i => (Number(i.allowances) || 0) + (Number(i.regularity) || 0) + (Number(i.kpi) || 0))), MONEY);
    tile(ws, 7, 5, L('مكافآت وحوافز', 'Bonus & incentives'), r2(sum(list, i => (Number(i.bonus) || 0) + (Number(i.incentive) || 0))), MONEY);
    tile(ws, 7, 7, `${L('أوفر تايم', 'Overtime')} (${r2(sum(list, i => i.overtimeHours))} ${L('ساعة', 'h')})`, r2(sum(list, i => i.overtime)), MONEY, C.brand);
    tile(ws, 10, 1, L('اتحوّل فعلاً', 'Transferred'), r2(sum(transferred, i => i.net)), MONEY, C.ok);
    tile(ws, 10, 3, L('لسه متحوّلش', 'Not yet transferred'), r2(sum(list, i => i.net) - sum(transferred, i => i.net)), MONEY, C.warn);
    tile(ws, 10, 5, L('أقساط السلف', 'Advance installments'), r2(sum(list, i => i.advance)), MONEY);
    tile(ws, 10, 7, L('متوسط الصافي', 'Average net'), list.length ? r2(sum(list, i => i.net) / list.length) : 0, MONEY);

    let row = 13;
    section(ws, row, L('حالة الرواتب', 'Salary status'), 8); row += 1;
    const statuses = ['pending', 'approved', 'paid', 'sent'].map(s => ({ s, rows: list.filter(i => payStatus(i) === s) }));
    const colsA = [
      { h: L('الحالة', 'Status'), v: (r) => payStatusLabel(r.s), bold: true, color: (r) => STATUS_COLOR[r.s] },
      { h: L('عدد الموظفين', 'Employees'), v: (r) => r.rows.length, fmt: INT, sum: true },
      { h: L('الصافي', 'Net'), v: (r) => r2(sum(r.rows, i => i.net)), fmt: MONEY, sum: true },
      { h: L('النسبة', 'Share'), v: (r) => (list.length ? r.rows.length / list.length : 0), fmt: '0%' }
    ];
    row = table(ws, row, colsA, statuses);

    section(ws, row, L('حسب القسم', 'By department'), 8); row += 1;
    const depts = [...new Set(list.map(i => i.department || L('بدون قسم', 'No department')))].sort((a, b) => a.localeCompare(b, 'ar'))
      .map(d => ({ d, rows: list.filter(i => (i.department || L('بدون قسم', 'No department')) === d) }));
    row = table(ws, row, [
      { h: L('القسم', 'Department'), v: (r) => r.d, bold: true },
      { h: L('الموظفين', 'Employees'), v: (r) => r.rows.length, fmt: INT, sum: true },
      { h: L('الإجمالي', 'Gross'), v: (r) => r2(sum(r.rows, i => i.gross)), fmt: MONEY, sum: true },
      { h: L('الاستقطاعات', 'Deductions'), v: (r) => r2(sum(r.rows, i => i.deductions)), fmt: MONEY, sum: true, color: () => C.bad },
      { h: L('الصافي', 'Net'), v: (r) => r2(sum(r.rows, i => i.net)), fmt: MONEY, sum: true, color: () => C.ok },
      { h: L('متوسط الصافي', 'Average net'), v: (r) => (r.rows.length ? r2(sum(r.rows, i => i.net) / r.rows.length) : 0), fmt: MONEY }
    ], depts);

    section(ws, row, L('تفصيل الاستقطاعات', 'Deductions breakdown'), 8); row += 1;
    const dedRows = [
      [L('استقطاعات ثابتة', 'Fixed deductions'), sum(list, i => i.fixed)], [L('غياب', 'Absence'), sum(list, dedAbsence)], [L('إجازة بدون أجر', 'Unpaid leave'), sum(list, i => i.unpaidDeduction)],
      [L('تأخير', 'Lateness'), sum(list, i => i.lateDeduction)], [L('أونلاين مرفوض', 'Rejected remote'), sum(list, i => i.remoteDeduction)], [L('انصراف مبكر', 'Early leave'), sum(list, i => i.earlyDeduction)],
      [L('أقساط السلف', 'Advance installments'), sum(list, i => i.advance)], [L('استقطاعات أخرى', 'Other deductions'), sum(list, dedOther)]
    ].map(([n, v]) => ({ n, v: r2(v) }));
    row = table(ws, row, [
      { h: L('البند', 'Item'), v: (r) => r.n, bold: true },
      { h: L('المبلغ', 'Amount'), v: (r) => r.v, fmt: MONEY, sum: true, color: () => C.bad }
    ], dedRows);

    section(ws, row, L('أعلى 5 صافي', 'Top 5 net salaries'), 8); row += 1;
    table(ws, row, [
      { h: '#', v: (r, i) => i + 1, fmt: INT, align: 'center', w: 6 },
      { h: L('الموظف', 'Employee'), v: (r) => r.name, bold: true },
      { h: L('القسم', 'Department'), v: (r) => r.department || '' },
      { h: L('الصافي', 'Net'), v: (r) => r2(r.net), fmt: MONEY }
    ], list.slice().sort((a, b) => (b.net || 0) - (a.net || 0)).slice(0, 5), { totals: false });
    ws.getColumn(1).width = 24;
  }

  // ===== 2. payroll sheet =====
  {
    const ws = sheet(wb, L('كشف الرواتب', 'Payroll'), { freeze: { x: 2, y: 4 } });
    const cols = [
      { h: '#', w: 5, v: (r, i) => i + 1, fmt: INT, align: 'center' },
      { h: L('الموظف', 'Employee'), w: 26, v: (r) => r.name, bold: true },
      { h: L('القسم', 'Department'), w: 16, v: (r) => r.department || '' },
      { h: L('الوظيفة', 'Title'), w: 18, v: (r) => r.title || '' },
      { h: L('تاريخ التعيين', 'Hire date'), w: 13, v: (r) => r.hireDate || '', align: 'center' },
      { h: L('النوع', 'Type'), w: 11, v: (r) => (r.freelancer ? L('فريلانسر', 'Freelancer') : L('موظف', 'Employee')), align: 'center' },
      { h: L('طريقة الدفع', 'Pay to'), w: 20, v: (r) => r.payTo || '' },
      { h: L('الأساسي', 'Basic'), w: 13, v: (r) => r2(r.basic), fmt: MONEY, sum: true },
      { h: L('البدلات', 'Allowances'), w: 13, v: (r) => r2(r.allowances), fmt: MONEY, sum: true },
      { h: L('الانتظام', 'Regularity'), w: 13, v: (r) => r2(r.regularity), fmt: MONEY, sum: true },
      { h: 'KPI', w: 13, v: (r) => r2(r.kpi), fmt: MONEY, sum: true },
      { h: L('مكافأة', 'Bonus'), w: 12, v: (r) => r2(r.bonus), fmt: MONEY, sum: true },
      { h: L('حوافز', 'Incentive'), w: 12, v: (r) => r2(r.incentive), fmt: MONEY, sum: true },
      { h: L('ساعات أوفر تايم', 'Overtime hours'), w: 12, v: (r) => r2(r.overtimeHours), fmt: HOURS, sum: true },
      { h: L('أوفر تايم', 'Overtime'), w: 13, v: (r) => r2(r.overtime), fmt: MONEY, sum: true },
      { h: L('الإجمالي', 'Gross'), w: 15, v: (r) => r2(r.gross), fmt: MONEY, sum: true, bold: true },
      { h: L('استقطاعات ثابتة', 'Fixed'), w: 13, v: (r) => r2(r.fixed), fmt: MONEY, sum: true, color: (r, v) => (v ? C.bad : C.muted) },
      { h: L('غياب', 'Absence'), w: 12, v: (r) => r2(dedAbsence(r)), fmt: MONEY, sum: true, color: (r, v) => (v ? C.bad : C.muted) },
      { h: L('بدون أجر', 'Unpaid leave'), w: 12, v: (r) => r2(r.unpaidDeduction), fmt: MONEY, sum: true, color: (r, v) => (v ? C.bad : C.muted) },
      { h: L('تأخير', 'Late'), w: 12, v: (r) => r2(r.lateDeduction), fmt: MONEY, sum: true, color: (r, v) => (v ? C.bad : C.muted) },
      { h: L('أونلاين مرفوض', 'Rejected remote'), w: 13, v: (r) => r2(r.remoteDeduction), fmt: MONEY, sum: true, color: (r, v) => (v ? C.bad : C.muted) },
      { h: L('انصراف مبكر', 'Early leave'), w: 12, v: (r) => r2(r.earlyDeduction), fmt: MONEY, sum: true, color: (r, v) => (v ? C.bad : C.muted) },
      { h: L('قسط سلفة', 'Advance'), w: 12, v: (r) => r2(r.advance), fmt: MONEY, sum: true, color: (r, v) => (v ? C.bad : C.muted) },
      { h: L('أخرى', 'Other'), w: 12, v: (r) => r2(dedOther(r)), fmt: MONEY, sum: true, color: (r, v) => (v ? C.bad : C.muted) },
      { h: L('إجمالي الاستقطاعات', 'Total deductions'), w: 15, v: (r) => r2(r.deductions), fmt: MONEY, sum: true, bold: true, color: () => C.bad },
      { h: L('الصافي', 'Net'), w: 15, v: (r) => r2(r.net), fmt: MONEY, sum: true, bold: true, color: () => C.ok },
      { h: L('الحالة', 'Status'), w: 18, v: (r) => payStatusLabel(payStatus(r)), align: 'center', bold: true, color: (r) => STATUS_COLOR[payStatus(r)] },
      { h: L('تاريخ التحويل', 'Transfer date'), w: 14, v: (r) => (r.paidAt ? new Date(toMs(r.paidAt)).toISOString().slice(0, 10) : ''), align: 'center' },
      { h: L('ملاحظات', 'Notes'), w: 34, v: (r) => [r.note, ...(r.otherDeductions || []).map(d => `${d.reason || L('خصم', 'Deduction')}: ${d.amount}`)].filter(Boolean).join(' · '), wrap: true }
    ];
    banner(ws, 1, `AL MASTER — ${L('كشف الرواتب التفصيلي', 'Detailed payroll')} · ${monthName}`, cols.length, { size: 15 });
    note(ws, 2, L('كل المبالغ بالجنيه المصري · الإجماليات معادلات تتحدّث لو عدّلت أي رقم · الفلتر شغال على العناوين', 'All amounts in EGP · totals are formulas · filters are on the headers'), cols.length);
    table(ws, 4 - 0, cols, list, { filter: true });
    ws.views = [{ rightToLeft: isAr, showGridLines: false, state: 'frozen', xSplit: 2, ySplit: 4 }];
  }

  // ===== 3. attendance & commitment =====
  {
    const ws = sheet(wb, L('الحضور والالتزام', 'Attendance'), { freeze: { x: 2, y: 4 }, tab: C.ok });
    const a = (r) => r.att || {};
    const cols = [
      { h: '#', w: 5, v: (r, i) => i + 1, fmt: INT, align: 'center' },
      { h: L('الموظف', 'Employee'), w: 26, v: (r) => r.name, bold: true },
      { h: L('القسم', 'Department'), w: 16, v: (r) => r.department || '' },
      { h: L('أيام الخطة', 'Planned days'), w: 12, v: (r) => a(r).planned || 0, fmt: INT, sum: true },
      { h: L('حضور', 'Present'), w: 11, v: (r) => a(r).present || 0, fmt: INT, sum: true },
      { h: L('من المقر', 'Office'), w: 11, v: (r) => a(r).office || 0, fmt: INT, sum: true },
      { h: L('أونلاين', 'Remote'), w: 11, v: (r) => a(r).remote || 0, fmt: INT, sum: true },
      { h: L('غياب', 'Absent'), w: 11, v: (r) => a(r).absent || 0, fmt: INT, sum: true, color: (r, v) => (v ? C.bad : C.text) },
      { h: L('إجازات', 'Leave'), w: 11, v: (r) => a(r).leave || 0, fmt: INT, sum: true },
      { h: L('إجازة بدون أجر', 'Unpaid leave'), w: 13, v: (r) => a(r).unpaidLeave || 0, fmt: INT, sum: true },
      { h: L('أيام تأخير', 'Late days'), w: 11, v: (r) => a(r).lateDays || 0, fmt: INT, sum: true, color: (r, v) => (v ? C.warn : C.text) },
      { h: L('دقائق التأخير', 'Late minutes'), w: 13, v: (r) => a(r).lateMinutes || 0, fmt: INT, sum: true, color: (r, v) => (v ? C.warn : C.text) },
      { h: L('ساعات الشغل (شغل + اجتماعات)', 'Work hours (work + meetings)'), w: 18, v: (r) => hoursOf(a(r).workMs), fmt: HOURS, sum: true },
      { h: L('نسبة الحضور', 'Attendance rate'), w: 13, v: (r) => (a(r).planned ? Math.min(1, (a(r).present || 0) / a(r).planned) : 0), fmt: '0%', color: (r, v) => (v >= 0.9 ? C.ok : (v >= 0.75 ? C.warn : C.bad)) },
      { h: L('غياب بيوم الراتب', 'Absence days priced'), w: 14, v: (r) => r.absenceDays || 0, fmt: INT, sum: true }
    ];
    banner(ws, 1, `AL MASTER — ${L('الحضور والالتزام', 'Attendance & commitment')} · ${monthName}`, cols.length, { size: 15 });
    note(ws, 2, L('الأرقام اللي اتحسب عليها الراتب (وقت حساب الشهر)', 'The numbers the salaries were calculated from (at the time the month was built)'), cols.length);
    table(ws, 4, cols, list, { filter: true });
    ws.views = [{ rightToLeft: isAr, showGridLines: false, state: 'frozen', xSplit: 2, ySplit: 4 }];
  }

  // ===== 4. overtime =====
  {
    const lines = list.flatMap(i => (i.overtimeLines || []).map(o => ({ i, o })));
    const ws = sheet(wb, L('الأوفر تايم', 'Overtime'), { freeze: { x: 0, y: 4 }, tab: C.warn });
    const cols = [
      { h: '#', w: 5, v: (r, k) => k + 1, fmt: INT, align: 'center' },
      { h: L('الموظف', 'Employee'), w: 26, v: (r) => r.i.name, bold: true },
      { h: L('القسم', 'Department'), w: 16, v: (r) => r.i.department || '' },
      { h: L('التاريخ', 'Date'), w: 13, v: (r) => r.o.date || '', align: 'center' },
      { h: L('الساعات', 'Hours'), w: 11, v: (r) => r2(r.o.hours), fmt: HOURS, sum: true },
      { h: L('قيمة الساعة', 'Hour value'), w: 13, v: (r) => r2(r.o.rate), fmt: MONEY },
      { h: L('المعامل', 'Multiplier'), w: 10, v: (r) => Number(r.o.multiplier) || 1, fmt: '0.00' },
      { h: L('المبلغ', 'Amount'), w: 14, v: (r) => r2(r.o.amount), fmt: MONEY, sum: true, bold: true, color: () => C.ok }
    ];
    banner(ws, 1, `AL MASTER — ${L('الأوفر تايم المعتمد', 'Approved overtime')} · ${monthName}`, cols.length, { size: 15 });
    note(ws, 2, L('الأوفر تايم اللي الأدمن اعتمده وبينزل على راتب الشهر', "Overtime the admin approved, added to this month's salary"), cols.length);
    if (lines.length) table(ws, 4, cols, lines, { filter: true });
    else { ws.mergeCells(4, 1, 4, cols.length); const c = ws.getCell(4, 1); c.value = L('مفيش أوفر تايم معتمد في الشهر ده', 'No approved overtime this month'); c.alignment = { horizontal: 'center' }; c.font = { name: FONT, size: 12, color: { argb: C.muted } }; }
    cols.forEach((c, i) => { ws.getColumn(i + 1).width = c.w; });
  }

  // ===== 5. deductions detail =====
  {
    const ws = sheet(wb, L('تفصيل الاستقطاعات', 'Deductions detail'), { freeze: { x: 0, y: 4 }, tab: C.bad });
    const rows = [];
    list.forEach(i => {
      (i.violations || []).forEach(l => rows.push({ i, kind: l.kind === 'late' ? L('تأخير', 'Late') : l.kind === 'absence' ? L('غياب', 'Absence') : l.kind === 'remote' ? L('أونلاين مرفوض', 'Rejected remote') : l.kind === 'early' ? L('انصراف مبكر', 'Early leave') : String(l.kind || ''), date: l.date || '', text: violationText(l), amount: r2(l.total) }));
      if (Number(i.unpaidDeduction) > 0) rows.push({ i, kind: L('إجازة بدون أجر', 'Unpaid leave'), date: '', text: L(`${i.unpaidDays || 0} يوم بدون أجر`, `${i.unpaidDays || 0} unpaid day(s)`), amount: r2(i.unpaidDeduction) });
      if (Number(i.fixed) > 0) rows.push({ i, kind: L('استقطاع ثابت', 'Fixed'), date: '', text: L('استقطاعات ثابتة من هيكل الراتب', 'Fixed deductions from the salary structure'), amount: r2(i.fixed) });
      (i.advanceRefs || []).forEach(a => rows.push({ i, kind: L('قسط سلفة', 'Advance'), date: '', text: L(`قسط من سلفة ${a.total} (${a.count} أقساط)، اتدفع قبل كده ${a.paidBefore}`, `Installment of an advance of ${a.total} (${a.count} installments), ${a.paidBefore} paid before`), amount: r2(a.amount) }));
      (i.otherDeductions || []).forEach(d => rows.push({ i, kind: L('خصم يدوي', 'Manual'), date: '', text: d.reason || '', amount: r2(d.amount) }));
    });
    const cols = [
      { h: '#', w: 5, v: (r, k) => k + 1, fmt: INT, align: 'center' },
      { h: L('الموظف', 'Employee'), w: 26, v: (r) => r.i.name, bold: true },
      { h: L('القسم', 'Department'), w: 16, v: (r) => r.i.department || '' },
      { h: L('النوع', 'Kind'), w: 18, v: (r) => r.kind, align: 'center' },
      { h: L('اليوم', 'Day'), w: 13, v: (r) => r.date, align: 'center' },
      { h: L('التفاصيل', 'Details'), w: 58, v: (r) => r.text, wrap: true },
      { h: L('المبلغ', 'Amount'), w: 14, v: (r) => r.amount, fmt: MONEY, sum: true, bold: true, color: () => C.bad }
    ];
    banner(ws, 1, `AL MASTER — ${L('تفصيل الاستقطاعات', 'Deductions detail')} · ${monthName}`, cols.length, { size: 15 });
    note(ws, 2, L('كل خصم على حدة: اليوم والسبب والمبلغ', 'Every deduction on its own: the day, the reason and the amount'), cols.length);
    if (rows.length) table(ws, 4, cols, rows, { filter: true });
    else { ws.mergeCells(4, 1, 4, cols.length); const c = ws.getCell(4, 1); c.value = L('مفيش استقطاعات في الشهر ده', 'No deductions this month'); c.alignment = { horizontal: 'center' }; c.font = { name: FONT, size: 12, color: { argb: C.muted } }; cols.forEach((x, k) => { ws.getColumn(k + 1).width = x.w; }); }
  }

  // ===== 6. advances =====
  {
    const rows = list.flatMap(i => (i.advanceRefs || []).map(a => ({ i, a })));
    const ws = sheet(wb, L('السلف', 'Advances'), { freeze: { x: 0, y: 4 }, tab: C.warn });
    const cols = [
      { h: '#', w: 5, v: (r, k) => k + 1, fmt: INT, align: 'center' },
      { h: L('الموظف', 'Employee'), w: 26, v: (r) => r.i.name, bold: true },
      { h: L('قيمة السلفة', 'Advance'), w: 14, v: (r) => r2(r.a.total), fmt: MONEY, sum: true },
      { h: L('عدد الأقساط', 'Installments'), w: 12, v: (r) => r.a.count || 0, fmt: INT },
      { h: L('القسط الشهري', 'Per month'), w: 14, v: (r) => r2(r.a.perMonth), fmt: MONEY },
      { h: L('أول شهر', 'First month'), w: 12, v: (r) => r.a.startMonth || '', align: 'center' },
      { h: L('آخر شهر', 'Last month'), w: 12, v: (r) => r.a.endMonth || '', align: 'center' },
      { h: L('اتدفع قبل كده', 'Paid before'), w: 14, v: (r) => r2(r.a.paidBefore), fmt: MONEY, sum: true },
      { h: L('قسط الشهر ده', "This month's"), w: 14, v: (r) => r2(r.a.amount), fmt: MONEY, sum: true, bold: true, color: () => C.bad },
      { h: L('المتبقي بعد الشهر ده', 'Left after this month'), w: 16, v: (r) => r2((Number(r.a.total) || 0) - (Number(r.a.paidBefore) || 0) - (Number(r.a.amount) || 0)), fmt: MONEY, sum: true }
    ];
    banner(ws, 1, `AL MASTER — ${L('السلف الشغالة', 'Active advances')} · ${monthName}`, cols.length, { size: 15 });
    note(ws, 2, L('السلف اللي ليها قسط بيتخصم من رواتب الشهر ده', 'Advances with an installment taken from this month\'s salaries'), cols.length);
    if (rows.length) table(ws, 4, cols, rows, { filter: true });
    else { ws.mergeCells(4, 1, 4, cols.length); const c = ws.getCell(4, 1); c.value = L('مفيش سلف في الشهر ده', 'No advances this month'); c.alignment = { horizontal: 'center' }; c.font = { name: FONT, size: 12, color: { argb: C.muted } }; cols.forEach((x, k) => { ws.getColumn(k + 1).width = x.w; }); }
  }

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `AL-MASTER_Payroll_${month}.xlsx`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast(L('اتنزل تقرير الرواتب', 'Payroll report downloaded'), `${list.length} ${L('موظف', 'employees')}`);
}
