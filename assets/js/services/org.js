// Company structure: the reporting tree (from each person's direct manager), the teams under every manager, and
// what each person costs and lost in a month. Salaries come from employees_private, the month's deductions from
// payroll_items; a salary that is not calculated yet (or still pending) is priced live from attendance with the
// same rules as payroll, so the numbers follow every change without anyone pressing "Recalculate".
import { computeItem, payStatus } from './payroll.js';
import { violationsFrom, payParts } from './salary.js';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Reporting tree: [{ person, children: [...] }]. A manager who is missing or suspended makes the person a root. */
export function buildTree(people) {
  const by = new Map(people.map(p => [p.email, { person: p, children: [] }]));
  const roots = [];
  people.forEach(p => {
    const boss = p.leaderEmail && p.leaderEmail !== p.email ? by.get(p.leaderEmail) : null;
    // a loop in the data (A → B → A) would hide both people: whoever closes the loop becomes a root
    let x = boss, seen = new Set([p.email]), loop = false;
    while (x && !loop) { if (seen.has(x.person.email)) loop = true; seen.add(x.person.email); x = x.person.leaderEmail ? by.get(x.person.leaderEmail) : null; }
    if (boss && !loop) boss.children.push(by.get(p.email)); else roots.push(by.get(p.email));
  });
  const sort = (n) => { n.children.sort((a, b) => (b.children.length - a.children.length) || String(a.person.name || a.person.email).localeCompare(String(b.person.name || b.person.email), 'ar')); n.children.forEach(sort); };
  roots.forEach(sort);
  roots.sort((a, b) => b.children.length - a.children.length);
  return roots;
}
export const subtree = (node) => [node.person, ...node.children.flatMap(subtree)];
export function flatten(roots, out = []) { roots.forEach(n => { out.push(n); flatten(n.children, out); }); return out; }

/** One team per manager: the manager and their direct reports, plus everyone below them for the "with sub-teams" total */
export function teamsOf(roots) {
  return flatten(roots).filter(n => n.children.length).map(n => ({
    leader: n.person, node: n, members: n.children.map(c => c.person), all: subtree(n),
    name: n.person.department || n.person.name || n.person.email
  }));
}

/**
 * The month for each person: { cost, parts, contract, deductions, penalty, net, absent, lateDays, lateMinutes, commitment,
 * present, source: 'final' (approved or later, frozen) | 'live' | 'none' }. penalty = what attendance cost them (lateness, absence, rejected remote,
 * early leave, unpaid leave); deductions also count advances, fixed and other deductions.
 */
export function personMonth({ person: p, priv, item, att, advances }) {
  const parts = payParts(priv || {});
  const contract = (priv && priv.contract) || 'fulltime';
  const pm = att ? att.people.find(x => x.person.email === p.email) : null;
  let it = null, source = 'none';
  if (item && payStatus(item) !== 'pending') { it = item; source = 'final'; }
  else if (priv || item) {   // a freelancer goes through payroll too: full salary, no attendance deductions
    const violations = pm && pm.rows ? violationsFrom(pm.rows, pm.requests) : [];
    it = computeItem({ person: p, priv: priv || {}, totals: pm ? pm.totals : null, violations, advances: (advances || []).filter(a => a.email === p.email), manual: item || {} });
    source = 'live';
  }
  const t = pm ? pm.totals : (it && it.att) || null;
  const penalty = it ? r2((it.lateDeduction || 0) + (it.absenceDeduction || 0) + (it.remoteDeduction || 0) + (it.earlyDeduction || 0) + (it.unpaidDeduction || 0)) : 0;
  return {
    parts, cost: parts.total, contract, item: it, source,
    deductions: it ? r2(it.deductions) : 0, penalty, net: it ? r2(it.net) : parts.total, gross: it ? r2(it.gross) : parts.total,
    absent: t ? t.absent || 0 : 0, lateDays: t ? t.lateDays || 0 : 0, lateMinutes: t ? t.lateMinutes || 0 : 0,
    earlyMinutes: t ? t.earlyMinutes || 0 : 0, present: t ? t.present || 0 : 0, commitment: t && t.commitment != null ? t.commitment : null,
    tracked: !!pm
  };
}

/** Totals of a group of people, and who in it slipped the most (biggest attendance penalty, then lowest commitment) */
export function groupStats(people, statOf) {
  const rows = people.map(p => ({ p, s: statOf(p.email) })).filter(x => x.s);
  const sum = (k) => r2(rows.reduce((t, x) => t + (Number(x.s[k]) || 0), 0));
  const tracked = rows.filter(x => x.s.commitment != null && x.s.tracked);
  const worst = worstOf(rows);
  return {
    count: rows.length, cost: sum('cost'), deductions: sum('deductions'), penalty: sum('penalty'), net: sum('net'),
    absent: sum('absent'), lateMinutes: sum('lateMinutes'),
    commitment: tracked.length ? Math.round(tracked.reduce((t, x) => t + x.s.commitment, 0) / tracked.length) : null,
    worst
  };
}
export const slipScore = (s) => [s.penalty || 0, -(s.commitment == null ? 100 : s.commitment), s.lateMinutes || 0];
export function rankSlips(rows) {
  // a freelancer is not held to attendance, so never ranked as slipping
  return rows.filter(x => x.s && x.s.contract !== 'freelancer' && (x.s.penalty > 0 || x.s.absent > 0 || x.s.lateMinutes > 0)).sort((a, b) => {
    const A = slipScore(a.s), B = slipScore(b.s);
    return (B[0] - A[0]) || (B[1] - A[1]) || (B[2] - A[2]);
  });
}
const worstOf = (rows) => rankSlips(rows)[0] || null;
