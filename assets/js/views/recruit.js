// Recruitment (HR & admin): #/recruit/<tab> · #/recruit/job/<id> (the job's board) · #/recruit/app/<id> (one applicant)
import { L, esc, isAr, debounce, num } from '../core/utils.js';
import { modal, toast, toastErr, busy, empty, loader, confirmDialog } from '../core/ui.js';
import { session, now } from '../core/session.js';
import { departments, nameOf } from '../services/directory.js';
import {
  STAGES, stageLabel, STATUS_LABEL, SOURCES, sourceOf, LEVELS, JOB_TYPES, JOB_STATUS, ROUNDS, MODES, Q_TYPES, BUILTIN, DEFAULT_FIELDS, DEFAULT_CRITERIA,
  RECS, REJECT_REASONS, TEMPLATE_KINDS, PH, pick, critLabel, fails, applyLink, newId,
  watchJobs, saveJob, setJobStatus, deleteJob, getJob, watchApps, watchAllApps, readError, acceptDraft, addApplicant, moveStage, uploadFile, computeScore,
  watchUpcoming, watchBank, saveBankTask, deleteBankTask, watchRecentTasks, watchTemplates, saveTemplate, deleteTemplate, resetTemplate,
  getRecruitSettings, saveRecruitSettings
} from '../services/recruit.js';
import { list, query, col, where } from '../core/fb.js';

const TABS = [
  ['jobs', 'fa-briefcase', 'الوظايف', 'Jobs'], ['people', 'fa-users', 'المتقدمين', 'Applicants'], ['interviews', 'fa-calendar-check', 'الإنترفيوهات', 'Interviews'],
  ['tasks', 'fa-laptop-code', 'التاسكات', 'Tasks'], ['templates', 'fa-envelope-open-text', 'قوالب الإيميل', 'Email templates'], ['settings', 'fa-sliders', 'الإعدادات', 'Settings']
];
const errBox = (e) => e ? `<div class="alert bad mb-16" role="alert"><i class="fas fa-triangle-exclamation"></i><div>${esc(readError(e))}</div></div>` : '';
export const fmtWhen = (ms, opts = {}) => ms ? new Date(ms).toLocaleString(isAr ? 'ar-EG-u-nu-latn' : 'en-GB', { timeZone: 'Africa/Cairo', day: 'numeric', month: 'short', ...opts }) : '';
export const scoreBadge = (s) => s == null || s === '' ? '' : `<span class="badge ${s >= 75 ? 'ok' : s >= 50 ? 'warn' : 'bad'}" title="${L('التقييم الكلي', 'Overall score')}"><i class="fas fa-star"></i> ${num(s)}</span>`;
export const srcIcon = (id) => { const s = sourceOf(id); return `<i class="${s[2]}" title="${esc(s[1])}"></i>`; };

export default async function render(root, { params = [] } = {}) {
  const p0 = params[0] || 'jobs';
  if (p0 === 'job' && params[1]) return renderBoard(root, params[1]);
  if (p0 === 'app' && params[1]) { const m = await import('./recruit-app.js'); return m.renderApp(root, params[1]); }
  return renderHome(root, TABS.some(t => t[0] === p0) ? p0 : 'jobs');
}

// ---------------------------------------------------------------- home: tabs
function renderHome(root, tab) {
  const unsubs = [];
  root.innerHTML = `<div class="rc-page">
    <div class="rc-tabs seg">${TABS.map(t => `<a href="#/recruit/${t[0]}" class="${t[0] === tab ? 'on' : ''}"><i class="fas ${t[1]}"></i><span class="hide-sm">${L(t[2], t[3])}</span></a>`).join('')}</div>
    <div id="rc-body" class="mt-16">${loader()}</div></div>`;
  const body = root.querySelector('#rc-body');
  const fn = { jobs: tabJobs, people: tabPeople, interviews: tabInterviews, tasks: tabTasks, templates: tabTemplates, settings: tabSettings }[tab];
  const off = fn(body);
  if (off) unsubs.push(off);
  return () => unsubs.forEach(f => { try { f(); } catch {} });
}

function tabJobs(el) {
  let jobs = [], apps = [], unfinished = [], filter = 'live', err = null;
  const draw = () => {
    const shown = jobs.filter(j => filter === 'all' || (filter === 'live' ? j.status !== 'closed' : j.status === 'closed'));
    const byJob = (id) => apps.filter(a => a.jobId === id);
    el.innerHTML = `${errBox(err)}<div class="tk-head mb-16"><div class="seg" id="jf">${[['live', L('الشغالة', 'Active')], ['closed', L('اتقفلت', 'Closed')], ['all', L('الكل', 'All')]].map(([v, t]) => `<button data-f="${v}" class="${filter === v ? 'on' : ''}">${t}</button>`).join('')}</div>
      <button class="btn btn-primary" id="jnew"><i class="fas fa-plus"></i> ${L('وظيفة جديدة', 'New job')}</button></div>
      ${shown.length ? `<div class="rc-jobs">${shown.map(j => {
        const a = byJob(j.id), act = a.filter(x => x.status === 'active'), fresh = a.filter(x => x.seen === false && x.status === 'active').length, hired = a.filter(x => x.status === 'hired').length, half = unfinished.filter(x => x.jobId === j.id).length;
        return `<article class="card rc-job"><div class="card-body col gap-8">
          <div class="row between gap-8"><span class="badge ${j.status === 'open' ? 'ok' : j.status === 'paused' ? 'warn' : ''}">${esc((JOB_STATUS[j.status] || JOB_STATUS.draft)())}</span><span class="row gap-4">${half ? `<span class="badge warn" title="${L('تقديمات ما اكتملتش', 'Unfinished applications')}"><i class="fas fa-hourglass-half"></i> ${num(half)}</span>` : ''}${fresh ? `<span class="badge info"><i class="fas fa-circle"></i> ${num(fresh)} ${L('جديد', 'new')}</span>` : ''}</span></div>
          <a href="#/recruit/job/${esc(j.id)}" class="rc-job-title">${esc(j.title)}</a>
          <div class="xs muted">${esc([j.department, pick(JOB_TYPES, j.type), pick(LEVELS, j.level)].filter(Boolean).join(' · '))}</div>
          <div class="rc-mini">${STAGES.slice(0, 3).map(s => { const n = act.filter(x => x.stage === s.id).length; return `<span title="${esc(L(s.ar, s.en))}" class="${n ? 'on' : ''}"><i class="fas ${s.icon}"></i>${n ? num(n) : ''}</span>`; }).join('')}</div>
          <div class="row between xs muted"><span>${L(`${num(a.length)} متقدم`, `${num(a.length)} applicants`)}</span><span>${L(`اتعيّن ${num(hired)} من ${num(j.openings || 1)}`, `Hired ${num(hired)} of ${num(j.openings || 1)}`)}</span></div>
          <div class="row gap-8 wrap mt-4"><a class="btn btn-sm btn-primary" href="#/recruit/job/${esc(j.id)}"><i class="fas fa-table-columns"></i> ${L('المتقدمين', 'Applicants')}</a>
            <button class="btn btn-sm" data-links="${esc(j.id)}"><i class="fas fa-link"></i> ${L('لينكات التقديم', 'Apply links')}</button>
            <button class="btn btn-sm btn-ghost" data-edit="${esc(j.id)}"><i class="fas fa-pen"></i> ${L('تعديل', 'Edit')}</button></div>
        </div></article>`;
      }).join('')}</div>` : empty('fa-briefcase', filter === 'closed' ? L('مفيش وظايف مقفولة', 'No closed jobs') : L('لسه مفيش وظايف', 'No jobs yet'), L('اعمل وظيفة، حدد أسئلتها، وخد لينك التقديم تحطه في إعلان لينكد إن.', 'Create a job, set its questions, and put its apply link in your LinkedIn post.'))}`;
  };
  el.onclick = (e) => {
    const f = e.target.closest('[data-f]'); if (f) { filter = f.dataset.f; draw(); return; }
    if (e.target.closest('#jnew')) { jobEditor(null); return; }
    const ed = e.target.closest('[data-edit]'); if (ed) { jobEditor(jobs.find(j => j.id === ed.dataset.edit)); return; }
    const ln = e.target.closest('[data-links]'); if (ln) linksModal(jobs.find(j => j.id === ln.dataset.links));
  };
  const u1 = watchJobs(r => { jobs = r; draw(); });
  const u2 = watchAllApps((r, d) => { apps = r; unfinished = d || []; err = null; draw(); }, (e) => { err = e; draw(); });
  return () => { u1(); u2(); };
}

