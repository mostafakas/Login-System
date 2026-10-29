// Company policy (settings/general + settings/leave) with safe defaults, and the
// pure calculations built on it: day keys, lateness, working days, schedule modes.
import { read, ref, watch, setDoc, serverTimestamp } from './fb.js';
import { L, zparts, ymd, addDays, weekday, hmToMin, minutesOfDay, dateRange } from './utils.js';

export const DEFAULT_DEPARTMENTS = ['SEO', 'Content', 'Management', 'Development', 'Design'];
export const DEFAULT_POLICY = {
  departments: DEFAULT_DEPARTMENTS,   // the departments to pick from (Settings → Departments adds / renames)
  workStart: '09:00',
  workEnd: '17:00',
  graceMinutes: 15,
  // the shifts an employee picks from when starting the day (office grace per shift; remote has its own grace)
  shifts: [
    { id: '8', start: '08:00', end: '17:00', grace: 30 },
    { id: '9', start: '09:00', end: '18:00', grace: 30 },
    { id: '10', start: '10:00', end: '19:00', grace: 30 }
  ],
  remoteGraceMinutes: 15,
  weekend: [5, 6],                // Friday, Saturday
  dayBoundaryHour: 4,             // work after midnight until 04:00 belongs to the previous day
  remoteNeedsApproval: true,
  defaultRemoteQuota: 4,          // remote days per month
  excuseHoursPerMonth: 4,
  excusesPerMonth: 1,        // late-arrival permissions a month, and as many early-leave ones (0 = no limit)
  hiddenRequestTypes: ['correction', 'letter'],   // built-in types not offered on the employee's request page
  customRequestTypes: [],         // admin-defined types: { id, ar, en, icon, dates: 'none' | 'day' | 'range', attachment, active }
  lateTiers: [                    // deduction per late day (fraction of a day's pay)
    { after: 15, day: 0.25 },
    { after: 60, day: 0.5 },
    { after: 180, day: 1 }
  ],
  lateDeductionEnabled: false,
  absenceDeductDays: 1,
  payrollDayDivisor: 30,
  overtimeMultiplier: 1,          // overtime on a day off: hours × the hour's value × this
  overtimeDayHours: 8,            // actual work hours in a day, for the hour's value (day value ÷ this)
  breakMaxMinutes: 60,
  carryOverMax: 0,                // unused annual days carried to next year
  trackingStart: '',              // first day attendance is tracked by this system (set at go-live)
  singleSession: true,
  hrEmail: '',
  statuses: {
    Online: { enabled: true },
    Break: { enabled: true },
    Meeting: { enabled: true }
  },
  workflow: {
    leave: ['leader', 'hr'],
    remote: ['leader'],
    excuse: ['leader'],
    mission: ['leader'],
    correction: ['leader', 'hr'],
    advance: ['leader', 'hr', 'finance'],
    letter: ['hr']
  }
};

export const DEFAULT_LEAVE_TYPES = [
  { id: 'annual', ar: 'إجازة اعتيادية', en: 'Annual leave', days: 21, paid: true, attachment: false, color: 'brand', active: true },
  { id: 'casual', ar: 'إجازة عارضة', en: 'Casual leave', days: 6, paid: true, attachment: false, color: 'info', active: true },
  { id: 'sick', ar: 'إجازة مرضية', en: 'Sick leave', days: 14, paid: true, attachment: true, color: 'warn', active: true },
  { id: 'unpaid', ar: 'إجازة بدون أجر', en: 'Unpaid leave', days: 0, paid: false, attachment: false, color: 'bad', active: true, unlimited: true }
];

