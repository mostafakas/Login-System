"""Freelancer pay: a freelancer gets the full agreed salary in payroll (no absence, lateness, unpaid leave, KPI cut or
allowance split), only the admin's own deductions come off, and the org chart and attendance pages show no
attendance deductions for them. A full-time colleague in the same month is still deducted as before."""
import sys, os, time; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import seed_payload, BASE, serve, route
from playwright.sync_api import sync_playwright
fails = []
def ok(c, m): print(('OK ' if c else 'FAIL ') + m); (None if c else fails.append(m))
def cairo(day, hm): h, m = map(int, hm.split(':')); return int(time.mktime(time.strptime(day, '%Y-%m-%d')) - time.timezone) * 1000 + ((h - 3) * 60 + m) * 60000
H = 3600000
def day(email, d, cin, cout, leader='leader@almaster.tech'):
    return {f'attendance_days/{email}_{d}': {'email': email, 'date': d, 'leaderEmail': leader, 'checkInMs': cairo(d, cin), 'checkOutMs': cairo(d, cout), 'workMs': 8 * H, 'meetingMs': 0, 'breakMs': 0, 'mode': 'office', 'shift': '9', 'closed': True}}
extra = {'settings/migration': {'done': True}, 'settings/general': {'trackingStart': '2026-10-01', 'workStart': '09:00', 'workEnd': '17:00', 'graceMinutes': 15}}
# emp1 (full-time): an hour late on the 5th · emp2 (freelancer): an hour late on the 1st, absent on the 4th and 5th
for d in ['2026-10-01', '2026-10-04']: extra.update(day('emp1@almaster.tech', d, '09:00', '18:00'))
extra.update(day('emp1@almaster.tech', '2026-10-05', '10:00', '18:00'))
extra.update(day('emp2@almaster.tech', '2026-10-01', '10:00', '18:00'))
p = seed_payload(extra)
fs = p['fs']
for e in ['admin@almaster.tech', 'hr@almaster.tech', 'fin@almaster.tech', 'leader@almaster.tech']: fs[f'users/{e}']['trackAttendance'] = False
pct = lambda b, a, r, k: {'basic': {'mode': 'pct', 'value': b}, 'allowances': {'mode': 'pct', 'value': a}, 'regularity': {'mode': 'pct', 'value': r}, 'kpi': {'mode': 'pct', 'value': k}}
fs['employees_private/emp1@almaster.tech']['salary'] = {'total': 14000, 'parts': pct(50, 20, 10, 20), 'fixedDeductions': 0}
fs['employees_private/emp2@almaster.tech']['salary'] = {'total': 9000, 'parts': pct(50, 20, 10, 20), 'fixedDeductions': 300}
fs['employees_private/emp2@almaster.tech']['contract'] = 'freelancer'
for e in fs:
    if e.startswith('users/'): fs[e]['createdAt'] = {'__ts': cairo('2025-01-01', '09:00')}

srv = serve(); pw = sync_playwright().start(); br = pw.chromium.launch(executable_path=os.environ.get('PW_CHROMIUM') or None)
ctx = br.new_context(viewport={'width': 1440, 'height': 950}, locale='ar-EG', timezone_id='Africa/Cairo'); ctx.route('**/*', route)
ctx.clock.install(time=cairo('2026-10-06', '12:00') / 1000)
errs = []
pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
pg.goto(BASE + '/tests/blank.html')
pg.evaluate("(p) => { localStorage.clear(); localStorage.setItem('mockauth_users', JSON.stringify(p.auth)); localStorage.setItem('mockfs', JSON.stringify(p.fs)); localStorage.setItem('am_lang','ar'); }", p)
def login(email):
    pg.evaluate("() => { localStorage.removeItem('mockauth_current'); }")
    pg.goto(BASE + '/index.html'); pg.fill('#email', email); pg.fill('#password', 'Passw0rd!'); pg.click('#login-btn')
    pg.wait_for_url('**/app.html**'); pg.wait_for_selector('#splash', state='detached')
db = lambda path: pg.evaluate("(k) => JSON.parse(localStorage.getItem('mockfs') || '{}')[k] || null", path)

# the freelancer's own attendance page: no "deductions so far" card
login('emp2@almaster.tech')
pg.evaluate("h => location.hash = h", '#/attendance'); pg.wait_for_timeout(1500)
ok(pg.locator('#ded').inner_text().strip() == '', 'the freelancer sees no deductions card on their attendance page')

