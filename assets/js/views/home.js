// "My day": start/end the day, switch status, live timers, balances, today's log.
import { L, esc, fmtDur, fmtTime, fmtHours, fmtMin, ymd, addDays, fmtDate, num, zparts } from '../core/utils.js';
import { toast, toastErr, modal, avatar, presenceBadge, STATUS_META, busy, confirmDialog, empty, livePop } from '../core/ui.js';
import { session, now } from '../core/session.js';
import { policy, dayKey, planFor, lateness, modeLabel, MODE_META, typeLabel, statusLabel, REQUEST_STATUS, leaveTypeLabel, isWorkingPlan, withShift, planOfDay, canPickShift, shiftList, shiftLabel, requestChoices, requiredWorkMs } from '../core/policy.js';
import { toMs, watch, query, col, where } from '../core/fb.js';
import { startDay, changeStatus, endDay, liveBank, staleDay, closeStaleDay, dayLogs, COUNTED, countFrom, workedMs } from '../services/attendance.js';
import { isOffDay, fileOvertime, msToHours } from '../services/overtime.js';
import { notifyMany } from '../services/notify.js';
import { approversFor } from '../services/requests.js';
import { getSchedule, watchBalance, remaining, watchMyRequests } from '../services/requests.js';
import { openRequestForm } from './request-form.js';
import { meetingLine, nameOf } from '../services/directory.js';

