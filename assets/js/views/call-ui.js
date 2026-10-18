// Voice-call screens: the incoming call (answer / decline, keeps ringing), and the call bar that stays on screen
// on every page while you talk (who is in, who is talking, mute, hang up).
import { L, esc } from '../core/utils.js';
import { avatar, toast, toastErr, modal, STATUS_META } from '../core/ui.js';
import { now } from '../core/session.js';
import { dayKey } from '../core/policy.js';
import { isGroup, ek } from '../services/chat.js';
import { read } from '../core/fb.js';
import { startRecording, stopRecording, isRecording, canRecord, onRecState, transcribing, transcriptBlocked, canTranscribe } from '../services/recording.js';
import { session } from '../core/session.js';
import { person, nameOf, activePeople } from '../services/directory.js';
import { play } from '../core/sounds.js';
import {
  startCall, joinCall, declineCall, hangUp, setMuted, currentCall, onCallState, watchMyCalls, dropStale, isTalking,
  lastEndedCall, fmtDur, RING_FOR, MAX_IN_CALL, touchedHere, addToCall, invitedAtOf, endForAll, myBeatStale,
  callName, guestLink, watchGuests, admitGuest, denyGuest, isGuestEmail, startRoom, canHostRoom,
  shareScreen, stopScreen, canShareScreen, screensNow, MAX_SHARING,
  startCamera, stopCamera, switchCamera, canUseCamera, videoTiles, MAX_CAMS
} from '../services/calls.js';

const nm = (e, c) => callName(c || (currentCall() || {}).call, e);   // employees by profile, guests by the name kept in the call
const who = (e, c) => person(e) || { email: e, name: nm(e, c) };
let live = [];                       // live calls in my chats
const liveSubs = new Set();
export const onLiveCalls = (cb) => { liveSubs.add(cb); return () => liveSubs.delete(cb); };
export const liveCallIn = (chatId) => live.find(c => c.chatId === chatId) || null;
const dismissed = new Set();         // incoming calls I ignored / declined on this device (call id + when I was asked)
const dkey = (c) => `${c.id}:${invitedAtOf(c, session.email)}`;

/** Start a call from a chat (button in the chat header) */
export async function startCallFor(chat) {
  const going = liveCallIn(chat.id);
  try {
    if (going && !(going.joined || []).includes(session.email)) await joinCall(going.id);   // a call is already on: join it
    else if (isGroup(chat)) { const people = await pickCallees(chat); if (people) await startCall(chat, people); }
    else await startCall(chat);
  } catch (e) { toastErr(e); }
}

