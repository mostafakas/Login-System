// Overtime = an assigned task with allotted time. Nobody starts overtime on their own:
//  1. a leader (for their team), the admin or a project manager gives an employee an overtime task: all the task's
//     details + the days and the hours of each day (createOvertimeTask). It is a normal task (tasks/{id}) with an `ot` map,
//     so it shows in the Tasks page for the employee, the leader, project managers and the admin.
//  2. the employee gets it as an offer on the dashboard and accepts or declines it (respondOT).
//  3. once accepted, the dashboard shows an overtime card for it: Work / Meeting / Break buttons like a normal day, a
//     counter for work + meetings and another for breaks (overtime_days/{email}_{taskId}_{date}); only work + meetings count.
//  4. when the employee finishes the task, one request goes to the admin alone (finishOTTask): what the leader allotted
//     and what the employee really took. The admin approves the allotted hours only, all the time taken, or any number
//     of hours in between; the amount then goes to that month's salary: hours × the value of one hour × the multiplier
//     (1 = the same value as in a normal work day).
// Time worked past the shift on the normal counter is NOT paid: the reports split it out for the admin (services/reports.js).
// The value of an hour = full monthly salary ÷ payroll day divisor (30) ÷ hours in a working day.
import { db, doc, col, setDoc, updateDoc, getDoc, watch, list, query, where, serverTimestamp, arrayUnion, settle } from '../core/fb.js';
import { session, now } from '../core/session.js';
import { policy, isWorkingPlan, dayWorkHours } from '../core/policy.js';
import { L, cairoMs } from '../core/utils.js';
import { userError } from '../core/ui.js';
import { salaryParts } from './salary.js';
import { notify, notifyMany } from './notify.js';
import { approversFor } from './requests.js';
import { createTasks, taskLink } from './tasks.js';
import { nameOf } from './directory.js';
import { track } from './activity.js';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
/** the request of an overtime task (one per task and employee) */
export const overtimeId = (email, taskId) => `ot_${email}_${taskId}`;
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
export const msToHours = (ms) => r4((Number(ms) || 0) / 3600000);
/** 3 725 000 ms → "1 س 2 د 5 ث" (hours, minutes and seconds; zero parts left out) */
export function fmtHMS(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  const parts = [h ? `${h} ${L('س', 'h')}` : '', m ? `${m} ${L('د', 'm')}` : '', x || !s ? `${x} ${L('ث', 's')}` : ''].filter(Boolean);
  return parts.join(' ');
}
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

// ---------- the overtime task ----------
export const isOTTask = (t) => !!t && !!t.ot && typeof t.ot === 'object';
export const OT_STATE = {
  offered: { ar: 'مستني ردك', en: 'Waiting for a reply', cls: 'warn' },
  accepted: { ar: 'شغال', en: 'Accepted', cls: 'ok' },
  submitted: { ar: 'عند الليدر للمراجعة', en: 'With the leader for review', cls: 'info' },
  declined: { ar: 'اتعذر', en: 'Declined', cls: 'bad' },
  done: { ar: 'خلص', en: 'Done', cls: 'info' }
};
/** the time allotted to a planned day (ms; older plans had hours) */
export const dayMs = (d) => (Number(d && d.ms) > 0 ? Number(d.ms) : Math.round((Number(d && d.hours) || 0) * 3600000));
export const otPlanMs = (plan) => (plan || []).reduce((s, d) => s + dayMs(d), 0);
export const otPlanHours = (plan) => msToHours(otPlanMs(plan));
const planDay = (t, date) => ((t && t.ot && t.ot.plan) || []).find(d => d.date === date) || null;
export const otPlanDay = planDay;

/**
 * Leader / project manager / admin: give `assignee` an overtime task. plan = [{ date: 'YYYY-MM-DD', hours }] — the days
 * it is worked on and the hours of each. fields = the usual task fields (title, details, priority, project…).
 */
