// Recruitment (HR & admin only): jobs and their application questions, applicants and their stages, interviews,
// take-home tasks sent by link, ready emails (HR copies them, or opens them in Outlook, and sends from the company
// address), offers and "hire → employee".
//   jobs/{id}              the job (with the salary range — HR only)
//   job_posts/{id}         what the public apply page shows (no salary); open == true while applying is allowed
//   applications/{jobId_phone}  one person × one job: their answers, files (Drive), stage, scores; /log = the timeline
//   interviews/{id}        a scheduled interview + its scorecard;  interview_links/{secret} = the candidate's link
//   cand_tasks/{secret}    a task sent to a candidate (the id is the link's secret);  task_bank/{id} = reusable tasks
//   email_templates/{id}   edited / added email templates (the built-in ones live in this file)
import {
  db, doc, col, watch, query, where, orderBy, limit, setDoc, updateDoc, deleteDoc, addDoc, getDoc, writeBatch, serverTimestamp, toMs, read, list
} from '../core/fb.js';
import { session, now, isHR } from '../core/session.js';
import { userError } from '../core/ui.js';
import { L, isAr } from '../core/utils.js';
import { callService } from './authsvc.js';
import { nameOf } from './directory.js';
import { track } from './activity.js';

export const canRecruit = () => isHR();

// ---------------------------------------------------------------- vocab
export const STAGES = [
  { id: 'new', ar: 'جديد', en: 'New', icon: 'fa-inbox' },
  { id: 'hr', ar: 'إنترفيو HR', en: 'HR interview', icon: 'fa-user-tie' },
  { id: 'tech', ar: 'إنترفيو تكنيكال', en: 'Technical interview', icon: 'fa-gears' },
  { id: 'hired', ar: 'اتعيّن', en: 'Hired', icon: 'fa-circle-check' }
];
/** stages of an earlier version → the nearest one now */
const OLD_STAGE = { screen: 'new', phone: 'new', task: 'hr', final: 'tech', offer: 'tech' };
export const normStage = (id) => OLD_STAGE[id] || (STAGES.some(s => s.id === id) ? id : 'new');
const norm = (a) => (a ? { ...a, stage: normStage(a.stage) } : a);
export const stageOf = (id) => STAGES.find(s => s.id === id) || STAGES[0];
export const stageLabel = (id) => { const s = stageOf(id); return L(s.ar, s.en); };
export const STATUS_LABEL = {
  draft: () => L('لسه بيقدّم', 'Still applying'), active: () => L('شغال', 'Active'), rejected: () => L('مرفوض', 'Rejected'),
  withdrawn: () => L('انسحب', 'Withdrew'), hired: () => L('اتعيّن', 'Hired')
};
export const REJECT_REASONS = [
  ['experience', 'خبرة أقل من المطلوب', 'Not enough experience'], ['skills', 'المهارات مش مناسبة', 'Skills do not match'],
  ['salary', 'الراتب المتوقع أعلى من الميزانية', 'Expected salary above budget'], ['interview', 'أداء الإنترفيو', 'Interview performance'],
  ['task', 'مستوى التاسك', 'Task quality'], ['culture', 'مش مناسب لبيئة الشغل', 'Not a culture fit'], ['noshow', 'ما حضرش / ما ردّش', 'No show / no answer'],
  ['filled', 'الوظيفة اتملت', 'Position filled'], ['other', 'سبب تاني', 'Other']
];
export const SOURCES = [
  ['linkedin', 'LinkedIn', 'fa-brands fa-linkedin'], ['wuzzuf', 'Wuzzuf', 'fa-solid fa-briefcase'], ['facebook', 'Facebook', 'fa-brands fa-facebook'],
  ['website', L('الموقع', 'Website'), 'fa-solid fa-globe'], ['referral', L('ترشيح', 'Referral'), 'fa-solid fa-user-group'],
  ['walkin', L('حضور مباشر', 'Walk-in'), 'fa-solid fa-door-open'], ['other', L('تاني', 'Other'), 'fa-solid fa-ellipsis']
];
export const sourceOf = (id) => SOURCES.find(s => s[0] === id) || SOURCES[SOURCES.length - 1];
export const LEVELS = [['intern', 'متدرب', 'Intern'], ['junior', 'Junior', 'Junior'], ['mid', 'Mid', 'Mid'], ['senior', 'Senior', 'Senior'], ['lead', 'Lead', 'Lead'], ['manager', 'مدير', 'Manager']];
export const JOB_TYPES = [['fulltime', 'دوام كامل', 'Full-time'], ['parttime', 'دوام جزئي', 'Part-time'], ['remote', 'ريموت', 'Remote'], ['hybrid', 'هايبرد', 'Hybrid'], ['internship', 'تدريب', 'Internship'], ['freelance', 'فريلانس', 'Freelance']];
export const pick = (list, id) => { const x = list.find(r => r[0] === id); return x ? L(x[1], x[2]) : (id || ''); };
export const JOB_STATUS = { draft: () => L('مسودة', 'Draft'), open: () => L('مفتوحة', 'Open'), paused: () => L('متوقفة', 'Paused'), closed: () => L('اتقفلت', 'Closed') };
export const ROUNDS = [['hr', 'إنترفيو HR', 'HR interview'], ['tech', 'إنترفيو تكنيكال', 'Technical interview'], ['phone', 'مكالمة تليفون', 'Phone call'], ['final', 'إنترفيو نهائي', 'Final interview']];
export const ROUND_CHOICES = ROUNDS.slice(0, 2);   // what a new interview can be (older ones keep their names)
export const MODES = [['office', 'في المكتب', 'In the office'], ['online', 'أونلاين', 'Online'], ['phone', 'تليفون', 'Phone']];
export const RECS = [['strong_yes', 'أكيد نعم', 'Strong yes', 'ok'], ['yes', 'نعم', 'Yes', 'ok'], ['no', 'لا', 'No', 'bad'], ['strong_no', 'أكيد لا', 'Strong no', 'bad']];
export const Q_TYPES = [
  ['short', 'إجابة قصيرة', 'Short answer', 'fa-font'], ['long', 'إجابة طويلة', 'Long answer', 'fa-align-left'], ['number', 'رقم', 'Number', 'fa-hashtag'],
  ['choice', 'اختيار واحد', 'One choice', 'fa-circle-dot'], ['multi', 'أكتر من اختيار', 'Several choices', 'fa-square-check'], ['yesno', 'نعم / لا', 'Yes / No', 'fa-toggle-on'],
  ['link', 'رابط', 'Link', 'fa-link'], ['file', 'إرفاق ملف', 'File upload', 'fa-paperclip'], ['date', 'تاريخ', 'Date', 'fa-calendar']
];
/** built-in fields the job may ask (name, phone, email and the CV are always asked) */
export const BUILTIN = [
  ['city', 'المدينة / المنطقة', 'City / area'], ['currentTitle', 'المسمى الوظيفي الحالي', 'Current job title'], ['years', 'سنين الخبرة', 'Years of experience'],
  ['salary', 'الراتب المتوقع (شهري)', 'Expected salary (monthly)'], ['available', 'تقدر تبدأ إمتى؟', 'When can you start?'],
  ['linkedin', 'لينك LinkedIn', 'LinkedIn link'], ['portfolio', 'بورتفوليو / أعمال سابقة', 'Portfolio / previous work']
];
export const DEFAULT_FIELDS = ['city', 'currentTitle', 'years', 'salary', 'available', 'linkedin'];
export const DEFAULT_CRITERIA = [
  { id: 'tech', ar: 'المهارات الفنية', en: 'Technical skills', w: 30 }, { id: 'exp', ar: 'الخبرة', en: 'Experience', w: 25 },
  { id: 'comm', ar: 'التواصل', en: 'Communication', w: 20 }, { id: 'culture', ar: 'الملاءمة لبيئة الشغل', en: 'Culture fit', w: 15 },
  { id: 'english', ar: 'الإنجليزي', en: 'English', w: 10 }
];
export const critLabel = (c) => (c.label || L(c.ar, c.en) || c.id);

