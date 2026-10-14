"""Screen sharing in a call: several people at once (up to 3), each sees the others' screens; stop; limit."""
import sys, os, time; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import seed_payload, BASE, ts, serve, route
from playwright.sync_api import sync_playwright

now = int(time.time() * 1000)
p = seed_payload({'settings/migration': {'done': True}})
gid = 'grp1'
p['fs'][f'chats/{gid}'] = {'type': 'group', 'name': 'فريق البرمجيات', 'members': ['emp1@almaster.tech', 'emp2@almaster.tech', 'leader@almaster.tech', 'hr@almaster.tech'], 'admins': [],
                          'createdAt': ts(now), 'updatedAt': ts(now), 'createdBy': 'admin@almaster.tech', 'lastMessage': None, 'unread': {}, 'lastRead': {}}
fails = []
def ok(c, m): print(('OK ' if c else 'FAIL ') + m); (None if c else fails.append(m))
srv = serve(); pw = sync_playwright().start()
br = pw.chromium.launch(headless=True, args=['--disable-web-security', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'])
ctx = br.new_context(viewport={'width': 1366, 'height': 860}, locale='ar-EG', timezone_id='Africa/Cairo', permissions=['microphone'])
ctx.route('**/*', route)
# a fake "screen": an animated canvas (headless Chrome has no screen picker)
ctx.add_init_script("""navigator.mediaDevices && (navigator.mediaDevices.getDisplayMedia = async () => {
  const c = document.createElement('canvas'); c.width = 640; c.height = 360; const g = c.getContext('2d'); let i = 0;
  setInterval(() => { g.fillStyle = `hsl(${(i += 7) % 360},70%,50%)`; g.fillRect(0, 0, 640, 360); g.fillStyle = '#fff'; g.font = '40px sans-serif'; g.fillText(location.hash + ' ' + i, 20, 180); }, 100);
  return c.captureStream(15); });""")
errs = []
def page():
    pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append(f'PAGEERROR {e}')); return pg
def login(pg, email):
    if not pg.url.startswith(BASE): pg.goto(BASE + '/tests/blank.html')
    pg.evaluate("() => localStorage.removeItem('mockauth_current')")
    pg.goto(BASE + '/index.html'); pg.fill('#email', email); pg.fill('#password', 'Passw0rd!'); pg.click('#login-btn')
    pg.wait_for_url('**/app.html**', timeout=8000); pg.wait_for_selector('#splash', state='detached', timeout=8000)
state = lambda pg: pg.evaluate("async () => { const m = await import('/assets/js/services/calls.js'); const c = m.currentCall(); return c ? { peers: [...c.peers].map(([e, p]) => [e, p.state]), sharing: c.call.sharing || [], mine: !!c.screen } : null; }")
conn = lambda s: sum(1 for x in (s or {}).get('peers', []) if x[1] == 'connected')
frames = lambda pg: pg.evaluate("() => [...document.querySelectorAll('.screen-tile video')].map(v => v.videoWidth)")

A = page(); A.goto(BASE + '/tests/blank.html')
A.evaluate("""(p) => { localStorage.clear(); localStorage.setItem('mockauth_users', JSON.stringify(p.auth)); localStorage.setItem('mockfs', JSON.stringify(p.fs)); localStorage.setItem('am_lang', 'ar'); }""", p)
login(A, 'emp1@almaster.tech')
B = page(); login(B, 'emp2@almaster.tech'); C = page(); login(C, 'leader@almaster.tech'); D = page(); login(D, 'hr@almaster.tech')
A.evaluate("h => location.hash = h", f'#/chat/{gid}'); A.wait_for_timeout(1200)
A.click('#call'); A.wait_for_timeout(500)
for e in ['emp2@almaster.tech', 'leader@almaster.tech', 'hr@almaster.tech']: A.locator(f'#cp-list [data-p="{e}"]').check()
A.click('#cp-go'); A.wait_for_timeout(1500)
for pg in (B, C, D):
    pg.wait_for_timeout(600); pg.locator('.call-in [data-a=yes]').click(); pg.wait_for_timeout(3500)
for _ in range(10):
    if all(conn(state(x)) == 3 for x in (A, B, C, D)): break
    A.wait_for_timeout(2500)
ok(all(conn(state(x)) == 3 for x in (A, B, C, D)), 'four people connected')

# A shares
A.locator('.call-panel [data-c=share]').first.click(); A.wait_for_timeout(3000)
ok(state(A)['mine'] and state(A)['sharing'] == ['emp1@almaster.tech'], 'A is sharing')
ok(A.locator('.call-sharing').count() == 1 and A.locator('.screen-stage').count() == 0, 'A sees "you are sharing" (no mirror of itself)')
ok(B.locator('.screen-tile').count() == 1 and max(frames(B) or [0]) > 0, f'B sees the screen of A with picture ({frames(B)})')
ok(D.locator('.screen-tile').count() == 1, 'D sees it too')
# B and C share as well
B.locator('.call-panel [data-c=share]').first.click(); B.wait_for_timeout(2000)
C.locator('.call-panel [data-c=share]').first.click(); C.wait_for_timeout(4000)
ok(sorted(state(D)['sharing']) == sorted(['emp1@almaster.tech', 'emp2@almaster.tech', 'leader@almaster.tech']), 'three people sharing at once')
D.wait_for_timeout(1500)
ok(D.locator('.screen-tile').count() == 3 and sum(1 for w in frames(D) if w > 0) == 3, f'D sees three screens, all with picture ({frames(D)})')
ok(A.locator('.screen-tile').count() == 2, 'each sharer sees the other two')
D.screenshot(path='shots/f13-three.png')
# the fourth can't
D.locator('.call-panel [data-c=share]').first.click(); D.wait_for_timeout(1500)
ok(not state(D)['mine'] and len(state(D)['sharing']) == 3, 'a fourth screen is refused (limit 3)')
# focus one
D.locator('.screen-tile[data-tile="emp2@almaster.tech"]').click(); D.wait_for_timeout(400)
ok(D.locator('.screen-tile.main[data-tile="emp2@almaster.tech"]').count() == 1, 'clicking a screen enlarges it')
D.screenshot(path='shots/f13-focus.png')
# B stops
B.locator('.call-sharing [data-c=share]').click(); B.wait_for_timeout(2500)
ok(D.locator('.screen-tile').count() == 2 and 'emp2@almaster.tech' not in state(D)['sharing'], 'stopping removes that screen for everyone')
# now D can share
D.locator('.call-panel [data-c=share]').first.click(); D.wait_for_timeout(3000)
ok(state(D)['mine'] and B.locator('.screen-tile').count() == 3, 'after one stops, someone else can share')
# A leaves while sharing → its screen disappears
A.locator('.call-panel [data-c=end]').click(); A.wait_for_timeout(300)
if A.locator('.call-endmenu [data-c=leave]').count(): A.locator('.call-endmenu [data-c=leave]').click()
B.wait_for_timeout(3000)
ok('emp1@almaster.tech' not in state(B)['sharing'] and B.locator('.screen-tile').count() == 2, 'leaving the call stops your screen')
for pg in (B, C, D):
    if state(pg): pg.locator('.call-panel [data-c=end]').click(); pg.wait_for_timeout(300)
    if pg.locator('.call-endmenu [data-c=leave]').count(): pg.locator('.call-endmenu [data-c=leave]').click()
B.wait_for_timeout(2000)
ok(all(state(x) is None for x in (B, C, D)) and B.locator('.screen-stage').count() == 0, 'all closed')
for e in errs: print(' ', e[:300])
br.close(); pw.stop(); srv.shutdown()
print('FAILS:', len(fails))
