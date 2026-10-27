"""Monthly attendance table filter: office / remote / leave / absence day buttons with counts, the table and its
totals follow the chosen filter, an empty filter says so, and the choice is kept when switching months."""
import sys, os, time; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import seed_payload, BASE, serve, route
from playwright.sync_api import sync_playwright
fails = []
def ok(c, m): print(('OK ' if c else 'FAIL ') + m); (None if c else fails.append(m))
def cairo(day, hm): h, m = map(int, hm.split(':')); return int(time.mktime(time.strptime(day, '%Y-%m-%d')) - time.timezone) * 1000 + ((h - 3) * 60 + m) * 60000
H = 3600000
E = 'emp1@almaster.tech'
def day(d, mode='office'):
    return {f'attendance_days/{E}_{d}': {'email': E, 'date': d, 'leaderEmail': 'leader@almaster.tech', 'checkInMs': cairo(d, '09:00'), 'checkOutMs': cairo(d, '18:00'), 'workMs': 8 * H, 'meetingMs': 0, 'breakMs': 0, 'mode': mode, 'shift': '9', 'closed': True}}
extra = {'settings/migration': {'done': True}, 'settings/general': {'trackingStart': '2026-10-01', 'workStart': '09:00', 'workEnd': '17:00', 'graceMinutes': 15}}
# Thu 1st and Sun 4th at the office, Mon 5th remote, Tue 6th on leave, Wed 7th absent, Thu 8th is today
extra.update(day('2026-10-01')); extra.update(day('2026-10-04')); extra.update(day('2026-10-05', 'remote'))
extra[f'schedules/{E}_2026-10'] = {'email': E, 'month': '2026-10', 'leaderEmail': 'leader@almaster.tech', 'days': {'2026-10-06': {'mode': 'leave', 'leaveType': 'annual'}}}
p = seed_payload(extra)
for e in p['fs']:
    if e.startswith('users/'): p['fs'][e]['createdAt'] = {'__ts': cairo('2025-01-01', '09:00')}

srv = serve(); pw = sync_playwright().start(); br = pw.chromium.launch(executable_path=os.environ.get('PW_CHROMIUM') or None)
ctx = br.new_context(viewport={'width': 1440, 'height': 950}, locale='ar-EG', timezone_id='Africa/Cairo'); ctx.route('**/*', route)
ctx.clock.install(time=cairo('2026-10-08', '12:00') / 1000)
errs = []
pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
pg.goto(BASE + '/tests/blank.html')
pg.evaluate("(p) => { localStorage.clear(); localStorage.setItem('mockauth_users', JSON.stringify(p.auth)); localStorage.setItem('mockfs', JSON.stringify(p.fs)); localStorage.setItem('am_lang','ar'); }", p)
pg.goto(BASE + '/index.html'); pg.fill('#email', E); pg.fill('#password', 'Passw0rd!'); pg.click('#login-btn')
pg.wait_for_url('**/app.html**'); pg.wait_for_selector('#splash', state='detached')
pg.evaluate("h => location.hash = h", '#/attendance'); pg.wait_for_selector('#pm-filter [data-f]', timeout=8000)

count = lambda k: pg.locator(f'#pm-filter [data-f="{k}"] .badge').inner_text().strip()
days = lambda: [int(t.split()[0]) for t in pg.locator('#pm-table tbody tr td:first-child').all_inner_texts()]
counts = {k: count(k) for k in ['all', 'office', 'remote', 'leave', 'absent']}; print('counts', counts)
ok(counts == {'all': '8', 'office': '2', 'remote': '1', 'leave': '1', 'absent': '1'}, 'each filter shows how many days it matches')
ok(pg.locator('#pm-filter [data-f="all"]').get_attribute('class') == 'on' and len(days()) == 8, 'all days shown by default')

def pick(k): pg.click(f'#pm-filter [data-f="{k}"]'); pg.wait_for_timeout(150)
pick('office'); ok(days() == [1, 4], f'office filter: the 1st and 4th ({days()})')
ok('16' in pg.locator('#pm-table tfoot').inner_text(), 'totals add up only the filtered days (16 hours)')
pick('remote'); ok(days() == [5], f'remote filter: the 5th ({days()})')
pick('leave'); ok(days() == [6], f'leave filter: the 6th ({days()})')
pick('absent'); ok(days() == [7], f'absence filter: the 7th ({days()})')
pg.locator('#pm-table tbody tr').first.click(); pg.wait_for_selector('.modal-root', timeout=3000)
ok('غياب' in pg.locator('.modal-root').inner_text(), 'clicking a filtered row still opens that day')
pg.keyboard.press('Escape'); pg.wait_for_timeout(300)
if pg.locator('.modal-root').count(): pg.locator('.modal-root [data-close]').first.click(); pg.wait_for_timeout(200)

pg.click('[data-m="1"]'); pg.wait_for_selector('#pm-filter [data-f]', timeout=8000); pg.wait_for_timeout(200)
ok(pg.locator('#pm-filter [data-f="absent"]').get_attribute('class') == 'on', 'the filter is kept when switching months')
ok('مفيش أيام' in pg.locator('#pm-table').inner_text(), 'a month with no matching days says so')
pg.click('[data-m="-1"]'); pg.wait_for_selector('#pm-filter [data-f]', timeout=8000); pg.wait_for_timeout(200)
pick('all'); ok(len(days()) == 8, 'back to all days')
pg.screenshot(path=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'shots', 'f27-day-filter.png'), full_page=False)

print('errors', errs); ok(not [e for e in errs if 'favicon' not in e], 'no page errors')
br.close(); pw.stop()
print('ALL OK' if not fails else f'{len(fails)} FAILED'); sys.exit(1 if fails else 0)