export async function createOvertimeTask(fields, assignee, plan) {
  const days = [];
  (plan || []).forEach(d => {
    const ms = Math.round(dayMs(d) / 1000) * 1000;
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(d && d.date)) && ms >= 1000 && ms <= 16 * 3600000 && !days.some(x => x.date === d.date)) days.push({ date: d.date, ms, hours: msToHours(ms) });
  });
  if (!days.length) throw userError('حدد يوم واحد على الأقل وعدد ساعاته.', 'Add at least one day with its hours.');
  if (days.length > 31) throw userError('أقصى حاجة 31 يوم.', 'At most 31 days.');
  days.sort((a, b) => a.date.localeCompare(b.date));
  const ot = { state: 'offered', plan: days, totalMs: otPlanMs(days), totalHours: otPlanHours(days), offeredBy: session.email, offeredAt: now() };
  const made = await createTasks({ ...fields, due: (fields && fields.due) || days[days.length - 1].date }, [assignee], { ot });
  const t = made[0];
  notify(assignee, L(`طلب أوفر تايم: ${t.title}`, `Overtime request: ${t.title}`), L(`${fmtHMS(ot.totalMs)} على ${days.length} يوم · من ${nameOf(session.email)} · وافق عليه من الداشبورد`, `${fmtHMS(ot.totalMs)} over ${days.length} day(s) · from ${nameOf(session.email)} · accept it on your dashboard`), taskLink(t.id), 'request');
  track('overtime.offer', { target: t.title, detail: `${nameOf(assignee)} · ${fmtHMS(ot.totalMs)}` });
  return t;
}

/** The employee accepts or declines an offered overtime task */
export async function respondOT(t, accept, note = '') {
  if (!isOTTask(t) || t.assignee !== session.email || t.ot.state !== 'offered') throw userError('الطلب ده مش متاح.', 'This offer is not available.');
  const n = String(note || '').trim().slice(0, 500);
  const to = accept ? 'in_progress' : 'hold';
  const upd = accept
    ? { 'ot.state': 'accepted', 'ot.acceptedAt': now(), status: to }
    : { 'ot.state': 'declined', 'ot.declineNote': n, status: to, holdReason: n || L('رفض الأوفر تايم', 'Declined the overtime') };
  upd.updatedAt = serverTimestamp();
  upd.history = arrayUnion({ by: session.email, from: t.status, to, at: now(), note: accept ? L('وافق على الأوفر تايم', 'accepted the overtime') : L(`رفض الأوفر تايم${n ? ` — ${n}` : ''}`, `declined the overtime${n ? ` — ${n}` : ''}`) });
  await updateDoc(doc(db, 'tasks', t.id), upd);
  const who = nameOf(session.email);
  notifyMany([t.leader, t.createdBy].filter(e => e && e !== session.email), accept ? L(`✓ ${who} وافق على الأوفر تايم`, `✓ ${who} accepted the overtime`) : L(`${who} رفض الأوفر تايم`, `${who} declined the overtime`), `${t.title}${n ? ` — ${n}` : ''}`, taskLink(t.id), 'progress');
}

// ---------- the overtime card: one counter per task and day (overtime_days/{email}_{taskId}_{date}) ----------
export const OT_STATUSES = ['Online', 'Meeting', 'Break'];
const zeroBank = () => ({ Online: 0, Break: 0, Meeting: 0 });
export const otDocId = (email, taskId, date) => `${email}_${taskId}_${date}`;
/** the card's counters at `at`: the saved bank + the time since the last change of a running status */
export function otLive(d, at = now()) {
  const bank = { ...zeroBank(), ...((d && d.bank) || {}) };
  if (d && !d.closed && OT_STATUSES.includes(d.status)) bank[d.status] += Math.max(0, at - (Number(d.lastChangeMs) || at));
  return bank;
}
/** counted overtime: work + meetings, breaks excluded */
export const otWorkMs = (d, at = now()) => { const b = otLive(d, at); return b.Online + b.Meeting; };