/** Group call: who to call from the group (only they ring, and only they can join) */
function pickCallees(chat, { exclude = [], max: maxPick = MAX_IN_CALL - 1, adding = false, anyone = false, notes = {} } = {}) {
  const live = (p) => (p && STATUS_META[p.status] && p.status !== 'Offline' && p.dayKey === dayKey(now()) ? p.status : 'Offline');
  const others = (chat.members || []).filter(e => e !== session.email && !exclude.includes(e)).map(who)
    .sort((a, b) => ((!!notes[b.email]) - (!!notes[a.email])) || ((live(b) === 'Online') - (live(a) === 'Online')) || String(a.name || '').localeCompare(String(b.name || ''), 'ar'));
  const max = Math.max(1, maxPick);
  const picked = new Set();
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title: adding ? L('إضافة للمكالمة', 'Add to the call') : L('مكالمة مع مين؟', 'Call whom?'), icon: adding ? 'fa-user-plus' : 'fa-phone', size: 'narrow',
      body: `<p class="small muted mb-8">${adding ? (anyone ? L(`اختار مين تضيفه للمكالمة من الزملاء (لحد ${max}). هيرن عندهم دلوقتي ويقدروا يدخلوا.`, `Pick colleagues to add (up to ${max}). They ring now and can join.`) : L(`اختار من «${chat.name}» مين تضيفه (لحد ${max}). هيرن عندهم دلوقتي ويقدروا يدخلوا.`, `Pick who to add from "${chat.name}" (up to ${max}). They ring now and can join.`)) : L(`اختار من «${chat.name}» اللي هتكلّمهم (لحد ${max}). هيرن عندهم هم بس، وهم بس اللي يقدروا يدخلوا المكالمة.`, `Pick who to call from "${chat.name}" (up to ${max}). Only they ring and only they can join.`)}</p>
        ${others.length > 8 || anyone ? `<div class="search mb-8"><i class="fas fa-search"></i><input class="input" id="cp-q" placeholder="${L('ابحث بالاسم', 'Search by name')}"></div>` : ''}
        <div class="chat-members" id="cp-list" style="max-height:320px"></div>`,
      foot: `<button class="btn" data-close>${L('إلغاء', 'Cancel')}</button><button class="btn btn-ok" id="cp-go" disabled><i class="fas fa-phone"></i> <span>${L('اتصال', 'Call')}</span></button>`,
      onClose: () => { if (!done) resolve(null); }
    });
    const draw = () => {
      const q = ((m.$('#cp-q') || {}).value || '').trim().toLowerCase();
      m.$('#cp-list').innerHTML = others.filter(p => !q || `${p.name} ${p.email}`.toLowerCase().includes(q)).map(p => {
        const st = live(p), meta = STATUS_META[st], on = picked.has(p.email);
        return `<label class="chat-member" style="cursor:pointer"><input type="checkbox" data-p="${esc(p.email)}" ${on ? 'checked' : ''} ${!on && picked.size >= max ? 'disabled' : ''}>${avatar(p, 'sm')}
          <span class="grow min0"><b class="truncate">${esc(p.name || p.email)}</b><small class="truncate ${notes[p.email] ? 'cp-note' : ''}">${esc(notes[p.email] || p.title || '')}</small></span>
          <span class="chat-st ${st.toLowerCase()}" style="--c:${meta.color}"><i class="fas ${meta.icon}"></i>${esc(L(meta.ar, meta.en))}</span></label>`;
      }).join('') || `<p class="muted small" style="padding:10px">${others.length ? L('مفيش نتائج', 'No results') : L('كل اللي في الجروب متدعيين بالفعل', 'Everyone in the group is already invited')}</p>`;
      const go = m.$('#cp-go'); go.disabled = !picked.size;
      go.querySelector('span').textContent = adding ? (picked.size ? L(`إضافة (${picked.size})`, `Add (${picked.size})`) : L('إضافة', 'Add')) : (picked.size ? L(`اتصال (${picked.size})`, `Call (${picked.size})`) : L('اتصال', 'Call'));
    };
    m.$('#cp-list').onchange = (e) => { const c = e.target.closest('[data-p]'); if (!c) return; if (c.checked) picked.add(c.dataset.p); else picked.delete(c.dataset.p); draw(); };
    if (m.$('#cp-q')) m.$('#cp-q').oninput = draw;
    m.$('#cp-go').onclick = () => { done = true; m.close(); resolve([...picked]); };
    draw();
  });
}
export async function joinLive(callId) { try { const c = live.find(x => x.id === callId); if (c) dismissed.add(dkey(c)); hideIncoming(callId); await joinCall(callId); } catch (e) { toastErr(e); } }

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
  const from = who(((c.invitedBy || {})[ek(session.email)]) || c.from);   // whoever added me, else who started it
  const inNames = (c.joined || []).filter(e => e !== session.email).map(e => String(nm(e, c)).split(' ')[0]).join('، ');
  const title = c.room ? L(`${from.name || from.email} بيدعوك لميتنج أونلاين: ${c.chatName}`, `${from.name || from.email} invites you to an online meeting: ${c.chatName}`)
    : c.group && !c.chatName ? L(`${from.name || from.email} بيضيفك لمكالمة`, `${from.name || from.email} adds you to a call`)
    : c.group ? L(`مكالمة جماعية في ${c.chatName}`, `Group call in ${c.chatName}`) : L(`${from.name || from.email} بيكلّمك`, `${from.name || from.email} is calling you`);
  const sub = c.room ? L(`جوّه: ${inNames || '—'}`, `In the call: ${inNames || '—'}`) : c.group && !c.chatName ? L(`جوّه: ${inNames}`, `In the call: ${inNames}`) : c.group ? L(`${from.name || from.email} بدأها · ${(c.joined || []).length} جوّه: ${(c.joined || []).map(e => String(nm(e, c)).split(' ')[0]).join('، ')}`, `Started by ${from.name || from.email} · ${(c.joined || []).length} in`) : L('📞 مكالمة صوتية', '📞 Voice call');
  const el = document.createElement('div');
  el.className = 'ring-pop call-in'; el.setAttribute('role', 'alertdialog');
  el.innerHTML = `<span class="ring-av">${avatar(from)}</span><div class="grow min0"><b class="truncate">${esc(title)}</b><small class="truncate">${esc(sub)}</small></div>
    <button class="btn btn-sm btn-ok" data-a="yes"><i class="fas fa-phone"></i> ${c.group ? L('انضم', 'Join') : L('رد', 'Answer')}</button>
    <button class="btn btn-sm btn-danger" data-a="no" title="${c.group ? L('تجاهل', 'Ignore') : L('رفض', 'Decline')}"><i class="fas fa-phone-slash"></i></button>`;
  el.onclick = async (e) => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    dismissed.add(dkey(c)); hideIncoming(c.id);
    if (b.dataset.a === 'yes') { try { await joinCall(c.id); } catch (ex) { toastErr(ex); } }
    else declineCall(c).catch(() => {});
  };
  ringRoot().prepend(el);
  const x = { el, timer: 0, stop: 0, notif: null };
  const ring = () => { play('ring'); try { navigator.vibrate && navigator.vibrate([400, 200, 400]); } catch {} };
  ring(); x.timer = setInterval(ring, 2600);
  x.stop = setTimeout(() => { dismissed.add(dkey(c)); hideIncoming(c.id); }, Math.max(5000, RING_FOR - (now() - invitedAtOf(c, session.email))));
  if ('Notification' in window && Notification.permission === 'granted' && (document.hidden || !document.hasFocus())) {
    try { x.notif = new Notification(title, { body: L('📞 مكالمة صوتية — اضغط عشان ترد', '📞 Voice call — click to answer'), icon: 'assets/img/icon-192.png', tag: 'call-' + c.id, requireInteraction: true, renotify: true });
      x.notif.onclick = () => { window.focus(); x.notif.close(); }; } catch {}
  }
  incoming.set(c.id, x);
}

