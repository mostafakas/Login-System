"""Late-arrival and early-leave permissions: each once a month (setting), the form says so, a second one of the same kind is refused."""
import sys, os, time; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import seed_payload, BASE, serve, route
from playwright.sync_api import sync_playwright
p = seed_payload({'settings/migration': {'done': True}})
fails = []
def ok(c, m): print(('OK ' if c else 'FAIL ') + m); (None if c else fails.append(m))
srv = serve(); pw = sync_playwright().start(); br = pw.chromium.launch()
ctx = br.new_context(viewport={'width': 1366, 'height': 860}, locale='ar-EG', timezone_id='Africa/Cairo'); ctx.route('**/*', route)
errs = []
pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
pg.goto(BASE + '/tests/blank.html')
pg.evaluate("(p) => { localStorage.clear(); localStorage.setItem('mockauth_users', JSON.stringify(p.auth)); localStorage.setItem('mockfs', JSON.stringify(p.fs)); localStorage.setItem('am_lang','ar'); }", p)
pg.goto(BASE + '/index.html'); pg.fill('#email', 'emp1@almaster.tech'); pg.fill('#password', 'Passw0rd!'); pg.click('#login-btn')
pg.wait_for_url('**/app.html**'); pg.wait_for_selector('#splash', state='detached')
day = time.strftime('%Y-%m-%d', time.gmtime(time.time() + 3 * 3600))
nxt = time.strftime('%Y-%m', time.gmtime(time.time() + 3 * 3600 + 32 * 86400)) + '-05'
sub = lambda d, k='late': pg.evaluate("""async ([d, k]) => { const m = await import('/assets/js/services/requests.js'); try { await m.submitRequest({ type: 'excuse', date: d, fromTime: k === 'late' ? '09:00' : '16:00', toTime: k === 'late' ? '10:00' : '17:00', excuseKind: k, reason: 'test' }); return 'ok'; } catch (e) { return e.userMessage || e.message; } }""", [d, k])
ok(sub(day) == 'ok', 'first permission this month accepted')
r = sub(day)
ok('مرة واحدة' in r, f'a second late-arrival permission in the same month refused ({r})')
ok(sub(day, 'early') == 'ok', 'an early-leave permission has its own monthly limit')
ok(sub(nxt) == 'ok', 'next month is fine')
# the form tells them
pg.evaluate("h => location.hash = h", '#/requests'); pg.wait_for_timeout(1200)
pg.evaluate("async () => { const m = await import('/assets/js/views/request-form.js'); m.openRequestForm('excuse:late'); }")
pg.wait_for_timeout(1500)
txt = pg.locator('.modal').inner_text() if pg.locator('.modal').count() else ''
print('form:', txt[:300].replace('\n', ' | '))
ok('استخدمت إذن تأخير' in txt, 'request form says this month\'s permission is used')
# cancelling frees it
pg.evaluate("""async () => { const fb = await import('/assets/js/core/fb.js'); const m = await import('/assets/js/services/requests.js'); const s = await import('/assets/js/core/session.js');
  const rows = (await fb.list(fb.query(fb.col('requests'), fb.where('email', '==', s.session.email)))).filter(r => r.type === 'excuse' && r.startDate.slice(0, 7) === new Date().toISOString().slice(0, 7));
  for (const r of rows) await m.cancelRequest(r.id); }""")
ok(sub(day, 'early') == 'ok', 'after cancelling, a new one is accepted')
print('errors', errs); ok(not errs, 'no page errors')
br.close(); pw.stop(); print('FAILS:', fails) if fails else print('ALL OK'); sys.exit(1 if fails else 0)
