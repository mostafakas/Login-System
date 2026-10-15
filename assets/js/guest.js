// A guest without an account joins a call from a link: guest.html#c=<callId>&k=<key>.
// They sign in anonymously, write their name and wait at the door (calls/{id}/guests/{uid}); once someone in the call
// lets them in, they talk like everyone else (voice, screens, their words go into the transcript). Nothing else of
// the system is open to them.
import { auth, signInAnonymously, db, doc, getDoc, setDoc, watch, serverTimestamp } from './core/fb.js';
import { session, syncClock, now } from './core/session.js';
import { L, esc } from './core/utils.js';
import { avatar, toastErr } from './core/ui.js';
import {
  joinCall, hangUp, setMuted, currentCall, onCallState, screensNow, shareScreen, stopScreen, canShareScreen, isTalking, fmtDur,
  callName, guestEmailFor, lastEndedCall
} from './services/calls.js';
import './services/recording.js';   // my words go into the call's transcript like everyone else's

const box = document.getElementById('g');
const screensBox = document.getElementById('g-screens');
const params = new URLSearchParams(location.hash.slice(1));
const callId = params.get('c') || '', key = params.get('k') || '';
let stage = 'form', joined = false, clock = 0;

const card = (html) => { box.innerHTML = `<div class="card guest-card"><div class="card-body">${html}</div></div>`; };
const done = (icon, title, text) => { stage = 'done'; screensBox.classList.add('hidden'); screensBox.innerHTML = ''; card(`<div class="guest-msg"><i class="fas ${icon}"></i><h2>${esc(title)}</h2>${text ? `<p class="muted">${esc(text)}</p>` : ''}</div>`); };

async function start() {
  if (!callId || !key) { done('fa-link-slash', L('اللينك ده ناقص', 'This link is incomplete'), L('اطلب لينك جديد من اللي بعتهولك.', 'Ask the sender for a new link.')); return; }
  try { await signInAnonymously(auth); }
  catch (e) { done('fa-triangle-exclamation', L('مش قادر أدخلك', 'Could not sign you in'), L('الدخول كضيف مش مفعّل في السيستم. بلّغ اللي بعتلك اللينك.', 'Guest sign-in is not enabled. Tell the person who sent you the link.')); console.warn(e); return; }
  session.user = auth.currentUser;
  session.email = guestEmailFor(auth.currentUser.uid);
  syncClock().catch(() => {});
  // opened the link again (a reload): carry on from where it was
  let mine = null;
  try { const s = await getDoc(doc(db, `calls/${callId}/guests`, auth.currentUser.uid)); mine = s.exists() ? s.data() : null; } catch {}
  if (mine && mine.status === 'denied') { done('fa-hand', L('ما اتسمحلكش تدخل', 'You were not let in'), ''); return; }
  if (mine && mine.status === 'allowed') { session.guestName = mine.name; waiting(mine.name); return; }
  form();
}

function form() {
  stage = 'form';
  let saved = ''; try { saved = localStorage.getItem('am_guest_name') || ''; } catch {}
  card(`<h2 class="guest-h">${L('مكالمة صوتية', 'Voice call')}</h2>
    <p class="muted small">${L('اكتب اسمك، وحد من اللي في المكالمة هيسمحلك تدخل.', 'Write your name; someone in the call will let you in.')}</p>
    <div class="field mt-16"><label>${L('اسمك', 'Your name')}</label><input class="input" id="gn" maxlength="60" autocomplete="name" value="${esc(saved)}"></div>
    <p class="xs muted mt-8"><i class="fas fa-circle-info"></i> ${L('المكالمة ممكن تتسجّل، والكلام بيتكتب تلقائياً في محضر.', 'The call may be recorded, and what is said is written down automatically.')}</p>
    <div id="ge" class="alert bad hidden mt-8"></div>
    <button class="btn btn-primary btn-lg mt-16" id="gj" style="width:100%"><i class="fas fa-phone"></i> ${L('دخول المكالمة', 'Join the call')}</button>`);
  const name = box.querySelector('#gn'), go = box.querySelector('#gj'), err = box.querySelector('#ge');
  name.focus();
  name.onkeydown = (e) => { if (e.key === 'Enter') go.click(); };
  go.onclick = async () => {
    const n = name.value.trim();
    err.classList.add('hidden');
    if (n.length < 2) { err.textContent = L('اكتب اسمك.', 'Write your name.'); err.classList.remove('hidden'); return; }
    go.disabled = true;
    // ask for the microphone now, so the browser question comes before the wait
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach(t => t.stop()); }
    catch { go.disabled = false; err.textContent = L('اسمح للموقع يستخدم المايك (من علامة القفل جنب العنوان) وجرّب تاني.', 'Allow the microphone (lock icon next to the address) and try again.'); err.classList.remove('hidden'); return; }
    try { localStorage.setItem('am_guest_name', n); } catch {}
    session.guestName = n;
    try {
      await setDoc(doc(db, `calls/${callId}/guests`, auth.currentUser.uid), { name: n, key, status: 'waiting', email: session.email, at: serverTimestamp() });
    } catch (e) { console.warn(e); done('fa-phone-slash', L('المكالمة مش متاحة', 'The call is not available'), L('يا إما المكالمة خلصت، يا إما اللينك اتغيّر.', 'Either the call has ended or the link changed.')); return; }
    waiting(n);
  };
}

