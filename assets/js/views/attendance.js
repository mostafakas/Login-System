// My attendance — monthly totals, a row per day and day details. `personMonthView` is reused by HR.
import { L, esc, fmtTime, fmtHours, fmtMin, num, ym as ymOf, addMonths, fmtMonth, weekday, fmtDay, isAr, money } from '../core/utils.js';
import { modal, empty, loader, STATUS_META } from '../core/ui.js';
import { session, now, isAdmin } from '../core/session.js';
import { modeLabel, leaveTypeLabel, dayKey, shiftLabel, isWorkingPlan, REQUEST_STATUS, statusLabel } from '../core/policy.js';
import { person } from '../services/directory.js';
import { toMs, read } from '../core/fb.js';
import { salaryParts, isFreelancer, rulesOf, violationsFrom, priceViolations, violationText } from '../services/salary.js';
import { personMonth, STATUS_DAY } from '../services/reports.js';
import { dayLogs, scopeFor } from '../services/attendance.js';
import { openRequestForm } from './request-form.js';
import { fmtHMS } from '../services/overtime.js';

const DOW = () => isAr ? ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'] : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function statTiles(t) {
  const tile = (icon, cls, label, value, unit = '') => `<div class="card stat"><div class="label"><span class="icon-tile ${cls}"><i class="fas ${icon}"></i></span>${esc(label)}</div><div class="value">${value}${unit ? `<small>${esc(unit)}</small>` : ''}</div></div>`;
  return `<div class="grid g-4 keep-2">
    ${tile('fa-user-check', 'ok', L('أيام حضور', 'Days present'), num(t.present), L(`منها ${t.remote} أونلاين`, `${t.remote} remote`))}
    ${tile('fa-user-xmark', 'bad', L('غياب', 'Absent'), num(t.absent), L('يوم', 'days'))}
    ${tile('fa-clock', 'warn', L('إجمالي التأخير', 'Total lateness'), esc(fmtMin(t.lateMinutes)), L(`في ${t.lateDays} يوم`, `on ${t.lateDays} days`))}
    ${tile('fa-umbrella-beach', 'info', L('إجازات', 'Leave days'), num(t.leave), L('يوم', 'days'))}
    ${tile('fa-laptop-code', '', L('ساعات الشغل (شغل + اجتماعات)', 'Work hours (work + meetings)'), esc(fmtHours((t.workMs || 0) + (t.meetingMs || 0))))}
    ${tile('fa-mug-hot', 'warn', L('استراحات', 'Breaks'), esc(fmtHours(t.breakMs)))}
    ${tile('fa-door-open', 'neutral', L('انصراف مبكر', 'Early leave'), esc(fmtMin(t.earlyMinutes)))}
    ${tile('fa-chart-simple', t.commitment >= 90 ? 'ok' : (t.commitment >= 75 ? 'warn' : 'bad'), L('نسبة الالتزام', 'Commitment'), num(t.commitment), '%')}
  </div>${t.shortDays || t.extraDays ? `<div class="row-wrap mt-8" style="gap:6px">
    ${t.shortDays ? `<span class="badge warn"><i class="fas fa-hourglass-half"></i>${L(`${t.shortDays} يوم ساعاته الفعلية ناقصة (${fmtHours(t.shortMs)})`, `${t.shortDays} short day(s) (${fmtHours(t.shortMs)})`)}${t.shortRefused ? ` · ${L(`اعترض على ${t.shortRefused}`, `objected to ${t.shortRefused}`)}` : ''}</span>` : ''}
    ${t.extraDays ? `<span class="badge ok"><i class="fas fa-business-time"></i>${L(`شغل في ${t.extraDays} يوم إجازة (${fmtHours(t.extraMs)})`, `Worked ${t.extraDays} day(s) off (${fmtHours(t.extraMs)})`)}</span>` : ''}</div>` : ''}`;
}

/**
 * Admin only: the month in 3 parts — the shift's actual hours, overtime run on the shift counter (unpaid, nothing to approve),
 * and the overtime card's sessions (paid once the admin approves the request).
 */
