// Voice-call screens: the incoming call (answer / decline, keeps ringing), and the call bar that stays on screen
// on every page while you talk (who is in, who is talking, mute, hang up).
import { L, esc } from '../core/utils.js';
import { avatar, toast, toastErr, modal, STATUS_META } from '../core/ui.js';
import { now } from '../core/session.js';
import { dayKey } from '../core/policy.js';
import { isGroup, ek } from '../services/chat.js';
import { read } from '../core/fb.js';
import { session } from '../core/session.js';
import { person, nameOf, activePeople } from '../services/directory.js';
import { play } from '../core/sounds.js';
import {
  startCall, joinCall, declineCall, hangUp, setMuted, currentCall, onCallState, watchMyCalls, dropStale, isTalking,
  lastEndedCall, fmtDur, RING_FOR, MAX_IN_CALL, touchedHere, addToCall, invitedAtOf, endForAll, myBeatStale,
  shareScreen, stopScreen, canShareScreen, screensNow, MAX_SHARING
} from '../services/calls.js';

const who = (e) => person(e) || { email: e, name: nameOf(e) };
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
  const inNames = (c.joined || []).filter(e => e !== session.email).map(e => String(nameOf(e)).split(' ')[0]).join('، ');
  const title = c.group && !c.chatName ? L(`${from.name || from.email} بيضيفك لمكالمة`, `${from.name || from.email} adds you to a call`)
    : c.group ? L(`مكالمة جماعية في ${c.chatName}`, `Group call in ${c.chatName}`) : L(`${from.name || from.email} بيكلّمك`, `${from.name || from.email} is calling you`);
  const sub = c.group && !c.chatName ? L(`جوّه: ${inNames}`, `In the call: ${inNames}`) : c.group ? L(`${from.name || from.email} بدأها · ${(c.joined || []).length} جوّه: ${(c.joined || []).map(e => String(nameOf(e)).split(' ')[0]).join('، ')}`, `Started by ${from.name || from.email} · ${(c.joined || []).length} in`) : L('📞 مكالمة صوتية', '📞 Voice call');
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
function drawPanel() {
  const c = currentCall();
  if (!c) {
    clearInterval(clock); clock = 0; clearInterval(ringback); ringback = 0; endMenu = false;
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
      else if (a === 'perm') { try { Notification.requestPermission().then(() => drawPanel()); } catch {} }
      else if (a === 'min') { minimized = !minimized; drawPanel(); }
      else if (a === 'add') addPeople();
      else if (a === 'share') { const cc = currentCall(); (cc && cc.screen ? stopScreen() : shareScreen()).catch(toastErr); }
      else if (a === 'chat') location.hash = `#/chat/${encodeURIComponent((currentCall() || {}).call.chatId)}`;
    });
  }
  const me = session.email;
  const others = (call.joined || []).filter(e => e !== me);
  const ringing = !call.startedAt;
  const otherOne = call.group ? null : who((call.members || []).find(e => e !== me));
  const firstNames = (list) => list.map(e => String(nameOf(e)).split(' ')[0]).join('، ');
  const title = call.group ? (call.chatName || L(`مكالمة مع ${firstNames(others) || '…'}`, `Call with ${firstNames(others) || '…'}`)) : (otherOne.name || otherOne.email);
  const canOpenChat = !call.chatMembers || call.chatMembers.includes(me);
  const STATE = { connecting: L('بيتوصل…', 'connecting…'), unstable: L('الشبكة ضعيفة', 'weak network'), failed: L('مش قادر يتوصل', 'cannot connect'), closed: '' };
  const people = [me, ...others].map(e => {
    const p = c.peers.get(e); const st = e === me ? '' : (p ? (p.state === 'connected' ? '' : STATE[p.state] || '') : STATE.connecting);
    return `<span class="call-person ${isTalking(e) ? 'talking' : ''} ${e === me && c.muted ? 'muted' : ''}" title="${esc(e === me ? L('إنت', 'You') : nameOf(e))}">${avatar(who(e), 'sm')}${e === me && c.muted ? '<i class="fas fa-microphone-slash"></i>' : ''}${st ? `<small>${esc(st)}</small>` : ''}</span>`;
  }).join('');
  // asked but not in yet (still ringing for them)
  const declined = (e) => Number(((call.declinedAt || {})[ek(e)]) || 0) > invitedAtOf(call, e);
  const waiting = call.group ? (call.members || []).filter(e => e !== me && !others.includes(e) && now() - invitedAtOf(call, e) < RING_FOR + 15000) : [];
  const left = (e) => Number(((call.leftAt || {})[ek(e)]) || 0) > invitedAtOf(call, e);
  const ringingPpl = waiting.map(e => left(e)
    ? `<span class="call-person declined" title="${esc(nameOf(e))}">${avatar(who(e), 'sm')}<small>${L('خرج', 'left')}</small></span>`
    : declined(e)
    ? `<span class="call-person declined" title="${esc(nameOf(e))}">${avatar(who(e), 'sm')}<small>${L('اعتذر', 'declined')}</small></span>`
    : (now() - invitedAtOf(call, e) < RING_FOR ? `<span class="call-person waiting" title="${esc(nameOf(e))}">${avatar(who(e), 'sm')}<small>${L('بيرن…', 'ringing…')}</small></span>` : `<span class="call-person declined" title="${esc(nameOf(e))}">${avatar(who(e), 'sm')}<small>${L('ما ردّش', 'no answer')}</small></span>`)).join('');
  const perm = 'Notification' in window ? Notification.permission : 'granted';
  const failed = [...c.peers.values()].some(p => p.state === 'failed');
  panel.classList.toggle('min', minimized);
  panel.innerHTML = `
    <div class="call-top"><span class="call-dot ${ringing ? 'ringing' : ''}"></span><div class="grow min0"><b class="truncate">${esc(title || '')}</b>
      <small class="num" id="call-clock">${ringing ? L('بيرن…', 'Ringing…') : fmtDur((now() - call.startedAt) / 1000)}${call.group ? ` · ${others.length + 1}/${MAX_IN_CALL}` : ''}</small></div>
      ${canOpenChat ? `<button class="btn btn-ghost btn-icon btn-sm" data-c="chat" title="${L('الشات', 'Chat')}"><i class="fas fa-comment-dots"></i></button>` : ''}
      <button class="btn btn-ghost btn-icon btn-sm" data-c="min" title="${minimized ? L('كبّر', 'Expand') : L('صغّر', 'Minimize')}"><i class="fas ${minimized ? 'fa-up-right-and-down-left-from-center' : 'fa-down-left-and-up-right-to-center'}"></i></button></div>
    ${minimized ? '' : `<div class="call-people">${people}${ringingPpl}</div>
      ${failed ? `<div class="call-warn"><i class="fas fa-triangle-exclamation"></i> ${L('الاتصال مش راضي يتوصل — غالباً شبكة الشركة أو النت بيمنعه. جرّب نت تاني.', 'The connection fails — the network probably blocks it. Try another connection.')}</div>` : ''}
      ${c.screen ? `<div class="call-sharing"><i class="fas fa-display"></i> ${L('إنت بتعرض شاشتك', 'You are sharing your screen')} <button class="btn btn-sm" data-c="share">${L('وقف', 'Stop')}</button></div>` : ''}
      ${perm === 'default' ? `<button class="call-hint" data-c="perm"><i class="fas fa-bell"></i> ${L('فعّل إشعارات الويندوز عشان المكالمات توصلك والسيستم في الخلفية', 'Turn on desktop notifications so calls reach you in the background')}</button>` : ''}
      ${perm === 'denied' ? `<div class="call-hint"><i class="fas fa-bell-slash"></i> ${L('إشعارات الويندوز مقفولة للموقع ده — افتحها من علامة القفل جنب العنوان', 'Desktop notifications are blocked for this site — allow them from the lock icon')}</div>` : ''}`}
    ${endMenu ? `<div class="call-endmenu"><button class="btn btn-sm btn-danger" data-c="endall"><i class="fas fa-phone-slash"></i> ${L('إنهاء المكالمة للكل', 'End the call for everyone')}</button><button class="btn btn-sm" data-c="leave"><i class="fas fa-right-from-bracket"></i> ${L('خروج بس', 'Just leave')}</button><button class="btn btn-sm btn-ghost" data-c="endx">${L('رجوع', 'Back')}</button></div>` : ''}
    <div class="call-actions">
      <button class="btn btn-icon call-btn ${c.muted ? 'on' : ''}" data-c="mute" title="${c.muted ? L('افتح المايك', 'Unmute') : L('اقفل المايك', 'Mute')}"><i class="fas ${c.muted ? 'fa-microphone-slash' : 'fa-microphone'}"></i></button>
      ${canShareScreen() ? `<button class="btn btn-icon call-btn ${c.screen ? 'on' : ''}" data-c="share" title="${c.screen ? L('وقف عرض شاشتك', 'Stop sharing your screen') : L(`اعرض شاشتك (${(call.sharing || []).length}/${MAX_SHARING})`, `Share your screen (${(call.sharing || []).length}/${MAX_SHARING})`)}"><i class="fas ${c.screen ? 'fa-display' : 'fa-desktop'}"></i></button>` : ''}
      ${(call.joined || []).includes(me) ? `<button class="btn btn-icon call-btn" data-c="add" title="${L('إضافة حد للمكالمة', 'Add someone to the call')}"><i class="fas fa-user-plus"></i></button>` : ''}
      <button class="btn btn-icon call-btn end" data-c="end" title="${L('إنهاء المكالمة', 'Hang up')}"><i class="fas fa-phone-slash"></i></button>
    </div>`;
  if (!clock) clock = setInterval(() => { const cc = currentCall(); const el = document.getElementById('call-clock'); if (cc && el && cc.call.startedAt) el.textContent = fmtDur((now() - cc.call.startedAt) / 1000) + (cc.call.group ? ` · ${(cc.call.joined || []).length}/${MAX_IN_CALL}` : ''); }, 1000);
  // the caller hears a ring-back tone until someone answers
  if (ringing && call.from === me && !ringback) { play('ringback'); ringback = setInterval(() => { const cc = currentCall(); if (cc && !cc.call.startedAt) play('ringback'); }, 3000); }
  if (!ringing && ringback) { clearInterval(ringback); ringback = 0; }
}

