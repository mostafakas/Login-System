// Dashboard (admin & HR for everyone; a leader the admin allowed sees their own team).
// "Today": everything unusual on one day — lateness, early leavers and short days, absences, remote / office days that
// differ from the plan, work on a day off, forgotten days, long breaks — plus each person's day in a table.
// "Month": attendance commitment, absences, lateness, actual work hours, by department and by person, plus task delivery.
import { L, esc, num, fmtHours, fmtMin, ymd, fmtTime, fmtDay, cairoMs } from '../core/utils.js';
import { avatar, loader, empty, presenceBadge } from '../core/ui.js';
import { session, now, isHR, isAdmin } from '../core/session.js';
import { toMs } from '../core/fb.js';
import { policy, dayKey, planFor, isWorkingPlan, canPickShift, shiftList, withShift, modeLabel, shiftLabel, statusLabel, leaveTypeLabel } from '../core/policy.js';
import { liveBank, COUNTED } from '../services/attendance.js';
import { teamMonth, summarize, classifyDay, STATUS_DAY } from '../services/reports.js';
import { nameOf, person, onDirectory } from '../services/directory.js';
import { startTasks, onTasks, allTasks, doneDay, periodRange, inPeriod } from '../services/tasks.js';
import { periodPicker } from './task-ui.js';
import { watchMonth } from '../services/todos.js';

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
const avgHours = (t) => (t.present ? (t.workMs + t.meetingMs) / t.present : 0);

/** task delivery for a set of tasks in a period (by due date; tasks without one count in every period) */
function taskStats(ts, range) {
  const today = ymd(now());
  const rel = ts.filter(t => inPeriod(t, range));
  const done = rel.filter(t => t.status === 'done');
  const onTime = done.filter(t => !t.due || doneDay(t) <= t.due).length;
  const lateOpen = rel.filter(t => t.status !== 'done' && t.due && t.due < today).length;
  const open = rel.filter(t => t.status !== 'done').length;
  return { total: rel.length, done: done.length, onTime, lateOpen, open, rate: pct(done.length, done.length + open), onTimeRate: pct(onTime, done.length) };
}

// ---------- one day: what was unusual ----------
export const DAY_GROUPS = [
  ['late', 'fa-clock', 'bad', 'تأخيرات', 'Late arrivals'],
  ['early', 'fa-door-open', 'warn', 'مشيوا بدري / ساعات ناقصة', 'Left early / short hours'],
  ['absent', 'fa-user-xmark', 'bad', 'غياب', 'Absences'],
  ['place', 'fa-shuffle', 'info', 'أونلاين أو مقر عكس الجدول', 'Remote / office against the plan'],
  ['overtime', 'fa-business-time', 'ok', 'شغل في يوم إجازة', 'Worked on a day off'],
  ['other', 'fa-circle-exclamation', 'neutral', 'حاجات تانية غير معتادة', 'Other unusual things']
];
const covers = (r, d) => r.startDate <= d && (r.endDate || r.startDate) >= d;
/** The latest moment someone may start a working day without being late (for shift pickers: the last shift) */
function dueBy(plan, date) {
  if (canPickShift(plan)) {
    const last = shiftList().slice().sort((a, b) => a.start.localeCompare(b.start)).pop();
    const p = withShift(plan, last.id, plan.mode);
    return cairoMs(date, p.start) + (Number(p.grace) || 0) * 60000;
  }
  return plan.start ? cairoMs(date, plan.start) + (Number(plan.grace) || 0) * 60000 : 0;
}

/**
 * One person's day: the row, live counters (today) and the unusual events, each { g, sev, text, sub }.
 * Today is classified again from the live profile, so a day started or ended a minute ago shows straight away.
 */