export const REQUEST_TYPES = {
  leave:      { ar: 'إجازة', en: 'Leave', icon: 'fa-umbrella-beach', tile: 'warn' },
  remote:     { ar: 'عمل أونلاين', en: 'Remote work', icon: 'fa-house-laptop', tile: '' },
  excuse:     { ar: 'إذن تأخير / انصراف', en: 'Late / early permission', icon: 'fa-clock', tile: 'info' },
  mission:    { ar: 'مأمورية', en: 'Business mission', icon: 'fa-briefcase', tile: 'ok', retired: true }, // no longer requested; kept to show old records
  correction: { ar: 'تصحيح حضور', en: 'Attendance correction', icon: 'fa-pen-to-square', tile: 'neutral' },
  advance:    { ar: 'سلفة', en: 'Salary advance', icon: 'fa-hand-holding-dollar', tile: 'ok' },
  letter:     { ar: 'خطاب من HR', en: 'HR letter', icon: 'fa-file-signature', tile: 'info' },
  overtime:   { ar: 'أوفر تايم', en: 'Overtime', icon: 'fa-business-time', tile: 'ok', internal: true }, // filed automatically when a day off is worked
  custom:     { ar: 'طلب آخر', en: 'Other request', icon: 'fa-file-lines', tile: 'neutral', internal: true } // admin-defined types (settings → request types)
};
export const EXCUSE_KINDS = {
  late:  { ar: 'إذن تأخير', en: 'Late-arrival permission', icon: 'fa-clock', tile: 'info' },
  early: { ar: 'إذن انصراف', en: 'Early-leave permission', icon: 'fa-person-walking-arrow-right', tile: 'info' }
};
export const REQUEST_STATUS = {
  pending_leader:  { ar: 'عند المدير المباشر', en: 'With manager', cls: 'warn' },
  pending_hr:      { ar: 'عند HR', en: 'With HR', cls: 'warn' },
  pending_finance: { ar: 'عند المالية', en: 'With finance', cls: 'warn' },
  pending_admin:   { ar: 'عند الأدمن', en: 'With admin', cls: 'warn' },
  approved:        { ar: 'معتمد', en: 'Approved', cls: 'ok' },
  rejected:        { ar: 'مرفوض', en: 'Rejected', cls: 'bad' },
  cancelled:       { ar: 'ملغي', en: 'Cancelled', cls: '' }
};
export const MODE_META = {
  office:  { ar: 'المكتب', en: 'Office', cls: 'm-office', icon: 'fa-building' },
  remote:  { ar: 'أونلاين', en: 'Remote', cls: 'm-remote', icon: 'fa-house-laptop' },
  leave:   { ar: 'إجازة', en: 'Leave', cls: 'm-leave', icon: 'fa-umbrella-beach' },
  mission: { ar: 'مأمورية', en: 'Mission', cls: 'm-mission', icon: 'fa-briefcase' },
  off:     { ar: 'راحة', en: 'Day off', cls: 'm-off', icon: 'fa-bed' },
  holiday: { ar: 'عطلة رسمية', en: 'Holiday', cls: 'm-holiday', icon: 'fa-flag' }
};
export const ROLE_META = {
  employee: { ar: 'موظف', en: 'Employee' },
  leader: { ar: 'مدير فريق', en: 'Team leader' },
  sales_manager: { ar: 'مدير السيلز', en: 'Sales manager' },   // a team leader for the sales team
  team_supervisor: { ar: 'سوبر فايزر', en: 'Team supervisor' },  // leads the leaders; sees their teams too (monitor, tasks)
  pm: { ar: 'مدير المشروعات', en: 'Project manager' },
  hr: { ar: 'موارد بشرية', en: 'HR' },
  finance: { ar: 'المالية', en: 'Finance' },
  admin: { ar: 'مدير النظام', en: 'Administrator' }
};
export const statusLabel = (s) => { const m = REQUEST_STATUS[s]; return m ? L(m.ar, m.en) : s; };
export const typeLabel = (t) => { const m = REQUEST_TYPES[t]; return m ? L(m.ar, m.en) : t; };
/** Label of one request record: the permission kind, or the admin-defined type's name */
export function requestLabel(r) {
  if (!r) return '';
  if (r.type === 'excuse' && EXCUSE_KINDS[r.excuseKind || 'late']) { const k = EXCUSE_KINDS[r.excuseKind || 'late']; return L(k.ar, k.en); }
  if (r.type === 'custom') { const c = customType(r.customType); return c ? L(c.ar, c.en || c.ar) : L((r.customLabel || {}).ar || 'طلب آخر', (r.customLabel || {}).en || (r.customLabel || {}).ar || 'Other request'); }
  return typeLabel(r.type);
}
export const customTypes = () => (Array.isArray(policy.customRequestTypes) ? policy.customRequestTypes : []);
export const customType = (id) => customTypes().find(c => c.id === id) || null;
/** Workflow key of a request: admin-defined types each have their own (custom_<id>) */
export const wfKey = (type, customId) => type === 'custom' && customId ? `custom_${customId}` : type;
/**
 * What the employee's request page offers, in order: { key, type, excuseKind?, customType?, label, icon, tile }.
 * key is what the form / quick buttons pass around ('excuse:late', 'custom:<id>', or the type itself).
 */
