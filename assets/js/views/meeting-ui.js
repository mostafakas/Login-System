// Meeting UI: "who is the meeting with?" picker, the invitation popup (accept / decline) and the host's answers.
import { L, esc, debounce } from '../core/utils.js';
import { modal, avatar, busy, toast, toastErr, STATUS_META, livePop } from '../core/ui.js';
import { session, now } from '../core/session.js';
import { dayKey } from '../core/policy.js';
import { activePeople, person, nameOf, departments, meetingLine } from '../services/directory.js';
import { startMeeting, updateMeeting, watchIncoming, watchAnswers, acceptInvite, declineInvite, settleAnswer, inviteText } from '../services/meetings.js';
import { play } from '../core/sounds.js';

const liveStatus = (p) => (p && STATUS_META[p.status] && p.status !== 'Offline' && p.dayKey === dayKey(now()) ? p.status : 'Offline');
const pill = (p) => { const s = liveStatus(p), m = STATUS_META[s]; return `<span class="chat-st ${s.toLowerCase()}" style="--c:${m.color}" title="${esc(meetingLine(p) || L(m.ar, m.en))}"><i class="fas ${m.icon}"></i>${esc(L(m.ar, m.en))}</span>`; };

/**
 * "Who is the meeting with?" — colleagues (several), or someone from outside, plus an optional topic.
 * Resolves true once the meeting started / was updated, false when closed.
 */
export function openMeetingPicker() {
  const me = person(session.email) || session.profile || {};
  const editing = me.status === 'Meeting' && me.dayKey === dayKey(now()) && !!me.meetingId;
  const picked = new Set(editing ? (me.meetingWith || []) : []);
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title: editing ? L('تعديل الميتنج', 'Edit the meeting') : L('ميتنج مع مين؟', 'Who is the meeting with?'), icon: 'fa-users',
      body: `<div class="col gap-12">
        <p class="small muted">${L('اختار الزميل (أو أكتر). هيوصله دعوة، ولما يقبل حالته هتتحوّل «اجتماع» معاك — والتيم بتاعكم هيشوف إنتوا في ميتنج مع مين.', 'Pick the colleague(s). They get an invitation; once they accept their status becomes "In a meeting" with you — and your teams see who is meeting whom.')}</p>
        <div class="mt-picked" id="mp-picked"></div>
        <div class="row gap-8"><div class="search grow"><i class="fas fa-search"></i><input class="input" id="mp-q" placeholder="${L('ابحث بالاسم أو القسم', 'Search name or department')}"></div>
          <select class="select" id="mp-d" style="max-width:170px"><option value="">${L('قسم كامل…', 'A whole department…')}</option>${departments().map(d => `<option>${esc(d)}</option>`).join('')}</select></div>
        <div class="chat-members" id="mp-list" style="max-height:260px"></div>
        <div class="form-grid">
          <div class="field"><label>${L('أو مع حد من برّه (اختياري)', 'Or someone from outside (optional)')}</label><input class="input" id="mp-ext" maxlength="80" placeholder="${L('مثلاً: عميل شركة كذا', 'e.g. a client')}" value="${esc(editing ? me.meetingExternal || '' : '')}"></div>
          <div class="field"><label>${L('موضوع الميتنج (اختياري)', 'Topic (optional)')}</label><input class="input" id="mp-topic" maxlength="120" value="${esc(editing ? me.meetingTopic || '' : '')}"></div>
        </div>
        <div id="mp-err" class="alert bad hidden"></div></div>`,
      foot: `<button class="btn" data-close>${L('إلغاء', 'Cancel')}</button><button class="btn btn-primary" id="mp-go"><i class="fas fa-paper-plane"></i> ${editing ? L('حفظ وابعت للجداد', 'Save & invite the new ones') : L('ابدأ الميتنج وابعت الدعوة', 'Start & send the invitation')}</button>`,
      onClose: () => { if (!done) resolve(false); }
    });
    const drawPicked = () => {
      m.$('#mp-picked').innerHTML = picked.size ? [...picked].map(e => `<span class="ct-chip">${avatar(person(e) || { email: e, name: nameOf(e) }, 'xs')}${esc(nameOf(e))}<button type="button" class="mt-x" data-un="${esc(e)}" aria-label="x"><i class="fas fa-xmark"></i></button></span>`).join('') : `<span class="xs muted">${L('لسه ما اخترتش حد', 'Nobody picked yet')}</span>`;
    };
    const draw = () => {
      const q = m.$('#mp-q').value.trim().toLowerCase();
      const ppl = activePeople().filter(p => p.email !== session.email && (!q || `${p.name} ${p.title} ${p.department} ${p.email}`.toLowerCase().includes(q)))
        .sort((a, b) => (picked.has(b.email) - picked.has(a.email)) || (a.name || '').localeCompare(b.name || '', 'ar'));
      m.$('#mp-list').innerHTML = ppl.map(p => {
        const busyWith = meetingLine(p, { topic: false });
        return `<label class="chat-member" style="cursor:pointer"><input type="checkbox" data-p="${esc(p.email)}" ${picked.has(p.email) ? 'checked' : ''}>${avatar(p, 'sm')}
          <span class="grow min0"><b class="truncate">${esc(p.name || p.email)}</b><small class="truncate">${esc(busyWith || [p.title, p.department].filter(Boolean).join(' · '))}</small></span>${pill(p)}</label>`;
      }).join('') || `<p class="muted small" style="padding:10px">${L('مفيش نتائج', 'No results')}</p>`;
      drawPicked();
    };
    m.$('#mp-q').oninput = debounce(draw, 100);
    m.$('#mp-d').onchange = (e) => { const d = e.target.value; if (!d) return; activePeople().forEach(p => { if (p.department === d && p.email !== session.email) picked.add(p.email); }); e.target.value = ''; draw(); };
    m.$('#mp-list').onchange = (e) => { const c = e.target.closest('[data-p]'); if (!c) return; if (c.checked) picked.add(c.dataset.p); else picked.delete(c.dataset.p); drawPicked(); };
    m.$('#mp-picked').onclick = (e) => { const b = e.target.closest('[data-un]'); if (b) { picked.delete(b.dataset.un); draw(); } };
    m.$('#mp-go').onclick = (e) => busy(e.currentTarget, async () => {
      const err = m.$('#mp-err'); err.classList.add('hidden');
      const data = { people: [...picked], external: m.$('#mp-ext').value, topic: m.$('#mp-topic').value };
      try {
        if (editing) await updateMeeting(data); else await startMeeting(data);
        done = true; m.close(); resolve(true);
        toast(L('بقيت في ميتنج', 'You are in a meeting'), data.people.length ? L('اتبعتت الدعوة', 'Invitation sent') : '');
      } catch (ex) { if (ex.userMessage) { err.textContent = ex.userMessage; err.classList.remove('hidden'); } else toastErr(ex); }
    });
    draw();
  });
}

