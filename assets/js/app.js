// App shell: session, navigation by role, router, clock, notifications badge.
import { L, isAr, esc, setLang, toggleTheme, fmtLongDate, zparts, pad, byId } from './core/utils.js';
import { requireSession, session, isHR, isLeader, isFinance, isAdmin, isPM, seesAll, hasCRM, canApprove, logout, now } from './core/session.js';
import { loadPolicy, roleLabel, policy, savePolicy, onPolicy } from './core/policy.js';
import { ymd } from './core/utils.js';
import { toast, toastErr, modal, avatar } from './core/ui.js';
import { startDirectory } from './services/directory.js';
import { startNotifications, onNotifications, unreadCount } from './services/notify.js';
import { watchInbox } from './services/requests.js';
import { auth, updatePassword, updateDoc, ref, read, isQuotaError, toMs } from './core/fb.js';
import { initTabs, enterTab, restoreScroll } from './tabs.js';

const ROUTES = [
  { id: 'home', group: 'me', icon: 'fa-house', ar: 'يومي', en: 'My day', load: () => import('./views/home.js'), bottom: true },
  { id: 'chat', group: 'me', icon: 'fa-comments', ar: 'الشات', en: 'Chat', load: () => import('./views/chat.js'), badge: 'chat', bottom: true },
  { id: 'tasks', group: 'me', icon: 'fa-clipboard-check', ar: 'التاسكات', en: 'Tasks', load: () => import('./views/tasks.js'), badge: 'tasks' },
  { id: 'todo', group: 'me', icon: 'fa-square-check', ar: 'To-Do List', en: 'To-Do List', load: () => import('./views/todo.js') },
  { id: 'announcements', group: 'me', icon: 'fa-bullhorn', ar: 'الإعلانات', en: 'Announcements', load: () => import('./views/announcements.js'), badge: 'ann' },
  { id: 'requests', group: 'me', icon: 'fa-paper-plane', ar: 'طلباتي', en: 'My requests', load: () => import('./views/requests.js'), bottom: true },
  { id: 'attendance', group: 'me', icon: 'fa-calendar-check', ar: 'حضوري', en: 'My attendance', load: () => import('./views/attendance.js') },
  { id: 'stats', group: 'me', icon: 'fa-chart-line', ar: 'الأداء', en: 'Performance', load: () => import('./views/stats.js'), badge: 'eval' },
  { id: 'records', group: 'me', icon: 'fa-circle-play', ar: 'التسجيلات والمحاضر', en: 'Recordings', load: () => import('./views/records.js') },
  { id: 'payslips', group: 'me', icon: 'fa-receipt', ar: 'قسائم الراتب', en: 'Payslips', load: () => import('./views/payslips.js') },
  { id: 'profile', group: 'me', icon: 'fa-circle-user', ar: 'حسابي', en: 'My profile', load: () => import('./views/profile.js') },
  { id: 'notifications', group: null, icon: 'fa-bell', ar: 'الإشعارات', en: 'Notifications', load: () => import('./views/notifications.js') },

  { id: 'dashboard', group: 'team', icon: 'fa-chart-pie', ar: 'الداشبورد', en: 'Dashboard', when: () => isAdmin() || isHR() || !!(session.profile && session.profile.permissions && session.profile.permissions.dashboard), load: () => import('./views/dashboard.js') },
  { id: 'monitor', group: 'team', icon: 'fa-signal', ar: 'المتابعة اللحظية', en: 'Live monitor', when: () => isLeader() || seesAll(), load: () => import('./views/monitor.js') },
  { id: 'approvals', group: 'team', icon: 'fa-inbox', ar: 'الموافقات', en: 'Approvals', when: canApprove, load: () => import('./views/approvals.js'), badge: 'inbox', bottom: true },
  { id: 'leaves', group: 'team', icon: 'fa-umbrella-beach', ar: 'الإجازات والأرصدة', en: 'Leaves & balances', when: () => isLeader() || seesAll(), load: () => import('./views/leaves.js') },
  { id: 'reports', group: 'team', icon: 'fa-chart-column', ar: 'التقارير الشهرية', en: 'Monthly reports', when: () => isLeader() || seesAll() || isFinance(), load: () => import('./views/reports.js') },

  { id: 'employees', group: 'hr', icon: 'fa-users', ar: 'الموظفين', en: 'Employees', when: isHR, load: () => import('./views/employees.js') },
  { id: 'daily', group: 'hr', icon: 'fa-user-clock', ar: 'الحضور اليومي', en: 'Daily attendance', when: isHR, load: () => import('./views/daily.js') },
  { id: 'recruit', group: 'hr', icon: 'fa-user-tie', ar: 'التوظيف', en: 'Recruitment', when: isHR, load: () => import('./views/recruit.js'), badge: 'recruit' },
  { id: 'schedules', group: 'hr', icon: 'fa-calendar-days', ar: 'الجداول', en: 'Schedules', when: () => isHR() || isLeader(), load: () => import('./views/schedules.js') },

  { id: 'payroll', group: 'finance', icon: 'fa-money-check-dollar', ar: 'الرواتب', en: 'Payroll', when: isFinance, load: () => import('./views/payroll.js') },
  { id: 'org', group: 'finance', icon: 'fa-sitemap', ar: 'الهيكل التنظيمي', en: 'Org chart', when: isFinance, load: () => import('./views/org.js') },
  { id: 'treasury', group: 'finance', icon: 'fa-vault', ar: 'الخزينة والمصروفات', en: 'Treasury', when: isFinance, load: () => import('./views/treasury.js') },

  { id: 'activity', group: 'admin', icon: 'fa-list-check', ar: 'سجل النشاط', en: 'Activity log', when: isAdmin, load: () => import('./views/activity.js') },
  { id: 'settings', group: 'admin', icon: 'fa-sliders', ar: 'الإعدادات', en: 'Settings', when: () => isAdmin() || isHR(), load: () => import('./views/settings.js') }
];
const GROUPS = {
  me: { ar: 'أنا', en: 'Me' }, team: { ar: 'الفريق', en: 'Team' }, hr: { ar: 'الموارد البشرية', en: 'Human resources' },
  finance: { ar: 'المالية', en: 'Finance' }, admin: { ar: 'النظام', en: 'System' }, apps: { ar: 'تطبيقات', en: 'Apps' }
};

