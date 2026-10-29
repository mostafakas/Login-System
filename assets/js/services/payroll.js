// Payroll: monthly run computed from salary data + attendance + advances, with manual adjustments.
// Each employee's salary then moves through: pending → approved (admin) → paid (transfer receipt attached,
// accountant or admin) → sent (payslip published to the employee). Admins may move a salary to any status.
import { db, doc, col, list, query, where, read, writeBatch, serverTimestamp, setDoc, updateDoc, runTransaction, arrayUnion, deleteDoc } from '../core/fb.js';
import { session, now, isAdmin } from '../core/session.js';
import { policy } from '../core/policy.js';
import { fmtMonth, ymd, L, imageToDataUrl } from '../core/utils.js';
import { userError } from '../core/ui.js';
import { driveUpload, driveDownload } from './files.js';
import { activePeople, person } from './directory.js';
import { teamMonth } from './reports.js';
import { notify } from './notify.js';
import { track } from './activity.js';
import { payParts, isFreelancer, rulesOf, violationsFrom, priceViolations } from './salary.js';
import { evalSettings, evalId } from './evaluations.js';
import { overtimeLines, hourValue, overtimeAmount, otMultiplier, msToHours, fmtHMS } from './overtime.js';
import { advancePlan } from './requests.js';

export const itemId = (month, email) => `${month}_${email}`;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ---------- statuses ----------
export const PAY_ORDER = ['pending', 'approved', 'paid', 'sent'];
export const PAY_STATUS = {
  pending: { ar: 'انتظار', en: 'Pending', cls: 'pending', icon: 'fa-hourglass-half' },
  approved: { ar: 'معتمد', en: 'Approved', cls: 'approved', icon: 'fa-circle-check' },
  paid: { ar: 'تم تحويل الراتب', en: 'Salary transferred', cls: 'paid', icon: 'fa-money-bill-transfer' },
  sent: { ar: 'تم إرسال القسيمة', en: 'Payslip sent', cls: 'sent', icon: 'fa-paper-plane' }
};
export const payStatus = (i) => (i && PAY_ORDER.includes(i.status) ? i.status : 'pending');
export const payStatusLabel = (s) => L(PAY_STATUS[s].ar, PAY_STATUS[s].en);
/** Statuses the signed-in user may move this salary to (admins: any; accountant: the next step after approval) */
export function allowedMoves(i) {
  const cur = payStatus(i);
  if (isAdmin()) return PAY_ORDER.filter(s => s !== cur);
  if (!i || i.email === session.email) return [];
  if (cur === 'approved') return ['paid'];
  if (cur === 'paid') return ['sent'];
  return [];
}

// ---------- calculation ----------
/**
 * One salary. `violations` are the month's raw attendance violations (services/salary.violationsFrom), priced
 * with the employee's own rules. `manual` carries bonus / incentive / other deductions / note and this month's
 * KPI ({ kpiMode: 'pct'|'amt', kpiValue }; empty = the full KPI).
 * A freelancer is paid the full agreed salary: attendance (absence, lateness, unpaid leave…) is not priced and
 * nothing is split into allowances; only advances and the admin's own bonus / deductions apply.
 * `overtime` = the month's approved overtime (services/overtime.overtimeLines), added to the gross.
 */
