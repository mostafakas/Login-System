// The public apply page: apply.html#j=<jobId>&s=<source>. Anyone opens it (no account — signed in anonymously on a
// separate app instance), reads the job, answers its questions and attaches the CV / files. The application lands in
// HR's recruitment section as "New". One application per phone number per job.
import { auth, signInAnonymously, db, doc, getDoc, setDoc, updateDoc, serverTimestamp } from './core/fb.js';
import { L, esc, isAr, setLang } from './core/utils.js';
import { BUILTIN, LEVELS, JOB_TYPES, pick, phoneKey, uploadFile } from './services/recruit.js';

const box = document.getElementById('g');
const params = new URLSearchParams(location.hash.slice(1));
const jobId = params.get('j') || '';
const source = (params.get('s') || 'website').replace(/[^a-z]/g, '').slice(0, 20) || 'website';
const langBtn = document.getElementById('pub-lang');
langBtn.textContent = isAr ? 'English' : 'عربي';
langBtn.onclick = () => setLang(isAr ? 'en' : 'ar');

const card = (h) => { box.innerHTML = `<div class="card guest-card"><div class="card-body">${h}</div></div>`; };
const msg = (icon, title, text = '', cls = '') => card(`<div class="guest-msg ${cls}"><i class="fas ${icon}"></i><h2>${esc(title)}</h2>${text ? `<p class="muted">${esc(text)}</p>` : ''}</div>`);
const lines = (t) => String(t || '').split('\n').map(x => x.replace(/^[-•*\s]+/, '').trim()).filter(Boolean);

async function start() {
  if (!jobId) { msg('fa-link-slash', L('اللينك ده ناقص', 'This link is incomplete')); return; }
  try { await signInAnonymously(auth); }
  catch (e) { console.warn(e); msg('fa-triangle-exclamation', L('الصفحة مش شغالة دلوقتي', 'This page is not available right now'), L('جرّب تاني بعد شوية.', 'Please try again later.')); return; }
  let job = null;
  try { const s = await getDoc(doc(db, 'job_posts', jobId)); job = s.exists() ? s.data() : null; } catch { job = null; }
  if (!job || !job.open) { msg('fa-door-closed', L('التقديم على الوظيفة دي اتقفل', 'Applications for this job are closed'), L('شكراً لاهتمامك. تابع إعلاناتنا للوظايف الجاية.', 'Thank you for your interest. Follow our posts for future openings.')); return; }
  document.title = `${job.title} | AL MASTER`;
  render(job);
}

const BI = Object.fromEntries(BUILTIN.map(b => [b[0], L(b[1], b[2])]));
function fieldHtml(q) {
  const req = q.required ? ' *' : '', id = `q_${q.id}`;
  const help = q.help ? `<div class="xs muted mt-4">${esc(q.help)}</div>` : '';
  const lab = `<label for="${id}">${esc(q.label)}${req}</label>`;
  switch (q.type) {
    case 'long': return `<div class="field span-2">${lab}<textarea class="textarea" id="${id}" data-q="${esc(q.id)}" maxlength="4000" rows="4"></textarea>${help}</div>`;
    case 'number': return `<div class="field">${lab}<input class="input num" type="number" inputmode="decimal" id="${id}" data-q="${esc(q.id)}">${help}</div>`;
    case 'date': return `<div class="field">${lab}<input class="input" type="date" id="${id}" data-q="${esc(q.id)}">${help}</div>`;
    case 'link': return `<div class="field">${lab}<input class="input" type="url" dir="ltr" placeholder="https://" id="${id}" data-q="${esc(q.id)}" maxlength="400">${help}</div>`;
    case 'yesno': return `<div class="field">${lab}<div class="pub-opts" data-q="${esc(q.id)}" data-type="yesno">
        <label class="pub-opt"><input type="radio" name="${id}" value="yes"> ${L('نعم', 'Yes')}</label><label class="pub-opt"><input type="radio" name="${id}" value="no"> ${L('لا', 'No')}</label></div>${help}</div>`;
    case 'choice': return `<div class="field span-2">${lab}<div class="pub-opts" data-q="${esc(q.id)}" data-type="choice">${(q.options || []).map(o => `<label class="pub-opt"><input type="radio" name="${id}" value="${esc(o)}"> ${esc(o)}</label>`).join('')}</div>${help}</div>`;
    case 'multi': return `<div class="field span-2">${lab}<div class="pub-opts" data-q="${esc(q.id)}" data-type="multi">${(q.options || []).map(o => `<label class="pub-opt"><input type="checkbox" value="${esc(o)}"> ${esc(o)}</label>`).join('')}</div>${help}</div>`;
    case 'file': return `<div class="field span-2">${lab}<label class="dropzone pub-drop"><input type="file" hidden data-file="${esc(q.id)}"><i class="fas fa-paperclip"></i> <span>${L('اختار ملف (لحد 5 ميجا)', 'Choose a file (up to 5 MB)')}</span></label>${help}</div>`;
    default: return `<div class="field">${lab}<input class="input" id="${id}" data-q="${esc(q.id)}" maxlength="400">${help}</div>`;
  }
}