function tabPeople(el) {
  let apps = [], jobs = [], q = '', fJob = '', fStage = '', fStatus = 'active', err = null;
  el.innerHTML = `<div class="tk-filters"><div class="search"><i class="fas fa-search"></i><input class="input" id="pq" placeholder="${L('ابحث بالاسم أو الموبايل أو الإيميل', 'Search name, phone or email')}"></div>
    <select class="select" id="pj"><option value="">${L('كل الوظايف', 'All jobs')}</option></select>
    <select class="select" id="ps"><option value="">${L('كل المراحل', 'All stages')}</option>${STAGES.map(s => `<option value="${s.id}">${esc(L(s.ar, s.en))}</option>`).join('')}</select>
    <select class="select" id="pst">${[['active', L('شغالين', 'Active')], ['', L('الكل', 'All')], ['rejected', L('مرفوضين', 'Rejected')], ['withdrawn', L('انسحبوا', 'Withdrew')], ['hired', L('اتعيّنوا', 'Hired')]].map(([v, t]) => `<option value="${v}" ${v === fStatus ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
    <div class="card"><div class="table-wrap" id="pt">${loader()}</div></div>`;
  const draw = () => {
    const s = q.toLowerCase();
    const rows = apps.filter(a => (!fJob || a.jobId === fJob) && (!fStage || a.stage === fStage) && (!fStatus || a.status === fStatus) && (!s || `${a.name} ${a.phone} ${a.email} ${a.currentTitle}`.toLowerCase().includes(s)));
    el.querySelector('#pt').innerHTML = err ? `<div class="card-body">${errBox(err)}</div>` : rows.length ? `<table class="table"><thead><tr><th>${L('الاسم', 'Name')}</th><th>${L('الوظيفة', 'Job')}</th><th>${L('المرحلة', 'Stage')}</th><th>${L('التقييم', 'Score')}</th><th>${L('المصدر', 'Source')}</th><th>${L('قدّم', 'Applied')}</th></tr></thead><tbody>
      ${rows.map(a => `<tr class="rc-row" data-open="${esc(a.id)}"><td><div class="person"><span><b>${a.seen === false ? '<span class="rc-dot"></span>' : ''}${esc(a.name)}</b><span>${esc(a.currentTitle || a.phone || '')}</span></span></div></td>
        <td>${esc(a.jobTitle || '')}</td><td>${a.status === 'active' ? esc(stageLabel(a.stage)) : `<span class="badge ${a.status === 'hired' ? 'ok' : 'bad'}">${esc((STATUS_LABEL[a.status] || STATUS_LABEL.active)())}</span>`}</td>
        <td>${scoreBadge(a.score)}</td><td>${srcIcon(a.source)}</td><td class="xs muted nowrap">${esc(fmtWhen(a.createdMs))}</td></tr>`).join('')}</tbody></table>`
      : empty('fa-users', L('مفيش متقدمين', 'No applicants'), '');
  };
  el.querySelector('#pq').oninput = debounce((e) => { q = e.target.value.trim(); draw(); }, 150);
  el.querySelector('#pj').onchange = (e) => { fJob = e.target.value; draw(); };
  el.querySelector('#ps').onchange = (e) => { fStage = e.target.value; draw(); };
  el.querySelector('#pst').onchange = (e) => { fStatus = e.target.value; draw(); };
  el.querySelector('#pt').onclick = (e) => { const r = e.target.closest('[data-open]'); if (r) location.hash = `#/recruit/app/${r.dataset.open}`; };
  const u1 = watchAllApps(r => { apps = r; err = null; draw(); }, (e) => { err = e; draw(); });
  const u2 = watchJobs(r => { jobs = r; const sel = el.querySelector('#pj'); sel.innerHTML = `<option value="">${L('كل الوظايف', 'All jobs')}</option>` + jobs.map(j => `<option value="${esc(j.id)}" ${j.id === fJob ? 'selected' : ''}>${esc(j.title)}</option>`).join(''); });
  return () => { u1(); u2(); };
}

function tabInterviews(el) {
  let past = false, off = null;
  const dayStart = () => { const d = new Date(now()); return now() - ((d.getUTCHours() + 3) % 24) * 3600000 - d.getUTCMinutes() * 60000; };
  const sub = () => {
    if (off) off();
    el.innerHTML = `<div class="tk-head mb-16"><div class="seg" id="ivf"><button data-p="0" class="${past ? '' : 'on'}">${L('الجاية', 'Upcoming')}</button><button data-p="1" class="${past ? 'on' : ''}">${L('آخر أسبوعين كمان', 'Incl. last 2 weeks')}</button></div></div><div id="ivl">${loader()}</div>`;
    off = watchUpcoming(past ? dayStart() - 14 * 86400000 : dayStart(), (rows) => {
      const days = new Map();
      rows.forEach(r => { const k = new Date(r.at).toLocaleDateString(isAr ? 'ar-EG-u-nu-latn' : 'en-GB', { timeZone: 'Africa/Cairo', weekday: 'long', day: 'numeric', month: 'long' }); if (!days.has(k)) days.set(k, []); days.get(k).push(r); });
      el.querySelector('#ivl').innerHTML = rows.length ? [...days].map(([d, list]) => `<section class="card mb-16"><div class="card-head"><h3><i class="fas fa-calendar-day"></i> ${esc(d)}</h3><span class="badge">${num(list.length)}</span></div><div class="card-body col gap-8">
        ${list.map(r => `<a class="rc-iv ${r.status}" href="#/recruit/app/${esc(r.appId)}"><b class="num">${esc(new Date(r.at).toLocaleTimeString(isAr ? 'ar-EG-u-nu-latn' : 'en-GB', { timeZone: 'Africa/Cairo', hour: 'numeric', minute: '2-digit' }))}</b>
          <span class="grow min0"><b class="truncate">${esc(r.name)}</b><small class="truncate">${esc(pick(ROUNDS, r.round))} · ${esc(r.jobTitle || '')}${(r.interviewers || []).length ? ' · ' + esc(r.interviewers.map(e => String(nameOf(e)).split(' ')[0]).join('، ')) : ''}</small></span>
          <span class="badge">${r.mode === 'online' ? '<i class="fas fa-video"></i>' : r.mode === 'phone' ? '<i class="fas fa-phone"></i>' : '<i class="fas fa-building"></i>'} ${esc(pick(MODES, r.mode))}</span>
          ${r.status !== 'scheduled' ? `<span class="badge ${r.status === 'done' ? 'ok' : 'bad'}">${esc(ivStatus(r.status))}</span>` : ''}</a>`).join('')}</div></section>`).join('')
        : empty('fa-calendar-check', L('مفيش إنترفيوهات جاية', 'No upcoming interviews'), L('بتحجز الإنترفيو من صفحة المتقدم.', 'Book interviews from an applicant\'s page.'));
    });
  };
  el.onclick = (e) => { const b = e.target.closest('[data-p]'); if (b) { past = b.dataset.p === '1'; sub(); } };
  sub();
  return () => off && off();
}
export const ivStatus = (s) => ({ scheduled: L('محجوز', 'Scheduled'), done: L('اتعمل', 'Done'), noshow: L('ما حضرش', 'No show'), cancelled: L('اتلغى', 'Cancelled') }[s] || s);

function tabTasks(el) {
  let bank = [], sent = [];
  const tStatus = (t) => {
    if (t.status === 'graded') return [L('اتصحّح', 'Graded') + (t.score != null ? ` · ${t.score}` : ''), 'ok'];
    if (t.status === 'submitted') return [L('اتسلّم', 'Handed in'), 'info'];
    if (t.status === 'opened') return now() > (t.deadlineMs || 0) + 600000 ? [L('الوقت خلص', 'Expired'), 'bad'] : [L('بيشتغل عليه', 'Working'), 'warn'];
    return [L('اتبعت', 'Sent'), ''];
  };
  const draw = () => {
    el.innerHTML = `<div class="grid g-2 gap-16 rc-two">
      <section class="card"><div class="card-head"><h3><i class="fas fa-box-archive"></i> ${L('بنك التاسكات', 'Task bank')}</h3><button class="btn btn-sm btn-primary" id="bnew"><i class="fas fa-plus"></i> ${L('تاسك جديد', 'New task')}</button></div>
        <div class="card-body col gap-8">${bank.length ? bank.map(t => `<div class="rec-row"><span class="icon-tile"><i class="fas fa-laptop-code"></i></span><div class="grow min0"><b class="truncate">${esc(t.title)}</b><div class="xs muted truncate">${t.hours ? L(`${t.hours} ساعة من الفتح`, `${t.hours}h from opening`) : ''}${(t.files || []).length ? ` · ${num(t.files.length)} ${L('ملف', 'file(s)')}` : ''}</div></div>
          <button class="btn btn-sm btn-ghost" data-bedit="${esc(t.id)}"><i class="fas fa-pen"></i></button><button class="btn btn-sm btn-ghost" data-bdel="${esc(t.id)}" style="color:var(--bad)"><i class="fas fa-trash"></i></button></div>`).join('')
          : `<p class="muted small">${L('احفظ هنا التاسكات اللي بتبعتها كتير، وابعتها بضغطة من صفحة المتقدم.', 'Keep tasks you send often here, and send them in one click from an applicant\'s page.')}</p>`}</div></section>
      <section class="card"><div class="card-head"><h3><i class="fas fa-paper-plane"></i> ${L('آخر التاسكات اللي اتبعتت', 'Recently sent')}</h3></div>
        <div class="card-body col gap-8">${sent.length ? sent.map(t => { const [s, c] = tStatus(t); return `<a class="rec-row" href="#/recruit/app/${esc(t.appId)}"><div class="grow min0"><b class="truncate">${esc(t.name)}</b><div class="xs muted truncate">${esc(t.title)} · ${esc(t.jobTitle || '')}</div></div><span class="badge ${c}">${esc(s)}</span></a>`; }).join('')
          : `<p class="muted small">${L('لسه ما اتبعتش تاسكات.', 'No tasks sent yet.')}</p>`}</div></section></div>`;
  };
  el.onclick = async (e) => {
    if (e.target.closest('#bnew')) { bankEditor(null); return; }
    const ed = e.target.closest('[data-bedit]'); if (ed) { bankEditor(bank.find(t => t.id === ed.dataset.bedit)); return; }
    const dl = e.target.closest('[data-bdel]');
    if (dl) { const t = bank.find(x => x.id === dl.dataset.bdel); if (t && await confirmDialog({ title: L('مسح التاسك', 'Delete task'), message: t.title, okText: L('مسح', 'Delete'), okClass: 'btn-danger' })) deleteBankTask(t).catch(toastErr); }
  };
  const u1 = watchBank(r => { bank = r; draw(); });
  const u2 = watchRecentTasks(r => { sent = r; draw(); });
  return () => { u1(); u2(); };
}

/** a reusable task: title, the brief, files and the default time */
export function bankEditor(t, onSaved) {
  const files = [...((t && t.files) || [])];
  const m = modal({
    title: t ? L('تعديل التاسك', 'Edit task') : L('تاسك جديد', 'New task'), icon: 'fa-laptop-code', size: 'wide',
    body: `<div class="col gap-12"><div class="field"><label>${L('عنوان التاسك', 'Title')} *</label><input class="input" id="bt" maxlength="160" value="${esc((t && t.title) || '')}"></div>
      <div class="field"><label>${L('المطلوب بالتفصيل', 'The brief')}</label><textarea class="textarea" id="bb" rows="9" maxlength="8000">${esc((t && t.body) || '')}</textarea></div>
      <div class="field" style="max-width:260px"><label>${L('المدة بالساعات من أول ما يفتحه', 'Hours from opening')}</label><input class="input num" type="number" min="1" max="720" id="bh" value="${esc((t && t.hours) || 48)}"></div>
      <div class="field"><label>${L('ملفات مع التاسك', 'Files with the task')}</label><div class="col gap-8" id="bfl"></div><label class="dropzone mt-8"><input type="file" hidden id="bf"><i class="fas fa-paperclip"></i> ${L('أضف ملف (لحد 5 ميجا)', 'Add a file (up to 5 MB)')}</label></div></div>`,
    foot: `<button class="btn" data-close>${L('إلغاء', 'Cancel')}</button><button class="btn btn-primary" id="bs"><i class="fas fa-floppy-disk"></i> ${L('حفظ', 'Save')}</button>`
  });
  const drawFiles = () => { m.$('#bfl').innerHTML = files.map((f, i) => `<div class="pub-file"><i class="fas fa-file"></i><span class="grow truncate">${esc(f.name)}</span><button class="btn btn-sm btn-ghost" data-x="${i}"><i class="fas fa-xmark"></i></button></div>`).join(''); };
  m.$('#bfl').onclick = (e) => { const b = e.target.closest('[data-x]'); if (b) { files.splice(Number(b.dataset.x), 1); drawFiles(); } };
  m.$('#bf').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; const lab = e.target.parentElement; lab.classList.add('busy'); try { files.push(await uploadFile('bank', (t && t.id) || 'bank', f)); drawFiles(); } catch (ex) { toastErr(ex); } lab.classList.remove('busy'); e.target.value = ''; };
  m.$('#bs').onclick = (e) => busy(e.currentTarget, async () => {
    try { const id = await saveBankTask({ id: t && t.id, title: m.$('#bt').value, body: m.$('#bb').value, hours: m.$('#bh').value, files }); m.close(); toast(L('اتحفظ', 'Saved')); onSaved && onSaved(id); } catch (ex) { toastErr(ex); }
  });
  drawFiles();
}