export function computeItem({ person: p, priv, totals, violations = [], advances, manual = {}, overtime = [] }) {
  const freelancer = isFreelancer(priv);
  const parts = payParts(priv);
  const rules = rulesOf(priv);
  const divisor = Number(policy.payrollDayDivisor) || 30;
  const priced = priceViolations(freelancer ? [] : violations, parts, rules, divisor);
  // KPI of the month: admin-set % or amount, otherwise paid in full
  const kpiMode = !freelancer && (manual.kpiMode === 'pct' || manual.kpiMode === 'amt') ? manual.kpiMode : '';
  const kpiValue = kpiMode ? Number(manual.kpiValue) || 0 : null;
  const kpi = r2(kpiMode === 'pct' ? parts.kpi * kpiValue / 100 : (kpiMode === 'amt' ? kpiValue : parts.kpi));
  // unpaid leave: the day's basic, from what is left of the basic after absences
  const unpaidDays = totals && !freelancer ? totals.unpaidLeave || 0 : 0;
  const unpaid = r2(Math.min(unpaidDays * parts.basic / divisor, priced.left.basic));
  const advance = advances.reduce((s, a) => s + a.installment, 0);
  const other = (manual.otherDeductions || []).reduce((s, d) => s + (Number(d.amount) || 0), 0);
  const bonus = Number(manual.bonus) || 0, incentive = Number(manual.incentive) || 0;
  const fixed = parts.fixed;
  const overtimeTotal = r2(overtime.reduce((s, o) => s + (Number(o.amount) || 0), 0));
  const violationTotal = r2(priced.byPart.basic + priced.byPart.allowances + priced.byPart.regularity);
  const gross = r2(parts.basic + parts.allowances + parts.regularity + kpi + bonus + incentive + overtimeTotal);
  const deductions = r2(fixed + violationTotal + unpaid + advance + other);
  const bank = String((priv && priv.bank) || '').replace(/\s/g, '');
  const payTo = (priv && priv.instapay) ? 'InstaPay' : (bank ? `${L('حساب بنكي', 'Bank account')} •••${bank.slice(-4)}` : '');
  return {
    email: p.email, name: p.name || p.email, title: p.title || '', department: p.department || '', hireDate: p.hireDate || '', payTo,
    structured: parts.structured, totalSalary: parts.total, freelancer,
    basic: parts.basic, allowances: parts.allowances, regularity: parts.regularity, kpiFull: parts.kpi, kpi, kpiMode, kpiValue,
    allowanceLines: [], bonus, incentive, fixed,
    overtime: overtimeTotal, overtimeLines: overtime, overtimeHours: r2(overtime.reduce((s, o) => s + (Number(o.hours) || 0), 0)),
    violations: priced.lines, deductionByPart: priced.byPart,
    lateDeduction: priced.byKind.late, absenceDeduction: priced.byKind.absence, remoteDeduction: priced.byKind.remote, earlyDeduction: priced.byKind.early,
    absenceDays: violations.filter(v => v.kind === 'absence').length, unpaidDays, unpaidDeduction: unpaid,
    lateDays: violations.filter(v => v.kind === 'late').length, lateMinutes: totals ? totals.lateMinutes : 0, presentDays: totals ? totals.present : 0,
    advance: r2(advance),
    // enough about each advance to explain the installment on the payslip ("installment 2 of 5 — 6,000 left")
    advanceRefs: advances.map(a => ({ id: a.id, amount: a.installment, total: Number(a.amount) || 0, paidBefore: Number(a.paid) || 0, count: Number(a.installments) || 0, perMonth: Number(a.perMonth) || a.installment, startMonth: a.startMonth || '', endMonth: a.endMonth || '' })),
    otherDeductions: manual.otherDeductions || [], note: manual.note || '',
    gross, deductions, net: r2(gross - deductions), dayRate: r2(parts.basic / divisor),
    att: totals ? {
      absent: totals.absent || 0, unpaidLeave: totals.unpaidLeave || 0, lateMinutes: totals.lateMinutes || 0,
      lateDays: totals.lateDays || 0, present: totals.present || 0, office: totals.office || 0, remote: totals.remote || 0, leave: totals.leave || 0,
      planned: totals.planned || 0, workMs: (totals.workMs || 0) + (totals.meetingMs || 0),   // work + meetings, breaks excluded
      violations // raw, so a later edit (bonus, KPI…) re-prices them with the current salary and rules
    } : null
  };
}

export async function activeAdvances(month) {
  const all = await list(query(col('advances'), where('status', '==', 'active'))).catch(() => []);
  return all.filter(a => (a.startMonth || '') <= month).map(a => {
    const left = r2((Number(a.amount) || 0) - (Number(a.paid) || 0));
    const per = Number(a.perMonth) || left;
    // the last installment takes the rounding remainder (1,000 in 3 → 333.33, 333.33, 333.34)
    return { ...a, installment: r2(left - per < 1 ? left : per) };
  }).filter(a => a.installment > 0);
}

