// Call recordings & transcripts: kept for the admin. Anyone else asks for access (record_requests); once the admin
// approves, their email is added to call_records/{callId}.viewRec / viewTr and they can open it.
import { db, doc, col, read, watch, query, where, orderBy, limit, writeBatch, setDoc, serverTimestamp, arrayUnion, toMs } from '../core/fb.js';
import { session, isAdmin, now } from '../core/session.js';
import { L } from '../core/utils.js';
import { userError } from '../core/ui.js';
import { callService } from './authsvc.js';
import { activePeople, nameOf } from './directory.js';
import { notify, notifyMany } from './notify.js';
import { track } from './activity.js';

export const KIND_LABEL = { rec: () => L('التسجيل', 'the recording'), tr: () => L('المحضر', 'the transcript') };
const admins = () => activePeople().filter(p => p.role === 'admin').map(p => p.email);

/** my requests (to show "waiting" / "approved" on the call in the chat) */
export const watchMyRecRequests = (cb) => watch(query(col('record_requests'), where('by', '==', session.email)), cb, () => cb([]));
/** admin: requests waiting for a decision */
export const watchPendingRecRequests = (cb) => watch(query(col('record_requests'), where('status', '==', 'pending')), rows => cb(rows.sort((a, b) => (b.atMs || 0) - (a.atMs || 0))), () => cb([]));
/** admin: the latest calls with a recording or a transcript */
export const watchAllRecords = (cb) => watch(query(col('call_records'), orderBy('updatedMs', 'desc'), limit(150)), cb, () => cb([]));
/** someone else: the ones shared with me */
export function watchSharedRecords(cb) {
  let a = [], b = [];
  const out = () => { const m = new Map(); [...a, ...b].forEach(r => m.set(r.id, r)); cb([...m.values()].sort((x, y) => (y.updatedMs || 0) - (x.updatedMs || 0))); };
  const u1 = watch(query(col('call_records'), where('viewRec', 'array-contains', session.email)), r => { a = r; out(); }, () => { a = []; out(); });
  const u2 = watch(query(col('call_records'), where('viewTr', 'array-contains', session.email)), r => { b = r; out(); }, () => { b = []; out(); });
  return () => { u1(); u2(); };
}
export const getRecord = (callId) => read('call_records', callId);
export const mayOpen = (record, kind) => isAdmin() || ((record && record[kind === 'tr' ? 'viewTr' : 'viewRec']) || []).includes(session.email);

/** Ask the admin for the recording and/or transcript of a call */
export async function requestAccess({ callId, chatId, title, kinds, reason }) {
  const ks = [...new Set(kinds || [])].filter(k => k === 'rec' || k === 'tr');
  if (!ks.length) throw userError('اختار التسجيل أو المحضر.', 'Choose the recording or the transcript.');
  const r = String(reason || '').trim();
  if (r.length < 3) throw userError('اكتب سبب الطلب.', 'Write why you need it.');
  await setDoc(doc(col('record_requests')), { callId, chatId: chatId || '', title: String(title || '').slice(0, 120), by: session.email, byName: nameOf(session.email), kinds: ks, reason: r.slice(0, 500), status: 'pending', at: serverTimestamp(), atMs: now() });
  notifyMany(admins(), L(`${nameOf(session.email)} بيطلب ${ks.map(k => KIND_LABEL[k]()).join(' و')}`, `${nameOf(session.email)} asks for ${ks.map(k => KIND_LABEL[k]()).join(' and ')}`), `${title || ''} — ${r.slice(0, 100)}`, '#/records', 'request');
  track('record.request', { target: title || callId, detail: ks.join(',') });
}

/** Admin: approve (gives access) or reject */
export async function decideRecRequest(req, approve, note = '') {
  if (!isAdmin()) throw userError('ده للأدمن بس.', 'Admins only.');
  const b = writeBatch(db);
  b.update(doc(db, 'record_requests', req.id), { status: approve ? 'approved' : 'rejected', decidedBy: session.email, decidedAt: serverTimestamp(), note: String(note || '').slice(0, 300) });
  if (approve) {
    const upd = {};
    if (req.kinds.includes('rec')) upd.viewRec = arrayUnion(req.by);
    if (req.kinds.includes('tr')) upd.viewTr = arrayUnion(req.by);
    b.set(doc(db, 'call_records', req.callId), upd, { merge: true });
  }
  await b.commit();
  notify(req.by, approve ? L(`تمت الموافقة: ${req.kinds.map(k => KIND_LABEL[k]()).join(' و')}`, `Approved: ${req.kinds.map(k => KIND_LABEL[k]()).join(' and ')}`) : L('طلبك للتسجيل اترفض', 'Your recording request was rejected'),
    `${req.title || ''}${note ? ' — ' + note : ''}`, approve ? '#/records' : '#/chat', approve ? 'approved' : 'rejected');
  track(approve ? 'record.approve' : 'record.reject', { target: req.byName || req.by, detail: req.title || '' });
}

/** Admin: give / take access without a request */
export async function setAccess(callId, email, kind, on) {
  const field = kind === 'tr' ? 'viewTr' : 'viewRec';
  const cur = (await getRecord(callId)) || {};
  const list = new Set(cur[field] || []);
  if (on) list.add(email); else list.delete(email);
  await setDoc(doc(db, 'call_records', callId), { [field]: [...list] }, { merge: true });
}

// ---- opening (through the Apps Script service, which checks the same access)
const cache = new Map();
export async function loadPart(callId, partId) {
  const k = callId + ':' + partId;
  if (cache.has(k)) return cache.get(k);
  const r = await callService('recGet', { callId, kind: 'rec', id: partId });
  const bin = atob(r.data || ''); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([arr], { type: r.mime || 'video/webm' }));
  cache.set(k, url);
  return url;
}
export async function loadTranscript(callId, rebuild = false) {
  if (rebuild) await callService('trBuild', { callId });
  const r = await callService('recGet', { callId, kind: 'tr' });
  return { name: r.name || 'transcript.txt', text: String(r.text || '').replace(/^﻿/, '') };
}
export const fmtWhen = (ms) => { const d = new Date(Number(ms) || 0); return isNaN(d) ? '' : d.toLocaleString(L('ar-EG', 'en-GB'), { timeZone: 'Africa/Cairo', dateStyle: 'medium', timeStyle: 'short' }); };
export { toMs };