// ---------------------------------------------------------------- the call bar
let panel = null, clock = 0, ringback = 0, minimized = false, wasIn = null, endMenu = false;
// guests from outside waiting to be let in
let lobby = { id: '', off: null, rows: [] };
function watchLobby(c) {
  const id = c ? c.id : '';
  if (lobby.id === id) return;
  if (lobby.off) lobby.off();
  lobby = { id, off: null, rows: [] };
  if (!id) return;
  lobby.off = watchGuests(id, rows => {
    const fresh = rows.some(r => !lobby.rows.some(x => x.id === r.id));
    lobby.rows = rows;
    if (fresh) { play('meeting'); if (minimized) minimized = false; }
    drawPanel();
  });
}
function drawPanel() {
  const c = currentCall();
  if (!c) {
    clearInterval(clock); clock = 0; clearInterval(ringback); ringback = 0; endMenu = false; watchLobby(null);
    if (panel) { panel.remove(); panel = null; }
    const end = lastEndedCall();
    if (wasIn && end && end.id === wasIn) {
      const d = end.call || {};
      play('callend');
      const dur = d.startedAt ? fmtDur((now() - d.startedAt) / 1000) : '';
      toast(L('المكالمة خلصت', 'Call ended'), dur ? L(`المدة ${dur}`, `Duration ${dur}`) : (d.outcome === 'declined' ? L('اترفضت', 'Declined') : (end.remoteEnded ? '' : L('محدش ردّ', 'No answer'))), 'info');
    }
    wasIn = null;
    return;
  }
  if (wasIn !== c.id) { wasIn = c.id; play('calljoin'); }
  watchLobby(c);
  const call = c.call || {};
  if (!panel) {
    panel = document.createElement('div'); panel.className = 'call-panel'; panel.setAttribute('role', 'region');
    document.body.appendChild(panel);
    panel.addEventListener('click', (e) => {
      const b = e.target.closest('[data-c]'); if (!b) return;
      const a = b.dataset.c;
      if (a === 'mute') setMuted(!(currentCall() || {}).muted);
      else if (a === 'end') {
        // the one who started a call of several people chooses: end it for everyone, or just leave
        const cc = currentCall(); const k = cc && cc.call;
        if (k && k.from === session.email && k.group && (k.joined || []).some(e => e !== session.email)) { endMenu = !endMenu; drawPanel(); }
        else hangUp();
      }
      else if (a === 'endall') { endMenu = false; endForAll(); }
      else if (a === 'leave') { endMenu = false; hangUp(); }
      else if (a === 'endx') { endMenu = false; drawPanel(); }
      else if (a === 'guest') shareGuestLink();
      else if (a === 'gin' || a === 'gout') {
        const g = lobby.rows.find(x => x.id === b.dataset.g); if (!g) return;
        (a === 'gin' ? admitGuest(g) : denyGuest(g)).then(() => { if (a === 'gin') toast(L(`${g.name} دخل المكالمة`, `${g.name} joined the call`), L('ضيف من برّه', 'Guest from outside'), 'info'); }).catch(toastErr);
      }
      else if (a === 'perm') { try { Notification.requestPermission().then(() => drawPanel()); } catch {} }
      else if (a === 'min') { minimized = !minimized; drawPanel(); }
      else if (a === 'add') addPeople();
      else if (a === 'rec') { (isRecording() ? stopRecording() : startRecording()).catch(toastErr); }
      else if (a === 'share') { const cc = currentCall(); (cc && cc.screen ? stopScreen() : shareScreen()).catch(toastErr); }
      else if (a === 'cam') { const cc = currentCall(); b.disabled = true; (cc && cc.cam ? stopCamera() : startCamera()).catch(toastErr).finally(() => { b.disabled = false; }); }
      else if (a === 'flip') switchCamera().catch(toastErr);
      else if (a === 'chat') location.hash = `#/chat/${encodeURIComponent((currentCall() || {}).call.chatId)}`;
    });
  }
  const me = session.email;
  const others = (call.joined || []).filter(e => e !== me);
  const ringing = !call.startedAt;
  const otherOne = call.group ? null : who((call.members || []).find(e => e !== me));
  const firstNames = (list) => list.map(e => String(nm(e)).split(' ')[0]).join('، ');
  const title = call.group ? (call.chatName || L(`مكالمة مع ${firstNames(others) || '…'}`, `Call with ${firstNames(others) || '…'}`)) : (otherOne.name || otherOne.email);
  const canOpenChat = !call.room && (!call.chatMembers || call.chatMembers.includes(me));
  const STATE = { connecting: L('بيتوصل…', 'connecting…'), unstable: L('الشبكة ضعيفة', 'weak network'), failed: L('مش قادر يتوصل', 'cannot connect'), closed: '' };
  const people = [me, ...others].map(e => {
    const p = c.peers.get(e); const st = e === me ? '' : (p ? (p.state === 'connected' ? '' : STATE[p.state] || '') : STATE.connecting);
    return `<span class="call-person ${isTalking(e) ? 'talking' : ''} ${e === me && c.muted ? 'muted' : ''}" title="${esc(e === me ? L('إنت', 'You') : nm(e))}">${avatar(who(e), 'sm')}${e === me && c.muted ? '<i class="fas fa-microphone-slash"></i>' : ''}${st ? `<small>${esc(st)}</small>` : ''}</span>`;
  }).join('');
  // asked but not in yet (still ringing for them)
  const declined = (e) => Number(((call.declinedAt || {})[ek(e)]) || 0) > invitedAtOf(call, e);
  const waiting = call.group ? (call.members || []).filter(e => e !== me && !others.includes(e) && now() - invitedAtOf(call, e) < RING_FOR + 15000) : [];
  const left = (e) => Number(((call.leftAt || {})[ek(e)]) || 0) > invitedAtOf(call, e);
  const ringingPpl = waiting.map(e => left(e)
    ? `<span class="call-person declined" title="${esc(nm(e))}">${avatar(who(e), 'sm')}<small>${L('خرج', 'left')}</small></span>`
    : declined(e)
    ? `<span class="call-person declined" title="${esc(nm(e))}">${avatar(who(e), 'sm')}<small>${L('اعتذر', 'declined')}</small></span>`
    : (now() - invitedAtOf(call, e) < RING_FOR ? `<span class="call-person waiting" title="${esc(nm(e))}">${avatar(who(e), 'sm')}<small>${L('بيرن…', 'ringing…')}</small></span>` : `<span class="call-person declined" title="${esc(nm(e))}">${avatar(who(e), 'sm')}<small>${L('ما ردّش', 'no answer')}</small></span>`)).join('');
  const perm = 'Notification' in window ? Notification.permission : 'granted';
  const recOther = !!(call.recBy && call.recBy !== me && (call.joined || []).includes(call.recBy));
  const failed = [...c.peers.values()].some(p => p.state === 'failed');
  panel.classList.toggle('min', minimized);
  panel.innerHTML = `
    <div class="call-top"><span class="call-dot ${ringing ? 'ringing' : ''}"></span><div class="grow min0"><b class="truncate">${esc(title || '')}</b>
      <small class="num" id="call-clock">${ringing ? L('بيرن…', 'Ringing…') : fmtDur((now() - call.startedAt) / 1000)}${call.group ? ` · ${others.length + 1}/${MAX_IN_CALL}` : ''}</small></div>
      ${canOpenChat ? `<button class="btn btn-ghost btn-icon btn-sm" data-c="chat" title="${L('الشات', 'Chat')}"><i class="fas fa-comment-dots"></i></button>` : ''}
      <button class="btn btn-ghost btn-icon btn-sm" data-c="min" title="${minimized ? L('كبّر', 'Expand') : L('صغّر', 'Minimize')}"><i class="fas ${minimized ? 'fa-up-right-and-down-left-from-center' : 'fa-down-left-and-up-right-to-center'}"></i></button></div>
    ${lobby.rows.length ? `<div class="call-lobby">${lobby.rows.map(g => `<div class="call-lobby-row"><i class="fas fa-user-clock"></i><span class="grow min0 truncate"><b>${esc(g.name || L('ضيف', 'Guest'))}</b> ${L('(من برّه) عايز يدخل', '(outside) wants to join')}</span>
      <button class="btn btn-sm btn-ok" data-c="gin" data-g="${esc(g.id)}">${L('سماح', 'Let in')}</button><button class="btn btn-sm" data-c="gout" data-g="${esc(g.id)}">${L('رفض', 'Deny')}</button></div>`).join('')}</div>` : ''}
    ${minimized ? '' : `<div class="call-people">${people}${ringingPpl}</div>
      ${failed ? `<div class="call-warn"><i class="fas fa-triangle-exclamation"></i> ${L('الاتصال مش راضي يتوصل — غالباً شبكة الشركة أو النت بيمنعه. جرّب نت تاني.', 'The connection fails — the network probably blocks it. Try another connection.')}</div>` : ''}
      ${call.recBy && (call.joined || []).includes(call.recBy) ? `<div class="call-recon"><span class="rec-dot"></span> ${call.recBy === me ? L('إنت بتسجّل المكالمة', 'You are recording this call') : L(`المكالمة بتتسجّل (${String(nm(call.recBy)).split(' ')[0]})`, `This call is being recorded (${String(nm(call.recBy)).split(' ')[0]})`)}</div>` : ''}
      ${call.startedAt ? `<div class="call-trnote"><i class="fas fa-file-lines"></i> ${!canTranscribe() ? L('متصفحك مش بيدعم التفريغ — كلامك مش هيتكتب في المحضر', 'Your browser cannot transcribe — your words will not be in the transcript') : transcriptBlocked() ? L('التفريغ متوقف: المتصفح منعه', 'Transcript blocked by the browser') : c.muted ? L('التفريغ واقف وإنت قافل المايك', 'Transcript paused while muted') : L('الكلام بيتفرّغ تلقائياً في محضر', 'What is said is transcribed automatically')}</div>` : ''}
      ${c.screen ? `<div class="call-sharing"><i class="fas fa-display"></i> ${L('إنت بتعرض شاشتك', 'You are sharing your screen')} <button class="btn btn-sm" data-c="share">${L('وقف', 'Stop')}</button></div>` : ''}
      ${perm === 'default' ? `<button class="call-hint" data-c="perm"><i class="fas fa-bell"></i> ${L('فعّل إشعارات الويندوز عشان المكالمات توصلك والسيستم في الخلفية', 'Turn on desktop notifications so calls reach you in the background')}</button>` : ''}
      ${perm === 'denied' ? `<div class="call-hint"><i class="fas fa-bell-slash"></i> ${L('إشعارات الويندوز مقفولة للموقع ده — افتحها من علامة القفل جنب العنوان', 'Desktop notifications are blocked for this site — allow them from the lock icon')}</div>` : ''}`}
    ${endMenu ? `<div class="call-endmenu"><button class="btn btn-sm btn-danger" data-c="endall"><i class="fas fa-phone-slash"></i> ${L('إنهاء المكالمة للكل', 'End the call for everyone')}</button><button class="btn btn-sm" data-c="leave"><i class="fas fa-right-from-bracket"></i> ${L('خروج بس', 'Just leave')}</button><button class="btn btn-sm btn-ghost" data-c="endx">${L('رجوع', 'Back')}</button></div>` : ''}
    <div class="call-actions">
      <button class="btn btn-icon call-btn ${c.muted ? 'on' : ''}" data-c="mute" title="${c.muted ? L('افتح المايك', 'Unmute') : L('اقفل المايك', 'Mute')}"><i class="fas ${c.muted ? 'fa-microphone-slash' : 'fa-microphone'}"></i></button>
      ${canRecord() && call.startedAt ? `<button class="btn btn-icon call-btn ${isRecording() ? 'rec-on' : ''}" data-c="rec" title="${isRecording() ? L('وقف التسجيل', 'Stop recording') : L('سجّل المكالمة', 'Record the call')}" ${recOther ? 'disabled' : ''}><i class="fas ${isRecording() ? 'fa-stop' : 'fa-circle'}"></i></button>` : ''}
      ${canUseCamera() && call.startedAt ? `<button class="btn btn-icon call-btn ${c.cam ? 'on' : ''}" data-c="cam" title="${c.cam ? L('اقفل الكاميرا', 'Turn camera off') : L(`افتح الكاميرا (${(call.cams || []).length}/${MAX_CAMS})`, `Turn camera on (${(call.cams || []).length}/${MAX_CAMS})`)}"><i class="fas ${c.cam ? 'fa-video' : 'fa-video-slash'}"></i></button>` : ''}
      ${c.cam && hasTouch ? `<button class="btn btn-icon call-btn" data-c="flip" title="${L('الكاميرا الأمامية / الخلفية', 'Front / back camera')}"><i class="fas fa-camera-rotate"></i></button>` : ''}
      ${canShareScreen() ? `<button class="btn btn-icon call-btn ${c.screen ? 'on' : ''}" data-c="share" title="${c.screen ? L('وقف عرض شاشتك', 'Stop sharing your screen') : L(`اعرض شاشتك (${(call.sharing || []).length}/${MAX_SHARING})`, `Share your screen (${(call.sharing || []).length}/${MAX_SHARING})`)}"><i class="fas ${c.screen ? 'fa-display' : 'fa-desktop'}"></i></button>` : ''}
      ${(call.joined || []).includes(me) ? `<button class="btn btn-icon call-btn" data-c="add" title="${L('إضافة حد للمكالمة', 'Add someone to the call')}"><i class="fas fa-user-plus"></i></button>` : ''}
      ${(call.joined || []).includes(me) && call.startedAt ? `<button class="btn btn-icon call-btn" data-c="guest" title="${L('ضيف من برّه (من غير حساب) — لينك', 'A guest without an account — link')}"><i class="fas fa-link"></i></button>` : ''}
      <button class="btn btn-icon call-btn end" data-c="end" title="${L('إنهاء المكالمة', 'Hang up')}"><i class="fas fa-phone-slash"></i></button>
    </div>`;
  if (!clock) clock = setInterval(() => { const cc = currentCall(); const el = document.getElementById('call-clock'); if (cc && el && cc.call.startedAt) el.textContent = fmtDur((now() - cc.call.startedAt) / 1000) + (cc.call.group ? ` · ${(cc.call.joined || []).length}/${MAX_IN_CALL}` : ''); }, 1000);
  // the caller hears a ring-back tone until someone answers
  if (ringing && call.from === me && !ringback) { play('ringback'); ringback = setInterval(() => { const cc = currentCall(); if (cc && !cc.call.startedAt) play('ringback'); }, 3000); }
  if (!ringing && ringback) { clearInterval(ringback); ringback = 0; }
}