/** Build (or rebuild) the month. Only salaries still "pending" are recalculated; manual fields are kept. */
export async function buildRun(month) {
  if (!isAdmin()) throw userError('إعادة الحساب للأدمن بس.', 'Only admins can recalculate payroll.');
  const run = await read('payroll_runs', month);
  if (run && run.status === 'closed') throw userError('ده أرشيف رواتب من السيستم القديم ومينفعش يتحسب تاني.', 'This is a legacy payroll archive and cannot be recalculated.');
  const people = activePeople().filter(p => !p.isSuspended);
  const [privs, existing, att, advs] = await Promise.all([
    list(col('employees_private')), list(query(col('payroll_items'), where('month', '==', month))),
    teamMonth(month, { people }), activeAdvances(month)
  ]);
  // optional (Settings → Reviews): the KPI part = the grade's share of the variable, once the month's review is sent —
  // unless the admin set the KPI by hand
  const link = !!evalSettings().salaryLink;
  const evals = link ? await list(query(col('evaluations'), where('month', '==', month))).catch(() => []) : [];
  const kpiFromReview = (email) => {
    const ev = evals.find(e => e.id === evalId(email, month) && e.sent);
    return ev && ev.variable != null ? Math.max(0, Math.min(100, Number(ev.variable))) : null;
  };
  const b = writeBatch(db);
  let count = 0;
  for (const p of people) {
    const priv = privs.find(x => x.id === p.email) || {};
    const old = existing.find(x => x.email === p.email) || {};
    if (old.status && payStatus(old) !== 'pending') continue; // approved / transferred / sent are frozen
    const pm = att.people.find(x => x.person.email === p.email) || {};
    const violations = pm.rows ? violationsFrom(pm.rows, pm.requests) : [];
    let manual = old;
    if (!old.kpiMode || old.kpiFromReview) {
      const k = link ? kpiFromReview(p.email) : null;
      if (k != null) manual = { ...old, kpiMode: 'pct', kpiValue: k };
      else if (old.kpiFromReview) manual = { ...old, kpiMode: '', kpiValue: null };     // the link was switched off / no review any more
    }
    const overtime = overtimeLines(pm.requests, priv, p.email);
    const item = computeItem({ person: p, priv, totals: pm.totals, violations, advances: advs.filter(a => a.email === p.email), manual, overtime });
    b.set(doc(db, 'payroll_items', itemId(month, p.email)), { ...item, kpiFromReview: manual !== old ? manual.kpiMode === 'pct' : !!old.kpiFromReview && !!old.kpiMode, month, status: 'pending', published: false, updatedAt: serverTimestamp() });
    count++;
  }
  b.set(doc(db, 'payroll_runs', month), { month, status: 'draft', builtBy: session.email, builtAt: serverTimestamp() }, { merge: true });
  await b.commit();
  track('payroll.build', { target: month, detail: `${count}` });
}

export async function saveManual(month, email, manual) {
  if (!isAdmin()) throw userError('تعديل الراتب للأدمن بس.', 'Only admins can adjust salaries.');
  const it = await read('payroll_items', itemId(month, email));
  if (['paid', 'sent'].includes(payStatus(it))) throw userError('الراتب ده اتحوّل بالفعل. رجّعه «معتمد» الأول عشان تعدّله.', 'This salary was already transferred. Move it back to "Approved" to edit it.');
  const p = person(email) || { email, name: it.name };
  const priv = await read('employees_private', email).catch(() => ({})) || {};
  const totals = it.att || null; // attendance numbers captured when the run was built
  const advances = (it.advanceRefs || []).map(a => ({ id: a.id, installment: a.amount, amount: a.total, paid: a.paidBefore, installments: a.count, perMonth: a.perMonth, startMonth: a.startMonth, endMonth: a.endMonth }));
  const next = computeItem({ person: p, priv, totals, violations: (it.att && it.att.violations) || [], advances, manual, overtime: it.overtimeLines || [] });
  // a KPI changed by hand is the admin's from now on (no longer follows the review)
  const fromReview = !!it.kpiFromReview && next.kpiMode === it.kpiMode && Number(next.kpiValue) === Number(it.kpiValue);
  await updateDoc(doc(db, 'payroll_items', itemId(month, email)), { ...next, kpiFromReview: fromReview, updatedAt: serverTimestamp(), editedBy: session.email });
}

// ---------- transfer receipt (Google Drive through the Apps Script service; Firestore chunks as a fallback) ----------
export const MAX_PROOF = 5 * 1024 * 1024;
const CHUNK = 700000;
const readAsDataUrl = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });

