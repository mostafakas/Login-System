// One applicant (#/recruit/app/<id>): details & answers, stage, interviews (+ scorecards, online interview link),
// take-home tasks by link, ready emails (copy / open in Outlook, sent from the company address), offer, hire, timeline.
import { L, esc, isAr, num } from '../core/utils.js';
import { modal, toast, toastErr, busy, empty, loader, confirmDialog, avatar } from '../core/ui.js';
import { session, now } from '../core/session.js';
import { activePeople, nameOf } from '../services/directory.js';
import {
  STAGES, stageLabel, STATUS_LABEL, sourceOf, ROUNDS, MODES, RECS, REJECT_REASONS, OFFER_STATUS, TEMPLATE_KINDS, Q_TYPES, BUILTIN, DEFAULT_CRITERIA,
  ROUND_CHOICES, pick, critLabel, fails, failsRule, offerStatus, interviewLink, taskLink,
  getJob, watchApp, watchLog, otherApps, updateApp, moveStage, rejectApp, withdrawApp, reopenApp, markSeen, addNote, refreshScore, computeScore,
  watchInterviewsOf, saveInterview, setInterviewStatus, saveScorecard, linkInterviewCall, deleteInterview,
  watchTasksOf, watchBank, sendTask, gradeTask, resetTask, deleteTask, saveBankTask, uploadFile, openFile,
  watchTemplates, fillTemplate, logEmail, getRecruitSettings, saveOffer, markHired
} from '../services/recruit.js';
import { fmtWhen, scoreBadge, srcIcon, ivStatus, compareModal } from './recruit.js';

