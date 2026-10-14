// Voice calls inside the system — free: the audio goes straight between the browsers (WebRTC). Firestore only
// carries the call itself (calls/{id}) and the short connection handshake (calls/{id}/signals), a few writes a call.
// 1:1 and group calls (a group call links everyone with everyone, so it suits up to MAX_IN_CALL people).
// No time limit. Without a TURN relay a few strict networks may not connect; a relay can be added later in
// settings/public.iceServers without code changes.
import { db, doc, col, watch, query, where, updateDoc, setDoc, deleteDoc, runTransaction, serverTimestamp } from '../core/fb.js';
import { session, now } from '../core/session.js';   // now(): server-corrected clock — devices with a wrong clock agree
import { L } from '../core/utils.js';
import { userError } from '../core/ui.js';
import { publicConfig } from './authsvc.js';
import { ek, isGroup, postCallLog } from './chat.js';
import { nameOf } from './directory.js';
import { track } from './activity.js';

export const MAX_IN_CALL = 6;           // people talking at once in a group call
export const MAX_SHARING = 3;           // screens shown at the same time
export const RING_FOR = 45000;          // nobody answered by then → missed
const BEAT_EVERY = 15000, STALE = 50000;  // "still in the call" heartbeat; silent longer than STALE = gone
const STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] }];

const listeners = new Set();
export const onCallState = (cb) => { listeners.add(cb); return () => listeners.delete(cb); };
const emit = () => listeners.forEach(cb => { try { cb(cur); } catch (e) { console.warn(e); } });

/** the call I am in (one at a time) */
let cur = null;
export const currentCall = () => cur;
const touched = new Set();   // calls this page started or joined (so a fresh snapshot is never taken for a left-over)
export const touchedHere = (id) => touched.has(id);

export const isLiveDoc = (c) => !!c && c.live === true && Object.values(c.beat || {}).some(ms => now() - Number(ms || 0) < STALE);
export const fmtDur = (s) => { s = Math.max(0, Math.round(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };

async function iceServers() {
  try { const extra = (await publicConfig()).iceServers; return Array.isArray(extra) && extra.length ? [...STUN, ...extra] : STUN; } catch { return STUN; }
}
async function getMic() {
  if (!navigator.mediaDevices || !window.RTCPeerConnection) throw userError('المتصفح ده مش بيدعم المكالمات. جرّب Chrome أو Edge.', 'This browser does not support calls. Try Chrome or Edge.');
  try { return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }); }
  catch { throw userError('اسمح للموقع يستخدم المايك (من علامة القفل جنب عنوان الموقع) وجرّب تاني.', 'Allow microphone access (lock icon next to the address) and try again.'); }
}

// ---------------------------------------------------------------- start / answer / leave
/** Call the other person of a 1:1 chat, or the people picked from a group (only they ring and can join) */
export async function startCall(chat, people = null) {
  if (cur) throw userError('إنت في مكالمة دلوقتي. اقفلها الأول.', 'You are already in a call. Hang up first.');
  if (!chat || !(chat.members || []).includes(session.email)) throw userError('المحادثة مش متاحة.', 'Conversation not available.');
  let members = chat.members.slice(0, 300);
  if (isGroup(chat)) {
    const picked = [...new Set(people || [])].filter(e => e !== session.email && chat.members.includes(e));
    if (!picked.length) throw userError('اختار مين هتكلّمه من الجروب.', 'Pick who to call from the group.');
    if (picked.length > MAX_IN_CALL - 1) throw userError(`تقدر تختار لحد ${MAX_IN_CALL - 1} أشخاص.`, `You can pick up to ${MAX_IN_CALL - 1} people.`);
    members = [session.email, ...picked];
  }
  const stream = await getMic();
  const ref = doc(col('calls'));
  touched.add(ref.id);
  const me = session.email;
  const data = {
    chatId: chat.id, group: isGroup(chat), chatName: isGroup(chat) ? String(chat.name || '').slice(0, 80) : '',
    from: me, fromName: nameOf(me), members, liveFor: members, joined: [me], ...(isGroup(chat) ? {} : { chatMembers: members.slice() }), beat: { [ek(me)]: now() },
    status: 'ringing', live: true, at: serverTimestamp(), atMs: now(), startedAt: 0
  };
  try { await setDoc(ref, data); } catch (e) { stream.getTracks().forEach(t => t.stop()); throw e; }
  track('call.start', { target: isGroup(chat) ? chat.name : members.filter(m => m !== me).map(nameOf).join(''), detail: isGroup(chat) ? members.filter(m => m !== me).map(nameOf).join('، ') : '' });
  enter(ref.id, { ...data, id: ref.id }, stream, []);
  // nobody answered → missed
  cur.ringTimer = setTimeout(() => { if (cur && cur.id === ref.id && !cur.call.startedAt) hangUp('missed'); }, RING_FOR);
  return ref.id;
}