async function uploadProof(item, file, note, onProgress) {
  if (!file) throw userError('ارفق إيصال التحويل (صورة أو ملف).', 'Attach the transfer receipt (image or file).');
  const isImg = /^image\/(png|jpe?g|webp|bmp)$/i.test(file.type);
  let dataUrl, mime = file.type || 'application/octet-stream', thumb = '';
  if (isImg) {
    dataUrl = await imageToDataUrl(file, 1800, 0.85);
    thumb = await imageToDataUrl(file, 360, 0.7);
    mime = 'image/jpeg';
  } else {
    if (file.size > MAX_PROOF) throw userError('الملف أكبر من 5 ميجا.', 'The file is larger than 5 MB.');
    dataUrl = await readAsDataUrl(file);
  }
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const size = Math.round(b64.length * 0.75);
  if (size > MAX_PROOF) throw userError('الملف أكبر من 5 ميجا.', 'The file is larger than 5 MB.');
  const pref = doc(col('payroll_proofs'));
  const name = String(file.name || (isImg ? 'receipt.jpg' : 'receipt')).slice(0, 180);
  onProgress && onProgress(0.15);
  const driveId = await driveUpload('payroll', item.id, { b64, name, mime });
  if (driveId) {
    await setDoc(pref, { itemId: item.id, email: item.email, month: item.month, by: session.email, name, mime, size, chunks: 0, driveId, at: serverTimestamp() });
    onProgress && onProgress(1);
    return { id: pref.id, name, mime, size, drive: true, ...(thumb ? { thumb } : {}), note: String(note || '').trim().slice(0, 300) };
  }
  const chunks = Math.ceil(b64.length / CHUNK) || 1;
  await setDoc(pref, { itemId: item.id, email: item.email, month: item.month, by: session.email, name, mime, size, chunks, at: serverTimestamp() });
  for (let i = 0; i < chunks; i++) {
    await setDoc(doc(db, `payroll_proofs/${pref.id}/chunks`, String(i)), { i, data: b64.slice(i * CHUNK, (i + 1) * CHUNK) });
    onProgress && onProgress((i + 1) / chunks);
  }
  return { id: pref.id, name, mime, size, ...(thumb ? { thumb } : {}), note: String(note || '').trim().slice(0, 300) };
}
const proofCache = new Map();
/** The receipt as an object URL */
export async function loadProof(meta) {
  if (proofCache.has(meta.id)) return proofCache.get(meta.id);
  if (meta.drive) { const u = await driveDownload('payroll', meta.id, meta.mime); proofCache.set(meta.id, u); return u; }
  const info = await read('payroll_proofs', meta.id);
  if (!info) throw userError('الإيصال مش موجود.', 'Receipt not found.');
  if (info.driveId) { const u = await driveDownload('payroll', meta.id, info.mime || meta.mime); proofCache.set(meta.id, u); return u; }
  const parts = await list(col(`payroll_proofs/${meta.id}/chunks`));
  const b64 = parts.sort((a, b) => Number(a.i ?? a.id) - Number(b.i ?? b.id)).map(p => p.data).join('');
  const bin = atob(b64); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([arr], { type: info.mime || meta.mime }));
  proofCache.set(meta.id, url);
  return url;
}

// ---------- status changes ----------
const treasuryIdOf = (item) => `salary_${item.id}`;

/** Transfer: receipt + treasury entry + advance installments, all at once. */
async function payItem(item, { file, note, onProgress }) {
  const proof = await uploadProof(item, file, note, onProgress);
  await runTransaction(db, async (tx) => {
    const ref = doc(db, 'payroll_items', item.id);
    const snap = await tx.get(ref);
    const cur = snap.data();
    if (!cur) throw userError('الراتب مش موجود.', 'Salary not found.');
    if (['paid', 'sent'].includes(payStatus(cur))) throw userError('الراتب ده اتسجل تحويله بالفعل.', 'This salary was already transferred.');
    const advSnaps = [];
    for (const a of (cur.advanceRefs || [])) advSnaps.push([a, await tx.get(doc(db, 'advances', a.id))]);
    const advancePaid = [];
    advSnaps.forEach(([a, s]) => {
      if (!s.exists()) return;
      const d = s.data(); const paid = r2((Number(d.paid) || 0) + a.amount);
      tx.update(doc(db, 'advances', a.id), { paid, status: paid >= Number(d.amount) - 0.01 ? 'settled' : 'active', updatedAt: serverTimestamp() });
      advancePaid.push({ id: a.id, amount: a.amount });
    });
    tx.set(doc(db, 'treasury', treasuryIdOf(item)), { type: 'salary', amount: cur.net, title: `راتب ${fmtMonth(cur.month)} — ${cur.name}`, email: cur.email, month: cur.month, date: ymd(now()), by: session.email, at: serverTimestamp() });
    const upd = { status: 'paid', paidAt: serverTimestamp(), paidBy: session.email, proof, treasuryId: treasuryIdOf(item), advancePaid, updatedAt: serverTimestamp() };
    if (payStatus(cur) === 'pending') Object.assign(upd, { approvedAt: serverTimestamp(), approvedBy: session.email }); // admin skipping ahead
    tx.update(ref, upd);
  });
}