// ---------------------------------------------------------------- small helpers
const rid = (n = 22) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map(x => 'abcdefghijkmnpqrstuvwxyz23456789'[x % 32]).join(''); };
export const newId = () => rid(20);
/** Egyptian-friendly phone key: digits only, +20 / 0020 → 0 */
export function phoneKey(p) {
  let d = String(p || '').replace(/[٠-٩]/g, c => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).replace(/\D/g, '');
  if (d.startsWith('0020')) d = '0' + d.slice(4);
  else if (d.startsWith('20') && d.length === 12) d = '0' + d.slice(2);
  return d;
}
export const appIdFor = (jobId, phone) => `${jobId}_${phoneKey(phone)}`;
export const siteBase = () => location.origin + location.pathname.replace(/[^/]*$/, '');
export const applyLink = (jobId, source = '') => `${siteBase()}apply.html#j=${encodeURIComponent(jobId)}${source ? '&s=' + encodeURIComponent(source) : ''}`;
export const taskLink = (taskId) => `${siteBase()}task.html#t=${encodeURIComponent(taskId)}`;
export const interviewLink = (linkId) => `${siteBase()}guest.html#i=${encodeURIComponent(linkId)}`;
const clean = (s, n = 200) => String(s ?? '').trim().slice(0, n);

/** does the answer break the question's "must" rule? (yes/no must be X · number at least N) */
export function failsRule(q, v) {
  const r = q && q.rule; if (!r) return false;
  if (q.type === 'yesno' && (r.equals === 'yes' || r.equals === 'no')) return v !== '' && v != null && v !== r.equals;
  if (q.type === 'number' && r.min != null && r.min !== '') return v !== '' && v != null && Number(v) < Number(r.min);
  if (q.type === 'choice' && Array.isArray(r.allowed) && r.allowed.length) return !!v && !r.allowed.includes(v);
  return false;
}
/** questions this application fails (and the built-in "min years") */
export function fails(app, job) {
  const out = [];
  ((job && job.questions) || []).forEach(q => { if (failsRule(q, ((app && app.answers) || {})[q.id])) out.push(q.label); });
  if (job && Number(job.minYears) > 0 && app && app.years !== '' && app.years != null && Number(app.years) < Number(job.minYears)) out.push(L(`خبرة أقل من ${job.minYears} سنين`, `Less than ${job.minYears} years`));
  return out;
}

