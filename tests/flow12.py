"""Voice calls (WebRTC between two/three pages with fake microphones): 1:1 answer + talk + hang up, decline, group call."""
import sys, os, time; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import seed_payload, BASE, ts, serve, route
from playwright.sync_api import sync_playwright

now = int(time.time() * 1000)
p = seed_payload({'settings/migration': {'done': True}})
dm = 'emp1@almaster.tech__emp2@almaster.tech'
p['fs'][f'chats/{dm}'] = {'members': ['emp1@almaster.tech', 'emp2@almaster.tech'], 'createdAt': ts(now), 'updatedAt': ts(now), 'createdBy': 'emp1@almaster.tech',
                         'lastMessage': None, 'unread': {'emp1_almaster_tech': 0, 'emp2_almaster_tech': 0}, 'lastRead': {}}
gid = 'grp1'
p['fs'][f'chats/{gid}'] = {'type': 'group', 'name': 'فريق البرمجيات', 'members': ['emp1@almaster.tech', 'emp2@almaster.tech', 'leader@almaster.tech', 'hr@almaster.tech'], 'admins': [],
                          'createdAt': ts(now), 'updatedAt': ts(now), 'createdBy': 'admin@almaster.tech', 'lastMessage': None, 'unread': {}, 'lastRead': {}}
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
conn = lambda s: sum(1 for x in (s or {}).get('peers', []) if x[1] == 'connected')
db = lambda pg: pg.evaluate("() => JSON.parse(localStorage.getItem('mockfs') || '{}')")
state = lambda pg: pg.evaluate("async () => { const m = await import('/assets/js/services/calls.js'); const c = m.currentCall(); return c ? { id: c.id, muted: c.muted, started: !!c.call.startedAt, peers: [...c.peers].map(([e, p]) => [e, p.state, !!(p.audio.srcObject && p.audio.srcObject.getAudioTracks().length)]) } : null; }")

A = page(); A.goto(BASE + '/tests/blank.html')
A.evaluate("""(p) => { localStorage.clear(); localStorage.setItem('mockauth_users', JSON.stringify(p.auth)); localStorage.setItem('mockfs', JSON.stringify(p.fs)); localStorage.setItem('am_lang', 'ar'); }""", p)
login(A, 'emp1@almaster.tech')
B = page(); login(B, 'emp2@almaster.tech')

# 1) emp1 calls emp2
A.evaluate("h => location.hash = h", f'#/chat/{dm}'); A.wait_for_timeout(1200)
ok(A.locator('#call').count() == 1 and A.locator('#ring').count() == 1, 'call + ring buttons in a 1:1 chat')
A.click('#call'); A.wait_for_timeout(1500)
calls = [v for k, v in db(A).items() if k.startswith('calls/') and '/signals/' not in k]
ok(len(calls) == 1 and calls[0]['live'] and calls[0]['joined'] == ['emp1@almaster.tech'], 'call stored, ringing')
ok(A.locator('.call-panel').count() == 1 and 'بيرن' in A.locator('.call-panel').inner_text(), 'caller sees "ringing"')
B.wait_for_timeout(1500)
ok(B.locator('.call-in').count() == 1 and 'سارة' in B.locator('.call-in').inner_text(), 'callee gets the incoming call')
B.screenshot(path='shots/f12-incoming.png')
B.locator('.call-in [data-a=yes]').click(); B.wait_for_timeout(5000)
sa, sb = state(A), state(B)
print('state', sa, sb)
ok(sa and sb and sa['started'] and sb['started'], 'both in the call')
ok(sa and any(x[0] == 'emp2@almaster.tech' and x[1] == 'connected' and x[2] for x in sa['peers']), 'caller connected with audio from emp2')
ok(sb and any(x[0] == 'emp1@almaster.tech' and x[1] == 'connected' and x[2] for x in sb['peers']), 'callee connected with audio from emp1')
A.wait_for_timeout(1500)
ok('بيرن' not in A.locator('.call-panel').inner_text(), 'caller panel shows the timer')
A.screenshot(path='shots/f12-call.png')
A.locator('.call-panel [data-c=mute]').click(); A.wait_for_timeout(300)
ok(state(A)['muted'] and A.evaluate("async () => { const m = await import('/assets/js/services/calls.js'); return m.currentCall().stream.getAudioTracks().every(t => !t.enabled); }"), 'mute stops sending the mic')
B.wait_for_timeout(1500)
B.locator('.call-panel [data-c=end]').click(); B.wait_for_timeout(3000)
ok(state(A) is None and state(B) is None, 'hang up ends it for both')
ok(A.locator('.call-panel').count() == 0, 'caller panel closed')
msgs = [v for k, v in db(A).items() if k.startswith(f'chats/{dm}/messages/')]
ok(any(m['type'] == 'call' and m['call']['outcome'] == 'done' and m['call']['dur'] >= 3 for m in msgs), f"call written into the chat ({[m.get('call') for m in msgs]})")
A.wait_for_timeout(800)
ok(A.locator('.chat-callmsg.done').count() == 1, 'call bubble shown')