export default async function render(root) {
  const unsubs = [];
  let schedule = null, balance = null, myReqs = [];
  const today = () => dayKey(now());

  root.innerHTML = `
    <div class="grid" style="grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);align-items:start" id="home-grid">
      <div class="col gap-16">
        <a class="ann-banner hidden" id="ann-banner" href="#/announcements"></a>
        <section class="hero" id="hero"></section>
        <section class="card" id="pad-card"></section>
        <section class="grid g-3 keep-2" id="stats"></section>
      </div>
      <div class="col gap-16">
        <section class="card hidden" id="bday"></section>
        <section class="card" id="quick"></section>
        <section class="card" id="upcoming"></section>
        <section class="card" id="log"></section>
      </div>
    </div>`;
  // the newest unread announcement on top, and the birthdays of today and this week
  import('../services/announcements.js').then(svc => {
    const el = root.querySelector('#ann-banner');
    unsubs.push(svc.onAnnouncements(() => {
      const u = svc.unread(); const a = u[0];
      el.classList.toggle('hidden', !a);
      if (a) el.innerHTML = `<span class="icon-tile ${a.important ? 'bad' : ''}"><i class="fas fa-bullhorn"></i></span><span class="grow min0"><small>${u.length > 1 ? L(`${u.length} إعلانات جديدة`, `${u.length} new announcements`) : L('إعلان جديد', 'New announcement')}</small><b class="truncate">${esc(a.title)}</b></span><i class="fas fa-chevron-left" data-flip></i>`;
    }));
  });
  import('./birthdays.js').then(b => { const redraw = b.mountBirthdayCard(root.querySelector('#bday')); import('../services/directory.js').then(d => unsubs.push(d.onDirectory(redraw))); });
  const mq = matchMedia('(max-width: 1100px)');
  const fit = () => { root.querySelector('#home-grid').style.gridTemplateColumns = mq.matches ? 'minmax(0,1fr)' : 'minmax(0,1.6fr) minmax(0,1fr)'; };
  fit(); mq.addEventListener('change', fit); unsubs.push(() => mq.removeEventListener('change', fit));

  const u = () => session.profile || {};
  const started = () => u().dayKey === today() && u().status && u().status !== 'Offline';
  const endedToday = () => u().dayKey === today() && u().checkedOut;

  function renderHero() {
    const p = u();
    const st = started() ? p.status : 'Offline';
    const meta = STATUS_META[st] || STATUS_META.Offline;
    const plan = planOfDay(planFor(today(), schedule, session.email), p.dayKey === today() ? p.shift : '', p.dayKey === today() ? toMs(p.firstOnlineAt) : null, p.dayKey === today() ? p.workLocation : '');
    const h = zparts(now()).h;
    const greet = h < 12 ? L('صباح الخير', 'Good morning') : (h < 17 ? L('مساء الخير', 'Good afternoon') : L('مساء النور', 'Good evening'));
    const fo0 = p.dayKey === today() ? toMs(p.firstOnlineAt) : null;
    const fo = fo0 && dayKey(fo0) === today() ? fo0 : null; // ignore a check-in filed under the wrong day
    const late = fo ? lateness(fo, plan) : { late: 0 };
    root.querySelector('#hero').innerHTML = `
      <div class="row gap-16" style="align-items:center;flex-wrap:wrap">
        <div class="ring">${avatar({ ...p, email: session.email }, '')}<span class="st" style="background:${meta.color}"><i class="fas ${meta.icon}"></i></span></div>
        <div class="grow">
          <div class="muted small">${esc(greet)}</div>
          <h2 style="font-size:24px;font-weight:800">${esc(p.name || session.email)}</h2>
          <div class="muted small">${esc(p.title || '')}</div>
          <div class="row-wrap mt-8">
            ${presenceBadge(st)}
            ${st === 'Meeting' && meetingLine({ ...p, email: session.email }) ? `<span class="badge info"><i class="fas fa-users"></i>${esc(meetingLine({ ...p, email: session.email }))}</span>` : ''}
            ${p.dayKey === today() && p.workLocation ? `<span class="badge brand"><i class="fas ${p.workLocation === 'remote' ? 'fa-house-laptop' : 'fa-building'}"></i>${esc(modeLabel(p.workLocation))}</span>` : ''}
            ${p.remotePending && p.dayKey === today() ? `<span class="badge warn"><i class="fas fa-hourglass-half"></i>${L('الأونلاين مستني موافقة', 'Remote pending approval')}</span>` : ''}
            ${fo ? `<span class="badge"><i class="fas fa-right-to-bracket"></i>${L('حضور', 'In')} ${esc(fmtTime(fo))}</span>` : ''}
            ${plan.shift && fo ? `<span class="badge info"><i class="fas fa-business-time"></i>${esc(shiftLabel(plan.shift))} · ${esc(plan.start)}–${esc(plan.end)}</span>` : ''}
            ${started() && countFrom(p) > now() ? `<span class="badge warn"><i class="fas fa-hourglass-start"></i>${L(`العدّ هيبدأ الساعة ${plan.start}`, `Counting starts at ${plan.start}`)}</span>` : ''}
            ${late.late ? `<span class="badge bad"><i class="fas fa-clock"></i>${L('تأخير', 'Late')} ${esc(fmtMin(late.late))}</span>` : ''}
          </div>
        </div>
        <div class="hero-timer">
          <div class="muted small" title="${L('العمل + الاجتماعات، من غير الاستراحة', 'Work + meetings, breaks excluded')}">${L('وقت الشغل النهارده', 'Work time today')}</div>
          <div class="timer-big" id="t-main">00:00:00</div>
          <div class="muted small mt-8">${esc(L('الخطة:', 'Plan:'))} ${esc(modeLabel(plan.mode))}${plan.start ? ` · ${esc(plan.start)}–${esc(plan.end)}` : ''}</div>
        </div>
      </div>`;
  }

  function renderPad() {
    const p = u();
    const card = root.querySelector('#pad-card');
    const plan = planFor(today(), schedule, session.email);
    if (!started()) {
      const stale = staleDay(p);
      const note = plan.mode === 'leave' ? `<div class="alert warn mb-16"><i class="fas fa-umbrella-beach"></i><span>${L('النهارده إجازة معتمدة ليك', 'You have approved leave today')}${plan.leaveType ? ` (${esc(leaveTypeLabel(plan.leaveType))})` : ''}.</span></div>`
        : (plan.mode === 'off' || plan.mode === 'holiday') ? `<div class="alert info mb-16"><i class="fas fa-bed"></i><span>${plan.mode === 'holiday' ? esc(L('عطلة رسمية', 'Public holiday')) + (plan.name ? ` — ${esc(plan.name)}` : '') : L('النهارده يوم راحة.', 'Today is a day off.')}</span></div>` : '';
      const otNote = isOffDay(plan) ? `<div class="alert ok mb-16" id="ot-note"><i class="fas fa-business-time"></i><span>${L('لو اشتغلت النهارده، ساعات شغلك هتتحسب أوفر تايم: لما تنهي اليوم بيتبعت طلب للإدارة، ولو اتوافق عليه المبلغ بينزل على مرتبك.', 'If you work today, your hours count as overtime: ending the day sends a request to management, and once approved the amount is added to your salary.')}</span></div>` : '';
      card.innerHTML = `<div class="card-body">
        ${note}${otNote}
        ${stale ? `<div class="alert warn mb-16"><i class="fas fa-triangle-exclamation"></i><span>${L(`يوم ${fmtDate(stale)} ما اتقفلش. هيتقفل تلقائياً على ميعاد الانصراف لما تبدأ النهارده، ولو فيه خطأ قدّم طلب تصحيح.`, `Your day on ${fmtDate(stale)} was not ended. It will be closed at the planned end time when you start today; request a correction if needed.`)}</span></div>` : ''}
        <div class="row between" style="flex-wrap:wrap;gap:16px">
          <div><h3 style="font-size:17px">${endedToday() ? L('خلّصت يومك', 'Your day is ended') : L('جاهز تبدأ؟', 'Ready to start?')}</h3>
          <p class="muted small">${endedToday() ? L('لو رجعت تشتغل تاني تقدر تكمل نفس اليوم.', 'If you are back to work you can resume today.') : L('اختار هتشتغل منين النهارده.', 'Choose where you are working from today.')}</p></div>
          <button class="btn btn-grad btn-lg" id="start-btn"><i class="fas fa-play"></i> ${endedToday() ? L('كمّل اليوم', 'Resume day') : L('ابدأ يومك', 'Start your day')}</button>
        </div></div>`;
      card.querySelector('#start-btn').onclick = openStart;
      return;
    }
    const enabled = COUNTED.filter(k => (policy.statuses[k] || {}).enabled !== false);
    card.innerHTML = `<div class="card-head"><h3>${L('حالتك دلوقتي', 'Your status')}</h3>
        <button class="btn btn-danger btn-sm" id="end-btn"><i class="fas fa-flag-checkered"></i> ${L('إنهاء اليوم', 'End day')}</button></div>
      <div class="card-body">
        <div class="status-pad">${enabled.map(k => {
          const s = STATUS_META[k];
          return `<button class="status-btn s-${k} ${p.status === k ? 'active' : ''}" data-st="${k}" ${p.status === k ? 'aria-pressed="true"' : ''}>
            <i class="fas ${s.icon}"></i><span>${esc(L(s.ar, s.en))}</span><span class="num small" data-timer="${k}">00:00:00</span></button>`;
        }).join('')}</div>
        <div id="meet-box"></div>
        <div id="break-warn" class="alert warn mt-16 hidden"><i class="fas fa-mug-hot"></i><span>${L(`تخطيت وقت الاستراحة المسموح (${policy.breakMaxMinutes} دقيقة).`, `You exceeded the allowed break time (${policy.breakMaxMinutes} min).`)}</span></div>
        <div id="offline-warn" class="alert bad mt-16 hidden"><i class="fas fa-wifi"></i><span>${L('مفيش إنترنت — تغيير الحالة متوقف لحد ما النت يرجع.', 'Offline — status changes are paused until you reconnect.')}</span></div>
      </div>`;
    card.querySelectorAll('[data-st]').forEach(b => b.onclick = () => busy(b, async () => {
      if (!navigator.onLine) { toast(L('مفيش إنترنت', 'No internet'), '', 'bad'); return; }
      // "In a meeting" always says who it is with (and invites them)
      if (b.dataset.st === 'Meeting') { const ui = await import('./meeting-ui.js'); await ui.openMeetingPicker(); return; }
      try { await changeStatus(session.email, b.dataset.st); } catch (e) { toastErr(e); }
    }));
    renderMeeting();
    card.querySelector('#end-btn').onclick = () => openEnd();
  }

  /** The day's actual hours: what the plan asks for (minus approved permission time) and what was worked so far */
  function dayHours() {
    const p = u();
    const plan = planOfDay(planFor(today(), schedule, session.email), p.shift, toMs(p.firstOnlineAt), p.workLocation);
    const worked = workedMs(p);
    let required = requiredWorkMs(plan);
    // a permission that did not move the day's hours (someone who picks a shift) is taken off what is required
    const moved = !!(schedule && schedule.days && (schedule.days[today()] || {}).excuseId);
    if (!moved) required -= myReqs.filter(r => r.type === 'excuse' && r.status === 'approved' && r.startDate === today()).reduce((s, r) => s + (r.minutes || 0) * 60000, 0);
    return { plan, worked, required: Math.max(0, required) };
  }

  async function openEnd() {
    const { plan, worked, required } = dayHours();
    const finish = async (extra) => {
      const p = u(), fo = toMs(p.firstOnlineAt);
      await endDay(extra);
      toast(L('يومك اتقفل. شكراً على مجهودك!', 'Day ended. Thanks for your work!'));
      if (isOffDay(plan)) {
        try {
          const r = await fileOvertime({ date: today(), plan, checkInMs: fo, checkOutMs: now(), workMs: worked });
          if (r) livePop({ icon: 'fa-business-time', cls: 'ok', title: L('اتبعت طلب أوفر تايم', 'Overtime request sent'), text: r.status === 'pending_admin' ? L(`${msToHours(worked)} ساعة شغل في يوم إجازة. الطلب عند الإدارة، ولو اتوافق عليه المبلغ هينزل على مرتبك.`, `${msToHours(worked)} h worked on a day off. The request is with management; once approved the amount is added to your salary.`) : L('طلب الأوفر تايم بتاع النهارده اتقرر بالفعل.', "Today's overtime request was already decided."), ttl: 15000 });
        } catch (e) { console.warn(e); toast(L('مقدرتش أبعت طلب الأوفر تايم', 'Could not send the overtime request'), e.userMessage || '', 'warn'); }
      }
    };
    // short of the day's actual hours: tell the employee, who accepts it or objects (both are kept on the day)
    if (isWorkingPlan(plan) && required > 0 && worked < required) {
      const missing = required - worked;
      const m = modal({
        title: L('لم يتم استكمال عدد ساعات اليوم الفعلية', "Today's actual hours are not complete"), icon: 'fa-hourglass-half', size: 'narrow',
        body: `<div class="col gap-12" id="short-box">
          <div class="alert warn"><i class="fas fa-triangle-exclamation"></i><span>${L(`إنت بتنهي يومك قبل ما تكمّل ساعات الشغل الفعلية (من غير الاستراحة). ناقصك <b class="num">${esc(fmtHours(missing))}</b>.`, `You are ending the day before completing the actual work hours (breaks excluded). You are <b class="num">${esc(fmtHours(missing))}</b> short.`)}</span></div>
          <dl class="kv">
            <dt>${L('المطلوب النهارده', 'Required today')}</dt><dd class="num">${esc(fmtHours(required))}</dd>
            <dt>${L('اشتغلت', 'Worked')}</dt><dd class="num">${esc(fmtHours(worked))}</dd>
            <dt>${L('الناقص', 'Missing')}</dt><dd class="num bad-txt"><b>${esc(fmtHours(missing))}</b></dd>
          </dl>
          <p class="small muted">${L('لو موافق، اليوم بيتسجل إن ساعاته ناقصة. ولو رافض، اكتب السبب وهيوصل لمديرك. في الحالتين ده بيظهر في تقارير حضورك.', 'If you accept, the day is recorded as short. If you object, write why and your manager is told. Either way it shows in your attendance reports.')}</p>
          <div class="field"><label>${L('سبب الرفض (لو رافض)', 'Reason (if you object)')}</label><textarea class="textarea" id="short-note" maxlength="500" placeholder="${L('مثلاً: كنت في مأمورية / الوقت متسجلش صح', 'e.g. I was on an errand / time was not recorded right')}"></textarea></div>
        </div>`,
        foot: `<button class="btn" data-close id="short-back"><i class="fas fa-rotate-left"></i> ${L('أكمّل شغلي', 'Keep working')}</button>
          <button class="btn" id="short-refuse"><i class="fas fa-hand"></i> ${L('رافض', 'Object')}</button>
          <button class="btn btn-danger" id="short-accept"><i class="fas fa-check"></i> ${L('موافق — أنهي اليوم', 'Accept — end day')}</button>`
      });
      const answer = (response) => async (e) => {
        const note = m.$('#short-note').value.trim();
        if (response === 'refused' && !note) { m.$('#short-note').focus(); toast(L('اكتب سبب الرفض', 'Write why you object'), '', 'warn'); return; }
        await busy(e.currentTarget, async () => {
          try {
            const { worked: w } = dayHours();
            const shortfall = { requiredMs: Math.round(required), workedMs: Math.round(w), missingMs: Math.max(0, Math.round(required - w)), response, note: note.slice(0, 500), at: now() };
            await finish({ shortfall });
            m.close();
            if (response === 'refused') {
              const me = u();
              const to = [...new Set([me.leaderEmail, ...approversFor('hr', {})].filter(e => e && e !== session.email))];
              notifyMany(to, L(`${me.name || session.email} اعترض على ساعات يوم ناقصة`, `${me.name || session.email} objected to a short day`), `${fmtHours(shortfall.missingMs)} — ${note}`, '#/reports', 'request');
            }
          } catch (ex) { toastErr(ex); }
        });
      };
      m.$('#short-accept').onclick = answer('accepted');
      m.$('#short-refuse').onclick = answer('refused');
      return;
    }
    const ok = await confirmDialog({ title: L('إنهاء اليوم', 'End day'), message: isOffDay(plan) ? L(`النهارده يوم إجازة: اشتغلت ${fmtHours(worked)}. لما تنهي اليوم هيتبعت طلب أوفر تايم للإدارة.`, `Today is a day off: you worked ${fmtHours(worked)}. Ending the day sends an overtime request to management.`) : L('هيتسجل وقت انصرافك دلوقتي. متأكد؟', 'Your check-out will be recorded now. Continue?'), okText: L('إنهاء اليوم', 'End day'), okClass: 'btn-danger' });
    if (!ok) return;
    try { await finish({ shortfall: null }); } catch (ex) { toastErr(ex); }
  }

  async function openStart() {
    const plan = planFor(today(), schedule, session.email);
    const approvedRemote = plan.mode === 'remote';
    const quota = Number(u().remoteQuota ?? policy.defaultRemoteQuota);
    const m = modal({
      title: L('هتشتغل منين النهارده؟', 'Where are you working today?'), icon: 'fa-location-dot', size: 'narrow',
      body: `<div class="col gap-16">
        <button class="btn btn-lg btn-block btn-primary" data-mode="office" style="height:64px;justify-content:flex-start"><i class="fas fa-building"></i> ${L('من المكتب', 'From the office')}</button>
        <button class="btn btn-lg btn-block" data-mode="remote" style="height:64px;justify-content:flex-start"><i class="fas fa-house-laptop"></i>
          <span class="grow" style="text-align:start">${L('أونلاين', 'Remote')}</span>
          ${approvedRemote ? `<span class="badge ok">${L('معتمد', 'Approved')}</span>` : (policy.remoteNeedsApproval && isWorkingPlan(plan) ? `<span class="badge warn">${L('محتاج موافقة', 'Needs approval')}</span>` : '')}</button>
        ${!approvedRemote && policy.remoteNeedsApproval && isWorkingPlan(plan) ? `<p class="small muted">${L(`لو اخترت أونلاين من غير طلب معتمد، هيتبعت طلب تلقائي لمديرك واليوم هيتعلّم «مستني موافقة». حصتك الشهرية ${quota} أيام.`, `Choosing remote without an approved request sends an automatic request to your manager and flags the day as pending. Your monthly quota is ${quota} days.`)}</p>` : ''}
      </div>`
    });
    m.$$('[data-mode]').forEach(b => b.onclick = () => busy(b, async () => {
      const mode = b.dataset.mode;
      try {
        const needsReq = mode === 'remote' && policy.remoteNeedsApproval && !approvedRemote && !endedToday() && isWorkingPlan(plan);
        const wasStale = staleDay(u());
        // a new day without fixed hours: pick the shift (resuming keeps the one picked in the morning)
        let shift = '';
        if (u().dayKey !== today() && canPickShift(plan)) {
          shift = await pickShift(plan, mode);
          if (shift === null) return;
        }
        const res = await startDay(mode, { remoteApproved: !needsReq, shift });
        if (needsReq) {
          const { submitRequest } = await import('../services/requests.js');
          try { await submitRequest({ type: 'remote', startDate: res.key, endDate: res.key, reason: L('طلب تلقائي عند بدء اليوم', 'Automatic request at check-in') }); }
          catch (e) { console.warn(e); toast(L('مقدرتش أبعت طلب الأونلاين تلقائياً', 'Could not send the remote request automatically'), e.userMessage || L('قدّمه من «طلباتي».', 'Submit it from My requests.'), 'warn'); }
        }
        m.close();
        toast(res.resumed ? L('كمّلت يومك', 'Day resumed') : L('يومك بدأ، بالتوفيق!', 'Your day has started. Have a great one!'));
        // forgetting to end the day costs nothing, but the employee is warned on the next working day
        if (wasStale) livePop({ icon: 'fa-triangle-exclamation', cls: 'warn', title: L('تحذير: نسيت تنهي يومك', 'Warning: you did not end your day'), text: L(`يوم ${fmtDate(wasStale)} ما اتقفلش، فاتقفل تلقائياً على ميعاد انصرافك. المرة الجاية اضغط «إنهاء اليوم» قبل ما تمشي.`, `${fmtDate(wasStale)} was not ended, so it was closed at your planned end time. Next time press "End day" before you leave.`), ttl: 30000 });
      } catch (e) { toastErr(e); }
    }));
  }

  /** The shift for a new day: its id, or null = cancelled. Each shift shows whether starting it now is late. */
  function pickShift(plan, mode) {
    return new Promise((resolve) => {
      let done = false;
      const t = now(), nowMin = zparts(t).h * 60 + zparts(t).mi;
      const rows = shiftList().map(s => {
        const p = withShift(plan, s.id, mode);
        const late = lateness(t, p).late;
        const [h, mi] = s.start.split(':').map(Number);
        const before = nowMin < h * 60 + mi;
        const badge = late ? `<span class="badge bad">${L('تأخير', 'Late')} ${esc(fmtMin(late))}</span>`
          : (before ? `<span class="badge info">${L(`العدّ من ${s.start}`, `Counts from ${s.start}`)}</span>` : `<span class="badge ok">${L('من غير تأخير', 'On time')}</span>`);
        return { s, late, html: `<button class="btn btn-lg btn-block" data-shift="${esc(s.id)}" style="height:auto;padding:14px;justify-content:flex-start;text-align:start">
            <i class="fas fa-business-time"></i><span class="grow"><b>${esc(shiftLabel(s.id))}</b><small class="muted" style="display:block">${esc(s.start)}–${esc(s.end)} · ${L('سماح', 'grace')} ${esc(p.grace)} ${L('د', 'min')}</small></span>${badge}</button>` };
      });
      // suggest the earliest shift that is not late yet
      const best = rows.find(r => !r.late);
      const m = modal({
        title: L('اختار شيفت النهارده', "Pick today's shift"), icon: 'fa-business-time', size: 'narrow',
        body: `<div class="col gap-12">
          <p class="muted small">${mode === 'remote' ? L('أونلاين: نفس مواعيد الشيفتات، وفترة السماح أقصر.', 'Remote: the same shift hours, with a shorter grace period.') : L('لو بدأت قبل ميعاد الشيفت، وقت الشغل بيتحسب من ميعاده.', 'If you start before the shift, work time counts from its start.')}</p>
          ${rows.map(r => r === best ? r.html.replace('class="btn btn-lg btn-block"', 'class="btn btn-lg btn-block btn-primary"') : r.html).join('')}
        </div>`,
        onClose: () => { if (!done) resolve(null); }
      });
      m.$$('[data-shift]').forEach(b => b.onclick = () => { done = true; m.close(); resolve(b.dataset.shift); });
    });
  }

  // ---- my meeting: who it is with, and (when I started it) who accepted the invitation ----
  let meetUnsub = null, meetId = '', invites = [];
  unsubs.push(() => meetUnsub && meetUnsub());
  function renderMeeting() {
    const box = root.querySelector('#meet-box'); if (!box) return;
    const p = { ...u(), email: session.email };
    const inMeeting = started() && p.status === 'Meeting';
    const id = inMeeting ? (p.meetingId || '') : '';
    const host = !!id && id.startsWith(session.email + '_');
    if ((host ? id : '') !== meetId) {
      meetUnsub && meetUnsub(); meetUnsub = null; invites = []; meetId = host ? id : '';
      if (meetId) import('../services/meetings.js').then(m => { if (meetId === id) meetUnsub = m.watchMeetingInvites(id, rows => { invites = rows; renderMeeting(); }); });
    }
    if (!inMeeting) { box.innerHTML = ''; return; }
    const line = meetingLine(p);
    const ST = { pending: ['warn', 'fa-hourglass-half', L('مستني رده', 'waiting')], accepted: ['ok', 'fa-check', L('قبل', 'accepted')], declined: ['bad', 'fa-xmark', L('اعتذر', 'declined')], expired: ['', 'fa-clock', L('انتهت', 'expired')], cancelled: ['', 'fa-ban', L('اتلغت', 'withdrawn')] };
    const latest = new Map(); invites.slice().sort((a, b) => (a.atMs || 0) - (b.atMs || 0)).forEach(i => latest.set(i.to, i));
    const chips = host ? [...latest.values()].filter(i => i.status !== 'cancelled').map(i => { const [c, ic, t] = ST[i.status] || ST.pending; return `<span class="badge ${c}" title="${esc(t)}"><i class="fas ${ic}"></i>${esc(String(nameOf(i.to)).split(' ')[0])} · ${esc(t)}</span>`; }).join('') : '';
    box.innerHTML = `<div class="meet-box mt-16"><span class="icon-tile info"><i class="fas fa-users"></i></span>
      <div class="grow min0"><b>${esc(line || L('في ميتنج', 'In a meeting'))}</b>${!host && p.meetingId && (p.meetingWith || []).length ? `<div class="xs muted">${L('الدعوة من', 'Invited by')} ${esc(nameOf((p.meetingWith || [])[0]))}</div>` : ''}
        ${chips ? `<div class="row-wrap mt-8">${chips}</div>` : ''}</div>
      ${host || !(p.meetingWith || []).length ? `<button class="btn btn-sm" id="meet-edit"><i class="fas fa-user-plus"></i> ${L('تعديل / إضافة', 'Edit / add')}</button>` : ''}</div>`;
    const ed = box.querySelector('#meet-edit');
    if (ed) ed.onclick = async () => { const ui = await import('./meeting-ui.js'); ui.openMeetingPicker(); };
  }

  function renderStats() {
    const p = u();
    const annual = balance ? remaining(balance.types.annual || { entitled: 0 }) : null;
    const casual = balance ? remaining(balance.types.casual || { entitled: 0 }) : null;
    const monthKey = today().slice(0, 7);
    const remoteUsed = myReqs.filter(r => r.type === 'remote' && r.status === 'approved' && (r.startDate || '').slice(0, 7) === monthKey).reduce((s, r) => s + (r.days || 0), 0);
    const quota = Number(p.remoteQuota ?? policy.defaultRemoteQuota);
    const pending = myReqs.filter(r => String(r.status).startsWith('pending')).length;
    const tile = (icon, cls, label, value, unit, hint = '') => `<div class="card stat"><div class="label"><span class="icon-tile ${cls}"><i class="fas ${icon}"></i></span>${esc(label)}</div><div class="value">${value}<small>${esc(unit)}</small></div>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
    root.querySelector('#stats').innerHTML =
      tile('fa-umbrella-beach', '', L('رصيد الاعتيادي', 'Annual balance'), annual === null ? '—' : num(annual, 1), L('يوم', 'days')) +
      tile('fa-person-running', 'info', L('رصيد العارضة', 'Casual balance'), casual === null ? '—' : num(casual, 1), L('يوم', 'days')) +
      tile('fa-house-laptop', 'ok', L('أونلاين الشهر ده', 'Remote this month'), `${num(remoteUsed)}<small>/ ${num(quota)}</small>`, '') +
      tile('fa-hourglass-half', 'warn', L('طلبات مستنية', 'Pending requests'), num(pending), '', `<a href="#/requests">${L('عرض طلباتي', 'View my requests')}</a>`);
  }

  function renderQuick() {
    // the request types the company offers (settings → request types)
    const q = requestChoices();
    root.querySelector('#quick').innerHTML = `<div class="card-head"><h3>${L('طلب سريع', 'Quick request')}</h3></div>
      <div class="card-body"><div class="grid g-3 keep-2" style="gap:10px">${q.map(c => `
        <button class="btn" data-rq="${esc(c.key)}" style="height:auto;padding:12px 8px;flex-direction:column;gap:6px"><span class="icon-tile ${esc(c.tile || '')}"><i class="fas ${esc(c.icon)}"></i></span><span class="small">${esc(c.label)}</span></button>`).join('')}
      </div></div>`;
    root.querySelectorAll('[data-rq]').forEach(b => b.onclick = () => openRequestForm(b.dataset.rq));
  }

  function renderUpcoming() {
    const t = today(), limitDay = addDays(t, 30);
    const up = myReqs.filter(r => ['leave', 'remote', 'mission'].includes(r.type) && !['rejected', 'cancelled'].includes(r.status) && (r.endDate || r.startDate) >= t && r.startDate <= limitDay)
      .sort((a, b) => a.startDate.localeCompare(b.startDate)).slice(0, 6);
    root.querySelector('#upcoming').innerHTML = `<div class="card-head"><h3>${L('الجاي خلال 30 يوم', 'Next 30 days')}</h3></div>
      ${up.length ? `<div class="list">${up.map(r => {
        const st = REQUEST_STATUS[r.status] || {};
        return `<div class="list-item"><span class="icon-tile ${r.type === 'leave' ? 'warn' : (r.type === 'remote' ? '' : 'ok')}"><i class="fas ${r.type === 'leave' ? 'fa-umbrella-beach' : (r.type === 'remote' ? 'fa-house-laptop' : 'fa-briefcase')}"></i></span>
          <div class="grow"><b class="small">${esc(r.type === 'leave' ? leaveTypeLabel(r.leaveType) : typeLabel(r.type))}</b><div class="xs muted">${esc(fmtDate(r.startDate))}${r.endDate && r.endDate !== r.startDate ? ' → ' + esc(fmtDate(r.endDate)) : ''} · ${num(r.days || 0)} ${L('يوم', 'd')}</div></div>
          <span class="badge ${st.cls || ''}">${esc(statusLabel(r.status))}</span></div>`;
      }).join('')}</div>` : `<div class="card-body">${empty('fa-calendar', L('مفيش حاجة مجدولة', 'Nothing scheduled'))}</div>`}`;
  }

  let logsUnsub = null, logsKey = '';
  function watchLogs() {
    const k = today();
    if (k === logsKey) return; logsKey = k;
    if (logsUnsub) logsUnsub();
    logsUnsub = watch(query(col('logs'), where('user', '==', session.email), where('dayKey', '==', k)), rows => {
      rows.sort((a, b) => (toMs(b.timestamp) || 0) - (toMs(a.timestamp) || 0));
      root.querySelector('#log').innerHTML = `<div class="card-head"><h3>${L('سجل النهارده', "Today's log")}</h3></div>
        <div class="card-body">${rows.length ? `<div class="timeline">${rows.slice(0, 12).map(l => {
          const s = STATUS_META[l.to_status] || STATUS_META.Offline;
          return `<div class="tl-item ${s.cls}"><div class="row between"><b class="small">${esc(L(s.ar, s.en))}</b><span class="xs muted num">${esc(fmtTime(toMs(l.timestamp)))}</span></div>
            <div class="xs muted">${l.duration_ms != null ? `${L('بعد', 'after')} ${esc(fmtHours(l.duration_ms))} ${esc(L((STATUS_META[l.from_status] || {}).ar || '', (STATUS_META[l.from_status] || {}).en || ''))}` : ''}${l.changed_by === 'admin' ? ` · ${L('بواسطة الإدارة', 'by management')}` : ''}</div></div>`;
        }).join('')}</div>` : empty('fa-clock-rotate-left', L('لسه مفيش نشاط النهارده', 'No activity yet today'))}</div>`;
    });
  }
  unsubs.push(() => logsUnsub && logsUnsub());

  function tick() {
    const p = u();
    const bank = p.dayKey === today() ? liveBank(p) : { Online: 0, Break: 0, Meeting: 0 };
    const main = root.querySelector('#t-main'); if (main) main.textContent = fmtDur(bank.Online + bank.Meeting); // work + meetings, breaks excluded
    root.querySelectorAll('[data-timer]').forEach(el => { el.textContent = fmtDur(bank[el.dataset.timer]); });
    const bw = root.querySelector('#break-warn');
    if (bw) bw.classList.toggle('hidden', !(bank.Break > (policy.breakMaxMinutes || 0) * 60000 && policy.breakMaxMinutes));
    const ow = root.querySelector('#offline-warn'); if (ow) ow.classList.toggle('hidden', navigator.onLine);
    watchLogs();
  }

  function renderAll() { renderHero(); renderPad(); renderStats(); renderUpcoming(); tick(); }

  schedule = await getSchedule(session.email, today().slice(0, 7));
  renderQuick();
  renderAll();
  unsubs.push(watch(query(col('schedules'), where('email', '==', session.email)), rows => { schedule = rows.find(r => r.month === today().slice(0, 7)) || null; renderAll(); }));
  unsubs.push(watchBalance(session.email, Number(today().slice(0, 4)), b => { balance = b; renderStats(); }));
  unsubs.push(watchMyRequests(rows => { myReqs = rows; renderStats(); renderUpcoming(); }));
  const onProf = () => renderAll();
  window.addEventListener('am:profile', onProf); unsubs.push(() => window.removeEventListener('am:profile', onProf));
  const onNet = () => tick();
  window.addEventListener('online', onNet); window.addEventListener('offline', onNet);
  unsubs.push(() => { window.removeEventListener('online', onNet); window.removeEventListener('offline', onNet); });
  const iv = setInterval(tick, 1000); unsubs.push(() => clearInterval(iv));
  return () => unsubs.forEach(f => { try { f(); } catch {} });
}