/** During a call: invite more people (they ring now, and can join). From a group: its members. From a 1:1 call: any
 *  colleague — the call then becomes a call of several people (it no longer ends when one of the two leaves). */
export const MAX_INVITED = 30;
export async function addToCall(people) {
  if (!cur) return 0;
  const id = cur.id;
  let added = [];
  await runTransaction(db, async (tx) => {
    const ref = doc(db, 'calls', id);
    const s = await tx.get(ref); const d = s.exists() ? s.data() : null;
    if (!d || !d.live) throw userError('المكالمة خلصت.', 'The call has ended.');
    if (!(d.joined || []).includes(session.email)) throw userError('ادخل المكالمة الأول.', 'Join the call first.');
    const cs = await tx.get(doc(db, 'chats', d.chatId)); const chat = cs.exists() ? cs.data() : null;
    const fromGroup = !!chat && chat.type === 'group';
    // new people, and people asked before who declined or left (they ring again)
    added = [...new Set((people || []).map(e => String(e || '').toLowerCase()))]
      .filter(e => e && e !== session.email && !(d.joined || []).includes(e) && (!fromGroup || (chat.members || []).includes(e)));
    if (!added.length) return;
    const members = [...(d.members || []), ...added.filter(e => !(d.members || []).includes(e))];
    if (members.length > MAX_INVITED) throw userError(`المكالمة فيها ${MAX_INVITED} مدعوين — ده الحد.`, `The call already has ${MAX_INVITED} invited — that is the limit.`);
    const invitedAt = { ...(d.invitedAt || {}) }, invitedBy = { ...(d.invitedBy || {}) };
    added.forEach(e => { invitedAt[ek(e)] = now(); invitedBy[ek(e)] = session.email; });
    const grows = members.length > (d.members || []).length;
    tx.update(ref, { invitedAt, invitedBy, ...(grows ? { members, liveFor: members } : {}), ...(d.group || !grows ? {} : { group: true }) });
  });
  if (added.length) track('call.add', { target: cur.call.chatName || '', detail: added.map(nameOf).join('، ') });
  return added.length;
}
/** When this person was asked to the call (the call start, or when they were added) */
export const invitedAtOf = (c, email) => Number(((c && c.invitedAt) || {})[ek(email)] || (c && c.atMs) || 0);

/** Answer / join a call */
export async function joinCall(callId) {
  if (cur && cur.id === callId) return;
  if (cur) await hangUp();
  const stream = await getMic();
  const me = session.email;
  touched.add(callId);
  let before = [], call = null;
  try {
    await runTransaction(db, async (tx) => {
      const ref = doc(db, 'calls', callId);
      const s = await tx.get(ref);
      const c = s.exists() ? s.data() : null;
      if (!c || !c.live) throw userError('المكالمة خلصت.', 'The call has ended.');
      const beat = { ...(c.beat || {}) };
      const alive = (c.joined || []).filter(e => e !== me && now() - Number(beat[ek(e)] || 0) < STALE);
      if (!alive.length) throw userError('المكالمة خلصت.', 'The call has ended.');
      if (alive.length >= MAX_IN_CALL) throw userError(`المكالمة فيها ${MAX_IN_CALL} أشخاص — ده الحد.`, `The call already has ${MAX_IN_CALL} people — that is the limit.`);
      before = alive;
      beat[ek(me)] = now();
      const upd = { joined: [...alive, me], beat, status: 'active', ...(c.startedAt ? {} : { startedAt: now() }) };
      tx.update(ref, upd);
      call = { ...c, ...upd, id: callId };
    });
  } catch (e) { stream.getTracks().forEach(t => t.stop()); throw e; }
  track('call.join', { target: call.group ? call.chatName : nameOf(call.from) });
  enter(callId, call, stream, before);   // the newcomer calls everyone already in
}