// ---------------------------------------------------------------- jobs
export const watchJobs = (cb) => watch(col('jobs'), rows => cb(rows.sort((a, b) => (toMs(b.createdAt) || 0) - (toMs(a.createdAt) || 0))), () => cb([]));
export const getJob = (id) => read('jobs', id);
const publicPost = (j) => ({
  title: j.title, department: j.department || '', level: j.level || '', type: j.type || '', location: j.location || '',
  description: j.description || '', must: j.must || '', nice: j.nice || '', fields: j.fields || [], questions: (j.questions || []).map(q => ({ id: q.id, type: q.type, label: q.label, help: q.help || '', required: !!q.required, options: q.options || [] })),
  cvRequired: j.cvRequired !== false, open: j.status === 'open', company: j.company || '', updatedAt: serverTimestamp()
});
export async function saveJob(job) {
  const title = clean(job.title, 120);
  if (title.length < 2) throw userError('اكتب اسم الوظيفة.', 'Write the job title.');
  const qs = (job.questions || []).map(q => ({ ...q, label: clean(q.label, 300) })).filter(q => q.label);
  if (qs.length > 40) throw userError('الأسئلة كتير — الحد 40 سؤال.', 'Too many questions — 40 at most.');
  const id = job.id || newId();
  const isNew = !job.id;
  const data = {
    title, department: clean(job.department, 80), level: job.level || '', type: job.type || '', location: clean(job.location, 120), openings: Math.max(1, Number(job.openings) || 1),
    salaryMin: Number(job.salaryMin) || 0, salaryMax: Number(job.salaryMax) || 0, minYears: Number(job.minYears) || 0,
    description: clean(job.description, 6000), must: clean(job.must, 3000), nice: clean(job.nice, 3000), status: job.status || 'draft',
    fields: (job.fields || []).filter(f => BUILTIN.some(b => b[0] === f)), questions: qs, cvRequired: job.cvRequired !== false,
    criteria: (job.criteria && job.criteria.length ? job.criteria : DEFAULT_CRITERIA).map(c => ({ id: c.id, label: c.label || '', ar: c.ar || '', en: c.en || '', w: Math.max(0, Number(c.w) || 0) })),
    company: clean(job.company, 120), updatedAt: serverTimestamp(), updatedBy: session.email
  };
  const b = writeBatch(db);
  b.set(doc(db, 'jobs', id), isNew ? { ...data, createdAt: serverTimestamp(), createdBy: session.email } : data, { merge: true });
  b.set(doc(db, 'job_posts', id), publicPost(data));
  await b.commit();
  track(isNew ? 'recruit.job.create' : 'recruit.job.update', { target: title, detail: data.status });
  return id;
}
export async function setJobStatus(job, status) {
  const b = writeBatch(db);
  b.update(doc(db, 'jobs', job.id), { status, updatedAt: serverTimestamp() });
  b.set(doc(db, 'job_posts', job.id), { open: status === 'open', updatedAt: serverTimestamp() }, { merge: true });
  await b.commit();
}
export async function deleteJob(job) {
  const apps = await list(query(col('applications'), where('jobId', '==', job.id), limit(1)));
  if (apps.length) throw userError('الوظيفة دي عليها متقدمين — اقفلها بدل ما تمسحها.', 'This job has applicants — close it instead of deleting.');
  const b = writeBatch(db);
  b.delete(doc(db, 'jobs', job.id)); b.delete(doc(db, 'job_posts', job.id));
  await b.commit();
}

// ---------------------------------------------------------------- applications
/** cb(applications, unfinished) — unfinished = started on the apply page but not sent (e.g. the CV upload failed) */
export const watchApps = (jobId, cb, onErr) => watch(query(col('applications'), where('jobId', '==', jobId)), rows => cb(rows.filter(a => a.status !== 'draft').map(norm), rows.filter(a => a.status === 'draft').map(norm)), (e) => { cb([], []); onErr && onErr(e); });
/** newest first, sorted here (not in the query) so an application whose createdAt is missing still shows */
const appTime = (a) => toMs(a.createdAt) || a.createdMs || toMs(a.updatedAt) || 0;
export const watchAllApps = (cb, onErr) => watch(query(col('applications'), limit(600)), rows => {
  rows = rows.slice().sort((x, y) => appTime(y) - appTime(x));
  cb(rows.filter(a => a.status !== 'draft').map(norm), rows.filter(a => a.status === 'draft').map(norm));
}, (e) => { cb([], []); onErr && onErr(e); });
/** why a list came back empty — shown on the screen instead of a silent "no applicants" */
export const readError = (e) => {
  const c = String((e && e.code) || '').replace('firestore/', '');
  if (c === 'permission-denied') return L('السيستم رفض قراءة المتقدمين (صلاحيات). اتأكد إن ملف الـ rules الأخير اتنشر في Firebase وإنك داخل بحساب HR أو أدمن.', 'Reading applicants was refused (permissions). Make sure the latest rules are published in Firebase and you are signed in as HR or admin.');
  if (c === 'resource-exhausted') return L('Firebase وصل لحد القراءة المجاني النهارده — هيرجع يشتغل بكره.', 'Firebase hit today\'s free read limit — it will work again tomorrow.');
  return L(`مش قادر يقرا المتقدمين دلوقتي (${c || 'error'}) — جرّب تحدّث الصفحة.`, `Could not read applicants (${c || 'error'}) — try refreshing.`);
};
export const watchUnseen = (cb) => watch(query(col('applications'), where('seen', '==', false)), rows => cb(rows.filter(a => a.status === 'active')), () => cb([]));
export const watchApp = (id, cb) => watch(doc(db, 'applications', id), d => cb(norm(d)));
export const watchLog = (id, cb) => watch(query(col(`applications/${id}/log`), orderBy('atMs', 'desc'), limit(200)), cb, () => cb([]));
/** the same person on other jobs (by phone) */
export const otherApps = async (app) => (await list(query(col('applications'), where('phoneKey', '==', app.phoneKey)))).filter(a => a.id !== app.id && a.status !== 'draft').map(norm);

