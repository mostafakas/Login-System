"""Monthly attendance: the stat tiles stay, and below them a row per day — in, out, work (working + meetings),
meetings, breaks, lateness, early leave — with the month's totals; clicking a row opens the day."""
import sys, os, time; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import seed_payload, BASE, serve, route
from playwright.sync_api import sync_playwright
fails = []
def ok(c, m): print(('OK ' if c else 'FAIL ') + m); (None if c else fails.append(m))
def cairo(day, hm): h, m = map(int, hm.split(':')); return int(time.mktime(time.strptime(day, '%Y-%m-%d')) - time.timezone) * 1000 + ((h - 3) * 60 + m) * 60000
H = 3600000
days = {
  '2026-10-04': dict(checkInMs=cairo('2026-10-04', '08:10'), checkOutMs=cairo('2026-10-04', '17:05'), workMs=7 * H, meetingMs=1 * H, breakMs=H // 2, mode='office', shift='8', closed=True),
  '2026-10-05': dict(checkInMs=cairo('2026-10-05', '09:45'), checkOutMs=cairo('2026-10-05', '18:00'), workMs=6 * H, meetingMs=2 * H, breakMs=H // 4, mode='remote', shift='9', closed=True),
}
extra = {'settings/migration': {'done': True}, 'settings/general': {'trackingStart': '2026-10-01', 'workStart': '09:00', 'workEnd': '17:00', 'graceMinutes': 15}}
for d, v in days.items(): extra[f'attendance_days/emp1@almaster.tech_{d}'] = {'email': 'emp1@almaster.tech', 'date': d, 'leaderEmail': 'leader@almaster.tech', **v}
p = seed_payload(extra)
srv = serve(); pw = sync_playwright().start(); br = pw.chromium.launch(executable_path=os.environ.get('PW_CHROMIUM') or None)
ctx = br.new_context(viewport={'width': 1366, 'height': 900}, locale='ar-EG', timezone_id='Africa/Cairo'); ctx.route('**/*', route)
ctx.clock.install(time=cairo('2026-10-06', '12:00') / 1000)
errs = []
pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
pg.goto(BASE + '/tests/blank.html')
pg.evaluate("(p) => { localStorage.clear(); localStorage.setItem('mockauth_users', JSON.stringify(p.auth)); localStorage.setItem('mockfs', JSON.stringify(p.fs)); localStorage.setItem('am_lang','ar'); }", p)
pg.goto(BASE + '/index.html'); pg.fill('#email', 'emp1@almaster.tech'); pg.fill('#password', 'Passw0rd!'); pg.click('#login-btn')
pg.wait_for_url('**/app.html**'); pg.wait_for_selector('#splash', state='detached')
pg.evaluate("h => location.hash = h", '#/attendance'); pg.wait_for_selector('.day-table', timeout=8000); pg.wait_for_timeout(500)
ok(pg.locator('.card.stat').count() == 8, 'the eight stat tiles are still on top')
ok(pg.locator('.cal').count() == 0, 'no calendar any more')
rows = pg.locator('.day-table tbody tr')
ok(rows.count() == 6, f'a row for each day up to today ({rows.count()})')
r4 = pg.locator('.day-table tr[data-day="2026-10-04"]').inner_text().replace('\n', ' | ').replace('\t', ' | ')
print('oct 4:', r4)
ok('08:10' in r4 and '05:05' in r4, 'oct 4 shows check-in and check-out')
ok('8س' in r4 and '1س' in r4 and '30د' in r4, 'oct 4: work 8h (7 working + 1 meeting), meetings 1h, break 30m')
r5 = pg.locator('.day-table tr[data-day="2026-10-05"]').inner_text().replace('\n', ' | ').replace('\t', ' | ')
print('oct 5:', r5)
ok('أونلاين' in r5 and '45د' in r5, 'oct 5: remote, 45 min late (09:45 on the 09:00 shift, remote grace 15)')
foot = pg.locator('.day-table tfoot').inner_text().replace('\n', ' | ').replace('\t', ' | '); print('total:', foot)
ok('16س' in foot, 'total work 16h (8 + 8)')
card = pg.locator('.card.stat', has_text='ساعات الشغل').inner_text().replace('\n', ' | '); print('card:', card)
ok('16س' in card, 'the work-hours card counts work + meetings, no breaks (16h, same as the table)')
r3 = pg.locator('.day-table tr[data-day="2026-10-03"]').inner_text(); ok('راحة' in r3, 'a day off shows as a day off')
if os.environ.get('SHOT'): pg.screenshot(path=os.environ['SHOT'], full_page=True)
pg.click('.day-table tr[data-day="2026-10-04"]'); pg.wait_for_selector('.modal'); pg.wait_for_timeout(400)
ok('سجل الحالات' in pg.locator('.modal').last.inner_text(), 'clicking a row opens the day details')
print('errors', errs); ok(not errs, 'no page errors')
br.close(); pw.stop(); srv.shutdown(); print('FAILS:', fails) if fails else print('ALL OK'); sys.exit(1 if fails else 0)