let current = null; // { id, cleanup }
let inboxCount = 0, chatCount = 0, annCount = 0, taskCount = 0, evalCount = 0, recruitCount = 0;
const allowed = (r) => !r.when || r.when();

function renderNav() {
  const nav = byId('nav');
  let h = '';
  Object.keys(GROUPS).forEach(g => {
    const items = ROUTES.filter(r => r.group === g && allowed(r));
    if (g === 'apps') return; // the sales system link was removed from the menu
    if (!items.length) return;
    h += `<div class="nav-group"><div class="nav-label">${esc(L(GROUPS[g].ar, GROUPS[g].en))}</div>`;
    items.forEach(r => {
      h += `<a class="nav-item" href="#/${r.id}" data-route="${r.id}"><i class="fas ${r.icon}"></i><span>${esc(L(r.ar, r.en))}</span>${r.badge ? `<span class="badge-count hidden" data-badge="${r.badge}"></span>` : ''}</a>`;
    });
    h += '</div>';
  });
  nav.innerHTML = h;
  const bn = byId('bottom-nav');
  bn.innerHTML = ROUTES.filter(r => r.bottom && allowed(r)).slice(0, 4).map(r =>
    `<a href="#/${r.id}" data-route="${r.id}" style="position:relative"><i class="fas ${r.icon}"></i><span>${esc(L(r.ar, r.en))}</span>${r.badge ? `<span class="badge-count hidden bn-badge" data-badge="${r.badge}"></span>` : ''}</a>`).join('') +
    `<a href="#" id="bn-more"><i class="fas fa-bars"></i><span>${L('المزيد', 'More')}</span></a>`;
  byId('bn-more').onclick = (e) => { e.preventDefault(); document.body.classList.add('nav-open'); };
  renderUserChip();
}
function renderUserChip() {
  const p = session.profile || {};
  byId('user-chip').innerHTML = `${avatar({ ...p, email: session.email }, 'sm')}
    <div class="who"><b class="truncate">${esc(p.name || session.email)}</b><span>${esc(p.title || roleLabel(session.role))}</span></div>
    <button class="btn btn-on-navy btn-icon btn-sm" id="logout-btn" title="${L('تسجيل خروج', 'Sign out')}" aria-label="${L('تسجيل خروج', 'Sign out')}"><i class="fas fa-right-from-bracket"></i></button>`;
  byId('logout-btn').onclick = async () => {
    const { confirmDialog } = await import('./core/ui.js');
    const live = p.status && p.status !== 'Offline';
    const ok = await confirmDialog({
      title: L('تسجيل الخروج', 'Sign out'),
      message: live ? L('لسه يومك شغال. تسجيل الخروج مش هيقفل اليوم — استخدم «إنهاء اليوم» من صفحة يومي لو خلصت شغل.', 'Your day is still running. Signing out does not end it — use "End day" on My day when you finish.') : '',
      okText: L('خروج', 'Sign out')
    });
    if (ok) logout();
  };
}
function setBadges() {
  document.querySelectorAll('[data-badge="inbox"]').forEach(b => { b.textContent = inboxCount; b.classList.toggle('hidden', !inboxCount); });
  document.querySelectorAll('[data-badge="ann"]').forEach(b => { b.textContent = annCount; b.classList.toggle('hidden', !annCount); });
  document.querySelectorAll('[data-badge="recruit"]').forEach(b => { b.textContent = recruitCount > 99 ? '99+' : recruitCount; b.classList.toggle('hidden', !recruitCount); });
  document.querySelectorAll('[data-badge="eval"]').forEach(b => { b.textContent = evalCount; b.classList.toggle('hidden', !evalCount); });
  document.querySelectorAll('[data-badge="tasks"]').forEach(b => { b.textContent = taskCount > 99 ? '99+' : taskCount; b.classList.toggle('hidden', !taskCount); });
  const n = unreadCount();
  const bc = byId('bell-count'); bc.textContent = n > 9 ? '9+' : n; bc.classList.toggle('hidden', !n);
  document.querySelectorAll('[data-badge="chat"]').forEach(b => { b.textContent = chatCount > 99 ? '99+' : chatCount; b.classList.toggle('hidden', !chatCount); });
  const base = document.title.replace(/^\(\d+\+?\)\s*/, '');
  document.title = (chatCount ? `(${chatCount > 99 ? '99+' : chatCount}) ` : '') + base;
}

