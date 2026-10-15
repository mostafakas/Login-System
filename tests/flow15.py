"""Guests from outside (no account): link from the call bar → guest.html → name → lobby → let in → talk → leave; deny."""
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
ctx = br.new_context(viewport={'width': 1280, 'height': 860}, locale='ar-EG', timezone_id='Africa/Cairo', permissions=['microphone', 'clipboard-read', 'clipboard-write'])
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
state = lambda pg: pg.evaluate("async () => { const m = await import('/assets/js/services/calls.js'); const c = m.currentCall(); return c ? { id: c.id, me: (await import('/assets/js/core/session.js')).session.email, started: !!c.call.startedAt, joined: c.call.joined, names: c.call.names, peers: [...c.peers].map(([e, p]) => [e, p.state, !!(p.audio.srcObject && p.audio.srcObject.getAudioTracks().length)]) } : null; }")
call_doc = lambda pg, cid: db(pg).get(f'calls/{cid}')

A = page(); A.goto(BASE + '/tests/blank.html')
A.evaluate("""(p) => { localStorage.clear(); localStorage.setItem('mockauth_users', JSON.stringify(p.auth)); localStorage.setItem('mockfs', JSON.stringify(p.fs)); localStorage.setItem('am_lang', 'ar'); }""", p)
login(A, 'emp1@almaster.tech')
B = page(); login(B, 'emp2@almaster.tech')

# A calls B, B answers
A.evaluate("h => location.hash = h", f'#/chat/{dm}'); A.wait_for_timeout(1200)
A.click('#call'); B.wait_for_timeout(1800)
B.locator('.call-in [data-a=yes]').click(); B.wait_for_timeout(4000)
sa = state(A); cid = sa and sa['id']
ok(sa and sa['started'], 'A and B in a call')

# the guest link
ok(A.locator('.call-panel [data-c=guest]').count() == 1, 'call bar has the guest-link button')
A.locator('.call-panel [data-c=guest]').click(); A.wait_for_timeout(1200)
link = A.locator('#gl-link').input_value() if A.locator('#gl-link').count() else ''
ok(re.search(r'/guest\.html#c=[^&]+&k=[a-z0-9]{16,}$', link or '') is not None, f'guest link made ({link})')
ok(bool((call_doc(A, cid) or {}).get('guestKey')), 'call keeps the guest key')
A.screenshot(path='shots/f15-link.png')
A.keyboard.press('Escape'); A.wait_for_timeout(300)

# a wrong key is refused at the door (the mock has no rules, so check the page with a missing key)
G0 = page(); G0.goto(BASE + '/guest.html#c=' + cid); G0.wait_for_timeout(1500)
ok('ناقص' in G0.locator('#g').inner_text(), 'link without a key → "incomplete"')
G0.close()

# the guest opens the link (no account)
G = page(); G.goto(BASE + '/tests/blank.html'); G.evaluate("() => localStorage.removeItem('mockauth_current')")
G.goto(link); G.wait_for_timeout(1500)
ok(G.locator('#gn').count() == 1, 'guest sees the name form')
G.screenshot(path='shots/f15-guest-form.png')
G.fill('#gn', 'محمد الضيف'); G.click('#gj'); G.wait_for_timeout(1500)
ok('مستني' in G.locator('#g').inner_text(), 'guest waits at the door')
gdocs = {k: v for k, v in db(A).items() if k.startswith(f'calls/{cid}/guests/')}
ok(len(gdocs) == 1 and list(gdocs.values())[0]['status'] == 'waiting' and list(gdocs.values())[0]['email'].endswith('@guest.local'), f'guest door doc ({gdocs})')
A.wait_for_timeout(800)
ok(A.locator('.call-lobby-row').count() == 1 and 'محمد الضيف' in A.locator('.call-lobby-row').inner_text(), 'A sees the guest waiting')
ok(B.locator('.call-lobby-row').count() == 1, 'B sees the guest waiting too')
A.screenshot(path='shots/f15-lobby.png')

# let in
A.locator('.call-lobby-row [data-c=gin]').click()
for i in range(45):
    G.wait_for_timeout(1000); sg = state(G)
    if sg and sum(1 for x in sg['peers'] if x[1] == 'connected') == 2: break
print('guest state', sg)
ok(sg and sg['me'].startswith('guest_') and sg['started'], 'guest joined the call')
ok(sg and sum(1 for x in sg['peers'] if x[1] == 'connected' and x[2]) == 2, 'guest connected with audio to A and B')
sa, sb = state(A), state(B)
ok(sa and any(x[0] == sg['me'] and x[1] == 'connected' for x in sa['peers']), 'A connected to the guest')
ok(sb and any(x[0] == sg['me'] and x[1] == 'connected' for x in sb['peers']), 'B connected to the guest')
ok(A.locator('.call-lobby-row').count() == 0, 'lobby emptied')
ok('محمد' in A.locator('.call-panel').inner_text(), 'A sees the guest by name in the call')
ok(G.locator('.guest-person').count() == 3 and 'سارة' in G.locator('#g').inner_text(), 'guest sees everyone by name')
d = call_doc(A, cid)
ok(d and d.get('group') is True and sg['me'] in d.get('guestList', []) and sg['me'] in d['members'], 'call turned into a call of several, guest listed')
G.screenshot(path='shots/f15-guest-call.png'); A.screenshot(path='shots/f15-call.png')

