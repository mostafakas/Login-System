// A take-home task sent to a candidate: task.html#t=<secret>. The candidate opens it (no account — signed in
// anonymously on a separate app instance), reads it, downloads the attached files, writes the answer / adds links /
// uploads files, and hands it in before the deadline. The first opening claims the link for that browser.
import { auth, signInAnonymously, db, doc, getDoc, updateDoc, watch, serverTimestamp, toMs } from './core/fb.js';
import { session, syncClock, now } from './core/session.js';
import { L, esc, isAr, setLang } from './core/utils.js';
import { uploadFile, openFile } from './services/recruit.js';

const box = document.getElementById('g');
const taskId = new URLSearchParams(location.hash.slice(1)).get('t') || '';
const langBtn = document.getElementById('pub-lang');
langBtn.textContent = isAr ? 'English' : 'عربي';
langBtn.onclick = () => setLang(isAr ? 'en' : 'ar');
const card = (h) => { box.innerHTML = `<div class="card guest-card"><div class="card-body">${h}</div></div>`; };
const msg = (icon, title, text = '', cls = '') => card(`<div class="guest-msg ${cls}"><i class="fas ${icon}"></i><h2>${esc(title)}</h2>${text ? `<p class="muted">${esc(text)}</p>` : ''}</div>`);
const fmtWhen = (ms) => new Date(ms).toLocaleString(L('ar-EG', 'en-GB'), { timeZone: 'Africa/Cairo', weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });
const left = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return d ? L(`${d} يوم و${h} ساعة`, `${d}d ${h}h`) : `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`; };
const GRACE = 10 * 60000;
let t = null, ticker = 0, drawn = '', saveT = 0, dirty = false;

async function start() {
  if (!taskId) { msg('fa-link-slash', L('اللينك ده ناقص', 'This link is incomplete')); return; }
  try { await signInAnonymously(auth); }
  catch (e) { console.warn(e); msg('fa-triangle-exclamation', L('الصفحة مش شغالة دلوقتي', 'This page is not available right now'), L('جرّب تاني بعد شوية.', 'Please try again later.')); return; }
  session.user = auth.currentUser;
  await syncClock().catch(() => {});
  watch(doc(db, 'cand_tasks', taskId), (d) => { t = d; draw(); }, () => msg('fa-link-slash', L('اللينك ده مش شغال', 'This link does not work')));
}

function draw() {
  if (!t) { msg('fa-link-slash', L('اللينك ده مش شغال', 'This link does not work'), L('يمكن التاسك اتلغى. كلّم فريق الموارد البشرية.', 'The task may have been cancelled. Contact our HR team.')); return; }
  const me = auth.currentUser.uid;
  if (t.status === 'sent') return intro();
  if (t.uid !== me) { msg('fa-lock', L('التاسك ده اتفتح من جهاز تاني', 'This task was opened on another device'), L('لو ده إنت، كمّل من نفس الجهاز والمتصفح اللي فتحته منهم، أو اطلب من الـ HR يفتحهولك تاني.', 'If that was you, continue on the same device and browser, or ask HR to reopen it.')); return; }
  if (t.status === 'submitted' || t.status === 'graded') return handedIn();
  if (now() > (t.deadlineMs || 0) + GRACE) { msg('fa-hourglass-end', L('معاد التسليم خلص', 'The deadline has passed'), L('للأسف الوقت خلص قبل ما التاسك يتسلّم. كلّم فريق الموارد البشرية لو محتاج حاجة.', 'Time ran out before the task was handed in. Contact our HR team if you need anything.')); return; }
  working();
}

function intro() {
  const when = t.hours ? L(`عندك ${t.hours} ساعة من أول ما تدوس «ابدأ».`, `You have ${t.hours} hours from when you press "Start".`) : L(`آخر معاد للتسليم: ${fmtWhen(t.dueMs)}`, `Deadline: ${fmtWhen(t.dueMs)}`);
  if (!t.hours && now() > t.dueMs) { msg('fa-hourglass-end', L('معاد التسليم خلص', 'The deadline has passed')); return; }
  card(`<div class="xs muted">${L('تاسك عملي', 'Take-home task')} · ${esc(t.jobTitle || '')}</div>
    <h1 class="pub-title">${esc(t.title)}</h1>
    <p class="mt-8">${L(`أهلاً ${esc(String(t.name || '').split(' ')[0])}،`, `Hi ${esc(String(t.name || '').split(' ')[0])},`)}</p>
    <div class="alert info mt-16"><i class="fas fa-clock"></i><div><b>${esc(when)}</b><div class="xs mt-4">${L('افتح التاسك وكمّل فيه من نفس الجهاز والمتصفح. اللي بتكتبه بيتحفظ لوحده لحد ما تسلّم.', 'Open and work on it from the same device and browser. What you write is saved as you go until you hand it in.')}</div></div></div>
    <button class="btn btn-primary btn-lg mt-16" id="tgo" style="width:100%"><i class="fas fa-play"></i> ${L('ابدأ التاسك', 'Start the task')}</button>`);
  box.querySelector('#tgo').onclick = async (e) => {
    e.currentTarget.disabled = true;
    try { await updateDoc(doc(db, 'cand_tasks', taskId), { uid: auth.currentUser.uid, status: 'opened', openedAt: serverTimestamp(), deadlineMs: t.hours ? now() + t.hours * 3600000 : t.dueMs }); }
    catch (ex) { console.warn(ex); msg('fa-triangle-exclamation', L('مش قادر أفتح التاسك', 'Could not open the task'), L('جرّب تاني، ولو المشكلة فضلت كلّم الـ HR.', 'Try again; if it keeps happening, contact HR.')); }
  };
}

