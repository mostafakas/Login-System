// Admin: add an advance for an employee by hand (Payroll → "Add advance").
// It becomes an approved advance request (shown to the employee), an active advance (its installments come off the
// salaries from the first month, and show on the payslip) and, if ticked, the treasury payout on the chosen date.
import { L, esc, ymd, money, fmtMonth, addMonths } from '../core/utils.js';
import { toast, toastErr, modal, busy } from '../core/ui.js';
import { now } from '../core/session.js';
import { activePeople, nameOf } from '../services/directory.js';
import { addManualAdvance } from '../services/payroll.js';

export function openManualAdvance({ month, onDone } = {}) {
  const people = activePeople().filter(p => !p.isSuspended).slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ar'));
  const today = ymd(now());
  const m = modal({
    title: L('إضافة سلفة', 'Add an advance'), icon: 'fa-hand-holding-dollar', size: '',
    body: `<form class="form-grid" id="maf">
        <div class="field span-2"><label>${L('الموظف', 'Employee')}</label>
          <select class="select" name="who" data-people><option value="">${L('اختار الموظف…', 'Pick the employee…')}</option>${people.map(p => `<option value="${esc(p.email)}">${esc(p.name || p.email)}</option>`).join('')}</select></div>
        <div class="field"><label>${L('المبلغ (ج.م)', 'Amount (EGP)')}</label><input class="input num" type="number" min="1" step="0.01" name="amount" required></div>
        <div class="field"><label>${L('عدد الأقساط', 'Installments')}</label><input class="input num" type="number" min="1" max="60" step="1" name="installments" value="1"></div>
        <div class="field"><label>${L('أول شهر خصم', 'First deduction month')}</label><input class="input" type="month" name="startMonth" value="${esc(month || today.slice(0, 7))}" required></div>
        <div class="field"><label>${L('تاريخ صرف السلفة', 'Payout date')}</label><input class="input" type="date" name="payoutDate" value="${esc(today)}" required></div>
        <div class="field"><label>${L('اتسدد منها قبل كده', 'Already repaid')}</label><input class="input num" type="number" min="0" step="0.01" name="repaid" value="0"><span class="help">${L('لو بتسجّل سلفة قديمة اتخصم منها جزء.', 'For an older advance that was partly deducted already.')}</span></div>
        <div class="field"><label>&nbsp;</label><label class="row gap-8" style="align-items:center"><input type="checkbox" name="paidOut" checked> <span>${L('اتصرفت من الخزينة', 'Paid out of the treasury')}</span></label></div>
        <div class="field span-2"><label>${L('السبب / تفاصيل', 'Reason / details')}</label><textarea class="textarea" name="note" maxlength="500" placeholder="${L('مثلاً: ظروف طارئة، اتفاق مع الإدارة…', 'e.g. an emergency, agreed with management…')}"></textarea></div>
        <div class="span-2 alert info" id="maprev"></div>
      </form>`,
    foot: `<button class="btn" data-close>${L('إلغاء', 'Cancel')}</button><button class="btn btn-primary" id="masave"><i class="fas fa-check"></i> ${L('إضافة السلفة', 'Add the advance')}</button>`
  });
  const f = m.$('#maf');
  const prev = () => {
    const n = Math.max(1, Math.min(60, Math.round(Number(f.installments.value) || 1))), amount = Number(f.amount.value) || 0, repaid = Number(f.repaid.value) || 0;
    m.$('#maprev').innerHTML = amount > 0 && f.startMonth.value
      ? `<i class="fas fa-calendar-check"></i><span>${L('القسط الشهري:', 'Monthly installment:')} <b class="num">${esc(money(amount / n, false))}</b> · ${esc(fmtMonth(f.startMonth.value))}${n > 1 ? ` ← ${esc(fmtMonth(addMonths(f.startMonth.value, n - 1)))}` : ''}${repaid > 0 ? ` · ${L('المتبقي', 'left')} <b class="num">${esc(money(Math.max(0, amount - repaid), false))}</b>` : ''}</span>`
      : `<i class="fas fa-circle-info"></i><span>${L('اكتب المبلغ وأول شهر خصم.', 'Enter the amount and the first deduction month.')}</span>`;
  };
  f.addEventListener('input', prev); prev();
  m.$('#masave').onclick = (e) => busy(e.currentTarget, async () => {
    if (!f.who.value) { toast(L('اختار الموظف', 'Pick the employee'), '', 'warn'); return; }
    if (!f.reportValidity()) return;
    try {
      const res = await addManualAdvance({ email: f.who.value, amount: f.amount.value, installments: f.installments.value, startMonth: f.startMonth.value, payoutDate: f.payoutDate.value, paidOut: f.paidOut.checked, repaid: f.repaid.value, note: f.note.value });
      m.close();
      const frozen = (res.states || []).some(s => s.state === 'frozen');
      toast(L('اتضافت السلفة', 'Advance added'), `${nameOf(f.who.value)} — ${money(res.plan.amount)} · ${res.plan.installments} ${L('قسط', 'installments')}${frozen ? ` · ${L('فيه راتب اتحوّل بالفعل ومتغيّرش', 'one salary was already transferred and was not changed')}` : ''}`, frozen ? 'warn' : 'ok');
      onDone && onDone();
    } catch (ex) { toastErr(ex); }
  });
  return m;
}
