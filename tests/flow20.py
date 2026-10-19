"""Public holidays: add / edit (move the date) / delete save at once; a moved holiday fixes the schedule and absences for everyone."""
import sys, os, time; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import seed_payload, BASE, serve, route
from playwright.sync_api import sync_playwright
p = seed_payload({'settings/migration': {'done': True}, 'settings/general': {'trackingStart': '2026-01-01'}, 'settings/holidays': {'days': {'2026-10-06': 'عيد القوات المسلحة', '2026-01-07': 'عيد الميلاد المجيد'}}})
fails = []
def ok(c, m): print(('OK ' if c else 'FAIL ') + m); (None if c else fails.append(m))
srv = serve(); pw = sync_playwright().start(); br = pw.chromium.launch()
ctx = br.new_context(viewport={'width': 1366, 'height': 900}, locale='ar-EG', timezone_id='Africa/Cairo'); ctx.route('**/*', route)
errs = []
pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('dialog', lambda d: d.accept())
pg.goto(BASE + '/tests/blank.html')
pg.evaluate("(p) => { localStorage.clear(); localStorage.setItem('mockauth_users', JSON.stringify(p.auth)); localStorage.setItem('mockfs', JSON.stringify(p.fs)); localStorage.setItem('am_lang','ar'); }", p)
pg.goto(BASE + '/index.html'); pg.fill('#email', 'admin@almaster.tech'); pg.fill('#password', 'Passw0rd!'); pg.click('#login-btn')
pg.wait_for_url('**/app.html**'); pg.wait_for_selector('#splash', state='detached')
hol = lambda: pg.evaluate("() => (JSON.parse(localStorage.getItem('mockfs') || '{}')['settings/holidays'] || {}).days || {}")
status = lambda d: pg.evaluate("""async (d) => { const r = await import('/assets/js/services/reports.js'); const pm = await r.personMonth('emp1@almaster.tech', d.slice(0, 7)); const row = (pm.rows || pm.days || []).find(x => x.date === d); return row ? row.status : JSON.stringify(Object.keys(pm)); }""", d)
ok(status('2026-10-06') == 'holiday' and status('2026-10-08') != 'holiday', f'before: 6 Oct holiday, 8 Oct a working day ({status("2026-10-06")}, {status("2026-10-08")})')

pg.evaluate("h => location.hash = h", '#/settings'); pg.wait_for_timeout(1000)
pg.locator('#st [data-p=holidays]').click(); pg.wait_for_timeout(500)
# add: saved at once (no extra Save button)
pg.fill('#add [name=d]', '2026-12-25'); pg.fill('#add [name=n]', 'عطلة تجربة'); pg.locator('#add button').click(); pg.wait_for_timeout(800)
ok(hol().get('2026-12-25') == 'عطلة تجربة', 'adding saves at once')
ok(pg.locator('#save').count() == 0, 'no separate Save button to forget')
# move 6 Oct → 8 Oct
pg.locator('[data-edit="2026-10-06"]').click(); pg.wait_for_timeout(300)
pg.fill('.hol-edit [name=d]', '2026-10-08'); pg.fill('.hol-edit [name=n]', 'عيد القوات المسلحة (مرحّل)'); pg.locator('.hol-edit [type=submit]').click(); pg.wait_for_timeout(800)
h = hol()
ok('2026-10-06' not in h and h.get('2026-10-08') == 'عيد القوات المسلحة (مرحّل)', f'moved and renamed ({h})')
pg.screenshot(path='shots/f20-holidays.png', full_page=True)
ok(pg.locator('[data-edit="2026-10-08"]').count() == 1 and pg.locator('[data-edit="2026-10-06"]').count() == 0, 'list shows the new date right away')
ok(status('2026-10-08') == 'holiday' and status('2026-10-06') != 'holiday', f'after: 8 Oct holiday for everyone, 6 Oct a normal day ({status("2026-10-08")}, {status("2026-10-06")})')
# the schedule page shows it
pg.evaluate("h => location.hash = h", '#/schedules'); pg.wait_for_timeout(1000)
plan = pg.evaluate("async () => { const p = await import('/assets/js/core/policy.js'); return [p.planFor('2026-10-08', null, 'emp2@almaster.tech').mode, p.planFor('2026-10-06', null, 'emp2@almaster.tech').mode]; }")
ok(plan == ['holiday', 'office'], f'schedule: 8 Oct holiday, 6 Oct office ({plan})')
# template doesn't bring the old date back
pg.evaluate("h => location.hash = h", '#/settings'); pg.wait_for_timeout(800); pg.locator('#st [data-p=holidays]').click(); pg.wait_for_timeout(400)
pg.click('#tpl'); pg.wait_for_timeout(800)
ok('2026-10-06' not in hol(), 'fixed-holiday button does not re-add a moved holiday')
# delete
pg.locator('[data-del="2026-12-25"]').click(); pg.wait_for_timeout(400); pg.locator('.modal [data-yes]').click(); pg.wait_for_timeout(800)
ok('2026-12-25' not in hol(), 'delete saves at once')
print('errors', errs); ok(not errs, 'no page errors')
br.close(); pw.stop(); print('FAILS:', fails) if fails else print('ALL OK'); sys.exit(1 if fails else 0)