// ---------- the invitation popup (stays until answered, withdrawn or put off) ----------
let started = false;
const shown = new Map();   // invite id → element
const later = new Set();   // put off for this session
const settled = new Set(); // answers already shown (a snapshot can fire again before our "seen" write lands)
function popRoot() {
  let root = document.querySelector('.chat-pops');
  if (!root) { root = document.createElement('div'); root.className = 'chat-pops'; document.body.appendChild(root); }
  return root;
}
function showInvite(inv) {
  const host = person(inv.from) || { email: inv.from, name: inv.fromName || nameOf(inv.from) };
  const el = document.createElement('div');
  el.className = 'chat-pop info mt-invite'; el.setAttribute('role', 'alertdialog');
  const sub = inviteText(inv);
  el.innerHTML = `${avatar(host)}<div class="grow min0"><b>${esc(L(`${host.name || host.email} بيدعوك لميتنج`, `${host.name || host.email} invites you to a meeting`))}</b>${sub ? `<p>${esc(sub)}</p>` : ''}
    <div class="row gap-8 mt-8 wrap"><button class="btn btn-sm btn-ok" data-a="yes"><i class="fas fa-check"></i> ${L('قبول', 'Accept')}</button><button class="btn btn-sm" data-a="no"><i class="fas fa-xmark"></i> ${L('اعتذار', 'Decline')}</button><button class="btn btn-sm btn-ghost" data-a="later">${L('بعدين', 'Later')}</button></div></div>`;
  const kill = () => { shown.delete(inv.id); el.classList.add('out'); setTimeout(() => el.remove(), 250); };
  el.onclick = async (e) => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    if (b.dataset.a === 'later') { later.add(inv.id); kill(); return; }
    await busy(b, async () => {
      try {
        if (b.dataset.a === 'yes') { await acceptInvite(inv); toast(L('دخلت الميتنج', 'You joined the meeting'), meetingLine(person(session.email) || {}) || ''); }
        else { await declineInvite(inv); toast(L('اتبعت الاعتذار', 'Declined'), '', 'info'); }
        kill();
      } catch (ex) { toastErr(ex); if (/خلص|ended/.test(ex.userMessage || '')) kill(); }
    });
  };
  popRoot().prepend(el);
  shown.set(inv.id, el);
  play('meeting');
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try { const n = new Notification(L(`${host.name || host.email} بيدعوك لميتنج`, `${host.name || host.email} invites you to a meeting`), { body: sub, icon: 'assets/img/icon-192.png', tag: inv.id }); n.onclick = () => { window.focus(); n.close(); }; } catch {}
  }
}

/** Started once after sign-in: invitations to me, and answers to mine */
export function startMeetingWatchers() {
  if (started) return; started = true;
  watchIncoming(rows => {
    const ids = new Set(rows.map(r => r.id));
    [...shown.keys()].forEach(id => { if (!ids.has(id)) { const el = shown.get(id); shown.delete(id); el.classList.add('out'); setTimeout(() => el.remove(), 250); } });   // withdrawn / answered elsewhere
    rows.slice().reverse().forEach(r => { if (!shown.has(r.id) && !later.has(r.id)) showInvite(r); });
  });
  watchAnswers(rows => {
    rows.forEach(inv => {
      if (inv.status === 'pending' || settled.has(inv.id)) return;
      settled.add(inv.id);
      if (inv.status === 'accepted' || inv.status === 'declined') {
        const who = person(inv.to) || { email: inv.to, name: nameOf(inv.to) };
        livePop({ who, cls: inv.status === 'accepted' ? 'ok' : 'bad', title: inv.status === 'accepted' ? L(`${who.name || who.email} قبل الميتنج`, `${who.name || who.email} accepted the meeting`) : L(`${who.name || who.email} اعتذر عن الميتنج`, `${who.name || who.email} declined the meeting`), text: inv.topic || '', ttl: 8000 });
        play(inv.status === 'accepted' ? 'approved' : 'rejected');
      }
      settleAnswer(inv);
    });
  });
}