/** "Add" in the call bar: pick more people from the group */
async function addPeople() {
  const c = currentCall(); if (!c) return;
  try {
    const chat = await read('chats', c.call.chatId).catch(() => null);
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
    if (n) toast(L('اتضافوا وبيرن عندهم', 'Added — ringing now'), people.map(e => nameOf(e)).join('، '));
  } catch (e) { toastErr(e); }
}

// ---------------------------------------------------------------- the screens being shown (several at once)
let stage = null, focus = '', collapsed = false;
const tiles = new Map();   // email → { el, video, stream }
function drawStage() {
  const list = currentCall() ? screensNow() : [];
  if (!list.length) { if (stage) { stage.remove(); stage = null; } tiles.clear(); focus = ''; collapsed = false; return; }
  if (!stage) {
    stage = document.createElement('div'); stage.className = 'screen-stage';
    stage.innerHTML = `<div class="screen-head"><i class="fas fa-display"></i><b class="grow" id="ss-title"></b>
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
  const emails = list.map(x => x.email);
  [...tiles.keys()].forEach(e => { if (!emails.includes(e)) { tiles.get(e).el.remove(); tiles.delete(e); } });
  list.forEach(({ email, stream }) => {
    let t = tiles.get(email);
    if (!t) {
      const el = document.createElement('div'); el.className = 'screen-tile'; el.dataset.tile = email;
      el.innerHTML = `<video autoplay playsinline muted></video><span class="screen-name">${avatar(who(email), 'xs')} ${esc(L(`شاشة ${String(nameOf(email)).split(' ')[0]}`, `${String(nameOf(email)).split(' ')[0]}'s screen`))}</span>`;
      t = { el, video: el.querySelector('video'), stream: null };
      tiles.set(email, t); grid.appendChild(el);
    }
    if (t.stream !== stream) { t.stream = stream; t.video.srcObject = stream; t.video.play().catch(() => {}); }
  });
  if (focus && !tiles.has(focus)) focus = '';
  stage.classList.toggle('collapsed', collapsed);
  grid.className = `screen-grid n${Math.min(list.length, 3)} ${focus ? 'focused' : ''}`;
  tiles.forEach((t, e) => t.el.classList.toggle('main', e === focus));
  stage.querySelector('#ss-title').textContent = list.length > 1 ? L(`${list.length} شاشات معروضة — اضغط على شاشة عشان تكبّرها`, `${list.length} screens — click one to enlarge`) : L(`${String(nameOf(list[0].email)).split(' ')[0]} بيعرض شاشته`, `${String(nameOf(list[0].email)).split(' ')[0]} is sharing`);
}

// ---------------------------------------------------------------- started once after sign-in
let started = false;
export function startCallWatchers() {
  if (started) return; started = true;
  onCallState(() => { drawPanel(); drawStage(); liveSubs.forEach(cb => cb(live)); });
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
