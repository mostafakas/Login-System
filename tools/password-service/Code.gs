/**
 * AL MASTER HR — password service (Google Apps Script, free).
 *
 * What it does (things the browser can't do alone on Firebase's free plan):
 *   • reset   — HR/admin sets a temporary password for an employee (they must change it at next sign-in)
 *   • forgot  — "Forgot password?" on the sign-in page: emails a reset link to the employee's recovery (Outlook) email
 *   • welcome — emails a new employee their username + temporary password
 *   • renameCheck / rename — admin changes an account's username (login email); the site moves the data first
 *   • ping    — health check used by Settings → System
 *   • recUp / recGet / trBuild — call recordings (parts of a few minutes) and the call transcript, kept in this
 *               account's Drive; employees see one only after the admin approves their request
 *   • fileUp / fileGet — chat files, task attachments and payroll receipts are kept in this account's Google Drive
 *               (free 15 GB) instead of Firestore, so they no longer eat Firebase's free daily quota
 *
 * Setup: see README.md in this folder. Secrets live in Script Properties, never in this file:
 *   SERVICE_ACCOUNT = the whole JSON key from Firebase Console → Project settings → Service accounts
 */

const PROJECT_ID = 'almaster-b8c18';
const WEB_API_KEY = 'AIzaSyCXyuT529aGwiS5j_RPxW_zEeAtkYc7JlM'; // public web key — only a fallback; tokens are verified with Google's public keys
const FROM_NAME = 'AL MASTER HR';
const REPLY_TO = 'almaster.hr@outlook.com'; // replies to system emails land in HR's Outlook
const HR_ROLES = ['hr', 'supervisor', 'admin'];
const FORGOT_COOLDOWN_SEC = 600;  // one reset email per account every 10 minutes
const FORGOT_DAILY_CAP = 60;      // keeps Gmail's daily sending quota safe

// ---------------------------------------------------------------- entry points
function doGet() {
  return json_({ ok: true, service: 'almaster-password-service', configured: !!prop_('SERVICE_ACCOUNT') });
}

function doPost(e) {
  let body;
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (x) { return json_({ ok: false, error: 'bad-request' }); }
  try {
    switch (body.action) {
      case 'ping': return json_(ping_());
      case 'forgot': return json_(forgot_(body));
      case 'reset': return json_(reset_(body));
      case 'welcome': return json_(welcome_(body));
      case 'renameCheck': return json_(renameCheck_(body));
      case 'rename': return json_(rename_(body));
      case 'fileUp': return json_(fileUp_(body));
      case 'fileGet': return json_(fileGet_(body));
      case 'recUp': return json_(recUp_(body));
      case 'recGet': return json_(recGet_(body));
      case 'trBuild': return json_(trBuild_(body));
      default: return json_({ ok: false, error: 'unknown-action' });
    }
  } catch (err) {
    const msg = String((err && err.message) || err);
    console.error(body.action, msg);
    const known = ['unauthenticated', 'forbidden', 'not-found', 'no-login', 'no-recovery-email', 'not-configured', 'bad-request', 'email-taken', 'too-large', 'drive-error'];
    const code = msg.split(':')[0];
    if (known.indexOf(code) >= 0) return json_({ ok: false, error: code, detail: msg.slice(code.length + 1, 300) });
    return json_({ ok: false, error: 'server-error', detail: msg.slice(0, 300) });
  }
}

/** Run this once from the editor (select "setupCheck" → Run) to confirm everything is wired. */
function setupCheck() {
  const r = ping_();
  console.log(JSON.stringify(r, null, 2));
  if (!r.firebase) throw new Error('Service account not working — check the SERVICE_ACCOUNT script property.');
}

// ---------------------------------------------------------------- actions
function ping_() {
  const out = { ok: true, configured: !!prop_('SERVICE_ACCOUNT'), mailQuota: MailApp.getRemainingDailyQuota(), firebase: false, files: false };
  try { filesRoot_(); out.files = true; } catch (e) { out.filesDetail = String(e.message || e).slice(0, 200); }
  if (out.configured) { try { getDoc_('settings/public'); out.firebase = true; } catch (e) { out.detail = String(e.message || e).slice(0, 200); } }
  return out;
}