export function requestChoices() {
  const hidden = Array.isArray(policy.hiddenRequestTypes) ? policy.hiddenRequestTypes : [];
  const out = [];
  const add = (type) => { const m = REQUEST_TYPES[type]; out.push({ key: type, type, label: L(m.ar, m.en), icon: m.icon, tile: m.tile }); };
  ['leave', 'remote'].filter(t => !hidden.includes(t)).forEach(add);
  if (!hidden.includes('excuse')) Object.entries(EXCUSE_KINDS).forEach(([k, m]) => out.push({ key: `excuse:${k}`, type: 'excuse', excuseKind: k, label: L(m.ar, m.en), icon: m.icon, tile: m.tile }));
  Object.keys(REQUEST_TYPES).filter(t => !['leave', 'remote', 'excuse'].includes(t) && !REQUEST_TYPES[t].retired && !REQUEST_TYPES[t].internal && !hidden.includes(t)).forEach(add);
  customTypes().filter(c => c.active !== false).forEach(c => out.push({ key: `custom:${c.id}`, type: 'custom', customType: c.id, label: L(c.ar, c.en || c.ar), icon: c.icon || 'fa-file-lines', tile: 'neutral' }));
  return out;
}
export const requestChoice = (key) => requestChoices().find(c => c.key === key) || null;
export const modeLabel = (m) => { const x = MODE_META[m]; return x ? L(x.ar, x.en) : m; };
export const roleLabel = (r) => { const x = ROLE_META[normRole(r)]; return x ? L(x.ar, x.en) : r; };
export const normRole = (raw) => { const r = String(raw || '').trim().toLowerCase(); return r === 'supervisor' ? 'hr' : (ROLE_META[r] ? r : 'employee'); };

// ---------- live policy ----------
export const policy = structuredClone(DEFAULT_POLICY);
export let leaveTypes = structuredClone(DEFAULT_LEAVE_TYPES);
export let holidays = {}; // 'YYYY-MM-DD' -> name
const subs = new Set();
export const onPolicy = (fn) => { subs.add(fn); return () => subs.delete(fn); };
function merge(target, src) { Object.keys(src || {}).forEach(k => { target[k] = src[k]; }); }