/** New chat messages: badge in the menu + a popup with a short sound (and a browser notification when the tab is hidden) */
async function startChatWatcher() {
  const { watchMyChats, unreadOf, isGroup, isMuted } = await import('./services/chat.js');
  const { person, nameOf } = await import('./services/directory.js');
  const { livePop } = await import('./core/ui.js');
  const { play } = await import('./core/sounds.js');
  const { toMs } = await import('./core/fb.js');
  let seen = now();
  const popup = (c, lm) => {
    const from = person(lm.by) || { email: lm.by, name: nameOf(lm.by) };
    // a group message says which group it came from, with that group's own unread count
    const title = isGroup(c) ? `${from.name || from.email} · ${c.name}${unreadOf(c) > 1 ? ` (${unreadOf(c)})` : ''}` : (from.name || from.email);
    livePop({ who: from, title, text: lm.text || '', href: `#/chat/${encodeURIComponent(c.id)}`, action: L('رد', 'Reply') });
    play('receive');
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      try { const n = new Notification(title, { body: lm.text || '', icon: 'assets/img/icon-192.png', tag: c.id }); n.onclick = () => { window.focus(); location.hash = `#/chat/${encodeURIComponent(c.id)}`; n.close(); }; } catch {}
    }
  };
  // a "ring" from a 1:1 chat keeps ringing (even when the chat is muted) until the person opens that chat,
  // clicks the notification or presses "Silence" — at most RING_MAX, then it becomes a "missed ring".
  const RING_MAX = 60000, RING_EVERY = 2600;
  const ringing = new Map();   // chatId → { el, timer, until, notif }
  const ringRoot = () => {
    let r = document.querySelector('.ring-pops');
    if (!r) { r = document.createElement('div'); r.className = 'ring-pops'; document.body.appendChild(r); }
    return r;
  };
  const stopRing = (id, missed = false) => {
    const r = ringing.get(id); if (!r) return;
    ringing.delete(id);
    clearInterval(r.timer);
    try { r.notif && r.notif.close(); } catch {}
    try { navigator.vibrate && navigator.vibrate(0); } catch {}
    r.el.classList.add('out'); setTimeout(() => r.el.remove(), 250);
    if (missed) livePop({ who: r.from, cls: 'warn', title: L(`فاتتك رنّة من ${r.from.name || r.from.email}`, `Missed ring from ${r.from.name || r.from.email}`), text: '', href: `#/chat/${encodeURIComponent(id)}`, action: L('فتح الشات', 'Open chat'), ttl: 600000 });
  };
  const chatIsOpen = (id) => window.__amOpenChat === id && !document.hidden && decodeURIComponent(location.hash) === `#/chat/${id}`;   // the chat view may stay alive in a background tab
  const ringPop = (c, lm) => {
    const from = person(lm.by) || { email: lm.by, name: nameOf(lm.by) };
    const href = `#/chat/${encodeURIComponent(c.id)}`;
    if (chatIsOpen(c.id)) { play('ring'); return; }   // already looking at that chat: one ring is enough
    const title = L(`${from.name || from.email} بيرن عليك`, `${from.name || from.email} is ringing you`);
    const cur = ringing.get(c.id);
    if (cur) { cur.until = Date.now() + RING_MAX; return; }   // rang again while ringing: keep going
    const el = document.createElement('div');
    el.className = 'ring-pop'; el.setAttribute('role', 'alertdialog');
    el.innerHTML = `<span class="ring-av">${avatar(from)}</span><div class="grow min0"><b class="truncate">${esc(title)}</b><small>${L('📞 رنّة — افتح الشات عشان توقفها', '📞 Ringing — open the chat to stop it')}</small></div>
      <a class="btn btn-sm btn-ok" href="${esc(href)}"><i class="fas fa-comment-dots"></i> ${L('فتح الشات', 'Open chat')}</a>
      <button class="btn btn-sm btn-ghost" data-mute title="${L('إسكات', 'Silence')}"><i class="fas fa-bell-slash"></i></button>`;
    el.querySelector('a').addEventListener('click', () => stopRing(c.id));
    el.querySelector('[data-mute]').onclick = () => stopRing(c.id);
    ringRoot().prepend(el);
    const r = { el, from, until: Date.now() + RING_MAX, notif: null, timer: 0 };
    const tick = () => {
      if (!ringing.has(c.id)) return;
      if (chatIsOpen(c.id)) { stopRing(c.id); return; }
      if (Date.now() > r.until) { stopRing(c.id, true); return; }
      play('ring');
      try { navigator.vibrate && navigator.vibrate([300, 150, 300]); } catch {}
    };
    ringing.set(c.id, r);
    if ('Notification' in window && Notification.permission === 'granted' && (document.hidden || !document.hasFocus())) {
      try { r.notif = new Notification(title, { body: L('📞 رنّة — اضغط لفتح الشات', '📞 Ringing — click to open the chat'), icon: 'assets/img/icon-192.png', tag: 'ring-' + c.id, requireInteraction: true, renotify: true });
        r.notif.onclick = () => { window.focus(); location.hash = href; stopRing(c.id); }; } catch {}
    }
    tick(); r.timer = setInterval(tick, RING_EVERY);
  };
  // opening that chat (here or on another device) stops it
  window.addEventListener('hashchange', () => [...ringing.keys()].forEach(id => { if (chatIsOpen(id) || decodeURIComponent(location.hash) === `#/chat/${id}`) stopRing(id); }));
  document.addEventListener('visibilitychange', () => [...ringing.keys()].forEach(id => { if (chatIsOpen(id)) stopRing(id); }));
  watchMyChats(chats => {
    chatCount = chats.reduce((s, c) => s + unreadOf(c), 0);
    setBadges();
    chats.forEach(c => { if (ringing.has(c.id) && !unreadOf(c)) stopRing(c.id); });   // read on another device
    let newest = seen;
    chats.forEach(c => {
      const lm = c.lastMessage; if (!lm || lm.by === session.email) return;
      const at = toMs(lm.at) || 0; if (at <= seen) return;
      newest = Math.max(newest, at);
      if (lm.type === 'ring' && !isGroup(c)) { ringPop(c, lm); return; }
      if (lm.type === 'call' && (lm.callOutcome !== 'missed' || (lm.callFor && !lm.callFor.includes(session.email)))) return;   // pop only a call I missed
      if (window.__amOpenChat === c.id && !document.hidden) return;
      if (isMuted(c)) return; // notifications switched off for this chat: the counter still counts
      popup(c, lm);
    });
    seen = newest;
  });
}