function reset_(b) {
  const me = caller_(b.idToken);
  if (HR_ROLES.indexOf(me.role) < 0) throw new Error('forbidden');
  const target = norm_(b.target);
  if (!target || target === me.email) throw new Error('forbidden');
  const t = getDoc_('users/' + target);
  if (!t) throw new Error('not-found');
  if (String(t.role || '').toLowerCase() === 'admin' && me.role !== 'admin') throw new Error('forbidden');

  const password = tempPassword_();
  const login = lookupLogin_(target);
  identity_('accounts:update', { localId: login.localId, password: password });
  // force the new-password popup and sign the account out everywhere
  patchDoc_('users/' + target, { mustChangePassword: true, sessionId: 'reset_' + Date.now() });

  let emailed = '';
  if (b.notify) {
    const to = recoveryEmail_(target);
    if (to) { sendCredentials_(to, t.name || target, target, password, b.origin, true); emailed = mask_(to); }
  }
  return { ok: true, password: password, emailed: emailed };
}

function welcome_(b) {
  const me = caller_(b.idToken);
  if (HR_ROLES.indexOf(me.role) < 0) throw new Error('forbidden');
  const target = norm_(b.target);
  const t = target && getDoc_('users/' + target);
  if (!t) throw new Error('not-found');
  if (!b.password || String(b.password).length < 6) throw new Error('bad-request');
  const to = recoveryEmail_(target);
  if (!to) throw new Error('no-recovery-email');
  sendCredentials_(to, t.name || target, target, String(b.password), b.origin, false);
  return { ok: true, emailed: mask_(to) };
}

function forgot_(b) {
  const neutral = { ok: true }; // same answer whatever happens, so accounts can't be probed
  let user = norm_(b.username);
  if (!user) return neutral;
  if (user.indexOf('@') < 0) {
    const pub = getDoc_('settings/public') || {};
    if (!pub.loginDomain) return neutral;
    user += '@' + String(pub.loginDomain).replace(/^@/, '');
  }
  const cache = CacheService.getScriptCache();
  if (cache.get('f_' + user)) return neutral;
  cache.put('f_' + user, '1', FORGOT_COOLDOWN_SEC);
  const dayKey = 'fday_' + Utilities.formatDate(new Date(), 'Africa/Cairo', 'yyyy-MM-dd');
  const n = Number(cache.get(dayKey) || 0);
  if (n >= FORGOT_DAILY_CAP) return neutral;
  cache.put(dayKey, String(n + 1), 21600);

  try {
    const p = getDoc_('users/' + user);
    if (!p || p.isSuspended === true) return neutral;
    const to = recoveryEmail_(user);
    if (!to) return neutral;
    const oob = identity_('accounts:sendOobCode', { requestType: 'PASSWORD_RESET', email: user, returnOobLink: true }).oobLink;
    // open our own "new password" page (reset.html) instead of Firebase's default page,
    // which is blocked when the web API key is restricted to the site's domain
    const code = oob && (String(oob).match(/[?&]oobCode=([^&#]+)/) || [])[1];
    const site = siteUrl_();
    const link = code && site ? site + 'reset.html?mode=resetPassword&oobCode=' + code : oob;
    if (link) sendResetLink_(to, p.name || user, user, link);
  } catch (e) { console.error('forgot', user, e && e.message); }
  return neutral;
}

// ---- username change (admin only). The site copies the Firestore data to the new key first, then calls rename.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function renamePair_(b) {
  const me = caller_(b.idToken);
  if (me.role !== 'admin') throw new Error('forbidden');
  const from = norm_(b.from), to = norm_(b.to);
  if (!from || !to || from === to || !EMAIL_RE.test(to)) throw new Error('bad-request');
  return { from: from, to: to };
}
const authUser_ = (email) => (identity_('accounts:lookup', { email: [email] }).users || [])[0] || null;

function renameCheck_(b) {
  const x = renamePair_(b);
  if (!getDoc_('users/' + x.from)) throw new Error('not-found');
  if (!authUser_(x.from)) throw new Error('no-login');
  if (authUser_(x.to)) throw new Error('email-taken');
  const existing = getDoc_('users/' + x.to);
  if (existing && existing.renamedFrom !== x.from) throw new Error('email-taken');
  return { ok: true };
}

function rename_(b) {
  const x = renamePair_(b);
  const copy = getDoc_('users/' + x.to);
  if (!copy || copy.renamedFrom !== x.from) throw new Error('bad-request'); // data must be copied first
  const fromU = authUser_(x.from), toU = authUser_(x.to);
  if (fromU && toU) throw new Error('email-taken');
  if (fromU) identity_('accounts:update', { localId: fromU.localId, email: x.to, emailVerified: false });
  else if (!toU) throw new Error('no-login');
  deleteDoc_('users/' + x.from); // safe to repeat
  return { ok: true };
}

// ---------------------------------------------------------------- files in Google Drive
// kind → the Firestore collection that holds the file's details, and the field that links it to its place
const FILE_KINDS = {
  chat: { coll: 'chat_files', key: 'chatId' },
  task: { coll: 'task_files', key: 'taskId' },
  payroll: { coll: 'payroll_proofs', key: 'itemId' }
};
const MAX_FILE_BYTES = 5300000;

/** "AL MASTER HR files" in this account's Drive (made once), with a folder per kind */
function filesRoot_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('FILES_FOLDER');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* deleted → make a new one */ } }
  const f = DriveApp.createFolder('AL MASTER HR files (do not share)');
  props.setProperty('FILES_FOLDER', f.getId());
  return f;
}
function kindFolder_(kind) {
  const root = filesRoot_();
  const it = root.getFoldersByName(kind);
  return it.hasNext() ? it.next() : root.createFolder(kind);
}
const isAdmin_ = (me) => me.role === 'admin';
const isHR_ = (me) => HR_ROLES.indexOf(me.role) >= 0;
const isFinance_ = (me) => me.role === 'finance' || me.role === 'admin' || !!((me.profile || {}).permissions || {}).payroll;