/** Online meeting (admins, project managers, sales): a topic, colleagues if you like, then the link for anyone else */
export function openRoomDialog() {
  if (!canHostRoom()) return;
  const max = MAX_IN_CALL - 1, picked = new Set();
  const m = modal({
    title: L('ميتنج أونلاين', 'Online meeting'), icon: 'fa-video',
    body: `<div class="col gap-12">
      <p class="small muted">${L('مكالمة بتبدأها إنت، وتدعي فيها أي حد: زمايلك من هنا، وأي حد ملوش حساب على السيستم (عميل مثلاً) بلينك هيظهرلك أول ما تبدأ.', 'A call you start and invite anyone to: colleagues from here, and anyone without an account (a client, say) through a link you get right after starting.')}</p>
      <div class="field"><label>${L('موضوع الميتنج', 'Topic')}</label><input class="input" id="rm-t" maxlength="80" placeholder="${L('مثلاً: ميتنج مع عميل شركة كذا', 'e.g. meeting with a client')}"></div>
      <div class="field"><label>${L(`زملاء من السيستم (اختياري — لحد ${max})`, `Colleagues (optional — up to ${max})`)}</label>
        <div class="search mb-8"><i class="fas fa-search"></i><input class="input" id="rm-q" placeholder="${L('ابحث بالاسم', 'Search by name')}"></div>
        <div class="chat-members" id="rm-list" style="max-height:220px"></div></div>
      <div id="rm-err" class="alert bad hidden"></div></div>`,
    foot: `<button class="btn" data-close>${L('إلغاء', 'Cancel')}</button><button class="btn btn-ok" id="rm-go"><i class="fas fa-video"></i> ${L('ابدأ الميتنج', 'Start the meeting')}</button>`
  });
  const draw = () => {
    const q = m.$('#rm-q').value.trim().toLowerCase();
    m.$('#rm-list').innerHTML = activePeople().filter(p => p.email !== session.email && (!q || `${p.name} ${p.title} ${p.department} ${p.email}`.toLowerCase().includes(q)))
      .sort((a, b) => (picked.has(b.email) - picked.has(a.email)) || String(a.name || '').localeCompare(String(b.name || ''), 'ar'))
      .map(p => { const on = picked.has(p.email); return `<label class="chat-member" style="cursor:pointer"><input type="checkbox" data-p="${esc(p.email)}" ${on ? 'checked' : ''} ${!on && picked.size >= max ? 'disabled' : ''}>${avatar(p, 'sm')}<span class="grow min0"><b class="truncate">${esc(p.name || p.email)}</b><small class="truncate">${esc([p.title, p.department].filter(Boolean).join(' · '))}</small></span></label>`; })
      .join('') || `<p class="muted small" style="padding:10px">${L('مفيش نتائج', 'No results')}</p>`;
  };
  m.$('#rm-q').oninput = draw;
  m.$('#rm-list').onchange = (e) => { const c = e.target.closest('[data-p]'); if (!c) return; if (c.checked) picked.add(c.dataset.p); else picked.delete(c.dataset.p); draw(); };
  m.$('#rm-go').onclick = async (e) => {
    const b = e.currentTarget, err = m.$('#rm-err'); err.classList.add('hidden'); b.disabled = true;
    try { await startRoom({ topic: m.$('#rm-t').value, people: [...picked] }); m.close(); shareGuestLink(); }
    catch (ex) { b.disabled = false; if (ex.userMessage) { err.textContent = ex.userMessage; err.classList.remove('hidden'); } else toastErr(ex); }
  };
  draw();
  m.$('#rm-t').focus();
}