/** Announcements: unread badge, and an "important" one pops up until the reader confirms it */
async function startAnnouncementWatcher() {
  const svc = await import('./services/announcements.js');
  svc.startAnnouncements();
  const shown = new Set();
  let busy = false;
  svc.onAnnouncements(async () => {
    annCount = svc.unread().length; setBadges();
    if (busy || (current && current.id === 'announcements')) return;
    const next = svc.unread().find(a => a.important && !shown.has(a.id));
    if (!next) return;
    busy = true; shown.add(next.id);
    try { const { importantPopup } = await import('./views/announcements.js'); const { queuePopup } = await import('./core/ui.js'); await queuePopup(() => importantPopup(next)); } finally { busy = false; }
  });
}

async function route() {
  const hash = location.hash.replace(/^#\/?/, '') || 'home';
  let [id, ...rest] = hash.split('/');
  if (id === 'evaluations') { location.replace('#/stats'); return; }   // the old reviews page is now part of «الأداء»
  let r = ROUTES.find(x => x.id === id);
  const fallback = !r || !allowed(r);
  if (fallback) r = ROUTES[0];
  const restoreY = enterTab(r, fallback ? `#/${r.id}` : `#/${hash}`);
  document.body.classList.remove('nav-open');
  document.querySelectorAll('[data-route]').forEach(a => a.classList.toggle('active', a.dataset.route === r.id));
  byId('page-title').textContent = L(r.ar, r.en);
  byId('page-icon').innerHTML = `<i class="fas ${r.icon}"></i>`;
  byId('page-crumb').textContent = r.group && GROUPS[r.group] ? L(GROUPS[r.group].ar, GROUPS[r.group].en) : '';
  document.title = `${L(r.ar, r.en)} | AL MASTER`;
  if (chatCount) setBadges();
  if (current && current.cleanup) { try { current.cleanup(); } catch {} }
  const view = byId('view');
  view.innerHTML = `<div class="page-loader"><span class="spinner"></span></div>`;
  try {
    const mod = await r.load();
    const token = {};
    current = { id: r.id, token };
    // fresh container per visit so listeners bound by a view never pile up
    const host = document.createElement('div');
    view.replaceChildren(host);
    const cleanup = await mod.default(host, { params: rest });
    if (current.token === token) current.cleanup = cleanup;
    else if (cleanup) cleanup();
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="card card-pad"><div class="empty"><i class="fas fa-triangle-exclamation"></i><b>${L('تعذّر تحميل الصفحة', 'Could not load this page')}</b><span>${esc(e && e.message || '')}</span></div></div>`;
  }
  view.focus({ preventScroll: true });
  window.scrollTo(0, 0);
  restoreScroll(restoreY); // reopened from its tab → back to where you were
}

function startClock() {
  const tick = () => {
    const p = zparts(now());
    byId('clock').textContent = `${pad(p.h)}:${pad(p.mi)}`;
    byId('today').textContent = fmtLongDate(now());
  };
  tick(); setInterval(tick, 15000);
}

async function forcePasswordChange() {
  const m = modal({
    title: L('غيّر كلمة المرور', 'Change your password'), icon: 'fa-key', locked: true, size: 'narrow',
    body: `<p class="muted mb-16">${L('ده أول دخول ليك. اختار كلمة مرور جديدة خاصة بيك (8 حروف على الأقل).', 'This is your first sign-in. Choose your own password (at least 8 characters).')}</p>
      <form id="pw-form" class="col">
        <div class="field"><label>${L('كلمة المرور الجديدة', 'New password')}</label><input class="input" type="password" name="p1" minlength="8" required autocomplete="new-password"></div>
        <div class="field"><label>${L('تأكيد كلمة المرور', 'Confirm password')}</label><input class="input" type="password" name="p2" minlength="8" required autocomplete="new-password"></div>
        <div id="pw-err" class="alert bad hidden"></div>
        <button class="btn btn-primary btn-lg btn-block" type="submit">${L('حفظ', 'Save')}</button>
      </form>`
  });
  m.$('#pw-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target, p1 = f.p1.value, p2 = f.p2.value, err = m.$('#pw-err');
    if (p1.length < 8 || p1 !== p2) { err.textContent = L('كلمتين المرور مش متطابقين أو أقصر من 8 حروف.', 'Passwords do not match or are shorter than 8 characters.'); err.classList.remove('hidden'); return; }
    try {
      await updatePassword(auth.currentUser, p1);
      import('./services/activity.js').then(m => m.track('auth.password_set')).catch(() => {});
      await updateDoc(ref('users', session.email), { mustChangePassword: false });
      m.close(); toast(L('تم تغيير كلمة المرور', 'Password changed'));
    } catch (ex) {
      if (ex && ex.code === 'auth/requires-recent-login') { err.textContent = L('سجّل خروج وادخل تاني وبعدين غيّرها.', 'Please sign out, sign in again, then retry.'); err.classList.remove('hidden'); }
      else toastErr(ex);
    }
  };
}

async function boot() {
  byId('lang-btn').textContent = isAr ? 'EN' : 'ع';
  byId('lang-btn').onclick = () => setLang(isAr ? 'en' : 'ar');
  const setThemeIcon = () => { byId('theme-btn').innerHTML = `<i class="fas ${document.documentElement.dataset.theme === 'dark' ? 'fa-sun' : 'fa-moon'}"></i>`; };
  setThemeIcon();
  byId('theme-btn').onclick = () => { toggleTheme(); setThemeIcon(); };
  byId('menu-btn').onclick = () => document.body.classList.toggle('nav-open');
  byId('scrim').onclick = () => document.body.classList.remove('nav-open');

  // Firebase answers "quota exceeded" → explain it (instead of an endless spinner)
  let quota = false;
  const quotaMsg = () => `<div style="color:#fff;text-align:center;padding:24px;max-width:520px;margin:auto">
      <i class="fas fa-gauge-high" style="font-size:34px;opacity:.85"></i>
      <h2 style="font-size:19px;margin-top:14px">${L('الحد اليومي المجاني لـ Firebase خلص', "Firebase's free daily limit has been reached")}</h2>
      <p style="opacity:.8;margin-top:10px;line-height:1.8">${L('السيستم هيرجع يشتغل لوحده لما الحد يتجدد (كل يوم الساعة 10 الصبح بتوقيت القاهرة تقريباً). عشان يرجع فوراً، الأدمن يحوّل المشروع لخطة Blaze من Firebase Console (بتدفع بس لو عديت الحد المجاني).', 'The system comes back by itself when the limit resets (daily, around 10:00 AM Cairo time). To restore it now, the admin can switch the project to the Blaze plan in the Firebase Console (you pay only beyond the free limit).')}</p>
      <button class="btn btn-on-navy mt-16" onclick="location.reload()"><i class="fas fa-rotate"></i> ${L('إعادة المحاولة', 'Retry')}</button></div>`;
  window.addEventListener('am:quota', () => {
    if (quota) return; quota = true;
    const sp = byId('splash');
    if (sp) { sp.innerHTML = quotaMsg(); return; }
    import('./core/ui.js').then(({ livePop }) => livePop({ icon: 'fa-gauge-high', cls: 'bad', title: L('الحد اليومي المجاني لـ Firebase خلص', "Firebase's free daily limit has been reached"), text: L('ممكن بعض البيانات ما تتحفظش أو ما تظهرش لحد ما الحد يتجدد.', 'Some data may not load or save until the limit resets.'), ttl: 20000 }));
  });
  const slow = setTimeout(() => {
    const sp = byId('splash'); if (!sp || quota) return;
    sp.insertAdjacentHTML('beforeend', `<div id="slow" style="position:absolute;bottom:40px;inset-inline:0;text-align:center;color:#fff;opacity:.8;font-size:13px">${L('التحميل واخد وقت أكتر من العادي. لو فضل كده، غالباً الحد اليومي المجاني لـ Firebase خلص (بيتجدد حوالي 10 الصبح بتوقيت القاهرة).', 'This is taking longer than usual. If it stays like this, Firebase’s free daily limit has probably run out (resets around 10:00 AM Cairo time).')} <a href="#" onclick="location.reload();return false" style="color:#fff;text-decoration:underline">${L('إعادة المحاولة', 'Retry')}</a></div>`);
  }, 12000);
  try {
    await requireSession({ onProfileChange: (p) => { renderUserChip(); window.dispatchEvent(new CustomEvent('am:profile', { detail: p })); } });
    await loadPolicy();
    clearTimeout(slow);
  } catch (e) {
    clearTimeout(slow);
    console.error(e);
    if (quota || isQuotaError(e)) { byId('splash').innerHTML = quotaMsg(); return; }
    byId('splash').innerHTML = `<div style="color:#fff;text-align:center;padding:24px"><b>${L('تعذّر الاتصال بالسيرفر', 'Could not reach the server')}</b><p style="opacity:.7;margin-top:8px">${esc(e && e.message || '')}</p><button class="btn btn-on-navy mt-16" onclick="location.reload()">${L('إعادة المحاولة', 'Retry')}</button></div>`;
    return;
  }
  await startDirectory();
  if (isHR() && !policy.trackingStart) { try { await savePolicy({ trackingStart: ymd(now()) }); } catch (e) { console.warn(e); } }
  window.addEventListener('am:late-error', (e) => toastErr(e.detail, L('ما اتحفظش', 'Not saved')));
  startNotifications();
  startChatWatcher().catch(e => console.warn('chat', e && e.message));
  import('./views/meeting-ui.js').then(m => m.startMeetingWatchers()).catch(e => console.warn('meetings', e && e.message));
  import('./views/call-ui.js').then(m => m.startCallWatchers()).catch(e => console.warn('calls', e && e.message));
  startAnnouncementWatcher().catch(e => console.warn('announcements', e && e.message));
  import('./services/tasks.js').then(t => { t.startTasks(); t.onTasks(() => { taskCount = t.badgeCount(); setBadges(); if (isAdmin()) t.syncSupervisors().catch(e => console.warn('supervisors', e && e.message)); }); }).catch(e => console.warn('tasks', e && e.message));
  onNotifications(setBadges);
  if (isLeader() || isAdmin() || isPM() || isHR()) import('./services/evaluations.js').then(ev => ev.watchPending(rows => { evalCount = rows.length; setBadges(); })).catch(e => console.warn('reviews', e && e.message));
  if (canApprove()) watchInbox(rows => { inboxCount = rows.length; setBadges(); });
  // new applications from the public apply page (not opened yet)
  if (isHR()) import('./services/recruit.js').then(r => r.watchUnseen(rows => { recruitCount = rows.length; setBadges(); })).catch(e => console.warn('recruit', e && e.message));
  renderNav();
  startClock();
  initTabs(ROUTES, allowed);
  window.addEventListener('am:tabs-drawn', setBadges);
  window.addEventListener('hashchange', route);
  await route();
  const s = byId('splash'); s.style.opacity = '0'; setTimeout(() => s.remove(), 300);
  if (session.profile && session.profile.mustChangePassword) forcePasswordChange();
  else import('./views/birthdays.js').then(m => m.birthdayGreeter()).catch(e => console.warn('birthdays', e && e.message));
  setupCheck();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  watchForcedReload();
  // desktop notifications (calls, rings, messages while the page is in the background). Browsers only show the
  // permission question after a click, so it is asked on the first click / key press.
  if ('Notification' in window && Notification.permission === 'default') {
    const ask = () => { ['pointerdown', 'keydown'].forEach(ev => window.removeEventListener(ev, ask, true)); try { Notification.requestPermission(); } catch {} };
    ['pointerdown', 'keydown'].forEach(ev => window.addEventListener(ev, ask, true));
  }
}
boot();

/**
 * Admin → Settings → System → "Update everyone": writes settings/general.forceReloadAt. Every open page that
 * loaded before that moment reloads itself (after a short notice) and picks up the latest release.
 */
function watchForcedReload() {
  const bootAt = now();
  let reloading = false;
  onPolicy(() => {
    const t = toMs(policy.forceReloadAt);
    if (!t || t <= bootAt || reloading) return;
    reloading = true;
    toast(L('فيه تحديث جديد للسيستم', 'A new version is available'), L('الصفحة هتتحدّث خلال ثواني…', 'The page will refresh in a few seconds…'), 'info');
    const go = () => location.reload();
    setTimeout(() => {
      const reg = 'serviceWorker' in navigator ? navigator.serviceWorker.getRegistration() : Promise.resolve(null);
      reg.then(r => r && r.update()).catch(() => {}).finally(go);
      setTimeout(go, 4000); // never wait on the service worker for long
    }, document.hidden ? 0 : 5000);
  });
}

/** Tell people plainly when the Firebase side isn't set up yet (rules not published / old data not migrated). */
async function setupCheck() {
  let msg = '';
  try { await read('settings', 'general'); }
  catch (e) {
    if (String(e && e.code).includes('permission')) msg = isAdmin()
      ? L('قواعد الأمان الجديدة (firestore.rules) لسه ما اتنشرتش على Firebase، فأغلب الشاشات هتقول «مش مسموح». انشرها من Firebase Console ← Firestore ← Rules ← Publish.', 'The new security rules (firestore.rules) are not published on Firebase yet, so most screens will say "not allowed". Publish them in Firebase Console → Firestore → Rules → Publish.')
      : L('السيستم لسه بيتجهز من الإدارة، وبعض الشاشات ممكن ما تشتغلش دلوقتي.', 'The system is still being set up by the admin; some screens may not work yet.');
  }
  // keep the site address used in emailed links in sync (admins only, real https site)
  if (!msg && isAdmin() && location.protocol === 'https:' && !/^(localhost|127\.)/.test(location.hostname)) {
    try {
      const { publicConfig, savePublicConfig, siteUrl } = await import('./services/authsvc.js');
      const pub = await publicConfig(true);
      if (pub.authServiceUrl && pub.siteUrl !== siteUrl()) await savePublicConfig({ siteUrl: siteUrl() });
    } catch (e) { console.warn('siteUrl sync', e && e.message); }
  }
  if (!msg && isAdmin()) {
    const m = await read('settings', 'migration').catch(() => null);
    if (!m || !m.done) msg = L('بيانات السيستم القديم لسه ما اترحّلتش. افتح الإعدادات ← النظام والترحيل ← «معاينة» ثم «تنفيذ».', 'Data from the old system has not been migrated yet. Open Settings → System & migration → Preview, then Run.');
  }
  if (!msg) return;
  const view = byId('view');
  const b = document.createElement('div');
  b.className = 'alert warn';
  b.id = 'setup-banner';
  b.style.cssText = 'margin:16px clamp(16px,3vw,32px) 0;';
  b.innerHTML = `<i class="fas fa-triangle-exclamation"></i><div>${esc(msg)}</div>`;
  view.parentNode.insertBefore(b, view);
}
