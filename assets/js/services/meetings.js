// Meetings: switching to "In a meeting" names who it is with. Every colleague picked gets an invitation
// (meeting_invites/{id}); accepting it switches their own status to "In a meeting" with the same people, so each
// team sees who is in a meeting with whom. Declining takes them off the host's list.
import { db, doc, col, watch, query, where, writeBatch, updateDoc, serverTimestamp, toMs, list } from '../core/fb.js';
import { session, now } from '../core/session.js';
import { dayKey } from '../core/policy.js';
import { L } from '../core/utils.js';
import { userError } from '../core/ui.js';
import { changeStatus } from './attendance.js';
import { person, nameOf } from './directory.js';
import { track } from './activity.js';

export const INVITE_TTL = 2 * 3600000;          // an unanswered invitation is ignored after two hours
const clean = (people) => [...new Set((people || []).map(e => String(e || '').trim().toLowerCase()))].filter(e => e && e !== session.email).slice(0, 20);

/** my day is running today (a status can only change on a running day) */
export function startedToday() {
  const p = session.profile || {};
  return p.dayKey === dayKey(now()) && !!p.status && p.status !== 'Offline';
}
const isLive = (p, meetingId) => !!p && p.status === 'Meeting' && p.meetingId === meetingId && p.dayKey === dayKey(now());

function invite(b, to, m) {
  b.set(doc(col('meeting_invites')), {
    from: session.email, fromName: nameOf(session.email), to, with: m.meetingWith, external: m.meetingExternal, topic: m.meetingTopic,
    meetingId: m.meetingId, status: 'pending', fromSeen: false, at: serverTimestamp(), atMs: now()
  });
}

/** Start a meeting: my status becomes "In a meeting" with these people, and each of them is invited. */
export async function startMeeting({ people = [], external = '', topic = '' }) {
  const withList = clean(people);
  const ext = String(external || '').trim().slice(0, 80), tp = String(topic || '').trim().slice(0, 120);
  if (!withList.length && !ext) throw userError('اختار الشخص اللي هتعمل معاه الميتنج.', 'Pick who the meeting is with.');
  if (!startedToday()) throw userError('ابدأ يومك الأول.', 'Start your day first.');
  await cancelMyInvites();
  const m = { meetingWith: withList, meetingExternal: ext, meetingTopic: tp, meetingId: `${session.email}_${now().toString(36)}` };
  await changeStatus(session.email, 'Meeting', session.email, m);
  if (withList.length) { const b = writeBatch(db); withList.forEach(to => invite(b, to, m)); await b.commit(); }
  track('meeting.start', { target: withList.map(nameOf).concat(ext ? [ext] : []).join('، '), detail: tp });
  return m.meetingId;
}

/** Already in my meeting: add people (they get invitations) / change the outside party or topic */
export async function updateMeeting({ people = [], external = '', topic = '' }) {
  const me = person(session.email) || session.profile || {};
  if (me.status !== 'Meeting' || !me.meetingId) return startMeeting({ people, external, topic });
  const before = me.meetingWith || [];
  const withList = clean(people);
  const ext = String(external || '').trim().slice(0, 80), tp = String(topic || '').trim().slice(0, 120);
  if (!withList.length && !ext) throw userError('اختار الشخص اللي هتعمل معاه الميتنج.', 'Pick who the meeting is with.');
  const m = { meetingWith: withList, meetingExternal: ext, meetingTopic: tp, meetingId: me.meetingId };
  const b = writeBatch(db);
  b.update(doc(db, 'users', session.email), m);
  withList.filter(e => !before.includes(e)).forEach(to => invite(b, to, m));
  await b.commit();
  // people taken off the list: their pending invitation is withdrawn
  const gone = before.filter(e => !withList.includes(e));
  if (gone.length) await cancelMyInvites(gone);
}