function tabTemplates(el) {
  let rows = [];
  const draw = () => {
    el.innerHTML = `<div class="tk-head mb-16"><p class="muted small">${L('القوالب دي بتتملي لوحدها ببيانات المتقدم والمعاد، وإنت بتنسخها أو تفتحها في Outlook وتبعتها من إيميل الشركة.', 'These fill in by themselves with the applicant and the appointment; you copy them or open them in Outlook and send from the company address.')}</p>
      <button class="btn btn-primary" id="tnew"><i class="fas fa-plus"></i> ${L('قالب جديد', 'New template')}</button></div>
      <div class="card"><div class="card-body col gap-8">${TEMPLATE_KINDS.map(([k, a, e]) => { const list = rows.filter(t => (t.kind || 'other') === k); if (!list.length) return ''; return `<div class="xs muted bold mt-8">${esc(L(a, e))}</div>${list.map(t => `<div class="rec-row"><span class="icon-tile"><i class="fas fa-envelope"></i></span><div class="grow min0"><b class="truncate">${esc(t.name)}</b><div class="xs muted truncate">${esc(t.subject || '')}</div></div><span class="badge">${t.lang === 'en' ? 'EN' : 'ع'}</span>
        <button class="btn btn-sm btn-ghost" data-tedit="${esc(t.id)}"><i class="fas fa-pen"></i> ${L('تعديل', 'Edit')}</button></div>`).join('')}`; }).join('')}</div></div>`;
  };
  el.onclick = (e) => {
    if (e.target.closest('#tnew')) { templateEditor(null); return; }
    const b = e.target.closest('[data-tedit]'); if (b) templateEditor(rows.find(t => t.id === b.dataset.tedit));
  };
  return watchTemplates(r => { rows = r; draw(); });
}
function templateEditor(t) {
  const isAr2 = !t || t.lang !== 'en';
  const chips = Object.entries(PH).map(([k, [a, e]]) => `<button type="button" class="chip" data-ph="${esc(isAr2 ? a : e)}">{${esc(isAr2 ? a : e)}}</button>`).join('');
  const m = modal({
    title: t ? L('تعديل القالب', 'Edit template') : L('قالب جديد', 'New template'), icon: 'fa-envelope-open-text', size: 'wide',
    body: `<div class="col gap-12"><div class="form-grid"><div class="field"><label>${L('اسم القالب', 'Name')}</label><input class="input" id="tn" value="${esc((t && t.name) || '')}"></div>
      <div class="field"><label>${L('بيتبعت في', 'Used for')}</label><select class="select" id="tk">${TEMPLATE_KINDS.map(([k, a, e]) => `<option value="${k}" ${(t && t.kind) === k ? 'selected' : ''}>${esc(L(a, e))}</option>`).join('')}</select></div>
      <div class="field"><label>${L('اللغة', 'Language')}</label><select class="select" id="tl"><option value="ar" ${isAr2 ? 'selected' : ''}>عربي</option><option value="en" ${!isAr2 ? 'selected' : ''}>English</option></select></div></div>
      <div class="field"><label>${L('الموضوع', 'Subject')}</label><input class="input" id="ts" value="${esc((t && t.subject) || '')}"></div>
      <div class="field"><label>${L('الرسالة', 'Message')}</label><textarea class="textarea" id="tb" rows="12">${esc((t && t.body) || '')}</textarea></div>
      <div><div class="xs muted mb-8">${L('اضغط على أي خانة تتحط مكان المؤشر — بتتملي لوحدها وقت الإرسال:', 'Click a field to insert it — it fills in when sending:')}</div><div class="row gap-4 wrap" id="tph">${chips}</div></div></div>`,
    foot: `${t && t.builtin ? `<button class="btn btn-ghost" id="tr" style="margin-inline-end:auto">${L('رجّعه زي الأصل', 'Restore original')}</button>` : t ? `<button class="btn btn-ghost" id="td" style="margin-inline-end:auto;color:var(--bad)"><i class="fas fa-trash"></i> ${L('مسح', 'Delete')}</button>` : ''}<button class="btn" data-close>${L('إلغاء', 'Cancel')}</button><button class="btn btn-primary" id="tsv"><i class="fas fa-floppy-disk"></i> ${L('حفظ', 'Save')}</button>`
  });
  let last = m.$('#tb');
  m.$('#ts').onfocus = (e) => { last = e.target; }; m.$('#tb').onfocus = (e) => { last = e.target; };
  m.$('#tph').onclick = (e) => { const b = e.target.closest('[data-ph]'); if (!b) return; const ins = `{${b.dataset.ph}}`; const s = last.selectionStart ?? last.value.length; last.value = last.value.slice(0, s) + ins + last.value.slice(last.selectionEnd ?? s); last.focus(); last.selectionStart = last.selectionEnd = s + ins.length; };
  m.$('#tsv').onclick = (e) => busy(e.currentTarget, async () => { try { await saveTemplate({ id: t && t.id, name: m.$('#tn').value, kind: m.$('#tk').value, lang: m.$('#tl').value, subject: m.$('#ts').value, body: m.$('#tb').value }); m.close(); toast(L('اتحفظ', 'Saved')); } catch (ex) { toastErr(ex); } });
  const r = m.$('#tr'); if (r) r.onclick = () => busy(r, async () => { await resetTemplate(t).catch(toastErr); m.close(); });
  const d = m.$('#td'); if (d) d.onclick = () => busy(d, async () => { await deleteTemplate(t).catch(toastErr); m.close(); });
}