/** Decline a 1:1 call (a group call is just ignored on this device) */
export async function declineCall(call) {
  if (call.group) {   // a call of several people: just say "no" (the one who asked sees it)
    await updateDoc(doc(db, 'calls', call.id), { [`declinedAt.${ek(session.email)}`]: now() }).catch(() => {});
    return;
  }
  let ended = false;
  await runTransaction(db, async (tx) => {
    const ref = doc(db, 'calls', call.id);
    const s = await tx.get(ref); const c = s.exists() ? s.data() : null;
    if (!c || !c.live || c.startedAt) return;
    tx.update(ref, { live: false, liveFor: [], status: 'ended', outcome: 'declined', endedAt: now(), endedBy: session.email });
    ended = true;
  }).catch(e => console.warn('decline', e && e.message));
  if (ended) postCallLog(call.chatId, { id: call.id, outcome: 'declined', dur: 0, group: false }).catch(() => {});
}

/** Leave the call. The last one out (or anyone in a 1:1) ends it and writes the call into the chat. */
export async function hangUp(reason = '') {
  const c = cur; if (!c) return;
  teardown();
  const me = session.email;
  let log = null;
  await runTransaction(db, async (tx) => {
    const ref = doc(db, 'calls', c.id);
    const s = await tx.get(ref); const d = s.exists() ? s.data() : null;
    if (!d || !d.live) return;
    const beat = { ...(d.beat || {}) }; delete beat[ek(me)];
    const left = (d.joined || []).filter(e => e !== me && now() - Number(beat[ek(e)] || 0) < STALE);
    const end = !d.group || !left.length;
    if (end) {
      const outcome = d.startedAt ? 'done' : (reason === 'missed' ? 'missed' : 'cancelled');
      tx.update(ref, { live: false, liveFor: [], status: 'ended', outcome, joined: left, beat, endedAt: now(), endedBy: me });
      log = { id: c.id, outcome: outcome === 'cancelled' ? 'missed' : outcome, dur: d.startedAt ? Math.round((now() - d.startedAt) / 1000) : 0, group: !!d.group, with: d.group ? (d.members || []) : [] };
    } else tx.update(ref, { joined: left, beat, [`leftAt.${ek(me)}`]: now(), sharing: (d.sharing || []).filter(e => e !== me && left.includes(e)) });
  }).catch(e => console.warn('hang up', e && e.message));
  if (log) postCallLog(c.call.chatId, log).catch(e => console.warn('call log', e && e.message));
}

/** The one who started the call ends it for everybody */
export async function endForAll() {
  const c = cur; if (!c) return;
  teardown();
  let log = null;
  await runTransaction(db, async (tx) => {
    const ref = doc(db, 'calls', c.id);
    const s = await tx.get(ref); const d = s.exists() ? s.data() : null;
    if (!d || !d.live) return;
    const outcome = d.startedAt ? 'done' : 'missed';
    tx.update(ref, { live: false, liveFor: [], status: 'ended', outcome, joined: [], endedAt: now(), endedBy: session.email });
    log = { id: c.id, outcome, dur: d.startedAt ? Math.round((now() - d.startedAt) / 1000) : 0, group: !!d.group, with: d.group ? (d.members || []) : [] };
  }).catch(e => console.warn('end for all', e && e.message));
  if (log) postCallLog(c.call.chatId, log).catch(e => console.warn('call log', e && e.message));
}
/** my own heartbeat in that call is old: no page of mine is in it any more (another tab of mine may well be) */
export const myBeatStale = (c) => now() - Number(((c && c.beat) || {})[ek(session.email)] || 0) > STALE;

