// Call recording and automatic transcript.
//  • Recording: anyone in the call presses ⏺. Their browser mixes every voice (and the screens being shown) into one
//    video and uploads it in parts of a few minutes to the admin's Google Drive (Apps Script "recUp"). Nobody sees it
//    except the admin, and people the admin approves (call_records/{callId}.viewRec).
//  • Transcript: starts by itself in every call. Each person's browser writes down what *they* say (Chrome / Edge
//    speech recognition), so every line carries the right name. The lines go to call_transcripts/{callId}/parts and
//    the Apps Script "trBuild" puts them into one text file when the call ends.
import { db, doc, col, updateDoc, setDoc, serverTimestamp } from '../core/fb.js';
import { session, now } from '../core/session.js';
import { L } from '../core/utils.js';
import { userError } from '../core/ui.js';
import { callService, publicConfig } from './authsvc.js';
import { nameOf } from './directory.js';
import { track } from './activity.js';
import { currentCall, onCallState, audioStreams, screensNow, myScreen, fmtDur } from './calls.js';

const PART_MS = 4 * 60000;          // one uploaded part every 4 minutes (a crash loses at most one part)
const FLUSH_MS = 20000;             // transcript lines are saved every 20 seconds (few Firestore writes)
const subs = new Set();
export const onRecState = (cb) => { subs.add(cb); return () => subs.delete(cb); };
const emit = () => subs.forEach(cb => { try { cb(); } catch {} });

// ================================================================ recording
let rec = null;   // { callId, ctx, dest, canvas, timer, mr, part, partStart, queue, uploading, hadScreen, sources, videos }
export const isRecording = () => !!rec;
export const canRecord = () => !!(window.MediaRecorder && HTMLCanvasElement.prototype.captureStream);
const mimeType = () => ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t)) || '';

