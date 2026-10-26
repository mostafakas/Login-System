"""Org chart (Finance → Org chart): the tree follows each person's direct manager, every manager's team shows its cost,
deductions and who slipped the most, the ranking orders the slips, and a change to people shows up live."""
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
# emp1: on time on the 1st and 4th, 1h late on the 5th · emp2: never came (absent 3 days) · leader: always on time
for d in ['2026-10-01', '2026-10-04']: extra.update(day('emp1@almaster.tech', d, '09:00', '18:00'))
extra.update(day('emp1@almaster.tech', '2026-10-05', '10:00', '18:00'))
for d in ['2026-10-01', '2026-10-04', '2026-10-05']: extra.update(day('leader@almaster.tech', d, '09:00', '18:00', 'admin@almaster.tech'))
p = seed_payload(extra)
fs = p['fs']
# top management is not tracked; HR and finance neither (only the software team is)
for e in ['admin@almaster.tech', 'hr@almaster.tech', 'fin@almaster.tech']: fs[f'users/{e}']['trackAttendance'] = False
fs['users/leader@almaster.tech']['department'] = 'Development'
for e in ['emp1@almaster.tech', 'emp2@almaster.tech']: fs[f'users/{e}']['department'] = 'Development'
pct = lambda b, a, r, k: {'basic': {'mode': 'pct', 'value': b}, 'allowances': {'mode': 'pct', 'value': a}, 'regularity': {'mode': 'pct', 'value': r}, 'kpi': {'mode': 'pct', 'value': k}}
fs['employees_private/emp1@almaster.tech']['salary'] = {'total': 14000, 'parts': pct(50, 20, 10, 20), 'fixedDeductions': 0}
fs['employees_private/emp2@almaster.tech']['salary'] = {'total': 9000, 'parts': pct(50, 20, 10, 20), 'fixedDeductions': 0}
fs['employees_private/emp2@almaster.tech']['contract'] = 'parttime'
fs['users/emp1@almaster.tech']['hireDate'] = '2025-03-01'
for e in fs:
    if e.startswith('users/'): fs[e]['createdAt'] = {'__ts': cairo('2025-01-01', '09:00')}   # on staff before the month

srv = serve(); pw = sync_playwright().start(); br = pw.chromium.launch(executable_path=os.environ.get('PW_CHROMIUM') or None)
ctx = br.new_context(viewport={'width': 1440, 'height': 950}, locale='ar-EG', timezone_id='Africa/Cairo'); ctx.route('**/*', route)
ctx.clock.install(time=cairo('2026-10-06', '12:00') / 1000)
errs = []
pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
pg.goto(BASE + '/tests/blank.html')
pg.evaluate("(p) => { localStorage.clear(); localStorage.setItem('mockauth_users', JSON.stringify(p.auth)); localStorage.setItem('mockfs', JSON.stringify(p.fs)); localStorage.setItem('am_lang','ar'); }", p)
def login(email):
    pg.goto(BASE + '/index.html'); pg.fill('#email', email); pg.fill('#password', 'Passw0rd!'); pg.click('#login-btn')
    pg.wait_for_url('**/app.html**'); pg.wait_for_selector('#splash', state='detached')

login('emp1@almaster.tech')
ok(pg.locator('#nav [data-route="org"]').count() == 0, 'an employee does not see the org chart')
pg.evaluate("() => { localStorage.removeItem('mockauth_current'); }")

login('fin@almaster.tech')
ok(pg.locator('#nav [data-route="org"]').count() == 1, 'finance sees "Org chart" in the menu')
pg.evaluate("h => location.hash = h", '#/org'); pg.wait_for_selector('.org-tree', timeout=8000)
pg.wait_for_function("() => !document.querySelector('#note .spinner')", timeout=8000); pg.wait_for_timeout(300)
nodes = pg.locator('.org-node'); ok(nodes.count() == 6, f'a card for each of the 6 people ({nodes.count()})')
top = pg.locator('.org-tree > ul > li > .org-node').inner_text(); ok('أحمد شحاتة' in top, 'the admin (no manager) is at the top')
lead_kids = pg.locator('.org-node[data-email="leader@almaster.tech"] ~ .org-stack .org-node').count()
ok(lead_kids == 2, f'the two developers hang under their leader ({lead_kids})')
kpi = pg.locator('#kpi').inner_text().replace('\n', ' | '); print('kpi:', kpi)
# cost: admin 18800 + hr 18800 + leader 18800 + fin 18800 (basic 18000 + 800 allowance) + emp1 14000 + emp2 9000 = 98200
ok('98,200' in kpi, 'monthly cost = everyone\'s full salary (98,200)')
ok('6' in kpi and '2 تيم' in kpi, 'headcount 6 in 2 teams')
n1 = pg.locator('.org-node[data-email="emp1@almaster.tech"]').inner_text().replace('\n', ' | '); print('emp1 card:', n1)
ok('14,000' in n1 and 'Development' in n1, 'the card shows the cost and the department')
ok('210' in n1, 'emp1 lost 210 for one check-in an hour late (15% of the 1,400 regularity)')
n2 = pg.locator('.org-node[data-email="emp2@almaster.tech"]').inner_text().replace('\n', ' | '); print('emp2 card:', n2)
ok('0%' in n2, 'emp2 never came: commitment 0%')
ok('تقديري' not in n2 and 'تقديرية' in pg.locator('#note').inner_text(), 'the note says deductions are estimated until payroll is approved')
if os.environ.get('SHOT'): pg.screenshot(path=os.environ['SHOT'] + '-chart.png', full_page=True)

