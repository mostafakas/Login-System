"""Applications are never lost: a failed CV upload still sends the application (HR sees what's missing);
applications left unfinished show up for HR, who can add them to the applicants."""
import sys, os, time, json; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import seed_payload, BASE, ts, serve, route
from playwright.sync_api import sync_playwright
now = int(time.time() * 1000)
p = seed_payload({'settings/migration': {'done': True}, 'settings/public': {'authServiceUrl': 'https://svc.test/exec', 'loginDomain': ''}})
p['fs']['jobs/j1'] = {'title': 'Designer', 'status': 'open', 'fields': ['city'], 'questions': [], 'cvRequired': True, 'criteria': [], 'createdAt': ts(now)}
p['fs']['job_posts/j1'] = {'title': 'Designer', 'fields': ['city'], 'questions': [], 'cvRequired': True, 'open': True}
# someone who started before and whose upload failed: still a draft
p['fs']['applications/j1_01055555555'] = {'jobId': 'j1', 'jobTitle': 'Designer', 'name': 'منى قديمة', 'phone': '01055555555', 'phoneKey': '01055555555', 'email': 'old@x.com',
  'answers': {}, 'files': {}, 'source': 'linkedin', 'stage': 'screen', 'status': 'draft', 'uid': 'AnonOld', 'seen': False, 'score': None, 'createdAt': ts(now - 86400000), 'createdMs': now - 86400000}
fails = []
def ok(c, m): print(('OK ' if c else 'FAIL ') + m); (None if c else fails.append(m))
srv = serve(); pw = sync_playwright().start(); br = pw.chromium.launch()
ctx = br.new_context(viewport={'width': 1366, 'height': 900}, locale='ar-EG', timezone_id='Africa/Cairo'); ctx.route('**/*', route)
# the Apps Script is the old version: it doesn't know "rUp"
ctx.route('https://svc.test/**', lambda r: r.fulfill(status=200, body=json.dumps({'ok': False, 'error': 'unknown-action'}), headers={'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'}))
errs = []
def page():
    pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e))); return pg
H = page(); H.goto(BASE + '/tests/blank.html')
H.evaluate("(p) => { localStorage.clear(); localStorage.setItem('mockauth_users', JSON.stringify(p.auth)); localStorage.setItem('mockfs', JSON.stringify(p.fs)); localStorage.setItem('am_lang','ar'); }", p)
A = page(); A.goto(BASE + '/apply.html#j=j1&s=linkedin'); A.wait_for_timeout(1800)
A.fill('[name=name]', 'كريم جديد'); A.fill('[name=phone]', '01066666666'); A.fill('[name=email]', 'k@x.com')
A.locator('[data-file=cv]').set_input_files({'name': 'cv.pdf', 'mimeType': 'application/pdf', 'buffer': b'%PDF'})
A.click('#ago'); A.wait_for_timeout(2500)
ok('وصلنا' in A.locator('#g').inner_text(), 'application sent even though the CV upload failed')
db = lambda: H.evaluate("() => JSON.parse(localStorage.getItem('mockfs') || '{}')")
a = db().get('applications/j1_01066666666', {})
ok(a.get('status') == 'active' and a.get('missingFiles') == ['cv.pdf'], f'stored as an applicant, CV marked missing ({a.get("status")}, {a.get("missingFiles")})')
H.goto(BASE + '/index.html'); H.fill('#email', 'hr@almaster.tech'); H.fill('#password', 'Passw0rd!'); H.click('#login-btn')
H.wait_for_url('**/app.html**'); H.wait_for_selector('#splash', state='detached')
H.evaluate("h => location.hash = h", '#/recruit/jobs'); H.wait_for_timeout(1500)
ok(H.locator('.rc-job .badge.warn').count() == 1, 'jobs page flags the unfinished one')
H.evaluate("h => location.hash = h", '#/recruit/job/j1'); H.wait_for_timeout(1500)
ok(H.locator('.rc-col[data-stage=new] .rc-card').count() == 1, 'the new applicant is on the board')
ok('منى قديمة' in H.locator('#bq').evaluate("e => e.closest('.rc-page').innerText") and H.locator('[data-accept]').count() == 1, 'the unfinished one is listed with «add to applicants»')
H.screenshot(path='shots/f21-board.png', full_page=True)
H.locator('[data-accept]').click(); H.wait_for_timeout(1200)
o = db().get('applications/j1_01055555555', {})
ok(o.get('status') == 'active' and o.get('stage') == 'new', 'added to the applicants under «new»')
ok(H.locator('.rc-col[data-stage=new] .rc-card').count() == 2 and H.locator('[data-accept]').count() == 0, 'board updated')
H.locator('.rc-card', has_text='كريم جديد').click(); H.wait_for_timeout(1500)
ok('ما اترفعتش' in H.locator('#ap').inner_text(), 'applicant page says the CV is missing')
print('errors', errs); ok(not errs, 'no page errors')
br.close(); pw.stop(); print('FAILS:', fails) if fails else print('ALL OK'); sys.exit(1 if fails else 0)