/** Watch my own overtime sessions (a handful per month) */
export const watchMyOT = (cb) => watch(query(col('overtime_days'), where('email', '==', session.email)), cb);
/** Admin: a person's overtime sessions of a month */
export const monthOT = (email, ym) => list(query(col('overtime_days'), where('email', '==', email)))
  .then(rows => rows.filter(d => (d.date || '').slice(0, 7) === ym).sort((a, b) => a.date.localeCompare(b.date)));

/** Start (or resume) today's session of an accepted overtime task */
export async function startOT(task, date) {
  window.dispatchEvent(new Event('am:data-changed'));
  if (!isOTTask(task) || task.assignee !== session.email || task.ot.state !== 'accepted') throw userError('التاسك ده مش متاح للأوفر تايم.', 'This task is not open for overtime.');
  const day = planDay(task, date);
  if (!day) throw userError('النهارده مش من الأيام المحددة للتاسك ده.', 'Today is not one of the days set for this task.');
  const email = session.email, me = session.profile || {};
  const ref = doc(db, 'overtime_days', otDocId(email, task.id, date));
  const cur = await getDoc(ref).then(s => (s.exists() ? s.data() : null)).catch(() => null);
  const at = now();
  const data = cur
    ? { status: 'Online', lastChangeMs: at, endMs: null, closed: false, autoClosed: false, updatedAt: serverTimestamp() }
    : {
      email, name: me.name || email, date, leaderEmail: '', department: me.department || '',
      kind: 'task', taskId: task.id, taskNum: task.num || 0, taskTitle: String(task.title || '').slice(0, 200), allotMs: dayMs(day),
      status: 'Online', bank: zeroBank(), lastChangeMs: at, startMs: at, endMs: null, closed: false, autoClosed: false, requestId: '', updatedAt: serverTimestamp()
    };
  await settle(setDoc(ref, data, { merge: true }));
}

/** Switch the card between Work / Meeting / Break */
export async function changeOT(d, status) {
  if (!d || d.closed || d.status === status || !OT_STATUSES.includes(status)) return;
  const at = now();
  const bank = otLive(d, at);                 // closes the running segment into the bank
  await settle(updateDoc(doc(db, 'overtime_days', d.id), { status, bank, lastChangeMs: at, updatedAt: serverTimestamp() }));
}

/**
 * End a session (the task stays open: the employee may come back on another planned day).
 * auto = a forgotten one from an earlier day: the running segment is counted only up to the end of its day.
 */
export async function endOT(d, { auto = false } = {}) {
  if (!d || d.closed) return;
  window.dispatchEvent(new Event('am:data-changed'));
  const at = now();
  const cap = auto ? Math.min(at, cairoMs(d.date, '23:59')) : at;
  const bank = { ...zeroBank(), ...(d.bank || {}) };
  if (OT_STATUSES.includes(d.status)) bank[d.status] += Math.max(0, cap - (Number(d.lastChangeMs) || cap));
  const endMs = Math.max(cap, Number(d.startMs) || 0);
  await settle(updateDoc(doc(db, 'overtime_days', d.id), { status: 'Offline', bank, lastChangeMs: at, endMs, closed: true, autoClosed: !!auto, updatedAt: serverTimestamp() }));
}

/**
 * The employee finished the task: close any open session and send ONE request to the admin with what the leader
 * allotted and what was really taken. The task goes to "Review" for the leader.
 */