export function addLog(appId, entry) {
  return addDoc(col(`applications/${appId}/log`), { ...entry, by: session.email, byName: nameOf(session.email), at: serverTimestamp(), atMs: now() });
}
/** HR adds someone by hand (Easy Apply on LinkedIn, a CV by email, a referral…) */
export async function addApplicant(job, d) {
  const name = clean(d.name, 100), pk = phoneKey(d.phone);
  if (name.length < 2) throw userError('اكتب الاسم.', 'Write the name.');
  if (pk.length < 8) throw userError('اكتب رقم تليفون صحيح.', 'Write a valid phone number.');
  const id = `${job.id}_${pk}`;
  const ex = await getDoc(doc(db, 'applications', id));
  if (ex.exists() && ex.data().status !== 'draft') throw userError('الشخص ده متسجّل على الوظيفة دي بالفعل.', 'This person already applied to this job.');
  const data = {
    jobId: job.id, jobTitle: job.title, name, phone: clean(d.phone, 30), phoneKey: pk, email: clean(d.email, 120).toLowerCase(), city: clean(d.city, 80),
    currentTitle: clean(d.currentTitle, 100), years: d.years === '' || d.years == null ? '' : Number(d.years), salary: d.salary === '' || d.salary == null ? '' : Number(d.salary),
    available: clean(d.available, 60), linkedin: clean(d.linkedin, 300), portfolio: clean(d.portfolio, 300), answers: {}, files: d.files || {},
    source: d.source || 'other', referredBy: clean(d.referredBy, 100), stage: 'new', status: 'active', uid: '', seen: true, score: null,
    createdAt: serverTimestamp(), createdMs: now(), updatedAt: serverTimestamp(), addedBy: session.email
  };
  await setDoc(doc(db, 'applications', id), data);
  addLog(id, { type: 'created', text: L('اتضاف يدوي', 'Added by hand') }).catch(() => {});
  track('recruit.app.add', { target: name, detail: job.title });
  return id;
}
export async function updateApp(app, data) { await updateDoc(doc(db, 'applications', app.id), { ...data, updatedAt: serverTimestamp() }); }
export async function moveStage(app, stage) {
  if (app.stage === stage && app.status === 'active') return;
  await updateApp(app, { stage, status: stage === 'hired' ? 'hired' : 'active', seen: true, stageAt: now() });
  await addLog(app.id, { type: 'stage', from: app.stage, to: stage, text: `${stageLabel(app.stage)} ← ${stageLabel(stage)}` });
}
export async function rejectApp(app, reason, note = '') {
  await updateApp(app, { status: 'rejected', rejectReason: reason, rejectNote: clean(note, 500), seen: true });
  await addLog(app.id, { type: 'rejected', text: pick(REJECT_REASONS.map(r => [r[0], r[1], r[2]]), reason) + (note ? ' — ' + clean(note, 500) : '') });
}
export async function withdrawApp(app, note = '') {
  await updateApp(app, { status: 'withdrawn', seen: true });
  await addLog(app.id, { type: 'withdrawn', text: clean(note, 500) || L('انسحب', 'Withdrew') });
}
export async function reopenApp(app) {
  await updateApp(app, { status: 'active', rejectReason: '', rejectNote: '' });
  await addLog(app.id, { type: 'reopened', text: L('رجع للمراحل', 'Back in the process') });
}
/** an application left unfinished on the apply page → a normal applicant (HR asks for what is missing) */
export async function acceptDraft(app) {
  await updateApp(app, { status: 'active', seen: true, stage: 'new', fromDraft: true });
  await addLog(app.id, { type: 'created', text: L('التقديم ما كملش من صفحة التقديم — اتضاف للمتقدمين', 'Unfinished on the apply page — added to the applicants') });
}
export const markSeen = (app) => (app.seen === false ? updateDoc(doc(db, 'applications', app.id), { seen: true }).catch(() => {}) : Promise.resolve());
export const addNote = (app, text) => { const t = clean(text, 3000); if (!t) return Promise.resolve(); return addLog(app.id, { type: 'note', text: t }); };