// ---------------------------------------------------------------- the running call
function enter(id, call, stream, offerTo) {
  cur = { id, call, stream, peers: new Map(), muted: false, enteredAt: now(), unsubs: [], timers: [], ringTimer: 0, meters: new Map(), seen: new Set(), sent: [] };
  const me = session.email;
  // the handshake messages addressed to me
  cur.unsubs.push(watch(query(col(`calls/${id}/signals`), where('to', '==', me)), rows => {
    rows.sort((a, b) => (a.atMs || 0) - (b.atMs || 0)).forEach(sig => {
      if (!cur || cur.id !== id || cur.seen.has(sig.id)) return;
      cur.seen.add(sig.id);
      deleteDoc(doc(db, `calls/${id}/signals`, sig.id)).catch(() => {});
      if ((sig.atMs || 0) < cur.enteredAt - 15000) return;   // from an earlier visit
      onSignal(sig).catch(e => console.warn('signal', e && e.message));
    });
  }));
  // the call itself: who is in, ended?
  cur.unsubs.push(watch(doc(db, 'calls', id), d => {
    if (!cur || cur.id !== id) return;
    if (!d || !d.live) { if (d) cur.call = { ...d, id }; teardown(true); return; }
    cur.call = { ...d, id };
    if (d.startedAt && cur.ringTimer) { clearTimeout(cur.ringTimer); cur.ringTimer = 0; }
    const nShare = (d.sharing || []).length;
    if (cur.screen && nShare !== cur.shareN) cur.peers.forEach(tuneScreen);   // more / fewer screens: adjust the quality
    cur.shareN = nShare;
    const alive = (d.joined || []).filter(e => now() - Number((d.beat || {})[ek(e)] || 0) < STALE);
    [...cur.peers.keys()].forEach(e => { if (!alive.includes(e)) closePeer(e); });   // left / dropped
    if (!d.group && d.startedAt && !alive.some(e => e !== me)) { hangUp(); return; }   // the other side is gone
    emit();
  }));
  // "still here" + dropping people whose device went quiet
  const beat = () => {
    if (!cur || cur.id !== id) return;
    const c = cur.call || {};
    const upd = { [`beat.${ek(me)}`]: now() };
    const dead = (c.joined || []).filter(e => e !== me && now() - Number((c.beat || {})[ek(e)] || 0) > STALE);
    if (dead.length) { upd.joined = (c.joined || []).filter(e => !dead.includes(e)); upd.sharing = (c.sharing || []).filter(e => !dead.includes(e)); }
    updateDoc(doc(db, 'calls', id), upd).catch(() => {});
  };
  cur.timers.push(setInterval(beat, BEAT_EVERY));
  cur.timers.push(setInterval(() => { meterTick(); }, 180));
  // a link that never came up (a lost handshake message, a network hiccup): the side that called tries again
  cur.timers.push(setInterval(() => {
    if (!cur || cur.id !== id) return;
    cur.peers.forEach((p, email) => {
      if (!p.initiator || p.state === 'connected' || p.tries >= 4) return;
      if (now() - Math.max(p.born, p.changed || 0) < (p.state === 'failed' ? 4000 : 12000)) return;
      closePeerOf(cur, email);
      call1(email, p.tries + 1).catch(err => console.warn('re-offer', err && err.message));
    });
  }, 4000));
  addMeter(me, stream);
  offerTo.forEach(e => call1(e).catch(err => console.warn('offer', err && err.message)));
  window.addEventListener('pagehide', onPageHide);
  emit();
}
const onPageHide = () => { if (cur) hangUp(); };

function teardown(remoteEnded = false) {
  const c = cur; if (!c) return;
  cur = null;
  clearTimeout(c.ringTimer);
  c.timers.forEach(clearInterval);
  c.unsubs.forEach(u => { try { u(); } catch {} });
  c.peers.forEach((_, e) => closePeerOf(c, e));
  c.stream.getTracks().forEach(t => t.stop());
  if (c.screen) c.screen.getTracks().forEach(t => t.stop());
  // handshake messages nobody picked up (they left first): don't leave them behind
  setTimeout(() => c.sent.forEach(sid => deleteDoc(doc(db, `calls/${c.id}/signals`, sid)).catch(() => {})), 1500);
  try { c.actx && c.actx.close(); } catch {}
  window.removeEventListener('pagehide', onPageHide);
  lastEnded = { id: c.id, call: c.call, remoteEnded, at: now() };
  emit();
}
let lastEnded = null;
export const lastEndedCall = () => lastEnded;