/** Withdraw my pending invitations (all of them, or only to these people) */
export async function cancelMyInvites(onlyTo = null) {
  const rows = await list(query(col('meeting_invites'), where('from', '==', session.email), where('status', '==', 'pending'))).catch(() => []);
  const todo = rows.filter(r => !onlyTo || onlyTo.includes(r.to));
  if (!todo.length) return;
  const b = writeBatch(db);
  todo.forEach(r => b.update(doc(db, 'meeting_invites', r.id), { status: 'cancelled', fromSeen: true }));
  await b.commit().catch(e => console.warn('cancel invites', e && e.message));
}

/** Invitations waiting for my answer (newest first) */
export const watchIncoming = (cb) => watch(query(col('meeting_invites'), where('to', '==', session.email), where('status', '==', 'pending')),
  rows => cb(rows.filter(r => (toMs(r.at) || r.atMs || now()) > now() - INVITE_TTL).sort((a, b) => (b.atMs || 0) - (a.atMs || 0))), () => cb([]));
/** Answers to my invitations I have not seen yet */
export const watchAnswers = (cb) => watch(query(col('meeting_invites'), where('from', '==', session.email), where('fromSeen', '==', false)), cb, () => cb([]));
/** The invitations of one of my meetings (to show who accepted) */
export const watchMeetingInvites = (meetingId, cb) => watch(query(col('meeting_invites'), where('from', '==', session.email), where('meetingId', '==', meetingId)), cb, () => cb([]));

/** Accept: my status becomes "In a meeting" with the host and the others invited */
export async function acceptInvite(inv) {
  if (!startedToday()) throw userError('ابدأ يومك الأول من «يومي»، وبعدين اقبل الميتنج.', 'Start your day on "My day" first, then accept.');
  const host = person(inv.from);
  if (!isLive(host, inv.meetingId)) {
    await updateDoc(doc(db, 'meeting_invites', inv.id), { status: 'expired', answeredAt: serverTimestamp() }).catch(() => {});
    throw userError('الميتنج ده خلص.', 'This meeting has already ended.');
  }
  const mine = session.profile || {};
  if (mine.meetingId && String(mine.meetingId).startsWith(session.email + '_')) await cancelMyInvites();   // leaving my own meeting
  const others = (host.meetingWith || inv.with || []).filter(e => e !== session.email);
  await changeStatus(session.email, 'Meeting', session.email, { meetingWith: [inv.from, ...others], meetingExternal: host.meetingExternal || inv.external || '', meetingTopic: host.meetingTopic || inv.topic || '', meetingId: inv.meetingId });
  await updateDoc(doc(db, 'meeting_invites', inv.id), { status: 'accepted', answeredAt: serverTimestamp() });
  track('meeting.accept', { target: nameOf(inv.from) });
}
export const declineInvite = (inv) => updateDoc(doc(db, 'meeting_invites', inv.id), { status: 'declined', answeredAt: serverTimestamp() });

/** The host takes in an answer: someone who declined leaves my list; the answer is marked seen. */
export async function settleAnswer(inv) {
  const me = person(session.email) || session.profile || {};
  if (inv.status === 'declined' && me.meetingId === inv.meetingId && (me.meetingWith || []).includes(inv.to)) {
    await updateDoc(doc(db, 'users', session.email), { meetingWith: (me.meetingWith || []).filter(e => e !== inv.to) }).catch(e => console.warn('meeting', e && e.message));
  }
  await updateDoc(doc(db, 'meeting_invites', inv.id), { fromSeen: true }).catch(() => {});
}

export const inviteText = (inv) => {
  const others = (inv.with || []).filter(e => e !== session.email).map(e => String(nameOf(e)).split(' ')[0]);
  if (inv.external) others.push(inv.external);
  return [inv.topic, others.length ? L(`ومعاكم: ${others.join('، ')}`, `also: ${others.join(', ')}`) : ''].filter(Boolean).join(' · ');
};
