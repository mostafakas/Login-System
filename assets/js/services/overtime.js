// Overtime. Paid overtime comes from the employee's own "overtime card" on the dashboard (no permission needed):
//  - on a day off (weekend, holiday, leave) the normal day is locked and the card is the only way to work;
//  - on a work day the card opens once the shift is ended.
// The card has the same Work / Meeting / Break buttons as a normal day (overtime_days/{email}_{date}); only work +
// meetings count. Ending it files an overtime request for the admin alone; once approved it is paid with that
// month's salary: hours × the value of one hour × the multiplier (1 = same value as in a normal work day).
// Time worked past the shift on the normal counter is NOT paid: the reports split it out for the admin (services/reports.js).
// The value of an hour = full monthly salary ÷ payroll day divisor (30) ÷ hours in a working day.
import { db, doc, col, setDoc, updateDoc, getDoc, watch, list, query, where, serverTimestamp, arrayUnion, settle } from '../core/fb.js';
import { session, now } from '../core/session.js';
import { policy, isWorkingPlan, dayWorkHours, modeLabel, leaveTypeLabel } from '../core/policy.js';
import { L, cairoMs } from '../core/utils.js';
import { salaryParts } from './salary.js';
import { notifyMany } from './notify.js';
import { approversFor } from './requests.js';
import { track } from './activity.js';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const overtimeId = (email, date) => `ot_${email}_${date}`;
export const msToHours = (ms) => r2((Number(ms) || 0) / 3600000);
export const otMultiplier = () => Number(policy.overtimeMultiplier) > 0 ? Number(policy.overtimeMultiplier) : 1;

/** The value of one working hour from the salary: { rate, dayHours, monthly, divisor } */
export function hourValue(priv, email) {
  const monthly = salaryParts(priv || {}).total || 0;
  const divisor = Number(policy.payrollDayDivisor) || 30;
  const dayHours = dayWorkHours(email);
  return { rate: r2(monthly / divisor / dayHours), dayHours, monthly, divisor };
}
/** hours × rate × multiplier */
export const overtimeAmount = (hours, rate, mult = otMultiplier()) => r2((Number(hours) || 0) * (Number(rate) || 0) * mult);

/** Is this plan a day off, so that work on it is overtime? */
export const isOffDay = (plan) => !!plan && !isWorkingPlan(plan) && ['off', 'holiday', 'leave'].includes(plan.mode);
export function offDayLabel(r) {
  if (r.kind === 'after') return L('بعد الشيفت', 'After the shift');
  if (r.dayMode === 'leave') return `${modeLabel('leave')}${r.leaveType ? ` (${leaveTypeLabel(r.leaveType)})` : ''}`;
  if (r.dayMode === 'holiday') return `${modeLabel('holiday')}${r.dayName ? ` — ${r.dayName}` : ''}`;
  return modeLabel(r.dayMode || 'off');
}

// ---------- the overtime card: a second counter next to the normal day (overtime_days/{email}_{date}) ----------
export const OT_STATUSES = ['Online', 'Meeting', 'Break'];
const zeroBank = () => ({ Online: 0, Break: 0, Meeting: 0 });
export const otDocId = (email, date) => `${email}_${date}`;
/** the card's counters at `at`: the saved bank + the time since the last change of a running status */
export function otLive(d, at = now()) {
  const bank = { ...zeroBank(), ...((d && d.bank) || {}) };
  if (d && !d.closed && OT_STATUSES.includes(d.status)) bank[d.status] += Math.max(0, at - (Number(d.lastChangeMs) || at));
  return bank;
}
/** counted overtime: work + meetings, breaks excluded */
export const otWorkMs = (d, at = now()) => { const b = otLive(d, at); return b.Online + b.Meeting; };

/** Watch my own overtime days (a handful per month) */
export const watchMyOT = (cb) => watch(query(col('overtime_days'), where('email', '==', session.email)), cb);
/** Admin: a person's overtime days of a month */
export const monthOT = (email, ym) => list(query(col('overtime_days'), where('email', '==', email)))
  .then(rows => rows.filter(d => (d.date || '').slice(0, 7) === ym).sort((a, b) => a.date.localeCompare(b.date)));

/** Start (or resume) today's overtime. kind: 'off' = a day off, 'after' = after the shift of a work day */
export async function startOT(date, kind, plan) {
  window.dispatchEvent(new Event('am:data-changed'));
  const email = session.email, me = session.profile || {};
  const ref = doc(db, 'overtime_days', otDocId(email, date));
  const cur = await getDoc(ref).then(s => (s.exists() ? s.data() : null)).catch(() => null);
  const at = now();
  const data = cur
    ? { status: 'Online', lastChangeMs: at, endMs: null, closed: false, autoClosed: false, updatedAt: serverTimestamp() }
    : {
      email, name: me.name || email, date, leaderEmail: me.leaderEmail || '', department: me.department || '',
      kind, dayMode: (plan && plan.mode) || 'off', dayName: (plan && plan.name) || '', leaveType: (plan && plan.leaveType) || '',
      status: 'Online', bank: zeroBank(), lastChangeMs: at, startMs: at, endMs: null, closed: false, autoClosed: false, requestId: '', updatedAt: serverTimestamp()
    };
  await settle(setDoc(ref, data, { merge: true }));
}

