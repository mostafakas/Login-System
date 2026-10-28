"""Live monitor, dashboard and monthly report agree on the day's shift and lateness.
emp1 started today at 10:12 with no shift saved ('' — was on fixed hours at the time, picks daily now) and emp2 picked
shift 10 and started at 10:12: neither is late anywhere (shift 10 = 10:00 + 30 min grace). The monitor used to measure
emp1 against the company start (09:00 → late 1h12)."""
import sys, os, time; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import seed_payload, BASE, serve, route
from playwright.sync_api import sync_playwright
fails = []
def ok(c, m): print(('OK ' if c else 'FAIL ') + m); (None if c else fails.append(m))
def cairo(day, hm): h, m = map(int, hm.split(':')); return int(time.mktime(time.strptime(day, '%Y-%m-%d')) - time.timezone) * 1000 + ((h - 3) * 60 + m) * 60000
D = '2026-10-28'
extra = {'settings/migration': {'done': True}, 'settings/general': {'trackingStart': '2026-10-01', 'workStart': '09:00', 'workEnd': '18:00', 'graceMinutes': 15}}
p = seed_payload(extra)
for e in p['fs']:
    if e.startswith('users/'): p['fs'][e]['createdAt'] = {'__ts': cairo('2025-01-01', '09:00')}
for em, sh in [('emp1@almaster.tech', ''), ('emp2@almaster.tech', '10')]:
    at = cairo(D, '10:12')
    p['fs'][f'users/{em}'].update({'status': 'Online', 'dayKey': D, 'firstOnlineAt': {'__ts': at}, 'lastChange': {'__ts': at}, 'lastChangeClient': at, 'checkedOut': False, 'workLocation': 'office', 'shift': sh, 'timeBank': {'Online': 0, 'Break': 0, 'Meeting': 0}})
    p['fs'][f'attendance_days/{em}_{D}'] = {'email': em, 'date': D, 'leaderEmail': 'leader@almaster.tech', 'checkInMs': at, 'checkOutMs': None, 'workMs': 0, 'breakMs': 0, 'meetingMs': 0, 'mode': 'office', 'shift': sh, 'closed': False}

srv = serve(); pw = sync_playwright().start(); br = pw.chromium.launch(executable_path=os.environ.get('PW_CHROMIUM') or None)
ctx = br.new_context(viewport={'width': 1440, 'height': 950}, locale='ar-EG', timezone_id='Africa/Cairo'); ctx.route('**/*', route)
ctx.clock.install(time=cairo(D, '11:00') / 1000)
errs = []
pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
pg.goto(BASE + '/tests/blank.html')
res = pg.evaluate("""async (t) => {
  const { classifyDay } = await import('/assets/js/services/reports.js');
  const { planFor, planOfDay, lateness } = await import('/assets/js/core/policy.js');
  const free = { email: 'z@almaster.tech' };
  const base = planFor('2026-10-28', null, free);
  const m1 = planOfDay(base, '', t.at, 'office'), m2 = planOfDay(base, '10', t.at, 'office');
  const r1 = classifyDay('2026-10-28', base, { checkInMs: t.at, mode: 'office', shift: '' }, [], '2026-10-28');
  const r2 = classifyDay('2026-10-28', base, { checkInMs: t.at, mode: 'office', shift: '10' }, [], '2026-10-28');
  return { live: [m1.shift, lateness(t.at, m1).late, m2.shift, lateness(t.at, m2).late], month: [r1.plan.shift, r1.late, r2.plan.shift, r2.late] };
}""", {'at': cairo(D, '10:12')})
print(res)
ok(res['live'] == ['10', 0, '10', 0], f'live plan: both on shift 10, not late ({res["live"]})')
ok(res['month'] == ['10', 0, '10', 0], f'monthly report: both on shift 10, not late ({res["month"]})')

pg.evaluate("(p) => { localStorage.clear(); localStorage.setItem('mockauth_users', JSON.stringify(p.auth)); localStorage.setItem('mockfs', JSON.stringify(p.fs)); localStorage.setItem('am_lang','ar'); }", p)
pg.goto(BASE + '/index.html'); pg.fill('#email', 'admin@almaster.tech'); pg.fill('#password', 'Passw0rd!'); pg.click('#login-btn')
pg.wait_for_url('**/app.html**'); pg.wait_for_selector('#splash', state='detached')
pg.evaluate("h => location.hash = h", '#/monitor'); pg.wait_for_timeout(2000)
card = lambda name: pg.locator('tr[data-email], .mon-card', has_text=name)
for name in ['سارة محمود', 'عمر خالد']:
    c = card(name)
    t = c.inner_text() if c.count() else ''
    print(name, '|', t.replace('\n', ' / '))
    ok(c.count() == 1 and 'تأخير' not in t and 'شيفت 10:00' in t, f'monitor: {name} on shift 10, not late')
ok('حسب الحضور' in (card('سارة محمود').inner_text() if card('سارة محمود').count() else ''), 'monitor: the shift of a day started without one says «(حسب الحضور)»')

pg.evaluate("h => location.hash = h", '#/dashboard'); pg.wait_for_timeout(2500)
dt = pg.locator('#view').inner_text()
ok('سارة محمود' not in dt.split('تأخيرات')[1].split('مشيوا بدري')[0] if 'تأخيرات' in dt and 'مشيوا بدري' in dt else True, 'dashboard: emp1 not in late arrivals')

print('errors', errs); ok(not [e for e in errs if 'favicon' not in e], 'no page errors')
br.close(); pw.stop()
print('ALL OK' if not fails else f'{len(fails)} FAILED'); sys.exit(1 if fails else 0)