// ---------------------------------------------------------------- peers (one connection per person)
async function newPeer(email) {
  const pc = new RTCPeerConnection({ iceServers: await iceServers() });
  const audio = document.createElement('audio');
  audio.autoplay = true; audio.setAttribute('playsinline', '');
  (document.getElementById('call-audio') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'call-audio', hidden: true }))).appendChild(audio);
  const p = { pc, audio, state: 'connecting', iceQ: [], iceOut: [], iceTimer: 0, remoteSet: false, born: now(), initiator: false, tries: 0, screen: null };
  cur.stream.getTracks().forEach(t => pc.addTrack(t, cur.stream));
  pc.ontrack = (ev) => {
    if (ev.track.kind === 'video') { p.screen = new MediaStream([ev.track]); ev.track.onunmute = () => emit(); emit(); return; }   // their screen (when they share)
    const st = ev.streams[0] || new MediaStream([ev.track]);
    audio.srcObject = st; audio.play().catch(() => {}); addMeter(email, st);
  };
  pc.onicecandidate = (ev) => {
    if (!ev.candidate) return;
    p.iceOut.push(ev.candidate.toJSON());
    // send the candidates in small batches (fewer Firestore writes)
    if (!p.iceTimer) p.iceTimer = setTimeout(() => { const list = p.iceOut.splice(0); p.iceTimer = 0; if (list.length) send(email, 'ice', list); }, 350);
  };
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    p.changed = now();
    p.state = s === 'connected' ? 'connected' : (s === 'failed' ? 'failed' : (s === 'disconnected' ? 'unstable' : (s === 'closed' ? 'closed' : 'connecting')));
    if (s === 'failed' && cur) { try { pc.restartIce(); } catch {} }
    emit();
  };
  cur.peers.set(email, p);
  emit();
  return p;
}
function closePeerOf(c, email) {
  const p = c.peers.get(email); if (!p) return;
  clearTimeout(p.iceTimer);
  try { p.pc.close(); } catch {}
  try { p.audio.srcObject = null; p.audio.remove(); } catch {}
  c.peers.delete(email); c.meters && c.meters.delete(email);
}
const closePeer = (email) => { if (cur) { closePeerOf(cur, email); emit(); } };

