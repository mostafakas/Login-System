"""Call recording + automatic transcript; kept for the admin; others request access and the admin approves."""
import sys, os, time, json, base64; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import seed_payload, BASE, ts, serve, route
from playwright.sync_api import sync_playwright

now = int(time.time() * 1000)
p = seed_payload({'settings/migration': {'done': True}, 'settings/public': {'authServiceUrl': 'https://svc.test/exec', 'loginDomain': ''}})
dm = 'emp1@almaster.tech__emp2@almaster.tech'
p['fs'][f'chats/{dm}'] = {'members': ['emp1@almaster.tech', 'emp2@almaster.tech'], 'createdAt': ts(now), 'updatedAt': ts(now), 'createdBy': 'emp1@almaster.tech',
                         'lastMessage': None, 'unread': {'emp1_almaster_tech': 0, 'emp2_almaster_tech': 0}, 'lastRead': {}}
fails = []
def ok(c, m): print(('OK ' if c else 'FAIL ') + m); (None if c else fails.append(m))
srv = serve(); pw = sync_playwright().start()
br = pw.chromium.launch(headless=True, args=['--disable-web-security', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'])
ctx = br.new_context(viewport={'width': 1366, 'height': 860}, locale='ar-EG', timezone_id='Africa/Cairo', permissions=['microphone'])
ctx.route('**/*', route)
# the Apps Script service, faked: keeps the uploaded parts; recGet returns them
parts = {}
def svc(r):
    body = json.loads(r.request.post_data or '{}'); a = body.get('action')
    if a == 'recUp':
        pid = f"part{len(parts) + 1}"; parts[pid] = body; return r.fulfill(status=200, body=json.dumps({'ok': True, 'id': pid}), headers={'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'})
    if a == 'recGet':
        if body.get('kind') == 'tr': return r.fulfill(status=200, body=json.dumps({'ok': True, 'name': 't.txt', 'text': 'محضر مكالمة\n[10:00:01] سارة محمود: أهلاً'}), headers={'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'})
        b = parts.get(body.get('id'), {}); return r.fulfill(status=200, body=json.dumps({'ok': True, 'mime': b.get('mime', 'video/webm'), 'data': b.get('data', '')}), headers={'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'})
    if a == 'trBuild': return r.fulfill(status=200, body=json.dumps({'ok': True, 'lines': 1}), headers={'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'})
    return r.fulfill(status=200, body=json.dumps({'ok': True}), headers={'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'})
ctx.route('https://svc.test/**', svc)
# headless Chrome has no speech recognition: a fake one that "hears" a sentence every 2 seconds
ctx.add_init_script("""(() => { class FakeSR { constructor() { this.continuous = true; this.lang = ''; }
  start() { if (this._t) return; let n = 0; this._t = setInterval(() => { n++;
    if (n % 3 === 0) {   // like Chrome: it stops by itself in the middle of a phrase — the words heard so far must not be lost
      const res = [{ transcript: 'نص ناقص ' + n }]; res.isFinal = false; this.onresult && this.onresult({ resultIndex: 0, results: [res] });
      clearInterval(this._t); this._t = 0; setTimeout(() => this.onend && this.onend(), 50); return; }
    const res = [{ transcript: 'جملة رقم ' + n + ' من ' + (localStorage.getItem('mockauth_current') || '') }]; res.isFinal = true;
    this.onresult && this.onresult({ resultIndex: 0, results: [res] }); }, 1500); }
  stop() { clearInterval(this._t); this._t = 0; setTimeout(() => this.onend && this.onend(), 10); } abort() { this.stop(); } }
  window.SpeechRecognition = FakeSR; window.webkitSpeechRecognition = FakeSR; })();""")
errs = []
def page():
    pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append(f'PAGEERROR {e}')); return pg
def login(pg, email):
    if not pg.url.startswith(BASE): pg.goto(BASE + '/tests/blank.html')
    pg.evaluate("() => localStorage.removeItem('mockauth_current')")
    pg.goto(BASE + '/index.html'); pg.fill('#email', email); pg.fill('#password', 'Passw0rd!'); pg.click('#login-btn')
    pg.wait_for_url('**/app.html**', timeout=8000); pg.wait_for_selector('#splash', state='detached', timeout=8000)
db = lambda pg: pg.evaluate("() => JSON.parse(localStorage.getItem('mockfs') || '{}')")

A = page(); A.goto(BASE + '/tests/blank.html')
A.evaluate("""(p) => { localStorage.clear(); localStorage.setItem('mockauth_users', JSON.stringify(p.auth)); localStorage.setItem('mockfs', JSON.stringify(p.fs)); localStorage.setItem('am_lang', 'ar'); }""", p)
login(A, 'emp1@almaster.tech'); B = page(); login(B, 'emp2@almaster.tech')
A.evaluate("h => location.hash = h", f'#/chat/{dm}'); A.wait_for_timeout(1200)
A.click('#call'); B.wait_for_timeout(2000); B.locator('.call-in [data-a=yes]').click(); B.wait_for_timeout(5000)
ok(A.locator('.call-trnote').count() == 1 and 'تلقائي' in A.locator('.call-trnote').inner_text(), 'transcript starts by itself')
A.locator('.call-panel [data-c=rec]').click(); A.wait_for_timeout(1500)
ok(B.locator('.call-recon').count() == 1 and 'بتتسجّل' in B.locator('.call-recon').inner_text(), 'everyone sees "this call is being recorded"')
ok(B.locator('.call-panel [data-c=rec]').is_disabled(), 'only one person records at a time')
A.wait_for_timeout(25000)   # talk a little (the transcript is saved every ~20 s)
A.locator('.call-panel [data-c=rec]').click(); A.wait_for_timeout(4000)
ok(len(parts) >= 1 and len(base64.b64decode(list(parts.values())[0]['data'])) > 5000, f'recording part uploaded ({[len(v.get("data", "")) for v in parts.values()]})')
d = db(A)
lines = [v for k, v in d.items() if k.startswith('call_transcripts/')]
ok(any(l['by'] == 'emp1@almaster.tech' for l in lines) and any(l['by'] == 'emp2@almaster.tech' for l in lines), f'each side writes down its own words ({len(lines)} saves)')
texts = [x['text'] for l in lines for x in l['lines']]
ok(any(t.startswith('نص ناقص') for t in texts), 'a phrase cut off when the recognizer stops is still kept')
ok(sum(1 for t in texts if t.startswith('جملة رقم')) >= 8, f'it keeps listening after each stop ({len(texts)} lines)')
B.locator('.call-panel [data-c=end]').click(); A.wait_for_timeout(4000)
msgs = [v for k, v in db(A).items() if k.startswith(f'chats/{dm}/messages/') and v.get('type') == 'call']
ok(msgs and msgs[-1]['call'].get('rec') and msgs[-1]['call'].get('tr'), 'the call in the chat says it was recorded and transcribed')
cid = msgs[-1]['call']['id']
# what the Apps Script would have written
A.evaluate("""([cid, parts]) => { const fs = JSON.parse(localStorage.getItem('mockfs'));
  fs['call_records/' + cid] = { callId: cid, chatId: 'x', title: 'عمر خالد', members: ['emp1@almaster.tech', 'emp2@almaster.tech'], atMs: Date.now(), startedAt: Date.now(), updatedMs: Date.now(),
    parts: parts.map((id, i) => ({ id, n: i + 1, durMs: 6000, video: false, startMs: Date.now() })), transcript: { id: 'tr1', lines: 5 } };
  const v = JSON.stringify(fs); localStorage.setItem('mockfs', v); window.dispatchEvent(new StorageEvent('storage', { key: 'mockfs', newValue: v })); }""", [cid, list(parts.keys())])
# B (an employee) can't open it: asks
B.evaluate("h => location.hash = h", f'#/chat/{dm}'); B.wait_for_timeout(1500)
ok(B.locator('[data-recask]').count() == 1 and B.locator('[data-recopen]').count() == 0, 'the employee sees "request" instead of the recording')
B.locator('[data-recask]').click(); B.wait_for_timeout(300); B.fill('#rq-r', 'محتاج أراجع الاتفاق'); B.click('#rq-go'); B.wait_for_timeout(1000)
rq = [v for k, v in db(B).items() if k.startswith('record_requests/')]
ok(len(rq) == 1 and rq[0]['status'] == 'pending' and sorted(rq[0]['kinds']) == ['rec', 'tr'], 'request sent')
ok('مستني' in B.locator('.chat-recbtns').inner_text(), 'the chat shows "waiting for the admin"')
# the admin approves
C = page(); login(C, 'admin@almaster.tech'); C.evaluate("h => location.hash = h", '#/records'); C.wait_for_timeout(1500)
ok(C.locator('#rq [data-yes]').count() == 1 and C.locator('#list [data-play]').count() == 1, 'admin sees the request and the recording')
C.locator('#rq [data-yes]').click(); C.wait_for_timeout(1200)
r = db(C)[f'call_records/{cid}']
ok('emp2@almaster.tech' in r.get('viewRec', []) and 'emp2@almaster.tech' in r.get('viewTr', []), 'approval opens it for that employee')
B.wait_for_timeout(1500)
ok(B.locator('[data-recopen]').count() == 2, 'the employee now has "Recording" and "Transcript"')
B.locator('[data-recopen][data-kind=rec]').click(); B.wait_for_timeout(2500)
ok(B.evaluate("() => { const v = document.querySelector('#rp-v'); return !!(v && v.src && v.src.startsWith('blob:')); }"), 'the recording plays')
B.locator('.modal-root [data-close]').last.click(); B.wait_for_timeout(300)
B.locator('[data-recopen][data-kind=tr]').click(); B.wait_for_timeout(1500)
ok('محضر' in B.locator('#tp-body').inner_text(), 'the transcript opens')
B.screenshot(path='shots/f14-transcript.png')
for e in errs: print(' ', e[:300])
br.close(); pw.stop(); srv.shutdown()
print('FAILS:', len(fails))