function tabSettings(el) {
  el.innerHTML = loader();
  getRecruitSettings().then(s => {
    el.innerHTML = `<div class="card" style="max-width:720px"><div class="card-body col gap-12">
      <div class="field"><label>${L('اسم الشركة في الإيميلات وصفحة التقديم', 'Company name in emails and the apply page')}</label><input class="input" id="sc" value="${esc(s.company || 'AL MASTER TECHNOLOGY')}"></div>
      <div class="field"><label>${L('الإمضاء في الإيميلات', 'Email signature name')}</label><input class="input" id="ss" value="${esc(s.sender || L('فريق الموارد البشرية', 'HR team'))}"></div>
      <div class="field"><label>${L('عنوان المكتب (للإنترفيوهات في المكتب)', 'Office address (for in-office interviews)')}</label><textarea class="textarea" id="sa" rows="2">${esc(s.officeAddress || '')}</textarea></div>
      <div class="field" style="max-width:260px"><label>${L('مدة الإنترفيو الافتراضية (دقيقة)', 'Default interview length (min)')}</label><input class="input num" type="number" min="10" max="240" id="sm" value="${esc(s.minutes || 45)}"></div>
      <div><button class="btn btn-primary" id="sv"><i class="fas fa-floppy-disk"></i> ${L('حفظ', 'Save')}</button></div></div></div>`;
    el.querySelector('#sv').onclick = (e) => busy(e.currentTarget, async () => { try { await saveRecruitSettings({ company: el.querySelector('#sc').value.trim(), sender: el.querySelector('#ss').value.trim(), officeAddress: el.querySelector('#sa').value.trim(), minutes: Number(el.querySelector('#sm').value) || 45 }); toast(L('اتحفظ', 'Saved')); } catch (ex) { toastErr(ex); } });
  });
}