async function send(to, kind, data) {
  if (!cur) return;
  const ref = doc(col(`calls/${cur.id}/signals`));
  cur.sent.push(ref.id);
  await setDoc(ref, { from: session.email, to, kind, data: JSON.stringify(data), atMs: now(), at: serverTimestamp() });
}
/** the video lane of a connection (for screen sharing) */
const videoLane = (p) => p.pc.getTransceivers().find(t => (t.receiver && t.receiver.track && t.receiver.track.kind) === 'video');
async function sendScreenTo(p) {
  const t = videoLane(p); if (!t) return;
  try { await t.sender.replaceTrack(cur && cur.screen ? cur.screen.getVideoTracks()[0] : null); } catch (e) { console.warn('screen', e && e.message); }
  tuneScreen(p);
}
function tuneScreen(p) {
  const t = videoLane(p); if (!t || !t.sender) return;
  // fewer bits each when several screens are on, so nobody's connection chokes
  const n = Math.max(1, ((cur && cur.call && cur.call.sharing) || []).length);
  try { const prm = t.sender.getParameters(); if (!prm.encodings || !prm.encodings.length) prm.encodings = [{}]; prm.encodings[0].maxBitrate = n > 1 ? 650000 : 1200000; prm.encodings[0].maxFramerate = n > 1 ? 10 : 15; t.sender.setParameters(prm).catch(() => {}); } catch {}
}
async function call1(email, tries = 0) {
  const p = await newPeer(email);
  p.initiator = true; p.tries = tries;
  p.pc.addTransceiver('video', { direction: 'sendrecv' });
  if (cur && cur.screen) sendScreenTo(p);
  const offer = await p.pc.createOffer({ offerToReceiveAudio: true });
  await p.pc.setLocalDescription(offer);
  await send(email, 'offer', { type: offer.type, sdp: offer.sdp });
}
async function onSignal(sig) {
  if (!cur) return;
  const from = sig.from; let data;
  try { data = JSON.parse(sig.data || 'null'); } catch { return; }
  if (sig.kind === 'offer') {
    if (cur.peers.has(from)) closePeer(from);   // they reconnected
    const p = await newPeer(from);
    await p.pc.setRemoteDescription(data); p.remoteSet = true;
    const vt = videoLane(p); if (vt) vt.direction = 'sendrecv';   // so I can show my screen to them too, later
    if (cur && cur.screen) await sendScreenTo(p);
    const ans = await p.pc.createAnswer();
    await p.pc.setLocalDescription(ans);
    await send(from, 'answer', { type: ans.type, sdp: ans.sdp });
    flushIce(p);
  } else if (sig.kind === 'answer') {
    const p = cur.peers.get(from); if (!p || p.remoteSet) return;
    await p.pc.setRemoteDescription(data); p.remoteSet = true;
    flushIce(p);
  } else if (sig.kind === 'ice') {
    const p = cur.peers.get(from);
    if (!p) return;
    (Array.isArray(data) ? data : [data]).forEach(c => p.iceQ.push(c));
    if (p.remoteSet) flushIce(p);
  }
}
function flushIce(p) { p.iceQ.splice(0).forEach(c => p.pc.addIceCandidate(c).catch(() => {})); }

// ---------------------------------------------------------------- mute + who is talking
// ---------------------------------------------------------------- screen sharing (up to MAX_SHARING at once)
export const canShareScreen = () => !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
export async function shareScreen() {
  if (!cur) return;
  if (!canShareScreen()) throw userError('عرض الشاشة متاح من الكمبيوتر بس (Chrome / Edge / Firefox).', 'Screen sharing works from a computer only (Chrome / Edge / Firefox).');
  if (cur.screen) return;
  const sharing = cur.call.sharing || [];
  if (sharing.length >= MAX_SHARING) throw userError(`فيه ${MAX_SHARING} بيعرضوا شاشتهم دلوقتي — ده الحد.`, `${MAX_SHARING} people are sharing already — that is the limit.`);
  let screen;
  try { screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false }); }
  catch { return; }   // the person closed the picker
  const track = screen.getVideoTracks()[0];
  try { track.contentHint = 'detail'; } catch {}
  const id = cur.id, me = session.email;
  try {
    await runTransaction(db, async (tx) => {
      const ref = doc(db, 'calls', id);
      const s = await tx.get(ref); const d = s.exists() ? s.data() : null;
      if (!d || !d.live) throw userError('المكالمة خلصت.', 'The call has ended.');
      const list = (d.sharing || []).filter(e => e !== me && (d.joined || []).includes(e));
      if (list.length >= MAX_SHARING) throw userError(`فيه ${MAX_SHARING} بيعرضوا شاشتهم دلوقتي — ده الحد.`, `${MAX_SHARING} people are sharing already — that is the limit.`);
      tx.update(ref, { sharing: [...list, me] });
    });
  } catch (e) { screen.getTracks().forEach(t => t.stop()); throw e; }
  if (!cur || cur.id !== id) { screen.getTracks().forEach(t => t.stop()); return; }
  cur.screen = screen;
  track.onended = () => stopScreen();   // the browser's own "Stop sharing" bar
  await Promise.all([...cur.peers.values()].map(sendScreenTo));
  track_('call.share');
  emit();
}
export async function stopScreen() {
  if (!cur || !cur.screen) return;
  const screen = cur.screen, id = cur.id, me = session.email;
  cur.screen = null;
  screen.getTracks().forEach(t => { t.onended = null; t.stop(); });
  await Promise.all([...cur.peers.values()].map(sendScreenTo));
  await runTransaction(db, async (tx) => {
    const ref = doc(db, 'calls', id);
    const s = await tx.get(ref); const d = s.exists() ? s.data() : null;
    if (!d || !d.live) return;
    tx.update(ref, { sharing: (d.sharing || []).filter(e => e !== me) });
  }).catch(() => {});
  emit();
}
const track_ = (a) => { try { track(a, { target: (cur && cur.call && (cur.call.chatName || '')) || '' }); } catch {} };
/** the screens shown right now (not mine): [{ email, stream }] */
export function screensNow() {
  if (!cur) return [];
  const on = (cur.call && cur.call.sharing) || [];
  return on.filter(e => e !== session.email).map(e => ({ email: e, stream: (cur.peers.get(e) || {}).screen || null })).filter(x => x.stream);
}