/** Admin: undo a transfer (treasury entry removed, advance installments returned). */
async function unpayItem(item) {
  let legacy = false;
  await runTransaction(db, async (tx) => {
    const ref = doc(db, 'payroll_items', item.id);
    const cur = (await tx.get(ref)).data();
    const advSnaps = [];
    for (const a of (cur.advancePaid || [])) advSnaps.push([a, await tx.get(doc(db, 'advances', a.id))]);
    advSnaps.forEach(([a, s]) => {
      if (!s.exists()) return;
      const paid = Math.max(0, r2((Number(s.data().paid) || 0) - a.amount));
      tx.update(doc(db, 'advances', a.id), { paid, status: 'active', updatedAt: serverTimestamp() });
    });
    if (cur.treasuryId) tx.delete(doc(db, 'treasury', cur.treasuryId)); else legacy = true;
    tx.update(ref, { status: 'approved', published: false, paidAt: null, paidBy: '', proof: null, treasuryId: '', advancePaid: [], sentAt: null, sentBy: '', updatedAt: serverTimestamp() });
  });
  return legacy;
}

/**
 * Move one salary to `target`. Reaching "paid" from before needs { file, note } (the transfer receipt).
 * Returns { legacyTreasury } when an old-system payment had no treasury link to undo.
 */
export async function setPayStatus(item, target, opts = {}) {
  const cur = payStatus(item);
  if (target === cur) return {};
  if (!allowedMoves(item).includes(target)) throw userError('مش مسموح لك تغيّر الحالة دي.', 'You are not allowed to make this change.');
  const ci = PAY_ORDER.indexOf(cur), ti = PAY_ORDER.indexOf(target);
  const ref = doc(db, 'payroll_items', item.id);
  let legacyTreasury = false;
  if (ci < 2 && ti >= 2) await payItem(item, opts);
  if (ci >= 2 && ti < 2) legacyTreasury = await unpayItem(item);
  if (target === 'pending' || target === 'approved') {
    await updateDoc(ref, { status: target, published: false, ...(target === 'approved' ? { approvedAt: serverTimestamp(), approvedBy: session.email } : {}), updatedAt: serverTimestamp() });
  } else if (target === 'sent') {
    await updateDoc(ref, { status: 'sent', published: true, sentAt: serverTimestamp(), sentBy: session.email, updatedAt: serverTimestamp() });
    notify(item.email, `قسيمة راتب ${fmtMonth(item.month)} وصلت`, `صافي الراتب ${item.net}`, '#/payslips', 'approved');
  } else if (target === 'paid' && ci === 3) {
    await updateDoc(ref, { status: 'paid', published: false, sentAt: null, sentBy: '', updatedAt: serverTimestamp() });
  }
  track('payroll.status', { target: item.email, detail: `${item.month}: ${PAY_STATUS[cur].ar} → ${PAY_STATUS[target].ar}` });
  return { legacyTreasury };
}

/** Advance paid out in cash from treasury (when finance approves an advance request) */
export async function recordAdvancePayout(adv) {
  await setDoc(doc(db, 'treasury', `advance_${adv.id}`), { type: 'advance', amount: adv.amount, title: `سلفة — ${adv.name || adv.email}`, email: adv.email, month: ymd(now()).slice(0, 7), date: ymd(now()), by: session.email, at: serverTimestamp() });
  await updateDoc(doc(db, 'advances', adv.id), { paidOut: true });
}

