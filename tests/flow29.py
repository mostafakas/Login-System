"""A day marked absent is priced once: no extra 'rejected remote', lateness or early-leave line on the same day.
Reproduces an HR correction to «غياب» on a remote day whose request was rejected (the record keeps check-in + mode
remote), which used to show both «غياب بدون إذن» and «أونلاين اترفض طلبه» on the payslip."""
import sys, os, time; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import BASE, serve, route
from playwright.sync_api import sync_playwright
fails = []
def ok(c, m): print(('OK ' if c else 'FAIL ') + m); (None if c else fails.append(m))
def cairo(day, hm): h, m = map(int, hm.split(':')); return int(time.mktime(time.strptime(day, '%Y-%m-%d')) - time.timezone) * 1000 + ((h - 3) * 60 + m) * 60000

srv = serve(); pw = sync_playwright().start(); br = pw.chromium.launch(executable_path=os.environ.get('PW_CHROMIUM') or None)
ctx = br.new_context(locale='ar-EG', timezone_id='Africa/Cairo'); ctx.route('**/*', route)
errs = []
pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
pg.goto(BASE + '/tests/blank.html')
res = pg.evaluate("""async (t) => {
  const { classifyDay } = await import('/assets/js/services/reports.js');
  const { violationsFrom, priceViolations, rulesOf } = await import('/assets/js/services/salary.js');
  const plan = { mode: 'office', start: '09:00', end: '18:00' };
  const recs = {
    // HR corrected to absent; the record still has the remote check-in (late, and left early)
    '2026-10-15': { status: 'absent', corrected: true, checkInMs: t.in15, checkOutMs: t.out15, closed: true, mode: 'remote', workMs: 3600000 },
    // a plain remote day whose request was rejected
    '2026-10-22': { checkInMs: t.in22, checkOutMs: t.out22, closed: true, mode: 'remote', workMs: 8 * 3600000 },
  };
  const rows = ['2026-10-15', '2026-10-22'].map(d => classifyDay(d, plan, recs[d], [], '2026-10-28'));
  const requests = ['2026-10-15', '2026-10-22'].map(d => ({ type: 'remote', status: 'rejected', startDate: d, endDate: d }));
  const v = violationsFrom(rows, requests);
  const priced = priceViolations(v, { basic: 7000, allowances: 2800, regularity: 1400 }, rulesOf({}), 30);
  return { v, lines: priced.lines.map(l => ({ date: l.date, kind: l.kind, total: l.total })), byKind: priced.byKind };
}""", {'in15': cairo('2026-10-15', '10:30'), 'out15': cairo('2026-10-15', '12:00'), 'in22': cairo('2026-10-22', '09:00'), 'out22': cairo('2026-10-22', '18:00')})
print(res)
d15 = [l for l in res['lines'] if l['date'] == '2026-10-15']
d22 = [l for l in res['lines'] if l['date'] == '2026-10-22']
ok([l['kind'] for l in d15] == ['absence'], f"the absent day has one line only ({[l['kind'] for l in d15]})")
ok(d15 and d15[0]['total'] == 373.33, 'absence = a day of basic + allowances + regularity (373.33)')
ok([l['kind'] for l in d22] == ['remote'] and d22[0]['total'] == 140, 'a rejected remote day (not absent) still costs a day of allowances + regularity (140)')
ok(res['byKind']['remote'] == 140 and res['byKind']['absence'] == 373.33, 'totals by kind')
ok(not errs, f'no page errors {errs}')
br.close(); pw.stop(); srv.shutdown()
print('\nFAILS:', fails if fails else 'none'); sys.exit(1 if fails else 0)