pg.click('#views [data-v="teams"]'); pg.wait_for_selector('.org-team-card')
ok(pg.locator('.org-team-card').count() == 2, 'one card per manager (admin and the team leader)')
tc = pg.locator('.org-team-card', has_text='تيم كريم حسن').inner_text().replace('\n', ' | '); print('team:', tc)
ok('41,800' in tc, 'the leader\'s team costs 41,800 (18,800 + 14,000 + 9,000)')
ok('أكتر واحد مقصر' in tc and 'عمر خالد' in tc, 'the team names who slipped the most (emp2, absent)')
ok(pg.locator('.org-team-card', has_text='تيم كريم حسن').locator('tr.org-worst').count() == 1, 'and highlights that row')
if os.environ.get('SHOT'): pg.screenshot(path=os.environ['SHOT'] + '-teams.png', full_page=True)

pg.click('#views [data-v="slips"]'); pg.wait_for_timeout(300)
rows = pg.locator('#body tbody tr'); names = [rows.nth(i).inner_text() for i in range(rows.count())]
print('slips:', [n.split('\n')[1] if '\n' in n else n for n in names])
ok(rows.count() == 2 and 'عمر خالد' in names[0] and 'سارة محمود' in names[1], 'ranking: the absent one first, then the late one')

pg.click('#views [data-v="table"]'); pg.wait_for_timeout(300)
t = pg.locator('#body').inner_text(); 
ok('الإدارة العليا' in t and 'تيم كريم حسن' in t, 'the table is grouped by team')
ok('دوام جزئي' in pg.locator('#body tr', has_text='عمر خالد').inner_text(), 'contract type shows (part-time)')
ok('2025' in pg.locator('#body tr', has_text='سارة محمود').inner_text(), 'start date shows')

pg.click('#views [data-v="chart"]'); pg.wait_for_selector('.org-tree')
# live: a new hire under the leader appears without reloading
pg.evaluate("""async () => { const m = await import('/assets/js/core/fb.js');
  await m.setDoc(m.ref('users', 'new@almaster.tech'), { name: 'موظف جديد', title: 'QA', role: 'employee', leaderEmail: 'leader@almaster.tech', department: 'Development', isSuspended: false, status: 'Offline' });
  await m.setDoc(m.ref('employees_private', 'new@almaster.tech'), { email: 'new@almaster.tech', salary: { total: 5000, parts: { basic: { mode: 'pct', value: 100 } } }, contract: 'intern' }); }""")
pg.wait_for_timeout(1200)
ok(pg.locator('.org-node').count() == 7, 'a new employee appears live')
ok('103,200' in pg.locator('#kpi').inner_text(), 'and the total cost follows (103,200)')
pg.click('.org-node[data-email="emp1@almaster.tech"]'); pg.wait_for_selector('.modal')
md = pg.locator('.modal').last.inner_text().replace('\n', ' | '); print('modal:', md[:300])
ok('كريم حسن' in md and 'تقديري' in md, 'the person dialog shows the manager and the estimate tag')
pg.locator('.modal [data-close]').last.click()
pg.click('[data-action="xls"]'); pg.wait_for_timeout(500)
x = pg.evaluate("() => window.__xlsx && window.__xlsx[0] && window.__xlsx[0].wb.SheetNames")
ok(x and len(x) == 2, f'Excel has a staff and a teams sheet ({x})')
pg.click('[data-action="collapse"]'); pg.wait_for_timeout(200)
ok(pg.locator('.org-node').count() == 4, 'collapse folds the team under the leader')
pg.set_viewport_size({'width': 390, 'height': 844}); pg.wait_for_timeout(300)
ok(pg.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth + 1"), 'no horizontal page scroll on a phone (the chart scrolls inside its card)')
print('errors', errs); ok(not errs, 'no page errors')
br.close(); pw.stop(); srv.shutdown(); print('FAILS:', fails) if fails else print('ALL OK'); sys.exit(1 if fails else 0)