const TZ = 'Africa/Cairo';
const loc = (lang) => (lang === 'en' ? 'en-GB' : 'ar-EG-u-nu-latn');
const dayName = (ms, lang) => new Date(ms).toLocaleDateString(loc(lang), { timeZone: TZ, weekday: 'long' });
const dateTxt = (ms, lang) => new Date(ms).toLocaleDateString(loc(lang), { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' });
const timeTxt = (ms, lang) => new Date(ms).toLocaleTimeString(loc(lang), { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const fullWhen = (ms) => new Date(ms).toLocaleString(loc(isAr ? 'ar' : 'en'), { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });
/** Cairo date + time inputs → ms */
const cairoInput = (d, t) => { if (!d || !t) return 0; const [y, mo, da] = d.split('-').map(Number); const [h, mi] = t.split(':').map(Number); const guess = Date.UTC(y, mo - 1, da, h, mi); const off = new Date(guess).toLocaleString('en-US', { timeZone: TZ, hour12: false, hour: '2-digit' }); const diff = (Number(off) - h + 24) % 24; return guess - (diff > 12 ? diff - 24 : diff) * 3600000; };
const toInputs = (ms) => { if (!ms) return ['', '']; const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ms)); const g = (t) => (p.find(x => x.type === t) || {}).value; return [`${g('year')}-${g('month')}-${g('day')}`, `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}`]; };
const waLink = (phone) => { let d = String(phone || '').replace(/\D/g, ''); if (d.startsWith('0')) d = '2' + d; return `https://wa.me/${d}`; };
const ROUND_KIND = { phone: 'phone', hr: 'hr', tech: 'tech', final: 'final' };   // interview → its email template

export async function renderApp(root, id) {
  let app = null, job = null, ivs = [], tasks = [], log = [], others = [], tab = 'info', settings = {};
  try { tab = sessionStorage.getItem('am_rc_tab') || 'info'; } catch {}
  const unsubs = [];
  root.innerHTML = loader();
  settings = await getRecruitSettings().catch(() => ({}));

  const draw = () => {
    if (!app) { root.innerHTML = empty('fa-user', L('المتقدم ده مش موجود', 'Applicant not found'), ''); return; }
    const f = job ? fails(app, job) : [];
    const sc = job ? computeScore(job, ivs, tasks) : { total: app.score };
    const closed = app.status === 'rejected' || app.status === 'withdrawn';
    root.innerHTML = `<div class="rc-page rc-app">
      <a href="#/recruit/job/${esc(app.jobId)}" class="xs muted"><i class="fas fa-arrow-${isAr ? 'right' : 'left'}"></i> ${esc(app.jobTitle || L('الوظيفة', 'Job'))}</a>
      <div class="card mt-8"><div class="card-body rc-hero">
        <span class="avatar lg">${esc(String(app.name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join(''))}</span>
        <div class="grow min0"><h2 class="rc-h">${esc(app.name)}</h2>
          <div class="small muted">${esc([app.currentTitle, app.years !== '' && app.years != null ? L(`${app.years} سنين خبرة`, `${app.years} yrs experience`) : '', app.city].filter(Boolean).join(' · '))}</div>
          <div class="row gap-8 wrap mt-8">
            ${app.phone ? `<a class="chip" href="tel:${esc(app.phone)}" dir="ltr"><i class="fas fa-phone"></i> ${esc(app.phone)}</a><a class="chip" target="_blank" rel="noopener" href="${esc(waLink(app.phone))}"><i class="fab fa-whatsapp"></i> WhatsApp</a>` : ''}
            ${app.email ? `<a class="chip" href="mailto:${esc(app.email)}" dir="ltr"><i class="fas fa-envelope"></i> ${esc(app.email)}</a>` : ''}
            <span class="chip">${srcIcon(app.source)} ${esc(sourceOf(app.source)[1])}${app.referredBy ? ' — ' + esc(app.referredBy) : ''}</span>
            <span class="chip"><i class="fas fa-clock"></i> ${esc(fmtWhen(app.createdMs, { year: 'numeric' }))}</span></div></div>
        <div class="col gap-8 rc-hero-side">${scoreBadge(sc.total)}
          ${closed ? `<span class="badge bad">${esc((STATUS_LABEL[app.status])())}${app.rejectReason ? ' · ' + esc(pick(REJECT_REASONS, app.rejectReason)) : ''}</span>` : app.status === 'hired' ? `<span class="badge ok"><i class="fas fa-circle-check"></i> ${L('اتعيّن', 'Hired')}</span>` : ''}
          ${f.length ? `<span class="badge bad" title="${esc(f.join('\n'))}"><i class="fas fa-xmark"></i> ${L(`مش مستوفي (${f.length})`, `Not qualified (${f.length})`)}</span>` : ''}</div>
      </div>
      <div class="rc-stages">${STAGES.map((s, i) => { const cur = STAGES.findIndex(x => x.id === app.stage); return `<button class="rc-stage ${s.id === app.stage ? 'on' : i < cur ? 'past' : ''}" data-stage="${s.id}" ${closed || app.status === 'hired' ? 'disabled' : ''} title="${esc(L(s.ar, s.en))}"><i class="fas ${s.icon}"></i><span>${esc(L(s.ar, s.en))}</span></button>`; }).join('')}</div>
      <div class="card-foot row gap-8 wrap">
        <button class="btn btn-sm btn-primary" data-a="email"><i class="fas fa-envelope"></i> ${L('جهّز إيميل', 'Prepare email')}</button>
        <button class="btn btn-sm" data-a="iv"><i class="fas fa-calendar-plus"></i> ${L('احجز إنترفيو', 'Book interview')}</button>
        <button class="btn btn-sm" data-a="task"><i class="fas fa-laptop-code"></i> ${L('ابعت تاسك', 'Send task')}</button>
        ${closed ? `<button class="btn btn-sm" data-a="reopen"><i class="fas fa-rotate-left"></i> ${L('رجّعه للمراحل', 'Back in the process')}</button>`
          : app.status !== 'hired' ? `<button class="btn btn-sm btn-ghost" data-a="reject" style="color:var(--bad)"><i class="fas fa-user-xmark"></i> ${L('رفض', 'Reject')}</button><button class="btn btn-sm btn-ghost" data-a="withdraw">${L('انسحب', 'Withdrew')}</button>` : ''}
        <span class="grow"></span><button class="btn btn-sm btn-ghost" data-a="edit"><i class="fas fa-pen"></i> ${L('تعديل البيانات', 'Edit details')}</button></div></div>
      <div class="tabs mt-16" id="at">${[['info', 'fa-id-card', L('البيانات والإجابات', 'Details & answers')], ['ivs', 'fa-calendar-check', L(`الإنترفيوهات (${ivs.length})`, `Interviews (${ivs.length})`)], ['tasks', 'fa-laptop-code', L(`التاسكات (${tasks.length})`, `Tasks (${tasks.length})`)], ['log', 'fa-clock-rotate-left', L('السجل والملاحظات', 'Timeline & notes')], ['offer', 'fa-file-signature', L('العرض والتعيين', 'Offer & hire')]]
        .map(([k, ic, t]) => `<button class="tab ${tab === k ? 'active' : ''}" data-tab="${k}"><i class="fas ${ic}"></i> ${esc(t)}</button>`).join('')}</div>
      <div class="mt-16" id="ap">${pane(f, sc)}</div></div>`;
  };

  const pane = (f, sc) => {
    if (tab === 'ivs') return paneInterviews();
    if (tab === 'tasks') return paneTasks();
    if (tab === 'log') return paneLog();
    if (tab === 'offer') return paneOffer();
    return paneInfo(f, sc);
  };
  const fileBtn = (key, fl) => `<div class="pub-file"><i class="fas ${/pdf/.test(fl.mime || fl.name) ? 'fa-file-pdf' : 'fa-file'}"></i><span class="grow truncate">${esc(fl.name || key)}</span><span class="xs muted">${fl.size ? num(fl.size / 1024) + ' KB' : ''}</span><button class="btn btn-sm" data-file="${esc(key)}"><i class="fas fa-up-right-from-square"></i> ${L('افتح', 'Open')}</button></div>`;
  const paneInfo = (f, sc) => {
    const q = (job && job.questions) || [];
    const ans = app.answers || {};
    const files = app.files || {};
    const fmtAns = (qq, v) => { if (v == null || v === '' || (Array.isArray(v) && !v.length)) return `<span class="muted">—</span>`; if (qq.type === 'yesno') return v === 'yes' ? L('نعم', 'Yes') : L('لا', 'No'); if (qq.type === 'link') return `<a href="${esc(v)}" target="_blank" rel="noopener" dir="ltr">${esc(v)}</a>`; if (Array.isArray(v)) return v.map(esc).join('، '); return esc(v).replace(/\n/g, '<br>'); };
    const over = job && job.salaryMax && app.salary > job.salaryMax;
    return `<div class="grid g-2 gap-16 rc-two">
      <section class="card"><div class="card-head"><h3><i class="fas fa-id-card"></i> ${L('البيانات', 'Details')}</h3></div><div class="card-body"><dl class="kv">
        ${[['currentTitle'], ['years'], ['salary'], ['available'], ['city']].map(([k]) => { const b = BUILTIN.find(x => x[0] === k); const v = app[k]; return `<dt>${esc(L(b[1], b[2]))}</dt><dd class="${k === 'salary' && over ? 'bad-txt' : ''}">${v === '' || v == null ? '—' : k === 'salary' ? num(v) + (over ? ` <span class="xs">(${L('أعلى من الميزانية', 'above budget')})</span>` : '') : esc(v)}</dd>`; }).join('')}
        <dt>LinkedIn</dt><dd>${app.linkedin ? `<a href="${esc(app.linkedin)}" target="_blank" rel="noopener" dir="ltr" class="truncate">${esc(app.linkedin)}</a>` : '—'}</dd>
        <dt>${L('بورتفوليو', 'Portfolio')}</dt><dd>${app.portfolio ? `<a href="${esc(app.portfolio)}" target="_blank" rel="noopener" dir="ltr">${esc(app.portfolio)}</a>` : '—'}</dd></dl>
        ${Object.keys(files).length ? `<h4 class="mt-16 mb-8">${L('الملفات', 'Files')}</h4><div class="col gap-8">${Object.entries(files).map(([k, fl]) => fileBtn(k, fl)).join('')}</div>` : `<p class="muted small mt-16">${L('مفيش ملفات', 'No files')}</p>`}
        ${others.length ? `<div class="alert info mt-16"><i class="fas fa-clock-rotate-left"></i><div>${L('قدّم قبل كده:', 'Applied before:')} ${others.map(o => `<a href="#/recruit/app/${esc(o.id)}">${esc(o.jobTitle || '')}</a> (${esc(stageLabel(o.stage))}${o.status !== 'active' ? ' · ' + esc((STATUS_LABEL[o.status] || STATUS_LABEL.active)()) : ''})`).join('، ')}</div></div>` : ''}
      </div></section>
      <section class="card"><div class="card-head"><h3><i class="fas fa-list-check"></i> ${L('إجابات الأسئلة', 'Answers')}</h3></div><div class="card-body col gap-12">
        ${f.length ? `<div class="alert bad"><i class="fas fa-xmark"></i><div><b>${L('مش مستوفي:', 'Not met:')}</b> ${f.map(esc).join(' · ')}</div></div>` : ''}
        ${q.filter(x => x.type !== 'file').map(qq => `<div class="rc-ans ${failsRule(qq, ans[qq.id]) ? 'bad' : ''}"><div class="xs muted">${esc(qq.label)}</div><div>${fmtAns(qq, ans[qq.id])}</div></div>`).join('') || `<p class="muted small">${L('الوظيفة دي ما فيهاش أسئلة إضافية.', 'This job has no extra questions.')}</p>`}
        ${sc.total != null ? `<div class="divider"></div><div class="row between"><b>${L('التقييم الكلي', 'Overall score')}</b>${scoreBadge(sc.total)}</div>
          <div class="col gap-4">${((job && job.criteria && job.criteria.length) ? job.criteria : DEFAULT_CRITERIA).map(c => `<div class="row between small"><span>${esc(critLabel(c))}</span><span class="num">${sc.per && sc.per[c.id] != null ? sc.per[c.id].toFixed(1) + ' / 5' : '—'}</span></div>`).join('')}
          ${sc.task != null ? `<div class="row between small"><span>${L('التاسك', 'Task')}</span><span class="num">${num(sc.task)} / 100</span></div>` : ''}</div>` : ''}
      </div></section></div>`;
  };
  const paneInterviews = () => `<div class="card"><div class="card-head"><h3><i class="fas fa-calendar-check"></i> ${L('الإنترفيوهات', 'Interviews')}</h3><button class="btn btn-sm btn-primary" data-a="iv"><i class="fas fa-calendar-plus"></i> ${L('احجز إنترفيو', 'Book interview')}</button></div><div class="card-body col gap-12">
    ${ivs.length ? ivs.map(iv => `<div class="rc-ivcard ${iv.status}"><div class="row gap-8 wrap"><span class="icon-tile ${iv.status === 'done' ? 'ok' : iv.status === 'scheduled' ? '' : 'bad'}"><i class="fas ${iv.mode === 'online' ? 'fa-video' : iv.mode === 'phone' ? 'fa-phone' : 'fa-building'}"></i></span>
        <div class="grow min0"><b>${esc(pick(ROUNDS, iv.round))}</b> <span class="badge">${esc(ivStatus(iv.status))}</span><div class="small">${esc(fullWhen(iv.at))} · ${num(iv.minutes)} ${L('دقيقة', 'min')} · ${esc(pick(MODES, iv.mode))}</div>
          ${(iv.interviewers || []).length ? `<div class="xs muted">${L('مع:', 'With:')} ${esc(iv.interviewers.map(nameOf).join('، '))}</div>` : ''}${iv.location ? `<div class="xs muted">${esc(iv.location)}</div>` : ''}</div>
        <div class="row gap-4 wrap">
          ${iv.mode === 'online' && iv.status === 'scheduled' ? `<button class="btn btn-sm btn-ok" data-ivstart="${esc(iv.id)}"><i class="fas fa-video"></i> ${L('ابدأ الإنترفيو', 'Start')}</button><button class="btn btn-sm" data-ivlink="${esc(iv.id)}" title="${L('لينك المتقدم', 'Candidate link')}"><i class="fas fa-link"></i></button>` : ''}
          <button class="btn btn-sm" data-ivscore="${esc(iv.id)}"><i class="fas fa-star"></i> ${iv.scores ? L('التقييم', 'Scorecard') : L('قيّم', 'Score')}</button>
          <button class="btn btn-sm" data-ivmail="${esc(iv.id)}"><i class="fas fa-envelope"></i></button>
          <button class="btn btn-sm btn-ghost" data-ivedit="${esc(iv.id)}"><i class="fas fa-pen"></i></button>
          ${iv.status === 'scheduled' ? `<button class="btn btn-sm btn-ghost" data-ivno="${esc(iv.id)}" title="${L('ما حضرش', 'No show')}"><i class="fas fa-user-slash"></i></button>` : ''}
          <button class="btn btn-sm btn-ghost" data-ivdel="${esc(iv.id)}" style="color:var(--bad)" title="${L('إلغاء', 'Cancel')}"><i class="fas fa-trash"></i></button></div></div>
      ${iv.scores ? `<div class="rc-scorerow mt-8">${Object.entries(iv.scores).map(([k, v]) => { const c = ((job && job.criteria) || DEFAULT_CRITERIA).find(x => x.id === k); return c ? `<span class="chip">${esc(critLabel(c))}: <b class="num">${v}</b></span>` : ''; }).join('')}${iv.rec ? `<span class="badge ${(RECS.find(x => x[0] === iv.rec) || [])[3] || ''}">${esc(pick(RECS, iv.rec))}</span>` : ''}</div>${iv.feedback ? `<p class="small mt-8">${esc(iv.feedback)}</p>` : ''}` : ''}
    </div>`).join('') : `<p class="muted small">${L('لسه ما اتحجزش إنترفيو.', 'No interviews yet.')}</p>`}</div></div>`;
  const tState = (t) => {
    if (t.status === 'graded') return [L(`اتصحّح ${t.score}/100`, `Graded ${t.score}/100`), 'ok'];
    if (t.status === 'submitted') return [L('اتسلّم — مستني تصحيح', 'Handed in — to grade'), 'info'];
    if (t.status === 'opened') return now() > (t.deadlineMs || 0) + 600000 ? [L('الوقت خلص من غير تسليم', 'Expired, not handed in'), 'bad'] : [L('فتحه وبيشتغل', 'Opened, working'), 'warn'];
    return [L('اتبعت — لسه ما فتحوش', 'Sent — not opened yet'), ''];
  };
  const paneTasks = () => `<div class="card"><div class="card-head"><h3><i class="fas fa-laptop-code"></i> ${L('التاسكات', 'Tasks')}</h3><button class="btn btn-sm btn-primary" data-a="task"><i class="fas fa-paper-plane"></i> ${L('ابعت تاسك', 'Send task')}</button></div><div class="card-body col gap-12">
    ${tasks.length ? tasks.map(t => { const [s, c] = tState(t); return `<div class="rc-ivcard"><div class="row gap-8 wrap"><span class="icon-tile ${c}"><i class="fas fa-laptop-code"></i></span>
      <div class="grow min0"><b>${esc(t.title)}</b> <span class="badge ${c}">${esc(s)}</span>
        <div class="xs muted">${L('اتبعت', 'Sent')} ${esc(fmtWhen(t.sentMs, { hour: 'numeric', minute: '2-digit' }))}${t.openedAt ? ` · ${L('اتفتح', 'opened')} ${esc(fmtWhen(t.openedAt.toMillis ? t.openedAt.toMillis() : t.openedAt, { hour: 'numeric', minute: '2-digit' }))}` : ''}${t.deadlineMs ? ` · ${L('آخر معاد', 'deadline')} ${esc(fmtWhen(t.deadlineMs, { hour: 'numeric', minute: '2-digit' }))}` : t.hours ? ` · ${L(`${t.hours} ساعة من الفتح`, `${t.hours}h from opening`)}` : ''}${t.submittedAt ? ` · ${L('اتسلّم', 'handed in')} ${esc(fmtWhen(t.submittedAt.toMillis ? t.submittedAt.toMillis() : t.submittedAt, { hour: 'numeric', minute: '2-digit' }))}` : ''}</div></div>
      <div class="row gap-4 wrap">${t.status === 'submitted' || t.status === 'graded' || t.answer || (t.subFiles || []).length ? `<button class="btn btn-sm btn-primary" data-tview="${esc(t.id)}"><i class="fas fa-eye"></i> ${L('التسليم', 'Submission')}</button>` : ''}
        <button class="btn btn-sm" data-tcopy="${esc(t.id)}" title="${L('انسخ اللينك', 'Copy link')}"><i class="fas fa-link"></i></button><button class="btn btn-sm" data-tmail="${esc(t.id)}"><i class="fas fa-envelope"></i></button>
        ${t.status === 'opened' ? `<button class="btn btn-sm btn-ghost" data-treset="${esc(t.id)}" title="${L('افتحه تاني (جهاز تاني / علّق)', 'Reopen (other device / stuck)')}"><i class="fas fa-rotate"></i></button>` : ''}
        <button class="btn btn-sm btn-ghost" data-tdel="${esc(t.id)}" style="color:var(--bad)"><i class="fas fa-trash"></i></button></div></div>
      ${t.review ? `<p class="small mt-8"><b>${L('ملاحظات التصحيح:', 'Review:')}</b> ${esc(t.review)}</p>` : ''}</div>`; }).join('') : `<p class="muted small">${L('لسه ما اتبعتش تاسك.', 'No tasks sent yet.')}</p>`}</div></div>`;
  const LOG_ICON = { stage: 'fa-arrow-right-arrow-left', note: 'fa-note-sticky', email: 'fa-envelope', interview: 'fa-calendar-check', score: 'fa-star', task: 'fa-laptop-code', rejected: 'fa-user-xmark', withdrawn: 'fa-person-walking-arrow-right', reopened: 'fa-rotate-left', offer: 'fa-file-signature', hired: 'fa-circle-check', created: 'fa-user-plus', edit: 'fa-pen' };
  const paneLog = () => `<div class="grid g-2 gap-16 rc-two"><section class="card"><div class="card-head"><h3><i class="fas fa-note-sticky"></i> ${L('ملاحظة جديدة', 'New note')}</h3></div><div class="card-body col gap-8">
      <textarea class="textarea" id="nt" rows="4" placeholder="${L('مثلاً: كلّمته وطلب يأجّل الإنترفيو للأحد', 'e.g. called him, asked to move the interview to Sunday')}"></textarea><div><button class="btn btn-primary btn-sm" id="nadd"><i class="fas fa-plus"></i> ${L('أضف', 'Add')}</button></div></div></section>
    <section class="card"><div class="card-head"><h3><i class="fas fa-clock-rotate-left"></i> ${L('السجل', 'Timeline')}</h3></div><div class="card-body"><div class="timeline">
      ${log.map(x => `<div class="tl-item ${x.type === 'rejected' ? 'bad' : x.type === 'hired' ? 'ok' : x.type === 'note' ? 'warn' : ''}"><div class="row gap-8"><i class="fas ${LOG_ICON[x.type] || 'fa-circle'} muted"></i><b class="small grow">${x.type === 'email' ? `${L('إيميل:', 'Email:')} ${esc(x.subject || '')}` : esc(x.text || '')}</b></div>
        ${x.type === 'email' ? `<details class="mt-4"><summary class="xs muted" style="cursor:pointer">${L('الرسالة', 'Message')}</summary><pre class="tr-text small">${esc(x.text || '')}</pre></details>` : ''}
        <div class="xs muted">${esc(x.byName || '')} · ${esc(fmtWhen(x.atMs, { hour: 'numeric', minute: '2-digit' }))}</div></div>`).join('') || `<p class="muted small">${L('لسه مفيش حاجة.', 'Nothing yet.')}</p>`}</div></div></section></div>`;
  const paneOffer = () => { const o = app.offer || {}; return `<div class="card" style="max-width:820px"><div class="card-head"><h3><i class="fas fa-file-signature"></i> ${L('العرض', 'Offer')}</h3>${o.status ? `<span class="badge ${o.status === 'accepted' ? 'ok' : o.status === 'declined' ? 'bad' : o.status === 'sent' ? 'info' : ''}">${esc(offerStatus(o.status))}</span>` : ''}</div><div class="card-body col gap-12">
    <div class="form-grid"><div class="field"><label>${L('الراتب الشهري', 'Monthly salary')}</label><input class="input num" type="number" min="0" id="os" value="${esc(o.salary || '')}">${job && (job.salaryMin || job.salaryMax) ? `<div class="xs muted mt-4">${L(`الميزانية: ${num(job.salaryMin || 0)} – ${num(job.salaryMax || 0)}`, `Budget: ${num(job.salaryMin || 0)} – ${num(job.salaryMax || 0)}`)}${app.salary ? ` · ${L(`طلب ${num(app.salary)}`, `asked ${num(app.salary)}`)}` : ''}</div>` : ''}</div>
      <div class="field"><label>${L('تاريخ البداية', 'Start date')}</label><input class="input" type="date" id="ost" value="${esc(o.start || '')}"></div>
      <div class="field"><label>${L('فترة الاختبار (شهور)', 'Probation (months)')}</label><input class="input num" type="number" min="0" max="12" id="opr" value="${esc(o.probation ?? 3)}"></div>
      <div class="field"><label>${L('حالة العرض', 'Offer status')}</label><select class="select" id="ost2">${OFFER_STATUS.map(([k, a, e]) => `<option value="${k}" ${(o.status || 'draft') === k ? 'selected' : ''}>${esc(L(a, e))}</option>`).join('')}</select></div>
      <div class="field span-2"><label>${L('تفاصيل تانية (مزايا، مواعيد…)', 'Other details (benefits, hours…)')}</label><textarea class="textarea" id="on" rows="3">${esc(o.notes || '')}</textarea></div></div>
    <div class="row gap-8 wrap"><button class="btn btn-primary" id="osave"><i class="fas fa-floppy-disk"></i> ${L('حفظ العرض', 'Save offer')}</button><button class="btn" id="omail"><i class="fas fa-envelope"></i> ${L('جهّز إيميل العرض', 'Prepare offer email')}</button></div>
    <div class="divider"></div>
    ${app.status === 'hired' ? `<div class="alert ok"><i class="fas fa-circle-check"></i><div>${L('اتعيّن', 'Hired')}${app.employeeEmail ? ` — <a href="#/employees">${esc(app.employeeEmail)}</a>` : ''}</div></div>`
      : `<div class="row between gap-12 wrap"><div><b>${L('حوّله لموظف', 'Make them an employee')}</b><div class="xs muted">${L('بيفتح «موظف جديد» وفيه بياناته متعبّية (الاسم، المسمى، القسم، تاريخ البداية، الموبايل والإيميل). بعد ما تعمل الحساب بيتعلّم «اتعيّن».', 'Opens "New employee" with their details filled in. Once the account is made they are marked hired.')}</div></div>
        <button class="btn btn-ok" id="ohire" ${o.status === 'accepted' ? '' : 'disabled title="' + esc(L('غيّر حالة العرض لـ «اتقبل» الأول', 'Set the offer to "Accepted" first')) + '"'}><i class="fas fa-user-plus"></i> ${L('حوّله لموظف', 'Make employee')}</button></div>`}
    </div></div>`; };

  // ------------------------------------------------------------ actions
  const nav = (t) => { tab = t; try { sessionStorage.setItem('am_rc_tab', t); } catch {} draw(); };
  root.addEventListener('click', async (e) => {
    const tb = e.target.closest('[data-tab]'); if (tb) { nav(tb.dataset.tab); return; }
    const st = e.target.closest('[data-stage]');
    if (st && !st.disabled) {
      if (st.dataset.stage === app.stage) return;
      if (st.dataset.stage === 'hired') { nav('offer'); toast(L('التعيين من هنا: العرض ← حوّله لموظف', 'Hire from here: Offer → Make employee'), '', 'info'); return; }
      try { await moveStage(app, st.dataset.stage); suggestNext(st.dataset.stage); } catch (ex) { toastErr(ex); }
      return;
    }
    const fb = e.target.closest('[data-file]');
    if (fb) { const fl = (app.files || {})[fb.dataset.file]; if (!fl) return; const w = window.open('', '_blank'); try { const url = await openFile(fl); if (w) w.location = url; else location.href = url; } catch (ex) { if (w) w.close(); toastErr(ex); } return; }
    const a = e.target.closest('[data-a]');
    if (a) {
      const k = a.dataset.a;
      if (k === 'email') composer({ app, job, settings, kind: defaultKind() });
      else if (k === 'iv') interviewModal(null);
      else if (k === 'task') taskModal();
      else if (k === 'reject') rejectModal();
      else if (k === 'withdraw') { if (await confirmDialog({ title: L('انسحب من التقديم؟', 'Withdrew?'), message: app.name, okText: L('تمام', 'OK') })) withdrawApp(app).catch(toastErr); }
      else if (k === 'reopen') reopenApp(app).catch(toastErr);
      else if (k === 'edit') editModal();
      return;
    }
    const pick1 = (attr) => { const b = e.target.closest(`[${attr}]`); return b ? b.getAttribute(attr) : null; };
    let x;
    if ((x = pick1('data-ivstart'))) startInterview(ivs.find(i => i.id === x), e.target.closest('button'));
    else if ((x = pick1('data-ivlink'))) { const iv = ivs.find(i => i.id === x); try { await navigator.clipboard.writeText(interviewLink(iv.linkId)); toast(L('لينك المتقدم اتنسخ', 'Candidate link copied'), '', 'info'); } catch {} }
    else if ((x = pick1('data-ivscore'))) scoreModal(ivs.find(i => i.id === x));
    else if ((x = pick1('data-ivmail'))) { const iv = ivs.find(i => i.id === x); composer({ app, job, settings, kind: ROUND_KIND[iv.round] || 'hr', iv }); }
    else if ((x = pick1('data-ivedit'))) interviewModal(ivs.find(i => i.id === x));
    else if ((x = pick1('data-ivno'))) { const iv = ivs.find(i => i.id === x); setInterviewStatus(iv, 'noshow').catch(toastErr); }
    else if ((x = pick1('data-ivdel'))) { const iv = ivs.find(i => i.id === x); if (await confirmDialog({ title: L('إلغاء الإنترفيو', 'Cancel interview'), message: `${pick(ROUNDS, iv.round)} — ${fullWhen(iv.at)}`, okText: L('إلغاء الإنترفيو', 'Cancel it'), okClass: 'btn-danger', cancelText: L('رجوع', 'Back') })) deleteInterview(iv).catch(toastErr); }
    else if ((x = pick1('data-tview'))) submissionModal(tasks.find(t => t.id === x));
    else if ((x = pick1('data-tcopy'))) { try { await navigator.clipboard.writeText(taskLink(x)); toast(L('لينك التاسك اتنسخ', 'Task link copied'), '', 'info'); } catch {} }
    else if ((x = pick1('data-tmail'))) { const t = tasks.find(y => y.id === x); composer({ app, job, settings, kind: 'task', task: t }); }
    else if ((x = pick1('data-treset'))) { const t = tasks.find(y => y.id === x); if (await confirmDialog({ title: L('تفتح التاسك تاني؟', 'Reopen the task?'), message: L('اللينك هيشتغل من أي جهاز من تاني، والمدة هتبدأ من أول ما يفتحه. اللي كتبه هيفضل موجود.', 'The link will work on any device again and the time restarts when opened. What they wrote stays.') })) resetTask(t).catch(toastErr); }
    else if ((x = pick1('data-tdel'))) { const t = tasks.find(y => y.id === x); if (await confirmDialog({ title: L('مسح التاسك', 'Delete task'), message: t.title, okText: L('مسح', 'Delete'), okClass: 'btn-danger' })) deleteTask(t).catch(toastErr); }
    else if (e.target.closest('#nadd')) { const t = root.querySelector('#nt'); busy(e.target.closest('button'), async () => { try { await addNote(app, t.value); t.value = ''; } catch (ex) { toastErr(ex); } }); }
    else if (e.target.closest('#osave')) saveOfferNow(e.target.closest('button'));
    else if (e.target.closest('#omail')) composer({ app, job, settings, kind: 'offer' });
    else if (e.target.closest('#ohire')) hire();
  });
  const defaultKind = () => ({ new: 'received', hr: 'hr', tech: 'tech' }[app.stage] || 'other');
  /** after moving to an interview / task stage: offer the next step */
  const suggestNext = async (stage) => {
    const round = { hr: 'hr', tech: 'tech' }[stage];
    if (!round) return;
    const { livePop } = await import('../core/ui.js');
    const el = livePop({ icon: round ? 'fa-calendar-plus' : 'fa-laptop-code', cls: 'info', title: round ? L('اتنقل — تحب تحجز الإنترفيو؟', 'Moved — book the interview?') : L('اتنقل — تحب تبعتله تاسك؟', 'Moved — send a task?'), href: '#', action: round ? L('احجز', 'Book') : L('ابعت تاسك', 'Send task'), ttl: 10000 });
    const lnk = el.querySelector('a');
    if (lnk) lnk.addEventListener('click', (ev) => { ev.preventDefault(); if (round) interviewModal(null, round); else taskModal(); });
  };

  // ------------------------------------------------------------ modals
  function editModal() {
    const fields = ['name', 'email', 'currentTitle', 'years', 'salary', 'available', 'city', 'linkedin', 'portfolio', 'referredBy'];
    const lab = { name: L('الاسم', 'Name'), email: L('الإيميل', 'Email'), referredBy: L('رشّحه مين؟', 'Referred by'), ...Object.fromEntries(BUILTIN.map(b => [b[0], L(b[1], b[2])])) };
    const m = modal({ title: L('تعديل البيانات', 'Edit details'), icon: 'fa-pen', size: 'wide',
      body: `<div class="form-grid">${fields.map(k => `<div class="field"><label>${esc(lab[k])}</label><input class="input ${k === 'years' || k === 'salary' ? 'num' : ''}" ${k === 'years' || k === 'salary' ? 'type="number" min="0"' : ''} name="${k}" value="${esc(app[k] ?? '')}"></div>`).join('')}
        <div class="field"><label>${L('الموبايل', 'Mobile')}</label><input class="input" disabled dir="ltr" value="${esc(app.phone || '')}"></div>
        <div class="field span-2"><label>${L('ملف جديد (مثلاً CV محدّث)', 'New file (e.g. an updated CV)')}</label><label class="dropzone"><input type="file" hidden id="ef"><i class="fas fa-paperclip"></i> <span>${L('اختار ملف', 'Choose a file')}</span></label></div></div>`,
      foot: `<button class="btn" data-close>${L('إلغاء', 'Cancel')}</button><button class="btn btn-primary" id="es"><i class="fas fa-floppy-disk"></i> ${L('حفظ', 'Save')}</button>` });
    let nf = null; m.$('#ef').onchange = (ev) => { nf = ev.target.files[0] || null; if (nf) m.$('#ef').parentElement.querySelector('span').textContent = nf.name; };
    m.$('#es').onclick = (ev) => busy(ev.currentTarget, async () => {
      const d = {}; fields.forEach(k => { const v = m.el.querySelector(`[name="${k}"]`).value.trim(); d[k] = (k === 'years' || k === 'salary') ? (v === '' ? '' : Number(v)) : v; });
      if (d.name.length < 2) { toast(L('اكتب الاسم', 'Write the name'), '', 'info'); return; }
      try { if (nf) { const up = await uploadFile('app', app.id, nf); d.files = { ...(app.files || {}), [`f${Date.now().toString(36)}`]: up }; } await updateApp(app, d); m.close(); toast(L('اتحفظ', 'Saved')); } catch (ex) { toastErr(ex); }
    });
  }
  function rejectModal() {
    const m = modal({ title: L('رفض المتقدم', 'Reject applicant'), icon: 'fa-user-xmark', size: 'narrow',
      body: `<div class="col gap-12"><div class="field"><label>${L('السبب', 'Reason')}</label><select class="select" id="rr">${REJECT_REASONS.map(([k, a, e2]) => `<option value="${k}">${esc(L(a, e2))}</option>`).join('')}</select></div>
        <div class="field"><label>${L('ملاحظة (اختياري)', 'Note (optional)')}</label><textarea class="textarea" id="rn" rows="2"></textarea></div>
        <label class="row gap-8 small"><input type="checkbox" id="rm" ${app.email ? 'checked' : 'disabled'}> ${L('جهّزلي إيميل الاعتذار بعدها', 'Prepare the regret email next')}</label></div>`,
      foot: `<button class="btn" data-close>${L('رجوع', 'Back')}</button><button class="btn btn-danger" id="rg">${L('رفض', 'Reject')}</button>` });
    m.$('#rg').onclick = (ev) => busy(ev.currentTarget, async () => { try { await rejectApp(app, m.$('#rr').value, m.$('#rn').value); const mail = m.$('#rm').checked; m.close(); if (mail) composer({ app, job, settings, kind: 'reject' }); } catch (ex) { toastErr(ex); } });
  }
  function interviewModal(iv, round = '') {
    const r = iv ? iv.round : (round || { hr: 'hr', tech: 'tech' }[app.stage] || (app.stage === 'new' ? 'hr' : 'tech'));
    const [d0, t0] = toInputs(iv && iv.at);
    const chosen = new Set((iv && iv.interviewers) || [session.email]);
    const ppl = activePeople().sort((a, b) => (chosen.has(b.email) - chosen.has(a.email)) || String(a.name).localeCompare(String(b.name), 'ar'));
    const m = modal({ title: iv ? L('تعديل الإنترفيو', 'Edit interview') : L('حجز إنترفيو', 'Book interview'), icon: 'fa-calendar-plus', size: 'wide',
      body: `<div class="form-grid">
        <div class="field"><label>${L('النوع', 'Round')}</label><select class="select" id="ir">${(ROUND_CHOICES.some(x => x[0] === r) ? ROUND_CHOICES : [...ROUND_CHOICES, ROUNDS.find(x => x[0] === r)].filter(Boolean)).map(([k, a, e2]) => `<option value="${k}" ${r === k ? 'selected' : ''}>${esc(L(a, e2))}</option>`).join('')}</select></div>
        <div class="field"><label>${L('الطريقة', 'Mode')}</label><select class="select" id="im">${MODES.map(([k, a, e2]) => `<option value="${k}" ${((iv && iv.mode) || (r === 'phone' ? 'phone' : 'office')) === k ? 'selected' : ''}>${esc(L(a, e2))}</option>`).join('')}</select></div>
        <div class="field"><label>${L('اليوم', 'Day')}</label><input class="input" type="date" id="id" value="${esc(d0)}"></div>
        <div class="field"><label>${L('الساعة', 'Time')}</label><input class="input" type="time" id="it" value="${esc(t0)}"></div>
        <div class="field"><label>${L('المدة (دقيقة)', 'Length (min)')}</label><input class="input num" type="number" min="10" max="240" id="iml" value="${esc((iv && iv.minutes) || settings.minutes || 45)}"></div>
        <div class="field"><label>${L('المكان', 'Place')}</label><input class="input" id="il" value="${esc(iv ? iv.location || '' : '')}" placeholder="${L('للإنترفيو في المكتب', 'For in-office interviews')}"><div class="xs muted mt-4" id="ilh"></div></div>
        <div class="field span-2"><label>${L('مين هيعمل الإنترفيو', 'Interviewers')}</label><div class="search mb-8"><i class="fas fa-search"></i><input class="input" id="iq" placeholder="${L('ابحث', 'Search')}"></div><div class="chat-members" id="ip" style="max-height:200px"></div></div>
        <div class="field span-2"><label>${L('ملاحظات (بتظهر في الإيميل لو حبيت)', 'Notes (can go in the email)')}</label><textarea class="textarea" id="in" rows="2" placeholder="${L('مثلاً: هات معاك نسخة من البطاقة', 'e.g. bring your ID')}">${esc((iv && iv.notes) || '')}</textarea></div></div>`,
      foot: `<button class="btn" data-close>${L('إلغاء', 'Cancel')}</button><button class="btn btn-primary" id="is"><i class="fas fa-floppy-disk"></i> ${iv ? L('حفظ', 'Save') : L('احجز', 'Book')}</button>` });
    const modeHint = () => { const md = m.$('#im').value; const il = m.$('#il'); m.$('#ilh').textContent = md === 'online' ? L('هيتعمل لينك خاص بالمتقدم يدخل منه — بيتحط في الإيميل لوحده.', 'A personal link is made for the candidate — it goes into the email.') : md === 'phone' ? L('هتكلّمه على رقمه.', 'You call their number.') : ''; if (md === 'office' && !il.value && settings.officeAddress) il.value = settings.officeAddress; il.disabled = md !== 'office'; };
    m.$('#im').onchange = modeHint; modeHint();
    const drawP = () => { const q = m.$('#iq').value.trim().toLowerCase(); m.$('#ip').innerHTML = ppl.filter(p => !q || `${p.name} ${p.title}`.toLowerCase().includes(q)).map(p => `<label class="chat-member" style="cursor:pointer"><input type="checkbox" data-p="${esc(p.email)}" ${chosen.has(p.email) ? 'checked' : ''}>${avatar(p, 'sm')}<span class="grow min0"><b class="truncate">${esc(p.name || p.email)}</b><small class="truncate">${esc(p.title || '')}</small></span></label>`).join(''); };
    m.$('#iq').oninput = drawP; m.$('#ip').onchange = (ev) => { const c = ev.target.closest('[data-p]'); if (c) { if (c.checked) chosen.add(c.dataset.p); else chosen.delete(c.dataset.p); } }; drawP();
    m.$('#is').onclick = (ev) => busy(ev.currentTarget, async () => {
      try {
        const saved = await saveInterview(app, { ...(iv || {}), round: m.$('#ir').value, mode: m.$('#im').value, at: cairoInput(m.$('#id').value, m.$('#it').value), minutes: m.$('#iml').value, location: m.$('#im').value === 'office' ? m.$('#il').value : '', interviewers: [...chosen], notes: m.$('#in').value });
        m.close(); toast(iv ? L('اتحفظ', 'Saved') : L('الإنترفيو اتحجز', 'Interview booked'));
        if (!iv && app.stage !== saved.round && ['hr', 'tech'].includes(saved.round) && STAGES.findIndex(s => s.id === saved.round) > STAGES.findIndex(s => s.id === app.stage)) moveStage(app, saved.round).catch(() => {});
        if (!iv && app.email) composer({ app, job, settings, kind: ROUND_KIND[saved.round] || 'hr', iv: saved });
        nav('ivs');
      } catch (ex) { toastErr(ex); }
    });
  }
  async function startInterview(iv, btn) {
    if (!iv) return;
    const calls = await import('../services/calls.js');
    if (calls.currentCall()) { toast(L('إنت في مكالمة دلوقتي', 'You are already in a call'), '', 'info'); return; }
    await busy(btn, async () => {
      try {
        await calls.startRoom({ topic: `${L('إنترفيو', 'Interview')} — ${app.name}`, people: (iv.interviewers || []).filter(e => e !== session.email).slice(0, 5) });
        const c = calls.currentCall();
        const url = await calls.guestLink();
        await linkInterviewCall(iv, c.id, url);
        toast(L('الإنترفيو بدأ', 'Interview started'), L('المتقدم هيدخل من لينكه، وهيظهرلك «عايز يدخل» — دوس «سماح».', 'The candidate joins from their link; press "Let in" when they appear.'));
      } catch (ex) { toastErr(ex); }
    });
  }
  function scoreModal(iv) {
    const crit = (job && job.criteria && job.criteria.length) ? job.criteria : DEFAULT_CRITERIA;
    const sc = { ...(iv.scores || {}) };
    let rec = iv.rec || '';
    const att = new Set(iv.attended || iv.interviewers || [session.email]);
    const m = modal({ title: L(`تقييم — ${pick(ROUNDS, iv.round)}`, `Scorecard — ${pick(ROUNDS, iv.round)}`), icon: 'fa-star', size: 'wide',
      body: `<div class="col gap-12"><div class="col gap-8" id="sc">${crit.map(c => `<div class="rc-crit"><span class="grow">${esc(critLabel(c))} <span class="xs muted">(${c.w})</span></span><div class="rc-stars" data-c="${esc(c.id)}">${[1, 2, 3, 4, 5].map(n => `<button type="button" data-n="${n}" class="${sc[c.id] >= n ? 'on' : ''}">${n}</button>`).join('')}</div></div>`).join('')}</div>
        <div class="field"><label>${L('التوصية', 'Recommendation')}</label><div class="seg" id="sr">${RECS.map(([k, a, e2]) => `<button type="button" data-r="${k}" class="${rec === k ? 'on' : ''}">${esc(L(a, e2))}</button>`).join('')}</div></div>
        <div class="field"><label>${L('ملاحظات', 'Feedback')}</label><textarea class="textarea" id="sf" rows="4">${esc(iv.feedback || '')}</textarea></div>
        <div class="field"><label>${L('حضر الإنترفيو', 'Attended')}</label><div class="row gap-4 wrap">${[...new Set([...(iv.interviewers || []), session.email])].map(em => `<label class="chip chip-check"><input type="checkbox" data-att="${esc(em)}" ${att.has(em) ? 'checked' : ''}> ${esc(nameOf(em))}</label>`).join('')}</div></div></div>`,
      foot: `<button class="btn" data-close>${L('إلغاء', 'Cancel')}</button><button class="btn btn-primary" id="ss"><i class="fas fa-floppy-disk"></i> ${L('حفظ التقييم', 'Save scorecard')}</button>` });
    m.$('#sc').onclick = (ev) => { const b = ev.target.closest('[data-n]'); if (!b) return; const box = b.closest('[data-c]'); sc[box.dataset.c] = Number(b.dataset.n); box.querySelectorAll('[data-n]').forEach(x => x.classList.toggle('on', Number(x.dataset.n) <= sc[box.dataset.c])); };
    m.$('#sr').onclick = (ev) => { const b = ev.target.closest('[data-r]'); if (!b) return; rec = b.dataset.r; m.$$('#sr [data-r]').forEach(x => x.classList.toggle('on', x === b)); };
    m.$('#ss').onclick = (ev) => busy(ev.currentTarget, async () => {
      if (!Object.keys(sc).length) { toast(L('قيّم معيار واحد على الأقل', 'Score at least one criterion'), '', 'info'); return; }
      try { await saveScorecard(iv, { scores: sc, rec, feedback: m.$('#sf').value, attended: m.$$('[data-att]').filter(c => c.checked).map(c => c.dataset.att) }); m.close(); toast(L('التقييم اتحفظ', 'Scorecard saved')); refreshScore(app, job).catch(() => {}); } catch (ex) { toastErr(ex); }
    });
  }
  function taskModal() {
    let bank = [], files = [];
    const m = modal({ title: L('ابعت تاسك', 'Send a task'), icon: 'fa-laptop-code', size: 'wide',
      body: `<div class="col gap-12"><div class="field"><label>${L('من بنك التاسكات', 'From the task bank')}</label><select class="select" id="tb"><option value="">${L('— تاسك جديد —', '— a new task —')}</option></select></div>
        <div class="field"><label>${L('العنوان', 'Title')} *</label><input class="input" id="tt" maxlength="160"></div>
        <div class="field"><label>${L('المطلوب بالتفصيل', 'The brief')}</label><textarea class="textarea" id="tbd" rows="8"></textarea></div>
        <div class="field"><label>${L('ملفات مع التاسك', 'Files with the task')}</label><div class="col gap-8" id="tfl"></div><label class="dropzone mt-8"><input type="file" hidden id="tf"><i class="fas fa-paperclip"></i> ${L('أضف ملف', 'Add a file')}</label></div>
        <div class="field"><label>${L('معاد التسليم', 'Deadline')}</label><div class="seg" id="tdm"><button type="button" data-m="h" class="on">${L('مدة من أول ما يفتحه', 'Time from opening')}</button><button type="button" data-m="d">${L('يوم وساعة محددين', 'A fixed date')}</button></div>
          <div class="row gap-8 mt-8" id="tdh"><input class="input num" type="number" min="1" max="720" id="th" value="48" style="width:110px"><span class="small">${L('ساعة', 'hours')}</span></div>
          <div class="row gap-8 mt-8 hidden" id="tdd"><input class="input" type="date" id="tdd1"><input class="input" type="time" id="tdd2" value="23:59"></div></div>
        <label class="row gap-8 small"><input type="checkbox" id="tsb"> ${L('احفظه في بنك التاسكات كمان', 'Also save it to the task bank')}</label></div>`,
      foot: `<button class="btn" data-close>${L('إلغاء', 'Cancel')}</button><button class="btn btn-primary" id="tgo"><i class="fas fa-paper-plane"></i> ${L('اعمل اللينك', 'Create the link')}</button>` });
    let mode = 'h';
    const drawFiles = () => { m.$('#tfl').innerHTML = files.map((f, i) => `<div class="pub-file"><i class="fas fa-file"></i><span class="grow truncate">${esc(f.name)}</span><button class="btn btn-sm btn-ghost" data-x="${i}"><i class="fas fa-xmark"></i></button></div>`).join(''); };
    m.$('#tfl').onclick = (ev) => { const b = ev.target.closest('[data-x]'); if (b) { files.splice(Number(b.dataset.x), 1); drawFiles(); } };
    m.$('#tf').onchange = async (ev) => { const f = ev.target.files[0]; if (!f) return; try { files.push(await uploadFile('bank', app.id, f)); drawFiles(); } catch (ex) { toastErr(ex); } ev.target.value = ''; };
    m.$('#tdm').onclick = (ev) => { const b = ev.target.closest('[data-m]'); if (!b) return; mode = b.dataset.m; m.$$('#tdm button').forEach(x => x.classList.toggle('on', x === b)); m.$('#tdh').classList.toggle('hidden', mode !== 'h'); m.$('#tdd').classList.toggle('hidden', mode !== 'd'); };
    const off = watchBank(r => { bank = r; m.$('#tb').innerHTML = `<option value="">${L('— تاسك جديد —', '— a new task —')}</option>` + bank.map(t => `<option value="${esc(t.id)}">${esc(t.title)}</option>`).join(''); });
    const close0 = m.close; m.close = () => { off(); close0(); };
    m.$('#tb').onchange = (ev) => { const t = bank.find(x => x.id === ev.target.value); if (!t) return; m.$('#tt').value = t.title || ''; m.$('#tbd').value = t.body || ''; if (t.hours) { m.$('#th').value = t.hours; m.$$('#tdm button')[0].click(); } files = [...(t.files || [])]; drawFiles(); };
    m.$('#tgo').onclick = (ev) => busy(ev.currentTarget, async () => {
      try {
        const due = mode === 'd' ? cairoInput(m.$('#tdd1').value, m.$('#tdd2').value) : 0;
        if (mode === 'd' && (!due || due < now())) { toast(L('اختار يوم وساعة جايين', 'Pick a future date and time'), '', 'info'); return; }
        const data = { title: m.$('#tt').value, body: m.$('#tbd').value, files, hours: mode === 'h' ? m.$('#th').value : 0, dueMs: due };
        const id = await sendTask(app, data);
        if (m.$('#tsb').checked) saveBankTask({ title: data.title, body: data.body, hours: Number(data.hours) || 48, files }).catch(() => {});
        m.close(); nav('tasks');
        composer({ app, job, settings, kind: 'task', task: { id, ...data } });
      } catch (ex) { toastErr(ex); }
    });
  }
  function submissionModal(t) {
    const m = modal({ title: L('تسليم التاسك', 'Task submission'), icon: 'fa-eye', size: 'wide',
      body: `<div class="col gap-12"><div class="xs muted">${esc(t.title)}${t.submittedAt ? ` · ${L('اتسلّم', 'handed in')} ${esc(fmtWhen(t.submittedAt.toMillis ? t.submittedAt.toMillis() : t.submittedAt, { hour: 'numeric', minute: '2-digit' }))}` : ` · ${L('لسه ما اتسلّمش — ده اللي كاتبه لحد دلوقتي', 'not handed in yet — what they wrote so far')}`}</div>
        <div><b>${L('الإجابة', 'Answer')}</b><pre class="tr-text mt-8">${esc(t.answer || '—')}</pre></div>
        ${(t.links || []).length ? `<div><b>${L('الروابط', 'Links')}</b><div class="col gap-4 mt-8">${t.links.map(u => `<a href="${esc(u)}" target="_blank" rel="noopener" dir="ltr">${esc(u)}</a>`).join('')}</div></div>` : ''}
        ${(t.subFiles || []).length ? `<div><b>${L('الملفات', 'Files')}</b><div class="col gap-8 mt-8">${t.subFiles.map((f, i) => `<div class="pub-file"><i class="fas fa-file"></i><span class="grow truncate">${esc(f.name)}</span><button class="btn btn-sm" data-sf="${i}"><i class="fas fa-download"></i></button></div>`).join('')}</div></div>` : ''}
        <div class="divider"></div>
        <div class="form-grid"><div class="field"><label>${L('الدرجة من 100', 'Grade out of 100')}</label><input class="input num" type="number" min="0" max="100" id="gs" value="${esc(t.score ?? '')}"></div>
          <div class="field span-2"><label>${L('ملاحظات التصحيح', 'Review notes')}</label><textarea class="textarea" id="gr" rows="3">${esc(t.review || '')}</textarea></div></div></div>`,
      foot: `<button class="btn" data-close>${L('قفل', 'Close')}</button><button class="btn btn-primary" id="gsv" ${t.status === 'submitted' || t.status === 'graded' ? '' : 'disabled'}><i class="fas fa-check"></i> ${L('حفظ الدرجة', 'Save grade')}</button>` });
    m.el.addEventListener('click', async (ev) => { const b = ev.target.closest('[data-sf]'); if (!b) return; const f = t.subFiles[Number(b.dataset.sf)]; const w = window.open('', '_blank'); try { const url = await openFile(f); if (w) w.location = url; } catch (ex) { if (w) w.close(); toastErr(ex); } });
    m.$('#gsv').onclick = (ev) => busy(ev.currentTarget, async () => { const v = m.$('#gs').value; if (v === '') { toast(L('اكتب الدرجة', 'Enter the grade'), '', 'info'); return; } try { await gradeTask(t, v, m.$('#gr').value); m.close(); toast(L('اتحفظ', 'Saved')); refreshScore(app, job).catch(() => {}); } catch (ex) { toastErr(ex); } });
  }
  async function saveOfferNow(btn) {
    await busy(btn, async () => { try { await saveOffer(app, { salary: root.querySelector('#os').value, start: root.querySelector('#ost').value, probation: root.querySelector('#opr').value, notes: root.querySelector('#on').value, status: root.querySelector('#ost2').value }); toast(L('العرض اتحفظ', 'Offer saved')); } catch (ex) { toastErr(ex); } });
  }
  async function hire() {
    const { openEditor } = await import('./employees.js');
    const o = app.offer || {};
    openEditor(null, { prefill: { name: app.name, title: (job && job.title) || app.jobTitle || '', department: (job && job.department) || '', hireDate: o.start || '', phone: app.phone || '', contactEmail: app.email || '' },
      onCreated: (email) => { markHired(app, email).then(() => toast(L('اتعيّن ومبروك 🎉', 'Hired — congratulations 🎉'))).catch(toastErr); } });
  }

  unsubs.push(watchApp(id, (d) => { app = d ? { ...d, id } : null; if (app && !job) getJob(app.jobId).then(j => { job = j ? { ...j, id: app.jobId } : null; draw(); }); if (app && app.seen === false) markSeen(app); if (app && !others.length && app.phoneKey) otherApps(app).then(o => { others = o; if (o.length) draw(); }).catch(() => {}); draw(); }));
  unsubs.push(watchInterviewsOf(id, (r) => { ivs = r; if (app) draw(); }));
  unsubs.push(watchTasksOf(id, (r) => { tasks = r; if (app) draw(); }));
  unsubs.push(watchLog(id, (r) => { log = r; if (app && tab === 'log') draw(); }));
  return () => unsubs.forEach(f => { try { f(); } catch {} });
}

// ---------------------------------------------------------------- the email composer
/** A ready email for the candidate: pick a template, fill the details, copy it or open it in Outlook, then mark it sent. */
export function composer({ app, job, settings = {}, kind = 'other', iv = null, task = null }) {
  let tpls = [], tpl = null, touched = false;
  const m = modal({ title: L('إيميل للمتقدم', 'Email to the applicant'), icon: 'fa-envelope', size: 'wide',
    body: `<div class="rc-mail"><div class="col gap-12 rc-mail-form">
        <div class="field"><label>${L('القالب', 'Template')}</label><select class="select" id="mt"></select></div>
        <div class="form-grid" id="mv"></div></div>
      <div class="col gap-8 rc-mail-out">
        <div class="field"><label>${L('إلى', 'To')}</label><div class="row gap-8"><input class="input grow" dir="ltr" readonly id="mto" value="${esc(app.email || '')}" placeholder="${L('مفيش إيميل للمتقدم', 'No email for this applicant')}"><button class="btn btn-sm" data-cp="to"><i class="fas fa-copy"></i></button></div></div>
        <div class="field"><label>${L('الموضوع', 'Subject')}</label><div class="row gap-8"><input class="input grow" id="ms"><button class="btn btn-sm" data-cp="subject"><i class="fas fa-copy"></i></button></div></div>
        <div class="field"><label>${L('الرسالة', 'Message')} <span class="xs muted">${L('(تقدر تعدّل فيها)', '(you can edit it)')}</span></label><textarea class="textarea" id="mb" rows="14"></textarea></div></div></div>`,
    foot: `<button class="btn" data-cp="body"><i class="fas fa-copy"></i> ${L('نسخ الرسالة', 'Copy message')}</button>
      <a class="btn" id="mol"><i class="fas fa-envelope-open"></i> ${L('افتح في Outlook', 'Open in Outlook')}</a>
      <span class="grow"></span><button class="btn" data-close>${L('قفل', 'Close')}</button><button class="btn btn-ok" id="msent"><i class="fas fa-check"></i> ${L('اتبعت — سجّله', 'Sent — log it')}</button>` });
  const lang = () => (tpl && tpl.lang === 'en' ? 'en' : 'ar');
  const ctx = () => {
    const lg = lang(), at = iv && iv.at;
    const place = iv ? (iv.mode === 'online' ? (lg === 'en' ? 'Online — join from the link below' : 'أونلاين — ادخل من اللينك اللي تحت') : iv.mode === 'phone' ? (lg === 'en' ? 'A phone call on your number' : 'مكالمة تليفون على رقمك') : (iv.location || settings.officeAddress || '')) : (settings.officeAddress || '');
    const link = iv && iv.mode === 'online' && iv.linkId ? interviewLink(iv.linkId) : task && task.id ? taskLink(task.id) : '';
    const deadline = task ? (task.dueMs ? `${dayName(task.dueMs, lg)} ${dateTxt(task.dueMs, lg)} ${timeTxt(task.dueMs, lg)}` : (lg === 'en' ? `within ${task.hours} hours of opening the link` : `خلال ${task.hours} ساعة من أول ما تفتح اللينك`)) : '';
    const o = app.offer || {};
    return {
      name: String(app.name || '').split(' ')[0], job: (job && job.title) || app.jobTitle || '', company: settings.company || 'AL MASTER TECHNOLOGY', sender: settings.sender || nameOf(session.email),
      day: at ? dayName(at, lg) : '', date: at ? dateTxt(at, lg) : '', time: at ? timeTxt(at, lg) : '', duration: iv ? (lg === 'en' ? `${iv.minutes} minutes` : `${iv.minutes} دقيقة`) : '',
      place, link, deadline, salary: o.salary ? num(o.salary) : '', start: o.start ? dateTxt(new Date(o.start + 'T09:00:00Z').getTime(), lg) : '', notes: (iv && iv.notes) || ''
    };
  };
  const FIELDS = [['day', 'اليوم', 'Day'], ['date', 'التاريخ', 'Date'], ['time', 'الساعة', 'Time'], ['duration', 'المدة', 'Duration'], ['place', 'المكان', 'Place'], ['link', 'اللينك', 'Link'], ['deadline', 'آخر معاد', 'Deadline'], ['salary', 'الراتب', 'Salary'], ['start', 'تاريخ البداية', 'Start date'], ['notes', 'ملاحظات', 'Notes']];
  const used = (t) => FIELDS.filter(([k]) => { const [a, e] = [`{${(PHK[k] || [])[0]}}`, `{${(PHK[k] || [])[1]}}`]; return `${t.subject} ${t.body}`.includes(a) || `${t.subject} ${t.body}`.includes(e); });
  const drawVars = () => {
    const c = ctx();
    m.$('#mv').innerHTML = (tpl ? used(tpl) : []).map(([k, a, e]) => `<div class="field ${k === 'notes' || k === 'place' || k === 'link' ? 'span-2' : ''}"><label>${esc(L(a, e))}</label>${k === 'notes' ? `<textarea class="textarea" rows="2" data-v="${k}">${esc(c[k])}</textarea>` : `<input class="input" data-v="${k}" value="${esc(c[k])}">`}</div>`).join('')
      || `<p class="xs muted span-2">${L('القالب ده مش محتاج تفاصيل زيادة.', 'This template needs no extra details.')}</p>`;
  };
  const vals = () => { const c = ctx(); m.$$('[data-v]').forEach(x => { c[x.dataset.v] = x.value; }); return c; };
  const fill = () => { if (!tpl) return; const v = vals(); m.$('#ms').value = fillTemplate(tpl.subject, v); if (!touched) m.$('#mb').value = fillTemplate(tpl.body, v); outlook(); };
  const outlook = () => { m.$('#mol').href = `mailto:${encodeURIComponent(app.email || '')}?subject=${encodeURIComponent(m.$('#ms').value)}&body=${encodeURIComponent(m.$('#mb').value)}`; };
  m.$('#mv').addEventListener('input', fill);
  m.$('#mb').oninput = () => { touched = true; outlook(); };
  m.$('#ms').oninput = outlook;
  m.$('#mt').onchange = () => { tpl = tpls.find(t => t.id === m.$('#mt').value) || null; touched = false; drawVars(); fill(); };
  m.el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-cp]'); if (!b) return;
    const v = b.dataset.cp === 'to' ? m.$('#mto').value : b.dataset.cp === 'subject' ? m.$('#ms').value : m.$('#mb').value;
    try { await navigator.clipboard.writeText(v); toast(L('اتنسخ', 'Copied'), '', 'info'); } catch { }
  });
  m.$('#msent').onclick = (e) => busy(e.currentTarget, async () => { try { await logEmail(app, m.$('#ms').value, m.$('#mb').value); m.close(); toast(L('اتسجّل في سجل المتقدم', 'Logged on the applicant')); } catch (ex) { toastErr(ex); } });
  const off = watchTemplates(r => {
    const first = !tpls.length; tpls = r;
    const order = [...tpls].sort((a, b) => ((b.kind === kind) - (a.kind === kind)) || ((a.lang === (isAr ? 'ar' : 'en')) ? -1 : 1));
    m.$('#mt').innerHTML = TEMPLATE_KINDS.map(([k, a, e]) => { const g = order.filter(t => (t.kind || 'other') === k); return g.length ? `<optgroup label="${esc(L(a, e))}">${g.map(t => `<option value="${esc(t.id)}">${esc(t.name)}${t.lang === 'en' ? ' (EN)' : ''}</option>`).join('')}</optgroup>` : ''; }).join('');
    if (first) { tpl = order.find(t => t.kind === kind && (t.lang || 'ar') === (app.lang === 'en' ? 'en' : 'ar')) || order.find(t => t.kind === kind) || order[0]; if (tpl) m.$('#mt').value = tpl.id; drawVars(); fill(); }
  });
  const close0 = m.close; m.close = () => { off(); close0(); };
}
const PHK = { day: ['اليوم', 'Day'], date: ['التاريخ', 'Date'], time: ['الساعة', 'Time'], duration: ['المدة', 'Duration'], place: ['المكان', 'Place'], link: ['اللينك', 'Link'], deadline: ['آخر_معاد', 'Deadline'], salary: ['الراتب', 'Salary'], start: ['تاريخ_البداية', 'Start_date'], notes: ['ملاحظات', 'Notes'] };
