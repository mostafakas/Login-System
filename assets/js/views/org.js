// Finance: the company structure, live. The chart is built from each person's direct manager; every manager's team
// shows what it costs, what it lost to deductions this month and who slipped the most. People, salaries and payroll
// are live listeners, so adding or editing an employee shows up at once; attendance is read once per month (and on
// "Refresh") because it is the heavy part.
import { L, esc, money, num, fmtMonth, fmtDate, addMonths, ym as ymOf, fmtMin } from '../core/utils.js';
import { toast, toastErr, modal, avatar, empty, bindActions, loader } from '../core/ui.js';
import { now, isHR, isAdmin } from '../core/session.js';
import { watch, query, col, where } from '../core/fb.js';
import { roleLabel } from '../core/policy.js';
import { activePeople, onDirectory, nameOf } from '../services/directory.js';
import { teamMonth } from '../services/reports.js';
import { activeAdvances } from '../services/payroll.js';
import { partLabel, PARTS } from '../services/salary.js';
import { buildTree, teamsOf, personMonth, groupStats, rankSlips, flatten } from '../services/org.js';
import { exportSheet } from './export.js';

const CONTRACT = { fulltime: ['دوام كامل', 'Full-time'], parttime: ['دوام جزئي', 'Part-time'], freelancer: ['فريلانسر', 'Freelancer'], intern: ['متدرب', 'Intern'] };
const contractLabel = (c) => { const x = CONTRACT[c] || CONTRACT.fulltime; return L(x[0], x[1]); };
// one color per department, in the order the departments appear
const HUES = ['#1b1bdb', '#12b76a', '#f79009', '#7a5af8', '#ee46bc', '#0ba5ec', '#f04438', '#66c61c', '#875bf7', '#15b79e'];
const VIEWS = [['chart', 'fa-sitemap', 'المخطط', 'Chart'], ['teams', 'fa-people-group', 'التيمز', 'Teams'], ['slips', 'fa-triangle-exclamation', 'الأكتر تقصيراً', 'Most slips'], ['table', 'fa-table', 'الجدول', 'Table']];
const LS_VIEW = 'am_org_view';

