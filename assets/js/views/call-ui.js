// Voice-call screens: the incoming call (answer / decline, keeps ringing), and the call bar that stays on screen
// on every page while you talk (who is in, who is talking, mute, hang up).
import { L, esc } from '../core/utils.js';
import { avatar, toast, toastErr } from '../core/ui.js';
import { session } from '../core/session.js';
import { person, nameOf } from '../services/directory.js';
import { play } from '../core/sounds.js';
import {
  startCall, joinCall, declineCall, hangUp, setMuted, currentCall, onCallState, watchMyCalls, dropStale, isTalking,
  lastEndedCall, fmtDur, RING_FOR, MAX_IN_CALL, touchedHere
} from '../services/calls.js';

const who = (e) => person(e) || { email: e, name: nameOf(e) };
let live = [];                       // live calls in my chats
const liveSubs = new Set();
export const onLiveCalls = (cb) => { liveSubs.add(cb); return () => liveSubs.delete(cb); };
export const liveCallIn = (chatId) => live.find(c => c.chatId === chatId) || null;
const dismissed = new Set();         // incoming calls I ignored / declined on this device

/** Start a call from a chat (button in the chat header) */
export async function startCallFor(chat) {
  const going = liveCallIn(chat.id);
  try {
    if (going && !(going.joined || []).includes(session.email)) await joinCall(going.id);   // a call is already on: join it
    else await startCall(chat);
  } catch (e) { toastErr(e); }
}
export async function joinLive(callId) { try { dismissed.add(callId); hideIncoming(callId); await joinCall(callId); } catch (e) { toastErr(e); } }

// ---------------------------------------------------------------- incoming
const incoming = new Map();          // callId → { el, timer, notif }
function ringRoot() {
  let r = document.querySelector('.ring-pops');
  if (!r) { r = document.createElement('div'); r.className = 'ring-pops'; document.body.appendChild(r); }
  return r;
}
function hideIncoming(id) {
  const x = incoming.get(id); if (!x) return;
  incoming.delete(id);
  clearInterval(x.timer); clearTimeout(x.stop);
  try { x.notif && x.notif.close(); } catch {}
  x.el.classList.add('out'); setTimeout(() => x.el.remove(), 250);
}
function showIncoming(c) {
  if (incoming.has(c.id)) return;
  const from = who(c.from);
  const title = c.group ? L(`مكالمة جماعية في ${c.chatName}`, `Group call in ${c.chatName}`) : L(`${from.name || from.email} بيكلّمك`, `${from.name || from.email} is calling you`);
  const sub = c.group ? L(`${from.name || from.email} بدأها · ${(c.joined || []).length} جوّه`, `Started by ${from.name || from.email} · ${(c.joined || []).length} in`) : L('📞 مكالمة صوتية', '📞 Voice call');
  const el = document.createElement('div');
  el.className = 'ring-pop call-in'; el.setAttribute('role', 'alertdialog');
  el.innerHTML = `<span class="ring-av">${avatar(from)}</span><div class="grow min0"><b class="truncate">${esc(title)}</b><small class="truncate">${esc(sub)}</small></div>
    <button class="btn btn-sm btn-ok" data-a="yes"><i class="fas fa-phone"></i> ${c.group ? L('انضم', 'Join') : L('رد', 'Answer')}</button>
    <button class="btn btn-sm btn-danger" data-a="no" title="${c.group ? L('تجاهل', 'Ignore') : L('رفض', 'Decline')}"><i class="fas fa-phone-slash"></i></button>`;
  el.onclick = async (e) => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    dismissed.add(c.id); hideIncoming(c.id);
    if (b.dataset.a === 'yes') { try { await joinCall(c.id); } catch (ex) { toastErr(ex); } }
    else declineCall(c).catch(() => {});
  };
  ringRoot().prepend(el);
  const x = { el, timer: 0, stop: 0, notif: null };
  const ring = () => { play('ring'); try { navigator.vibrate && navigator.vibrate([400, 200, 400]); } catch {} };
  ring(); x.timer = setInterval(ring, 2600);
  x.stop = setTimeout(() => { dismissed.add(c.id); hideIncoming(c.id); }, Math.max(5000, RING_FOR - (Date.now() - (c.atMs || Date.now()))));
  if ('Notification' in window && Notification.permission === 'granted' && (document.hidden || !document.hasFocus())) {
    try { x.notif = new Notification(title, { body: L('📞 مكالمة صوتية — اضغط عشان ترد', '📞 Voice call — click to answer'), icon: 'assets/img/icon-192.png', tag: 'call-' + c.id, requireInteraction: true, renotify: true });
      x.notif.onclick = () => { window.focus(); x.notif.close(); }; } catch {}
  }
  incoming.set(c.id, x);
}