export function splitHTML(s) {
  if (!s) return '';
  const tile = (icon, cls, label, hint, ms) => `<div class="card stat"><div class="label"><span class="icon-tile ${cls}"><i class="fas ${icon}"></i></span>${esc(label)}</div><div class="value">${esc(fmtHMS(ms))}</div><div class="hint">${esc(hint)}</div></div>`;
  const rows = (s.card || []).map(d => {
    const rq = d.request, st = rq ? REQUEST_STATUS[rq.status] || {} : null;
    return `<tr><td class="nowrap num">${esc(d.date)}</td>
      <td>${esc(d.taskTitle || '—')}${d.taskNum ? ` <span class="xs muted num">#${esc(d.taskNum)}</span>` : ''}${d.autoClosed ? ` <span class="badge warn xs" title="${L('نسي ينهي العداد', 'Counter was not ended')}">${L('اتقفل تلقائياً', 'Auto-closed')}</span>` : ''}</td>
      <td class="num nowrap">${d.startMs ? esc(fmtTime(d.startMs)) : '—'}</td><td class="num nowrap">${d.endMs ? esc(fmtTime(d.endMs)) : (d.closed ? '—' : `<span class="badge ok xs">${L('شغال', 'Running')}</span>`)}</td>
      <td class="num">${d.allotMs ? esc(fmtHMS(d.allotMs)) : '—'}</td><td class="num"><b>${esc(fmtHMS(d.workMs))}</b></td><td class="num">${esc(fmtHMS(d.breakMs))}</td>
      <td>${rq ? `<span class="badge ${st.cls || ''}">${esc(statusLabel(rq.status))}</span>` : '—'}</td>
      <td class="num">${rq && rq.amount != null ? esc(money(rq.amount)) : '—'}</td></tr>`;
  }).join('');
  return `<div class="card mt-16"><div class="card-head"><h3><i class="fas fa-business-time"></i> ${L('تقسيم وقت الشهر (للأدمن)', 'Month time split (admin)')}</h3></div>
    <div class="card-body"><div class="grid g-3 keep-2">
      ${tile('fa-briefcase', 'ok', L('وقت الشيفت الفعلي', "Shift's actual time"), L('الشغل الفعلي داخل ساعات الشيفت', 'Real work within the shift hours'), s.regularMs)}
      ${tile('fa-hourglass-end', 'warn', L('أوفر تايم على عداد الشيفت', 'Overtime on the shift counter'), L('استكمل بعد الشيفت من غير ما يقفل العداد · بدون مقابل', 'Kept the shift counter running · unpaid'), s.afterMs)}
      ${tile('fa-business-time', 'info', L('أوفر تايم التاسكات', 'Overtime tasks'), L('تاسكات اتحدد لها وقت · بتتحاسب بعد موافقتك', 'Tasks with allotted time · paid once you approve'), s.cardMs)}
    </div>
    ${rows ? `<div class="table-wrap mt-16"><table class="table"><thead><tr><th>${L('اليوم', 'Day')}</th><th>${L('التاسك', 'Task')}</th><th class="num">${L('بدأ', 'Start')}</th><th class="num">${L('انتهى', 'End')}</th><th class="num">${L('المحدد', 'Allotted')}</th><th class="num">${L('الشغل + الاجتماع', 'Work + meetings')}</th><th class="num">${L('الاستراحة', 'Break')}</th><th>${L('الطلب', 'Request')}</th><th class="num">${L('المبلغ', 'Amount')}</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}</div></div>`;
}

/** Day-type filters over the month table: office, remote, leave and absence days */
export const DAY_FILTERS = [
  ['all', 'fa-list', 'الكل', 'All', () => true],
  ['office', 'fa-building', 'المقر', 'Office', r => r.status === 'present'],
  ['remote', 'fa-laptop-house', 'أونلاين', 'Remote', r => r.status === 'remote'],
  ['leave', 'fa-umbrella-beach', 'إجازات', 'Leave', r => r.status === 'leave'],
  ['absent', 'fa-user-xmark', 'غياب', 'Absent', r => r.status === 'absent']
];
/**
 * A day HR / a manager corrected by hand: who did it, and which of check-in / check-out changed (with the time it had before).
 * null = not corrected. in / out = the previous time (ms, or 0 when there was none), undefined = that one did not change.
 */
export function editInfo(r) {
  const rec = (r && r.rec) || {};
  if (!r || !r.flags.includes('corrected')) return null;
  const by = rec.correctedBy ? ((person(rec.correctedBy) || {}).name || rec.correctedBy) : '';
  const pv = rec.previous;
  const was = (k) => (pv && (pv[k] || 0) !== (rec[k] || 0) ? (pv[k] || 0) : undefined);
  return { by, note: rec.correctionNote || '', in: was('checkInMs'), out: was('checkOutMs') };
}
const editTitle = (ed, prev) => [L('اتعدل يدوي', 'Edited by hand') + (ed.by ? ` ${L('من', 'by')} ${ed.by}` : ''),
  prev !== undefined ? `${L('كان', 'was')} ${prev ? fmtTime(prev) : '—'}` : '', ed.note].filter(Boolean).join(' · ');
const visibleDays = (rows) => { const todayKey = dayKey(now()); return rows.filter(r => r.date <= todayKey && r.status !== 'future'); };

/** The filter buttons, each with how many days of the month it matches */
export function dayFilterHTML(rows, filter = 'all') {
  const days = visibleDays(rows);
  return `<div class="seg day-filter" role="group" aria-label="${L('فلتر الأيام', 'Filter days')}" style="flex-wrap:wrap;max-width:100%">${DAY_FILTERS.map(([k, ic, ar, en, fn]) =>
    `<button type="button" data-f="${k}" class="${k === filter ? 'on' : ''}" aria-pressed="${k === filter}"><i class="fas ${ic}"></i>${esc(L(ar, en))} <span class="badge xs num">${days.filter(fn).length}</span></button>`).join('')}</div>`;
}

/**
 * The month as a table: one row per day up to today — check-in, check-out, work (working + meetings),
 * meetings, breaks, lateness and early leave — with the month's totals at the bottom.
 */
export function dayTableHTML(rows, filter = 'all') {
  const todayKey = dayKey(now());
  const f = DAY_FILTERS.find(x => x[0] === filter) || DAY_FILTERS[0];
  const shown = visibleDays(rows).filter(f[4]);
  if (!shown.length) return f[0] === 'all' ? empty('fa-calendar', L('مفيش أيام لسه في الشهر ده', 'No days yet this month'))
    : empty('fa-filter', L(`مفيش أيام «${f[2]}» في الشهر ده`, `No "${f[3]}" days this month`));
  const dash = '<span class="muted">—</span>';
  const tm = (ms) => ms ? esc(fmtTime(ms)) : dash;
  // a pen next to a time HR / the manager changed by hand
  const pen = (ed, prev) => ed && prev !== undefined ? ` <span class="badge info xs edited-time" title="${esc(editTitle(ed, prev))}"><i class="fas fa-user-pen"></i></span>` : '';
  const hrs = (ms) => ms ? esc(fmtHours(ms)) : dash;
  const tot = { work: 0, meet: 0, brk: 0, late: 0, early: 0 };
  const body = shown.map(r => {
    const meta = STATUS_DAY[r.status] || STATUS_DAY.none;
    const rec = r.rec || {};
    const work = (r.workMs || 0) + (r.meetingMs || 0);       // meetings count as work time
    tot.work += work; tot.meet += r.meetingMs || 0; tot.brk += r.breakMs || 0; tot.late += r.late || 0; tot.early += r.early || 0;
    const idle = !rec.checkInMs && ['off', 'holiday', 'none'].includes(r.status);
    let label = L(meta.ar, meta.en) || modeLabel(r.plan.mode);
    if (r.status === 'leave') label = leaveTypeLabel(r.plan.leaveType || rec.leaveType);
    else if (r.status === 'holiday' && r.plan.name) label = r.plan.name;
    const ed = editInfo(r);
    const tags = [
      r.plan.shift && rec.checkInMs ? `<span class="badge info xs"${r.flags.includes('shift-guessed') ? ` title="${L('اليوم اتسجل من غير شيفت، فاتحسب على الشيفت اللي يناسب ميعاد حضوره', 'Saved without a shift: counted on the shift the check-in fits')}"` : ''}>${esc(shiftLabel(r.plan.shift))}${r.flags.includes('shift-guessed') ? ` ${L('(حسب الحضور)', '(by check-in)')}` : ''}</span>` : '',
      // no shift picked (fixed / company hours): the hours lateness and early leave are measured against
      !r.plan.shift && rec.checkInMs && isWorkingPlan(r.plan) && r.plan.start ? `<span class="badge xs num" dir="ltr" title="${L('مواعيد ثابتة (من غير اختيار شيفت)', 'Fixed hours (no shift picked)')}">${esc(r.plan.start)}–${esc(r.plan.end)}</span>` : '',
      ed ? `<span class="badge info xs edited-day" title="${esc(editTitle(ed))}"><i class="fas fa-user-pen"></i>${L('تعديل يدوي', 'Edited')}${ed.by ? ` · ${esc(ed.by)}` : ''}</span>` : '',
      r.flags.includes('forgot') ? `<span class="badge warn xs" title="${L('نسي ينهي اليوم', 'Day not ended')}">${L('اتقفل تلقائياً', 'Auto-closed')}</span>` : '',
      (r.excuses || []).map(x => `<span class="badge ok xs" title="${L('إذن معتمد، ومتحسبش عليه تأخير في الوقت المغطّى', 'Approved permission: lateness inside it is not counted')}"><i class="fas fa-file-circle-check"></i> ${x.kind === 'early' ? L('إذن انصراف مبكر', 'Early leave') : (x.kind === 'middle' ? L('إذن خروج', 'Mid-day permission') : L('إذن تأخير', 'Late permission'))}${x.from || x.to ? ` <span class="num" dir="ltr">${esc(x.from)}–${esc(x.to)}</span>` : ''}</span>`).join(''),
      r.flags.includes('excused') ? `<span class="badge ok xs">${L('بإذن', 'Excused')}</span>` : '',
      r.flags.includes('remote-pending') ? `<span class="badge warn xs">${L('مستني موافقة', 'Pending')}</span>` : '',
      r.flags.includes('extra-day') ? `<span class="badge ok xs" title="${L('شغل في يوم إجازة', 'Worked on a day off')}">${L('أوفر تايم', 'Overtime')}</span>` : '',
      isAdmin() && r.afterMs > 0 && !r.flags.includes('extra-day') ? `<span class="badge warn xs" title="${L('زيادة على ساعات الشيفت الفعلية، على عداد الشيفت (بدون مقابل)', 'Past the shift hours on the shift counter (unpaid)')}">+${esc(fmtHours(r.afterMs))}</span>` : '',
      r.short ? shortBadge(r.short, 'xs') : ''
    ].join('');
    return `<tr data-day="${r.date}" tabindex="0" role="button" style="cursor:pointer;${idle ? 'opacity:.55' : ''}" class="${r.date === todayKey ? 'today-row' : ''}">
      <td class="nowrap"><b class="num">${+r.date.slice(8)}</b> <span class="muted small">${esc(DOW()[weekday(r.date)])}</span></td>
      <td><div class="row-wrap" style="gap:4px"><span class="badge ${meta.badge}">${esc(label)}</span>${tags}</div></td>
      <td class="num nowrap">${tm(rec.checkInMs)}${pen(ed, ed && ed.in)}</td>
      <td class="num nowrap">${rec.checkOutMs ? tm(rec.checkOutMs) : (rec.checkInMs && r.date === todayKey ? `<span class="badge ok xs">${L('لسه شغال', 'Working')}</span>` : dash)}${pen(ed, ed && ed.out)}</td>
      <td class="num"><b>${hrs(work)}</b></td>
      <td class="num">${hrs(r.meetingMs)}</td>
      <td class="num">${hrs(r.breakMs)}</td>
      <td class="num ${r.late ? 'bad-txt' : ''}">${r.late ? esc(fmtMin(r.late)) : dash}</td>
      <td class="num ${r.early ? 'bad-txt' : ''}">${r.early ? esc(fmtMin(r.early)) : dash}</td>
    </tr>`;
  }).join('');
  return `<div class="table-wrap"><table class="table day-table">
    <thead><tr><th>${L('اليوم', 'Day')}</th><th>${L('الحالة', 'Status')}</th><th>${L('الحضور', 'In')}</th><th>${L('الانصراف', 'Out')}</th>
      <th title="${L('الشغل + الاجتماعات، من غير الاستراحة', 'Work + meetings, breaks excluded')}">${L('ساعات الشغل', 'Work hours')}<div class="xs muted" style="font-weight:400">${L('شغل + اجتماعات', 'work + meetings')}</div></th>
      <th>${L('اجتماعات', 'Meetings')}</th><th>${L('استراحة', 'Breaks')}</th><th>${L('تأخير', 'Late')}</th><th>${L('انصراف مبكر', 'Early leave')}</th></tr></thead>
    <tbody>${body}</tbody>
    <tfoot><tr><th colspan="4">${L('الإجمالي', 'Total')}</th><th class="num">${hrs(tot.work)}</th><th class="num">${hrs(tot.meet)}</th><th class="num">${hrs(tot.brk)}</th>
      <th class="num ${tot.late ? 'bad-txt' : ''}">${tot.late ? esc(fmtMin(tot.late)) : dash}</th><th class="num ${tot.early ? 'bad-txt' : ''}">${tot.early ? esc(fmtMin(tot.early)) : dash}</th></tr></tfoot>
  </table></div>`;
}

/** A short day (ended before its actual hours): how much was missing, and the employee's answer */
export function shortBadge(sh, size = '') {
  const refused = sh.response === 'refused';
  return `<span class="badge ${refused ? 'bad' : 'warn'} ${size}" title="${esc(sh.note || '')}"><i class="fas fa-hourglass-half"></i>${L('ناقص', 'Short')} ${esc(fmtHours(sh.missingMs))} · ${refused ? L('اعترض', 'objected') : L('وافق', 'accepted')}</span>`;
}

/** "(was 08:20 before the edit)" next to a time changed by hand */
const wasTxt = (ed, k) => ed && ed[k] !== undefined ? ` <span class="xs muted">${L('(قبل التعديل', '(before the edit')} ${esc(ed[k] ? fmtTime(ed[k]) : '—')})</span>` : '';

export async function showDayDetails(email, row, { canRequest = false } = {}) {
  const meta = STATUS_DAY[row.status] || STATUS_DAY.none;
  const m = modal({
    title: fmtDay(row.date), icon: 'fa-calendar-day',
    body: `<div class="row-wrap mb-16"><span class="badge ${meta.badge}">${esc(L(meta.ar, meta.en) || modeLabel(row.plan.mode))}</span>
        ${row.mode ? `<span class="badge brand">${esc(modeLabel(row.mode))}</span>` : ''}
        ${row.late ? `<span class="badge bad">${L('تأخير', 'Late')} ${esc(fmtMin(row.late))}</span>` : ''}
        ${row.early ? `<span class="badge warn">${L('انصراف مبكر', 'Early')} ${esc(fmtMin(row.early))}</span>` : ''}
        ${row.flags.includes('forgot') ? `<span class="badge warn">${L('اتقفل تلقائياً', 'Auto-closed')}</span>` : ''}
        ${row.flags.includes('corrected') ? `<span class="badge info"><i class="fas fa-user-pen"></i>${L('تعديل يدوي', 'Edited by hand')}${editInfo(row).by ? ` ${L('من', 'by')} ${esc(editInfo(row).by)}` : ''}</span>` : ''}
        ${row.flags.includes('excused') ? `<span class="badge ok">${L('بإذن', 'Excused')}</span>` : ''}</div>
      <dl class="kv">
        <dt>${L('الخطة', 'Plan')}</dt><dd>${esc(modeLabel(row.plan.mode))}${row.plan.start ? ` · ${esc(row.plan.start)}–${esc(row.plan.end)}` : ''}</dd>
        <dt>${L('الحضور', 'Check-in')}</dt><dd class="num">${esc(row.rec && row.rec.checkInMs ? fmtTime(row.rec.checkInMs) : '—')}${wasTxt(editInfo(row), 'in')}</dd>
        <dt>${L('الانصراف', 'Check-out')}</dt><dd class="num">${esc(row.rec && row.rec.checkOutMs ? fmtTime(row.rec.checkOutMs) : '—')}${wasTxt(editInfo(row), 'out')}</dd>
        <dt>${L('ساعات الشغل', 'Work hours')}</dt><dd>${esc(fmtHours((row.workMs || 0) + (row.meetingMs || 0)))} <span class="xs muted">${L('شغل + اجتماعات', 'work + meetings')}</span></dd>
        <dt>${L('استراحة', 'Break')}</dt><dd>${esc(fmtHours(row.breakMs))}</dd>
        <dt>${L('اجتماعات', 'Meetings')}</dt><dd>${esc(fmtHours(row.meetingMs))}</dd>
        ${row.short ? `<dt>${L('ساعات اليوم الفعلية', 'Actual hours')}</dt><dd>${L(`المطلوب ${fmtHours(row.short.requiredMs)} · اشتغل ${fmtHours(row.short.workedMs)} · ناقص`, `Required ${fmtHours(row.short.requiredMs)} · worked ${fmtHours(row.short.workedMs)} · short`)} <b class="bad-txt">${esc(fmtHours(row.short.missingMs))}</b> ${shortBadge(row.short, 'xs')}</dd>
          ${row.short.note ? `<dt>${L('سبب الاعتراض', 'Objection')}</dt><dd>${esc(row.short.note)}</dd>` : ''}` : ''}
        ${row.flags.includes('extra-day') ? `<dt>${L('أوفر تايم', 'Overtime')}</dt><dd>${L(`شغل في يوم إجازة: ${fmtHours((row.workMs || 0) + (row.meetingMs || 0))}`, `Worked on a day off: ${fmtHours((row.workMs || 0) + (row.meetingMs || 0))}`)}</dd>` : ''}
        ${row.rec && row.rec.correctionNote ? `<dt>${L('ملاحظة التصحيح', 'Correction note')}</dt><dd>${esc(row.rec.correctionNote)}</dd>` : ''}
      </dl>
      <div class="mt-16"><div class="label mb-8">${L('سجل الحالات', 'Status log')}</div><div id="day-logs">${loader()}</div></div>`,
    foot: `${canRequest && row.date <= dayKey(now()) ? `<button class="btn" id="fix-btn"><i class="fas fa-pen-to-square"></i> ${L('طلب تصحيح', 'Request correction')}</button>` : ''}<button class="btn btn-primary" data-close>${L('تمام', 'OK')}</button>`
  });
  const fb = m.$('#fix-btn');
  if (fb) fb.onclick = () => { m.close(); openRequestForm('correction', { date: row.date }); };
  try {
    const logs = (await dayLogs(email, row.date, scopeFor(email))).sort((a, b) => (toMs(a.timestamp) || 0) - (toMs(b.timestamp) || 0));
    m.$('#day-logs').innerHTML = logs.length ? `<div class="timeline">${logs.map(l => {
      const s = STATUS_META[l.to_status] || STATUS_META.Offline;
      return `<div class="tl-item ${s.cls}"><div class="row between"><b class="small">${esc(L(s.ar, s.en))}</b><span class="xs muted num">${esc(fmtTime(toMs(l.timestamp)))}</span></div>${l.changed_by === 'admin' ? `<div class="xs muted">${L('بواسطة', 'by')} ${esc(l.changed_by_name || '')}</div>` : ''}</div>`;
    }).join('')}</div>` : `<p class="muted small">${L('مفيش سجل لليوم ده', 'No log for this day')}</p>`;
  } catch { m.$('#day-logs').innerHTML = `<p class="muted small">—</p>`; }
}

/** Render a person's month into `el` with a month switcher */
export async function personMonthView(el, email, { initialYm, canRequest = false, title = '', onData } = {}) {
  let ym = initialYm || ymOf(now());
  let data = null;
  let filter = 'all';                                        // kept when switching months
  el.innerHTML = `<div class="row between mb-16" style="flex-wrap:wrap;gap:10px">
      <div>${title}</div>
      <div class="row gap-8"><button class="btn btn-icon btn-sm" data-m="-1" aria-label="prev"><i class="fas fa-chevron-right" data-flip></i></button>
      <b id="pm-label" style="min-width:130px;text-align:center"></b>
      <button class="btn btn-icon btn-sm" data-m="1" aria-label="next"><i class="fas fa-chevron-left" data-flip></i></button></div>
    </div><div id="pm-body">${loader()}</div>`;
  async function load() {
    el.querySelector('#pm-label').textContent = fmtMonth(ym);
    el.querySelector('#pm-body').innerHTML = loader();
    try {
      data = await personMonth(email, ym, scopeFor(email));
      el.querySelector('#pm-body').innerHTML = `${statTiles(data.totals)}${isAdmin() ? splitHTML(data.split) : ''}
        <div class="card mt-16"><div class="card-head" id="pm-filter"></div><div id="pm-table"></div></div>`;
      drawTable();
      onData && onData(data, ym);
    } catch (e) {
      console.error(e);
      el.querySelector('#pm-body').innerHTML = `<div class="card">${empty('fa-triangle-exclamation', L('تعذّر تحميل البيانات', 'Could not load data'), e.message)}</div>`;
    }
  }
  function drawTable() {
    el.querySelector('#pm-filter').innerHTML = dayFilterHTML(data.rows, filter);
    el.querySelector('#pm-table').innerHTML = dayTableHTML(data.rows, filter);
    el.querySelectorAll('#pm-filter [data-f]').forEach(b => b.onclick = () => { filter = b.dataset.f; drawTable(); });
    el.querySelectorAll('#pm-table [data-day]').forEach(d => {
      const open = () => { const r = data.rows.find(x => x.date === d.dataset.day); if (r && r.status !== 'future') showDayDetails(email, r, { canRequest }); };
      d.onclick = open; d.onkeydown = (e) => { if (e.key === 'Enter') open(); };
    });
  }
  el.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { ym = addMonths(ym, Number(b.dataset.m)); load(); });
  await load();
}

export default async function render(root) {
  root.innerHTML = `<div class="page-head"><div><h2>${L('حضوري', 'My attendance')}</h2><p>${L('اضغط على أي يوم عشان تشوف تفاصيله أو تطلب تصحيح.', 'Click any day for details or to request a correction.')}</p></div></div><div id="pm"></div><div id="ded" class="mt-16"></div>`;
  const priv = await read('employees_private', session.email).catch(() => null);
  // the month's deductions so far, from this employee's own rules — so a wrong one can be fixed before payroll
  const drawDeductions = (data, ym) => {
    const box = root.querySelector('#ded');
    const parts = salaryParts(priv || {});
    if (!priv || !parts.structured || isFreelancer(priv)) { box.innerHTML = ''; return; }   // a freelancer has no attendance deductions
    const priced = priceViolations(violationsFrom(data.rows, data.requests), parts, rulesOf(priv));
    const total = priced.lines.reduce((s, l) => s + l.total, 0);
    box.innerHTML = `<div class="card"><div class="card-head"><h3>${L(`خصومات ${fmtMonth(ym)} لحد دلوقتي`, `${fmtMonth(ym)} deductions so far`)}</h3><b class="num" style="color:${total ? 'var(--bad)' : 'var(--ok)'}">${esc(money(total))}</b></div>
      ${priced.lines.length ? `<div class="table-wrap"><table class="table"><tbody>${priced.lines.map(l => `<tr><td class="num nowrap">${esc(fmtDay(l.date))}</td><td>${esc(violationText(l))}</td><td class="num" style="color:var(--bad);white-space:nowrap">−${esc(money(l.total, false))}</td></tr>`).join('')}</tbody></table></div>
        <div class="card-foot" style="justify-content:flex-start"><span class="xs muted"><i class="fas fa-circle-info"></i> ${L('لو فيه خصم غلط، اضغط على اليوم في الجدول واطلب تصحيح أو قدّم إذن — المخالفة بتتشال لما الطلب يتعتمد.', 'If a deduction is wrong, click that day in the table and request a correction or a permission — it is removed once approved.')}</span></div>`
        : `<div class="card-body">${empty('fa-face-smile', L('مفيش خصومات الشهر ده 👏', 'No deductions this month 👏'))}</div>`}</div>`;
  };
  await personMonthView(root.querySelector('#pm'), session.email, { canRequest: true, onData: drawDeductions });
}