# 2) decline
A.wait_for_timeout(500); A.click('#call'); B.wait_for_timeout(2000)
B.locator('.call-in [data-a=no]').click(); A.wait_for_timeout(2500)
ok(state(A) is None, 'declined → caller call ends')
msgs = [v for k, v in db(A).items() if k.startswith(f'chats/{dm}/messages/')]
ok(any(m['type'] == 'call' and m['call']['outcome'] == 'declined' for m in msgs), 'declined call written')

# 3) a 1:1 call grows: emp1 adds the leader (not in that chat) while talking
C = page(); login(C, 'leader@almaster.tech')
A.wait_for_timeout(500); A.click('#call'); B.wait_for_timeout(2000)
B.locator('.call-in [data-a=yes]').click(); B.wait_for_timeout(4000)
A.locator('.call-panel [data-c=add]').click(); A.wait_for_timeout(500)
ok(A.locator('#cp-list [data-p="leader@almaster.tech"]').count() == 1 and A.locator('#cp-list [data-p="emp2@almaster.tech"]').count() == 0, 'adding from a 1:1 call lists colleagues outside the chat')
A.fill('#cp-q', 'كريم'); A.wait_for_timeout(200)
A.locator('#cp-list [data-p="leader@almaster.tech"]').check(); A.click('#cp-go'); A.wait_for_timeout(1500)
C.wait_for_timeout(800)
ok(C.locator('.call-in').count() == 1 and 'بيضيفك' in C.locator('.call-in').inner_text(), 'the added colleague rings ("… adds you to a call")')
C.locator('.call-in [data-a=yes]').click(); C.wait_for_timeout(5000)
for _ in range(8):
    if conn(state(C)) == 2: break
    C.wait_for_timeout(2500)
ok(conn(state(C)) == 2 and conn(state(A)) == 2 and conn(state(B)) == 2, 'three people in what started as a 1:1 call')
ok(C.locator('.call-panel [data-c=chat]').count() == 0, 'the added person has no link to a chat that is not theirs')
B.locator('.call-panel [data-c=end]').click(); A.wait_for_timeout(2500)
ok(state(A) and conn(state(A)) == 1 and state(C), 'one of the two leaves, the call goes on')
A.locator('.call-panel [data-c=end]').click(); C.locator('.call-panel [data-c=end]').click(); A.wait_for_timeout(2500)
ok(state(A) is None and state(C) is None, 'ended')

