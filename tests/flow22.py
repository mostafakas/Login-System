"""Shifts (08/09/10, picked at start), grace (office 30, remote 15), counting from the shift start, resume,
fixed-shift exception, separate late / early permissions, the request page's types and admin-defined types."""
import sys, os, time; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import seed_payload, BASE, serve, route
from playwright.sync_api import sync_playwright
fails = []
def ok(c, m): print(('OK ' if c else 'FAIL ') + m); (None if c else fails.append(m))
DAY = '2026-10-22'                      # a Thursday (working day); Cairo is UTC+3 that day
def cairo(hm): h, m = map(int, hm.split(':')); return int(time.mktime(time.strptime(f'{DAY} 00:00', '%Y-%m-%d %H:%M')) - time.timezone) * 1000 + ((h - 3) * 60 + m) * 60000
p = seed_payload({'settings/migration': {'done': True}, 'settings/general': {'trackingStart': '2026-01-01', 'workStart': '09:00', 'workEnd': '17:00', 'graceMinutes': 15}})
p['fs']['users/emp2@almaster.tech'].update({'workStart': '09:00', 'workEnd': '18:00'})     # an exception: fixed on the 09:00 shift
srv = serve(); pw = sync_playwright().start(); br = pw.chromium.launch(executable_path=os.environ.get('PW_CHROMIUM') or None)
errs = []
def open_as(email, at):
    ctx = br.new_context(viewport={'width': 1366, 'height': 860}, locale='ar-EG', timezone_id='Africa/Cairo'); ctx.route('**/*', route)
    ctx.clock.install(time=at / 1000)
    pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(BASE + '/tests/blank.html')
    if not open_as.seeded:
        pg.evaluate("(p) => { localStorage.clear(); localStorage.setItem('mockauth_users', JSON.stringify(p.auth)); localStorage.setItem('mockfs', JSON.stringify(p.fs)); localStorage.setItem('am_lang','ar'); }", p)
        open_as.seeded = True
    else:
        pg.evaluate("(s) => { localStorage.setItem('mockauth_users', JSON.stringify(s.auth)); localStorage.setItem('mockfs', s.fs); localStorage.setItem('am_lang','ar'); }", {'auth': p['auth'], 'fs': open_as.fs})
    pg.goto(BASE + '/index.html'); pg.fill('#email', email); pg.fill('#password', 'Passw0rd!'); pg.click('#login-btn')
    pg.wait_for_url('**/app.html**'); pg.wait_for_selector('#splash', state='detached'); pg.wait_for_timeout(800)
    return ctx, pg
open_as.seeded = False
def save(pg): open_as.fs = pg.evaluate("() => localStorage.getItem('mockfs')")
ev = lambda pg, js, arg=None: pg.evaluate(js, arg)

# 1) emp1 at 08:40 in the office: the picker offers the three shifts; 08:00 is late (40 > 30), 09:00 counts from 09:00
ctx, pg = open_as('emp1@almaster.tech', cairo('08:40'))
pg.click('#start-btn'); pg.click('[data-mode="office"]'); pg.wait_for_selector('[data-shift]')
txt = pg.locator('.modal').last.inner_text(); print('picker:', txt.replace('\n', ' | ')[:300])
ok(pg.locator('[data-shift]').count() == 3, 'three shifts offered')
ok('تأخير 40' in pg.locator('[data-shift="8"]').inner_text(), '08:00 shift shows 40 min late')
ok('العدّ من 09:00' in pg.locator('[data-shift="9"]').inner_text(), '09:00 shift counts from 09:00')
pg.click('[data-shift="9"]'); pg.wait_for_timeout(1500)
u = ev(pg, "() => JSON.parse(localStorage.getItem('mockfs'))['users/emp1@almaster.tech']")
ok(u['shift'] == '9' and u['status'] == 'Online', f"day started on the 09:00 shift ({u.get('shift')})")
ok('العدّ هيبدأ الساعة 09:00' in pg.locator('#hero').inner_text(), 'hero says counting starts at 09:00')
bank = lambda: ev(pg, "async () => { const a = await import('/assets/js/services/attendance.js'); const s = await import('/assets/js/core/session.js'); return a.liveBank(s.session.profile).Online; }")
ok(bank() == 0, 'nothing counted before 09:00')
pg.clock.fast_forward('30:00'); pg.wait_for_timeout(300)          # 09:10
b = bank(); ok(abs(b - 10 * 60000) < 90000, f'at 09:10 about 10 min counted ({b // 60000} min)')
late = ev(pg, """async () => { const r = await import('/assets/js/services/reports.js'); const pol = await import('/assets/js/core/policy.js'); const s = await import('/assets/js/core/session.js');
  const u = s.session.profile; return r.classifyDay(u.dayKey, pol.planFor(u.dayKey, null, s.session.email), { checkInMs: u.firstOnlineAt.toMillis ? u.firstOnlineAt.toMillis() : Date.now(), mode: 'office', shift: u.shift }, [], u.dayKey).late; }""")