// ---------------------------------------------------------------- scoring
/** 0–100 from the interviews' scorecards (weighted by the job's criteria) and the graded tasks */
export function computeScore(job, interviews, tasks) {
  const crit = (job && job.criteria && job.criteria.length ? job.criteria : DEFAULT_CRITERIA);
  const scored = (interviews || []).filter(i => i.scores && Object.keys(i.scores).length);
  const per = {};
  crit.forEach(c => { const v = scored.map(i => Number(i.scores[c.id])).filter(x => x > 0); per[c.id] = v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; });
  const used = crit.filter(c => per[c.id] != null && c.w > 0);
  const wsum = used.reduce((s, c) => s + c.w, 0);
  const iv = wsum ? used.reduce((s, c) => s + per[c.id] * c.w, 0) / wsum : null;   // 1–5
  const tv = (tasks || []).filter(t => t.score != null && t.score !== '').map(t => Number(t.score));
  const task = tv.length ? tv.reduce((s, x) => s + x, 0) / tv.length : null;      // 0–100
  const parts = [];
  if (iv != null) parts.push({ v: (iv - 1) / 4 * 100, w: 3 });
  if (task != null) parts.push({ v: task, w: 1 });
  const total = parts.length ? Math.round(parts.reduce((s, p) => s + p.v * p.w, 0) / parts.reduce((s, p) => s + p.w, 0)) : null;
  const recs = scored.map(i => i.rec).filter(Boolean);
  return { total, per, interview: iv, task, recs };
}
export async function refreshScore(app, job) {
  const [ivs, tks] = await Promise.all([list(query(col('interviews'), where('appId', '==', app.id))), list(query(col('cand_tasks'), where('appId', '==', app.id)))]);
  const s = computeScore(job, ivs, tks);
  await updateDoc(doc(db, 'applications', app.id), { score: s.total, recs: s.recs }).catch(() => {});
  return s;
}

