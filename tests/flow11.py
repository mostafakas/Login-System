"""Reply to a message: reply button, double-click, quote that jumps to the original, the group author is told."""
import sys, os, time; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import App, seed_payload, BASE, ts

now = int(time.time() * 1000)
p = seed_payload({'settings/migration': {'done': True}})
gid = 'grp1'
p['fs'][f'chats/{gid}'] = {'type': 'group', 'name': 'فريق البرمجيات', 'members': ['emp1@almaster.tech', 'emp2@almaster.tech', 'leader@almaster.tech'], 'admins': [],
                          'createdAt': ts(now), 'updatedAt': ts(now), 'createdBy': 'admin@almaster.tech', 'lastMessage': None, 'unread': {}, 'lastRead': {}}
a = App(); pg = a.page
fails = []
def ok(c, m): print(('OK ' if c else 'FAIL ') + m); (None if c else fails.append(m))
a.seed(p)
msgs = lambda cid: sorted([dict(v, id=k.split('/')[-1]) for k, v in a.db().items() if k.startswith(f'chats/{cid}/messages/')], key=lambda m: m['at']['__ts'])

# emp1 posts in the group
a.login('emp1@almaster.tech'); a.go(f'#/chat/{gid}'); pg.wait_for_timeout(1000)
pg.fill('#text', 'مين خلّص تقرير الأسبوع؟'); pg.keyboard.press('Enter'); pg.wait_for_timeout(700)

# emp2 double-clicks it and replies
a.login('emp2@almaster.tech'); a.go(f'#/chat/{gid}'); pg.wait_for_timeout(1200)
pg.locator('.chat-row.them .chat-text').first.dblclick(); pg.wait_for_timeout(300)
bar = pg.locator('#replybar')
ok(bar.is_visible() and 'سارة' in bar.inner_text() and 'تقرير الأسبوع' in bar.inner_text(), 'double-click opens the reply bar')
pg.keyboard.press('Escape'); pg.wait_for_timeout(200)
ok(not bar.is_visible(), 'Esc cancels the reply')
pg.locator('.chat-row.them').first.hover(); pg.locator('.chat-row.them [data-reply]').first.click(); pg.wait_for_timeout(200)
ok(bar.is_visible(), 'reply button opens the reply bar')
pg.fill('#text', 'أنا خلّصته'); pg.keyboard.press('Enter'); pg.wait_for_timeout(900)
ms = msgs(gid); last = ms[-1]
ok(last.get('replyTo', {}).get('id') == ms[0]['id'] and last['replyTo']['by'] == 'emp1@almaster.tech' and 'تقرير' in last['replyTo']['text'], 'reply stored with the quote')
ok(not bar.is_visible(), 'reply bar cleared after sending')
ok(pg.locator('.chat-row.me .chat-quote').count() == 1, 'quote shown above the reply')
db = a.db()
ok(db[f'chats/{gid}'].get('mentioned', {}).get('emp1_almaster_tech') is True, 'group chat marked for the original author')
ok(any(v.get('to') == 'emp1@almaster.tech' and 'ردّ على رسالتك' in v.get('title', '') for k, v in db.items() if k.startswith('notifications/')), 'author notified')
pg.locator('.chat-quote').first.click(); pg.wait_for_timeout(300)
ok(pg.locator(f'.chat-row[data-mid="{ms[0]["id"]}"].flash').count() == 1, 'quote jumps to the original and flashes it')

# a file can answer too
pg.locator('.chat-row.them .chat-text').first.dblclick(); pg.wait_for_timeout(200)
pg.set_input_files('#file', files=[{'name': 'r.pdf', 'mimeType': 'application/pdf', 'buffer': b'%PDF-1.4 x' * 100}]); pg.wait_for_timeout(1500)
ok(msgs(gid)[-1]['type'] == 'file' and msgs(gid)[-1].get('replyTo', {}).get('id') == ms[0]['id'], 'a file sent as a reply keeps the quote')

# reactions: emp2 reacts 👍 from the smiley button, then switches to ❤️ by right-click
first = pg.locator('.chat-row.them').first
first.hover(); first.locator('[data-react]').click(); pg.wait_for_timeout(200)
ok(pg.locator('.react-pick').count() == 1, 'reaction picker opens')
pg.locator('.react-pick [data-pick="👍"]').click(); pg.wait_for_timeout(600)
ok(a.db(f'chats/{gid}/messages/{ms[0]["id"]}').get('reactions', {}).get('emp2_almaster_tech') == '👍', 'reaction stored')
ok(pg.locator('.chat-row.them').first.locator('.chat-react.mine').inner_text().startswith('👍'), 'reaction chip shown, marked mine')
pg.locator('.chat-row.them .chat-bubble').first.click(button='right'); pg.wait_for_timeout(200)
pg.locator('.react-pick [data-more]').click(); pg.locator('.react-pick [data-pick="🔥"]').click(); pg.wait_for_timeout(600)
ok(a.db(f'chats/{gid}/messages/{ms[0]["id"]}')['reactions'] == {'emp2_almaster_tech': '🔥'}, 'one reaction per person (switched to 🔥)')
ok(any(v.get('to') == 'emp1@almaster.tech' and '🔥' in v.get('title', '') for k, v in a.db().items() if k.startswith('notifications/')), 'author notified of the reaction')
a.shot('f11-react')

# emp1 sees the reply highlighted
a.login('emp1@almaster.tech'); a.go(f'#/chat/{gid}'); pg.wait_for_timeout(1200)
ok(pg.locator('.chat-bubble.mentioned .chat-quote').count() >= 1, 'author sees the reply highlighted with the quote')
ok(pg.locator('.chat-react').first.inner_text().startswith('🔥'), 'author sees the reaction')
pg.locator('.chat-react').first.click(); pg.wait_for_timeout(600)
rx = a.db(f'chats/{gid}/messages/{ms[0]["id"]}')['reactions']
ok(rx == {'emp2_almaster_tech': '🔥', 'emp1_almaster_tech': '🔥'} and '2' in pg.locator('.chat-react').first.inner_text(), 'clicking a chip adds the same reaction (count 2)')
pg.locator('.chat-react').first.click(); pg.wait_for_timeout(600)
ok(a.db(f'chats/{gid}/messages/{ms[0]["id"]}')['reactions'] == {'emp2_almaster_tech': '🔥'}, 'clicking it again removes mine')
a.shot('f11-reply')
a.dump_errors('flow11'); a.close()
print('FAILS:', len(fails))
