"""Cameras in calls: on/off, everyone sees them, camera + screen at the same time, a guest (no account) with a camera."""
import sys, os, time, re; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import seed_payload, BASE, ts, serve, route
from playwright.sync_api import sync_playwright

now = int(time.time() * 1000)
p = seed_payload({'settings/migration': {'done': True}})
dm = 'emp1@almaster.tech__emp2@almaster.tech'
p['fs'][f'chats/{dm}'] = {'members': ['emp1@almaster.tech', 'emp2@almaster.tech'], 'createdAt': ts(now), 'updatedAt': ts(now), 'createdBy': 'emp1@almaster.tech',
                         'lastMessage': None, 'unread': {'emp1_almaster_tech': 0, 'emp2_almaster_tech': 0}, 'lastRead': {}}
fails = []
def ok(c, m): print(('OK ' if c else 'FAIL ') + m); (None if c else fails.append(m))
srv = serve(); pw = sync_playwright().start()
br = pw.chromium.launch(headless=True, args=['--disable-web-security', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'])
ctx = br.new_context(viewport={'width': 1366, 'height': 860}, locale='ar-EG', timezone_id='Africa/Cairo', permissions=['microphone', 'camera'])
ctx.route('**/*', route)
ctx.add_init_script("""navigator.mediaDevices && (navigator.mediaDevices.getDisplayMedia = async () => {
  const c = document.createElement('canvas'); c.width = 1280; c.height = 720; const g = c.getContext('2d'); let i = 0;
  setInterval(() => { g.fillStyle = `hsl(${(i += 7) % 360},70%,50%)`; g.fillRect(0, 0, 1280, 720); }, 100);
  return c.captureStream(15); });""")
errs = []
def page():
    pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append(f'PAGEERROR {e}')); return pg
def login(pg, email):
    if not pg.url.startswith(BASE): pg.goto(BASE + '/tests/blank.html')
    pg.evaluate("() => localStorage.removeItem('mockauth_current')")
    pg.goto(BASE + '/index.html'); pg.fill('#email', email); pg.fill('#password', 'Passw0rd!'); pg.click('#login-btn')
    pg.wait_for_url('**/app.html**', timeout=8000); pg.wait_for_selector('#splash', state='detached', timeout=8000)
db = lambda pg: pg.evaluate("() => JSON.parse(localStorage.getItem('mockfs') || '{}')")
# what each page shows on its video stage: [key, frame width]
tiles = lambda pg, sel='.screen-stage [data-tile]': pg.evaluate(f"() => [...document.querySelectorAll('{sel}')].map(t => [t.dataset.tile || t.className, t.querySelector('video').videoWidth])")
def wait_tiles(pg, n, sel='.screen-stage [data-tile]', secs=20):
    for _ in range(secs * 2):
        t = tiles(pg, sel)
        if len(t) == n and all(w > 0 for _, w in t): return t
        pg.wait_for_timeout(500)
    return tiles(pg, sel)

A = page(); A.goto(BASE + '/tests/blank.html')
A.evaluate("""(p) => { localStorage.clear(); localStorage.setItem('mockauth_users', JSON.stringify(p.auth)); localStorage.setItem('mockfs', JSON.stringify(p.fs)); localStorage.setItem('am_lang', 'ar'); }""", p)
login(A, 'emp1@almaster.tech')
B = page(); login(B, 'emp2@almaster.tech')
A.evaluate("h => location.hash = h", f'#/chat/{dm}'); A.wait_for_timeout(1200)
A.click('#call'); B.wait_for_timeout(1800)
B.locator('.call-in [data-a=yes]').click(); B.wait_for_timeout(4500)
cid = A.evaluate("async () => (await import('/assets/js/services/calls.js')).currentCall().id")
ok(A.locator('.call-panel [data-c=cam]').count() == 1, 'camera button in the call bar')

# A turns the camera on
A.locator('.call-panel [data-c=cam]').click()
ta = wait_tiles(A, 1)
ok(ta == [['me', ta[0][1]]] if ta else False, f'A sees their own preview ({ta})')
tb = wait_tiles(B, 1)
ok(len(tb) == 1 and tb[0][0] == 'c:emp1@almaster.tech' and tb[0][1] > 0, f'B sees A\'s camera with picture ({tb})')
ok(db(A)[f'calls/{cid}'].get('cams') == ['emp1@almaster.tech'], 'call keeps who has the camera on')
B.screenshot(path='shots/f18-cam1.png')

# B too
B.locator('.call-panel [data-c=cam]').click()
ta = wait_tiles(A, 2); tb = wait_tiles(B, 2)
ok(sorted(k for k, _ in ta) == ['c:emp2@almaster.tech', 'me'] and sorted(k for k, _ in tb) == ['c:emp1@almaster.tech', 'me'], f'both cameras on both sides ({ta} / {tb})')

# A also shares the screen: B gets screen and camera apart
A.locator('.call-panel [data-c=share]').click()
tb = wait_tiles(B, 3)
keys = [k for k, _ in tb]
ok(keys[:1] == ['s:emp1@almaster.tech'] and 'c:emp1@almaster.tech' in keys, f'screen + camera at once, screen first ({tb})')
w = dict(tb)
ok(w.get('s:emp1@almaster.tech') != w.get('c:emp1@almaster.tech'), f'screen and camera are different pictures ({w})')
B.screenshot(path='shots/f18-cam-screen.png')
A.locator('.call-panel .call-btn[data-c=share]').click(); B.wait_for_timeout(2000)

# a guest without an account joins and turns the camera on
A.locator('.call-panel [data-c=guest]').click(); A.wait_for_timeout(1000)
link = A.locator('#gl-link').input_value(); A.keyboard.press('Escape'); A.wait_for_timeout(300)
G = page(); G.goto(BASE + '/tests/blank.html'); G.evaluate("() => localStorage.removeItem('mockauth_current')")
G.goto(link); G.wait_for_timeout(1500); G.fill('#gn', 'عميل'); G.click('#gj'); A.wait_for_timeout(1800)
A.locator('.call-lobby-row [data-c=gin]').click()
tg = wait_tiles(G, 2, '#g-screens .screen-tile', 30)
ok(len(tg) == 2 and all(w > 0 for _, w in tg), f'guest sees both cameras ({tg})')
G.locator('[data-g=cam]').click()
ta = wait_tiles(A, 3, secs=30)
ok(len(ta) == 3 and any(k.startswith('c:guest_') for k, _ in ta), f'A sees the guest camera ({ta})')
G.screenshot(path='shots/f18-guest.png')
A.screenshot(path='shots/f18-three.png')

# A turns it off: gone for the others, list updated
A.locator('.call-panel [data-c=cam]').click(); B.wait_for_timeout(2500)
tb = tiles(B)
ok(not any(k == 'c:emp1@almaster.tech' for k, _ in tb), f'camera off → tile gone for B ({tb})')
ok('emp1@almaster.tech' not in db(A)[f'calls/{cid}'].get('cams', []), 'list updated')
ok(A.evaluate("async () => !(await import('/assets/js/services/calls.js')).myCamera()"), 'A\'s camera released')

# the guest leaves: their camera goes from the list
G.locator('[data-g=end]').click(); A.wait_for_timeout(2500)
ok(not any(e.startswith('guest_') for e in db(A)[f'calls/{cid}'].get('cams', [])), 'guest left → off the camera list')

print('errors:', errs)
ok(not errs, 'no page errors')
br.close(); pw.stop()
print('FAILS:', fails) if fails else print('ALL OK')
sys.exit(1 if fails else 0)