/**
 * Admin: change an active advance — the amount, the number of installments, the first month, how much was already
 * repaid, and (when it was paid out of the treasury) the payout date. The treasury entry follows the new amount / date.
 * Salaries that are still pending pick the new installment up on the next "Recalculate".
 */
export async function updateAdvance(adv, f) {
  if (!isAdmin()) throw userError('تعديل السلف للأدمن بس.', 'Only admins can edit advances.');
  const plan = advancePlan(f.amount, Math.min(60, Number(f.installments) || 1), f.startMonth);
  const paid = r2(f.paid);
  if (!(plan.amount > 0)) throw userError('اكتب مبلغ صحيح.', 'Enter a valid amount.');
  if (!/^\d{4}-\d{2}$/.test(plan.startMonth || '')) throw userError('اختار أول شهر خصم.', 'Pick the first deduction month.');
  if (paid < 0 || paid > plan.amount + 0.005) throw userError('المسدّد لازم يكون بين صفر ومبلغ السلفة.', 'Repaid must be between 0 and the advance amount.');
  if (f.payoutDate && !/^\d{4}-\d{2}-\d{2}$/.test(f.payoutDate)) throw userError('تاريخ الصرف مش صحيح.', 'The payout date is not valid.');
  const changes = [
    plan.amount !== r2(adv.amount) ? L(`المبلغ ${adv.amount} ← ${plan.amount}`, `amount ${adv.amount} → ${plan.amount}`) : '',
    plan.installments !== Number(adv.installments) ? L(`الأقساط ${adv.installments} ← ${plan.installments}`, `installments ${adv.installments} → ${plan.installments}`) : '',
    plan.startMonth !== adv.startMonth ? L(`أول شهر ${adv.startMonth || '—'} ← ${plan.startMonth}`, `first month ${adv.startMonth || '—'} → ${plan.startMonth}`) : '',
    paid !== r2(adv.paid) ? L(`المسدد ${r2(adv.paid)} ← ${paid}`, `repaid ${r2(adv.paid)} → ${paid}`) : '',
    f.payoutDate && f.payoutDate !== (adv.payoutDate || '') ? L(`تاريخ الصرف ${adv.payoutDate || '—'} ← ${f.payoutDate}`, `payout date ${adv.payoutDate || '—'} → ${f.payoutDate}`) : ''
  ].filter(Boolean);
  if (!changes.length) return false;
  await updateDoc(doc(db, 'advances', adv.id), {
    amount: plan.amount, installments: plan.installments, perMonth: plan.perMonth, startMonth: plan.startMonth, endMonth: plan.endMonth, paid,
    ...(f.payoutDate ? { payoutDate: f.payoutDate } : {}), updatedAt: serverTimestamp(), editedBy: session.email,
    edits: arrayUnion({ at: now(), by: session.email, note: changes.join(' · ') })
  });
  // paid out of the treasury already: the entry follows the new amount / date
  if (adv.paidOut) {
    const t = { amount: plan.amount };
    if (f.payoutDate) { t.date = f.payoutDate; t.month = f.payoutDate.slice(0, 7); }
    await updateDoc(doc(db, 'treasury', `advance_${adv.id}`), t).catch(e => console.warn('[advance treasury]', e && e.message));
  }
  track('advance.edit', { target: adv.email || adv.name, detail: changes.join(' · ') });
  return true;
}

