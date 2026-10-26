"""Org chart layout with a 16-person company (COO → PM → dev leader with 5 devs, SEO supervisor with 3 specialists and a
content leader with 2 writers; sales manager alone): the whole chart fits the card with no sideways scrolling, people
without a team stack under their manager, and every full name and title shows (no ellipsis)."""
import sys, os, time; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import seed_payload, BASE, serve, route
from playwright.sync_api import sync_playwright
fails = []
def ok(c, m): print(('OK ' if c else 'FAIL ') + m); (None if c else fails.append(m))
def cairo(day, hm): h, m = map(int, hm.split(':')); return int(time.mktime(time.strptime(day, '%Y-%m-%d')) - time.timezone) * 1000 + ((h - 3) * 60 + m) * 60000
D = '@test.tech'
org = [  # email, name, title, role, manager, department, salary
    ('coo', 'Mostafa Abdelrahman Mahmoud', 'Chief Operating Officer', 'admin', '', 'Management', 15000),
    ('pm', 'Ahmed Shehata Abdelaziz', 'Project Manager', 'pm', 'coo', 'Management', 16000),
    ('sales', 'Magda Elsayed', 'Sales manager', 'sales_manager', 'coo', 'Management', 12000),
    ('acc', 'Mahmoud Lotfy', 'Accountant', 'finance', 'coo', 'Management', 5000),
    ('devlead', 'Ahmed Sapry', 'Web Dev', 'leader', 'pm', 'Development', 20000),
    ('d1', 'Abdallah Morsy', 'Backend Developer', 'employee', 'devlead', 'Development', 18500),
    ('d2', 'Ahmed Abo ELkher', 'Web Dev', 'employee', 'devlead', 'Development', 6000),
    ('d3', 'Ahmed Salah', 'Mobile Dev', 'employee', 'devlead', 'Development', 11000),
    ('d4', 'Fares Elsayed', 'Frontend Developer', 'employee', 'devlead', 'Development', 14000),
    ('d5', 'Mohamed Shehata', 'Fullstack Developer', 'employee', 'devlead', 'Development', 7000),
    ('seo', 'Moheyeldeen Mahmoud Abdelghany', 'SEO Team Supervisor', 'team_supervisor', 'pm', 'SEO', 30000),
    ('s1', 'Khaled Gadalla', 'SEO Specialist', 'employee', 'seo', 'SEO', 25000),
    ('s2', 'Osama Ghareb', 'SEO Specialist', 'employee', 'seo', 'SEO', 8000),
    ('s3', 'Sabah Sobhy', 'SEO Specialist', 'employee', 'seo', 'SEO', 12500),
    ('content', 'Sara Mohamed', 'Copy Writing', 'leader', 'seo', 'Content', 14000),
    ('c1', 'Ahmed Yahia', 'Writer', 'employee', 'content', 'Content', 10000),
    ('c2', 'Linaa Wael', 'Content writing', 'employee', 'content', 'SEO', 11000),
]
p = seed_payload({'settings/migration': {'done': True}, 'settings/general': {'trackingStart': '2026-10-01', 'workStart': '09:00', 'workEnd': '17:00', 'graceMinutes': 15}})
fs = {k: v for k, v in p['fs'].items() if not k.startswith(('users/', 'employees_private/'))}
auth = {}
pct = {'basic': {'mode': 'pct', 'value': 50}, 'allowances': {'mode': 'pct', 'value': 20}, 'regularity': {'mode': 'pct', 'value': 10}, 'kpi': {'mode': 'pct', 'value': 20}}
for e, n, t, r, l, d, sal in org:
    fs[f'users/{e}{D}'] = {'name': n, 'title': t, 'role': r, 'leaderEmail': (l + D) if l else '', 'department': d, 'status': 'Offline', 'isSuspended': False, 'trackAttendance': False,
                           'timeBank': {'Online': 0, 'Break': 0, 'Meeting': 0}, 'permissions': {'payroll': e == 'coo'}, 'createdAt': {'__ts': cairo('2025-01-01', '09:00')}}
    fs[f'employees_private/{e}{D}'] = {'email': e + D, 'salary': {'total': sal, 'parts': pct}, 'contract': 'fulltime'}
    auth[e + D] = {'password': 'Passw0rd!'}
p = {'auth': auth, 'fs': fs}

