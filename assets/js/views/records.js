// "Recordings & transcripts": the admin sees every recorded / transcribed call and decides the requests;
// everyone else sees the ones the admin opened for them. Also the players used from the chat.
import { L, esc } from '../core/utils.js';
import { modal, toast, toastErr, busy, avatar, empty } from '../core/ui.js';
import { session, isAdmin } from '../core/session.js';
import { nameOf, person } from '../services/directory.js';
import { fmtDur } from '../services/calls.js';
import {
  watchMyRecRequests, watchPendingRecRequests, watchAllRecords, watchSharedRecords, mayOpen, requestAccess, decideRecRequest,
  loadPart, loadTranscript, getRecord, fmtWhen, KIND_LABEL
} from '../services/records.js';

const who = (e) => person(e) || { email: e, name: nameOf(e) };

/** Play a call's recording: its parts one after the other */
export async function openRecording(callId, record = null) {
  const r = record || await getRecord(callId).catch(() => null);
  if (!r || !(r.parts || []).length) { toast(L('مفيش تسجيل للمكالمة دي', 'No recording for this call'), '', 'info'); return; }
  if (!mayOpen(r, 'rec')) { toast(L('محتاج موافقة الأدمن الأول', 'You need the admin\'s approval first'), '', 'info'); return; }
  const parts = (r.parts || []).slice().sort((a, b) => (a.startMs || 0) - (b.startMs || 0) || (a.n || 0) - (b.n || 0));
  const m = modal({
    title: L('تسجيل المكالمة', 'Call recording'), icon: 'fa-circle-play', size: 'wide',
    body: `<div class="rec-player"><div class="rec-meta"><b>${esc(r.title || '')}</b> <span class="muted small">${esc(fmtWhen(r.startedAt || r.atMs))}</span></div>
      <video id="rp-v" controls playsinline style="width:100%;max-height:60vh;background:#000;border-radius:12px"></video>
      <div class="rec-parts" id="rp-parts">${parts.map((p, i) => `<button class="btn btn-sm" data-i="${i}"><i class="fas ${p.video ? 'fa-display' : 'fa-microphone'}"></i> ${L('جزء', 'Part')} ${i + 1} · ${esc(fmtDur((p.durMs || 0) / 1000))}</button>`).join('')}</div>
      <p class="xs muted mt-8" id="rp-st"></p></div>`,
    foot: `<a class="btn" id="rp-dl" download><i class="fas fa-download"></i> ${L('تنزيل الجزء ده', 'Download this part')}</a><button class="btn btn-primary" data-close>${L('قفل', 'Close')}</button>`
  });
  const v = m.$('#rp-v'), st = m.$('#rp-st');
  let idx = 0;
  const play = async (i) => {
    idx = i;
    m.$$('#rp-parts [data-i]').forEach(b => b.classList.toggle('btn-soft', Number(b.dataset.i) === i));
    st.textContent = L('بيحمّل…', 'Loading…');
    try {
      const url = await loadPart(callId, parts[i].id);
      if (!m.el.isConnected) return;
      v.src = url; v.play().catch(() => {}); st.textContent = '';
      const dl = m.$('#rp-dl'); dl.href = url; dl.download = `${r.title || 'call'} - part ${i + 1}.webm`;
      if (parts[i + 1]) loadPart(callId, parts[i + 1].id).catch(() => {});   // ready before it's needed
    } catch (ex) { st.textContent = ''; toastErr(ex); }
  };
  v.onended = () => { if (parts[idx + 1]) play(idx + 1); };
  m.$('#rp-parts').onclick = (e) => { const b = e.target.closest('[data-i]'); if (b) play(Number(b.dataset.i)); };
  play(0);
}