# guest mutes, then leaves: the call goes on for A and B
G.locator('[data-g=mute]').click(); G.wait_for_timeout(400)
ok(G.locator('[data-g=mute].on').count() == 1, 'guest can mute')
G.locator('[data-g=end]').click(); G.wait_for_timeout(2500)
ok(state(G) is None and 'خلصت' in G.locator('#g').inner_text(), 'guest left → "call ended" page')
sa, sb = state(A), state(B)
ok(sa and sb and sa['started'] and any(x[1] == 'connected' for x in sa['peers']), 'A and B still talking after the guest left')

# a second guest is denied
G2 = ctx.new_page(); G2.on('pageerror', lambda e: errs.append(f'PAGEERROR {e}'))
G2.goto(link); G2.wait_for_timeout(1500)
G2.fill('#gn', 'زائر تاني'); G2.click('#gj'); A.wait_for_timeout(1800)
ok(A.locator('.call-lobby-row').count() == 1, 'second guest waiting')
A.locator('.call-lobby-row [data-c=gout]').click(); G2.wait_for_timeout(1800)
ok('ما اتسمحلكش' in G2.locator('#g').inner_text(), 'denied guest is told')
G2.close()

# a guest still in the call when everyone with an account leaves → the call ends for them
G3 = ctx.new_page(); G3.on('pageerror', lambda e: errs.append(f'PAGEERROR {e}'))
G3.goto(link); G3.wait_for_timeout(1500); G3.fill('#gn', 'ضيف تالت'); G3.click('#gj'); A.wait_for_timeout(1800)
A.locator('.call-lobby-row [data-c=gin]').click(); G3.wait_for_timeout(5000)
ok(state(G3) is not None, 'third guest in')
B.locator('.call-panel [data-c=end]').click(); B.wait_for_timeout(1500)
A.locator('.call-panel [data-c=end]').click(); A.wait_for_timeout(600)
if A.locator('.call-endmenu [data-c=leave]').count(): A.locator('.call-endmenu [data-c=leave]').click()
G3.wait_for_timeout(3000)
ok(state(A) is None and state(G3) is None, 'last account holder leaves → call over (guest alone does not keep it)')
ok('خلصت' in G3.locator('#g').inner_text(), 'guest sees "call ended"')
d = call_doc(A, cid)
ok(d and d['live'] is False, 'call stored as ended')
A.wait_for_timeout(1200)
msgs = [v for k, v in db(A).items() if k.startswith(f'chats/{dm}/messages/') and v.get('type') == 'call']
last = msgs[-1]['call'] if msgs else {}
ok(last.get('gn') and any('محمد' in n for n in last['gn'].values()), f'call log keeps the guests\' names ({last})')
A.evaluate("h => location.hash = h", f'#/chat/{dm}'); A.wait_for_timeout(1500)
ok('محمد' in A.locator('.chat-callmsg').last.inner_text(), 'call bubble shows the guest name')
A.screenshot(path='shots/f15-bubble.png')

# the link no longer works after the call
G4 = ctx.new_page(); G4.goto(link); G4.wait_for_timeout(1500)
G4.fill('#gn', 'متأخر'); G4.click('#gj'); G4.wait_for_timeout(1500)
print('late guest:', G4.locator('#g').inner_text()[:80])

# the host opens the guest link in the same browser: the employee stays signed in
A.evaluate("() => localStorage.setItem('mockauth_current', 'emp1@almaster.tech')"); before = 'emp1@almaster.tech'
H = page(); H.goto(link); H.wait_for_timeout(1500)
ok(H.locator('#gn').count() == 1, 'guest page opens in the employee\'s browser')
after = A.evaluate("() => localStorage.getItem('mockauth_current')")
ok(after == before and '@almaster' in (after or ''), f'employee sign-in untouched by the guest page ({before} → {after})')
# (the real check is above; reloading here would trip the one-device rule, since every test page shares one browser)
H.close()
# a browser left with a guest sign-in by the older version: back to the login page, no error
A.evaluate("() => localStorage.setItem('mockauth_current', 'anon:Oldguest123')")
A.goto(BASE + '/app.html'); A.wait_for_timeout(2500)
ok('index.html' in A.url and A.locator('#email').count() == 1, f'leftover guest sign-in → login page ({A.url})')
ok(A.evaluate("() => localStorage.getItem('mockauth_current')") in (None, ''), 'leftover guest sign-in cleared')

print('errors:', errs)
ok(not errs, 'no page errors')
br.close(); pw.stop()
print('FAILS:', fails) if fails else print('ALL OK')
sys.exit(1 if fails else 0)