export async function loadPolicy() {
  const [g, lv, hd] = await Promise.all([
    read('settings', 'general').catch(() => null),
    read('settings', 'leave').catch(() => null),
    read('settings', 'holidays').catch(() => null)
  ]);
  if (g) { merge(policy, g); policy.workflow = { ...DEFAULT_POLICY.workflow, ...(g.workflow || {}) }; policy.statuses = { ...DEFAULT_POLICY.statuses, ...(g.statuses || {}) }; }
  if (lv && Array.isArray(lv.types) && lv.types.length) leaveTypes = lv.types;
  holidays = (hd && hd.days) || {};
  if (!g) {
    // Fall back to the old system's work_config when present (first run after migration)
    const legacy = await read('system_settings', 'work_config').catch(() => null);
    if (legacy && typeof legacy.workStart === 'string') policy.workStart = legacy.workStart;
  }
  watch(ref('settings', 'general'), d => { if (d) { merge(policy, d); policy.workflow = { ...DEFAULT_POLICY.workflow, ...(d.workflow || {}) }; } subs.forEach(f => f()); });
  watch(ref('settings', 'leave'), d => { if (d && Array.isArray(d.types) && d.types.length) leaveTypes = d.types; subs.forEach(f => f()); });
  watch(ref('settings', 'holidays'), d => { holidays = (d && d.days) || {}; window.dispatchEvent(new Event('am:data-changed')); subs.forEach(f => f()); });   // a moved holiday: reports work the days out again
}
const audit = (a, d) => import('../services/activity.js').then(m => m.track(a, { detail: d })).catch(() => {});
export async function savePolicy(part) { await setDoc(ref('settings', 'general'), { ...part, updatedAt: serverTimestamp() }, { merge: true }); audit('settings.update', Object.keys(part).join(', ')); }
export async function saveLeaveTypes(types) { await setDoc(ref('settings', 'leave'), { types, updatedAt: serverTimestamp() }, { merge: true }); audit('settings.update', 'leave types'); }
export async function saveHolidays(days) { await setDoc(ref('settings', 'holidays'), { days, updatedAt: serverTimestamp() }); audit('settings.update', 'holidays'); }

export const leaveType = (id) => leaveTypes.find(t => t.id === id) || { id, ar: id, en: id, days: 0, paid: true };
export const leaveTypeLabel = (id) => { const t = leaveType(id); return L(t.ar, t.en); };

// ---------- day logic ----------
/** Work-day key for a moment: the Cairo date, shifted back by the day boundary hour. */
export function dayKey(ms) { return ymd(ms - (policy.dayBoundaryHour || 0) * 3600000); }
export const isWeekend = (dateStr) => (policy.weekend || []).includes(weekday(dateStr));
export const isHoliday = (dateStr) => !!holidays[dateStr];

// ---------- personal working hours (users/{email}.workStart / workEnd; empty = company hours) ----------
let personOf = () => null;
/** The people directory registers how to look a person up by email. */
export const setPersonLookup = (fn) => { personOf = fn || (() => null); };
/**
 * { start, end, grace, fixed, ownGrace } for a person — `who` is an email or a profile; each falls back to the company setting.
 * fixed = the person has their own hours (an exception set on their profile), so they do not pick a shift.
 */
export function hoursFor(who) {
  const p = who && typeof who === 'object' ? (personOf(who.email) || who) : personOf(who);
  const own = !!(p && p.workStart && p.workEnd);
  const ownGrace = !!p && p.graceMinutes !== undefined && p.graceMinutes !== null && p.graceMinutes !== '';
  // fixed on one of the shifts: that shift's grace
  const sh = own && !ownGrace ? shiftList().find(s => s.start === p.workStart && s.end === p.workEnd) : null;
  const g = ownGrace ? Number(p.graceMinutes) : (sh ? Number(sh.grace ?? policy.graceMinutes) || 0 : Number(policy.graceMinutes) || 0);
  return { start: own ? p.workStart : policy.workStart, end: own ? p.workEnd : policy.workEnd, grace: g, fixed: own, ownGrace };
}