/** Same access as firestore.rules: chat members · people who see the task · finance (+ the employee once published) */
function canUse_(me, kind, ref, meta, forRead) {
  if (kind === 'chat') {
    const c = getDoc_('chats/' + ref);
    return !!c && (isAdmin_(me) || (c.members || []).indexOf(me.email) >= 0);
  }
  if (kind === 'task') {
    const t = getDoc_('tasks/' + ref);
    return !!t && (isAdmin_(me) || me.role === 'pm' || isHR_(me) || t.assignee === me.email || t.leader === me.email || t.supervisor === me.email);
  }
  if (kind === 'payroll') {
    if (isFinance_(me)) return !!getDoc_('payroll_items/' + ref);
    if (!forRead) return false;
    if (isHR_(me)) return true;
    const it = getDoc_('payroll_items/' + ref);
    return !!it && !!meta && meta.email === me.email && it.published === true;
  }
  return false;
}

/** Save one file (base64, ≤ 5 MB) and return its Drive id. The file's description records where it belongs. */
function fileUp_(b) {
  const me = caller_(b.idToken);
  const kind = String(b.kind || ''), ref = String(b.ref || '');
  if (!FILE_KINDS[kind] || !ref || ref.length > 200 || !b.data) throw new Error('bad-request');
  if (!canUse_(me, kind, ref, null, false)) throw new Error('forbidden');
  const bytes = Utilities.base64Decode(String(b.data));
  if (bytes.length > MAX_FILE_BYTES) throw new Error('too-large');
  const name = String(b.name || 'file').replace(/[\\/]/g, '_').slice(0, 180);
  const mime = String(b.mime || 'application/octet-stream').slice(0, 120);
  let file;
  try {
    file = kindFolder_(kind).createFile(Utilities.newBlob(bytes, mime, name));
    file.setDescription(kind + ':' + ref + ':' + me.email);
  } catch (e) { throw new Error('drive-error:' + String(e.message || e).slice(0, 200)); }
  return { ok: true, driveId: file.getId(), size: bytes.length };
}