function render(job) {
  const chips = [job.department, pick(JOB_TYPES, job.type), pick(LEVELS, job.level), job.location].filter(Boolean);
  const must = lines(job.must), nice = lines(job.nice);
  const f = job.fields || [];
  const builtinHtml = f.map(k => {
    if (k === 'years') return `<div class="field"><label>${esc(BI.years)}</label><input class="input num" type="number" min="0" max="60" step="0.5" name="years" inputmode="decimal"></div>`;
    if (k === 'salary') return `<div class="field"><label>${esc(BI.salary)}</label><input class="input num" type="number" min="0" name="salary" inputmode="numeric"></div>`;
    if (k === 'available') return `<div class="field"><label>${esc(BI.available)}</label><input class="input" name="available" maxlength="60" placeholder="${L('مثلاً: فوراً / بعد أسبوعين', 'e.g. immediately / in 2 weeks')}"></div>`;
    if (k === 'linkedin' || k === 'portfolio') return `<div class="field"><label>${esc(BI[k])}</label><input class="input" type="url" dir="ltr" name="${k}" maxlength="300" placeholder="https://"></div>`;
    return `<div class="field"><label>${esc(BI[k])}</label><input class="input" name="${k}" maxlength="100"></div>`;
  }).join('');
  card(`<div class="pub-job">
      <div class="xs muted">${L('وظيفة متاحة', 'Open position')}${job.company ? ' · ' + esc(job.company) : ''}</div>
      <h1 class="pub-title">${esc(job.title)}</h1>
      ${chips.length ? `<div class="row gap-8 wrap mt-8">${chips.map(c => `<span class="chip">${esc(c)}</span>`).join('')}</div>` : ''}
      ${job.description ? `<div class="pub-desc mt-16">${esc(job.description).replace(/\n/g, '<br>')}</div>` : ''}
      ${must.length ? `<h3 class="pub-h">${L('المطلوب', 'Requirements')}</h3><ul class="pub-list">${must.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${nice.length ? `<h3 class="pub-h">${L('ميزة إضافية', 'Nice to have')}</h3><ul class="pub-list">${nice.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    </div>
    <hr class="divider">
    <form id="af" class="col gap-16" novalidate autocomplete="on">
      <h2 class="guest-h">${L('قدّم دلوقتي', 'Apply now')}</h2>
      <div class="form-grid">
        <div class="field"><label>${L('الاسم بالكامل', 'Full name')} *</label><input class="input" name="name" required maxlength="100" autocomplete="name"></div>
        <div class="field"><label>${L('رقم الموبايل', 'Mobile number')} *</label><input class="input" name="phone" required maxlength="30" dir="ltr" inputmode="tel" autocomplete="tel" placeholder="01xxxxxxxxx"></div>
        <div class="field"><label>${L('الإيميل', 'Email')} *</label><input class="input" name="email" type="email" required maxlength="120" dir="ltr" autocomplete="email"></div>
        ${builtinHtml}
        ${(job.questions || []).map(fieldHtml).join('')}
        ${job.cvRequired !== false ? `<div class="field span-2"><label>${L('الـ CV', 'Your CV')} *</label><label class="dropzone pub-drop"><input type="file" hidden data-file="cv" accept=".pdf,.doc,.docx,.png,.jpg,.jpeg"><i class="fas fa-file-arrow-up"></i> <span>${L('ارفع الـ CV (PDF أو Word — لحد 5 ميجا)', 'Upload your CV (PDF or Word — up to 5 MB)')}</span></label></div>` : ''}
        <input type="text" name="website2" tabindex="-1" autocomplete="off" class="pub-hp" aria-hidden="true">
      </div>
      <p class="xs muted"><i class="fas fa-lock"></i> ${L('بياناتك بتوصل لفريق الموارد البشرية بس، وبتستخدم في التوظيف.', 'Your details go to our HR team only and are used for hiring.')}</p>
      <div id="ae" class="alert bad hidden"></div>
      <button class="btn btn-primary btn-lg" id="ago" type="submit" style="width:100%"><i class="fas fa-paper-plane"></i> ${L('ابعت التقديم', 'Submit application')}</button>
    </form>`);
  const form = box.querySelector('#af'), err = box.querySelector('#ae'), go = box.querySelector('#ago');
  const files = {};
  box.querySelectorAll('[data-file]').forEach(inp => {
    inp.onchange = () => {
      const fl = inp.files && inp.files[0]; if (!fl) return;
      const span = inp.parentElement.querySelector('span');
      if (fl.size > 5 * 1024 * 1024) { span.textContent = L('الملف أكبر من 5 ميجا — اختار ملف أصغر', 'Larger than 5 MB — choose a smaller file'); inp.value = ''; delete files[inp.dataset.file]; inp.parentElement.classList.remove('on'); return; }
      files[inp.dataset.file] = fl; span.textContent = fl.name; inp.parentElement.classList.add('on');
    };
  });
  const fail = (t, el) => { err.textContent = t; err.classList.remove('hidden'); (el || err).scrollIntoView({ behavior: 'smooth', block: 'center' }); if (el && el.focus) el.focus(); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    err.classList.add('hidden');
    if (form.website2.value) { msg('fa-circle-check', L('وصلنا تقديمك', 'Application received')); return; }   // a bot filled the hidden field
    const v = (n) => (form.elements[n] ? String(form.elements[n].value || '').trim() : '');
    if (v('name').length < 2) return fail(L('اكتب اسمك بالكامل.', 'Write your full name.'), form.name);
    const pk = phoneKey(v('phone'));
    if (pk.length < 8 || pk.length > 15) return fail(L('اكتب رقم موبايل صحيح.', 'Write a valid mobile number.'), form.phone);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v('email'))) return fail(L('اكتب إيميل صحيح.', 'Write a valid email.'), form.email);
    const answers = {};
    for (const q of job.questions || []) {
      let val = '';
      if (q.type === 'file') { if (q.required && !files[q.id]) return fail(L(`ارفع ملف: ${q.label}`, `Attach a file: ${q.label}`)); continue; }
      if (q.type === 'yesno' || q.type === 'choice') { const c = box.querySelector(`[data-q="${CSS.escape(q.id)}"] input:checked`); val = c ? c.value : ''; }
      else if (q.type === 'multi') val = [...box.querySelectorAll(`[data-q="${CSS.escape(q.id)}"] input:checked`)].map(c => c.value);
      else { const el = box.querySelector(`[data-q="${CSS.escape(q.id)}"]`); val = el ? String(el.value || '').trim() : ''; if (q.type === 'number' && val !== '') val = Number(val); }
      const empty = val === '' || (Array.isArray(val) && !val.length);
      if (q.required && empty) return fail(L(`جاوب على: ${q.label}`, `Please answer: ${q.label}`), box.querySelector(`[data-q="${CSS.escape(q.id)}"]`));
      if (!empty) answers[q.id] = val;
    }
    if (job.cvRequired !== false && !files.cv) return fail(L('ارفع الـ CV.', 'Upload your CV.'));
    const id = `${jobId}_${pk}`;
    const ref = doc(db, 'applications', id);
    go.disabled = true; go.innerHTML = `<span class="spinner" style="width:18px;height:18px;border-width:2px"></span> ${L('بيبعت…', 'Sending…')}`;
    const reset = () => { go.disabled = false; go.innerHTML = `<i class="fas fa-paper-plane"></i> ${L('ابعت التقديم', 'Submit application')}`; };
    try {
      // my own unfinished try (a reload after a failed upload) carries on; someone else's application is not readable
      let mine = null;
      try { const s = await getDoc(ref); mine = s.exists() ? s.data() : null; }
      catch { reset(); return fail(L('فيه تقديم على الوظيفة دي بنفس رقم الموبايل ده بالفعل.', 'There is already an application for this job with this mobile number.')); }
      if (mine && mine.status !== 'draft') { reset(); return fail(L('إنت قدّمت على الوظيفة دي قبل كده.', 'You have already applied for this job.')); }
      if (!mine) {
        const num = (n) => (v(n) === '' ? '' : Number(v(n)));
        await setDoc(ref, {
          jobId, jobTitle: job.title, name: v('name'), phone: v('phone'), phoneKey: pk, email: v('email').toLowerCase(), city: v('city'), currentTitle: v('currentTitle'),
          years: num('years'), salary: num('salary'), available: v('available'), linkedin: v('linkedin'), portfolio: v('portfolio'),
          answers, files: {}, source, stage: 'new', status: 'draft', uid: auth.currentUser.uid, seen: false, score: null, lang: isAr ? 'ar' : 'en',
          createdAt: serverTimestamp(), createdMs: Date.now(), updatedAt: serverTimestamp()
        });
      }
      // the files: one that fails (too big, the service is down…) never loses the application — HR sees what's missing
      const up = {}, missing = [];
      const keys = Object.keys(files);
      for (let i = 0; i < keys.length; i++) {
        go.innerHTML = `<span class="spinner" style="width:18px;height:18px;border-width:2px"></span> ${L(`بيرفع الملفات (${i + 1}/${keys.length})…`, `Uploading files (${i + 1}/${keys.length})…`)}`;
        try { up[keys[i]] = await uploadFile('app', id, files[keys[i]]); }
        catch (ex) {
          if (ex && ex.code === 'too-large') { reset(); return fail(ex.userMessage || L('الملف أكبر من 5 ميجا.', 'The file is larger than 5 MB.')); }
          try { up[keys[i]] = await uploadFile('app', id, files[keys[i]]); }   // once more
          catch (ex2) { console.warn('upload', ex2); missing.push(String(files[keys[i]].name || keys[i]).slice(0, 120)); }
        }
      }
      await updateDoc(ref, { files: up, status: 'active', submittedAt: serverTimestamp(), updatedAt: serverTimestamp(), ...(missing.length ? { missingFiles: missing } : {}) });
      msg('fa-circle-check', L(`وصلنا تقديمك يا ${v('name').split(' ')[0]}`, `Thank you, ${v('name').split(' ')[0]} — application received`),
        L('فريق الموارد البشرية هيراجع طلبك، ولو فيه خطوة جاية هنتواصل معاك على الموبايل أو الإيميل.', 'Our HR team will review it and contact you by phone or email about the next step.'), 'ok');
    } catch (ex) {
      console.warn(ex); reset();
      fail(ex.userMessage || L('حصلت مشكلة وإحنا بنبعت التقديم. جرّب تاني.', 'Something went wrong while sending. Please try again.'));
    }
  };
}
start();
