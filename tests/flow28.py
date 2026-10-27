"""Overtime, short days and the day dashboard.
1. Short day: an employee on the 09:00 shift ends the day after 4 hours; they are told the day's actual hours are not
   done (8 h = 9 h shift − 1 h break), can go back to work, or object with a reason; the answer is kept on the day,
   shown in their attendance report and their manager is notified.
2. Overtime: working on Friday (weekend) files an overtime request when the day ends; the admin sees the hours and the
   amount (12,000 ÷ 30 ÷ 8 = 50 an hour), approves it, and payroll adds it to the gross and the payslip.
3. Dashboard "day" tab: today's overtime, and on an earlier day: lateness, remote without approval, absence, short day."""
import sys, os, time; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import seed_payload, BASE, serve, route
from playwright.sync_api import sync_playwright
fails = []
def ok(c, m): print(('OK ' if c else 'FAIL ') + m); (None if c else fails.append(m))
def cairo(day, hm): h, m = map(int, hm.split(':')); return int(time.mktime(time.strptime(day, '%Y-%m-%d')) - time.timezone) * 1000 + ((h - 3) * 60 + m) * 60000
H = 3600000
extra = {'settings/migration': {'done': True}, 'settings/general': {'trackingStart': '2026-10-01', 'workStart': '09:00', 'workEnd': '17:00', 'graceMinutes': 15, 'breakMaxMinutes': 60}}
# Wed 28: emp1 worked remote without an approved request (office day), emp2 came an hour late on the 09:00 shift
extra['attendance_days/emp1@almaster.tech_2026-10-28'] = {'email': 'emp1@almaster.tech', 'date': '2026-10-28', 'leaderEmail': 'leader@almaster.tech', 'checkInMs': cairo('2026-10-28', '09:05'), 'checkOutMs': cairo('2026-10-28', '18:05'), 'workMs': 8 * H, 'meetingMs': 0, 'breakMs': H, 'mode': 'remote', 'remotePending': True, 'shift': '9', 'closed': True}
extra['attendance_days/emp2@almaster.tech_2026-10-28'] = {'email': 'emp2@almaster.tech', 'date': '2026-10-28', 'leaderEmail': 'leader@almaster.tech', 'checkInMs': cairo('2026-10-28', '10:00'), 'checkOutMs': cairo('2026-10-28', '18:00'), 'workMs': 7 * H, 'meetingMs': 0, 'breakMs': H, 'mode': 'office', 'shift': '9', 'closed': True}
p = seed_payload(extra)
fs = p['fs']
for e in ['admin@almaster.tech', 'hr@almaster.tech', 'fin@almaster.tech', 'leader@almaster.tech']: fs[f'users/{e}']['trackAttendance'] = False
pct = lambda b, a, r, k: {'basic': {'mode': 'pct', 'value': b}, 'allowances': {'mode': 'pct', 'value': a}, 'regularity': {'mode': 'pct', 'value': r}, 'kpi': {'mode': 'pct', 'value': k}}
fs['employees_private/emp1@almaster.tech']['salary'] = {'total': 12000, 'parts': pct(50, 20, 10, 20), 'fixedDeductions': 0}
fs['employees_private/emp2@almaster.tech']['salary'] = {'total': 9000, 'parts': pct(50, 20, 10, 20), 'fixedDeductions': 0}
for e in fs:
    if e.startswith('users/'): fs[e]['createdAt'] = {'__ts': cairo('2025-01-01', '09:00')}

srv = serve(); pw = sync_playwright().start(); br = pw.chromium.launch(executable_path=os.environ.get('PW_CHROMIUM') or None)
ctx = br.new_context(viewport={'width': 1440, 'height': 950}, locale='ar-EG', timezone_id='Africa/Cairo'); ctx.route('**/*', route)
ctx.clock.install(time=cairo('2026-10-29', '09:00') / 1000)
errs = []
pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
pg.goto(BASE + '/tests/blank.html')
pg.evaluate("(p) => { localStorage.clear(); localStorage.setItem('mockauth_users', JSON.stringify(p.auth)); localStorage.setItem('mockfs', JSON.stringify(p.fs)); localStorage.setItem('am_lang','ar'); }", p)
def login(email):
    pg.evaluate("() => { localStorage.removeItem('mockauth_current'); }")
    pg.goto(BASE + '/index.html'); pg.fill('#email', email); pg.fill('#password', 'Passw0rd!'); pg.click('#login-btn')
    pg.wait_for_url('**/app.html**'); pg.wait_for_selector('#splash', state='detached')