function waiting(n) {
  stage = 'waiting';
  card(`<div class="guest-msg"><span class="ring-av">${avatar({ name: n })}</span><h2>${L('مستني حد يسمحلك…', 'Waiting to be let in…')}</h2>
    <p class="muted small">${L('اللي في المكالمة شايفين إنك مستني. خليك على الصفحة دي.', 'The people in the call can see you are waiting. Stay on this page.')}</p></div>`);
  const off = watch(doc(db, `calls/${callId}/guests`, auth.currentUser.uid), async (g) => {
    if (!g || stage !== 'waiting') return;
    if (g.status === 'denied') { off(); done('fa-hand', L('ما اتسمحلكش تدخل', 'You were not let in'), ''); return; }
    if (g.status === 'allowed' && !joined) {
      joined = true; off();
      try { await joinCall(callId); stage = 'in'; draw(); }
      catch (e) { toastErr(e); done('fa-phone-slash', L('مش قادر أدخلك المكالمة', 'Could not join the call'), e.userMessage || ''); }
    }
  });
}

// ---------------------------------------------------------------- in the call
const tiles = new Map();
function drawScreens() {
  const list = screensNow();
  screensBox.classList.toggle('hidden', !list.length);
  const ids = list.map(x => x.email);
  [...tiles.keys()].forEach(e => { if (!ids.includes(e)) { tiles.get(e).el.remove(); tiles.delete(e); } });
  list.forEach(({ email, stream }) => {
    let t = tiles.get(email);
    if (!t) {
      const el = document.createElement('div'); el.className = 'screen-tile';
      el.innerHTML = `<video autoplay playsinline muted></video><span class="screen-name"></span>`;
      el.ondblclick = () => el.requestFullscreen && el.requestFullscreen().catch(() => {});
      t = { el, video: el.querySelector('video'), stream: null }; tiles.set(email, t); screensBox.appendChild(el);
    }
    const c = currentCall();
    t.el.querySelector('.screen-name').textContent = L(`شاشة ${String(callName(c && c.call, email)).split(' ')[0]}`, `${String(callName(c && c.call, email)).split(' ')[0]}'s screen`);
    if (t.stream !== stream) { t.stream = stream; t.video.srcObject = stream; t.video.play().catch(() => {}); }
  });
}
function draw() {
  const c = currentCall();
  if (!c) {
    clearInterval(clock); clock = 0;
    if (stage === 'in') { const end = lastEndedCall(); const d = (end && end.call) || {}; done('fa-phone-slash', L('المكالمة خلصت', 'The call has ended'), d.startedAt ? L(`المدة ${fmtDur(((d.endedAt || now()) - d.startedAt) / 1000)}`, `Duration ${fmtDur(((d.endedAt || now()) - d.startedAt) / 1000)}`) : ''); }
    return;
  }
  if (stage !== 'in') return;
  const call = c.call || {}, me = session.email;
  const people = [me, ...(call.joined || []).filter(e => e !== me)];
  const title = call.chatName || L('مكالمة صوتية', 'Voice call');
  card(`<div class="guest-call">
    <div class="row gap-8" style="align-items:center"><span class="call-dot"></span><b class="grow truncate">${esc(title)}</b><span class="num muted" id="gt">${call.startedAt ? fmtDur((now() - call.startedAt) / 1000) : ''}</span></div>
    ${call.recBy && (call.joined || []).includes(call.recBy) ? `<div class="call-recon mt-8"><span class="rec-dot"></span> ${L('المكالمة بتتسجّل', 'This call is being recorded')}</div>` : ''}
    <div class="guest-people">${people.map(e => {
      const p = c.peers.get(e); const conn = e === me || (p && p.state === 'connected');
      return `<div class="guest-person ${isTalking(e) ? 'talking' : ''} ${conn ? '' : 'dim'}" data-e="${esc(e)}">${avatar({ name: callName(call, e) })}<small class="truncate">${esc(e === me ? L('إنت', 'You') : String(callName(call, e)).split(' ')[0])}</small>${e === me && c.muted ? '<i class="fas fa-microphone-slash"></i>' : ''}</div>`;
    }).join('')}</div>
    <div class="call-actions">
      <button class="btn btn-icon call-btn ${c.muted ? 'on' : ''}" data-g="mute" title="${L('المايك', 'Microphone')}"><i class="fas ${c.muted ? 'fa-microphone-slash' : 'fa-microphone'}"></i></button>
      ${canShareScreen() ? `<button class="btn btn-icon call-btn ${c.screen ? 'on' : ''}" data-g="share" title="${L('اعرض شاشتك', 'Share your screen')}"><i class="fas fa-desktop"></i></button>` : ''}
      <button class="btn btn-icon call-btn end" data-g="end" title="${L('خروج', 'Leave')}"><i class="fas fa-phone-slash"></i></button>
    </div></div>`);
  if (!clock) clock = setInterval(() => {
    const cc = currentCall(); if (!cc) return;
    const el = document.getElementById('gt'); if (el && cc.call.startedAt) el.textContent = fmtDur((now() - cc.call.startedAt) / 1000);
    box.querySelectorAll('.guest-person[data-e]').forEach(x => x.classList.toggle('talking', isTalking(x.dataset.e)));
  }, 300);
  drawScreens();
}
box.addEventListener('click', (e) => {
  const b = e.target.closest('[data-g]'); if (!b) return;
  const c = currentCall(); if (!c) return;
  if (b.dataset.g === 'mute') setMuted(!c.muted);
  else if (b.dataset.g === 'share') (c.screen ? stopScreen() : shareScreen()).catch(toastErr);
  else if (b.dataset.g === 'end') hangUp();
});
onCallState(() => draw());
start();