export function dayOf(x, date, { requests = [], schedules = [] } = {}) {
  const todayKey = dayKey(now());
  let r = x.rows.find(z => z.date === date);
  if (!r) return null;
  const p = person(x.person.email) || x.person;
  if (date === todayKey && p.dayKey === date && toMs(p.firstOnlineAt)) {
    const was = r.rec || {};
    const ended = !!p.checkedOut && (!p.status || p.status === 'Offline');
    const rec = { ...was, checkInMs: was.checkInMs || toMs(p.firstOnlineAt), mode: was.mode || p.workLocation || 'office', remotePending: !!p.remotePending, shift: was.shift ?? (p.shift || ''),
      closed: ended, checkOutMs: ended ? (was.checkOutMs || toMs(p.lastChange) || null) : null };
    const sch = schedules.find(s => s.email === p.email) || null;
    r = classifyDay(date, planFor(date, sch, p), rec, requests.filter(q => q.email === p.email && q.type === 'excuse' && q.status === 'approved'), todayKey);
  }
  const rec = r.rec || {};
  const live = date === todayKey && p.dayKey === date && !!rec.checkInMs;
  const bank = live ? liveBank(p) : null;
  const work = live ? bank.Online + bank.Meeting : (r.workMs || 0) + (r.meetingMs || 0);
  const brk = live ? bank.Break : (r.breakMs || 0);
  const upTo = x.rows.filter(z => z.date <= date && !z.flags.includes('untracked'));
  const nth = (fn) => upTo.filter(fn).length;
  const times = (n) => L(n === 1 ? 'أول مرة الشهر ده' : `المرة رقم ${n} الشهر ده`, n === 1 ? 'first time this month' : `${n} times this month`);
  const mine = requests.filter(q => q.email === p.email && covers(q, date));
  const ev = [];
  if (r.late) ev.push({ g: 'late', sev: 'bad', text: L(`متأخر ${fmtMin(r.late)}`, `Late ${fmtMin(r.late)}`), sub: `${L('حضر', 'In at')} ${fmtTime(rec.checkInMs)}${r.plan.start ? ` · ${L('ميعاده', 'due')} ${r.plan.start}` : ''} · ${times(nth(z => z.late > 0))}` });
  else if (r.flags.includes('excused')) ev.push({ g: 'late', sev: 'info', text: L('اتأخر بإذن', 'Late with permission'), sub: `${L('حضر', 'In at')} ${fmtTime(rec.checkInMs)}` });
  if (r.early) ev.push({ g: 'early', sev: 'warn', text: L(`مشي بدري ${fmtMin(r.early)}`, `Left ${fmtMin(r.early)} early`), sub: `${L('انصرف', 'Out at')} ${fmtTime(rec.checkOutMs)}${r.plan.end ? ` · ${L('ميعاده', 'due')} ${r.plan.end}` : ''} · ${times(nth(z => z.early > 0))}` });
  if (r.short) ev.push({ g: 'early', sev: r.short.response === 'refused' ? 'bad' : 'warn', text: L(`ساعاته الفعلية ناقصة ${fmtHours(r.short.missingMs)}`, `Short of actual hours by ${fmtHours(r.short.missingMs)}`),
    sub: `${L(`اشتغل ${fmtHours(r.short.workedMs)} من ${fmtHours(r.short.requiredMs)}`, `worked ${fmtHours(r.short.workedMs)} of ${fmtHours(r.short.requiredMs)}`)} · ${r.short.response === 'refused' ? L('اعترض', 'objected') + (r.short.note ? `: ${r.short.note}` : '') : L('وافق', 'accepted')}` });
  if (r.status === 'absent') ev.push({ g: 'absent', sev: 'bad', text: L('غياب من غير إذن', 'Absent without leave'), sub: times(nth(z => z.status === 'absent')) });
  if (r.status === 'today' && isWorkingPlan(r.plan)) {
    const due = dueBy(r.plan, date);
    if (due && now() > due) ev.push({ g: 'absent', sev: 'bad', text: L('لسه ماجاش', 'Not in yet'), sub: L(`كان المفروض يبدأ بحد أقصى ${fmtTime(due)}`, `was due by ${fmtTime(due)}`) });
  }
  if (rec.checkInMs && rec.mode === 'remote' && isWorkingPlan(r.plan) && r.plan.mode !== 'remote') {
    const rq = mine.filter(q => q.type === 'remote');
    const state = rq.some(q => q.status === 'approved') ? 'approved' : (rec.remotePending || rq.some(q => String(q.status).startsWith('pending')) ? 'pending' : (rq.some(q => q.status === 'rejected') ? 'rejected' : 'none'));
    const sub = { approved: L('بموافقة', 'approved'), pending: L('من غير موافقة — الطلب لسه مستني', 'not approved — the request is pending'), rejected: L('طلب الأونلاين اترفض', 'the remote request was rejected'), none: L('من غير طلب', 'without a request') }[state];
    ev.push({ g: 'place', sev: state === 'approved' ? 'info' : 'bad', text: L('اشتغل أونلاين ويومه مقر', 'Worked remote on an office day'), sub: `${sub} · ${times(nth(z => z.rec && z.rec.mode === 'remote' && z.plan.mode !== 'remote' && isWorkingPlan(z.plan)))}` });
  }
  if (rec.checkInMs && rec.mode === 'remote' && r.plan.mode === 'remote' && r.plan.requestId) ev.push({ g: 'place', sev: 'info', text: L('أونلاين بموافقة', 'Remote, approved'), sub: L(`يومه الأصلي مقر · ${nth(z => z.rec && z.rec.mode === 'remote')} يوم أونلاين الشهر ده`, `normally an office day · ${nth(z => z.rec && z.rec.mode === 'remote')} remote days this month`) });
  if (rec.checkInMs && rec.mode === 'office' && r.plan.mode === 'remote') ev.push({ g: 'place', sev: 'info', text: L('جه المقر ويومه أونلاين', 'Came to the office on a remote day'), sub: '' });
  if (r.flags.includes('extra-day')) {
    const ot = requests.find(q => q.type === 'overtime' && q.email === p.email && q.startDate === date);
    const kind = r.plan.mode === 'leave' ? leaveTypeLabel(r.plan.leaveType) : (r.plan.mode === 'holiday' && r.plan.name ? r.plan.name : modeLabel(r.plan.mode));
    ev.push({ g: 'overtime', sev: 'ok', text: L(`اشتغل ${fmtHours(work)} في ${kind}`, `Worked ${fmtHours(work)} on ${kind}`), sub: ot ? `${L('طلب أوفر تايم', 'Overtime request')}: ${statusLabel(ot.status)}${ot.amount != null ? ` · ${num(ot.amount)} ${L('ج.م', 'EGP')}` : ''}` : (live && COUNTED.includes(p.status) ? L('لسه شغال', 'still working') : L('مفيش طلب أوفر تايم', 'no overtime request')) });
  }
  if (r.flags.includes('forgot')) ev.push({ g: 'other', sev: 'warn', text: L('نسي ينهي اليوم', 'Did not end the day'), sub: L('اتقفل تلقائياً على ميعاد الانصراف', 'closed automatically at the planned end') });
  const bmax = Number(policy.breakMaxMinutes) || 0;
  if (bmax && brk > bmax * 60000) ev.push({ g: 'other', sev: 'warn', text: L(`استراحة طويلة ${fmtHours(brk)}`, `Long break ${fmtHours(brk)}`), sub: L(`المسموح ${bmax} دقيقة`, `${bmax} min allowed`) });
  if (r.flags.includes('corrected')) ev.push({ g: 'other', sev: 'info', text: L('اليوم متعدّل من HR', 'Day corrected by HR'), sub: rec.correctionNote || '' });
  if (live && COUNTED.includes(p.status) && isWorkingPlan(r.plan) && r.plan.end && now() > cairoMs(date, r.plan.end) + 3600000) ev.push({ g: 'other', sev: 'info', text: L('لسه شغال بعد ميعاد الانصراف', 'Still working after the end of the day'), sub: L(`ميعاده ${r.plan.end}`, `due out ${r.plan.end}`) });
  if (r.status === 'leave' && rec.checkInMs === undefined && mine.some(q => q.type === 'leave' && String(q.status).startsWith('pending'))) ev.push({ g: 'other', sev: 'info', text: L('إجازة لسه مستنية موافقة', 'Leave still pending'), sub: '' });
  return { p, r, rec, live, work, brk, ev };
}