export async function startRecording() {
  const c = currentCall();
  if (!c) return;
  if (rec) return;
  if (!canRecord()) throw userError('المتصفح ده مش بيقدر يسجّل. جرّب Chrome أو Edge.', 'This browser cannot record. Try Chrome or Edge.');
  if (!(await publicConfig()).authServiceUrl) throw userError('التسجيل محتاج خدمة Apps Script (الإعدادات ← النظام).', 'Recording needs the Apps Script service (Settings → System).');
  if (c.call.recBy && c.call.recBy !== session.email && (c.call.joined || []).includes(c.call.recBy)) throw userError(`${nameOf(c.call.recBy)} بيسجّل المكالمة بالفعل.`, `${nameOf(c.call.recBy)} is already recording.`);
  const A = window.AudioContext || window.webkitAudioContext;
  const ctx = new A();
  const dest = ctx.createMediaStreamDestination();
  const canvas = Object.assign(document.createElement('canvas'), { width: 1280, height: 720 });
  rec = { callId: c.id, ctx, dest, canvas, g: canvas.getContext('2d'), timer: 0, mr: null, part: 0, partStart: 0, queue: [], uploading: false, hadScreen: false, sources: new Map(), videos: new Map(), stopping: false, startedAt: now() };
  await updateDoc(doc(db, 'calls', c.id), { recBy: session.email, rec: true }).catch(() => {});
  wireAudio(); draw();
  rec.timer = setInterval(() => { wireAudio(); draw(); }, 125);   // 8 frames a second is plenty for screens
  newPart();
  track('call.record', { target: c.call.chatName || '' });
  emit();
}
function wireAudio() {
  if (!rec) return;
  audioStreams().forEach(({ email, stream }) => {
    const id = email + ':' + stream.id;
    if (rec.sources.has(id) || !stream.getAudioTracks().length) return;
    try { const src = rec.ctx.createMediaStreamSource(stream); src.connect(rec.dest); rec.sources.set(id, src); } catch {}
  });
}
function screenVideos() {
  const list = [...screensNow()];
  const mine = myScreen(); if (mine) list.unshift({ email: session.email, stream: mine });
  const keep = new Set();
  const out = list.slice(0, 3).map(({ email, stream }) => {
    keep.add(stream.id);
    let v = rec.videos.get(stream.id);
    if (!v) { v = Object.assign(document.createElement('video'), { muted: true, playsInline: true, autoplay: true }); v.srcObject = stream; v.play().catch(() => {}); rec.videos.set(stream.id, v); }
    return { email, v };
  });
  [...rec.videos.keys()].forEach(k => { if (!keep.has(k)) { const v = rec.videos.get(k); v.srcObject = null; rec.videos.delete(k); } });
  return out;
}
function draw() {
  if (!rec) return;
  const g = rec.g, W = 1280, H = 720, c = currentCall();
  g.fillStyle = '#0b0f2a'; g.fillRect(0, 0, W, H);
  const shots = screenVideos().filter(x => x.v.videoWidth);
  if (shots.length) {
    rec.hadScreen = true;
    const cells = shots.length === 1 ? [[0, 0, W, H]] : shots.length === 2 ? [[0, 0, W / 2, H], [W / 2, 0, W / 2, H]] : [[0, 0, W, H / 2], [0, H / 2, W / 2, H / 2], [W / 2, H / 2, W / 2, H / 2]];
    shots.forEach(({ email, v }, i) => {
      const [x, y, w, h] = cells[i]; const r = Math.min(w / v.videoWidth, h / v.videoHeight);
      const dw = v.videoWidth * r, dh = v.videoHeight * r;
      try { g.drawImage(v, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh); } catch {}
      g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(x + 8, y + h - 34, 220, 26);
      g.fillStyle = '#fff'; g.font = '16px sans-serif'; g.textAlign = 'left'; g.fillText(String(nameOf(email)).slice(0, 26), x + 16, y + h - 15);
    });
  } else {
    // no screen: a quiet card (costs almost nothing in the file)
    g.fillStyle = '#fff'; g.textAlign = 'center';
    g.font = 'bold 40px sans-serif'; g.fillText((c && (c.call.chatName || 'مكالمة صوتية')) || 'مكالمة صوتية', W / 2, H / 2 - 30);
    g.font = '24px sans-serif'; g.fillStyle = '#b8c0ff';
    const names = c ? (c.call.joined || []).map(e => String(nameOf(e)).split(' ')[0]).join('، ') : '';
    g.fillText(names, W / 2, H / 2 + 20);
    g.font = '20px sans-serif'; g.fillStyle = '#7f88c9';
    g.fillText('● REC  ' + fmtDur((now() - rec.startedAt) / 1000), W / 2, H / 2 + 70);
  }
}
function newPart() {
  if (!rec || rec.stopping) return;
  if (!rec.vtrack) rec.vtrack = rec.canvas.captureStream(8).getVideoTracks()[0];
  const stream = new MediaStream([rec.vtrack, ...rec.dest.stream.getAudioTracks()]);
  const mt = mimeType();
  const mr = new MediaRecorder(stream, { ...(mt ? { mimeType: mt } : {}), videoBitsPerSecond: 700000, audioBitsPerSecond: 48000 });
  const chunks = []; const part = ++rec.part; const startMs = now(); const r = rec;
  r.hadScreen = false;   // set by draw() when a screen shows up in this part
  mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  mr.onstop = () => {
    const blob = new Blob(chunks, { type: mr.mimeType || 'video/webm' });
    if (blob.size > 2000) { r.queue.push({ blob, part, startMs, durMs: now() - startMs, video: r.hadScreen }); upload(r); }
    if (rec === r && !r.stopping) newPart();
    else if (r.stopping && !r.uploading && !r.queue.length) finish(r);
  };
  mr.start(10000);
  rec.mr = mr;
  clearTimeout(rec.partTimer);
  rec.partTimer = setTimeout(() => { if (mr.state !== 'inactive') mr.stop(); }, PART_MS);
}
const toB64 = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => { const u = String(fr.result); const i = u.indexOf('base64,'); res(i >= 0 ? u.slice(i + 7) : ''); }; fr.onerror = rej; fr.readAsDataURL(blob); });   // the type itself has a comma (vp8,opus)
async function upload(r) {
  if (r.uploading) return;
  r.uploading = true;
  while (r.queue.length) {
    const it = r.queue[0];
    let ok = false;
    for (let i = 0; i < 3 && !ok; i++) {
      try { await callService('recUp', { callId: r.callId, part: it.part, data: await toB64(it.blob), mime: it.blob.type, startMs: it.startMs, durMs: it.durMs, video: it.video }); ok = true; }
      catch (e) { console.warn('recording upload', e && (e.code || e.message)); await new Promise(res => setTimeout(res, 3000 * (i + 1))); }
    }
    r.queue.shift();
    r.uploaded = (r.uploaded || 0) + (ok ? 1 : 0);
    r.failed = (r.failed || 0) + (ok ? 0 : 1);
    emit();
  }
  r.uploading = false;
  if (r.stopping) finish(r);
}
function finish(r) {
  if (r.done) return; r.done = true;
  try { r.ctx.close(); } catch {}
  try { r.vtrack && r.vtrack.stop(); } catch {}
  r.videos.forEach(v => { v.srcObject = null; });
  lastRec = { failed: r.failed || 0, parts: r.uploaded || 0 };
  emit();
}
let lastRec = null;
export const lastRecording = () => lastRec;
/** stop recording (the last part is uploaded in the background) */
export async function stopRecording() {
  const r = rec; if (!r) return;
  rec = null; r.stopping = true;
  clearInterval(r.timer); clearTimeout(r.partTimer);
  if (r.mr && r.mr.state !== 'inactive') r.mr.stop(); else if (!r.uploading) finish(r);
  const c = currentCall();
  if (c && c.id === r.callId && c.call.recBy === session.email) updateDoc(doc(db, 'calls', r.callId), { recBy: '' }).catch(() => {});
  emit();
}