/** Return a file (base64) after checking the caller may see the chat / task / receipt it belongs to. */
function fileGet_(b) {
  const me = caller_(b.idToken);
  const kind = String(b.kind || ''), id = String(b.id || '');
  const k = FILE_KINDS[kind];
  if (!k || !id || id.length > 200) throw new Error('bad-request');
  const meta = getDoc_(k.coll + '/' + id);
  if (!meta || !meta.driveId) throw new Error('not-found');
  const ref = String(meta[k.key] || '');
  if (!canUse_(me, kind, ref, meta, true)) throw new Error('forbidden');
  let file;
  try { file = DriveApp.getFileById(String(meta.driveId)); } catch (e) { throw new Error('not-found'); }
  // the Drive file must be the one saved for this same chat / task / salary (a copied id can't open another one)
  if (String(file.getDescription() || '').split(':').slice(0, 2).join(':') !== kind + ':' + ref) throw new Error('forbidden');
  const blob = file.getBlob();
  return { ok: true, name: meta.name || file.getName(), mime: meta.mime || blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
}

// ---------------------------------------------------------------- call recordings & transcripts
// Recordings come in parts of a few minutes (a crash loses at most one part). They and the transcript live in this
// account's Drive; call_records/{callId} lists them. Only the admin, and people the admin approved, can open them.
const REC_MAX_BYTES = 40 * 1024 * 1024;
function callOf_(callId) { const c = getDoc_('calls/' + callId); if (!c) throw new Error('not-found'); return c; }
function recFolder_(sub) {
  const root = filesRoot_();
  const it = root.getFoldersByName(sub);
  return it.hasNext() ? it.next() : root.createFolder(sub);
}
function canSeeRec_(me, rec, kind) {
  if (me.role === 'admin') return true;
  const list = (rec && rec[kind === 'tr' ? 'viewTr' : 'viewRec']) || [];
  return list.indexOf(me.email) >= 0;
}
function stamp_(ms) { return Utilities.formatDate(new Date(Number(ms) || Date.now()), 'Africa/Cairo', 'yyyy-MM-dd HH:mm'); }

/** one part of a recording (webm, base64) from someone in the call */
function recUp_(b) {
  const me = caller_(b.idToken);
  const callId = String(b.callId || '');
  if (!callId || !b.data) throw new Error('bad-request');
  const call = callOf_(callId);
  if ((call.members || []).indexOf(me.email) < 0) throw new Error('forbidden');
  const bytes = Utilities.base64Decode(String(b.data));
  if (bytes.length > REC_MAX_BYTES) throw new Error('too-large');
  const n = Math.max(1, Number(b.part) || 1);
  const title = call.chatName || call.fromName || 'call';
  const name = stamp_(call.atMs) + ' — ' + String(title).replace(/[\\/]/g, '_').slice(0, 60) + ' — part ' + n + '.webm';
  let file;
  try {
    file = recFolder_('recordings').createFile(Utilities.newBlob(bytes, String(b.mime || 'video/webm').slice(0, 80), name));
    file.setDescription('rec:' + callId + ':' + me.email);
  } catch (e) { throw new Error('drive-error:' + String(e.message || e).slice(0, 200)); }
  const rec = getDoc_('call_records/' + callId) || {};
  const parts = (rec.parts || []).concat([{ id: file.getId(), n: n, by: me.email, startMs: Number(b.startMs) || 0, durMs: Number(b.durMs) || 0, size: bytes.length, video: !!b.video, mime: String(b.mime || 'video/webm').slice(0, 80) }]);
  setDoc_('call_records/' + callId, {
    callId: callId, chatId: call.chatId || '', title: String(title).slice(0, 120), group: !!call.group,
    members: call.members || [], atMs: Number(call.atMs) || 0, startedAt: Number(call.startedAt) || 0, parts: parts, updatedMs: Date.now()
  });
  return { ok: true, id: file.getId() };
}

/** a recording part (kind 'rec', with part id) or the transcript (kind 'tr') for the admin / approved people */
function recGet_(b) {
  const me = caller_(b.idToken);
  const callId = String(b.callId || ''), kind = b.kind === 'tr' ? 'tr' : 'rec';
  let rec = getDoc_('call_records/' + callId);
  if (!rec) throw new Error('not-found');
  if (!canSeeRec_(me, rec, kind)) throw new Error('forbidden');
  // the transcript is rebuilt when someone's last lines arrived after it was made (nothing said is left out)
  if (kind === 'tr') {
    const parts = listDocs_('call_transcripts/' + callId + '/parts');
    const newest = parts.reduce((m, p) => Math.max(m, Number(p.atMs) || 0), 0);
    if (parts.length && (!rec.transcript || !rec.transcript.id || newest > Number(rec.transcript.builtMs || 0) - 5000)) { buildTranscript_(callId, parts); rec = getDoc_('call_records/' + callId) || rec; }
  }
  const id = kind === 'tr' ? ((rec.transcript || {}).id || '') : String(b.id || '');
  if (kind === 'rec' && !(rec.parts || []).some(p => p.id === id)) throw new Error('not-found');
  if (!id) throw new Error('not-found');
  let file;
  try { file = DriveApp.getFileById(id); } catch (e) { throw new Error('not-found'); }
  const blob = file.getBlob();
  if (kind === 'tr') return { ok: true, name: file.getName(), text: blob.getDataAsString('UTF-8') };
  return { ok: true, name: file.getName(), mime: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
}

/** Build (or rebuild) the transcript file of a call from what every participant's browser wrote down */
function trBuild_(b) {
  const me = caller_(b.idToken);
  const callId = String(b.callId || '');
  const call = callOf_(callId);
  if ((call.members || []).indexOf(me.email) < 0 && me.role !== 'admin') throw new Error('forbidden');
  return { ok: true, lines: buildTranscript_(callId) };
}
function buildTranscript_(callId, partsIn) {
  const call = callOf_(callId);
  const parts = partsIn || listDocs_('call_transcripts/' + callId + '/parts');
  const lines = [];
  parts.forEach(p => (p.lines || []).forEach(l => { if (l && l.text) lines.push({ t: Number(l.t) || 0, by: p.by || '', name: p.name || p.by || '', text: String(l.text) }); }));
  lines.sort((a, c) => a.t - c.t);
  const title = call.chatName || ('مكالمة ' + (call.fromName || ''));
  const who = {}; lines.forEach(l => { who[l.by] = l.name; });
  const dur = call.startedAt && call.endedAt ? Math.round((call.endedAt - call.startedAt) / 60000) : 0;
  const head = ['محضر مكالمة — ' + title, 'التاريخ: ' + stamp_(call.startedAt || call.atMs) + (dur ? ' · المدة حوالي ' + dur + ' دقيقة' : ''),
    'اللي اتكلموا: ' + Object.keys(who).map(k => who[k]).join('، '), '(تفريغ تلقائي من المتصفح — ممكن يكون فيه أخطاء)', ''.padEnd(40, '—'), ''];
  const body = lines.map(l => '[' + Utilities.formatDate(new Date(l.t), 'Africa/Cairo', 'HH:mm:ss') + '] ' + l.name + ': ' + l.text);
  const text = '\uFEFF' + head.concat(body.length ? body : ['(مفيش كلام اتسجل)']).join('\n');
  const rec = getDoc_('call_records/' + callId) || {};
  const name = stamp_(call.atMs) + ' — ' + String(title).replace(/[\\/]/g, '_').slice(0, 60) + ' — transcript.txt';
  let file = null;
  if (rec.transcript && rec.transcript.id) { try { file = DriveApp.getFileById(rec.transcript.id); file.setContent(text); } catch (e) { file = null; } }
  if (!file) { file = recFolder_('transcripts').createFile(name, text, MimeType.PLAIN_TEXT); file.setDescription('tr:' + callId); }
  setDoc_('call_records/' + callId, {
    callId: callId, chatId: call.chatId || '', title: String(title).slice(0, 120), group: !!call.group,
    members: call.members || [], atMs: Number(call.atMs) || 0, startedAt: Number(call.startedAt) || 0, endedAt: Number(call.endedAt) || 0,
    transcript: { id: file.getId(), lines: lines.length, builtMs: Date.now() }, updatedMs: Date.now()
  });
  return lines.length;
}

// ---------------------------------------------------------------- identity & Firestore (service account)
function caller_(idToken) {
  if (!idToken) throw new Error('unauthenticated:no-token');
  let email = '';
  try { email = verifyIdToken_(idToken); }
  catch (e) {
    // fallback: ask Firebase directly (works when the web API key is not restricted to your site)
    const r = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + WEB_API_KEY, {
      method: 'post', contentType: 'application/json', payload: JSON.stringify({ idToken: idToken }), muteHttpExceptions: true
    });
    const u = r.getResponseCode() === 200 ? (JSON.parse(r.getContentText()).users || [])[0] : null;
    if (!u || !u.email) throw new Error('unauthenticated:' + String(e.message || e).replace(/^unauthenticated:/, '') + ' / lookup ' + r.getResponseCode());
    email = String(u.email).toLowerCase();
  }
  const p = getDoc_('users/' + email);
  if (!p || p.isSuspended === true) throw new Error('forbidden');
  return { email: email, role: String(p.role || '').toLowerCase(), profile: p };
}

// ---- Firebase ID token verification (RS256 against Google's public keys) — no API key needed
function b64urlBytes_(s) { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Utilities.base64Decode(s); }
function b64urlJson_(s) { return JSON.parse(Utilities.newBlob(b64urlBytes_(s)).getDataAsString('UTF-8')); }
function bytesToHex_(b) { return b.map(x => ('0' + ((x + 256) % 256).toString(16)).slice(-2)).join(''); }
// (written with BigInt(...) calls — the Apps Script editor rejects the 1n literal syntax)
function modPow_(base, exp, mod) {
  const ZERO = BigInt(0), ONE = BigInt(1), TWO = BigInt(2);
  let r = ONE; base = base % mod;
  while (exp > ZERO) {
    if (exp % TWO === ONE) r = (r * base) % mod;
    base = (base * base) % mod;
    exp = exp / TWO;
  }
  return r;
}
function firebaseKeys_(force) {
  const cache = CacheService.getScriptCache();
  const hit = !force && cache.get('fb_jwks');
  if (hit) return JSON.parse(hit);
  const r = UrlFetchApp.fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com', { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('unauthenticated:keys-' + r.getResponseCode());
  const keys = {};
  (JSON.parse(r.getContentText()).keys || []).forEach(k => { keys[k.kid] = { n: k.n, e: k.e }; });
  cache.put('fb_jwks', JSON.stringify(keys), 3600);
  return keys;
}
function verifyIdToken_(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('unauthenticated:format');
  const header = b64urlJson_(parts[0]), claims = b64urlJson_(parts[1]);
  const now = Math.floor(Date.now() / 1000);
  if (header.alg !== 'RS256') throw new Error('unauthenticated:alg');
  if (claims.aud !== PROJECT_ID || claims.iss !== 'https://securetoken.google.com/' + PROJECT_ID) throw new Error('unauthenticated:project');
  if (!claims.sub || !claims.email) throw new Error('unauthenticated:claims');
  if (Number(claims.exp) < now - 30) throw new Error('unauthenticated:expired');
  if (Number(claims.iat) > now + 300) throw new Error('unauthenticated:clock');
  if (typeof BigInt !== 'function') throw new Error('unauthenticated:no-bigint');
  let key = firebaseKeys_()[header.kid];
  if (!key) key = firebaseKeys_(true)[header.kid];
  if (!key) throw new Error('unauthenticated:kid');
  const n = BigInt('0x' + bytesToHex_(b64urlBytes_(key.n)));
  const e = BigInt('0x' + bytesToHex_(b64urlBytes_(key.e)));
  const sig = BigInt('0x' + bytesToHex_(b64urlBytes_(parts[2])));
  const k = bytesToHex_(b64urlBytes_(key.n)).replace(/^(00)+/, '').length / 2;
  const em = modPow_(sig, e, n).toString(16).padStart(k * 2, '0');
  const digest = bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, parts[0] + '.' + parts[1], Utilities.Charset.US_ASCII));
  const t = '3031300d060960864801650304020105000420' + digest;
  const expected = '0001' + 'ff'.repeat(k - 3 - t.length / 2) + '00' + t;
  if (em !== expected) throw new Error('unauthenticated:signature');
  return String(claims.email).toLowerCase();
}

