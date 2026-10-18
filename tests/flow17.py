"""Recruitment: job + questions → public apply page → board → interview (online, by the candidate's link) → scorecard
→ task by link (candidate hands it in) → grade → ready emails → compare → offer → hire as an employee."""
import sys, os, time, json, re; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import seed_payload, BASE, ts, serve, route
from playwright.sync_api import sync_playwright

p = seed_payload({'settings/migration': {'done': True}, 'settings/public': {'authServiceUrl': 'https://svc.test/exec', 'loginDomain': ''}})
fails = []
def ok(c, m): print(('OK ' if c else 'FAIL ') + m); (None if c else fails.append(m))

srv = serve(); pw = sync_playwright().start()
br = pw.chromium.launch(headless=True, args=['--disable-web-security', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'])
ctx = br.new_context(viewport={'width': 1366, 'height': 900}, locale='ar-EG', timezone_id='Africa/Cairo', permissions=['microphone', 'clipboard-read', 'clipboard-write'])
ctx.route('**/*', route)
store = {}
calls_log = []
def svc(r):
    body = json.loads(r.request.post_data or '{}'); a = body.get('action'); calls_log.append((a, body.get('kind'), body.get('ref')))
    H = {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'}
    if a == 'rUp':
        did = f"d{len(store) + 1}"; store[did] = body; return r.fulfill(status=200, body=json.dumps({'ok': True, 'driveId': did, 'size': 10}), headers=H)
    if a == 'rGet':
        b = store.get(body.get('driveId'), {}); return r.fulfill(status=200, body=json.dumps({'ok': True, 'name': b.get('name', 'f'), 'mime': b.get('mime', 'application/pdf'), 'data': b.get('data', '')}), headers=H)
    return r.fulfill(status=200, body=json.dumps({'ok': True}), headers=H)
ctx.route('https://svc.test/**', svc)
errs = []
def page():
    pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append(f'PAGEERROR {e}')); pg.on('dialog', lambda d: d.accept()); return pg
def login(pg, email):
    if not pg.url.startswith(BASE): pg.goto(BASE + '/tests/blank.html')
    pg.evaluate("() => localStorage.removeItem('mockauth_current')")
    pg.goto(BASE + '/index.html'); pg.fill('#email', email); pg.fill('#password', 'Passw0rd!'); pg.click('#login-btn')
    pg.wait_for_url('**/app.html**', timeout=8000); pg.wait_for_selector('#splash', state='detached', timeout=8000)
db = lambda pg: pg.evaluate("() => JSON.parse(localStorage.getItem('mockfs') || '{}')")
docs = lambda pg, prefix: {k: v for k, v in db(pg).items() if k.startswith(prefix) and k.count('/') == prefix.count('/')}
pdf = {'name': 'cv.pdf', 'mimeType': 'application/pdf', 'buffer': b'%PDF-1.4 test cv ahmed@test.com 01012345678'}

H = page(); H.goto(BASE + '/tests/blank.html')
H.evaluate("""(p) => { localStorage.clear(); localStorage.setItem('mockauth_users', JSON.stringify(p.auth)); localStorage.setItem('mockfs', JSON.stringify(p.fs)); localStorage.setItem('am_lang', 'ar'); }""", p)
login(H, 'hr@almaster.tech')
ok(H.locator('[data-route=recruit]').count() >= 1, 'HR sees «التوظيف» in the menu')

# settings: office address
H.evaluate("h => location.hash = h", '#/recruit/settings'); H.wait_for_timeout(1000)
H.fill('#sa', 'مدينة نصر — شارع عباس العقاد 12'); H.click('#sv'); H.wait_for_timeout(600)

# 1) a job with questions
H.evaluate("h => location.hash = h", '#/recruit/jobs'); H.wait_for_timeout(1000)
H.click('#jnew'); H.wait_for_timeout(500)
H.fill('#j_title', 'Frontend Developer'); H.fill('#j_smin', '15000'); H.fill('#j_smax', '25000'); H.fill('#j_miny', '2')
H.fill('#j_desc', 'بنعمل أنظمة داخلية للشركات.'); H.fill('#j_must', 'React\nJavaScript')
H.locator('#jt .tab[data-p=qs]').click()
H.select_option('#jqt', 'yesno'); H.click('#jqa'); H.locator('[data-qi="0"] [data-k=label]').fill('تقدر تشتغل من المكتب؟'); H.locator('[data-qi="0"] [data-k=req]').check(); H.locator('[data-qi="0"] select[data-k=rule]').select_option('yes')
H.select_option('#jqt', 'number'); H.click('#jqa'); H.locator('[data-qi="1"] [data-k=label]').fill('سنين خبرة React'); H.locator('[data-qi="1"] input[data-k=rule]').fill('2')
H.select_option('#jqt', 'choice'); H.click('#jqa'); H.locator('[data-qi="2"] [data-k=label]').fill('المنطقة'); H.locator('[data-qi="2"] [data-k=opts]').fill('القاهرة\nالجيزة\nأخرى'); H.locator('[data-qi="2"] [data-k=opts]').dispatch_event('change')
H.select_option('#jqt', 'file'); H.click('#jqa'); H.locator('[data-qi="3"] [data-k=label]').fill('نموذج من شغلك')
H.screenshot(path='shots/f17-job-questions.png')
H.click('#jsave'); H.wait_for_timeout(1500)
jobs = docs(H, 'jobs/'); jid = list(jobs.keys())[0].split('/')[1] if jobs else ''
j = list(jobs.values())[0] if jobs else {}
ok(j.get('title') == 'Frontend Developer' and len(j.get('questions', [])) == 4 and j['questions'][0]['rule'] == {'equals': 'yes'}, f'job saved with 4 questions ({[q.get("type") for q in j.get("questions", [])]})')
post = db(H).get(f'job_posts/{jid}', {})
ok(post.get('open') is True and 'salaryMax' not in post and len(post.get('questions', [])) == 4, 'public post has no salary, is open')
link = H.locator('.modal input[readonly]').first.input_value() if H.locator('.modal input[readonly]').count() else ''
ok('apply.html#j=' + jid in link and 's=linkedin' in link, f'apply links shown ({link})')
H.screenshot(path='shots/f17-links.png')
H.keyboard.press('Escape'); H.locator('.modal [data-close]').first.click() if H.locator('.modal').count() else None

# 2) the public apply page (no account)
A = page(); A.goto(BASE + '/tests/blank.html'); A.evaluate("() => localStorage.removeItem('mockauth_current')")
A.goto(link); A.wait_for_timeout(1800)
ok('Frontend Developer' in A.locator('#g').inner_text() and 'React' in A.locator('#g').inner_text(), 'apply page shows the job')
A.screenshot(path='shots/f17-apply.png', full_page=True)
A.fill('[name=name]', 'أحمد سامي'); A.fill('[name=phone]', '+20 101 234 5678'); A.fill('[name=email]', 'ahmed@test.com')
A.fill('[name=currentTitle]', 'Junior Frontend'); A.fill('[name=years]', '1'); A.fill('[name=salary]', '18000')
A.click('#ago'); A.wait_for_timeout(400)
ok('جاوب' in A.locator('#ae').inner_text() or 'تقدر' in A.locator('#ae').inner_text(), 'required question enforced')
qs = j['questions']
A.locator(f'[data-q="{qs[0]["id"]}"] input[value=no]').check()   # fails the "must be yes" rule
A.locator(f'[data-q="{qs[1]["id"]}"]').fill('1')
A.locator(f'[data-q="{qs[2]["id"]}"] input[value="القاهرة"]').check()
A.locator('[data-file=cv]').set_input_files(pdf)
A.locator(f'[data-file="{qs[3]["id"]}"]').set_input_files({'name': 'work.png', 'mimeType': 'image/png', 'buffer': b'\x89PNG fake'})
A.click('#ago'); A.wait_for_timeout(2500)
ok('وصلنا' in A.locator('#g').inner_text(), 'application received')
apps = docs(H, 'applications/'); aid = f'{jid}_01012345678'
ap = db(H).get(f'applications/{aid}', {})
ok(ap.get('status') == 'active' and ap.get('source') == 'linkedin' and ap.get('files', {}).get('cv', {}).get('driveId') and ap['answers'].get(qs[0]['id']) == 'no', f'application stored ({ap.get("status")}, {ap.get("source")}, files={list(ap.get("files", {}).keys())})')
ok(ap.get('phoneKey') == '01012345678', 'phone normalised (+20 → 0)')
A.goto(BASE + '/tests/blank.html'); A.goto(link); A.wait_for_timeout(1500)
A.fill('[name=name]', 'أحمد سامي'); A.fill('[name=phone]', '01012345678'); A.fill('[name=email]', 'ahmed@test.com')
A.locator(f'[data-q="{qs[0]["id"]}"] input[value=yes]').check(); A.locator(f'[data-q="{qs[2]["id"]}"] input[value="الجيزة"]').check(); A.locator('[data-file=cv]').set_input_files(pdf)
A.click('#ago'); A.wait_for_timeout(1200)
ok('قبل كده' in A.locator('#ae').inner_text(), 'applying twice with the same phone is refused')

# 3) HR: badge, board, applicant page
H.wait_for_timeout(1500)
ok(H.locator('[data-badge=recruit]:not(.hidden)').count() >= 1, 'menu badge shows the new application')
H.evaluate("h => location.hash = h", f'#/recruit/job/{jid}'); H.wait_for_timeout(1500)
ok(H.locator('.rc-col[data-stage=new] .rc-card').count() == 1, 'applicant on the board under «جديد»')
ok(H.locator('.rc-card .badge.bad').count() == 1, 'flagged as not qualified')
H.screenshot(path='shots/f17-board.png')
H.locator('.rc-card').first.click(); H.wait_for_timeout(1500)
ok('أحمد سامي' in H.locator('.rc-hero').inner_text(), 'applicant page opens')
ok(db(H)[f'applications/{aid}'].get('seen') is True, 'opened → marked seen')
ok(H.locator('.rc-ans.bad').count() >= 1, 'failed answer highlighted')
H.screenshot(path='shots/f17-app.png', full_page=True)
H.locator('.rc-stage[data-stage=screen]').click(); H.wait_for_timeout(800)
ok(db(H)[f'applications/{aid}']['stage'] == 'screen', 'moved to screening')

# 4) book an online interview → the email is ready with the candidate's link
H.locator('[data-a=iv]').first.click(); H.wait_for_timeout(600)
H.select_option('#ir', 'hr'); H.select_option('#im', 'online')
H.fill('#id', time.strftime('%Y-%m-%d', time.gmtime(time.time() + 86400))); H.fill('#it', '11:30')
H.click('#is'); H.wait_for_timeout(1500)
ivs = docs(H, 'interviews/'); iv = list(ivs.values())[0] if ivs else {}
ok(iv.get('mode') == 'online' and iv.get('linkId') and db(H).get(f'interview_links/{iv.get("linkId")}'), 'online interview + candidate link saved')
ok(db(H)[f'applications/{aid}']['stage'] == 'hr', 'stage moved to «إنترفيو HR»')
ok(H.locator('#mb').count() == 1, 'email composer opened')
body = H.locator('#mb').input_value(); subj = H.locator('#ms').input_value()
ok('أحمد' in body and 'Frontend Developer' in subj and 'guest.html#i=' in body and '11:30' in body, f'email filled (name, job, time, link)')
ok('{' not in body, 'no placeholders left')
ok(H.locator('#mol').get_attribute('href').startswith('mailto:ahmed%40test.com?subject='), 'Open in Outlook link ready')
H.screenshot(path='shots/f17-email.png')
H.click('#msent'); H.wait_for_timeout(800)
logs = [v for k, v in db(H).items() if k.startswith(f'applications/{aid}/log/')]
ok(any(l['type'] == 'email' for l in logs), 'email logged on the applicant')

# 5) start the interview; the candidate joins from their link
H.locator('[data-tab=ivs]').click(); H.wait_for_timeout(500)
H.locator('[data-ivstart]').click(); H.wait_for_timeout(2000)
lk = db(H).get(f'interview_links/{iv["linkId"]}', {})
ok(lk.get('callId') and lk.get('key'), 'interview link now points to the meeting')
G = page(); G.goto(BASE + '/tests/blank.html'); G.evaluate("() => localStorage.removeItem('mockauth_current')")
G.goto(f'{BASE}/guest.html#i={iv["linkId"]}'); G.wait_for_timeout(2000)
ok(G.locator('#gn').count() == 1, 'candidate reaches the name form from the interview link')
G.fill('#gn', 'أحمد سامي'); G.click('#gj'); H.wait_for_timeout(2000)
ok(H.locator('.call-lobby-row').count() == 1, 'HR sees the candidate at the door')
H.locator('.call-lobby-row [data-c=gin]').click()
conn = False
for _ in range(25):
    G.wait_for_timeout(1000)
    st = G.evaluate("async () => { const m = await import('/assets/js/services/calls.js'); const c = m.currentCall(); return c ? [...c.peers].map(([e, p]) => p.state) : null; }")
    if st and 'connected' in st: conn = True; break
ok(conn, 'candidate connected to the interview')
G.locator('[data-g=end]').click(); G.wait_for_timeout(800)
H.locator('.call-panel [data-c=end]').click(); H.wait_for_timeout(600)
if H.locator('.call-endmenu [data-c=endall]').count(): H.locator('.call-endmenu [data-c=endall]').click()
H.wait_for_timeout(1000)

# 6) scorecard
H.locator('[data-ivscore]').click(); H.wait_for_timeout(500)
for i, c in enumerate(H.locator('.rc-stars').all()): c.locator(f'[data-n="{4 if i % 2 == 0 else 3}"]').click()
H.locator('#sr [data-r=yes]').click(); H.fill('#sf', 'كويس في React'); H.click('#ss'); H.wait_for_timeout(1500)
iv2 = list(docs(H, 'interviews/').values())[0]
ok(iv2.get('status') == 'done' and iv2.get('rec') == 'yes' and len(iv2.get('scores', {})) == 5, 'scorecard saved')
sc = db(H)[f'applications/{aid}'].get('score')
ok(isinstance(sc, (int, float)) and 50 <= sc <= 90, f'overall score computed ({sc})')

# 7) task by link
H.locator('[data-a=task]').first.click(); H.wait_for_timeout(600)
H.fill('#tt', 'صفحة تسجيل دخول'); H.fill('#tbd', 'اعمل صفحة login بـ React.'); H.fill('#th', '2'); H.locator('#tsb').check()
H.click('#tgo'); H.wait_for_timeout(1500)
tks = docs(H, 'cand_tasks/'); tid = list(tks.keys())[0].split('/')[1] if tks else ''
ok(tks and list(tks.values())[0]['status'] == 'sent' and len(tid) >= 20, 'task created with a secret link')
ok(len(docs(H, 'task_bank/')) == 1, 'task also saved to the bank')
ok(H.locator('#mb').count() == 1 and 'task.html#t=' + tid in H.locator('#mb').input_value() and 'ساعة' in H.locator('#mb').input_value(), 'task email ready with the link and the deadline')
H.locator('.modal [data-close]').last.click(); H.wait_for_timeout(300)
T = page(); T.goto(BASE + '/tests/blank.html'); T.evaluate("() => localStorage.removeItem('mockauth_current')")
T.goto(f'{BASE}/task.html#t={tid}'); T.wait_for_timeout(1800)
ok('صفحة تسجيل دخول' in T.locator('#g').inner_text() and T.locator('#tgo').count() == 1, 'candidate sees the task intro')
T.click('#tgo'); T.wait_for_timeout(1500)
t1 = db(H)[f'cand_tasks/{tid}']
ok(t1['status'] == 'opened' and t1.get('uid') and abs(t1['deadlineMs'] - (time.time() * 1000 + 2 * 3600000)) < 120000, 'opening claims it and starts the 2-hour clock')
ok(T.locator('#tt').count() == 1 and 'باقي' in T.locator('#tt').inner_text(), 'countdown shown')
T.fill('#ta', 'عملت الصفحة بـ React و hooks.'); T.wait_for_timeout(3500)
ok('hooks' in db(H)[f'cand_tasks/{tid}'].get('answer', ''), 'answer autosaved')
T.fill('#tli', 'https://github.com/ahmed/login'); T.click('#tla'); T.wait_for_timeout(800)
T.locator('#tf').set_input_files({'name': 'login.zip', 'mimeType': 'application/zip', 'buffer': b'PK fake'}); T.wait_for_timeout(1500)
ok(len(db(H)[f'cand_tasks/{tid}'].get('subFiles', [])) == 1 and len(db(H)[f'cand_tasks/{tid}'].get('links', [])) == 1, 'link + file attached')
T.screenshot(path='shots/f17-task.png', full_page=True)
T.click('#tsub'); T.wait_for_timeout(1500)
ok(db(H)[f'cand_tasks/{tid}']['status'] == 'submitted' and 'اتسلّم' in T.locator('#g').inner_text(), 'task handed in')
T2 = page(); T2.goto(BASE + '/tests/blank.html'); T2.goto(f'{BASE}/task.html#t={tid}'); T2.wait_for_timeout(1500)
ok('اتسلّم' in T2.locator('#g').inner_text() or 'جهاز تاني' in T2.locator('#g').inner_text(), 'the link does not reopen the task elsewhere')
T2.close()
H.locator('[data-tab=tasks]').click(); H.wait_for_timeout(800)
H.locator('[data-tview]').click(); H.wait_for_timeout(500)
ok('hooks' in H.locator('.modal').inner_text() and 'github.com' in H.locator('.modal').inner_text(), 'HR sees the submission')
H.fill('#gs', '80'); H.fill('#gr', 'نظيف ومنظم'); H.click('#gsv'); H.wait_for_timeout(1500)
ok(db(H)[f'cand_tasks/{tid}']['score'] == 80, 'task graded')

# 8) a second applicant by hand, then compare
H.evaluate("h => location.hash = h", f'#/recruit/job/{jid}'); H.wait_for_timeout(1200)
H.click('#ba'); H.wait_for_timeout(500)
H.locator('#acv').set_input_files({'name': 'mona.pdf', 'mimeType': 'application/pdf', 'buffer': b'%PDF mona.ali@mail.com 01122223333'}); H.wait_for_timeout(500)
ok(H.locator('.modal [name=email]').input_value() == 'mona.ali@mail.com' and H.locator('.modal [name=phone]').input_value() == '01122223333', 'email and phone read from the CV')
H.fill('.modal [name=name]', 'منى علي'); H.fill('.modal [name=years]', '4'); H.select_option('.modal [name=source]', 'linkedin')
H.click('#asv'); H.wait_for_timeout(1800)
ok('منى علي' in H.locator('.rc-hero').inner_text(), 'added by hand → her page')
H.evaluate("h => location.hash = h", f'#/recruit/job/{jid}'); H.wait_for_timeout(1200)
H.locator('[data-v=table]').click(); H.wait_for_timeout(400)
for cb in H.locator('[data-pick]').all()[:2]: cb.check(); H.wait_for_timeout(200)
H.click('#bc'); H.wait_for_timeout(1500)
ok(H.locator('.rc-cmp th a').count() == 2 and 'التقييم الكلي' in H.locator('.rc-cmp').inner_text(), 'compare shows both side by side')
H.screenshot(path='shots/f17-compare.png')
H.locator('.modal [data-close]').last.click()

# 9) offer → hire as an employee
H.evaluate("h => location.hash = h", f'#/recruit/app/{aid}'); H.wait_for_timeout(1200)
H.locator('[data-tab=offer]').click(); H.wait_for_timeout(400)
H.fill('#os', '20000'); H.fill('#ost', '2026-11-01'); H.select_option('#ost2', 'accepted'); H.click('#osave'); H.wait_for_timeout(1200)
ok(db(H)[f'applications/{aid}'].get('offer', {}).get('status') == 'accepted', 'offer saved')
H.click('#omail'); H.wait_for_timeout(800)
ok('20,000' in H.locator('#mb').input_value() or '20000' in H.locator('#mb').input_value(), 'offer email has the salary')
H.locator('.modal [data-close]').last.click(); H.wait_for_timeout(300)
H.click('#ohire'); H.wait_for_timeout(1500)
ok(H.locator('#ef [name=name]').input_value() == 'أحمد سامي' and H.locator('#ef [name=title]').input_value() == 'Frontend Developer', 'new-employee form prefilled')
H.fill('#ef [name=email]', 'ahmed.sami@almaster.tech'); H.click('#save'); H.wait_for_timeout(2500)
ap = db(H)[f'applications/{aid}']
ok(ap.get('status') == 'hired' and ap.get('employeeEmail') == 'ahmed.sami@almaster.tech' and db(H).get('users/ahmed.sami@almaster.tech'), 'employee created and applicant marked hired')

# 10) templates: edit and the change is used
while H.locator('.modal').count(): H.locator('.modal [data-close]').last.click(); H.wait_for_timeout(200)
H.evaluate("h => location.hash = h", '#/recruit/templates'); H.wait_for_timeout(1000)
H.locator('[data-tedit=b_reject]').click(); H.wait_for_timeout(400)
H.fill('#ts', 'رد على طلبك — {الوظيفة}'); H.click('#tsv'); H.wait_for_timeout(800)
ok(db(H).get('email_templates/b_reject', {}).get('subject', '').startswith('رد على طلبك'), 'template edited')
ok(H.locator('[data-badge=recruit]:not(.hidden)').count() == 0, 'badge cleared once opened')

print('svc calls:', calls_log)
print('errors:', errs)
ok(not errs, 'no page errors')
br.close(); pw.stop()
print('FAILS:', fails) if fails else print('ALL OK')
sys.exit(1 if fails else 0)