srv = serve(); pw = sync_playwright().start(); br = pw.chromium.launch(executable_path=os.environ.get('PW_CHROMIUM') or None)
errs = []
def run(width, height, theme, shot):
    ctx = br.new_context(viewport={'width': width, 'height': height}, locale='ar-EG', timezone_id='Africa/Cairo'); ctx.route('**/*', route)
    ctx.clock.install(time=cairo('2026-10-26', '12:00') / 1000)
    pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    pg.goto(BASE + '/tests/blank.html')
    pg.evaluate("([p, t]) => { localStorage.clear(); localStorage.setItem('mockauth_users', JSON.stringify(p.auth)); localStorage.setItem('mockfs', JSON.stringify(p.fs)); localStorage.setItem('am_lang','ar'); localStorage.setItem('am_theme', t); }", [p, theme])
    pg.goto(BASE + '/index.html'); pg.fill('#email', 'coo' + D); pg.fill('#password', 'Passw0rd!'); pg.click('#login-btn')
    pg.wait_for_url('**/app.html**'); pg.wait_for_selector('#splash', state='detached')
    pg.evaluate("h => location.hash = h", '#/org'); pg.wait_for_selector('.org-tree', timeout=8000); pg.wait_for_timeout(900)
    tag = f'{width}x{height}'
    ok(pg.locator('.org-node').count() == 17, f'{tag}: 17 cards')
    grp = pg.locator('.org-group', has=pg.locator('.org-node[data-email="acc@test.tech"]'))
    ok(grp.count() == 1 and 'Mostafa Abdelrahman Mahmoud' in grp.locator('.org-group-head').inner_text() and grp.locator('.org-node[data-email="sales@test.tech"]').count() == 1,
       f'{tag}: the accountant and the sales manager both report to the COO and sit in one group titled with his name (not one under the other)')
    ok(pg.locator('.org-node[data-email="sales@test.tech"] .org-toggle').count() == 0, f'{tag}: the sales manager shows no team of her own')
    box = pg.evaluate("""() => { const b = document.querySelector('.org-scroll'), t = document.querySelector('.org-tree'), r = t.getBoundingClientRect(), br = b.getBoundingClientRect();
      return { zoom: t.style.zoom, tw: r.width, bw: br.width, left: r.left - br.left, right: br.right - r.right, sw: b.scrollWidth, cw: b.clientWidth, th: r.height, vh: innerHeight }; }""")
    print(tag, box)
    if width >= 1024: ok(box['left'] >= 0 and box['right'] >= 0 and box['sw'] <= box['cw'] + 1, f'{tag}: the whole chart fits inside the card, nothing cut on either side, no sideways scroll')
    else: ok(box['sw'] > box['cw'] and float(box['zoom']) >= 0.5, f'{tag}: on a phone the chart stays readable and scrolls sideways inside its card')
    ok(pg.evaluate("() => document.documentElement.scrollWidth <= innerWidth + 1"), f'{tag}: no horizontal page scroll')
    cut = pg.evaluate("() => [...document.querySelectorAll('.org-top b, .org-top span')].filter(e => e.scrollWidth > e.clientWidth + 1 || getComputedStyle(e).textOverflow === 'ellipsis' && getComputedStyle(e).overflow === 'hidden').map(e => e.textContent)")
    ok(not cut, f'{tag}: every name and title shows in full {cut}')
    ok('Moheyeldeen Mahmoud Abdelghany' in pg.locator('.org-tree').inner_text(), f'{tag}: the long name is written in full')
    stacked = pg.locator('.org-node[data-email="devlead@test.tech"] ~ .org-group .org-node').count()
    ok(stacked == 5, f'{tag}: the 5 developers stack in a column under their leader ({stacked})')
    if width >= 1366: ok(float(box['zoom']) >= 0.75, f'{tag}: still readable (zoom {box["zoom"]})')
    if width == 1920: ok(box['th'] <= box['vh'] - 40, f'{tag}: on a full-HD screen the whole chart fits the screen height too')
    if shot:
        pg.evaluate("() => document.querySelector('.org-scroll').scrollIntoView({block: 'start'})"); pg.wait_for_timeout(200)
        pg.screenshot(path=shot, full_page=False)
    ctx.close()
S = os.environ.get('SHOT')
run(1920, 1080, 'dark', S and S + '-1920-dark.png')
run(1366, 768, 'light', S and S + '-1366-light.png')
run(390, 844, 'light', S and S + '-phone.png')
print('errors', errs); ok(not errs, 'no page errors')
br.close(); pw.stop(); srv.shutdown(); print('FAILS:', fails) if fails else print('ALL OK'); sys.exit(1 if fails else 0)