const fileRow = (f, i, kind) => `<div class="pub-file"><i class="fas fa-file"></i><span class="grow truncate">${esc(f.name)}</span>${kind === 'att' ? `<button class="btn btn-sm" data-dl="${i}"><i class="fas fa-download"></i> ${L('تنزيل', 'Download')}</button>` : `<button class="btn btn-sm btn-ghost" data-rm="${i}" title="${L('شيل', 'Remove')}"><i class="fas fa-xmark"></i></button>`}</div>`;
function working() {
  const sig = `w:${t.status}:${(t.subFiles || []).length}:${(t.links || []).length}`;
  if (drawn === sig) return;   // don't redraw under the candidate's typing
  const first = !drawn.startsWith('w:');
  drawn = sig;
  const answerNow = first ? (t.answer || '') : (box.querySelector('#ta') || {}).value ?? t.answer ?? '';
  card(`<div class="row between gap-8 wrap"><div class="xs muted">${L('تاسك عملي', 'Take-home task')} · ${esc(t.jobTitle || '')}</div><div class="pub-timer" id="tt"></div></div>
    <h1 class="pub-title">${esc(t.title)}</h1>
    <div class="pub-desc mt-8">${esc(t.body || '').replace(/\n/g, '<br>')}</div>
    ${(t.files || []).length ? `<h3 class="pub-h">${L('ملفات التاسك', 'Task files')}</h3><div class="col gap-8">${t.files.map((f, i) => fileRow(f, i, 'att')).join('')}</div>` : ''}
    <hr class="divider">
    <h2 class="guest-h">${L('التسليم', 'Your submission')}</h2>
    <div class="field"><label>${L('إجابتك / شرح الحل', 'Your answer / explanation')}</label><textarea class="textarea" id="ta" rows="8" maxlength="20000">${esc(answerNow)}</textarea><div class="xs muted mt-4" id="tsv"></div></div>
    <div class="field mt-8"><label>${L('روابط (GitHub، Figma، Drive…)', 'Links (GitHub, Figma, Drive…)')}</label>
      <div class="col gap-8" id="tl">${(t.links || []).map((u, i) => `<div class="pub-file"><i class="fas fa-link"></i><a class="grow truncate" href="${esc(u)}" target="_blank" rel="noopener" dir="ltr">${esc(u)}</a><button class="btn btn-sm btn-ghost" data-rl="${i}"><i class="fas fa-xmark"></i></button></div>`).join('')}</div>
      ${(t.links || []).length < 10 ? `<div class="row gap-8 mt-8"><input class="input grow" id="tli" type="url" dir="ltr" placeholder="https://"><button class="btn" id="tla"><i class="fas fa-plus"></i> ${L('أضف', 'Add')}</button></div>` : ''}</div>
    <div class="field mt-8"><label>${L('ملفات', 'Files')}</label>
      <div class="col gap-8">${(t.subFiles || []).map((f, i) => fileRow(f, i, 'sub')).join('')}</div>
      ${(t.subFiles || []).length < 10 ? `<label class="dropzone pub-drop mt-8"><input type="file" hidden id="tf"><i class="fas fa-file-arrow-up"></i> <span>${L('ارفع ملف (لحد 5 ميجا)', 'Upload a file (up to 5 MB)')}</span></label>` : ''}</div>
    <div id="te" class="alert bad hidden mt-8"></div>
    <button class="btn btn-primary btn-lg mt-16" id="tsub" style="width:100%"><i class="fas fa-paper-plane"></i> ${L('سلّم التاسك', 'Hand in the task')}</button>
    <p class="xs muted mt-8 center">${L('بعد التسليم مش هتقدر تعدّل.', 'You cannot edit after handing in.')}</p>`);
  const ta = box.querySelector('#ta'), sv = box.querySelector('#tsv'), err = box.querySelector('#te');
  const save = async () => { if (!dirty) return; dirty = false; try { await updateDoc(doc(db, 'cand_tasks', taskId), { answer: ta.value, links: t.links || [], subFiles: t.subFiles || [], savedAt: serverTimestamp() }); sv.textContent = L('اتحفظ', 'Saved') + ' ' + new Date().toLocaleTimeString(L('ar-EG', 'en-GB'), { hour: 'numeric', minute: '2-digit' }); } catch { dirty = true; sv.textContent = L('ما اتحفظش — هيحاول تاني', 'Not saved — retrying'); } };
  ta.oninput = () => { dirty = true; clearTimeout(saveT); saveT = setTimeout(save, 2500); };
  ta.onblur = save;
  const patch = async (data) => { try { await updateDoc(doc(db, 'cand_tasks', taskId), { answer: ta.value, links: t.links || [], subFiles: t.subFiles || [], ...data, savedAt: serverTimestamp() }); } catch (ex) { err.textContent = ex.userMessage || L('ما اتحفظش، جرّب تاني.', 'Not saved, try again.'); err.classList.remove('hidden'); } };
  const la = box.querySelector('#tla');
  if (la) la.onclick = () => { const u = box.querySelector('#tli').value.trim(); if (!/^https?:\/\/\S+$/.test(u)) { err.textContent = L('اكتب رابط صحيح يبدأ بـ https://', 'Enter a valid link starting with https://'); err.classList.remove('hidden'); return; } err.classList.add('hidden'); patch({ links: [...(t.links || []), u.slice(0, 500)] }); };
  box.querySelector('#tl').onclick = (e) => { const b = e.target.closest('[data-rl]'); if (b) patch({ links: (t.links || []).filter((_, i) => i !== Number(b.dataset.rl)) }); };
  const tf = box.querySelector('#tf');
  if (tf) tf.onchange = async () => {
    const fl = tf.files && tf.files[0]; if (!fl) return;
    const span = tf.parentElement.querySelector('span'); span.textContent = L('بيرفع…', 'Uploading…'); err.classList.add('hidden');
    try { const up = await uploadFile('task', taskId, fl); await patch({ subFiles: [...(t.subFiles || []), up] }); }
    catch (ex) { span.textContent = L('ارفع ملف (لحد 5 ميجا)', 'Upload a file (up to 5 MB)'); err.textContent = ex.userMessage || L('الملف ما اترفعش، جرّب تاني.', 'The file was not uploaded, try again.'); err.classList.remove('hidden'); }
  };
  box.onclick = async (e) => {
    const dl = e.target.closest('[data-dl]');
    if (dl) { const f = t.files[Number(dl.dataset.dl)]; dl.disabled = true; try { const url = await openFile(f, 'task', taskId); const a = document.createElement('a'); a.href = url; a.download = f.name; a.click(); } catch (ex) { err.textContent = ex.userMessage || L('مش قادر أنزّل الملف.', 'Could not download the file.'); err.classList.remove('hidden'); } dl.disabled = false; return; }
    const rm = e.target.closest('[data-rm]');
    if (rm) patch({ subFiles: (t.subFiles || []).filter((_, i) => i !== Number(rm.dataset.rm)) });
  };
  box.querySelector('#tsub').onclick = async (e) => {
    const b = e.currentTarget;
    if (!ta.value.trim() && !(t.links || []).length && !(t.subFiles || []).length) { err.textContent = L('اكتب إجابتك أو أضف رابط أو ملف الأول.', 'Write your answer or add a link or file first.'); err.classList.remove('hidden'); return; }
    if (!confirm(L('تسلّم التاسك دلوقتي؟ بعد التسليم مش هتقدر تعدّل.', 'Hand in the task now? You cannot edit afterwards.'))) return;
    b.disabled = true; clearTimeout(saveT);
    try { await updateDoc(doc(db, 'cand_tasks', taskId), { answer: ta.value, links: t.links || [], subFiles: t.subFiles || [], status: 'submitted', submittedAt: serverTimestamp() }); }
    catch (ex) { b.disabled = false; err.textContent = L('ما اتسلّمش — يمكن الوقت خلص. جرّب تاني أو كلّم الـ HR.', 'Not handed in — time may be up. Try again or contact HR.'); err.classList.remove('hidden'); }
  };
  clearInterval(ticker);
  const tick = () => {
    const el = box.querySelector('#tt'); if (!el || !t) return;
    const ms = (t.deadlineMs || 0) - now();
    el.innerHTML = ms > 0 ? `<i class="fas fa-hourglass-half"></i> ${L('باقي', 'Left')} <b class="num">${esc(left(ms))}</b>` : `<i class="fas fa-hourglass-end"></i> ${L('الوقت خلص — سلّم دلوقتي', 'Time is up — hand in now')}`;
    el.classList.toggle('late', ms < 3600000);
    if (ms < -GRACE) { clearInterval(ticker); drawn = ''; draw(); }
  };
  tick(); ticker = setInterval(tick, 1000);
}

function handedIn() {
  clearInterval(ticker); drawn = 'done';
  msg('fa-circle-check', L('التاسك اتسلّم', 'Task handed in'), L(`شكراً! اتسلّم ${t.submittedAt ? fmtWhen(toMs(t.submittedAt)) : ''}. فريق الموارد البشرية هيراجعه ويتواصل معاك.`, `Thank you! Handed in ${t.submittedAt ? fmtWhen(toMs(t.submittedAt)) : ''}. Our HR team will review it and get back to you.`), 'ok');
}
window.addEventListener('beforeunload', () => { if (dirty) { try { updateDoc(doc(db, 'cand_tasks', taskId), { answer: (box.querySelector('#ta') || {}).value || '', savedAt: serverTimestamp() }); } catch {} } });
start();