// ---------------------------------------------------------------- job editor (details · questions · scoring)
export function jobEditor(job, onSaved) {
  const j = job ? structuredClone(job) : { status: 'open', fields: [...DEFAULT_FIELDS], questions: [], criteria: DEFAULT_CRITERIA.map(c => ({ ...c })), cvRequired: true, openings: 1 };
  j.questions = (j.questions || []).map(q => ({ ...q }));
  j.criteria = (j.criteria && j.criteria.length ? j.criteria : DEFAULT_CRITERIA).map(c => ({ ...c }));
  const sel = (list, v) => list.map(([k, a, e]) => `<option value="${k}" ${v === k ? 'selected' : ''}>${esc(L(a, e))}</option>`).join('');
  const m = modal({
    title: job ? L('تعديل الوظيفة', 'Edit job') : L('وظيفة جديدة', 'New job'), icon: 'fa-briefcase', size: 'wide',
    body: `<div class="tabs mb-16" id="jt"><button class="tab active" data-p="basic">${L('البيانات', 'Details')}</button><button class="tab" data-p="qs">${L('أسئلة التقديم', 'Application questions')}</button><button class="tab" data-p="crit">${L('معايير التقييم', 'Scoring')}</button></div>
      <div data-pane="basic" class="form-grid">
        <div class="field"><label>${L('اسم الوظيفة', 'Job title')} *</label><input class="input" id="j_title" maxlength="120" value="${esc(j.title || '')}"></div>
        <div class="field"><label>${L('القسم', 'Department')}</label><select class="select" id="j_dept"><option value="">—</option>${departments().map(d => `<option ${j.department === d ? 'selected' : ''}>${esc(d)}</option>`).join('')}</select></div>
        <div class="field"><label>${L('المستوى', 'Level')}</label><select class="select" id="j_level"><option value="">—</option>${sel(LEVELS, j.level)}</select></div>
        <div class="field"><label>${L('نوع الشغل', 'Type')}</label><select class="select" id="j_type"><option value="">—</option>${sel(JOB_TYPES, j.type)}</select></div>
        <div class="field"><label>${L('المكان', 'Location')}</label><input class="input" id="j_loc" maxlength="120" value="${esc(j.location || '')}" placeholder="${L('مثلاً: القاهرة — مدينة نصر', 'e.g. Cairo — Nasr City')}"></div>
        <div class="field"><label>${L('عدد الأماكن', 'Openings')}</label><input class="input num" type="number" min="1" max="100" id="j_open" value="${esc(j.openings || 1)}"></div>
        <div class="field"><label>${L('الراتب من (مخفي عن المتقدم)', 'Salary from (hidden)')}</label><input class="input num" type="number" min="0" id="j_smin" value="${esc(j.salaryMin || '')}"></div>
        <div class="field"><label>${L('الراتب لحد', 'Salary up to')}</label><input class="input num" type="number" min="0" id="j_smax" value="${esc(j.salaryMax || '')}"></div>
        <div class="field"><label>${L('أقل خبرة مقبولة (سنين)', 'Minimum years')}</label><input class="input num" type="number" min="0" max="40" id="j_miny" value="${esc(j.minYears || '')}"><div class="xs muted mt-4">${L('اللي أقل منها بيتعلّم عليه «مش مستوفي».', 'Applicants below it are flagged.')}</div></div>
        <div class="field"><label>${L('الحالة', 'Status')}</label><select class="select" id="j_status">${Object.keys(JOB_STATUS).map(k => `<option value="${k}" ${j.status === k ? 'selected' : ''}>${esc(JOB_STATUS[k]())}</option>`).join('')}</select><div class="xs muted mt-4">${L('لينك التقديم شغال وهي «مفتوحة» بس.', 'The apply link works only while it is "Open".')}</div></div>
        <div class="field span-2"><label>${L('وصف الوظيفة', 'Description')}</label><textarea class="textarea" id="j_desc" rows="5" maxlength="6000">${esc(j.description || '')}</textarea></div>
        <div class="field"><label>${L('المطلوب (سطر لكل نقطة)', 'Requirements (one per line)')}</label><textarea class="textarea" id="j_must" rows="5">${esc(j.must || '')}</textarea></div>
        <div class="field"><label>${L('ميزة إضافية (سطر لكل نقطة)', 'Nice to have (one per line)')}</label><textarea class="textarea" id="j_nice" rows="5">${esc(j.nice || '')}</textarea></div>
      </div>
      <div data-pane="qs" class="col gap-12 hidden">
        <div class="alert info"><i class="fas fa-circle-info"></i><div>${L('الاسم والموبايل والإيميل بيتسألوا دايماً. اختار البيانات التانية اللي عايزها، وأضف أسئلتك.', 'Name, mobile and email are always asked. Pick the other details you want and add your own questions.')}</div></div>
        <div class="row gap-8 wrap" id="jfl">${BUILTIN.map(([k, a, e]) => `<label class="chip chip-check"><input type="checkbox" data-bi="${k}" ${(j.fields || []).includes(k) ? 'checked' : ''}> ${esc(L(a, e))}</label>`).join('')}
          <label class="chip chip-check"><input type="checkbox" id="j_cv" ${j.cvRequired !== false ? 'checked' : ''}> ${L('الـ CV إجباري', 'CV required')}</label></div>
        <div id="jq" class="col gap-8"></div>
        <div class="row gap-8 wrap"><select class="select" id="jqt" style="max-width:220px">${Q_TYPES.map(([k, a, e]) => `<option value="${k}">${esc(L(a, e))}</option>`).join('')}</select><button class="btn btn-soft" id="jqa"><i class="fas fa-plus"></i> ${L('أضف سؤال', 'Add question')}</button>
          ${job ? `<a class="btn btn-ghost" target="_blank" rel="noopener" href="${esc(applyLink(job.id, 'preview'))}"><i class="fas fa-eye"></i> ${L('معاينة صفحة التقديم', 'Preview the apply page')}</a>` : ''}</div>
      </div>
      <div data-pane="crit" class="col gap-12 hidden">
        <p class="small muted">${L('دي الحاجات اللي بتقيّم عليها في كل إنترفيو (من 1 لـ 5). الوزن = أهميتها في التقييم الكلي.', 'What you score in every interview (1–5). The weight is its share of the overall score.')}</p>
        <div id="jc" class="col gap-8"></div><div><button class="btn btn-soft" id="jca"><i class="fas fa-plus"></i> ${L('أضف معيار', 'Add criterion')}</button></div>
      </div><div id="je" class="alert bad hidden mt-8"></div>`,
    foot: `${job ? `<button class="btn btn-ghost" id="jdel" style="margin-inline-end:auto;color:var(--bad)"><i class="fas fa-trash"></i> ${L('مسح', 'Delete')}</button>` : ''}<button class="btn" data-close>${L('إلغاء', 'Cancel')}</button><button class="btn btn-primary" id="jsave"><i class="fas fa-floppy-disk"></i> ${L('حفظ', 'Save')}</button>`
  });
  m.$('#jt').onclick = (e) => { const b = e.target.closest('.tab'); if (!b) return; m.$$('#jt .tab').forEach(x => x.classList.toggle('active', x === b)); m.$$('[data-pane]').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== b.dataset.p)); };
  const readQs = () => { m.$$('[data-qi]').forEach(row => { const q = j.questions[Number(row.dataset.qi)]; if (!q) return;
    q.label = row.querySelector('[data-k=label]').value; q.required = row.querySelector('[data-k=req]').checked;
    const h = row.querySelector('[data-k=help]'); q.help = h ? h.value : '';
    const o = row.querySelector('[data-k=opts]'); if (o) q.options = o.value.split('\n').map(x => x.trim()).filter(Boolean).slice(0, 30);
    const r = row.querySelector('[data-k=rule]'); if (r) { const v = r.value; q.rule = q.type === 'yesno' ? (v ? { equals: v } : null) : q.type === 'number' ? (v !== '' ? { min: Number(v) } : null) : null; }
    const al = row.querySelector('[data-k=allowed]'); if (al) { const v = [...al.selectedOptions].map(x => x.value); q.rule = v.length ? { allowed: v } : null; }
  }); };
  const drawQs = () => {
    m.$('#jq').innerHTML = j.questions.map((q, i) => { const t = Q_TYPES.find(x => x[0] === q.type) || Q_TYPES[0];
      return `<div class="rc-q" data-qi="${i}"><div class="row gap-8"><span class="icon-tile"><i class="fas ${t[3]}"></i></span><input class="input grow" data-k="label" placeholder="${L('نص السؤال', 'Question')}" value="${esc(q.label || '')}">
        <label class="row gap-4 xs nowrap"><input type="checkbox" data-k="req" ${q.required ? 'checked' : ''}> ${L('إجباري', 'Required')}</label>
        <button class="btn btn-sm btn-ghost btn-icon" data-up="${i}" ${i ? '' : 'disabled'}><i class="fas fa-arrow-up"></i></button><button class="btn btn-sm btn-ghost btn-icon" data-down="${i}" ${i < j.questions.length - 1 ? '' : 'disabled'}><i class="fas fa-arrow-down"></i></button><button class="btn btn-sm btn-ghost btn-icon" data-rm="${i}" style="color:var(--bad)"><i class="fas fa-trash"></i></button></div>
        <div class="row gap-8 wrap mt-8 rc-q-more"><span class="xs muted">${esc(L(t[1], t[2]))}</span><input class="input input-sm grow" data-k="help" placeholder="${L('توضيح صغير تحت السؤال (اختياري)', 'Small hint under the question (optional)')}" value="${esc(q.help || '')}">
        ${q.type === 'yesno' ? `<label class="xs row gap-4">${L('لازم الإجابة', 'Must answer')}<select class="select select-sm" data-k="rule"><option value="">${L('أي حاجة', 'anything')}</option><option value="yes" ${q.rule && q.rule.equals === 'yes' ? 'selected' : ''}>${L('نعم', 'Yes')}</option><option value="no" ${q.rule && q.rule.equals === 'no' ? 'selected' : ''}>${L('لا', 'No')}</option></select></label>` : ''}
        ${q.type === 'number' ? `<label class="xs row gap-4">${L('أقل رقم مقبول', 'Minimum accepted')}<input class="input input-sm num" style="width:90px" type="number" data-k="rule" value="${esc(q.rule && q.rule.min != null ? q.rule.min : '')}"></label>` : ''}</div>
        ${q.type === 'choice' || q.type === 'multi' ? `<div class="row gap-8 mt-8 wrap"><textarea class="textarea grow" rows="3" data-k="opts" placeholder="${L('الاختيارات — سطر لكل اختيار', 'Options — one per line')}">${esc((q.options || []).join('\n'))}</textarea>
          ${q.type === 'choice' && (q.options || []).length ? `<label class="xs col gap-4">${L('الاختيارات المقبولة (اختياري)', 'Accepted options (optional)')}<select class="select" multiple size="3" data-k="allowed">${q.options.map(o => `<option ${q.rule && (q.rule.allowed || []).includes(o) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>` : ''}</div>` : ''}
      </div>`; }).join('') || `<p class="muted small">${L('مفيش أسئلة إضافية لسه.', 'No extra questions yet.')}</p>`;
  };
  m.$('#jq').onclick = (e) => {
    const up = e.target.closest('[data-up]'), dn = e.target.closest('[data-down]'), rm = e.target.closest('[data-rm]');
    if (!up && !dn && !rm) return; readQs();
    if (up) { const i = Number(up.dataset.up); [j.questions[i - 1], j.questions[i]] = [j.questions[i], j.questions[i - 1]]; }
    if (dn) { const i = Number(dn.dataset.down); [j.questions[i + 1], j.questions[i]] = [j.questions[i], j.questions[i + 1]]; }
    if (rm) j.questions.splice(Number(rm.dataset.rm), 1);
    drawQs();
  };
  m.$('#jq').addEventListener('change', (e) => { if (e.target.matches('[data-k=opts]')) { readQs(); drawQs(); } });
  m.$('#jqa').onclick = () => { readQs(); j.questions.push({ id: newId().slice(0, 8), type: m.$('#jqt').value, label: '', required: false, options: [] }); drawQs(); const ins = m.$$('[data-k=label]'); ins[ins.length - 1].focus(); };
  const drawCrit = () => { m.$('#jc').innerHTML = j.criteria.map((c, i) => `<div class="row gap-8" data-ci="${i}"><input class="input grow" data-k="label" value="${esc(critLabel(c))}"><label class="xs row gap-4 nowrap">${L('الوزن', 'Weight')}<input class="input num" style="width:80px" type="number" min="0" max="100" data-k="w" value="${esc(c.w)}"></label><button class="btn btn-sm btn-ghost btn-icon" data-crm="${i}" style="color:var(--bad)"><i class="fas fa-trash"></i></button></div>`).join(''); };
  const readCrit = () => { m.$$('[data-ci]').forEach(r => { const c = j.criteria[Number(r.dataset.ci)]; const lab = r.querySelector('[data-k=label]').value.trim(); if (lab !== critLabel(c)) c.label = lab; c.w = Number(r.querySelector('[data-k=w]').value) || 0; }); };
  m.$('#jc').onclick = (e) => { const b = e.target.closest('[data-crm]'); if (b) { readCrit(); j.criteria.splice(Number(b.dataset.crm), 1); drawCrit(); } };
  m.$('#jca').onclick = () => { readCrit(); j.criteria.push({ id: newId().slice(0, 8), label: '', w: 10 }); drawCrit(); };
  drawQs(); drawCrit();
  const del = m.$('#jdel');
  if (del) del.onclick = async () => { if (!(await confirmDialog({ title: L('مسح الوظيفة', 'Delete job'), message: j.title, okText: L('مسح', 'Delete'), okClass: 'btn-danger' }))) return; try { await deleteJob(job); m.close(); location.hash = '#/recruit/jobs'; } catch (ex) { toastErr(ex); } };
  m.$('#jsave').onclick = (e) => busy(e.currentTarget, async () => {
    readQs(); readCrit();
    const err = m.$('#je'); err.classList.add('hidden');
    const v = (id) => m.$('#' + id).value;
    const bad = j.questions.find(q => !String(q.label || '').trim());
    if (bad) { m.$$('#jt .tab')[1].click(); err.textContent = L('فيه سؤال فاضي — اكتبه أو امسحه.', 'A question is empty — write it or remove it.'); err.classList.remove('hidden'); return; }
    if (j.questions.some(q => (q.type === 'choice' || q.type === 'multi') && !(q.options || []).length)) { m.$$('#jt .tab')[1].click(); err.textContent = L('سؤال الاختيارات محتاج اختيارات.', 'A choice question needs options.'); err.classList.remove('hidden'); return; }
    const isNew = !job;
    try {
      const s = await getRecruitSettings().catch(() => ({}));
      const id = await saveJob({ ...j, id: job && job.id, title: v('j_title'), department: v('j_dept'), level: v('j_level'), type: v('j_type'), location: v('j_loc'), openings: v('j_open'),
        salaryMin: v('j_smin'), salaryMax: v('j_smax'), minYears: v('j_miny'), status: v('j_status'), description: v('j_desc'), must: v('j_must'), nice: v('j_nice'),
        fields: m.$$('[data-bi]').filter(c => c.checked).map(c => c.dataset.bi), cvRequired: m.$('#j_cv').checked, company: s.company || 'AL MASTER TECHNOLOGY' });
      m.close(); toast(L('الوظيفة اتحفظت', 'Job saved'));
      if (isNew) { const nj = await getJob(id); linksModal(nj); }
      onSaved && onSaved(id);
    } catch (ex) { if (ex.userMessage) { err.textContent = ex.userMessage; err.classList.remove('hidden'); } else toastErr(ex); }
  });
}

/** the apply links: one per place you post it, so you know where each applicant came from */
export function linksModal(job) {
  if (!job) return;
  const places = SOURCES.filter(s => !['referral', 'walkin'].includes(s[0]));
  const m = modal({
    title: L('لينكات التقديم', 'Apply links'), icon: 'fa-link',
    body: `<div class="col gap-12">${job.status !== 'open' ? `<div class="alert warn"><i class="fas fa-triangle-exclamation"></i><div>${L('الوظيفة مش «مفتوحة» — اللينك هيقول إن التقديم مقفول لحد ما تفتحها.', 'The job is not "Open" — the link says applications are closed until you open it.')}</div></div>` : ''}
      <p class="small muted">${L('حط اللينك في الإعلان. كل منصة ليها لينك، فبتعرف كل متقدم جه منين.', 'Put the link in your post. Each platform has its own link, so you know where each applicant came from.')}</p>
      ${places.map(s => `<div class="field"><label><i class="${s[2]}"></i> ${esc(s[1])}</label><div class="row gap-8"><input class="input grow" dir="ltr" readonly value="${esc(applyLink(job.id, s[0]))}"><button class="btn" data-copy="${esc(applyLink(job.id, s[0]))}"><i class="fas fa-copy"></i></button></div></div>`).join('')}</div>`,
    foot: `<a class="btn" target="_blank" rel="noopener" href="${esc(applyLink(job.id, 'preview'))}"><i class="fas fa-eye"></i> ${L('افتح الصفحة', 'Open the page')}</a><button class="btn btn-primary" data-close>${L('تمام', 'Done')}</button>`
  });
  m.el.addEventListener('click', async (e) => { const b = e.target.closest('[data-copy]'); if (!b) return; try { await navigator.clipboard.writeText(b.dataset.copy); toast(L('اتنسخ', 'Copied'), '', 'info'); } catch { } });
  m.el.addEventListener('focusin', (e) => { if (e.target.matches('input[readonly]')) e.target.select(); });
}

// ---------------------------------------------------------------- one job: the board
function renderBoard(root, jobId) {
  let job = null, apps = [], drafts = [], view = 'board', q = '', okOnly = false, showClosed = false, dragId = '', bErr = null;
  const picked = new Set();
  try { view = localStorage.getItem('am_rc_view') || 'board'; } catch {}
  root.innerHTML = loader();
  const draw = () => {
    if (!job) { root.innerHTML = empty('fa-briefcase', L('الوظيفة دي مش موجودة', 'Job not found'), ''); return; }
    const s = q.toLowerCase();
    const match = (a) => (!s || `${a.name} ${a.phone} ${a.email} ${a.currentTitle}`.toLowerCase().includes(s)) && (!okOnly || !fails(a, job).length);
    const active = apps.filter(a => (a.status === 'active' || a.status === 'hired') && match(a));
    const closed = apps.filter(a => (a.status === 'rejected' || a.status === 'withdrawn') && match(a));
    const card = (a) => { const f = fails(a, job); return `<div class="tk-card rc-card ${a.seen === false ? 'fresh' : ''}" draggable="true" data-open="${esc(a.id)}">
      <div class="row gap-8"><label class="rc-pick" title="${L('للمقارنة', 'Compare')}"><input type="checkbox" data-pick="${esc(a.id)}" ${picked.has(a.id) ? 'checked' : ''}></label><b class="grow truncate">${a.seen === false ? '<span class="rc-dot"></span>' : ''}${esc(a.name)}</b>${scoreBadge(a.score)}</div>
      <div class="xs muted truncate">${esc([a.currentTitle, a.years !== '' && a.years != null ? L(`${a.years} سنين`, `${a.years} yrs`) : ''].filter(Boolean).join(' · ') || a.phone || '')}</div>
      <div class="row gap-8 xs muted">${srcIcon(a.source)}<span>${esc(fmtWhen(a.createdMs))}</span>${f.length ? `<span class="badge bad" title="${esc(f.join('\n'))}"><i class="fas fa-xmark"></i> ${L('مش مستوفي', 'Not qualified')}</span>` : ''}${(a.recs || []).length ? `<span>${a.recs.map(r => r.includes('yes') ? '👍' : '👎').join('')}</span>` : ''}</div></div>`; };
    root.innerHTML = `<div class="rc-page">${errBox(bErr)}
      <div class="tk-head mb-16"><div class="col gap-4 min0"><a href="#/recruit/jobs" class="xs muted"><i class="fas fa-arrow-${isAr ? 'right' : 'left'}"></i> ${L('الوظايف', 'Jobs')}</a>
        <h2 class="rc-h truncate">${esc(job.title)} <span class="badge ${job.status === 'open' ? 'ok' : job.status === 'paused' ? 'warn' : ''}">${esc((JOB_STATUS[job.status] || JOB_STATUS.draft)())}</span></h2></div>
        <div class="row gap-8 wrap"><button class="btn btn-sm" id="bl"><i class="fas fa-link"></i> ${L('لينكات التقديم', 'Apply links')}</button><button class="btn btn-sm" id="ba"><i class="fas fa-user-plus"></i> ${L('إضافة متقدم', 'Add applicant')}</button>
          <button class="btn btn-sm" id="bc" ${picked.size >= 2 ? '' : 'disabled'} title="${L('علّم على 2 أو 3 متقدمين', 'Tick 2 or 3 applicants')}"><i class="fas fa-scale-balanced"></i> ${L('مقارنة', 'Compare')}${picked.size ? ` (${picked.size})` : ''}</button>
          <select class="select select-sm" id="bst" style="width:auto">${Object.keys(JOB_STATUS).map(k => `<option value="${k}" ${job.status === k ? 'selected' : ''}>${esc(JOB_STATUS[k]())}</option>`).join('')}</select>
          <button class="btn btn-sm btn-ghost" id="be"><i class="fas fa-pen"></i> ${L('تعديل', 'Edit')}</button></div></div>
      <div class="tk-filters"><div class="search"><i class="fas fa-search"></i><input class="input" id="bq" value="${esc(q)}" placeholder="${L('ابحث', 'Search')}"></div>
        <label class="chip chip-check"><input type="checkbox" id="bok" ${okOnly ? 'checked' : ''}> ${L('المستوفين بس', 'Qualified only')}</label>
        <div class="seg" id="bv"><button data-v="board" class="${view === 'board' ? 'on' : ''}"><i class="fas fa-table-columns"></i> ${L('لوحة', 'Board')}</button><button data-v="table" class="${view === 'table' ? 'on' : ''}"><i class="fas fa-list"></i> ${L('جدول', 'Table')}</button></div>
        <span class="xs muted">${L(`${num(apps.length)} متقدم`, `${num(apps.length)} applicants`)}</span></div>
      ${view === 'board' ? `<div class="tk-board rc-board">${STAGES.map(st => { const list = active.filter(a => a.stage === st.id).sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || (b.createdMs || 0) - (a.createdMs || 0));
        return `<section class="tk-col rc-col rc-${st.id}" data-stage="${st.id}"><header><i class="fas ${st.icon}"></i><b>${esc(L(st.ar, st.en))}</b><span class="num">${num(list.length)}</span></header><div class="tk-col-body">${list.map(card).join('') || `<div class="tk-none">—</div>`}</div></section>`; }).join('')}</div>`
      : `<div class="card"><div class="table-wrap"><table class="table"><thead><tr><th></th><th>${L('الاسم', 'Name')}</th><th>${L('المرحلة', 'Stage')}</th><th>${L('التقييم', 'Score')}</th><th>${L('الخبرة', 'Years')}</th><th>${L('الراتب المتوقع', 'Expected salary')}</th><th>${L('يبدأ', 'Available')}</th><th>${L('المصدر', 'Source')}</th><th>${L('قدّم', 'Applied')}</th></tr></thead><tbody>
        ${active.sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).map(a => { const f = fails(a, job); const over = job.salaryMax && a.salary > job.salaryMax; return `<tr class="rc-row" data-open="${esc(a.id)}"><td><input type="checkbox" data-pick="${esc(a.id)}" ${picked.has(a.id) ? 'checked' : ''}></td>
          <td><div class="person"><span><b>${a.seen === false ? '<span class="rc-dot"></span>' : ''}${esc(a.name)}</b><span>${esc(a.currentTitle || a.phone || '')}</span></span></div>${f.length ? `<span class="badge bad" title="${esc(f.join('\n'))}">${L('مش مستوفي', 'Not qualified')}</span>` : ''}</td>
          <td>${esc(stageLabel(a.stage))}</td><td>${scoreBadge(a.score)}</td><td class="num">${a.years === '' || a.years == null ? '—' : esc(a.years)}</td><td class="num ${over ? 'bad-txt' : ''}">${a.salary ? num(a.salary) : '—'}</td><td class="xs">${esc(a.available || '—')}</td><td>${srcIcon(a.source)}</td><td class="xs muted nowrap">${esc(fmtWhen(a.createdMs))}</td></tr>`; }).join('')}</tbody></table></div></div>`}
      ${drafts.length ? `<section class="card mt-16"><div class="card-head"><h3><i class="fas fa-hourglass-half"></i> ${L('تقديمات ما اكتملتش', 'Unfinished applications')} (${num(drafts.length)})</h3></div><div class="card-body col gap-8">
        <p class="xs muted">${L('ناس بدأوا التقديم من اللينك وبياناتهم وصلت، بس التقديم ما اتبعتش للآخر (غالباً رفع الـ CV ما نجحش). تقدر تضيفهم للمتقدمين وتطلب منهم الـ CV.', 'People who started on the apply link and whose details arrived, but who did not finish (usually the CV upload failed). Add them to the applicants and ask for the CV.')}</p>
        ${drafts.sort((a, b) => (b.createdMs || 0) - (a.createdMs || 0)).map(a => `<div class="rec-row"><div class="grow min0"><b class="truncate">${esc(a.name || '—')}</b><div class="xs muted truncate" dir="auto">${esc([a.phone, a.email, fmtWhen(a.createdMs, { hour: 'numeric', minute: '2-digit' })].filter(Boolean).join(' · '))}</div></div>
          <button class="btn btn-sm btn-primary" data-accept="${esc(a.id)}"><i class="fas fa-user-plus"></i> ${L('ضيفه للمتقدمين', 'Add to applicants')}</button></div>`).join('')}</div></section>` : ''}
      ${closed.length ? `<details class="card mt-16" ${showClosed ? 'open' : ''} id="bcl"><summary class="card-head" style="cursor:pointer"><h3><i class="fas fa-user-xmark"></i> ${L('مرفوضين وانسحبوا', 'Rejected & withdrew')} (${num(closed.length)})</h3></summary><div class="card-body col gap-8">
        ${closed.map(a => `<a class="rec-row" href="#/recruit/app/${esc(a.id)}"><div class="grow min0"><b class="truncate">${esc(a.name)}</b><div class="xs muted truncate">${esc(stageLabel(a.stage))}${a.rejectReason ? ' · ' + esc(pick(REJECT_REASONS, a.rejectReason)) : ''}</div></div><span class="badge bad">${esc((STATUS_LABEL[a.status] || STATUS_LABEL.rejected)())}</span></a>`).join('')}</div></details>` : ''}
    </div>`;
  };
  root.addEventListener('click', (e) => {
    const pk = e.target.closest('[data-pick]');
    if (pk) { e.stopPropagation(); const id = pk.dataset.pick; if (pk.checked) { if (picked.size >= 3) { pk.checked = false; toast(L('تقدر تقارن لحد 3', 'Compare up to 3'), '', 'info'); return; } picked.add(id); } else picked.delete(id); draw(); return; }
    if (e.target.closest('.rc-pick')) return;
    const ac = e.target.closest('[data-accept]');
    if (ac) { const a = drafts.find(x => x.id === ac.dataset.accept); if (a) busy(ac, async () => { try { await acceptDraft(a); toast(L('اتضاف — تقدر تفتحه من «جديد»', 'Added — find them under "New"')); } catch (ex) { toastErr(ex); } }); return; }
    const o = e.target.closest('[data-open]'); if (o) { location.hash = `#/recruit/app/${o.dataset.open}`; return; }
    if (e.target.closest('#bl')) { linksModal(job); return; }
    if (e.target.closest('#be')) { jobEditor(job, () => getJob(jobId).then(j => { if (j) { job = { ...j, id: jobId }; draw(); } })); return; }
    if (e.target.closest('#ba')) { addApplicantModal(job); return; }
    if (e.target.closest('#bc')) { compareModal(job, apps.filter(a => picked.has(a.id))); return; }
    const v = e.target.closest('[data-v]'); if (v) { view = v.dataset.v; try { localStorage.setItem('am_rc_view', view); } catch {} draw(); }
  });
  root.addEventListener('toggle', (e) => { if (e.target.id === 'bcl') showClosed = e.target.open; }, true);
  root.addEventListener('input', debounce((e) => { if (e.target.id === 'bq') { q = e.target.value.trim(); draw(); const i = root.querySelector('#bq'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 200));
  root.addEventListener('change', async (e) => {
    if (e.target.id === 'bok') { okOnly = e.target.checked; draw(); }
    if (e.target.id === 'bst') { try { await setJobStatus(job, e.target.value); job.status = e.target.value; draw(); toast(L('اتغيّرت الحالة', 'Status changed')); } catch (ex) { toastErr(ex); } }
  });
  // drag a card to another stage
  root.addEventListener('dragstart', (e) => { const c = e.target.closest('.rc-card'); if (!c) return; dragId = c.dataset.open; c.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
  root.addEventListener('dragend', () => { dragId = ''; root.querySelectorAll('.drop-ok').forEach(x => x.classList.remove('drop-ok')); });
  root.addEventListener('dragover', (e) => { const col = e.target.closest('.rc-col'); if (!col || !dragId) return; e.preventDefault(); root.querySelectorAll('.drop-ok').forEach(x => x !== col && x.classList.remove('drop-ok')); col.classList.add('drop-ok'); });
  root.addEventListener('drop', async (e) => {
    const col = e.target.closest('.rc-col'); if (!col || !dragId) return; e.preventDefault();
    const a = apps.find(x => x.id === dragId); dragId = '';
    if (!a || a.stage === col.dataset.stage) { draw(); return; }
    if (col.dataset.stage === 'hired') { toast(L('التعيين بيتم من صفحة المتقدم (العرض ← حوّله لموظف)', 'Hiring is done from the applicant page (Offer → make employee)'), '', 'info'); draw(); return; }
    try { await moveStage(a, col.dataset.stage); } catch (ex) { toastErr(ex); }
  });
  const u1 = watchApps(jobId, (r, d) => { apps = r; drafts = d || []; bErr = null; [...picked].forEach(id => { if (!apps.some(a => a.id === id)) picked.delete(id); }); if (job) draw(); }, (e) => { bErr = e; if (job) draw(); });
  getJob(jobId).then(j => { job = j ? { ...j, id: jobId } : null; draw(); }).catch(() => { job = null; draw(); });
  return () => u1();
}

/** HR adds someone by hand: Easy Apply on LinkedIn, a CV by email, a referral, a walk-in */
export function addApplicantModal(job) {
  let cv = null;
  const m = modal({
    title: L('إضافة متقدم', 'Add applicant'), icon: 'fa-user-plus', size: 'wide',
    body: `<div class="form-grid">
      <div class="field"><label>${L('الاسم', 'Name')} *</label><input class="input" name="name"></div>
      <div class="field"><label>${L('الموبايل', 'Mobile')} *</label><input class="input" name="phone" dir="ltr"></div>
      <div class="field"><label>${L('الإيميل', 'Email')}</label><input class="input" name="email" dir="ltr"></div>
      <div class="field"><label>${L('المصدر', 'Source')}</label><select class="select" name="source">${SOURCES.map(s => `<option value="${s[0]}">${esc(s[1])}</option>`).join('')}</select></div>
      <div class="field"><label>${L('المسمى الحالي', 'Current title')}</label><input class="input" name="currentTitle"></div>
      <div class="field"><label>${L('سنين الخبرة', 'Years')}</label><input class="input num" type="number" min="0" step="0.5" name="years"></div>
      <div class="field"><label>${L('الراتب المتوقع', 'Expected salary')}</label><input class="input num" type="number" min="0" name="salary"></div>
      <div class="field"><label>${L('المدينة', 'City')}</label><input class="input" name="city"></div>
      <div class="field"><label>${L('LinkedIn', 'LinkedIn')}</label><input class="input" name="linkedin" dir="ltr"></div>
      <div class="field"><label>${L('رشّحه مين؟', 'Referred by')}</label><input class="input" name="referredBy"></div>
      <div class="field span-2"><label>${L('الـ CV', 'CV')}</label><label class="dropzone"><input type="file" hidden id="acv" accept=".pdf,.doc,.docx,.png,.jpg,.jpeg"><i class="fas fa-file-arrow-up"></i> <span>${L('ارفع الـ CV — السيستم بيحاول يقرا منه الإيميل والموبايل', 'Upload the CV — the email and mobile are read from it when possible')}</span></label></div>
    </div><div id="aerr" class="alert bad hidden mt-8"></div>`,
    foot: `<button class="btn" data-close>${L('إلغاء', 'Cancel')}</button><button class="btn btn-primary" id="asv"><i class="fas fa-floppy-disk"></i> ${L('إضافة', 'Add')}</button>`
  });
  const f = (n) => m.el.querySelector(`[name="${n}"]`);
  m.$('#acv').onchange = async (e) => {
    cv = e.target.files[0] || null; if (!cv) return;
    m.$('#acv').parentElement.querySelector('span').textContent = cv.name;
    // a text-based PDF / Word file often has the email and the phone in plain text
    try {
      const txt = new TextDecoder('latin1').decode(new Uint8Array(await cv.slice(0, 3 * 1024 * 1024).arrayBuffer()));
      const em = (txt.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/) || [])[0];
      const ph = (txt.match(/(?:\+?20|0)1[0125][\s-]?\d{3,4}[\s-]?\d{4}/) || [])[0];
      if (em && !f('email').value) f('email').value = em.toLowerCase();
      if (ph && !f('phone').value) f('phone').value = ph.replace(/[\s-]/g, '');
    } catch {}
  };
  m.$('#asv').onclick = (e) => busy(e.currentTarget, async () => {
    const err = m.$('#aerr'); err.classList.add('hidden');
    const d = Object.fromEntries(['name', 'phone', 'email', 'source', 'currentTitle', 'years', 'salary', 'city', 'linkedin', 'referredBy'].map(n => [n, f(n).value.trim()]));
    try {
      const files = {};
      if (cv) files.cv = await uploadFile('app', `${job.id}_manual`, cv);
      const id = await addApplicant(job, { ...d, files });
      m.close(); toast(L('اتضاف', 'Added')); location.hash = `#/recruit/app/${id}`;
    } catch (ex) { if (ex.userMessage) { err.textContent = ex.userMessage; err.classList.remove('hidden'); } else toastErr(ex); }
  });
}

/** 2–3 applicants of one job side by side */
export async function compareModal(job, apps) {
  if (apps.length < 2) return;
  const m = modal({ title: L('مقارنة المتقدمين', 'Compare applicants'), icon: 'fa-scale-balanced', size: 'wide', body: loader(), foot: `<button class="btn btn-primary" data-close>${L('قفل', 'Close')}</button>` });
  m.el.addEventListener('click', (e) => { if (e.target.closest('.modal-body a[href^="#/"]')) m.close(); });
  const data = await Promise.all(apps.map(async a => {
    const [ivs, tks] = await Promise.all([list(query(col('interviews'), where('appId', '==', a.id))).catch(() => []), list(query(col('cand_tasks'), where('appId', '==', a.id))).catch(() => [])]);
    return { a, s: computeScore(job, ivs, tks), ivs };
  }));
  const crit = job.criteria && job.criteria.length ? job.criteria : DEFAULT_CRITERIA;
  const best = Math.max(...data.map(d => d.s.total ?? -1));
  const row = (label, fn) => `<tr><th>${esc(label)}</th>${data.map(d => `<td>${fn(d)}</td>`).join('')}</tr>`;
  const stars = (v) => v == null ? '—' : `<span class="num">${v.toFixed(1)}</span> / 5`;
  m.$('.modal-body').innerHTML = `<div class="table-wrap"><table class="table rc-cmp"><thead><tr><th></th>${data.map(d => `<th><a href="#/recruit/app/${esc(d.a.id)}" data-close>${esc(d.a.name)}</a>${d.s.total != null && d.s.total === best ? ` <span class="badge ok">${L('الأعلى', 'Top')}</span>` : ''}</th>`).join('')}</tr></thead><tbody>
    ${row(L('التقييم الكلي', 'Overall score'), d => d.s.total == null ? '—' : `<b class="num">${num(d.s.total)}</b> / 100`)}
    ${row(L('المرحلة', 'Stage'), d => esc(stageLabel(d.a.stage)))}
    ${crit.map(c => row(critLabel(c), d => stars(d.s.per[c.id]))).join('')}
    ${row(L('التاسك', 'Task'), d => d.s.task == null ? '—' : `<span class="num">${num(d.s.task)}</span> / 100`)}
    ${row(L('التوصيات', 'Recommendations'), d => (d.s.recs || []).map(r => `<span class="badge ${(RECS.find(x => x[0] === r) || [])[3] || ''}">${esc(pick(RECS, r))}</span>`).join(' ') || '—')}
    ${row(L('الخبرة', 'Experience'), d => d.a.years === '' || d.a.years == null ? '—' : L(`${d.a.years} سنين`, `${d.a.years} yrs`))}
    ${row(L('الراتب المتوقع', 'Expected salary'), d => d.a.salary ? `<span class="num ${job.salaryMax && d.a.salary > job.salaryMax ? 'bad-txt' : ''}">${num(d.a.salary)}</span>` : '—')}
    ${row(L('يبدأ', 'Available'), d => esc(d.a.available || '—'))}
    ${row(L('شروط مش مستوفيها', 'Requirements not met'), d => { const f = fails(d.a, job); return f.length ? `<span class="bad-txt">${f.map(esc).join('<br>')}</span>` : `<span class="badge ok">${L('مستوفي', 'All met')}</span>`; })}
    ${row(L('الإنترفيوهات', 'Interviews'), d => num(d.ivs.filter(i => i.status === 'done').length))}
    ${row(L('المصدر', 'Source'), d => `${srcIcon(d.a.source)} ${esc(sourceOf(d.a.source)[1])}`)}
    </tbody></table></div>
    ${job.salaryMin || job.salaryMax ? `<p class="xs muted mt-8">${L(`ميزانية الوظيفة: ${num(job.salaryMin || 0)} – ${num(job.salaryMax || 0)}`, `Budget: ${num(job.salaryMin || 0)} – ${num(job.salaryMax || 0)}`)}</p>` : ''}
    <p class="xs muted mt-8">${L('التقييم الكلي = متوسط تقييمات الإنترفيوهات بأوزان المعايير (3 أجزاء) + درجة التاسك (جزء). القرار في الآخر قراركم.', 'Overall = interview scores weighted by the criteria (3 parts) + the task grade (1 part). The final call is yours.')}</p>`;
}