// ---------------------------------------------------------------- interviews
export const watchInterviewsOf = (appId, cb) => watch(query(col('interviews'), where('appId', '==', appId)), rows => cb(rows.sort((a, b) => (a.at || 0) - (b.at || 0))), () => cb([]));
export const watchUpcoming = (fromMs, cb) => watch(query(col('interviews'), where('at', '>=', fromMs), orderBy('at'), limit(200)), cb, () => cb([]));
export async function saveInterview(app, iv) {
  const at = Number(iv.at);
  if (!at) throw userError('اختار اليوم والساعة.', 'Pick the day and time.');
  const id = iv.id || newId();
  const isNew = !iv.id;
  const data = {
    appId: app.id, jobId: app.jobId, jobTitle: app.jobTitle || '', name: app.name, round: iv.round || 'hr', at, minutes: Math.max(10, Number(iv.minutes) || 45),
    mode: iv.mode || 'office', location: clean(iv.location, 300), interviewers: (iv.interviewers || []).slice(0, 10), notes: clean(iv.notes, 2000),
    status: iv.status || 'scheduled', updatedAt: serverTimestamp(), updatedBy: session.email
  };
  let linkId = iv.linkId || '';
  if (data.mode === 'online' && !linkId) linkId = rid(24);
  if (linkId) data.linkId = linkId;
  const b = writeBatch(db);
  b.set(doc(db, 'interviews', id), isNew ? { ...data, createdAt: serverTimestamp(), createdBy: session.email } : data, { merge: true });
  if (linkId) b.set(doc(db, 'interview_links', linkId), { title: `${pick(ROUNDS, data.round)} — ${data.jobTitle}`, at, minutes: data.minutes, callId: iv.callId || '', key: iv.callKey || '', updatedAt: serverTimestamp() }, { merge: true });
  await b.commit();
  await addLog(app.id, { type: 'interview', text: `${isNew ? L('اتحجز', 'Booked') : L('اتعدّل', 'Updated')}: ${pick(ROUNDS, data.round)} — ${new Date(at).toLocaleString(isAr ? 'ar-EG' : 'en-GB', { timeZone: 'Africa/Cairo', weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' })}` });
  return { id, ...data };
}
export async function setInterviewStatus(iv, status) { await updateDoc(doc(db, 'interviews', iv.id), { status, updatedAt: serverTimestamp() }); }
export async function saveScorecard(iv, card) {
  await updateDoc(doc(db, 'interviews', iv.id), { scores: card.scores || {}, rec: card.rec || '', feedback: clean(card.feedback, 4000), attended: (card.attended || []).slice(0, 10), status: 'done', scoredBy: session.email, scoredAt: serverTimestamp() });
  await addLog(iv.appId, { type: 'score', text: `${pick(ROUNDS, iv.round)}: ${pick(RECS, card.rec)}` });
}
/** the interview starts now: an online meeting + its guest link, written where the candidate's link waits */
export async function linkInterviewCall(iv, callId, guestUrl) {
  const m = String(guestUrl).match(/[#&]c=([^&]+)&k=([^&]+)/);
  const key = m ? decodeURIComponent(m[2]) : '';
  await setDoc(doc(db, 'interview_links', iv.linkId), { callId, key, startedAt: now() }, { merge: true });
  await updateDoc(doc(db, 'interviews', iv.id), { callId, startedAt: now() }).catch(() => {});
}
export async function deleteInterview(iv) {
  const b = writeBatch(db);
  b.delete(doc(db, 'interviews', iv.id));
  if (iv.linkId) b.delete(doc(db, 'interview_links', iv.linkId));
  await b.commit();
  await addLog(iv.appId, { type: 'interview', text: L(`اتلغى: ${pick(ROUNDS, iv.round)}`, `Cancelled: ${pick(ROUNDS, iv.round)}`) });
}

// ---------------------------------------------------------------- tasks sent to candidates
export const watchBank = (cb) => watch(col('task_bank'), rows => cb(rows.sort((a, b) => String(a.title).localeCompare(String(b.title), 'ar'))), () => cb([]));
export async function saveBankTask(t) {
  const title = clean(t.title, 160);
  if (title.length < 2) throw userError('اكتب عنوان التاسك.', 'Write the task title.');
  const id = t.id || newId();
  await setDoc(doc(db, 'task_bank', id), { title, body: clean(t.body, 8000), hours: Math.max(0, Number(t.hours) || 0), files: t.files || [], updatedAt: serverTimestamp(), updatedBy: session.email }, { merge: true });
  return id;
}
export const deleteBankTask = (t) => deleteDoc(doc(db, 'task_bank', t.id));
export const watchTasksOf = (appId, cb) => watch(query(col('cand_tasks'), where('appId', '==', appId)), rows => cb(rows.sort((a, b) => (b.sentMs || 0) - (a.sentMs || 0))), () => cb([]));
export const watchRecentTasks = (cb) => watch(query(col('cand_tasks'), orderBy('sentMs', 'desc'), limit(60)), cb, () => cb([]));
/** deadline: `hours` after the candidate opens the link, or a fixed date (dueMs) */
export async function sendTask(app, t) {
  const title = clean(t.title, 160);
  if (title.length < 2) throw userError('اكتب عنوان التاسك.', 'Write the task title.');
  const hours = Math.max(0, Number(t.hours) || 0), dueMs = Number(t.dueMs) || 0;
  if (!hours && !dueMs) throw userError('حدد مدة التسليم.', 'Set the deadline.');
  const id = rid(24);
  await setDoc(doc(db, 'cand_tasks', id), {
    appId: app.id, jobId: app.jobId, jobTitle: app.jobTitle || '', name: app.name, title, body: clean(t.body, 8000), files: t.files || [],
    hours, dueMs, status: 'sent', uid: '', answer: '', links: [], subFiles: [], score: null, review: '',
    sentMs: now(), sentAt: serverTimestamp(), sentBy: session.email
  });
  await addLog(app.id, { type: 'task', text: L(`اتبعت تاسك: ${title}`, `Task sent: ${title}`) });
  return id;
}
export async function gradeTask(t, score, review) {
  const s = Math.max(0, Math.min(100, Number(score)));
  await updateDoc(doc(db, 'cand_tasks', t.id), { score: s, review: clean(review, 3000), status: 'graded', gradedBy: session.email, gradedAt: serverTimestamp() });
  await addLog(t.appId, { type: 'task', text: L(`التاسك اتصحّح: ${s}/100`, `Task graded: ${s}/100`) });
}
/** the candidate switched device / the link got stuck: open it again (same deadline rules from the next opening) */
export const resetTask = (t) => updateDoc(doc(db, 'cand_tasks', t.id), { uid: '', status: 'sent', openedAt: null, deadlineMs: 0 });
export const deleteTask = (t) => deleteDoc(doc(db, 'cand_tasks', t.id));

// ---------------------------------------------------------------- files (Drive, through the Apps Script)
export async function uploadFile(kind, ref, file) {
  if (file.size > 5 * 1024 * 1024) throw userError(`الملف «${file.name}» أكبر من 5 ميجا.`, `"${file.name}" is larger than 5 MB.`);
  const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(file); });
  const r = await callService('rUp', { kind, ref, name: file.name, mime: file.type || 'application/octet-stream', data: b64 });
  return { driveId: r.driveId, name: file.name.slice(0, 180), mime: file.type || '', size: file.size };
}
export async function openFile(f, kind = '', ref = '') {
  const r = await callService('rGet', { driveId: f.driveId, kind, ref });
  const bin = atob(r.data || ''); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([arr], { type: r.mime || f.mime || 'application/octet-stream' }));
}