db = lambda path: pg.evaluate("(k) => JSON.parse(localStorage.getItem('mockfs') || '{}')[k] || null", path)
dball = lambda: pg.evaluate("() => JSON.parse(localStorage.getItem('mockfs') || '{}')")
def close_modals():
    for _ in range(3):
        if pg.locator('.modal-root').count(): pg.keyboard.press('Escape'); pg.wait_for_timeout(250)

# ---------- 1. short day (Thursday 29, 09:00 shift) ----------
login('emp2@almaster.tech')
pg.evaluate("h => location.hash = h", '#/home'); pg.wait_for_selector('#start-btn')
ok(pg.locator('#ot-note').count() == 0, 'a working day shows no overtime note')
pg.click('#start-btn'); pg.click('[data-mode="office"]'); pg.wait_for_selector('[data-shift="9"]'); pg.click('[data-shift="9"]')
pg.wait_for_selector('#end-btn', timeout=8000)
ctx.clock.fast_forward('04:00:00'); pg.wait_for_timeout(500)
pg.click('#end-btn'); pg.wait_for_selector('#short-box', timeout=5000)
txt = pg.locator('.modal-root').last.inner_text(); print('short modal:', txt.replace('\n', ' | ')[:300])
ok('لم يتم استكمال عدد ساعات اليوم الفعلية' in txt and '8' in txt, 'ending after 4 h: "the day\'s actual hours are not complete" with 8 h required')
pg.click('#short-back'); pg.wait_for_timeout(300)
ok(pg.locator('#short-box').count() == 0 and pg.locator('#end-btn').count() == 1, '"keep working" closes it and the day stays open')
pg.click('#end-btn'); pg.wait_for_selector('#short-box')
pg.click('#short-refuse'); pg.wait_for_timeout(300)
ok(pg.locator('#short-box').count() == 1, 'objecting without a reason is not accepted')
pg.fill('#short-note', 'كان عندي مشوار شغل للعميل'); pg.click('#short-refuse'); pg.wait_for_timeout(1200)
d = db('attendance_days/emp2@almaster.tech_2026-10-29') or {}
sf = d.get('shortfall') or {}
print('shortfall:', sf)
ok(d.get('closed') is True and sf.get('response') == 'refused' and abs(sf.get('missingMs', 0) - 4 * H) < 5 * 60000 and sf.get('note'), 'the day is closed with the objection and ~4 h missing')
notes = [v for k, v in dball().items() if k.startswith('notifications/') and v.get('to', v.get('email')) == 'leader@almaster.tech' or (k.startswith('notifications/') and 'leader@almaster.tech' in str(v))]
ok(any('اعترض' in str(n) for n in notes), 'the manager is notified of the objection')
pg.evaluate("h => location.hash = h", '#/attendance'); pg.wait_for_selector('.day-table', timeout=8000); pg.wait_for_timeout(500)
row = pg.locator('.day-table tr[data-day="2026-10-29"]').inner_text().replace('\n', ' | '); print('att row:', row)
ok('ناقص' in row and 'اعترض' in row, 'the attendance report shows the short day and the objection')
ok('يوم ساعاته الفعلية ناقصة' in pg.locator('#pm-body').inner_text(), 'the month summary counts the short day')

# ---------- 2. overtime on Friday 30 ----------
ctx.clock.fast_forward('25:00:00')   # Fri 30, 14:00
login('emp1@almaster.tech')
pg.evaluate("h => location.hash = h", '#/home'); pg.wait_for_selector('#start-btn')
ok(pg.locator('#ot-note').count() == 1, 'a day off says work today counts as overtime')
pg.click('#start-btn'); pg.click('[data-mode="office"]')
pg.wait_for_selector('#end-btn', timeout=8000)
ok(pg.locator('[data-shift]').count() == 0, 'no shift picker on a day off')
ctx.clock.fast_forward('03:00:00'); pg.wait_for_timeout(500)
pg.click('#end-btn'); pg.wait_for_selector('[data-yes]')
ok('أوفر تايم' in pg.locator('.modal-root').last.inner_text(), 'the end-day dialog says an overtime request will be sent')
pg.click('[data-yes]'); pg.wait_for_timeout(1500)
ot = db('requests/ot_emp1@almaster.tech_2026-10-30') or {}
print('ot request:', {k: ot.get(k) for k in ['type', 'status', 'hours', 'dayMode', 'stages', 'amount']})
ok(ot.get('type') == 'overtime' and ot.get('status') == 'pending_admin' and abs((ot.get('hours') or 0) - 3) < 0.05 and ot.get('dayMode') == 'off', 'an overtime request of ~3 h is with the admin')
pg.evaluate("h => location.hash = h", '#/requests'); pg.wait_for_timeout(1000)
ok('أوفر تايم' in pg.locator('#content, main, body').first.inner_text(), 'the employee sees it in My requests')