export function setMuted(on) {
  if (!cur) return;
  cur.muted = !!on;
  cur.stream.getAudioTracks().forEach(t => { t.enabled = !cur.muted; });
  emit();
}
function addMeter(email, stream) {
  try {
    if (!cur.actx) { const A = window.AudioContext || window.webkitAudioContext; if (!A) return; cur.actx = new A(); }
    const src = cur.actx.createMediaStreamSource(stream);
    const an = cur.actx.createAnalyser(); an.fftSize = 512;
    src.connect(an);
    cur.meters.set(email, { an, buf: new Uint8Array(an.fftSize), level: 0 });
  } catch {}
}
function meterTick() {
  if (!cur || !cur.meters) return;
  let changed = false;
  cur.meters.forEach((m, email) => {
    m.an.getByteTimeDomainData(m.buf);
    let sum = 0; for (let i = 0; i < m.buf.length; i += 4) { const v = (m.buf[i] - 128) / 128; sum += v * v; }
    const talking = Math.sqrt(sum / (m.buf.length / 4)) > 0.04 && !(email === session.email && cur.muted);
    if (talking !== m.talking) { m.talking = talking; changed = true; }
  });
  if (changed) emit();
}
export const isTalking = (email) => !!(cur && cur.meters && cur.meters.get(email) && cur.meters.get(email).talking);

// ---------------------------------------------------------------- calls that concern me
/** Live calls in my chats (ringing or going on) */
export const watchMyCalls = (cb) => watch(query(col('calls'), where('liveFor', 'array-contains', session.email)),   // one array filter: no composite index needed
  
  rows => { rows.filter(r => r.live && !isLiveDoc(r)).forEach(endZombie); cb(rows.filter(isLiveDoc)); }, () => cb([]));
/** A call whose people all went quiet (closed tabs, crashes): close it so it stops showing */
const zombies = new Set();
function endZombie(c) {
  if (zombies.has(c.id) || now() - (c.atMs || 0) < STALE) return;
  zombies.add(c.id);
  runTransaction(db, async (tx) => {
    const ref = doc(db, 'calls', c.id);
    const s = await tx.get(ref); const d = s.exists() ? s.data() : null;
    if (!d || !d.live || Object.values(d.beat || {}).some(ms => now() - Number(ms || 0) < 2 * STALE)) return;   // be sure: quiet for a good while
    tx.update(ref, { live: false, liveFor: [], status: 'ended', outcome: d.startedAt ? 'done' : 'missed', endedAt: now(), endedBy: session.email });
  }).catch(() => {});
}
/** Remove me from a call I was in before this page loaded (a reload or a crash) */
export async function dropStale(call) {
  const me = session.email;
  await runTransaction(db, async (tx) => {
    const ref = doc(db, 'calls', call.id);
    const s = await tx.get(ref); const d = s.exists() ? s.data() : null;
    if (!d || !d.live || !(d.joined || []).includes(me)) return;
    const beat = { ...(d.beat || {}) }; delete beat[ek(me)];
    const left = (d.joined || []).filter(e => e !== me);
    if (!d.group || !left.length) tx.update(ref, { live: false, liveFor: [], status: 'ended', outcome: d.startedAt ? 'done' : 'missed', joined: left, beat, endedAt: now(), endedBy: me });
    else tx.update(ref, { joined: left, beat, [`leftAt.${ek(me)}`]: now(), sharing: (d.sharing || []).filter(e => e !== me && left.includes(e)) });
  }).catch(() => {});
}