function lookupLogin_(email) {
  const r = identity_('accounts:lookup', { email: [email] });
  const u = (r.users || [])[0];
  if (!u) throw new Error('no-login');
  return u;
}

function identity_(method, payload) {
  const r = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/projects/' + PROJECT_ID + '/' + method, {
    method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + token_() },
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  const code = r.getResponseCode(), text = r.getContentText();
  if (code >= 300) throw new Error('identity ' + method + ' ' + code + ' ' + text.slice(0, 200));
  return JSON.parse(text || '{}');
}

const FS_BASE = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID + '/databases/(default)/documents/';
function fsPath_(path) { return path.split('/').map(encodeURIComponent).join('/'); }

function getDoc_(path) {
  const r = UrlFetchApp.fetch(FS_BASE + fsPath_(path), { headers: { Authorization: 'Bearer ' + token_() }, muteHttpExceptions: true });
  if (r.getResponseCode() === 404) return null;
  if (r.getResponseCode() >= 300) throw new Error('firestore get ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 200));
  return fromFields_(JSON.parse(r.getContentText()).fields || {});
}

function patchDoc_(path, data) {
  const mask = Object.keys(data).map(k => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
  const r = UrlFetchApp.fetch(FS_BASE + fsPath_(path) + '?' + mask + '&currentDocument.exists=true', {
    method: 'patch', contentType: 'application/json', headers: { Authorization: 'Bearer ' + token_() },
    payload: JSON.stringify({ fields: toFields_(data) }), muteHttpExceptions: true
  });
  if (r.getResponseCode() >= 300) throw new Error('firestore patch ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 200));
}

function deleteDoc_(path) {
  const r = UrlFetchApp.fetch(FS_BASE + fsPath_(path), { method: 'delete', headers: { Authorization: 'Bearer ' + token_() }, muteHttpExceptions: true });
  if (r.getResponseCode() >= 300 && r.getResponseCode() !== 404) throw new Error('firestore delete ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 200));
}

function fromValue_(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('mapValue' in v) return fromFields_(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue_);
  return null;
}
function fromFields_(f) { const o = {}; Object.keys(f).forEach(k => { o[k] = fromValue_(f[k]); }); return o; }
function toValue_(v) {
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (v === null || v === undefined) return { nullValue: null };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue_) } };
  if (typeof v === 'object') return { mapValue: { fields: toFields_(v) } };
  return { stringValue: String(v) };
}
function toFields_(o) {
  const f = {};
  Object.keys(o).forEach(k => { f[k] = toValue_(o[k]); });
  return f;
}
/** create or update (only the given fields) */
function setDoc_(path, data) {
  const mask = Object.keys(data).map(k => 'updateMask.fieldPaths=' + encodeURIComponent('`' + k + '`')).join('&');
  const r = UrlFetchApp.fetch(FS_BASE + fsPath_(path) + '?' + mask, {
    method: 'patch', contentType: 'application/json', headers: { Authorization: 'Bearer ' + token_() },
    payload: JSON.stringify({ fields: toFields_(data) }), muteHttpExceptions: true
  });
  if (r.getResponseCode() >= 300) throw new Error('firestore set ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 200));
}
/** all documents of a (sub)collection */
function listDocs_(path) {
  const out = []; let page = '';
  do {
    const r = UrlFetchApp.fetch(FS_BASE + fsPath_(path) + '?pageSize=300' + (page ? '&pageToken=' + encodeURIComponent(page) : ''), { headers: { Authorization: 'Bearer ' + token_() }, muteHttpExceptions: true });
    if (r.getResponseCode() === 404) return out;
    if (r.getResponseCode() >= 300) throw new Error('firestore list ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 200));
    const j = JSON.parse(r.getContentText());
    (j.documents || []).forEach(d => out.push(Object.assign({ id: d.name.split('/').pop() }, fromFields_(d.fields || {}))));
    page = j.nextPageToken || '';
  } while (page);
  return out;
}

/** OAuth token for the Firebase service account (cached ~50 minutes). */
function token_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('sa_token');
  if (hit) return hit;
  const raw = prop_('SERVICE_ACCOUNT');
  if (!raw) throw new Error('not-configured');
  const sa = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Utilities.base64EncodeWebSafe(JSON.stringify(o)).replace(/=+$/, '');
  const unsigned = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({
    iss: sa.client_email, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/identitytoolkit'
  });
  const sig = Utilities.base64EncodeWebSafe(Utilities.computeRsaSha256Signature(unsigned, sa.private_key)).replace(/=+$/, '');
  const r = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post', payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + sig }, muteHttpExceptions: true
  });
  if (r.getResponseCode() !== 200) throw new Error('token ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 200));
  const tok = JSON.parse(r.getContentText()).access_token;
  cache.put('sa_token', tok, 3000);
  return tok;
}

// ---------------------------------------------------------------- helpers
/** The recovery (Outlook) email; when none is set and the username itself is a real mailbox
 *  (not under the internal login domain), the username is used. */
function recoveryEmail_(email) {
  const p = getDoc_('employees_private/' + email);
  const v = p && String(p.contactEmail || '').trim();
  if (v && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return v;
  const pub = getDoc_('settings/public') || {};
  const dom = String(pub.loginDomain || '').replace(/^@/, '').toLowerCase();
  return dom && email.endsWith('@' + dom) ? '' : email;
}
function tempPassword_() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Utilities.getUuid() + Date.now());
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[(bytes[i] + 256) % chars.length];
  return s.slice(0, 4) + '-' + s.slice(4, 8) + '#' + (10 + ((bytes[9] + 256) % 90));
}
/** The site address, as saved by the admin in Settings (never taken from the request, so links can't be redirected). */
function siteUrl_() {
  const pub = getDoc_('settings/public') || {};
  const u = String(pub.siteUrl || '');
  return /^https:\/\/[^\s]+$/.test(u) ? u.replace(/\/?$/, '/') : '';
}
function norm_(v) { return String(v || '').trim().toLowerCase(); }
function mask_(e) { const p = String(e).split('@'); return p[0].slice(0, 2) + '•••@' + (p[1] || ''); }
function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function escHtml_(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------------------------------------------------------------- emails
function shell_(title, bodyHtml) {
  return '<div style="font-family:Segoe UI,Tahoma,Arial,sans-serif;background:#f5f7ff;padding:24px">' +
    '<div style="max-width:520px;margin:auto;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e3e7f5">' +
    '<div style="background:#0a0f3d;color:#fff;padding:18px 24px;font-weight:800;letter-spacing:.04em">AL MASTER</div>' +
    '<div style="padding:24px;color:#0f1633;line-height:1.7"><h2 style="margin:0 0 12px;font-size:18px">' + title + '</h2>' + bodyHtml + '</div>' +
    '<div style="padding:14px 24px;color:#8b93aa;font-size:12px;border-top:1px solid #e3e7f5">AL MASTER Technology — HR portal</div></div></div>';
}
function sendCredentials_(to, name, username, password, origin, isReset) {
  const url = siteUrl_();
  const title = isReset ? 'Your password was reset / تم إعادة تعيين كلمة المرور' : 'Your AL MASTER account / حسابك على بوابة الماستر';
  const html = shell_(title,
    '<p>Hi ' + escHtml_(name) + ',</p>' +
    '<p>' + (isReset ? 'HR has set a temporary password for your account.' : 'An account has been created for you on the AL MASTER employee portal.') + '</p>' +
    '<table style="border-collapse:collapse;margin:12px 0;font-size:14px">' +
    '<tr><td style="padding:6px 12px 6px 0;color:#5b6479">Username</td><td style="padding:6px 0;font-weight:700;direction:ltr">' + escHtml_(username) + '</td></tr>' +
    '<tr><td style="padding:6px 12px 6px 0;color:#5b6479">Temporary password</td><td style="padding:6px 0;font-weight:700;font-family:Consolas,monospace;direction:ltr">' + escHtml_(password) + '</td></tr></table>' +
    (url ? '<p><a href="' + escHtml_(url) + '" style="display:inline-block;background:#1b1bdb;color:#fff;padding:10px 18px;border-radius:10px;text-decoration:none;font-weight:700">Sign in</a></p>' : '') +
    '<p style="color:#5b6479;font-size:13px">You will be asked to choose your own password right after signing in.</p>' +
    '<p dir="rtl" style="text-align:right;color:#5b6479;font-size:13px;border-top:1px solid #eee;padding-top:12px">ادخل باسم المستخدم وكلمة المرور المؤقتة اللي فوق، وهيُطلب منك تختار كلمة مرور جديدة أول ما تدخل.</p>');
  MailApp.sendEmail({ to: to, subject: title, htmlBody: html, name: FROM_NAME, replyTo: REPLY_TO });
}
function sendResetLink_(to, name, username, link) {
  const title = 'Reset your password / استعادة كلمة المرور';
  const html = shell_(title,
    '<p>Hi ' + escHtml_(name) + ',</p>' +
    '<p>We received a request to reset the password for <b style="direction:ltr">' + escHtml_(username) + '</b>.</p>' +
    '<p><a href="' + escHtml_(link) + '" style="display:inline-block;background:#1b1bdb;color:#fff;padding:10px 18px;border-radius:10px;text-decoration:none;font-weight:700">Choose a new password</a></p>' +
    '<p style="color:#5b6479;font-size:13px">The link works once and expires in about an hour. If you didn\'t ask for this, ignore this email — your password stays the same.</p>' +
    '<p dir="rtl" style="text-align:right;color:#5b6479;font-size:13px;border-top:1px solid #eee;padding-top:12px">اضغط الزرار اللي فوق عشان تختار كلمة مرور جديدة. لو ما طلبتش ده، تجاهل الإيميل.</p>');
  MailApp.sendEmail({ to: to, subject: title, htmlBody: html, name: FROM_NAME, replyTo: REPLY_TO });
}