ok(late == 0, 'not late on the 09:00 shift')
# leaving mid-day and coming back continues the same day and shift
pg.click('#end-btn'); pg.click('.modal .btn-danger'); pg.wait_for_timeout(1200)
pg.click('#start-btn'); pg.click('[data-mode="office"]'); pg.wait_for_timeout(1500)
ok(pg.locator('[data-shift]').count() == 0, 'resuming does not ask for a shift again')
u = ev(pg, "() => JSON.parse(localStorage.getItem('mockfs'))['users/emp1@almaster.tech']")
ok(u['shift'] == '9' and u['status'] == 'Online', 'resumed on the same shift')

# 2) permissions: one late-arrival and one early-leave a month, each on its own
sub = lambda k: ev(pg, """async (k) => { const m = await import('/assets/js/services/requests.js'); try { await m.submitRequest({ type: 'excuse', date: '2026-10-25', fromTime: k === 'late' ? '09:00' : '16:00', toTime: k === 'late' ? '10:00' : '17:00', excuseKind: k, reason: 't' }); return 'ok'; } catch (e) { return e.userMessage || e.message; } }""", k)
ok(sub('late') == 'ok', 'first late-arrival permission accepted')
r = sub('late'); ok('مرة واحدة' in r, f'second late-arrival refused ({r[:60]})')
ok(sub('early') == 'ok', 'early-leave permission accepted on its own')
r = sub('early'); ok('مرة واحدة' in r, 'second early-leave refused')
# 3) the request page offers the five types
keys = ev(pg, "async () => (await import('/assets/js/core/policy.js')).requestChoices().map(c => c.key)")
ok(keys == ['leave', 'remote', 'excuse:late', 'excuse:early', 'advance'], f'employee request types: {keys}')
quick = pg.locator('#quick [data-rq]').count(); ok(quick == 5, f'quick requests shows 5 ({quick})')
save(pg); ctx.close()

# 4) emp2 (fixed 09:00–18:00) remote at 09:20: no picker, remote grace is 15 → 20 min late
ctx, pg = open_as('emp2@almaster.tech', cairo('09:20'))
pg.click('#start-btn'); pg.click('[data-mode="remote"]'); pg.wait_for_timeout(1500)
ok(pg.locator('[data-shift]').count() == 0, 'fixed-shift employee is not asked to pick')
hero = pg.locator('#hero').inner_text(); print('hero:', hero.replace('\n', ' | ')[:200])
ok('تأخير 20' in hero, 'remote 09:20 on a 09:00 shift is 20 min late (grace 15)')
save(pg); ctx.close()

# 5) leader in the office at 08:29 on the 08:00 shift: within the 30-minute grace
ctx, pg = open_as('leader@almaster.tech', cairo('08:29'))
pg.click('#start-btn'); pg.click('[data-mode="office"]'); pg.wait_for_selector('[data-shift]')
ok('من غير تأخير' in pg.locator('[data-shift="8"]').inner_text(), '08:29 on the 08:00 shift is on time')
pg.click('[data-shift="8"]'); pg.wait_for_timeout(1500)
ok('تأخير' not in pg.locator('#hero').inner_text(), 'hero shows no lateness')
save(pg); ctx.close()

# 6) admin adds a request type; the employee files it and it goes to their manager
ctx, pg = open_as('admin@almaster.tech', cairo('10:00'))
pg.evaluate("h => location.hash = h", '#/settings/types'); pg.wait_for_timeout(1200)
if not pg.locator('#add-ct').count(): pg.click('[data-p="types"]'); pg.wait_for_timeout(500)
pg.click('#add-ct'); pg.fill('tr[data-i="0"] [data-f=ar]', 'بدل مواصلات'); pg.fill('tr[data-i="0"] [data-f=en]', 'Transport allowance')
pg.select_option('tr[data-i="0"] [data-f=dates]', 'day'); pg.click('#save'); pg.wait_for_timeout(1200)
ct = ev(pg, "() => JSON.parse(localStorage.getItem('mockfs'))['settings/general'].customRequestTypes")
ok(ct and ct[0]['ar'] == 'بدل مواصلات' and ct[0]['dates'] == 'day', f'custom type saved ({ct})')
save(pg); ctx.close()
ctx, pg = open_as('emp1@almaster.tech', cairo('10:05'))
cid = ct[0]['id']
ok(pg.locator(f'#quick [data-rq="custom:{cid}"]').count() == 1, 'the new type shows on the employee page')
pg.click(f'#quick [data-rq="custom:{cid}"]'); pg.wait_for_timeout(500); pg.fill('[name=reason]', 'مشوار عميل'); pg.click('#rq-send'); pg.wait_for_timeout(1500)
reqs = ev(pg, "() => Object.values(JSON.parse(localStorage.getItem('mockfs'))).filter(d => d && d.type === 'custom')")
ok(len(reqs) == 1 and reqs[0]['status'] == 'pending_leader' and reqs[0]['customType'] == cid, f"custom request filed to the manager ({[(r['status'], r.get('customType')) for r in reqs]})")
ctx.close()
print('errors', errs); ok(not errs, 'no page errors')
br.close(); pw.stop(); srv.shutdown(); print('FAILS:', fails) if fails else print('ALL OK'); sys.exit(1 if fails else 0)
