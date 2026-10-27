// Overtime: working on a day off (weekend, public holiday or an approved leave day) files an overtime request
// when the day ends. The admin approves or rejects it; an approved one is paid with that month's salary:
// hours worked (work + meetings, breaks excluded) × the value of one hour × the overtime multiplier.
// The value of an hour = full monthly salary ÷ payroll day divisor (30) ÷ hours in a working day.
import { db, doc, col, setDoc, updateDoc, list, query, where, serverTimestamp, arrayUnion, settle } from '../core/fb.js';
import { session, now } from '../core/session.js';
import { policy, isWorkingPlan, dayWorkHours, modeLabel, leaveTypeLabel } from '../core/policy.js';
import { L } from '../core/utils.js';
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
  if (r.dayMode === 'leave') return `${modeLabel('leave')}${r.leaveType ? ` (${leaveTypeLabel(r.leaveType)})` : ''}`;
  if (r.dayMode === 'holiday') return `${modeLabel('holiday')}${r.dayName ? ` — ${r.dayName}` : ''}`;
  return modeLabel(r.dayMode || 'off');
}

/**
 * File (or bring up to date) today's overtime request after the employee ended a day off.
 * day = { date, plan, checkInMs, checkOutMs, workMs }. Returns the request, or null when nothing was worked.
 * A request that was already decided is left as it is.
 */
export async function fileOvertime(day) {
  if (!day || !isOffDay(day.plan) || !(day.workMs > 0)) return null;
  const email = session.email, me = session.profile || {};
  const id = overtimeId(email, day.date);
  const mine = await list(query(col('requests'), where('email', '==', email))).catch(() => []);
  const cur = mine.find(r => r.id === id);
  const hours = msToHours(day.workMs);
  const facts = { workMs: Math.round(day.workMs), hours, checkInMs: day.checkInMs || null, checkOutMs: day.checkOutMs || null };
  if (cur) {
    if (cur.status !== 'pending_admin') return cur;
    await settle(updateDoc(doc(db, 'requests', id), { ...facts, updatedAt: serverTimestamp(), history: arrayUnion({ at: now(), by: email, byName: me.name || email, action: 'updated', note: L(`${hours} ساعة`, `${hours} h`) }) }));
    return { ...cur, ...facts };
  }
  const req = {
    email, name: me.name || email, leaderEmail: me.leaderEmail || '', department: me.department || '',
    type: 'overtime', startDate: day.date, endDate: day.date, dayMode: day.plan.mode, dayName: day.plan.name || '', leaveType: day.plan.leaveType || '',
    ...facts, multiplier: otMultiplier(),
    reason: L('اتقدّم تلقائياً: شغل في يوم إجازة', 'Filed automatically: work on a day off'),
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