login('admin@almaster.tech')
pg.evaluate("h => location.hash = h", '#/approvals'); pg.wait_for_timeout(1500)
card = pg.locator('.req-card', has_text='سارة محمود').filter(has_text='أوفر تايم')
ok(card.count() == 1, 'the admin has the overtime request in Approvals')
card.locator('[data-action="details"]').click(); pg.wait_for_selector('#ot-calc'); pg.wait_for_timeout(800)
calc = pg.locator('#ot-calc').inner_text(); print('calc:', calc.replace('\n', ' | '))
ok('150' in calc and '50' in calc and '8' in calc, 'details: 3 h × 50 (12,000 ÷ 30 ÷ 8) = 150')
close_modals()
card.locator('[data-action="approve"]').click(); pg.wait_for_timeout(1500)
ot = db('requests/ot_emp1@almaster.tech_2026-10-30') or {}
print('approved:', {k: ot.get(k) for k in ['status', 'hours', 'hourlyRate', 'amount', 'dayHours']})
ok(ot.get('status') == 'approved' and ot.get('hourlyRate') == 50 and abs((ot.get('amount') or 0) - 150) < 2, 'approval stores the hour value 50 and the amount ~150')

pg.evaluate("h => location.hash = h", '#/payroll'); pg.wait_for_selector('[data-action="build"]', timeout=8000)
pg.locator('[data-action="build"]').first.click()
pg.wait_for_function("() => document.querySelectorAll('#rows tr').length >= 2 && !document.querySelector('#rows .empty')", timeout=10000); pg.wait_for_timeout(500)
it = db('payroll_items/2026-10_emp1@almaster.tech') or {}
print('payroll:', {k: it.get(k) for k in ['gross', 'overtime', 'overtimeHours', 'net']})
ok(abs((it.get('overtime') or 0) - 150) < 2 and it.get('gross', 0) >= 12000 + 148, 'payroll adds the overtime to the gross')
ok('أوفر تايم' in pg.locator('#rows tr', has_text='سارة محمود').inner_text(), 'the payroll row shows the overtime')
pg.locator('#rows tr', has_text='سارة محمود').locator('[data-action="slip"]').click(); pg.wait_for_timeout(800)
slip = pg.locator('.payslip').inner_text()
ok('أوفر تايم' in slip and '× 50' in slip, 'the payslip has an overtime line with hours × 50')
close_modals()

# ---------- 3. dashboard, day tab ----------
pg.evaluate("h => location.hash = h", '#/dashboard'); pg.wait_for_selector('#day-groups', timeout=10000); pg.wait_for_timeout(500)
ot_grp = pg.locator('.db-day-grp[data-g="overtime"]').inner_text(); print('today overtime group:', ot_grp.replace('\n', ' | ')[:200])
ok('سارة محمود' in ot_grp and 'معتمد' in ot_grp, 'today: emp1 worked the day off, request approved')
pg.fill('#day', '2026-10-28'); pg.dispatch_event('#day', 'change'); pg.wait_for_timeout(1200)
late = pg.locator('.db-day-grp[data-g="late"]').inner_text(); place = pg.locator('.db-day-grp[data-g="place"]').inner_text()
print('28 late:', late.replace('\n', ' | ')[:200]); print('28 place:', place.replace('\n', ' | ')[:200])
ok('عمر خالد' in late and 'متأخر 1س' in late, 'Wed 28: emp2 late an hour')
ok('سارة محمود' in place and 'من غير موافقة' in place, 'Wed 28: emp1 remote on an office day without approval')
pg.fill('#day', '2026-10-29'); pg.dispatch_event('#day', 'change'); pg.wait_for_timeout(1200)
early = pg.locator('.db-day-grp[data-g="early"]').inner_text(); absent = pg.locator('.db-day-grp[data-g="absent"]').inner_text()
ok('عمر خالد' in early and 'اعترض' in early, 'Thu 29: emp2 short day with objection')
ok('سارة محمود' in absent, 'Thu 29: emp1 absent')
pg.click('#day-tiles [data-grp="early"]'); pg.wait_for_timeout(400)
trs = pg.locator('#day-table tbody tr').count()
ok(trs == 1 and 'عمر خالد' in pg.locator('#day-table').inner_text(), 'clicking the "early" tile filters the table to that person')
pg.screenshot(path=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'shots', 'f28-day-dashboard.png'), full_page=True)
pg.click('#tabs [data-tab="month"]'); pg.wait_for_timeout(800)
ok('مقارنة الأقسام' in pg.locator('#dash').inner_text(), 'the month tab still shows the monthly dashboard')

print('errors', errs); ok(not [e for e in errs if 'favicon' not in e], 'no page errors')
br.close(); pw.stop()
print('ALL OK' if not fails else f'{len(fails)} FAILED'); sys.exit(1 if fails else 0)
