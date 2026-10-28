"""Shift 8 / 9 end times and early leave, and the "edited by hand" marker on the monthly day table.
- shift 8 (08:00–17:00): in 08:20, out 17:07 = no early leave; shift 9 (09:00–18:00): out 17:07 = 53 min early.
- a day with no picked shift (fixed hours 09:00–18:00 on the profile) is measured against 18:00 (the screenshot's
  -53), and the table now shows those hours next to the status.
- a day saved with no shift ('' = the person had fixed hours then) by someone who now picks a shift every day is
  counted on the shift the check-in fits (08:20 → shift 8), so no early leave at 17:07; old days without the field stay.
- a day HR corrected shows «تعديل يدوي · <name>», and a pen only next to the time that changed."""
import sys, os, time; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import seed_payload, BASE, serve, route
from playwright.sync_api import sync_playwright
fails = []
def ok(c, m): print(('OK ' if c else 'FAIL ') + m); (None if c else fails.append(m))
def cairo(day, hm): h, m = map(int, hm.split(':')); return int(time.mktime(time.strptime(day, '%Y-%m-%d')) - time.timezone) * 1000 + ((h - 3) * 60 + m) * 60000
H = 3600000
E = 'emp1@almaster.tech'
def day(d, i, o, shift, **kw):
    r = {'email': E, 'date': d, 'leaderEmail': 'leader@almaster.tech', 'checkInMs': cairo(d, i), 'checkOutMs': cairo(d, o), 'workMs': 7 * H, 'meetingMs': 0, 'breakMs': H, 'mode': 'office', 'shift': shift, 'closed': True}
    r.update(kw); return {f'attendance_days/{E}_{d}': r}
extra = {'settings/migration': {'done': True}, 'settings/general': {'trackingStart': '2026-10-01', 'workStart': '09:00', 'workEnd': '17:00', 'graceMinutes': 15}}
extra.update(day('2026-10-22', '08:20', '17:07', ''))      # Thu: saved without a shift (was on fixed hours)
extra.update(day('2026-10-25', '08:20', '17:07', '8'))     # Sun: shift 8
extra.update(day('2026-10-26', '09:00', '17:07', '9'))     # Mon: shift 9
# Tue: shift 8, HR moved the check-out from 16:00 to 17:00 (check-in untouched)
extra.update(day('2026-10-27', '08:05', '17:00', '8', corrected=True, correctedBy='hr@almaster.tech', correctionNote='نسي يقفل',
                 previous={'checkInMs': cairo('2026-10-27', '08:05'), 'checkOutMs': cairo('2026-10-27', '16:00'), 'workMs': 7 * H, 'mode': 'office'}))
p = seed_payload(extra)
for e in p['fs']:
    if e.startswith('users/'): p['fs'][e]['createdAt'] = {'__ts': cairo('2025-01-01', '09:00')}

srv = serve(); pw = sync_playwright().start(); br = pw.chromium.launch(executable_path=os.environ.get('PW_CHROMIUM') or None)
ctx = br.new_context(viewport={'width': 1440, 'height': 950}, locale='ar-EG', timezone_id='Africa/Cairo'); ctx.route('**/*', route)
ctx.clock.install(time=cairo('2026-10-28', '12:00') / 1000)
errs = []
pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
pg.goto(BASE + '/tests/blank.html')