/** A link for someone without an account: they open it, write their name, and wait until someone lets them in */
async function shareGuestLink() {
  try {
    const link = await guestLink();
    if (!link) return;
    const msg = L(`ادخل المكالمة من اللينك ده: ${link}`, `Join the call from this link: ${link}`);
    const m = modal({
      title: L('ضيف من برّه', 'A guest from outside'), icon: 'fa-link', size: 'narrow',
      body: `<div class="col gap-12"><p class="small muted">${L('ابعت اللينك ده لأي حد مش عنده حساب على السيستم. بيفتحه من الموبايل أو الكمبيوتر، يكتب اسمه، ويستنى لحد ما حد في المكالمة يدوس «سماح». اللينك شغال طول ما المكالمة دي شغالة بس.', 'Send this link to someone without an account. They open it, write their name and wait until someone in the call presses "Let in". It works only while this call is on.')}</p>
        <input class="input" id="gl-link" readonly dir="ltr" value="${esc(link)}">
        <p class="xs muted">${L('الضيف بيسمع ويتكلم ويشوف الشاشات المعروضة، وكلامه بيدخل في المحضر والتسجيل. مش بيشوف الشات ولا أي حاجة تانية في السيستم.', 'The guest hears, talks and sees shared screens; their words go into the transcript and recording. They see nothing else in the system.')}</p></div>`,
      foot: `<a class="btn" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(msg)}"><i class="fab fa-whatsapp"></i> ${L('واتساب', 'WhatsApp')}</a><button class="btn btn-primary" id="gl-copy"><i class="fas fa-copy"></i> ${L('نسخ اللينك', 'Copy link')}</button>`
    });
    m.$('#gl-link').onclick = (e) => e.target.select();
    m.$('#gl-copy').onclick = async () => { try { await navigator.clipboard.writeText(link); } catch { m.$('#gl-link').select(); document.execCommand && document.execCommand('copy'); } toast(L('اتنسخ', 'Copied'), '', 'info'); };
  } catch (e) { toastErr(e); }
}