/** Switch the card between Work / Meeting / Break */
export async function changeOT(d, status) {
  if (!d || d.closed || d.status === status || !OT_STATUSES.includes(status)) return;
  const at = now();
  const bank = otLive(d, at);                 // closes the running segment into the bank
  await settle(updateDoc(doc(db, 'overtime_days', d.id || otDocId(d.email, d.date)), { status, bank, lastChangeMs: at, updatedAt: serverTimestamp() }));
}

/**
 * End the card and file the overtime request for the admin. auto = a forgotten one (from an earlier day):
 * the running segment is counted only up to the end of its day, and the admin sees that it was closed automatically.
 */
export async function endOT(d, { auto = false } = {}) {
  if (!d || d.closed) return null;
  window.dispatchEvent(new Event('am:data-changed'));
  const at = now();
  const cap = auto ? Math.min(at, cairoMs(d.date, '23:59')) : at;
  const bank = { ...zeroBank(), ...(d.bank || {}) };
  if (OT_STATUSES.includes(d.status)) bank[d.status] += Math.max(0, cap - (Number(d.lastChangeMs) || cap));
  const endMs = Math.max(cap, Number(d.startMs) || 0);
  await settle(updateDoc(doc(db, 'overtime_days', d.id || otDocId(d.email, d.date)), { status: 'Offline', bank, lastChangeMs: at, endMs, closed: true, autoClosed: !!auto, requestId: overtimeId(d.email, d.date), updatedAt: serverTimestamp() }));
  return fileOvertime({
    date: d.date, kind: d.kind, plan: { mode: d.dayMode || 'off', name: d.dayName, leaveType: d.leaveType },
    checkInMs: d.startMs, checkOutMs: endMs, workMs: bank.Online + bank.Meeting, autoClosed: !!auto
  });
}

/**
 * File (or bring up to date) the overtime request when the employee ended the overtime card.
 * day = { date, kind, plan, checkInMs, checkOutMs, workMs, autoClosed }. Returns the request, or null when nothing was worked.
 * The request goes to the admin alone (no leader on it). A request that was already decided is left as it is.
 */
export async function fileOvertime(day) {
  if (!day || !(day.workMs > 0)) return null;
  const email = session.email, me = session.profile || {};
  const id = overtimeId(email, day.date);
  const mine = await list(query(col('requests'), where('email', '==', email))).catch(() => []);
  const cur = mine.find(r => r.id === id);
  const hours = msToHours(day.workMs);
  const facts = { workMs: Math.round(day.workMs), hours, checkInMs: day.checkInMs || null, checkOutMs: day.checkOutMs || null, autoClosed: !!day.autoClosed };
  if (cur) {
    if (cur.status !== 'pending_admin') return cur;
    await settle(updateDoc(doc(db, 'requests', id), { ...facts, updatedAt: serverTimestamp(), history: arrayUnion({ at: now(), by: email, byName: me.name || email, action: 'updated', note: L(`${hours} ساعة`, `${hours} h`) }) }));
    return { ...cur, ...facts };
  }
  const req = {
    email, name: me.name || email, leaderEmail: '', department: me.department || '',
    type: 'overtime', kind: day.kind || 'off', startDate: day.date, endDate: day.date, dayMode: day.plan.mode, dayName: day.plan.name || '', leaveType: day.plan.leaveType || '',
    ...facts, multiplier: otMultiplier(),
    reason: day.kind === 'after' ? L('اتقدّم تلقائياً: أوفر تايم بعد الشيفت', 'Filed automatically: overtime after the shift') : L('اتقدّم تلقائياً: أوفر تايم في يوم إجازة', 'Filed automatically: overtime on a day off'),
    status: 'pending_admin', stages: ['admin'], createdMs: now(), createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    history: [{ at: now(), by: email, byName: me.name || email, action: 'submitted', note: '' }]
  };
  await settle(setDoc(doc(db, 'requests', id), req));
  track('request.submit', { target: id, detail: `overtime ${day.date} ${hours}h` });
  notifyMany(approversFor('admin', req), L(`طلب أوفر تايم: ${req.name}`, `Overtime request: ${req.name}`), L(`${hours} ساعة يوم ${day.date}`, `${hours} h on ${day.date}`), '#/approvals', 'request');
  return { id, ...req };
}

/** Overtime lines of a month for payroll, from the approved requests: { date, hours, rate, amount, requestId } */
export function overtimeLines(requests, priv, email) {
  const hv = hourValue(priv, email);
  return (requests || []).filter(r => r.type === 'overtime' && r.status === 'approved' && r.email === email)
    .sort((a, b) => (a.startDate || '').localeCompare(b.startDate || ''))
    .map(r => {
      const hours = Number(r.hours) || msToHours(r.workMs);
      const rate = Number(r.hourlyRate) || hv.rate;
      const mult = Number(r.multiplier) || otMultiplier();
      return { date: r.startDate, hours, rate, multiplier: mult, amount: r.amount != null ? r2(r.amount) : overtimeAmount(hours, rate, mult), requestId: r.id };
    });
}
