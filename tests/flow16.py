"""Online meetings (no chat): sales / PM / admin start one, invite a colleague and a guest without an account."""
import sys, os, time, re; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import seed_payload, BASE, ts, serve, route
from playwright.sync_api import sync_playwright

p = seed_payload({'settings/migration': {'done': True}})
p['fs']['users/emp1@almaster.tech']['permissions']['crm'] = True   # emp1 is in sales (CRM access)
fails = []
def ok(c, m): print(('OK ' if c else 'FAIL ') + m); (None if c else fails.append(m))

srv = serve(); pw = sync_playwright().start()
br = pw.chromium.launch(headless=True, args=['--disable-web-security', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'])
ctx = br.new_context(viewport={'width': 1280, 'height': 860}, locale='ar-EG', timezone_id='Africa/Cairo', permissions=['microphone'])
ctx.route('**/*', route)
errs = []
def page():
    pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append(f'PAGEERROR {e}')); return pg
def login(pg, email):
    if not pg.url.startswith(BASE): pg.goto(BASE + '/tests/blank.html')
    pg.evaluate("() => localStorage.removeItem('mockauth_current')")
    pg.goto(BASE + '/index.html'); pg.fill('#email', email); pg.fill('#password', 'Passw0rd!'); pg.click('#login-btn')
    pg.wait_for_url('**/app.html**', timeout=8000); pg.wait_for_selector('#splash', state='detached', timeout=8000)
db = lambda pg: pg.evaluate("() => JSON.parse(localStorage.getItem('mockfs') || '{}')")
state = lambda pg: pg.evaluate("async () => { const m = await import('/assets/js/services/calls.js'); const c = m.currentCall(); return c ? { id: c.id, me: (await import('/assets/js/core/session.js')).session.email, room: !!c.call.room, joined: c.call.joined, peers: [...c.peers].map(([e, p]) => [e, p.state]) } : null; }")
def wait_conn(pg, n, secs=40):
    for _ in range(secs):
        s = state(pg)
        if s and sum(1 for x in s['peers'] if x[1] == 'connected') >= n: return s
        pg.wait_for_timeout(1000)
    return state(pg)

A = page(); A.goto(BASE + '/tests/blank.html')
A.evaluate("""(p) => { localStorage.clear(); localStorage.setItem('mockauth_users', JSON.stringify(p.auth)); localStorage.setItem('mockfs', JSON.stringify(p.fs)); localStorage.setItem('am_lang', 'ar'); }""", p)
login(A, 'emp2@almaster.tech')
A.evaluate("h => location.hash = h", '#/chat'); A.wait_for_timeout(1200)
ok(A.locator('#room').count() == 0, 'a plain employee has no online-meeting button')
login(A, 'emp1@almaster.tech')
B = page(); login(B, 'emp2@almaster.tech')

A.evaluate("h => location.hash = h", '#/chat'); A.wait_for_timeout(1200)
ok(A.locator('#room').count() == 1, 'sales (CRM access) sees the online-meeting button')
A.click('#room'); A.wait_for_timeout(500)
A.fill('#rm-t', 'ميتنج مع عميل')
A.locator('#rm-list [data-p="emp2@almaster.tech"]').check()
A.screenshot(path='shots/f16-dialog.png')
A.click('#rm-go'); A.wait_for_timeout(1500)
sa = state(A); cid = sa and sa['id']
d = db(A).get(f'calls/{cid}', {})
ok(sa and sa['room'] and d.get('chatId') == '' and d.get('status') == 'active' and d.get('members') == ['emp1@almaster.tech', 'emp2@almaster.tech'], f'online meeting started ({d.get("chatName")}, {d.get("members")})')
link = A.locator('#gl-link').input_value() if A.locator('#gl-link').count() else ''
ok('guest.html#c=' + str(cid) in link, 'guest link shown right after starting')
A.screenshot(path='shots/f16-link.png')
A.keyboard.press('Escape'); A.wait_for_timeout(300)
ok('ميتنج مع عميل' in A.locator('.call-panel').inner_text() and A.locator('.call-panel [data-c=chat]').count() == 0, 'call bar shows the topic, no chat button')

# the colleague is invited
B.wait_for_timeout(1500)
ok(B.locator('.call-in').count() == 1 and 'ميتنج أونلاين' in B.locator('.call-in').inner_text(), 'colleague gets the online-meeting invitation')
B.locator('.call-in [data-a=yes]').click()
sb = wait_conn(B, 1)
ok(sb and sb['id'] == cid, 'colleague joined and connected')

# a guest without an account
G = page(); G.goto(BASE + '/tests/blank.html'); G.evaluate("() => localStorage.removeItem('mockauth_current')")
G.goto(link); G.wait_for_timeout(1500); G.fill('#gn', 'عميل شركة النور'); G.click('#gj'); A.wait_for_timeout(1800)
ok(A.locator('.call-lobby-row').count() == 1, 'host sees the guest at the door')
A.locator('.call-lobby-row [data-c=gin]').click()
sg = wait_conn(G, 2)
ok(sg and sg['me'].startswith('guest_') and sum(1 for x in sg['peers'] if x[1] == 'connected') == 2, f'guest connected to both ({sg and sg["peers"]})')
A.screenshot(path='shots/f16-call.png')

# add another colleague mid-call (any colleague: the meeting has no chat)
A.locator('.call-panel [data-c=add]').click(); A.wait_for_timeout(700)
ok(A.locator('#cp-list [data-p="leader@almaster.tech"]').count() == 1, 'adding: any colleague is offered')
A.locator('#cp-list [data-p="leader@almaster.tech"]').check(); A.click('#cp-go'); A.wait_for_timeout(1200)
ok('leader@almaster.tech' in db(A)[f'calls/{cid}']['members'], 'colleague added')
if A.locator('.modal').count(): A.keyboard.press('Escape')

# mark it transcribed (the headless browser cannot transcribe), then everyone leaves
A.evaluate("async (id) => { const f = await import('/assets/js/core/fb.js'); await f.updateDoc(f.doc(f.db, 'calls', id), { tr: true }); }", cid)
G.locator('[data-g=end]').click(); B.locator('.call-panel [data-c=end]').click(); A.wait_for_timeout(1500)
A.locator('.call-panel [data-c=end]').click(); A.wait_for_timeout(600)
if A.locator('.call-endmenu [data-c=leave]').count(): A.locator('.call-endmenu [data-c=leave]').click()
A.wait_for_timeout(2500)
ok(state(A) is None and db(A)[f'calls/{cid}']['live'] is False, 'meeting over when everyone left')
ok(not any(k.startswith('chats//') or k.startswith('chats/messages') for k in db(A)), 'nothing written to a chat')

# the host asks for its transcript from the records page
A.evaluate("h => location.hash = h", '#/records'); A.wait_for_timeout(1500)
ok(A.locator('#rooms [data-ask]').count() == 1 and 'ميتنج مع عميل' in A.locator('#rooms').inner_text(), 'host sees the meeting under "My online meetings"')
A.locator('#rooms [data-ask]').click(); A.wait_for_timeout(500)
A.fill('#rq-r', 'محتاج المحضر للمتابعة مع العميل'); A.click('#rq-go'); A.wait_for_timeout(1200)
reqs = [v for k, v in db(A).items() if k.startswith('record_requests/')]
ok(len(reqs) == 1 and reqs[0]['callId'] == cid and reqs[0]['kinds'] == ['tr'], 'request sent to the admin')
ok(A.locator('#rooms .badge').count() == 1, 'shows "waiting"')
A.screenshot(path='shots/f16-records.png')

# PM role also may host; the meeting picker offers it
login(B, 'admin@almaster.tech')
B.evaluate("h => location.hash = h", '#/chat'); B.wait_for_timeout(1200)
ok(B.locator('#room').count() == 1, 'admin sees the online-meeting button')

print('errors:', errs)
ok(not errs, 'no page errors')
br.close(); pw.stop()
print('FAILS:', fails) if fails else print('ALL OK')
sys.exit(1 if fails else 0)