login('admin@almaster.tech')
pg.evaluate("h => location.hash = h", '#/payroll'); pg.wait_for_selector('[data-action="build"]', timeout=8000)
pg.locator('[data-action="build"]').first.click()
pg.wait_for_function("() => document.querySelectorAll('#rows tr').length >= 2 && !document.querySelector('#rows .empty')", timeout=10000); pg.wait_for_timeout(500)
it2 = db('payroll_items/2026-10_emp2@almaster.tech') or {}
it1 = db('payroll_items/2026-10_emp1@almaster.tech') or {}
print('emp2 item:', {k: it2.get(k) for k in ['freelancer', 'basic', 'allowances', 'regularity', 'kpi', 'fixed', 'gross', 'deductions', 'net', 'lateDeduction', 'absenceDeduction']})
ok(it2.get('freelancer') is True, 'the freelancer is in this month\'s payroll and marked as one')
ok(it2.get('gross') == 9000 and it2.get('basic') == 9000 and not it2.get('allowances') and not it2.get('regularity') and not it2.get('kpi'), 'full 9,000 as one amount (no allowance / regularity / KPI split)')
ok(it2.get('deductions') == 0 and it2.get('net') == 9000, 'no automatic deductions: no late, no absence, no fixed deduction (net 9,000)')
ok(it1.get('lateDeduction', 0) > 0 and it1.get('net', 0) < 14000, f'the full-time colleague is still deducted for lateness ({it1.get("lateDeduction")})')
row2 = pg.locator('#rows tr', has_text='عمر خالد').inner_text().replace('\n', ' | '); print('row:', row2)
ok('فريلانسر' in row2 and '9,000' in row2, 'the payroll row shows the freelancer badge and the full salary')
ok(pg.locator('#stale-banner').count() == 0, 'no false "salary data changed" warning for the freelancer')

# admin adds a deduction by hand: that and only that comes off
pg.locator('#rows tr', has_text='عمر خالد').locator('[data-action="edit"]').click(); pg.wait_for_selector('#ef')
ok(pg.locator('#ef [name=kpiMode]').count() == 0, 'no KPI field in the freelancer\'s adjust dialog')
pg.click('#addod'); pg.locator('#od [data-r]').last.fill('تأخير تسليم'); pg.locator('#od [data-a]').last.fill('500')
pg.click('#sv'); pg.wait_for_timeout(800)
it2 = db('payroll_items/2026-10_emp2@almaster.tech') or {}
ok(it2.get('deductions') == 500 and it2.get('net') == 8500, f'the manual deduction is the only one: net 8,500 ({it2.get("net")})')

pg.locator('#rows tr', has_text='عمر خالد').locator('[data-action="slip"]').click(); pg.wait_for_timeout(800)
slip = pg.locator('.payslip').inner_text()
ok('الراتب (فريلانسر)' in slip and 'تأخير تسليم' in slip and 'غياب بدون إذن' not in slip, 'the payslip shows one salary line and only the manual deduction')

pg.keyboard.press('Escape'); pg.wait_for_timeout(300)
if pg.locator('.modal-root').count(): pg.locator('.modal-root [data-close]').first.click()
# org chart: the freelancer's month is the full salary minus the manual deduction, no attendance penalty
pg.evaluate("h => location.hash = h", '#/org'); pg.wait_for_selector('.org-tree', timeout=8000)
pg.wait_for_function("() => !document.querySelector('#note .spinner')", timeout=8000); pg.wait_for_timeout(300)
pg.click('#views [data-v="slips"]'); pg.wait_for_timeout(300)
ok('عمر خالد' not in pg.locator('#body').inner_text(), 'the freelancer is not in the "slipped the most" ranking')
pg.click('#views [data-v="table"]'); pg.wait_for_timeout(300)
r = pg.locator('#body tr', has_text='عمر خالد').inner_text().replace('\n', ' | '); print('org row:', r)
ok('500' in r and '8,500' in r and 'فريلانسر' in r, 'org table: deductions 500, net 8,500')

print('errors', errs); ok(not [e for e in errs if 'favicon' not in e], 'no page errors')
br.close(); pw.stop()
print('ALL OK' if not fails else f'{len(fails)} FAILED'); sys.exit(1 if fails else 0)