/** "Add" in the call bar: pick more people from the group */
async function addPeople() {
  const c = currentCall(); if (!c) return;
  try {
    const chat = c.call.chatId ? await read('chats', c.call.chatId).catch(() => null) : null;   // an online meeting: any colleague
    const fromGroup = !!chat && chat.type === 'group';
    // a group: its members · a 1:1 call (or a call that grew from one): any colleague
    const pool = fromGroup ? { id: c.call.chatId, ...chat } : { id: c.call.chatId, name: '', members: activePeople().map(p => p.email) };
    const k = c.call;
    const after = (m, e) => Number(((m || {})[ek(e)]) || 0) > invitedAtOf(k, e);
    const ringingNow = (k.members || []).filter(e => now() - invitedAtOf(k, e) < RING_FOR && !after(k.declinedAt, e) && !after(k.leftAt, e));
    // someone who declined or left can be asked again
    const notes = {};
    (k.members || []).forEach(e => { if (!(k.joined || []).includes(e) && !ringingNow.includes(e)) notes[e] = Number(((k.declinedAt || {})[ek(e)]) || 0) > invitedAtOf(k, e) ? L('اعتذر — تقدر تكلّمه تاني', 'declined — you can ask again') : L('خرج / ما ردّش — تقدر تكلّمه تاني', 'left / no answer — ask again'); });
    const people = await pickCallees(pool, { exclude: [...new Set([...(k.joined || []), ...ringingNow])], max: MAX_IN_CALL - (k.joined || []).length, adding: true, anyone: !fromGroup, notes });
    if (!people || !people.length) return;
    const n = await addToCall(people);
    if (n) toast(L('اتضافوا وبيرن عندهم', 'Added — ringing now'), people.map(e => nm(e)).join('، '));
  } catch (e) { toastErr(e); }
}

