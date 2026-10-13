"""Meetings (who with + invitation + accept), @mention meeting hint, 1:1 ring, excuse approval moves the day's time."""
import sys, os, time, json; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from datetime import datetime
from zoneinfo import ZoneInfo
from harness import App, seed_payload, BASE, ts

now = int(time.time() * 1000)
today = datetime.now(ZoneInfo('Africa/Cairo')).strftime('%Y-%m-%d')
p = seed_payload({'settings/migration': {'done': True}})
for e in ['emp1@almaster.tech', 'emp2@almaster.tech', 'leader@almaster.tech']:
    p['fs'][f'users/{e}'].update({'status': 'Online', 'dayKey': today, 'lastChange': ts(now - 3600000), 'lastChangeClient': now - 3600000,
                                  'timeBank': {'Online': 0, 'Break': 0, 'Meeting': 0}, 'firstOnlineAt': ts(now - 3600000), 'workLocation': 'office', 'checkedOut': False})
gid = 'grp1'
p['fs'][f'chats/{gid}'] = {'type': 'group', 'name': 'فريق البرمجيات', 'members': ['emp1@almaster.tech', 'emp2@almaster.tech', 'leader@almaster.tech'], 'admins': [],
                          'createdAt': ts(now), 'updatedAt': ts(now), 'createdBy': 'admin@almaster.tech', 'lastMessage': None, 'unread': {}, 'lastRead': {}}
dm = 'emp1@almaster.tech__leader@almaster.tech'
p['fs'][f'chats/{dm}'] = {'members': ['emp1@almaster.tech', 'leader@almaster.tech'], 'createdAt': ts(now), 'updatedAt': ts(now), 'createdBy': 'leader@almaster.tech',
                         'lastMessage': None, 'unread': {'emp1_almaster_tech': 0, 'leader_almaster_tech': 0}, 'lastRead': {}}
p['fs']['requests/ex1'] = {'email': 'emp1@almaster.tech', 'name': 'سارة محمود', 'leaderEmail': 'leader@almaster.tech', 'department': 'البرمجيات', 'type': 'excuse',
                           'excuseKind': 'late', 'fromTime': '09:00', 'toTime': '10:30', 'minutes': 90, 'startDate': today, 'endDate': today,
                           'status': 'pending_hr', 'stages': ['hr'], 'history': [], 'createdMs': now, 'createdAt': ts(now), 'updatedAt': ts(now), 'reason': 'مشوار'}

a = App(); pg = a.page
fails = []
def ok(c, m): print(('OK ' if c else 'FAIL ') + m); (None if c else fails.append(m))
a.seed(p)

# 1) emp1: "Meeting" asks who with → picks emp2 → invitation
a.login('emp1@almaster.tech'); pg.wait_for_timeout(900)
pg.click('[data-st="Meeting"]'); pg.wait_for_timeout(400)
ok(pg.locator('.modal-root #mp-list').count() == 1, 'meeting picker opens')
pg.click('#mp-go'); pg.wait_for_timeout(300)
ok(pg.locator('#mp-err').is_visible(), 'must pick someone')
pg.fill('#mp-q', 'عمر'); pg.wait_for_timeout(250)
pg.locator('#mp-list [data-p="emp2@almaster.tech"]').check(); pg.fill('#mp-topic', 'مراجعة الـ API')
pg.click('#mp-go'); pg.wait_for_timeout(1200)
u1 = a.db('users/emp1@almaster.tech')
ok(u1['status'] == 'Meeting' and u1.get('meetingWith') == ['emp2@almaster.tech'] and u1.get('meetingTopic') == 'مراجعة الـ API', f"emp1 in a meeting with emp2 ({u1.get('status')}, {u1.get('meetingWith')})")
inv = [v for k, v in a.db().items() if k.startswith('meeting_invites/')]
ok(len(inv) == 1 and inv[0]['to'] == 'emp2@almaster.tech' and inv[0]['status'] == 'pending', 'invitation stored for emp2')
ok('عمر' in pg.locator('#hero').inner_text(), 'hero shows who the meeting is with')
ok(pg.locator('.meet-box').count() == 1 and 'مستني' in pg.locator('.meet-box').inner_text(), 'meeting box shows the invite waiting')
a.shot('f7-host')

# 2) emp2: invitation popup → accept
a.login('emp2@almaster.tech'); pg.wait_for_timeout(1500)
ok(pg.locator('.mt-invite').count() == 1 and 'سارة' in pg.locator('.mt-invite').inner_text(), 'invite popup for emp2')
a.shot('f7-invite')
pg.locator('.mt-invite [data-a=yes]').click(); pg.wait_for_timeout(1200)
u2 = a.db('users/emp2@almaster.tech')
ok(u2['status'] == 'Meeting' and u2.get('meetingWith', [None])[0] == 'emp1@almaster.tech', f"emp2 status → Meeting with emp1 ({u2.get('status')})")
inv = [v for k, v in a.db().items() if k.startswith('meeting_invites/')]
ok(inv[0]['status'] == 'accepted', 'invite accepted')
ok(pg.locator('.mt-invite').count() == 0, 'popup closed after accepting')

# 3) emp1 hears the answer
a.login('emp1@almaster.tech'); pg.wait_for_timeout(1500)
ok(any('قبل' in t for t in pg.locator('.chat-pop').all_inner_texts()), 'host sees "accepted"')
inv = [v for k, v in a.db().items() if k.startswith('meeting_invites/')]
ok(inv[0].get('fromSeen') is True, 'answer marked seen')

