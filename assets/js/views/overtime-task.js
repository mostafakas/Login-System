// "Overtime task": a leader (for their team), a project manager or the admin gives an employee a task with allotted time —
// the days it is worked on and the hours of each day. The employee accepts it from the dashboard (see services/overtime.js).
import { L, esc, addDays, ymd, num } from '../core/utils.js';
import { toast, toastErr, modal, busy } from '../core/ui.js';
import { session, now } from '../core/session.js';
import { PRIORITY, assignable } from '../services/tasks.js';
import { createOvertimeTask, otPlanHours } from '../services/overtime.js';

/** people I may give overtime to: the same as tasks, but never myself */
export const overtimeAssignable = () => assignable().filter(p => p.email !== session.email);
export const canOfferOvertime = () => overtimeAssignable().length > 0;

export function openOvertimeTaskForm({ assignee = '' } = {}) {
  const people = overtimeAssignable();
  if (!people.length) { toast(L('مفيش حد تقدر تدّيه أوفر تايم', 'There is nobody you can give overtime to'), '', 'warn'); return null; }
  const today = ymd(now());
  let rows = [{ date: today, hours: 2 }];
  const m = modal({
    title: L('تاسك أوفر تايم', 'Overtime task'), icon: 'fa-business-time', size: '',
    body: `<form class="form-grid" id="otf">
        <div class="field span-2"><label>${L('الموظف', 'Employee')}</label>
          <select class="select" name="who" data-people>${people.map(p => `<option value="${esc(p.email)}" ${p.email === assignee ? 'selected' : ''}>${esc(p.name || p.email)}</option>`).join('')}</select></div>
        <div class="field span-2"><label>${L('اسم التاسك', 'Task name')}</label><input class="input" name="title" maxlength="200" required></div>
        <div class="field span-2"><label>${L('التفاصيل', 'Details')}</label><textarea class="textarea" name="details" maxlength="6000" placeholder="${L('المطلوب بالظبط، الروابط، وإيه اللي هيتسلّم', 'What exactly is needed, links, and what is handed in')}"></textarea></div>
        <div class="field"><label>${L('الأولوية', 'Priority')}</label><select class="select" name="priority">${Object.entries(PRIORITY).map(([k, v]) => `<option value="${k}">${esc(L(v.ar, v.en))}</option>`).join('')}</select></div>
        <div class="field span-2"><label>${L('الأيام والساعات', 'Days and hours')}</label>
          <div class="row gap-8" style="flex-wrap:wrap;align-items:flex-end">
            <div class="field"><label class="xs muted">${L('من يوم', 'From')}</label><input class="input" type="date" id="g-from" value="${esc(today)}" style="width:auto"></div>
            <div class="field"><label class="xs muted">${L('عدد الأيام', 'Days')}</label><input class="input num" type="number" id="g-n" min="1" max="31" value="1" style="width:90px"></div>
            <div class="field"><label class="xs muted">${L('ساعات كل يوم', 'Hours a day')}</label><input class="input num" type="number" id="g-h" min="0.25" max="16" step="0.25" value="2" style="width:100px"></div>
            <button type="button" class="btn" id="g-make"><i class="fas fa-wand-magic-sparkles"></i> ${L('جهّز الأيام', 'Fill the days')}</button>
          </div>
          <div id="otrows" class="col gap-8 mt-8"></div>
          <div class="row between mt-8"><button type="button" class="btn btn-sm" id="g-add"><i class="fas fa-plus"></i> ${L('يوم تاني', 'Another day')}</button><b id="otsum" class="num"></b></div>
          <div class="help">${L('الموظف بيشتغل في الأيام دي بس، وبيحاسبه الأدمن على المدة اللي بتحددها أو على الوقت الفعلي اللي أخده.', 'The employee works on these days only; the admin pays the time you set or the time really taken.')}</div>
        </div>
      </form>`,
    foot: `<button class="btn" data-close>${L('إلغاء', 'Cancel')}</button><button class="btn btn-primary" id="otsend"><i class="fas fa-paper-plane"></i> ${L('ابعت للموظف', 'Send to the employee')}</button>`
  });
  const f = m.$('#otf');
  const draw = () => {
    m.$('#otrows').innerHTML = rows.map((r, i) => `<div class="row gap-8"><input class="input" type="date" data-i="${i}" data-k="date" value="${esc(r.date)}" style="width:auto">
      <input class="input num" type="number" data-i="${i}" data-k="hours" min="0.25" max="16" step="0.25" value="${esc(r.hours)}" style="width:100px"><span class="muted small">${L('ساعة', 'h')}</span>
      ${rows.length > 1 ? `<button type="button" class="btn btn-icon btn-sm" data-del="${i}" aria-label="remove"><i class="fas fa-xmark"></i></button>` : ''}</div>`).join('');
    m.$('#otsum').textContent = `${num(otPlanHours(rows), 2)} ${L('ساعة', 'h')} · ${num(rows.length)} ${L('يوم', 'd')}`;
  };
  draw();
  m.$('#otrows').addEventListener('input', (e) => { const el = e.target.closest('[data-i]'); if (!el) return; rows[Number(el.dataset.i)][el.dataset.k] = el.dataset.k === 'hours' ? Number(el.value) : el.value; m.$('#otsum').textContent = `${num(otPlanHours(rows), 2)} ${L('ساعة', 'h')} · ${num(rows.length)} ${L('يوم', 'd')}`; });
  m.$('#otrows').addEventListener('click', (e) => { const b = e.target.closest('[data-del]'); if (!b) return; rows.splice(Number(b.dataset.del), 1); draw(); });
  m.$('#g-add').onclick = () => { const last = rows[rows.length - 1]; rows.push({ date: last ? addDays(last.date, 1) : today, hours: last ? last.hours : 2 }); draw(); };
  m.$('#g-make').onclick = () => {
    const from = m.$('#g-from').value || today, n = Math.max(1, Math.min(31, Number(m.$('#g-n').value) || 1)), h = Number(m.$('#g-h').value) || 1;
    rows = Array.from({ length: n }, (_, i) => ({ date: addDays(from, i), hours: h })); draw();
  };
  m.$('#otsend').onclick = (e) => busy(e.currentTarget, async () => {
    if (!f.reportValidity()) return;
    try {
      await createOvertimeTask({ title: f.title.value, details: f.details.value, priority: f.priority.value }, f.who.value, rows);
      m.close();
      toast(L('اتبعت الطلب للموظف', 'Sent to the employee'), L('هيظهرله على الداشبورد ويوافق عليه.', 'It shows on their dashboard for them to accept.'));
    } catch (ex) { toastErr(ex); }
  });
  return m;
}