// ---------------------------------------------------------------- the screens being shown (several at once)
let stage = null, focus = '', collapsed = false;
const hasTouch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const tiles = new Map();   // tile key → { el, video, stream }
/** the video stage: shared screens and cameras (mine as a small mirrored preview) */
function drawStage() {
  const list = currentCall() ? videoTiles() : [];
  if (!list.length) { if (stage) { stage.remove(); stage = null; } tiles.clear(); focus = ''; collapsed = false; return; }
  if (!stage) {
    stage = document.createElement('div'); stage.className = 'screen-stage';
    stage.innerHTML = `<div class="screen-head"><i class="fas fa-display" id="ss-icon"></i><b class="grow" id="ss-title"></b>
      <button class="btn btn-ghost btn-icon btn-sm" data-s="full" title="${L('ملء الشاشة', 'Full screen')}"><i class="fas fa-expand"></i></button>
      <button class="btn btn-ghost btn-icon btn-sm" data-s="min" title="${L('صغّر / كبّر', 'Collapse / expand')}"><i class="fas fa-window-minimize"></i></button></div>
      <div class="screen-grid" id="ss-grid"></div>`;
    document.body.appendChild(stage);
    stage.addEventListener('click', (e) => {
      const b = e.target.closest('[data-s]');
      if (b && b.dataset.s === 'min') { collapsed = !collapsed; drawStage(); return; }
      if (b && b.dataset.s === 'full') { const t = focus && tiles.get(focus); const el = t ? t.el : stage; (el.requestFullscreen ? el.requestFullscreen() : Promise.reject()).catch(() => {}); return; }
      const tile = e.target.closest('[data-tile]');
      if (tile) { focus = focus === tile.dataset.tile ? '' : tile.dataset.tile; drawStage(); }
    });
    stage.addEventListener('dblclick', (e) => { const tile = e.target.closest('[data-tile]'); if (tile && tile.requestFullscreen) tile.requestFullscreen().catch(() => {}); });
  }
  const grid = stage.querySelector('#ss-grid');
  const keys = list.map(x => x.key);
  [...tiles.keys()].forEach(k => { if (!keys.includes(k)) { tiles.get(k).el.remove(); tiles.delete(k); } });
  list.forEach((it, i) => {
    let t = tiles.get(it.key);
    const first = String(nm(it.email)).split(' ')[0];
    if (!t) {
      const el = document.createElement('div'); el.className = `screen-tile ${it.kind === 'cam' ? 'cam' : ''} ${it.mine ? 'mine' : ''}`; el.dataset.tile = it.key;
      el.innerHTML = `<video autoplay playsinline muted></video><span class="screen-name">${it.kind === 'screen' ? avatar(who(it.email), 'xs') + ' ' + esc(L(`شاشة ${first}`, `${first}'s screen`)) : esc(it.mine ? L('إنت', 'You') : first)}</span>`;
      t = { el, video: el.querySelector('video'), stream: null };
      tiles.set(it.key, t);
    }
    if (grid.children[i] !== t.el) grid.insertBefore(t.el, grid.children[i] || null);   // screens first, then cameras
    if (t.stream !== it.stream) { t.stream = it.stream; t.video.srcObject = it.stream; t.video.play().catch(() => {}); }
    t.el.classList.toggle('talking', it.kind === 'cam' && isTalking(it.email));
  });
  if (focus && !tiles.has(focus)) focus = '';
  stage.classList.toggle('collapsed', collapsed);
  const screens = list.filter(x => x.kind === 'screen');
  stage.classList.toggle('cams-only', !screens.length);
  // screens: the big layouts · cameras only: an even grid
  grid.className = `screen-grid ${screens.length ? (list.length > 3 ? 'many' : 'n' + list.length) : 'cams c' + Math.min(list.length, 6)} ${focus ? 'focused' : ''}`;
  tiles.forEach((t, k) => t.el.classList.toggle('main', k === focus));
  stage.querySelector('#ss-icon').className = `fas ${screens.length ? 'fa-display' : 'fa-video'}`;
  stage.querySelector('#ss-title').textContent = screens.length > 1 ? L(`${screens.length} شاشات معروضة — اضغط على أي واحدة عشان تكبّرها`, `${screens.length} screens — click one to enlarge`)
    : screens.length ? L(`${String(nm(screens[0].email)).split(' ')[0]} بيعرض شاشته`, `${String(nm(screens[0].email)).split(' ')[0]} is sharing`)
    : L('الكاميرات — اضغط على أي واحدة عشان تكبّرها', 'Cameras — click one to enlarge');
}

// ---------------------------------------------------------------- started once after sign-in
let started = false;
export function startCallWatchers() {
  if (started) return; started = true;
  onCallState(() => { drawPanel(); drawStage(); liveSubs.forEach(cb => cb(live)); });
  onRecState(() => drawPanel());
  watchMyCalls(rows => {
    live = rows;
    const me = session.email, mine = currentCall();
    const ids = new Set(rows.map(r => r.id));
    [...incoming.keys()].forEach(id => { if (!ids.has(id)) hideIncoming(id); });
    rows.forEach(c => {
      if (mine && mine.id === c.id) { hideIncoming(c.id); return; }
      if ((c.joined || []).includes(me)) { if (!mine && !touchedHere(c.id) && myBeatStale(c)) dropStale(c); hideIncoming(c.id); return; }   // I'm in it here or in another tab
      const fresh = now() - invitedAtOf(c, me) < RING_FOR;   // since the call started, or since I was added
      const rings = c.from !== me && fresh && !dismissed.has(dkey(c)) && (c.group || !c.startedAt);
      if (rings) showIncoming(c); else hideIncoming(c.id);
    });
    liveSubs.forEach(cb => cb(live));
  });
}