// ---------------------------------------------------------------- settings & offers
export const getRecruitSettings = async () => (await read('settings', 'recruit').catch(() => null)) || {};
export const saveRecruitSettings = (d) => setDoc(doc(db, 'settings', 'recruit'), { ...d, updatedAt: serverTimestamp() }, { merge: true });
export async function saveOffer(app, o) {
  const offer = { salary: Number(o.salary) || 0, start: clean(o.start, 20), probation: Number(o.probation) || 0, notes: clean(o.notes, 2000), status: o.status || 'draft', updatedMs: now() };
  await updateApp(app, { offer });
  await addLog(app.id, { type: 'offer', text: L(`العرض: ${offer.salary} — ${offerStatus(offer.status)}`, `Offer: ${offer.salary} — ${offerStatus(offer.status)}`) });
}
export const OFFER_STATUS = [['draft', 'مسودة', 'Draft'], ['sent', 'اتبعت', 'Sent'], ['accepted', 'اتقبل', 'Accepted'], ['declined', 'اترفض', 'Declined']];
export const offerStatus = (s) => pick(OFFER_STATUS, s);
export async function markHired(app, email) {
  await updateApp(app, { stage: 'hired', status: 'hired', employeeEmail: email || '', hiredAt: now() });
  await addLog(app.id, { type: 'hired', text: L(`اتعيّن — حسابه: ${email}`, `Hired — account: ${email}`) });
  track('recruit.hire', { target: app.name, detail: app.jobTitle || '' });
}