// ---------- overtime the admin registers by hand ----------
// An approved overtime request (kind 'manual') for the employee: it is paid with that month's salary like any approved
// overtime, shows on the payslip and in the Excel report, and the employee sees it in "My requests".
const advRefsOf = (it) => (it.advanceRefs || []).map(a => ({ id: a.id, installment: a.amount, amount: a.total, paid: a.paidBefore, installments: a.count, perMonth: a.perMonth, startMonth: a.startMonth, endMonth: a.endMonth }));
/** Re-price this month's salary of one employee with the overtime now approved (frozen salaries — transferred / sent — are left alone) */
async function refreshItemOvertime(month, email) {
  const it = await read('payroll_items', itemId(month, email)).catch(() => null);
  if (!it) return 'none';
  if (['paid', 'sent'].includes(payStatus(it))) return 'frozen';
  const [reqs, priv] = await Promise.all([list(query(col('requests'), where('email', '==', email))).catch(() => []), read('employees_private', email).catch(() => null)]);
  const lines = overtimeLines(reqs.filter(r => (r.startDate || '').slice(0, 7) === month), priv || {}, email);
  const p = person(email) || { email, name: it.name };
  const next = computeItem({ person: p, priv: priv || {}, totals: it.att || null, violations: (it.att && it.att.violations) || [], advances: advRefsOf(it), manual: it, overtime: lines });
  await updateDoc(doc(db, 'payroll_items', itemId(month, email)), { ...next, kpiFromReview: !!it.kpiFromReview, updatedAt: serverTimestamp(), editedBy: session.email });
  return 'updated';
}
/** Admin: register overtime { email, date, ms, note } → { state: 'updated' | 'none' | 'frozen', amount } */
export async function addManualOvertime({ email, date, ms, note = '' }) {
  if (!isAdmin()) throw userError('تسجيل الأوفر تايم للأدمن بس.', 'Only admins can register overtime.');
  const t = Math.round((Number(ms) || 0) / 1000) * 1000;
  if (!person(email)) throw userError('اختار الموظف.', 'Pick the employee.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw userError('اختار اليوم.', 'Pick the day.');
  if (!(t >= 60000) || t > 24 * 3600000) throw userError('اكتب وقت من دقيقة لـ 24 ساعة.', 'Enter a time between 1 minute and 24 hours.');
  const priv = await read('employees_private', email).catch(() => null);
  if (!priv) throw userError('مفيش بيانات راتب للموظف ده، فمينفعش يتحسب له مبلغ.', 'This employee has no salary data, so no amount can be worked out.');
  const p = person(email), hv = hourValue(priv, email), hours = msToHours(t), mult = otMultiplier();
  const amount = overtimeAmount(hours, hv.rate, mult);
  const id = `ot_manual_${email}_${Date.now().toString(36)}`;
  const by = (session.profile && session.profile.name) || session.email;
  await setDoc(doc(db, 'requests', id), {
    email, name: p.name || email, leaderEmail: '', department: p.department || '',
    type: 'overtime', kind: 'manual', startDate: date, endDate: date, taskTitle: String(note || '').trim().slice(0, 200) || L('أوفر تايم مسجّل بواسطة الأدمن', 'Overtime registered by the admin'),
    assignedBy: session.email, assignedByName: by, workMs: t, actualMs: t, payMs: t, allotMs: 0, actualHours: hours, hours,
    hourlyRate: hv.rate, dayHours: hv.dayHours, multiplier: mult, amount,
    reason: String(note || '').trim().slice(0, 500) || L('أوفر تايم مسجّل بواسطة الأدمن', 'Overtime registered by the admin'),
    status: 'approved', stages: ['admin'], approvedBy: session.email, approvedAt: serverTimestamp(), decidedBy: session.email, createdMs: now(), createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    history: [{ at: now(), by: session.email, byName: by, action: 'approved_admin', note: L('سجّله الأدمن واعتمده', 'Registered and approved by the admin') }]
  });
  const state = await refreshItemOvertime(date.slice(0, 7), email);
  notify(email, L('اتسجّل لك أوفر تايم', 'Overtime was registered for you'), `${fmtHMS(t)} · ${date} = ${amount} ${L('ج.م', 'EGP')}`, '#/requests', 'approved');
  track('overtime.manual', { target: email, detail: `${date} ${fmtHMS(t)} = ${amount}` });
  return { state, amount };
}
/** the overtime registered by hand for a month (newest first) */
export const manualOvertimeOf = (month) => list(query(col('requests'), where('type', '==', 'overtime')))
  .then(rows => rows.filter(r => r.kind === 'manual' && (r.startDate || '').slice(0, 7) === month).sort((a, b) => (b.createdMs || 0) - (a.createdMs || 0)));
/** Admin: delete one of them (a wrong entry) and re-price the salary */
export async function removeManualOvertime(r) {
  if (!isAdmin()) throw userError('الحذف للأدمن بس.', 'Only admins can delete this.');
  if (r.kind !== 'manual') throw userError('ده مش أوفر تايم مسجّل يدوياً.', 'This is not a manually registered overtime.');
  await deleteDoc(doc(db, 'requests', r.id));
  const state = await refreshItemOvertime((r.startDate || '').slice(0, 7), r.email);
  track('overtime.manual.delete', { target: r.email, detail: `${r.startDate} ${fmtHMS(r.workMs)}` });
  return state;
}