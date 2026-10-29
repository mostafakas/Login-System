// "Overtime task": a leader (for their team), a project manager or the admin gives an employee a task with allotted time —
// the days it is worked on and the time of each day (hours, minutes, seconds) — and its steps. The employee accepts it
// from the dashboard (see services/overtime.js).
import { L, esc, addDays, ymd } from '../core/utils.js';
import { toast, toastErr, modal, busy } from '../core/ui.js';
import { session, now } from '../core/session.js';
import { PRIORITY, assignable } from '../services/tasks.js';
import { createOvertimeTask, otPlanMs, fmtHMS } from '../services/overtime.js';

/** people I may give overtime to: the same as tasks, but never myself */
export const overtimeAssignable = () => assignable().filter(p => p.email !== session.email);
export const canOfferOvertime = () => overtimeAssignable().length > 0;

const parts = (ms) => { const s = Math.round((Number(ms) || 0) / 1000); return { h: Math.floor(s / 3600), m: Math.floor(s % 3600 / 60), s: s % 60 }; };
const toMs = (h, m, s) => ((Number(h) || 0) * 3600 + (Number(m) || 0) * 60 + (Number(s) || 0)) * 1000;
/** hours / minutes / seconds inputs for one time value */
const hms = (ms, attrs = '') => { const p = parts(ms); return `<input class="input num" type="number" min="0" max="16" step="1" data-t="h" value="${p.h}" style="width:70px" ${attrs}><span class="muted small">${L('س', 'h')}</span>
  <input class="input num" type="number" min="0" max="59" step="1" data-t="m" value="${p.m}" style="width:70px" ${attrs}><span class="muted small">${L('د', 'm')}</span>
  <input class="input num" type="number" min="0" max="59" step="1" data-t="s" value="${p.s}" style="width:70px" ${attrs}><span class="muted small">${L('ث', 's')}</span>`; };