// ---------------------------------------------------------------- the call bar
let panel = null, clock = 0, ringback = 0, minimized = false, wasIn = null;
function drawPanel() {
  const c = currentCall();
  if (!c) {
    clearInterval(clock); clock = 0; clearInterval(ringback); ringback = 0;
    if (panel) { panel.remove(); panel = null; }
    const end = lastEndedCall();
    if (wasIn && end && end.id === wasIn) {
      const d = end.call || {};
      play('callend');
      const dur = d.startedAt ? fmtDur((Date.now() - d.startedAt) / 1000) : '';
      toast(L('المكالمة خلصت', 'Call ended'), dur ? L(`المدة ${dur}`, `Duration ${dur}`) : (d.outcome === 'declined' ? L('اترفضت', 'Declined') : (end.remoteEnded ? '' : L('محدش ردّ', 'No answer'))), 'info');
    }
    wasIn = null;
    return;
  }
  if (wasIn !== c.id) { wasIn = c.id; play('calljoin'); }
  const call = c.call || {};
  if (!panel) {
    panel = document.createElement('div'); panel.className = 'call-panel'; panel.setAttribute('role', 'region');
    document.body.appendChild(panel);
    panel.addEventListener('click', (e) => {
      const b = e.target.closest('[data-c]'); if (!b) return;
      const a = b.dataset.c;
      if (a === 'mute') setMuted(!(currentCall() || {}).muted);
      else if (a === 'end') hangUp();
      else if (a === 'min') { minimized = !minimized; drawPanel(); }
      else if (a === 'chat') location.hash = `#/chat/${encodeURIComponent((currentCall() || {}).call.chatId)}`;
    });
  }
  const me = session.email;
  const others = (call.joined || []).filter(e => e !== me);
  const ringing = !call.startedAt;
  const otherOne = call.group ? null : who((call.members || []).find(e => e !== me));
  const title = call.group ? call.chatName : (otherOne.name || otherOne.email);
  const STATE = { connecting: L('بيتوصل…', 'connecting…'), unstable: L('الشبكة ضعيفة', 'weak network'), failed: L('مش قادر يتوصل', 'cannot connect'), closed: '' };
  const people = [me, ...others].map(e => {
    const p = c.peers.get(e); const st = e === me ? '' : (p ? (p.state === 'connected' ? '' : STATE[p.state] || '') : STATE.connecting);
    return `<span class="call-person ${isTalking(e) ? 'talking' : ''} ${e === me && c.muted ? 'muted' : ''}" title="${esc(e === me ? L('إنت', 'You') : nameOf(e))}">${avatar(who(e), 'sm')}${e === me && c.muted ? '<i class="fas fa-microphone-slash"></i>' : ''}${st ? `<small>${esc(st)}</small>` : ''}</span>`;
  }).join('');
  const failed = [...c.peers.values()].some(p => p.state === 'failed');
  panel.classList.toggle('min', minimized);
  panel.innerHTML = `
    <div class="call-top"><span class="call-dot ${ringing ? 'ringing' : ''}"></span><div class="grow min0"><b class="truncate">${esc(title || '')}</b>
      <small class="num" id="call-clock">${ringing ? L('بيرن…', 'Ringing…') : fmtDur((Date.now() - call.startedAt) / 1000)}${call.group ? ` · ${others.length + 1}/${MAX_IN_CALL}` : ''}</small></div>
      <button class="btn btn-ghost btn-icon btn-sm" data-c="chat" title="${L('الشات', 'Chat')}"><i class="fas fa-comment-dots"></i></button>
      <button class="btn btn-ghost btn-icon btn-sm" data-c="min" title="${minimized ? L('كبّر', 'Expand') : L('صغّر', 'Minimize')}"><i class="fas ${minimized ? 'fa-up-right-and-down-left-from-center' : 'fa-down-left-and-up-right-to-center'}"></i></button></div>
    ${minimized ? '' : `<div class="call-people">${people}</div>
      ${failed ? `<div class="call-warn"><i class="fas fa-triangle-exclamation"></i> ${L('الاتصال مش راضي يتوصل — غالباً شبكة الشركة أو النت بيمنعه. جرّب نت تاني.', 'The connection fails — the network probably blocks it. Try another connection.')}</div>` : ''}`}
    <div class="call-actions">
      <button class="btn btn-icon call-btn ${c.muted ? 'on' : ''}" data-c="mute" title="${c.muted ? L('افتح المايك', 'Unmute') : L('اقفل المايك', 'Mute')}"><i class="fas ${c.muted ? 'fa-microphone-slash' : 'fa-microphone'}"></i></button>
      <button class="btn btn-icon call-btn end" data-c="end" title="${L('إنهاء المكالمة', 'Hang up')}"><i class="fas fa-phone-slash"></i></button>
    </div>`;
  if (!clock) clock = setInterval(() => { const cc = currentCall(); const el = document.getElementById('call-clock'); if (cc && el && cc.call.startedAt) el.textContent = fmtDur((Date.now() - cc.call.startedAt) / 1000) + (cc.call.group ? ` · ${(cc.call.joined || []).length}/${MAX_IN_CALL}` : ''); }, 1000);
  // the caller hears a ring-back tone until someone answers
  if (ringing && call.from === me && !ringback) { play('ringback'); ringback = setInterval(() => { const cc = currentCall(); if (cc && !cc.call.startedAt) play('ringback'); }, 3000); }
  if (!ringing && ringback) { clearInterval(ringback); ringback = 0; }
}

// ---------------------------------------------------------------- started once after sign-in
let started = false;
export function startCallWatchers() {
  if (started) return; started = true;
  onCallState(() => { drawPanel(); liveSubs.forEach(cb => cb(live)); });
  watchMyCalls(rows => {
    live = rows;
    const me = session.email, mine = currentCall();
    const ids = new Set(rows.map(r => r.id));
    [...incoming.keys()].forEach(id => { if (!ids.has(id)) hideIncoming(id); });
    rows.forEach(c => {
      if (mine && mine.id === c.id) { hideIncoming(c.id); return; }
      if ((c.joined || []).includes(me)) { if (!mine && !touchedHere(c.id)) dropStale(c); hideIncoming(c.id); return; }   // left over from a reload
      const fresh = Date.now() - (c.atMs || 0) < RING_FOR;
      const rings = c.from !== me && fresh && !dismissed.has(c.id) && (c.group || !c.startedAt);
      if (rings) showIncoming(c); else hideIncoming(c.id);
    });
    liveSubs.forEach(cb => cb(live));
  });
}