/** Effective plan for a date: schedule override > holiday > weekend > office. `who` = email/profile when there may be no schedule. */
export function planFor(dateStr, schedule, who) {
  const h = hoursFor(who || (schedule && schedule.email) || '');
  const o = schedule && schedule.days && schedule.days[dateStr];
  // hours written on the day itself (HR's schedule, an approved permission) that differ from the company hours are fixed too
  const dayFixed = !!(o && o.start && (o.excuseId || o.start !== policy.workStart || (o.end && o.end !== policy.workEnd)));
  if (o && o.mode) return { mode: o.mode, start: o.start || h.start, end: o.end || h.end, grace: h.grace, ownGrace: h.ownGrace, fixed: h.fixed || dayFixed, leaveType: o.leaveType, requestId: o.requestId, source: 'schedule' };
  if (isHoliday(dateStr)) return { mode: 'holiday', name: holidays[dateStr], start: null, end: null, source: 'holiday' };
  if (isWeekend(dateStr)) return { mode: 'off', start: null, end: null, source: 'weekend' };
  return { mode: 'office', start: h.start, end: h.end, grace: h.grace, ownGrace: h.ownGrace, fixed: h.fixed, source: 'default' };
}
export const isWorkingPlan = (p) => p.mode === 'office' || p.mode === 'remote' || p.mode === 'mission';
/**
 * Shifts: someone without fixed hours picks one when starting the day (08:00–17:00, 09:00–18:00 or 10:00–19:00).
 * The choice is stored on the day (users.shift / attendance_days.shift); days from before shifts keep '' (company hours).
 */
export const shiftList = () => (Array.isArray(policy.shifts) && policy.shifts.length ? policy.shifts : DEFAULT_POLICY.shifts);
export const shiftById = (id) => (id ? shiftList().find(s => String(s.id) === String(id)) || null : null);
export const shiftLabel = (id) => { const s = shiftById(id); return s ? L(`شيفت ${s.start}`, `${s.start} shift`) : ''; };
export const canPickShift = (plan) => !!plan && isWorkingPlan(plan) && !plan.fixed;
/** The day's plan with the picked shift's hours; mode = where the day is worked ('remote' has its own, shorter grace) */
export function withShift(plan, shift, mode) {
  if (!plan) return plan;
  let p = plan;
  const s = shiftById(shift);
  if (s && canPickShift(p)) p = { ...p, start: s.start, end: s.end, grace: p.ownGrace ? p.grace : Number(s.grace ?? policy.graceMinutes) || 0, shift: String(s.id) };
  if (isWorkingPlan(p) && (mode === 'remote' || p.mode === 'remote') && !p.ownGrace) p = { ...p, grace: Number(policy.remoteGraceMinutes ?? 15) || 0 };
  return p;
}

/**
 * The shift a check-in fits: the earliest one it is not late for (what the start-day picker suggests), else the last.
 * For a day saved without a shift (the person had fixed hours then) by someone who now picks one every day.
 */
export function shiftForCheckIn(plan, checkInMs, mode) {
  if (!checkInMs || !canPickShift(plan)) return '';
  const all = shiftList();
  const fit = all.find(s => !lateness(checkInMs, withShift(plan, s.id, mode)).late) || all[all.length - 1];
  return fit ? String(fit.id) : '';
}

/**
 * The shift a day runs on, the same everywhere (live monitor, home, dashboard, monthly reports, payroll):
 * the picked one, else for a day saved with shift '' and a check-in, the shift that check-in fits (shiftForCheckIn).
 * undefined (days from before shifts) stays as it is.
 */
export function dayShift(plan, shift, checkInMs, mode) {
  if (shift || shift !== '' || !checkInMs) return shift;
  return shiftForCheckIn(plan, checkInMs, mode) || shift;
}
/** withShift with the day's shift resolved by dayShift */
export const planOfDay = (plan, shift, checkInMs, mode) => withShift(plan, dayShift(plan, shift, checkInMs, mode), mode);

/** Actual work a working day asks for (work + meetings, breaks excluded): the plan's hours minus the allowed break */
export function requiredWorkMs(plan) {
  if (!plan || !isWorkingPlan(plan) || !plan.start || !plan.end) return 0;
  const mins = hmToMin(plan.end) - hmToMin(plan.start) - (Number(policy.breakMaxMinutes) || 0);
  return Math.max(0, mins) * 60000;
}
/** Hours in one working day, for the value of an hour: the setting (Settings → Payroll), else 8 — the day's actual work hours */
export function dayWorkHours() {
  const set = Number(policy.overtimeDayHours) || 0;
  return set > 0 ? set : 8;
}