export default async function render(root) {
  startTasks();
  let ym = ymd(now()).slice(0, 7), week = 0, dept = '', data = null, sortBy = 'late', todos = [], unTodo = null;
  let tab = 'day', day = dayKey(now()), grp = '';
  const watchTodo = () => { if (unTodo) unTodo(); unTodo = watchMonth(ym, rows => { todos = rows; draw(); }); };
  const scopeAll = isAdmin() || isHR();
  root.innerHTML = `<div class="page-head"><div><h2>${L('الداشبورد', 'Dashboard')}</h2><p>${scopeAll ? L('الشركة كلها', 'The whole company') : L('فريقك', 'Your team')}</p></div>
      <div class="row gap-8 wrap"><div class="seg" id="tabs"><button type="button" data-tab="day"><i class="fas fa-calendar-day"></i>${L('اليوم', 'Day')}</button><button type="button" data-tab="month"><i class="fas fa-calendar"></i>${L('الشهر', 'Month')}</button></div>
        <select class="select" id="dept" style="min-width:160px;width:auto"></select><input class="input" type="date" id="day" style="width:auto"><span id="period"></span></div></div>
    <div id="dash">${loader()}</div>`;
  const $ = (s) => root.querySelector(s);

  async function load() {
    $('#dash').innerHTML = loader();
    try { data = await teamMonth(ym); } catch (e) { $('#dash').innerHTML = `<div class="card">${empty('fa-triangle-exclamation', L('تعذّر تحميل البيانات', 'Could not load data'), esc(e.message || ''))}</div>`; return; }
    const depts = [...new Set(data.people.map(x => x.person.department || L('بدون قسم', 'No department')))].sort((a, b) => a.localeCompare(b, 'ar'));
    $('#dept').innerHTML = `<option value="">${L('كل الأقسام', 'All departments')}</option>${depts.map(d => `<option ${d === dept ? 'selected' : ''}>${esc(d)}</option>`).join('')}`;
    draw();
  }

  function draw() {
    root.querySelectorAll('#tabs [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    $('#period').classList.toggle('hidden', tab !== 'month');
    $('#day').classList.toggle('hidden', tab !== 'day');
    $('#day').max = dayKey(now()); if ($('#day').value !== day) $('#day').value = day;
    if (tab === 'day') { drawDay(); return; }
    $('#period').innerHTML = periodPicker(ym, week, { ahead: 0 });
    if (!data) return;
    const range = periodRange(ym, week);
    const rows = data.people.filter(x => !dept || (x.person.department || L('بدون قسم', 'No department')) === dept);
    if (!rows.length) { $('#dash').innerHTML = `<div class="card">${empty('fa-users', L('مفيش موظفين', 'No employees'))}</div>`; return; }
    const tasks = allTasks();
    const per = rows.map(x => {
      const t = week ? summarize(x.rows.filter(r => r.date >= range.from && r.date <= range.to)) : x.totals;   // attendance of that week only
      const td = todos.filter(k => k.owner === x.person.email && k.date >= range.from && k.date <= range.to);
      return { p: x.person, t, hrs: avgHours(t), tk: taskStats(tasks.filter(k => k.assignee === x.person.email), range), td: td.length ? Math.round(td.filter(k => k.done).length / td.length * 100) : null, tdN: td.length };
    });
    const sum = (f) => per.reduce((s, x) => s + f(x), 0);
    const present = sum(x => x.t.present), absent = sum(x => x.t.absent), lateDays = sum(x => x.t.lateDays), lateMin = sum(x => x.t.lateMinutes);
    const commit = Math.round(sum(x => x.t.commitment) / per.length);
    const hrs = present ? sum(x => x.t.workMs + x.t.meetingMs) / present : 0;
    const allTk = taskStats(tasks.filter(k => per.some(x => x.p.email === k.assignee)), range);
    const tile = (icon, cls, label, value, hint = '') => `<div class="card stat"><div class="label"><span class="icon-tile ${cls}"><i class="fas ${icon}"></i></span>${esc(label)}</div><div class="value">${value}</div>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;

    // by department
    const byDept = {};
    per.forEach(x => { const d = x.p.department || L('بدون قسم', 'No department'); (byDept[d] = byDept[d] || []).push(x); });
    const deptRows = Object.entries(byDept).map(([d, xs]) => {
      const pr = xs.reduce((s, x) => s + x.t.present, 0);
      return { d, n: xs.length, commit: Math.round(xs.reduce((s, x) => s + x.t.commitment, 0) / xs.length), absent: xs.reduce((s, x) => s + x.t.absent, 0), lateMin: xs.reduce((s, x) => s + x.t.lateMinutes, 0), lateDays: xs.reduce((s, x) => s + x.t.lateDays, 0), hrs: pr ? xs.reduce((s, x) => s + x.t.workMs + x.t.meetingMs, 0) / pr : 0, tk: taskStats(tasks.filter(k => xs.some(x => x.p.email === k.assignee)), ym) };
    }).sort((a, b) => b.n - a.n);
    const maxHrs = Math.max(1, ...deptRows.map(r => r.hrs));

    // leaders' task delivery
    const leaders = [...new Set(tasks.map(k => k.leader).filter(Boolean))].filter(e => scopeAll || e === session.email);
    const leaderRows = leaders.map(e => ({ e, tk: taskStats(tasks.filter(k => k.leader === e), range) })).filter(r => r.tk.total).sort((a, b) => b.tk.total - a.tk.total);

    const topLate = per.filter(x => x.t.lateMinutes > 0).sort((a, b) => b.t.lateMinutes - a.t.lateMinutes).slice(0, 5);
    const topGood = per.filter(x => x.t.present > 0).sort((a, b) => b.t.commitment - a.t.commitment || a.t.lateMinutes - b.t.lateMinutes || b.hrs - a.hrs).slice(0, 5);
    const sorters = { todo: (a, b) => (a.td ?? 101) - (b.td ?? 101), late: (a, b) => b.t.lateMinutes - a.t.lateMinutes, absent: (a, b) => b.t.absent - a.t.absent, hours: (a, b) => b.hrs - a.hrs, commit: (a, b) => a.t.commitment - b.t.commitment, tasks: (a, b) => b.tk.lateOpen - a.tk.lateOpen || a.tk.rate - b.tk.rate, name: (a, b) => (a.p.name || '').localeCompare(b.p.name || '', 'ar') };
    const link = (p) => isAdmin() ? `#/stats/${encodeURIComponent(p.email)}` : (isHR() ? `#/employees/${encodeURIComponent(p.email)}` : `#/reports`);
    const th = (k, t) => `<th class="${k === 'name' ? '' : 'num'}"><button class="db-sort ${sortBy === k ? 'on' : ''}" data-sort="${k}">${t}${sortBy === k ? ' <i class="fas fa-arrow-down-short-wide"></i>' : ''}</button></th>`;

    $('#dash').innerHTML = `
      <div class="grid g-4 keep-2 mb-16">
        ${tile('fa-user-check', 'ok', L('نسبة الالتزام', 'Commitment'), `${commit}<small>%</small>`, L(`${num(present)} يوم حضور`, `${num(present)} days present`))}
        ${tile('fa-user-xmark', 'bad', L('أيام الغياب', 'Absent days'), num(absent), L(`${num(sum(x => x.t.leave))} يوم إجازة`, `${num(sum(x => x.t.leave))} leave days`))}
        ${tile('fa-clock', 'warn', L('التأخير', 'Lateness'), `${esc(fmtMin(lateMin))}`, L(`في ${num(lateDays)} يوم`, `on ${num(lateDays)} days`))}
        ${tile('fa-business-time', 'info', L('ساعات العمل الفعلية', 'Actual work hours'), esc(fmtHours(hrs)), L('متوسط اليوم (شغل + اجتماعات)', 'Daily average (work + meetings)'))}
        ${tile('fa-clipboard-check', 'ok', L('إنجاز التاسكات', 'Task completion'), `${allTk.rate}<small>%</small>`, L(`${allTk.done} خلصت · ${allTk.open} مفتوحة`, `${allTk.done} done · ${allTk.open} open`))}
        ${tile('fa-stopwatch', '', L('التسليم في الميعاد', 'Delivered on time'), `${allTk.onTimeRate}<small>%</small>`, L(`${allTk.onTime} من ${allTk.done}`, `${allTk.onTime} of ${allTk.done}`))}
        ${tile('fa-triangle-exclamation', 'bad', L('تاسكات متأخرة', 'Late tasks'), num(allTk.lateOpen), L('مفتوحة وعدّى ميعادها', 'Open and past due'))}
        ${tile('fa-house-laptop', 'brand', L('أيام أونلاين', 'Remote days'), num(sum(x => x.t.remote)), L(`${num(sum(x => x.t.forgot))} يوم نسيوا يقفلوه`, `${num(sum(x => x.t.forgot))} days not ended`))}
      </div>
      <div class="grid mb-16" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px">
        <section class="card"><div class="card-head"><h3><i class="fas fa-clock" style="color:var(--bad)"></i> ${L('أكتر الناس تأخيراً', 'Most late')}</h3></div><div class="card-body db-rank">
          ${topLate.map((x, i) => `<a class="db-rank-row" href="${link(x.p)}"><span class="num db-pos">${i + 1}</span>${avatar(x.p, 'sm')}<span class="grow min0"><b class="truncate">${esc(x.p.name || x.p.email)}</b><small>${esc(x.p.department || '')}</small></span><span class="num bad-txt">${esc(fmtMin(x.t.lateMinutes))}<small> / ${x.t.lateDays} ${L('يوم', 'd')}</small></span></a>`).join('') || `<p class="muted small">${L('مفيش تأخير الشهر ده 👌', 'No lateness this month 👌')}</p>`}</div></section>
        <section class="card"><div class="card-head"><h3><i class="fas fa-award" style="color:var(--ok)"></i> ${L('الأكتر التزاماً', 'Most committed')}</h3></div><div class="card-body db-rank">
          ${topGood.map((x, i) => `<a class="db-rank-row" href="${link(x.p)}"><span class="num db-pos">${i + 1}</span>${avatar(x.p, 'sm')}<span class="grow min0"><b class="truncate">${esc(x.p.name || x.p.email)}</b><small>${esc(x.p.department || '')}</small></span><span class="num ok-txt">${x.t.commitment}%<small> · ${esc(fmtHours(x.hrs))}</small></span></a>`).join('') || `<p class="muted small">—</p>`}</div></section>
      </div>
      <section class="card mb-16"><div class="card-head"><h3><i class="fas fa-building"></i> ${L('مقارنة الأقسام', 'Departments')}</h3></div><div class="table-wrap"><table class="table">
        <thead><tr><th>${L('القسم', 'Department')}</th><th class="num">${L('موظفين', 'People')}</th><th class="num">${L('الالتزام', 'Commitment')}</th><th class="num">${L('غياب', 'Absent')}</th><th class="num">${L('التأخير', 'Late')}</th><th>${L('ساعات العمل / يوم', 'Hours / day')}</th><th class="num">${L('إنجاز التاسكات', 'Tasks done')}</th></tr></thead>
        <tbody>${deptRows.map(r => `<tr><td><b>${esc(r.d)}</b></td><td class="num">${r.n}</td><td class="num"><span class="db-pill ${r.commit >= 95 ? 'ok' : r.commit >= 85 ? 'warn' : 'bad'}">${r.commit}%</span></td><td class="num">${r.absent}</td><td class="num">${esc(fmtMin(r.lateMin))}</td>
          <td><div class="db-bar"><span style="width:${Math.round(r.hrs / maxHrs * 100)}%"></span><small class="num">${esc(fmtHours(r.hrs))}</small></div></td><td class="num">${r.tk.total ? `${r.tk.rate}%` : '—'}</td></tr>`).join('')}</tbody></table></div></section>
      ${leaderRows.length ? `<section class="card mb-16"><div class="card-head"><h3><i class="fas fa-user-tie"></i> ${L('التاسكات حسب الليدر', 'Tasks by leader')}</h3></div><div class="table-wrap"><table class="table">
        <thead><tr><th>${L('الليدر', 'Leader')}</th><th class="num">${L('تاسكات', 'Tasks')}</th><th class="num">${L('خلصت', 'Done')}</th><th class="num">${L('مفتوحة', 'Open')}</th><th class="num">${L('متأخرة', 'Late')}</th><th class="num">${L('الإنجاز', 'Completion')}</th><th class="num">${L('في الميعاد', 'On time')}</th></tr></thead>
        <tbody>${leaderRows.map(r => { const p = person(r.e) || { email: r.e, name: nameOf(r.e) }; return `<tr><td><span class="tk-who">${avatar(p, 'xs')}<b>${esc(p.name || r.e)}</b></span></td><td class="num">${r.tk.total}</td><td class="num">${r.tk.done}</td><td class="num">${r.tk.open}</td><td class="num ${r.tk.lateOpen ? 'bad-txt' : ''}">${r.tk.lateOpen}</td><td class="num">${r.tk.rate}%</td><td class="num">${r.tk.done ? r.tk.onTimeRate + '%' : '—'}</td></tr>`; }).join('')}</tbody></table></div></section>` : ''}
      <section class="card"><div class="card-head"><h3><i class="fas fa-users"></i> ${L('كل الموظفين', 'Everyone')}</h3><span class="xs muted">${L('اضغط على عنوان العمود للترتيب', 'Click a column title to sort')}</span></div><div class="table-wrap"><table class="table">
        <thead><tr>${th('name', L('الموظف', 'Employee'))}${th('commit', L('الالتزام', 'Commitment'))}${th('absent', L('غياب', 'Absent'))}${th('late', L('التأخير', 'Late'))}${th('hours', L('ساعات / يوم', 'Hours / day'))}${th('tasks', L('التاسكات', 'Tasks'))}${th('todo', 'To-Do')}</tr></thead>
        <tbody>${per.slice().sort(sorters[sortBy]).map(x => `<tr><td><a class="tk-who" href="${link(x.p)}" style="color:inherit">${avatar(x.p, 'xs')}<span><b>${esc(x.p.name || x.p.email)}</b><small class="muted"> · ${esc(x.p.department || '')}</small></span></a></td>
          <td class="num"><span class="db-pill ${x.t.commitment >= 95 ? 'ok' : x.t.commitment >= 85 ? 'warn' : 'bad'}">${x.t.commitment}%</span></td><td class="num">${x.t.absent}</td><td class="num">${x.t.lateMinutes ? `${esc(fmtMin(x.t.lateMinutes))} <small class="muted">(${x.t.lateDays})</small>` : '—'}</td>
          <td class="num">${x.t.present ? esc(fmtHours(x.hrs)) : '—'}</td><td class="num">${x.tk.total ? `${x.tk.done}/${x.tk.done + x.tk.open}${x.tk.lateOpen ? ` <span class="bad-txt">· ${x.tk.lateOpen} ${L('متأخر', 'late')}</span>` : ''}` : '—'}</td>
          <td class="num">${x.td === null ? '—' : `<a href="#/todo/${encodeURIComponent(x.p.email)}">${x.td}%</a> <small class="muted">(${x.tdN})</small>`}</td></tr>`).join('')}</tbody></table></div></section>`;
  }

  function drawDay() {
    if (!data) return;
    const rows = data.people.filter(x => !dept || (x.person.department || L('بدون قسم', 'No department')) === dept);
    if (!rows.length) { $('#dash').innerHTML = `<div class="card">${empty('fa-users', L('مفيش موظفين', 'No employees'))}</div>`; return; }
    const isToday = day === dayKey(now());
    const days = rows.map(x => dayOf(x, day, data)).filter(Boolean).filter(d => !d.r.flags.includes('untracked'));
    const evs = days.flatMap(d => d.ev.map(e => ({ ...e, d })));
    const by = (g) => evs.filter(e => e.g === g);
    const working = days.filter(d => isWorkingPlan(d.r.plan) || d.rec.checkInMs);
    const inNow = days.filter(d => d.live && COUNTED.includes(d.p.status)).length;
    const came = days.filter(d => d.rec.checkInMs);
    const office = came.filter(d => d.rec.mode !== 'remote').length, remote = came.length - office;
    const absent = by('absent').length, leave = days.filter(d => d.r.status === 'leave').length;
    const late = by('late').filter(e => e.sev === 'bad').length, early = new Set(by('early').map(e => e.d.p.email)).size;
    const hrsAvg = came.length ? came.reduce((s, d) => s + d.work, 0) / came.length : 0;
    const tile = (icon, cls, label, value, hint = '', g = '') => `<div class="card stat ${g ? 'db-tile' : ''}" ${g ? `data-grp="${g}" role="button" tabindex="0" style="cursor:pointer;${grp === g ? 'outline:2px solid var(--brand)' : ''}"` : ''}><div class="label"><span class="icon-tile ${cls}"><i class="fas ${icon}"></i></span>${esc(label)}</div><div class="value">${value}</div>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
    const chip = (e) => `<span class="badge ${e.sev === 'neutral' ? '' : e.sev} xs" title="${esc(e.sub || '')}">${esc(e.text)}</span>`;
    const link = (p) => isAdmin() ? `#/stats/${encodeURIComponent(p.email)}` : (isHR() ? `#/employees/${encodeURIComponent(p.email)}` : `#/reports`);
    const groups = DAY_GROUPS.map(([g, icon, cls, ar, en]) => {
      const list = by(g);
      return `<section class="card db-day-grp" data-g="${g}"><div class="card-head"><h3><span class="icon-tile ${cls}"><i class="fas ${icon}"></i></span> ${esc(L(ar, en))} <span class="badge ${list.length ? cls : ''} num">${list.length}</span></h3>
        ${list.length ? `<button class="btn btn-ghost btn-sm" data-grp="${g}">${grp === g ? L('عرض الكل', 'Show all') : L('فلتر الجدول', 'Filter table')}</button>` : ''}</div>
        <div class="card-body db-rank">${list.length ? list.map(e => `<a class="db-rank-row" href="${link(e.d.p)}">${avatar(e.d.p, 'sm')}<span class="grow min0"><b class="truncate">${esc(e.d.p.name || e.d.p.email)}</b><small>${esc(e.sub || e.d.p.department || '')}</small></span><span class="badge ${e.sev === 'neutral' ? '' : e.sev}">${esc(e.text)}</span></a>`).join('')
          : `<p class="muted small">${L('مفيش 👌', 'None 👌')}</p>`}</div></section>`;
    }).join('');
    const tableRows = days.filter(d => !grp || d.ev.some(e => e.g === grp))
      .sort((a, b) => b.ev.filter(e => e.sev === 'bad').length - a.ev.filter(e => e.sev === 'bad').length || b.ev.length - a.ev.length || (a.p.name || '').localeCompare(b.p.name || '', 'ar'));
    const dash = '<span class="muted">—</span>';
    const stBadge = (d) => {
      if (d.live) return presenceBadge(d.p.status);
      const m = STATUS_DAY[d.r.status] || STATUS_DAY.none;
      const label = d.r.status === 'leave' ? leaveTypeLabel(d.r.plan.leaveType) : (L(m.ar, m.en) || modeLabel(d.r.plan.mode));
      return `<span class="badge ${d.r.status === 'today' && d.ev.some(e => e.g === 'absent') ? 'bad' : m.badge}">${esc(d.r.status === 'today' ? (d.ev.some(e => e.g === 'absent') ? L('ماجاش', 'Not in') : L('لسه', 'Not yet')) : label)}</span>`;
    };
    $('#dash').innerHTML = `
      <div class="row between mb-16" style="flex-wrap:wrap;gap:8px"><h3 style="font-size:16px"><i class="fas fa-calendar-day"></i> ${esc(fmtDay(day))}${isToday ? ` <span class="badge brand">${L('النهارده', 'Today')}</span>` : ''}</h3>
        <span class="small muted">${L(`${evs.length} حاجة غير معتادة`, `${evs.length} unusual events`)}${grp ? ` · <button class="btn btn-ghost btn-sm" data-grp="">${L('إلغاء الفلتر', 'Clear filter')}</button>` : ''}</span></div>
      <div class="grid g-4 keep-2 mb-16" id="day-tiles">
        ${tile('fa-user-check', 'ok', L('حضروا', 'Came in'), `${num(came.length)}<small>/ ${num(working.length)}</small>`, L(`${office} مقر · ${remote} أونلاين`, `${office} office · ${remote} remote`))}
        ${tile('fa-signal', 'brand', isToday ? L('شغالين دلوقتي', 'Working now') : L('متوسط ساعات الشغل', 'Average hours'), isToday ? num(inNow) : esc(fmtHours(hrsAvg)), isToday ? L(`متوسط الشغل ${fmtHours(hrsAvg)}`, `avg ${fmtHours(hrsAvg)} worked`) : '')}
        ${tile('fa-user-xmark', 'bad', L('غياب', 'Absent'), num(absent), L(`${leave} في إجازة`, `${leave} on leave`), 'absent')}
        ${tile('fa-clock', 'bad', L('تأخيرات', 'Late'), num(late), L(`إجمالي ${fmtMin(days.reduce((s, d) => s + (d.r.late || 0), 0))}`, `${fmtMin(days.reduce((s, d) => s + (d.r.late || 0), 0))} in total`), 'late')}
        ${tile('fa-door-open', 'warn', L('مشيوا بدري / ناقص', 'Early / short'), num(early), '', 'early')}
        ${tile('fa-shuffle', 'info', L('عكس الجدول', 'Against the plan'), num(by('place').length), L('أونلاين بدل مقر أو العكس', 'remote instead of office or back'), 'place')}
        ${tile('fa-business-time', 'ok', L('شغل في إجازة', 'Worked a day off'), num(by('overtime').length), L('أوفر تايم', 'overtime'), 'overtime')}
        ${tile('fa-circle-exclamation', '', L('حاجات تانية', 'Other'), num(by('other').length), L('نسي يقفل، استراحة طويلة…', 'not ended, long break…'), 'other')}
      </div>
      <div class="grid mb-16" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px" id="day-groups">${groups}</div>
      <section class="card"><div class="card-head"><h3><i class="fas fa-users"></i> ${L('يوم كل موظف', "Everyone's day")}</h3>${grp ? `<span class="badge brand">${esc(L(...DAY_GROUPS.find(x => x[0] === grp).slice(3)))}</span>` : ''}</div>
        <div class="table-wrap"><table class="table" id="day-table">
        <thead><tr><th>${L('الموظف', 'Employee')}</th><th>${L('الخطة', 'Plan')}</th><th>${L('الحالة', 'Status')}</th><th class="num">${L('حضور', 'In')}</th><th class="num">${L('انصراف', 'Out')}</th><th class="num">${L('شغل', 'Work')}</th><th class="num">${L('استراحة', 'Break')}</th><th>${L('غير معتاد', 'Unusual')}</th></tr></thead>
        <tbody>${tableRows.map(d => `<tr data-email="${esc(d.p.email)}"><td><a class="tk-who" href="${link(d.p)}" style="color:inherit">${avatar(d.p, 'xs')}<span><b>${esc(d.p.name || d.p.email)}</b><small class="muted"> · ${esc(d.p.department || '')}</small></span></a></td>
          <td class="small">${esc(modeLabel(d.r.plan.mode))}${d.r.plan.start && isWorkingPlan(d.r.plan) ? ` <span class="muted num">${esc(d.r.plan.shift ? shiftLabel(d.r.plan.shift) : `${d.r.plan.start}–${d.r.plan.end}`)}</span>` : ''}</td>
          <td>${stBadge(d)}${d.rec.checkInMs ? ` <span class="badge xs">${esc(modeLabel(d.rec.mode || 'office'))}</span>` : ''}</td>
          <td class="num ${d.r.late ? 'bad-txt' : ''}">${d.rec.checkInMs ? esc(fmtTime(d.rec.checkInMs)) : dash}</td>
          <td class="num ${d.r.early ? 'bad-txt' : ''}">${d.rec.checkOutMs ? esc(fmtTime(d.rec.checkOutMs)) : (d.live ? `<span class="badge ok xs">${L('شغال', 'Working')}</span>` : dash)}</td>
          <td class="num">${d.work ? esc(fmtHours(d.work)) : dash}</td><td class="num">${d.brk ? esc(fmtHours(d.brk)) : dash}</td>
          <td><div class="row-wrap" style="gap:4px">${d.ev.map(chip).join('') || '<span class="muted xs">—</span>'}</div></td></tr>`).join('') || `<tr><td colspan="8">${empty('fa-filter', L('مفيش حد', 'Nobody'))}</td></tr>`}</tbody></table></div></section>`;
  }

  async function setDay(v) {
    if (!v || v > dayKey(now())) return;
    day = v; grp = '';
    if (v.slice(0, 7) !== ym) { ym = v.slice(0, 7); week = 0; watchTodo(); await load(); } else draw();
  }

  root.addEventListener('change', (e) => {
    if (e.target.matches('[data-pp-month]') && e.target.value) { ym = e.target.value; week = 0; watchTodo(); load(); }
    if (e.target.id === 'dept') { dept = e.target.value; draw(); }
    if (e.target.id === 'day') setDay(e.target.value);
  });
  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]'); if (t) {
      tab = t.dataset.tab;
      // back to the day view: its month
      if (tab === 'day' && day.slice(0, 7) !== ym) { ym = day.slice(0, 7); week = 0; watchTodo(); load(); return; }
      draw(); return;
    }
    const g = e.target.closest('[data-grp]'); if (g && tab === 'day') { e.preventDefault(); grp = grp === g.dataset.grp ? '' : g.dataset.grp; draw(); return; }
    const w = e.target.closest('[data-pp-week]'); if (w) { week = Number(w.dataset.ppWeek); draw(); return; }
    const s = e.target.closest('[data-sort]'); if (s) { sortBy = s.dataset.sort; draw(); }
  });
  const off = onTasks(() => { if (tab === 'month') draw(); });
  // today's view follows the live directory (who started, who went on a break…)
  const offDir = onDirectory(() => { if (tab === 'day' && day === dayKey(now())) draw(); });
  const iv = setInterval(() => { if (tab === 'day' && day === dayKey(now()) && document.visibilityState === 'visible') draw(); }, 60000);
  const onData = () => { if (tab === 'day') load(); };
  window.addEventListener('am:data-changed', onData);
  watchTodo();
  await load();
  return () => { off(); offDir(); clearInterval(iv); window.removeEventListener('am:data-changed', onData); if (unTodo) unTodo(); };
}