// ---------------------------------------------------------------- emails (HR sends them from the company address)
export const PH = {   // placeholder → [Arabic label, English label]
  name: ['الاسم', 'Name'], job: ['الوظيفة', 'Job'], company: ['الشركة', 'Company'], day: ['اليوم', 'Day'], date: ['التاريخ', 'Date'], time: ['الساعة', 'Time'],
  duration: ['المدة', 'Duration'], place: ['المكان', 'Place'], link: ['اللينك', 'Link'], deadline: ['آخر_معاد', 'Deadline'], salary: ['الراتب', 'Salary'],
  start: ['تاريخ_البداية', 'Start_date'], notes: ['ملاحظات', 'Notes'], sender: ['اسمي', 'My_name']
};
const ar = (k) => `{${PH[k][0]}}`;
export const BUILTIN_TEMPLATES = [
  { id: 'b_received', kind: 'received', lang: 'ar', name: 'وصلنا طلبك', subject: `وصلنا طلبك لوظيفة ${ar('job')}`, body: `أهلاً ${ar('name')}،\n\nشكراً لاهتمامك بالانضمام لـ ${ar('company')}. وصلنا طلبك لوظيفة ${ar('job')}، وفريق الموارد البشرية بيراجعه، وهنتواصل معاك لو فيه خطوة جاية.\n\nمع التحية،\n${ar('sender')}\n${ar('company')}` },
  { id: 'b_phone', kind: 'phone', lang: 'ar', name: 'ميعاد مكالمة تليفون', subject: `مكالمة تعارف — ${ar('job')}`, body: `أهلاً ${ar('name')}،\n\nحابين نتكلم معاك في مكالمة تليفون قصيرة بخصوص وظيفة ${ar('job')}.\n\nالمعاد: ${ar('day')} ${ar('date')} الساعة ${ar('time')} (حوالي ${ar('duration')}).\n\nلو المعاد مش مناسب، رد على الإيميل ده بمعاد يناسبك.\n\nمع التحية،\n${ar('sender')}\n${ar('company')}` },
  { id: 'b_hr', kind: 'hr', lang: 'ar', name: 'دعوة إنترفيو أول', subject: `دعوة لإنترفيو — ${ar('job')}`, body: `أهلاً ${ar('name')}،\n\nبعد مراجعة طلبك لوظيفة ${ar('job')}، يسعدنا ندعوك لإنترفيو.\n\nاليوم: ${ar('day')} ${ar('date')}\nالساعة: ${ar('time')}\nالمدة: حوالي ${ar('duration')}\nالمكان: ${ar('place')}\nاللينك: ${ar('link')}\n${ar('notes')}\n\nبرجاء تأكيد الحضور بالرد على الإيميل ده.\n\nمع التحية،\n${ar('sender')}\n${ar('company')}` },
  { id: 'b_tech', kind: 'tech', lang: 'ar', name: 'دعوة إنترفيو تاني (فني)', subject: `الإنترفيو التاني — ${ar('job')}`, body: `أهلاً ${ar('name')}،\n\nمبروك، اتأهلت للإنترفيو التاني لوظيفة ${ar('job')}.\n\nاليوم: ${ar('day')} ${ar('date')}\nالساعة: ${ar('time')}\nالمدة: حوالي ${ar('duration')}\nالمكان: ${ar('place')}\nاللينك: ${ar('link')}\n${ar('notes')}\n\nبرجاء تأكيد الحضور بالرد على الإيميل ده.\n\nمع التحية،\n${ar('sender')}\n${ar('company')}` },
  { id: 'b_final', kind: 'final', lang: 'ar', name: 'دعوة إنترفيو نهائي', subject: `الإنترفيو النهائي — ${ar('job')}`, body: `أهلاً ${ar('name')}،\n\nيسعدنا ندعوك للإنترفيو النهائي لوظيفة ${ar('job')}.\n\nاليوم: ${ar('day')} ${ar('date')}\nالساعة: ${ar('time')}\nالمكان: ${ar('place')}\nاللينك: ${ar('link')}\n${ar('notes')}\n\nبرجاء تأكيد الحضور بالرد على الإيميل ده.\n\nمع التحية،\n${ar('sender')}\n${ar('company')}` },
  { id: 'b_task', kind: 'task', lang: 'ar', name: 'التاسك', subject: `تاسك عملي — ${ar('job')}`, body: `أهلاً ${ar('name')}،\n\nكخطوة جاية في التقديم على وظيفة ${ar('job')}، محتاجين منك تعمل تاسك عملي صغير.\n\nالتاسك وتفاصيله والتسليم كله من اللينك ده:\n${ar('link')}\n\nآخر معاد للتسليم: ${ar('deadline')}\n${ar('notes')}\n\nبالتوفيق،\n${ar('sender')}\n${ar('company')}` },
  { id: 'b_offer', kind: 'offer', lang: 'ar', name: 'عرض عمل', subject: `عرض عمل — ${ar('job')}`, body: `أهلاً ${ar('name')}،\n\nيسعدنا نعرض عليك الانضمام لـ ${ar('company')} في وظيفة ${ar('job')}.\n\nالراتب الشهري: ${ar('salary')}\nتاريخ البداية: ${ar('start')}\n${ar('notes')}\n\nبرجاء الرد بالموافقة أو أي استفسار.\n\nمع التحية،\n${ar('sender')}\n${ar('company')}` },
  { id: 'b_reject', kind: 'reject', lang: 'ar', name: 'اعتذار', subject: `بخصوص طلبك لوظيفة ${ar('job')}`, body: `أهلاً ${ar('name')}،\n\nشكراً على وقتك واهتمامك بوظيفة ${ar('job')}. بعد المراجعة، قررنا نكمّل مع مرشحين تانيين مناسبين أكتر لاحتياجات الوظيفة دلوقتي.\n\nهنحتفظ ببياناتك، وهنتواصل معاك لو فيه فرصة مناسبة قريب.\n\nمع التمنيات بالتوفيق،\n${ar('sender')}\n${ar('company')}` },
  { id: 'b_hr_en', kind: 'hr', lang: 'en', name: 'Interview invitation (EN)', subject: `Interview invitation — {Job}`, body: `Dear {Name},\n\nThank you for applying for the {Job} position. We would like to invite you to an interview.\n\nDay: {Day} {Date}\nTime: {Time}\nDuration: about {Duration}\nPlace: {Place}\nLink: {Link}\n{Notes}\n\nPlease confirm by replying to this email.\n\nBest regards,\n{My_name}\n{Company}` },
  { id: 'b_reject_en', kind: 'reject', lang: 'en', name: 'Regret (EN)', subject: `Your application for {Job}`, body: `Dear {Name},\n\nThank you for your time and interest in the {Job} position. After careful review, we have decided to move forward with other candidates whose profiles better match our current needs.\n\nWe will keep your details on file and reach out if a suitable opportunity comes up.\n\nBest wishes,\n{My_name}\n{Company}` }
];
export const TEMPLATE_KINDS = [['received', 'وصلنا طلبك', 'Application received'], ['phone', 'مكالمة تليفون', 'Phone call'], ['hr', 'إنترفيو أول', 'First interview'], ['tech', 'إنترفيو تاني', 'Second interview'], ['final', 'إنترفيو نهائي', 'Final interview'], ['task', 'تاسك', 'Task'], ['offer', 'عرض عمل', 'Offer'], ['reject', 'اعتذار', 'Regret'], ['other', 'تاني', 'Other']];
export const watchTemplates = (cb) => watch(col('email_templates'), saved => {
  const map = new Map(BUILTIN_TEMPLATES.map(t => [t.id, { ...t, builtin: true }]));
  saved.forEach(t => { if (t.deleted) map.delete(t.id); else map.set(t.id, { ...(map.get(t.id) || {}), ...t }); });
  cb([...map.values()]);
}, () => cb(BUILTIN_TEMPLATES.map(t => ({ ...t, builtin: true }))));
export async function saveTemplate(t) {
  const name = clean(t.name, 100);
  if (!name) throw userError('اكتب اسم القالب.', 'Write the template name.');
  const id = t.id || newId();
  await setDoc(doc(db, 'email_templates', id), { name, kind: t.kind || 'other', lang: t.lang === 'en' ? 'en' : 'ar', subject: clean(t.subject, 300), body: clean(t.body, 10000), deleted: false, updatedAt: serverTimestamp() }, { merge: true });
  return id;
}
export const deleteTemplate = (t) => setDoc(doc(db, 'email_templates', t.id), { deleted: true, updatedAt: serverTimestamp() }, { merge: true });
export const resetTemplate = (t) => deleteDoc(doc(db, 'email_templates', t.id));   // a built-in one goes back to the original
/** fill {placeholders} (Arabic or English names); empty ones and lines left with only a label are dropped */
export function fillTemplate(text, vals) {
  let out = String(text || '');
  Object.entries(PH).forEach(([k, [a, e]]) => {
    const v = vals[k] == null ? '' : String(vals[k]);
    out = out.split(`{${a}}`).join(v).split(`{${e}}`).join(v);
  });
  return out.split('\n').filter(line => !/^\s*[^:\n]{1,30}:\s*$/.test(line)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
export const logEmail = (app, subject, body) => addLog(app.id, { type: 'email', subject: clean(subject, 300), text: clean(body, 6000) });