/** Count working days in a range (excludes weekends & holidays; schedule overrides respected) */
export function workingDays(from, to, schedulesByMonth = {}) {
  return dateRange(from, to).filter(d => {
    const p = planFor(d, schedulesByMonth[d.slice(0, 7)]);
    return p.mode !== 'off' && p.mode !== 'holiday';
  }).length;
}

/** Minutes late for a check-in (0 if within grace). Returns {late, raw} */
export function lateness(checkInMs, plan) {
  if (!checkInMs) return { late: 0, raw: 0 };
  if (plan && !isWorkingPlan(plan)) return { late: 0, raw: 0 };
  const start = hmToMin((plan && plan.start) || policy.workStart);
  // whole minutes: with a 30-minute grace, 09:30:59 is still on time and 09:31 is 31 minutes late
  const rawMin = Math.max(0, Math.floor(minutesOfDay(checkInMs) - start));
  const grace = plan && plan.grace !== undefined ? plan.grace : (policy.graceMinutes || 0);
  return { late: rawMin > grace ? rawMin : 0, raw: rawMin };
}
export function earlyLeave(checkOutMs, plan, dateStr) {
  if (!checkOutMs) return 0;
  if (plan && !isWorkingPlan(plan)) return 0;
  if (dateStr && ymd(checkOutMs) !== dateStr) return 0; // left after midnight
  const end = hmToMin((plan && plan.end) || policy.workEnd);
  return Math.max(0, Math.round(end - minutesOfDay(checkOutMs)));
}
export function lateDeductionDays(lateMin) {
  if (!lateMin) return 0;
  let d = 0;
  (policy.lateTiers || []).forEach(t => { if (lateMin > Number(t.after)) d = Math.max(d, Number(t.day) || 0); });
  return d;
}
/** Which approval stages a request of this type goes through for this requester */
/** Request types people can still file (retired ones only appear on old records) */
export const activeRequestTypes = () => Object.keys(REQUEST_TYPES).filter(k => !REQUEST_TYPES[k].retired && !REQUEST_TYPES[k].internal);
/** type = a request type or a workflow key (custom_<id> for an admin-defined type) */
export function stagesFor(type, requester) {
  if (type === 'advance' || type === 'overtime') return ['admin']; // money: salary advances and overtime are decided by the admin only
  // with no saved workflow, an admin-defined type goes to the manager (the same default the security rules use)
  const wf = (policy.workflow && policy.workflow[type]) || (String(type).startsWith('custom') ? ['leader'] : ['hr']);
  const st = wf.filter(s => !(s === 'leader' && !(requester && requester.leaderEmail)));
  return st.length ? st : ['hr']; // nobody approves their own request
}
export function firstStatus(type, requester) {
  const st = stagesFor(type, requester);
  return st.length ? `pending_${st[0]}` : 'approved';
}
export function nextStatus(type, requester, current) {
  const st = stagesFor(type, requester);
  const i = st.indexOf(String(current).replace('pending_', ''));
  return i >= 0 && i < st.length - 1 ? `pending_${st[i + 1]}` : 'approved';
}
/** First date absence can be counted for a person: go-live date, hire date or account creation. */
export function trackedSince(p) {
  const created = p && p.createdAt ? ymd(p.createdAt.toMillis ? p.createdAt.toMillis() : (p.createdAt.seconds ? p.createdAt.seconds * 1000 : p.createdAt)) : '';
  return [policy.trackingStart || ymd(Date.now()), (p && p.hireDate) || '', created].filter(Boolean).sort().pop();
}
export { zparts, addDays };