# 4) group call
D = page(); login(D, 'hr@almaster.tech')
A.evaluate("h => location.hash = h", f'#/chat/{gid}'); A.wait_for_timeout(1200)
A.click('#call'); A.wait_for_timeout(600)
ok(A.locator('#cp-list [data-p]').count() == 3 and A.locator('#cp-go').is_disabled(), 'group call asks who to call')
A.locator('#cp-list [data-p="emp2@almaster.tech"]').check(); A.locator('#cp-list [data-p="leader@almaster.tech"]').check()
A.screenshot(path='shots/f12-pick.png')
A.click('#cp-go'); A.wait_for_timeout(1500)
B.wait_for_timeout(1000); C.wait_for_timeout(500); D.wait_for_timeout(300)
ok(B.locator('.call-in').count() == 1 and C.locator('.call-in').count() == 1, 'the two picked people are called')
ok(D.locator('.call-in').count() == 0, 'the one not picked is not called')
D.evaluate("h => location.hash = h", f'#/chat/{gid}'); D.wait_for_timeout(1000)
ok(D.locator('#callbar [data-joincall]').count() == 0, 'someone not picked does not see "Join"')
D.evaluate("h => location.hash = h", '#/home'); D.wait_for_timeout(500)
B.locator('.call-in [data-a=yes]').click(); B.wait_for_timeout(3500)
C.locator('.call-in [data-a=yes]').click(); C.wait_for_timeout(6000)
sa, sb, sc = state(A), state(B), state(C)
print('group', sa, sb, sc)
ok(conn(sa) == 2 and conn(sb) == 2 and conn(sc) == 2, 'each of the three is connected to the other two')
# add the fourth one while the call is going
A.locator('.call-panel [data-c=add]').click(); A.wait_for_timeout(500)
ok(A.locator('#cp-list [data-p]').count() == 1 and A.locator('#cp-list [data-p="hr@almaster.tech"]').count() == 1, 'add lists only who is not invited yet')
A.locator('#cp-list [data-p="hr@almaster.tech"]').check(); A.click('#cp-go'); A.wait_for_timeout(1500)
D.wait_for_timeout(800)
ok(D.locator('.call-in').count() == 1, 'the added person rings')
ok(A.locator('.call-person.waiting').count() == 1, 'the call bar shows them ringing')
D.locator('.call-in [data-a=yes]').click(); D.wait_for_timeout(5000)
for _ in range(8):   # a lost handshake is retried by the side that called (the mock store can drop one with 4 pages writing)
    if conn(state(D)) == 3: break
    D.wait_for_timeout(2500)
sd = state(D); print('D', sd)
ok(conn(sd) == 3 and conn(state(A)) == 3, f'the added person talks with everyone ({conn(sd)})')
C.screenshot(path='shots/f12-group.png')
C.locator('.call-panel [data-c=end]').click(); A.wait_for_timeout(2500)
sa = state(A)
ok(sa and conn(sa) == 2, 'one leaves, the others keep talking')
B.evaluate("h => location.hash = h", f'#/chat/{gid}'); B.wait_for_timeout(300)
C.evaluate("h => location.hash = h", f'#/chat/{gid}'); C.wait_for_timeout(1500)
ok(C.locator('#callbar [data-joincall]').count() == 1, 'the group chat shows "Join" while the call is on')
A.locator('.call-panel [data-c=end]').click(); B.locator('.call-panel [data-c=end]').click(); D.locator('.call-panel [data-c=end]').click(); A.wait_for_timeout(2500)
gm = [v for k, v in db(A).items() if k.startswith(f'chats/{gid}/messages/') and v['type'] == 'call']
ok(len(gm) == 1 and gm[0]['call']['group'] and gm[0]['call']['outcome'] == 'done' and sorted(gm[0]['call'].get('with', [])) == sorted(['emp1@almaster.tech', 'emp2@almaster.tech', 'leader@almaster.tech', 'hr@almaster.tech']), 'group call written once, with who was in it')

live = [v for k, v in db(A).items() if k.startswith('calls/') and '/signals/' not in k and v.get('live')]
ok(not live, 'no call left open')
sig = [k for k in db(A) if '/signals/' in k]
print('signals left', len(sig))
for e in errs: print(' ', e[:300])
br.close(); pw.stop(); srv.shutdown()
print('FAILS:', len(fails))
