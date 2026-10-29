// Admin: register overtime for an employee by hand (Payroll → "Register overtime").
// It is an approved overtime request: paid with that month's salary, on the payslip, in the Excel report and in the
// employee's "My requests".
import { L, esc, ymd, money, num, fmtDate } from '../core/utils.js';
import { toast, toastErr, modal, busy, confirmDialog, empty } from '../core/ui.js';
import { now } from '../core/session.js';
import { activePeople, nameOf } from '../services/directory.js';
import { addManualOvertime, manualOvertimeOf, removeManualOvertime } from '../services/payroll.js';
import { fmtHMS } from '../services/overtime.js';

const STATE_NOTE = {
  updated: ['ok', 'الراتب اتحدّث بالأوفر تايم.', "The salary was updated with the overtime."],
  none: ['info', 'لسه مفيش راتب للشهر ده. هيتحسب أول ما تنشئ رواتب الشهر.', 'There is no salary for that month yet; it is counted when you create the month\'s payroll.'],
  frozen: ['warn', 'راتب الشهر ده اتحوّل بالفعل. رجّعه «معتمد» وبعدين «إعادة الحساب» عشان الأوفر تايم يتضاف.', 'That month\'s salary is already transferred. Move it back to "Approved", then "Recalculate", to include the overtime.']
};

export function openManualOvertime({ month, onDone } = {}) {
  const people = activePeople().filter(p => !p.isSuspended).slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ar'));
  const today = ymd(now());
  const defDate = month && month !== today.slice(0, 7) ? `${month}-01` : today;
  const m = modal({
    title: L('تسجيل أوفر تايم', 'Register overtime'), icon: 'fa-business-time', size: '',
    body: `<form class="form-grid" id="mof">
        <div class="field span-2"><label>${L('الموظف', 'Employee')}</label>
          <select class="select" name="who" data-people><option value="">${L('اختار الموظف…', 'Pick the employee…')}</option>${people.map(p => `<option value="${esc(p.email)}">${esc(p.name || p.email)}</option>`).join('')}</select></div>
        <div class="field"><label>${L('اليوم', 'Day')}</label><input class="input" type="date" name="date" value="${esc(defDate)}" required></div>
        <div class="field"><label>${L('الوقت', 'Time')}</label>
          <div class="row gap-4" style="align-items:center">
            <input class="input num" type="number" min="0" max="24" step="1" name="h" value="1" style="width:70px"><span class="muted small">${L('س', 'h')}</span>
            <input class="input num" type="number" min="0" max="59" step="1" name="m" value="0" style="width:70px"><span class="muted small">${L('د', 'm')}</span>
            <input class="input num" type="number" min="0" max="59" step="1" name="s" value="0" style="width:70px"><span class="muted small">${L('ث', 's')}</span></div></div>
        <div class="field span-2"><label>${L('السبب / الملاحظة', 'Reason / note')}</label><input class="input" name="note" maxlength="200" placeholder="${L('مثلاً: شغل على تسليم المشروع يوم الجمعة', 'e.g. worked on the project hand-over on Friday')}" autocomplete="off"></div>
        <div class="span-2 alert info"><i class="fas fa-circle-info"></i><span>${L('الأوفر تايم بيتحسب بقيمة ساعة الموظف العادية (× معامل الأوفر تايم من الإعدادات)، وبيتضاف لراتب الشهر بتاع اليوم اللي تختاره، ويظهر في قسيمته وتقرير الإكسل.', "Paid at the employee's normal hour value (× the overtime multiplier in Settings), added to the salary of the month of the day you pick, and shown on the payslip and in the Excel report.")}</span></div>
      </form>
      <div class="label mb-8 mt-16">${L('اللي اتسجّل يدوياً في الشهر ده', 'Registered by hand this month')}</div><div id="molist"></div>`,
    foot: `<button class="btn" data-close>${L('إغلاق', 'Close')}</button><button class="btn btn-primary" id="mosave"><i class="fas fa-plus"></i> ${L('تسجيل', 'Register')}</button>`
  });
  const f = m.$('#mof');
  const drawList = async () => {
    const box = m.$('#molist'); box.innerHTML = '<span class="spinner"></span>';
    try {
      const rows = await manualOvertimeOf(f.date.value ? f.date.value.slice(0, 7) : (month || today.slice(0, 7)));
      box.innerHTML = rows.length ? `<div class="list">${rows.map(r => `<div class="list-item"><div class="grow min0"><b class="small">${esc(nameOf(r.email))}</b>
          <div class="xs muted">${esc(fmtDate(r.startDate))} · ${esc(fmtHMS(r.workMs))}${r.reason ? ` · ${esc(r.reason)}` : ''}</div></div>
          <b class="num small">${esc(money(r.amount))}</b>
          <button class="btn btn-icon btn-sm" data-del="${esc(r.id)}" title="${L('حذف', 'Delete')}"><i class="fas fa-trash"></i></button></div>`).join('')}</div>` : empty('fa-business-time', L('مفيش حاجة اتسجلت لسه', 'Nothing registered yet'));
      box.onclick = async (e) => {
        const b = e.target.closest('[data-del]'); if (!b) return;
        const r = rows.find(x => x.id === b.dataset.del); if (!r) return;
        const ok = await confirmDialog({ title: L('حذف الأوفر تايم', 'Delete overtime'), message: `${nameOf(r.email)} — ${r.startDate} — ${fmtHMS(r.workMs)}`, okText: L('حذف', 'Delete'), okClass: 'btn-danger' });
        if (!ok) return;
        try { const st = await removeManualOvertime(r); toast(L('اتحذف', 'Deleted'), st === 'frozen' ? L('الراتب اتحوّل بالفعل، راجعه.', 'The salary is already transferred; review it.') : ''); onDone && onDone(); drawList(); } catch (ex) { toastErr(ex); }
      };
    } catch (ex) { box.innerHTML = ''; console.warn(ex); }
  };
  drawList();
  f.date.addEventListener('change', drawList);
  m.$('#mosave').onclick = (e) => busy(e.currentTarget, async () => {
    if (!f.who.value) { toast(L('اختار الموظف', 'Pick the employee'), '', 'warn'); return; }
    if (!f.reportValidity()) return;
    const ms = ((Number(f.h.value) || 0) * 3600 + (Number(f.m.value) || 0) * 60 + (Number(f.s.value) || 0)) * 1000;
    try {
      const res = await addManualOvertime({ email: f.who.value, date: f.date.value, ms, note: f.note.value });
      const [cls, ar, en] = STATE_NOTE[res.state] || STATE_NOTE.none;
      toast(L('اتسجّل الأوفر تايم', 'Overtime registered'), `${nameOf(f.who.value)} — ${fmtHMS(ms)} = ${money(res.amount)}. ${L(ar, en)}`, cls === 'warn' ? 'warn' : 'ok');
      f.note.value = ''; onDone && onDone(); drawList();
    } catch (ex) { toastErr(ex); }
  });
  return m;
}