export default async function render(root) {
  let month = ymOf(now());
  let view = (() => { try { return localStorage.getItem(LS_VIEW) || 'chart'; } catch { return 'chart'; } })();
  if (!VIEWS.some(v => v[0] === view)) view = 'chart';
  let people = activePeople(), privs = null, items = [], att = null, advances = [], attErr = null, loadingAtt = true;
  const collapsed = new Set();
  const unsubs = [];

  root.innerHTML = `
    <div class="page-head"><div><h2>${L('الهيكل التنظيمي', 'Org chart')}</h2>
      <p>${L('الشركة كلها مبنية على «المدير المباشر» لكل موظف، ومعاها تكلفة كل تيم واستقطاعات الشهر. أي تعديل في الموظفين أو المرتبات بيظهر هنا على طول.', 'The whole company, built from each employee\'s direct manager, with each team\'s cost and the month\'s deductions. Any change to people or salaries shows here at once.')}</p></div>
      <div class="row gap-8"><button class="btn btn-icon" data-m="-1" aria-label="${L('الشهر اللي فات', 'Previous month')}"><i class="fas fa-chevron-right" data-flip></i></button><b id="ml" style="min-width:130px;text-align:center"></b><button class="btn btn-icon" data-m="1" aria-label="${L('الشهر الجاي', 'Next month')}"><i class="fas fa-chevron-left" data-flip></i></button></div></div>
    <div class="grid g-4 keep-2 mb-16" id="kpi"></div>
    <div class="row between mb-16" style="flex-wrap:wrap;gap:10px">
      <div class="seg" id="views" role="group">${VIEWS.map(([k, ic, ar, en]) => `<button data-v="${k}" class="${k === view ? 'on' : ''}"><i class="fas ${ic}"></i>${esc(L(ar, en))}</button>`).join('')}</div>
      <div class="row-wrap gap-8"><span class="xs muted" id="note"></span>
        <button class="btn btn-sm" data-action="refresh"><i class="fas fa-rotate-right"></i> ${L('تحديث الحضور', 'Refresh attendance')}</button>
        <button class="btn btn-sm" data-action="xls"><i class="fas fa-file-excel"></i> Excel</button></div>
    </div>
    <div id="body">${loader()}</div>`;

  // ---------- data ----------
  const privOf = (email) => (privs || []).find(x => x.id === email) || null;
  const itemOf = (email) => items.find(x => x.email === email) || null;
  let stats = new Map();
  const statOf = (email) => stats.get(email) || null;
  function compute() {
    stats = new Map(people.map(p => [p.email, personMonth({ person: p, priv: privOf(p.email), item: itemOf(p.email), att, advances })]));
  }
  async function loadAttendance() {
    loadingAtt = true; attErr = null; draw();
    const m = month;
    try {
      const [a, adv] = await Promise.all([teamMonth(m, { people: activePeople() }), activeAdvances(m).catch(() => [])]);
      if (m !== month) return;
      att = a; advances = adv;
    } catch (e) { if (m !== month) return; att = null; attErr = e; console.warn('org attendance', e); }
    loadingAtt = false; draw();
  }
  function watchMonth() {
    while (unsubs.length > 2) { try { unsubs.pop()(); } catch {} }
    items = [];
    unsubs.push(watch(query(col('payroll_items'), where('month', '==', month)), rows => { items = rows; draw(); }, () => { items = []; draw(); }));
  }
  unsubs.push(onDirectory(() => { const before = people.length; people = activePeople(); if (people.length !== before) loadAttendance(); else draw(); }));
  unsubs.push(watch(col('employees_private'), rows => { privs = rows; draw(); }, (e) => { privs = []; toastErr(e); draw(); }));

  // ---------- departments → colors ----------
  const hueOf = (() => { const map = new Map(); return (dept) => { const k = dept || '—'; if (!map.has(k)) map.set(k, HUES[map.size % HUES.length]); return map.get(k); }; })();

  // ---------- pieces ----------
  const commitTone = (c) => (c == null ? '' : c >= 95 ? 'ok' : c >= 85 ? 'warn' : 'bad');
  const dedBadge = (s) => (s && s.deductions > 0 ? `<span class="badge bad" title="${L('استقطاعات الشهر', 'Deductions this month')}"><i class="fas fa-minus"></i>${esc(money(s.deductions, false))}</span>` : '');
  const commitBadge = (s) => (s && s.commitment != null && s.tracked ? `<span class="badge ${commitTone(s.commitment)}" title="${L('نسبة الالتزام', 'Commitment')}">${num(s.commitment)}%</span>` : '');

  function nodeCard(n, team) {
    const p = n.person, s = statOf(p.email), hue = hueOf(p.department);
    const kids = n.children.length;
    return `<div class="org-node" style="--hue:${hue}" data-action="person" data-email="${esc(p.email)}" tabindex="0">
      <div class="org-top">${avatar(p, 'sm')}<div class="min0"><b class="truncate">${esc(p.name || p.email)}</b><span class="truncate">${esc(p.title || roleLabel(p.role))}</span></div></div>
      <div class="org-dept"><span class="org-dot"></span>${esc(p.department || L('بدون قسم', 'No department'))}</div>
      <div class="org-money"><b class="num">${esc(money(s ? s.cost : 0, false))}</b>${dedBadge(s)}${commitBadge(s)}</div>
      ${team ? `<div class="org-team" title="${L('التيم شامل التيمز اللي تحته', 'Team including the teams under it')}"><i class="fas fa-people-group"></i> ${num(team.all.length - 1)} · <b class="num">${esc(money(team.allStats.cost, false))}</b></div>` : ''}
      ${kids ? `<button class="org-toggle" data-action="toggle" data-email="${esc(p.email)}" aria-label="${collapsed.has(p.email) ? L('افتح', 'Expand') : L('اقفل', 'Collapse')}">${collapsed.has(p.email) ? `+${num(kids)}` : '<i class="fas fa-minus"></i>'}</button>` : ''}
    </div>`;
  }
  function treeHTML(nodes, teamBy) {
    return `<ul>${nodes.map(n => `<li>${nodeCard(n, teamBy.get(n.person.email))}${n.children.length && !collapsed.has(n.person.email) ? treeHTML(n.children, teamBy) : ''}</li>`).join('')}</ul>`;
  }

  function memberRow(p, worstEmail, isLead) {
    const s = statOf(p.email) || {};
    return `<tr class="${p.email === worstEmail ? 'org-worst' : ''}" data-action="person" data-email="${esc(p.email)}" style="cursor:pointer">
      <td><div class="person">${avatar(p, 'sm')}<div><b>${esc(p.name || p.email)}${isLead ? ` <span class="badge brand">${L('الليدر', 'Lead')}</span>` : ''}</b><span>${esc(p.title || roleLabel(p.role))}</span></div></div></td>
      <td class="num">${esc(money(s.cost || 0, false))}</td>
      <td class="num">${s.deductions > 0 ? `<span style="color:var(--bad)">${esc(money(s.deductions, false))}</span>` : '0'}</td>
      <td class="num">${s.tracked && s.commitment != null ? `<span class="badge ${commitTone(s.commitment)}">${num(s.commitment)}%</span>` : '—'}</td>
      <td class="num">${num(s.absent || 0)}</td>
      <td class="num">${s.lateMinutes ? esc(fmtMin(s.lateMinutes)) : '0'}</td></tr>`;
  }
  function teamCard(t) {
    const st = t.stats, worst = st.worst;
    const hue = hueOf(t.leader.department);
    return `<div class="card org-team-card" style="--hue:${hue}">
      <div class="card-head"><div class="row gap-8 min0">${avatar(t.leader, 'sm')}<div class="min0"><h3 class="truncate">${esc(L('تيم ', 'Team ') + (t.leader.name || t.leader.email))}</h3><span class="xs muted">${esc(t.leader.department || '')} · ${num(t.members.length)} ${L('تحته مباشرة', 'direct reports')}</span></div></div>
        <span class="badge" style="background:color-mix(in srgb, var(--hue) 14%, transparent);color:var(--hue)">${esc(roleLabel(t.leader.role))}</span></div>
      <div class="org-team-kpis">
        <div><span>${L('تكلفة التيم', 'Team cost')}</span><b class="num">${esc(money(st.cost, false))}</b></div>
        <div><span>${L('الاستقطاعات', 'Deductions')}</span><b class="num" style="color:${st.deductions ? 'var(--bad)' : 'inherit'}">${esc(money(st.deductions, false))}</b></div>
        <div><span>${L('الصافي', 'Net')}</span><b class="num">${esc(money(st.net, false))}</b></div>
        <div><span>${L('الالتزام', 'Commitment')}</span><b class="num">${st.commitment == null ? '—' : num(st.commitment) + '%'}</b></div>
      </div>
      ${t.all.length - 1 > t.members.length ? `<div class="xs muted" style="padding:0 20px 10px">${L('شامل التيمز اللي تحته', 'With the teams under it')}: ${num(t.all.length - 1)} ${L('شخص', 'people')} · <b class="num">${esc(money(t.allStats.cost, false))}</b></div>` : ''}
      ${worst ? `<div class="alert warn" style="margin:0 20px 12px"><i class="fas fa-triangle-exclamation"></i><div>${L('أكتر واحد مقصر:', 'Slipped the most:')} <b>${esc(worst.p.name || worst.p.email)}</b> · ${slipText(worst.s)}</div></div>` : ''}
      <div class="table-wrap"><table class="table"><thead><tr><th>${L('الشخص', 'Person')}</th><th class="num">${L('التكلفة', 'Cost')}</th><th class="num">${L('استقطاعات', 'Deductions')}</th><th class="num">${L('الالتزام', 'Commit.')}</th><th class="num">${L('غياب', 'Absent')}</th><th class="num">${L('تأخير', 'Late')}</th></tr></thead>
        <tbody>${memberRow(t.leader, worst && worst.p.email, true)}${t.members.map(p => memberRow(p, worst && worst.p.email, false)).join('')}</tbody></table></div>
    </div>`;
  }
  function slipText(s) {
    const bits = [];
    if (s.penalty > 0) bits.push(`${L('خصم', 'lost')} ${esc(money(s.penalty))}`);
    if (s.absent) bits.push(`${num(s.absent)} ${L('غياب', 'absent')}`);
    if (s.lateMinutes) bits.push(`${L('تأخير', 'late')} ${esc(fmtMin(s.lateMinutes))} ${L('في', 'over')} ${num(s.lateDays)} ${L('يوم', 'days')}`);
    if (s.tracked && s.commitment != null) bits.push(`${L('التزام', 'commitment')} ${num(s.commitment)}%`);
    return bits.join(' · ');
  }

  // ---------- draw ----------
  function draw() {
    root.querySelector('#ml').textContent = fmtMonth(month);
    if (privs === null) return;
    compute();
    const roots = buildTree(people);
    const teams = teamsOf(roots).map(t => ({ ...t, stats: groupStats([t.leader, ...t.members], statOf), allStats: groupStats(t.all, statOf) }));
    const teamBy = new Map(teams.map(t => [t.leader.email, t]));
    const all = groupStats(people, statOf);

    const k = (icon, cls, label, v, sub = '') => `<div class="card stat"><div class="label"><span class="icon-tile ${cls}"><i class="fas ${icon}"></i></span>${esc(label)}</div><div class="value" style="font-size:20px">${v}</div>${sub ? `<div class="xs muted mt-4">${sub}</div>` : ''}</div>`;
    root.querySelector('#kpi').innerHTML =
      k('fa-users', '', L('عدد الأفراد', 'Headcount'), `<span class="num">${num(people.length)}</span>`, `${num(teams.length)} ${L('تيم', 'teams')}`) +
      k('fa-sack-dollar', 'info', L('التكلفة الشهرية', 'Monthly cost'), `<span class="num">${esc(money(all.cost))}</span>`, L('المرتب الكامل بالبدلات والانتظام والـ KPI', 'Full salary with allowances, regularity and KPI')) +
      k('fa-minus', 'bad', L('استقطاعات الشهر', 'Deductions this month'), `<span class="num">${esc(money(all.deductions))}</span>`, `${L('منها تقصير', 'from slips')} ${esc(money(all.penalty, false))}`) +
      k('fa-chart-simple', commitTone(all.commitment) || 'ok', L('متوسط الالتزام', 'Avg. commitment'), all.commitment == null ? '—' : `<span class="num">${num(all.commitment)}%</span>`, `${num(all.absent)} ${L('يوم غياب', 'days absent')}`);

    const live = [...stats.values()].some(s => s.source === 'live');
    root.querySelector('#note').innerHTML = loadingAtt ? `<span class="spinner" style="width:12px;height:12px;display:inline-block;vertical-align:middle"></span> ${L('بيحسب الحضور…', 'Reading attendance…')}`
      : attErr ? `<span style="color:var(--bad)"><i class="fas fa-triangle-exclamation"></i> ${L('تعذّر قراية الحضور، الاستقطاعات من الرواتب المحسوبة بس', 'Could not read attendance; deductions come from calculated payroll only')}</span>`
      : live ? `<i class="fas fa-circle-info"></i> ${L('الاستقطاعات تقديرية من الحضور لحد ما الرواتب تتعتمد', 'Deductions are estimated from attendance until payroll is approved')}` : '';

    const body = root.querySelector('#body');
    if (!people.length) { body.innerHTML = `<div class="card">${empty('fa-sitemap', L('مفيش موظفين لسه', 'No employees yet'))}</div>`; return; }

    if (view === 'chart') {
      const depts = [...new Set(people.map(p => p.department || '—'))];
      depts.forEach(hueOf);
      body.innerHTML = `<div class="card"><div class="card-head"><div class="row-wrap gap-8">${depts.map(d => `<span class="org-legend" style="--hue:${hueOf(d === '—' ? '' : d)}"><span class="org-dot"></span>${esc(d === '—' ? L('بدون قسم', 'No department') : d)} <b class="num">${num(people.filter(p => (p.department || '—') === d).length)}</b></span>`).join('')}</div>
        <div class="row gap-8"><button class="btn btn-sm btn-ghost" data-action="expand">${L('افتح الكل', 'Expand all')}</button><button class="btn btn-sm btn-ghost" data-action="collapse">${L('اقفل التيمز', 'Collapse teams')}</button></div></div>
        <div class="org-scroll"><div class="org-tree">${treeHTML(roots, teamBy)}</div></div></div>`;
    } else if (view === 'teams') {
      body.innerHTML = teams.length ? `<div class="grid g-2 org-teams">${teams.sort((a, b) => b.stats.cost - a.stats.cost).map(teamCard).join('')}</div>`
        : `<div class="card">${empty('fa-people-group', L('مفيش تيمز', 'No teams'), L('حدد «المدير المباشر» لكل موظف من ملفه.', 'Set each employee\'s direct manager in their file.'))}</div>`;
    } else if (view === 'slips') {
      const rows = rankSlips(people.map(p => ({ p, s: statOf(p.email) })));
      body.innerHTML = `<div class="card"><div class="card-head"><h3>${L('ترتيب التقصير', 'Slip ranking')} — ${esc(fmtMonth(month))}</h3><span class="xs muted">${L('بالترتيب: خصم التقصير، وبعدين نسبة الالتزام، وبعدين دقايق التأخير', 'Ordered by slip deductions, then commitment, then minutes late')}</span></div>
        ${rows.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>#</th><th>${L('الشخص', 'Person')}</th><th>${L('التيم', 'Team')}</th><th class="num">${L('خصم التقصير', 'Slip deductions')}</th><th class="num">${L('الالتزام', 'Commitment')}</th><th class="num">${L('غياب', 'Absent')}</th><th class="num">${L('أيام تأخير', 'Late days')}</th><th class="num">${L('دقايق تأخير', 'Late minutes')}</th><th class="num">${L('انصراف مبكر', 'Early leave')}</th></tr></thead><tbody>
          ${rows.map((x, i) => `<tr data-action="person" data-email="${esc(x.p.email)}" style="cursor:pointer"><td class="num">${i < 3 ? `<span class="badge bad">${num(i + 1)}</span>` : num(i + 1)}</td>
            <td><div class="person">${avatar(x.p, 'sm')}<div><b>${esc(x.p.name || x.p.email)}</b><span>${esc(x.p.title || '')}</span></div></div></td>
            <td>${x.p.leaderEmail ? esc(L('تيم ', 'Team ') + nameOf(x.p.leaderEmail)) : '—'}</td>
            <td class="num" style="color:var(--bad)"><b>${esc(money(x.s.penalty, false))}</b></td>
            <td class="num">${x.s.tracked && x.s.commitment != null ? `<span class="badge ${commitTone(x.s.commitment)}">${num(x.s.commitment)}%</span>` : '—'}</td>
            <td class="num">${num(x.s.absent)}</td><td class="num">${num(x.s.lateDays)}</td><td class="num">${esc(fmtMin(x.s.lateMinutes))}</td><td class="num">${x.s.earlyMinutes ? esc(fmtMin(x.s.earlyMinutes)) : '0'}</td></tr>`).join('')}
        </tbody></table></div>` : empty('fa-face-smile', loadingAtt ? L('بيحسب…', 'Calculating…') : L('مفيش تقصير الشهر ده', 'No slips this month'))}</div>`;
    } else {
      body.innerHTML = tableHTML(roots);
    }
  }

  /** Everyone grouped by team: a person sits in their manager's team; whoever has no manager is "Top management". */
  function groups(roots) {
    const out = [];
    const tops = roots.map(n => n.person);
    if (tops.length) out.push({ title: L('الإدارة العليا', 'Top management'), people: tops });
    flatten(roots).filter(n => n.children.length).forEach(n => out.push({ title: `${L('تيم ', 'Team ')}${n.person.name || n.person.email}${n.person.department ? ` · ${n.person.department}` : ''}`, people: n.children.map(c => c.person) }));
    return out;
  }
  function tableHTML(roots) {
    const head = `<tr><th>${L('الموظف', 'Employee')}</th><th>${L('الدور', 'Role')}</th><th>${L('القسم', 'Department')}</th><th>${L('التعاقد', 'Contract')}</th><th>${L('تاريخ البدء', 'Start date')}</th>${PARTS.map(p => `<th class="num">${esc(partLabel(p))}</th>`).join('')}<th class="num">${L('التكلفة الشهرية', 'Monthly cost')}</th><th class="num">${L('الاستقطاعات', 'Deductions')}</th><th class="num">${L('الصافي', 'Net')}</th></tr>`;
    return groups(roots).map(g => {
      const st = groupStats(g.people, statOf);
      return `<div class="card mb-16"><div class="card-head"><h3>${esc(g.title)}</h3><div class="row-wrap gap-8"><span class="badge">${num(g.people.length)} ${L('شخص', 'people')}</span><span class="badge info">${L('التكلفة', 'Cost')} ${esc(money(st.cost, false))}</span>${st.deductions ? `<span class="badge bad">${L('استقطاعات', 'Deductions')} ${esc(money(st.deductions, false))}</span>` : ''}</div></div>
        <div class="table-wrap"><table class="table"><thead>${head}</thead><tbody>${g.people.map(p => {
          const s = statOf(p.email) || { parts: {} };
          return `<tr data-action="person" data-email="${esc(p.email)}" style="cursor:pointer"><td><div class="person">${avatar(p, 'sm')}<div><b>${esc(p.name || p.email)}</b><span>${esc(p.title || '')}</span></div></div></td>
            <td><span class="badge brand">${esc(roleLabel(p.role))}</span></td><td>${esc(p.department || '—')}</td><td>${esc(contractLabel(s.contract))}</td><td>${p.hireDate ? esc(fmtDate(p.hireDate)) : '—'}</td>
            ${PARTS.map(k => `<td class="num">${esc(money(s.parts[k] || 0, false))}</td>`).join('')}
            <td class="num"><b>${esc(money(s.cost || 0, false))}</b></td><td class="num">${s.deductions ? `<span style="color:var(--bad)">${esc(money(s.deductions, false))}</span>` : '0'}</td><td class="num">${esc(money(s.net || 0, false))}</td></tr>`;
        }).join('')}</tbody><tfoot><tr><td colspan="9"><b>${L('الإجمالي', 'Total')}</b></td><td class="num"><b>${esc(money(st.cost, false))}</b></td><td class="num"><b>${esc(money(st.deductions, false))}</b></td><td class="num"><b>${esc(money(st.net, false))}</b></td></tr></tfoot></table></div></div>`;
    }).join('');
  }

  // ---------- one person ----------
  function openPerson(email) {
    const p = people.find(x => x.email === email); if (!p) return;
    const s = statOf(email) || { parts: {} };
    const it = s.item;
    const line = (label, v, bad = false) => `<div class="row between"><span class="muted">${esc(label)}</span><b class="num"${bad ? ' style="color:var(--bad)"' : ''}>${v}</b></div>`;
    const reports = people.filter(x => x.leaderEmail === email);
    const ded = it ? [[L('تأخير', 'Lateness'), it.lateDeduction], [L('غياب', 'Absence'), (it.absenceDeduction || 0) + (it.unpaidDeduction || 0)], [L('أونلاين مرفوض', 'Rejected remote'), it.remoteDeduction], [L('انصراف مبكر', 'Early leave'), it.earlyDeduction], [L('قسط سلفة', 'Advance'), it.advance], [L('ثابتة', 'Fixed'), it.fixed], [L('أخرى', 'Other'), (it.otherDeductions || []).reduce((t, d) => t + (Number(d.amount) || 0), 0)]].filter(x => Number(x[1]) > 0) : [];
    modal({
      title: p.name || p.email, icon: 'fa-id-badge', size: 'narrow',
      body: `<div class="col gap-16">
        <div class="row gap-8">${avatar(p, 'lg')}<div><b>${esc(p.title || '')}</b><div class="xs muted">${esc(roleLabel(p.role))} · ${esc(p.department || L('بدون قسم', 'No department'))}</div>
          <div class="xs muted">${L('المدير المباشر:', 'Manager:')} ${p.leaderEmail ? esc(nameOf(p.leaderEmail)) : '—'} · ${esc(contractLabel(s.contract))}${p.hireDate ? ` · ${L('من', 'since')} ${esc(fmtDate(p.hireDate))}` : ''}</div></div></div>
        <div class="card card-pad col gap-8"><b>${L('التكلفة الشهرية', 'Monthly cost')}</b>
          ${PARTS.map(k => line(partLabel(k), esc(money(s.parts[k] || 0, false)))).join('')}
          ${line(L('الإجمالي', 'Total'), esc(money(s.cost || 0)))}</div>
        <div class="card card-pad col gap-8"><b>${L('شهر', 'Month')} ${esc(fmtMonth(month))}${s.source === 'live' ? ` <span class="badge warn">${L('تقديري', 'Estimate')}</span>` : s.source === 'final' ? ` <span class="badge ok">${L('معتمد', 'Approved')}</span>` : ''}</b>
          ${ded.length ? ded.map(([n, v]) => line(n, esc(money(v, false)), true)).join('') : `<span class="muted">${L('مفيش استقطاعات', 'No deductions')}</span>`}
          ${line(L('إجمالي الاستقطاعات', 'Total deductions'), esc(money(s.deductions || 0)))}
          ${line(L('الصافي', 'Net'), esc(money(s.net || 0)))}
          ${s.tracked ? `<div class="row-wrap gap-8 mt-8"><span class="badge ${commitTone(s.commitment)}">${L('التزام', 'Commitment')} ${num(s.commitment)}%</span><span class="badge">${num(s.present)} ${L('يوم حضور', 'days present')}</span><span class="badge">${num(s.absent)} ${L('غياب', 'absent')}</span><span class="badge">${L('تأخير', 'Late')} ${esc(fmtMin(s.lateMinutes))}</span></div>` : `<span class="xs muted">${L('الحضور مش متتبع للشخص ده', 'Attendance is not tracked for this person')}</span>`}</div>
        ${reports.length ? `<div><b>${L('تحته مباشرة', 'Direct reports')} (${num(reports.length)})</b><div class="row-wrap gap-8 mt-8">${reports.map(r => `<span class="badge">${esc(r.name || r.email)}</span>`).join('')}</div></div>` : ''}
      </div>`,
      foot: `${isHR() ? `<a class="btn" href="#/employees/${encodeURIComponent(email)}" data-close><i class="fas fa-id-card"></i> ${L('ملف الموظف', 'Employee file')}</a>` : ''}${isAdmin() ? `<a class="btn" href="#/stats/${encodeURIComponent(email)}" data-close><i class="fas fa-chart-line"></i> ${L('الأداء', 'Performance')}</a>` : ''}<button class="btn btn-primary" data-close>${L('تمام', 'Done')}</button>`
    });
  }

  // ---------- Excel ----------
  function exportXls() {
    const roots = buildTree(people);
    const teamName = (p) => (p.leaderEmail ? `${L('تيم ', 'Team ')}${nameOf(p.leaderEmail)}` : L('الإدارة العليا', 'Top management'));
    const staff = flatten(roots).map(n => n.person).map(p => {
      const s = statOf(p.email) || { parts: {} };
      return {
        [L('الاسم', 'Name')]: p.name || p.email, [L('المسمى', 'Title')]: p.title || '', [L('الدور', 'Role')]: roleLabel(p.role), [L('القسم', 'Department')]: p.department || '',
        [L('التيم', 'Team')]: teamName(p), [L('المدير المباشر', 'Manager')]: p.leaderEmail ? nameOf(p.leaderEmail) : '', [L('التعاقد', 'Contract')]: contractLabel(s.contract), [L('تاريخ البدء', 'Start date')]: p.hireDate || '',
        ...Object.fromEntries(PARTS.map(k => [partLabel(k), s.parts[k] || 0])), [L('التكلفة الشهرية', 'Monthly cost')]: s.cost || 0,
        [L('الاستقطاعات', 'Deductions')]: s.deductions || 0, [L('منها تقصير', 'Of which slips')]: s.penalty || 0, [L('الصافي', 'Net')]: s.net || 0,
        [L('الالتزام %', 'Commitment %')]: s.tracked ? s.commitment : '', [L('غياب', 'Absent')]: s.absent || 0, [L('دقايق تأخير', 'Late minutes')]: s.lateMinutes || 0
      };
    });
    const teams = teamsOf(roots).map(t => {
      const st = groupStats([t.leader, ...t.members], statOf), sa = groupStats(t.all, statOf);
      return { [L('التيم', 'Team')]: `${L('تيم ', 'Team ')}${t.leader.name || t.leader.email}`, [L('القسم', 'Department')]: t.leader.department || '', [L('العدد', 'People')]: st.count,
        [L('التكلفة', 'Cost')]: st.cost, [L('الاستقطاعات', 'Deductions')]: st.deductions, [L('الصافي', 'Net')]: st.net, [L('الالتزام %', 'Commitment %')]: st.commitment ?? '',
        [L('أكتر مقصر', 'Slipped most')]: st.worst ? (st.worst.p.name || st.worst.p.email) : '', [L('العدد شامل التيمز التابعة', 'People incl. sub-teams')]: sa.count, [L('التكلفة شامل التيمز التابعة', 'Cost incl. sub-teams')]: sa.cost };
    });
    exportSheet(`org_${month}`, [{ name: L('الموظفين', 'Staff'), rows: staff }, { name: L('التيمز', 'Teams'), rows: teams }]);
  }

  // ---------- events ----------
  root.querySelector('#views').onclick = (e) => {
    const b = e.target.closest('[data-v]'); if (!b) return;
    view = b.dataset.v; try { localStorage.setItem(LS_VIEW, view); } catch {}
    root.querySelectorAll('#views [data-v]').forEach(x => x.classList.toggle('on', x === b));
    draw();
  };
  root.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { month = addMonths(month, Number(b.dataset.m)); att = null; watchMonth(); loadAttendance(); });
  bindActions(root, {
    person: (d) => openPerson(d.email),
    toggle: (d) => { collapsed.has(d.email) ? collapsed.delete(d.email) : collapsed.add(d.email); draw(); },
    expand: () => { collapsed.clear(); draw(); },
    // keep the top of the company open, fold every team under it
    collapse: () => { collapsed.clear(); buildTree(people).forEach(r => flatten(r.children).forEach(n => { if (n.children.length) collapsed.add(n.person.email); })); draw(); },
    refresh: () => { window.dispatchEvent(new Event('am:data-changed')); loadAttendance(); toast(L('بيحدّث الحضور…', 'Refreshing attendance…'), '', 'info'); },
    xls: () => exportXls()
  });
  root.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('.org-node')) openPerson(e.target.dataset.email); });

  watchMonth();
  loadAttendance();
  draw();
  return () => unsubs.forEach(f => { try { f(); } catch {} });
}