// ================================================================ automatic transcript
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
export const canTranscribe = () => !!SR;
let tr = null;   // { callId, sr, lines, timer, on }
function trStart(callId) {
  if (!SR || tr) return;
  tr = { callId, sr: null, lines: [], on: true, running: false, flagged: false, fails: 0, pending: '', pendingAt: 0, lastEvent: now() };
  const t = tr;
  t.timer = setInterval(() => flush(t), FLUSH_MS + Math.round(Math.random() * 4000));   // spread out, so the people in a call don't all write at once
  // Chrome's recognizer sometimes goes quiet without ending: give it a fresh start after a long silence
  t.watch = setInterval(() => { if (t.on && t.running && !t.paused && now() - t.lastEvent > 45000) { t.lastEvent = now(); try { t.sr.stop(); } catch {} } }, 10000);
  run(t);
  emit();
}
/** keep a phrase: the final text, or (when the recognizer stopped half-way) what it had heard so far */
function keep(t, text, at) {
  const x = String(text || '').replace(/\s+/g, ' ').trim();
  if (!x) return;
  const last = t.lines[t.lines.length - 1];
  if (last && last.text === x && Math.abs(last.t - at) < 5000) return;   // the same phrase twice (a restart)
  t.lines.push({ t: at || now(), text: x.slice(0, 1000) });
}
/** a fresh recognizer each time: Chrome stops it after silences / every minute or so, and words said in the gap are lost
 *  — so it restarts at once, and whatever was heard but not finished is kept instead of being dropped */
function run(t) {
  if (!t.on || t.running || t.paused || tr !== t) return;
  const sr = new SR();
  sr.lang = 'ar-EG'; sr.continuous = true; sr.interimResults = true; sr.maxAlternatives = 1;
  sr.onresult = (e) => {
    t.lastEvent = now(); t.fails = 0;
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (!t.pendingAt) t.pendingAt = now();                  // when this phrase began (keeps the speakers in order)
      if (r.isFinal) { keep(t, r[0].transcript, t.pendingAt); t.pending = ''; t.pendingAt = 0; }
      else interim += r[0].transcript;
    }
    if (interim.trim()) t.pending = interim;
  };
  sr.onspeechstart = () => { t.lastEvent = now(); };
  sr.onerror = (e) => {
    t.lastEvent = now();
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { t.on = false; t.blocked = true; emit(); return; }
    if (e.error !== 'no-speech' && e.error !== 'aborted') t.fails++;   // silence is normal in a meeting, not a failure
  };
  sr.onend = () => {
    if (t.sr === sr) t.running = false;
    if (t.pending) { keep(t, t.pending, t.pendingAt); t.pending = ''; t.pendingAt = 0; }   // words heard just before it stopped
    if (!t.on) { flush(t); return; }
    setTimeout(() => run(t), t.fails > 8 ? 1500 : 0);    // straight back to listening
  };
  t.sr = sr;
  try { sr.start(); t.running = true; t.lastEvent = now(); } catch { t.running = false; setTimeout(() => run(t), 500); }
}
async function flush(t) {
  if (!t.lines.length) return;
  const lines = t.lines.splice(0);
  try {
    await setDoc(doc(col(`call_transcripts/${t.callId}/parts`)), { by: session.email, name: session.guestName || nameOf(session.email), lines, at: serverTimestamp(), atMs: now() });
    if (!t.flagged) { t.flagged = true; updateDoc(doc(db, 'calls', t.callId), { tr: true }).catch(() => {}); }
  } catch (e) { t.lines.unshift(...lines); console.warn('transcript save', e && e.message); }
}
function trStop() {
  const t = tr; if (!t) return;
  tr = null; t.on = false;
  clearInterval(t.timer); clearInterval(t.watch);
  try { t.sr && t.sr.stop(); } catch {}              // onend keeps the half-heard phrase and saves
  setTimeout(() => { if (t.pending) { keep(t, t.pending, t.pendingAt); t.pending = ''; } flush(t); }, 1500);
  emit();
}
export const transcribing = () => !!(tr && tr.on && !tr.paused);
export const transcriptBlocked = () => !!(tr && tr.blocked);

// follow the call: transcribe while I'm in a call that has started and my mic is on; stop recording when I leave
onCallState(() => {
  const c = currentCall();
  if (!c) { if (rec) stopRecording(); if (tr) trStop(); return; }
  if (rec && rec.callId !== c.id) stopRecording();
  if (tr && tr.callId !== c.id) trStop();
  if (c.call.startedAt && (c.call.joined || []).includes(session.email)) {
    if (!tr) trStart(c.id);
    if (tr) {
      const pause = !!c.muted;
      if (pause !== !!tr.paused) { tr.paused = pause; if (pause) { try { tr.sr && tr.sr.stop(); } catch {} } else run(tr); emit(); }
    }
  }
});

// ================================================================ access: the admin, or people the admin approved
export const REC_KINDS = { rec: L('التسجيل', 'Recording'), tr: L('المحضر', 'Transcript') };