export function openOvertimeTaskForm({ assignee = '' } = {}) {
  const people = overtimeAssignable();
  if (!people.length) { toast(L('مفيش حد تقدر تدّيه أوفر تايم', 'There is nobody you can give overtime to'), '', 'warn'); return null; }
  const today = ymd(now());
  let rows = [{ date: today, ms: 2 * 3600000 }];
  let steps = [''];
  const m = modal({
    title: L('تاسك أوفر تايم', 'Overtime task'), icon: 'fa-business-time', size: '',
    body: `<form class="form-grid" id="otf">
        <div class="field span-2"><label>${L('الموظف', 'Employee')}</label>
          <select class="select" name="who" data-people>${people.map(p => `<option value="${esc(p.email)}" ${p.email === assignee ? 'selected' : ''}>${esc(p.name || p.email)}</option>`).join('')}</select></div>
        <div class="field span-2"><label>${L('اسم التاسك', 'Task name')}</label><input class="input" name="title" maxlength="200" required autocomplete="off"></div>
        <div class="field span-2"><label>${L('التفاصيل', 'Details')}</label><textarea class="textarea" name="details" maxlength="6000" placeholder="${L('المطلوب بالظبط، الروابط، وإيه اللي هيتسلّم', 'What exactly is needed, links, and what is handed in')}"></textarea></div>
        <div class="field span-2"><label>${L('خطوات العمل', 'Work steps')}</label>
          <div id="otsteps" class="col gap-8"></div>
          <div class="mt-8"><button type="button" class="btn btn-sm" id="s-add"><i class="fas fa-plus"></i> ${L('خطوة', 'Step')}</button></div>
          <div class="help">${L('الموظف بيعلّم عليها وهو شغال، وبتظهر في التاسك.', 'The employee ticks them off while working; they show in the task.')}</div></div>
        <div class="field"><label>${L('الأولوية', 'Priority')}</label><select class="select" name="priority">${Object.entries(PRIORITY).map(([k, v]) => `<option value="${k}">${esc(L(v.ar, v.en))}</option>`).join('')}</select></div>
        <div class="field span-2"><label>${L('الأيام والوقت', 'Days and time')}</label>
          <div class="row gap-8" style="flex-wrap:wrap;align-items:flex-end">
            <div class="field"><label class="xs muted">${L('من يوم', 'From')}</label><input class="input" type="date" id="g-from" value="${esc(today)}" style="width:auto"></div>
            <div class="field"><label class="xs muted">${L('عدد الأيام', 'Days')}</label><input class="input num" type="number" id="g-n" min="1" max="31" value="1" style="width:80px"></div>
            <div class="field"><label class="xs muted">${L('الوقت كل يوم', 'Time a day')}</label><div class="row gap-4" id="g-t" style="align-items:center">${hms(2 * 3600000)}</div></div>
            <button type="button" class="btn" id="g-make"><i class="fas fa-wand-magic-sparkles"></i> ${L('جهّز الأيام', 'Fill the days')}</button>
          </div>
          <div id="otrows" class="col gap-8 mt-8"></div>
          <div class="row between mt-8"><button type="button" class="btn btn-sm" id="g-add"><i class="fas fa-plus"></i> ${L('يوم تاني', 'Another day')}</button><b id="otsum" class="num"></b></div>
          <div class="help">${L('الموظف بيشتغل في الأيام دي بس. لما يخلّص وتنهي التاسك، الأدمن بيحدد الوقت اللي يتحاسب عليه من الوقت الفعلي.', 'The employee works on these days only. Once you finish the task the admin sets the time to pay from the time really taken.')}</div>
        </div>
      </form>`,
    foot: `<button class="btn" data-close>${L('إلغاء', 'Cancel')}</button><button class="btn btn-primary" id="otsend"><i class="fas fa-paper-plane"></i> ${L('ابعت للموظف', 'Send to the employee')}</button>`
  });
  const f = m.$('#otf');
  const sum = () => { m.$('#otsum').textContent = `${fmtHMS(otPlanMs(rows))} · ${rows.length} ${L('يوم', 'd')}`; };
  const draw = () => {
    m.$('#otrows').innerHTML = rows.map((r, i) => `<div class="row gap-8" data-row="${i}" style="align-items:center;flex-wrap:wrap"><input class="input" type="date" data-k="date" value="${esc(r.date)}" style="width:auto">${hms(r.ms)}
      ${rows.length > 1 ? `<button type="button" class="btn btn-icon btn-sm" data-del="${i}" aria-label="remove"><i class="fas fa-xmark"></i></button>` : ''}</div>`).join('');
    sum();
  };
  const drawSteps = () => {
    m.$('#otsteps').innerHTML = steps.map((s, i) => `<div class="row gap-8"><span class="muted num small" style="width:20px">${i + 1}</span><input class="input grow" data-st="${i}" maxlength="300" value="${esc(s)}" placeholder="${L('اكتب الخطوة…', 'Write the step…')}">
      <button type="button" class="btn btn-icon btn-sm" data-sdel="${i}" aria-label="remove"><i class="fas fa-xmark"></i></button></div>`).join('');
  };
  draw(); drawSteps();
  m.$('#otrows').addEventListener('input', (e) => {
    const row = e.target.closest('[data-row]'); if (!row) return; const r = rows[Number(row.dataset.row)];
    if (e.target.dataset.k === 'date') r.date = e.target.value;
    else { const v = (k) => row.querySelector(`[data-t="${k}"]`).value; r.ms = toMs(v('h'), v('m'), v('s')); }
    sum();
  });
  m.$('#otrows').addEventListener('click', (e) => { const b = e.target.closest('[data-del]'); if (!b) return; rows.splice(Number(b.dataset.del), 1); draw(); });
  m.$('#otsteps').addEventListener('input', (e) => { const i = e.target.dataset.st; if (i != null) steps[Number(i)] = e.target.value; });
  m.$('#otsteps').addEventListener('click', (e) => { const b = e.target.closest('[data-sdel]'); if (!b) return; steps.splice(Number(b.dataset.sdel), 1); if (!steps.length) steps = ['']; drawSteps(); });
  m.$('#s-add').onclick = () => { steps.push(''); drawSteps(); const all = m.$$('[data-st]'); all[all.length - 1].focus(); };
  m.$('#g-add').onclick = () => { const last = rows[rows.length - 1]; rows.push({ date: last ? addDays(last.date, 1) : today, ms: last ? last.ms : 3600000 }); draw(); };
  m.$('#g-make').onclick = () => {
    const from = m.$('#g-from').value || today, n = Math.max(1, Math.min(31, Number(m.$('#g-n').value) || 1));
    const g = m.$('#g-t'), ms = toMs(g.querySelector('[data-t="h"]').value, g.querySelector('[data-t="m"]').value, g.querySelector('[data-t="s"]').value) || 3600000;
    rows = Array.from({ length: n }, (_, i) => ({ date: addDays(from, i), ms })); draw();
  };
  m.$('#otsend').onclick = (e) => busy(e.currentTarget, async () => {
    if (!f.reportValidity()) return;
    try {
      await createOvertimeTask({ title: f.title.value, details: f.details.value, priority: f.priority.value, checklist: steps.map(s => ({ text: s })) }, f.who.value, rows);
      m.close();
      toast(L('اتبعت الطلب للموظف', 'Sent to the employee'), L('هيظهرله على الداشبورد ويوافق عليه.', 'It shows on their dashboard for them to accept.'));
    } catch (ex) { toastErr(ex); }
  });
  return m;
}