# 4) leader: monitor + @mention hint + ring
a.login('leader@almaster.tech'); a.go('#/monitor'); pg.wait_for_timeout(1500)
mon = pg.locator('#view').inner_text()
ok('مع' in mon and pg.locator('.sub.meet').count() >= 2, f"monitor shows who meets whom ({pg.locator('.sub.meet').count()})")
a.go(f'#/chat/{gid}'); pg.wait_for_timeout(1200)
pg.click('#text'); pg.keyboard.type('@سا'); pg.wait_for_timeout(400)
ok('في ميتنج مع' in pg.locator('#suggest').inner_text(), 'mention list shows the meeting line')
pg.keyboard.press('Enter'); pg.wait_for_timeout(300)
hint = pg.locator('#mhint')
ok(hint.is_visible() and 'في ميتنج مع' in hint.inner_text() and 'عمر' in hint.inner_text(), f"hint under the box: {hint.inner_text() if hint.count() else ''}")
a.shot('f7-mention')
pg.keyboard.type('محتاجك بعد الميتنج'); pg.keyboard.press('Enter'); pg.wait_for_timeout(800)
ok(pg.locator('.chat-mention .chat-mention-meet').count() == 1, 'sent mention marked "in a meeting"')
a.go(f'#/chat/{dm}'); pg.wait_for_timeout(1200)
ok('مع' in pg.locator('#away').inner_text(), f"1:1 note says who the meeting is with: {pg.locator('#away').inner_text()}")
ok(pg.locator('#ring').count() == 1, 'ring button in a 1:1 chat')
pg.click('#ring'); pg.wait_for_timeout(900)
msgs = [v for k, v in a.db().items() if k.startswith(f'chats/{dm}/messages/')]
ok(any(m['type'] == 'ring' for m in msgs) and a.db(f'chats/{dm}')['lastMessage']['type'] == 'ring', 'ring message stored')
ok(pg.locator('.chat-ringmsg').count() == 1, 'ring bubble shown')
pg.evaluate("() => document.querySelector('#ring').click()"); pg.wait_for_timeout(500)   # the button is dimmed; a click still must not ring
n_r = [v.get("type") for k, v in a.db().items() if k.startswith(f"chats/{dm}/messages/")]; ok(n_r.count("ring") == 1, f"second ring within 20s blocked ({n_r})")
a.go(f'#/chat/{gid}'); pg.wait_for_timeout(800)
ok(pg.locator('#ring').count() == 0, 'no ring button in groups')

# 5) emp1 receives a ring while the chat is open and muted
a.login('emp1@almaster.tech'); a.go(f'#/chat/{dm}'); pg.wait_for_timeout(1000)
pg.evaluate("""(cid) => { const fs = JSON.parse(localStorage.getItem('mockfs')); const t = { __ts: Date.now() + 60000 };
  fs['chats/' + cid + '/messages/rr'] = { by: 'leader@almaster.tech', type: 'ring', text: '', at: t };
  const c = fs['chats/' + cid]; c.muted = { emp1_almaster_tech: true }; c.lastMessage = { id: 'rr', by: 'leader@almaster.tech', text: '📞 رنّة', type: 'ring', at: t }; c.updatedAt = t;
  const v = JSON.stringify(fs); localStorage.setItem('mockfs', v); window.dispatchEvent(new StorageEvent('storage', { key: 'mockfs', newValue: v })); }""", dm)
pg.wait_for_timeout(1000)
ok(pg.locator('.chat-pop.ringing').count() == 1 and 'بيرن' in pg.locator('.chat-pop.ringing').inner_text(), 'ring popup even though the chat is open and muted')
a.shot('f7-ring')

# 6) leaving the meeting clears it; changing status again
a.go('#/home'); pg.wait_for_timeout(800)
pg.click('[data-st="Online"]'); pg.wait_for_timeout(1000)
u1 = a.db('users/emp1@almaster.tech')
ok(u1['status'] == 'Online' and u1.get('meetingWith') == [] and u1.get('meetingId') == '', 'back to work clears the meeting')
logs = [v for k, v in a.db().items() if k.startswith('logs/') and v.get('to_status') == 'Meeting']
ok(any(l.get('meeting_with') for l in logs), 'status log records who the meeting was with')

# 7) excuse approval: today's start moves to 10:30
a.login('admin@almaster.tech'); pg.wait_for_timeout(800)
res = pg.evaluate("async () => { const m = await import('/assets/js/services/requests.js'); return await m.decide('ex1', 'approve'); }")
pg.wait_for_timeout(800)
sc = a.db(f"schedules/emp1@almaster.tech_{today[:7]}") or {}
day = (sc.get('days') or {}).get(today, {})
ok(res == 'approved' and day.get('start') == '10:30' and day.get('excuseId') == 'ex1', f"approved late permission sets the start to 10:30 ({day})")
pg.evaluate("async () => { const m = await import('/assets/js/services/requests.js'); return await m.revokeRequest('ex1', 'test'); }")
pg.wait_for_timeout(800)
sc = a.db(f"schedules/emp1@almaster.tech_{today[:7]}") or {}
ok(today not in (sc.get('days') or {}), 'revoking the permission restores the day')

errs = a.dump_errors('flow7')
a.close()
print('FAILS:', len(fails))