/** Show a call's transcript (with download) */
export async function openTranscript(callId, record = null) {
  const r = record || await getRecord(callId).catch(() => null);
  if (r && !mayOpen(r, 'tr')) { toast(L('محتاج موافقة الأدمن الأول', 'You need the admin\'s approval first'), '', 'info'); return; }
  const m = modal({
    title: L('محضر المكالمة', 'Call transcript'), icon: 'fa-file-lines', size: 'wide',
    body: `<div id="tp-body">${L('بيحمّل…', 'Loading…')}</div>`,
    foot: `${isAdmin() ? `<button class="btn" id="tp-re"><i class="fas fa-rotate"></i> ${L('تحديث', 'Rebuild')}</button>` : ''}<button class="btn" id="tp-dl" disabled><i class="fas fa-download"></i> ${L('تنزيل', 'Download')}</button><button class="btn btn-primary" data-close>${L('قفل', 'Close')}</button>`
  });
  let file = null;
  const show = async (rebuild) => {
    try {
      file = await loadTranscript(callId, rebuild);
      m.$('#tp-body').innerHTML = `<pre class="tr-text">${esc(file.text)}</pre>`;
      m.$('#tp-dl').disabled = false;
    } catch (ex) { m.$('#tp-body').innerHTML = `<p class="muted">${esc(ex.userMessage || ex.message || '')}</p>`; if (isAdmin() && !rebuild && /not-found|مش موجود/.test(String(ex.code || ex.userMessage || ''))) show(true); }
  };
  m.$('#tp-dl').onclick = () => { if (!file) return; const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + file.text], { type: 'text/plain;charset=utf-8' })); a.download = file.name; a.click(); };
  const re = m.$('#tp-re'); if (re) re.onclick = () => busy(re, () => show(true));
  show(false);
}

/** Ask the admin for access */
export function requestModal({ callId, chatId, title, kinds = ['rec', 'tr'] }) {
  const m = modal({
    title: L('طلب الاطلاع', 'Request access'), icon: 'fa-lock', size: 'narrow',
    body: `<div class="col gap-12"><p class="small muted">${L('التسجيلات والمحاضر محفوظة عند الإدارة. ابعت طلب، ولما الأدمن يوافق هتقدر تفتحها.', 'Recordings and transcripts are kept by management. Send a request; once the admin approves you can open it.')}</p>
      ${kinds.map(k => `<label class="row gap-8"><input type="checkbox" data-k="${k}" checked> ${esc(KIND_LABEL[k]())}</label>`).join('')}
      <div class="field"><label>${L('محتاجه ليه؟', 'Why do you need it?')}</label><textarea class="textarea" id="rq-r" maxlength="500" style="min-height:80px"></textarea></div></div>`,
    foot: `<button class="btn" data-close>${L('إلغاء', 'Cancel')}</button><button class="btn btn-primary" id="rq-go"><i class="fas fa-paper-plane"></i> ${L('ابعت الطلب', 'Send request')}</button>`
  });
  m.$('#rq-go').onclick = (e) => busy(e.currentTarget, async () => {
    try {
      await requestAccess({ callId, chatId, title, kinds: m.$$('[data-k]').filter(c => c.checked).map(c => c.dataset.k), reason: m.$('#rq-r').value });
      m.close(); toast(L('اتبعت الطلب للأدمن', 'Request sent to the admin'));
    } catch (ex) { toastErr(ex); }
  });
}