export async function finishOTTask(task, sessions) {
  if (!isOTTask(task) || task.assignee !== session.email || task.ot.state !== 'accepted') throw userError('التاسك ده مش متاح.', 'This task is not available.');
  window.dispatchEvent(new Event('am:data-changed'));
  const email = session.email, me = session.profile || {};
  for (const d of sessions.filter(x => !x.closed)) await endOT(d);
  // read the saved sessions back (the ones just closed included)
  const rows = (await list(query(col('overtime_days'), where('email', '==', email), where('taskId', '==', task.id))).catch(() => sessions))
    .sort((a, b) => a.date.localeCompare(b.date));
  const workMs = rows.reduce((s, d) => s + (Number((d.bank || {}).Online) || 0) + (Number((d.bank || {}).Meeting) || 0), 0);
  if (!(workMs > 0)) throw userError('لسه ما اشتغلتش على التاسك ده.', 'You have not worked on this task yet.');
  const allotMs = Number(task.ot.totalMs) || otPlanMs(task.ot.plan), actualMs = Math.round(workMs);
  const payMs = allotMs > 0 ? Math.min(actualMs, allotMs) : actualMs;      // the default: what was allotted; the admin decides
  const facts = {
    workMs: actualMs, actualMs, allotMs, payMs, actualHours: msToHours(actualMs), allotHours: msToHours(allotMs), hours: msToHours(payMs),
    days: rows.map(d => ({ date: d.date, workMs: Math.round((Number((d.bank || {}).Online) || 0) + (Number((d.bank || {}).Meeting) || 0)), breakMs: Math.round(Number((d.bank || {}).Break) || 0), allotMs: d.allotMs || 0, autoClosed: !!d.autoClosed })),
    startDate: rows[0].date, endDate: rows[rows.length - 1].date, checkInMs: rows[0].startMs || null, checkOutMs: rows[rows.length - 1].endMs || null
  };
  const id = overtimeId(email, task.id);
  const cur = await list(query(col('requests'), where('email', '==', email))).then(r => r.find(x => x.id === id)).catch(() => null);
  if (cur && cur.status !== 'pending_admin') throw userError('طلب الأوفر تايم للتاسك ده اتقرر بالفعل.', 'The overtime request of this task was already decided.');
  if (cur) await settle(updateDoc(doc(db, 'requests', id), { ...facts, updatedAt: serverTimestamp(), history: arrayUnion({ at: now(), by: email, byName: me.name || email, action: 'updated', note: L(`سلّم تاني: ${fmtHMS(actualMs)}`, `handed in again: ${fmtHMS(actualMs)}`) }) }));
  else {
    const req = {
      email, name: me.name || email, leaderEmail: '', department: me.department || '',
      type: 'overtime', kind: 'task', taskId: task.id, taskNum: task.num || 0, taskTitle: String(task.title || '').slice(0, 200),
      assignedBy: task.createdBy || task.leader || '', assignedByName: nameOf(task.createdBy || task.leader || ''), plan: task.ot.plan || [],
      ...facts, multiplier: otMultiplier(),
      reason: L(`أوفر تايم على تاسك #${task.num || ''}: ${task.title}`, `Overtime on task #${task.num || ''}: ${task.title}`),
      status: 'pending_admin', stages: ['admin'], createdMs: now(), createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      history: [{ at: now(), by: email, byName: me.name || email, action: 'submitted', note: '' }]
    };
    await settle(setDoc(doc(db, 'requests', id), req));
  }
  // the task goes to the leader's review (the assignee may do that from "In progress"). The admin only sees the request
  // once the leader finishes the task (moveTask in services/tasks.js); until then the leader may comment or send it back.
  const upd = { 'ot.state': 'submitted', 'ot.submittedAt': now(), updatedAt: serverTimestamp(), history: arrayUnion({ by: email, from: task.status, to: task.status === 'in_progress' ? 'review' : task.status, at: now(), note: L(`سلّم الأوفر تايم: ${fmtHMS(actualMs)}`, `handed in the overtime: ${fmtHMS(actualMs)}`) }) };
  if (task.status === 'in_progress') { upd.status = 'review'; upd.reviewAt = serverTimestamp(); }
  await settle(updateDoc(doc(db, 'tasks', task.id), upd));
  notifyMany([task.leader, task.createdBy].filter((e, i, a) => e && e !== email && a.indexOf(e) === i), L(`✓ ${me.name || email} سلّم تاسك أوفر تايم`, `✓ ${me.name || email} handed in an overtime task`), L(`${task.title} · المحدد ${fmtHMS(allotMs)} · الفعلي ${fmtHMS(actualMs)}`, `${task.title} · allotted ${fmtHMS(allotMs)} · taken ${fmtHMS(actualMs)}`), taskLink(task.id), 'progress');
  track('request.submit', { target: id, detail: `overtime task #${task.num} ${fmtHMS(actualMs)}` });
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