# pure calculation: shifts, and a fixed 09:00–18:00 person with no shift (the screenshot)
res = pg.evaluate("""async (t) => {
  const { classifyDay } = await import('/assets/js/services/reports.js');
  const { planFor, shiftById } = await import('/assets/js/core/policy.js');
  const rec = (i, o, shift) => ({ checkInMs: i, checkOutMs: o, closed: true, mode: 'office', shift, workMs: 7 * 3600000 });
  const free = { email: 'x@almaster.tech' }, fixed9 = { email: 'y@almaster.tech', workStart: '09:00', workEnd: '18:00' };
  const r8 = classifyDay('2026-10-25', planFor('2026-10-25', null, free), rec(t.in820, t.out1707, '8'), [], '2026-10-28');
  const r9 = classifyDay('2026-10-25', planFor('2026-10-25', null, free), rec(t.in820, t.out1707, '9'), [], '2026-10-28');
  const rf = classifyDay('2026-10-25', planFor('2026-10-25', null, fixed9), rec(t.in820, t.out1707, ''), [], '2026-10-28');
  const rg = classifyDay('2026-10-25', planFor('2026-10-25', null, free), rec(t.in820, t.out1707, ''), [], '2026-10-28');
  const rr = classifyDay('2026-10-25', planFor('2026-10-25', null, free), { ...rec(t.in806, t.out1707, ''), mode: 'remote' }, [], '2026-10-28');
  const old = rec(t.in820, t.out1707); delete old.shift;
  const ro = classifyDay('2026-10-25', planFor('2026-10-25', null, free), old, [], '2026-10-28');
  const s = (id) => { const x = shiftById(id); return [x.start, x.end]; };
  return { s8: s('8'), s9: s('9'), r8: [r8.plan.end, r8.late, r8.early], r9: [r9.plan.end, r9.late, r9.early], rf: [rf.plan.shift || '', rf.plan.end, rf.early],
    rg: [rg.plan.shift, rg.plan.end, rg.late, rg.early, rg.flags.includes('shift-guessed')], rr: [rr.plan.shift, rr.late, rr.early],
    ro: [ro.plan.shift || '', ro.plan.end, ro.flags.includes('shift-guessed')] };
}""", {'in806': cairo('2026-10-25', '08:06'), 'in820': cairo('2026-10-25', '08:20'), 'out1707': cairo('2026-10-25', '17:07')})
print(res)
ok(res['s8'] == ['08:00', '17:00'] and res['s9'] == ['09:00', '18:00'], 'shift 8 = 08:00–17:00 and shift 9 = 09:00–18:00 (9 hours each)')
ok(res['r8'] == ['17:00', 0, 0], f'shift 8, 08:20–17:07: ends 17:00, no lateness, no early leave ({res["r8"]})')
ok(res['r9'] == ['18:00', 0, 53], f'shift 9, out 17:07: 53 min early ({res["r9"]})')
ok(res['rf'] == ['', '18:00', 53], f'fixed 09:00–18:00 with no shift: measured against 18:00 = 53 min (the screenshot) ({res["rf"]})')
ok(res['rg'] == ['8', '17:00', 0, 0, True], f'saved without a shift, picks daily now: 08:20 → shift 8, no early leave ({res["rg"]})')
ok(res['rr'] == ['8', 0, 0], f'same on a remote day, 08:06 → shift 8 ({res["rr"]})')
ok(res['ro'] == ['', '17:00', False], f'an old day without the shift field keeps the company hours ({res["ro"]})')

pg.evaluate("(p) => { localStorage.clear(); localStorage.setItem('mockauth_users', JSON.stringify(p.auth)); localStorage.setItem('mockfs', JSON.stringify(p.fs)); localStorage.setItem('am_lang','ar'); }", p)
pg.goto(BASE + '/index.html'); pg.fill('#email', E); pg.fill('#password', 'Passw0rd!'); pg.click('#login-btn')
pg.wait_for_url('**/app.html**'); pg.wait_for_selector('#splash', state='detached')
pg.evaluate("h => location.hash = h", '#/attendance'); pg.wait_for_selector('#pm-table tbody tr', timeout=8000)
row = lambda d: pg.locator(f'#pm-table tr[data-day="{d}"]')
cells = lambda d: row(d).locator('td').all_inner_texts()
c22 = cells('2026-10-22'); print(c22)
ok('شيفت 08:00' in c22[1] and 'حسب الحضور' in c22[1] and c22[8].strip() == '—', 'table: a day saved without a shift shows «شيفت 08:00 (حسب الحضور)» and no early leave')
c25, c26, c27 = cells('2026-10-25'), cells('2026-10-26'), cells('2026-10-27')
print(c25, c26, c27, sep='\n')
ok('شيفت 08:00' in c25[1] and c25[8].strip() == '—', 'table: shift 8 day shows its shift and no early leave')
ok('شيفت 09:00' in c26[1] and '53' in c26[8], 'table: shift 9 day out at 17:07 shows 53 min early')
ok('تعديل يدوي' in c27[1] and 'منى عادل' in c27[1], 'corrected day: «تعديل يدوي · منى عادل» next to the status')
ok(row('2026-10-25').locator('.edited-day, .edited-time').count() == 0, 'a day nobody edited has no marker')
ok(row('2026-10-27').locator('td:nth-child(3) .edited-time').count() == 0, 'check-in was not changed: no pen on it')
pen = row('2026-10-27').locator('td:nth-child(4) .edited-time')
ok(pen.count() == 1 and 'منى عادل' in (pen.get_attribute('title') or '') and '04:00' in (pen.get_attribute('title') or ''), f'check-out changed: pen with who and the old time ({pen.get_attribute("title") if pen.count() else None})')
row('2026-10-27').click(); pg.wait_for_selector('.modal-root', timeout=3000)
mt = pg.locator('.modal-root').inner_text()
ok('تعديل يدوي من منى عادل' in mt and 'قبل التعديل' in mt, 'day details: who edited it and the time before the edit')
pg.keyboard.press('Escape'); pg.wait_for_timeout(300)
pg.screenshot(path=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'shots', 'f30-edited-day.png'), full_page=False)

print('errors', errs); ok(not [e for e in errs if 'favicon' not in e], 'no page errors')
br.close(); pw.stop()
print('ALL OK' if not fails else f'{len(fails)} FAILED'); sys.exit(1 if fails else 0)