// ---------------------------------------------------------------- the page
export default async function render(root) {
  const admin = isAdmin();
  const unsubs = [];
  let records = [], pending = [], mine = [];
  root.innerHTML = `<div class="col gap-16">
    ${admin ? `<section class="card"><div class="card-head"><h3><i class="fas fa-inbox"></i> ${L('طلبات الاطلاع', 'Access requests')}</h3></div><div class="card-body" id="rq"></div></section>` : ''}
    <section class="card"><div class="card-head"><h3><i class="fas fa-circle-play"></i> ${admin ? L('كل التسجيلات والمحاضر', 'All recordings & transcripts') : L('التسجيلات والمحاضر المتاحة ليك', 'Recordings & transcripts open to you')}</h3></div><div class="card-body" id="list"></div></section>
    ${admin ? '' : `<section class="card"><div class="card-head"><h3><i class="fas fa-paper-plane"></i> ${L('طلباتي', 'My requests')}</h3></div><div class="card-body" id="mine"></div></section>`}
  </div>`;
  const ST = { pending: ['warn', L('مستني', 'Pending')], approved: ['ok', L('اتوافق', 'Approved')], rejected: ['bad', L('اترفض', 'Rejected')] };
  const drawReq = () => {
    const el = root.querySelector('#rq'); if (!el) return;
    el.innerHTML = pending.length ? pending.map(q => `<div class="rec-row"><span>${avatar(who(q.by), 'sm')}</span><div class="grow min0"><b>${esc(q.byName || nameOf(q.by))}</b> <span class="muted small">${L('بيطلب', 'asks for')} ${esc(q.kinds.map(k => KIND_LABEL[k]()).join(' + '))}</span>
      <div class="small truncate">${esc(q.title || '')}</div><div class="xs muted">${esc(q.reason || '')}</div></div>
      <button class="btn btn-sm btn-ok" data-yes="${esc(q.id)}"><i class="fas fa-check"></i> ${L('موافقة', 'Approve')}</button><button class="btn btn-sm" data-no="${esc(q.id)}"><i class="fas fa-xmark"></i> ${L('رفض', 'Reject')}</button></div>`).join('')
      : `<p class="muted small">${L('مفيش طلبات مستنية', 'No pending requests')}</p>`;
  };
  const drawList = () => {
    const el = root.querySelector('#list');
    el.innerHTML = records.length ? records.map(r => {
      const parts = r.parts || [], dur = parts.reduce((s, p) => s + (p.durMs || 0), 0);
      return `<div class="rec-row"><span class="icon-tile"><i class="fas ${parts.some(p => p.video) ? 'fa-display' : 'fa-phone'}"></i></span>
        <div class="grow min0"><b class="truncate">${esc(r.title || '')}</b><div class="xs muted">${esc(fmtWhen(r.startedAt || r.atMs))} · ${esc((r.members || []).map(e => String(nameOf(e)).split(' ')[0]).join('، '))}</div>
        ${admin && ((r.viewRec || []).length || (r.viewTr || []).length) ? `<div class="xs muted">${L('متاح لـ', 'Open to')}: ${esc([...new Set([...(r.viewRec || []), ...(r.viewTr || [])])].map(nameOf).join('، '))}</div>` : ''}</div>
        ${parts.length && mayOpen(r, 'rec') ? `<button class="btn btn-sm" data-play="${esc(r.id)}"><i class="fas fa-circle-play"></i> ${L('التسجيل', 'Recording')} · ${esc(fmtDur(dur / 1000))}</button>` : ''}
        ${r.transcript && mayOpen(r, 'tr') ? `<button class="btn btn-sm" data-tr="${esc(r.id)}"><i class="fas fa-file-lines"></i> ${L('المحضر', 'Transcript')}</button>` : ''}</div>`;
    }).join('') : empty('fa-circle-play', admin ? L('لسه مفيش مكالمات متسجّلة', 'No recorded calls yet') : L('مفيش حاجة متاحة ليك لسه', 'Nothing open to you yet'), admin ? '' : L('من الشات، اطلب تسجيل أو محضر أي مكالمة كنت فيها.', 'From the chat, request a call\'s recording or transcript.'));
  };
  const drawMine = () => {
    const el = root.querySelector('#mine'); if (!el) return;
    el.innerHTML = mine.length ? mine.sort((a, b) => (b.atMs || 0) - (a.atMs || 0)).map(q => { const [c, t] = ST[q.status] || ST.pending; return `<div class="rec-row"><div class="grow min0"><b class="truncate">${esc(q.title || '')}</b><div class="xs muted">${esc(q.kinds.map(k => KIND_LABEL[k]()).join(' + '))} · ${esc(q.reason || '')}</div></div><span class="badge ${c}">${esc(t)}</span></div>`; }).join('')
      : `<p class="muted small">${L('مفيش طلبات', 'No requests')}</p>`;
  };
  root.addEventListener('click', async (e) => {
    const p = e.target.closest('[data-play]'); if (p) { openRecording(p.dataset.play, records.find(r => r.id === p.dataset.play)); return; }
    const t = e.target.closest('[data-tr]'); if (t) { openTranscript(t.dataset.tr, records.find(r => r.id === t.dataset.tr)); return; }
    const y = e.target.closest('[data-yes]'), n = e.target.closest('[data-no]');
    if (y || n) { const q = pending.find(x => x.id === (y || n).dataset[y ? 'yes' : 'no']); if (q) busy(y || n, async () => { try { await decideRecRequest(q, !!y); toast(y ? L('اتوافق — بقى يقدر يفتحه', 'Approved — they can open it now') : L('اترفض', 'Rejected')); } catch (ex) { toastErr(ex); } }); }
  });
  if (admin) {
    unsubs.push(watchPendingRecRequests(rows => { pending = rows; drawReq(); }));
    unsubs.push(watchAllRecords(rows => { records = rows; drawList(); }));
  } else {
    unsubs.push(watchSharedRecords(rows => { records = rows; drawList(); }));
    unsubs.push(watchMyRecRequests(rows => { mine = rows; drawMine(); }));
  }
  drawReq(); drawList(); drawMine();
  return () => unsubs.forEach(f => { try { f(); } catch {} });
}
