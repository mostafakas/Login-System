// Short, quiet UI sounds made with WebAudio (no files to download). Each event has its own sound.
// Turned on by default; users can mute them from "My profile".
const KEY = 'am_sounds';
let ctx = null;
export const soundsOn = () => { try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; } };
export const setSounds = (on) => { try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch {} };

function ac() {
  if (!ctx) { const A = window.AudioContext || window.webkitAudioContext; if (!A) return null; ctx = new A(); }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
// browsers only allow audio after the first click/key press on the page
['pointerdown', 'keydown', 'touchstart'].forEach(ev => window.addEventListener(ev, () => { try { ac(); } catch {} }, { once: true, passive: true }));

// ---- rings on every speaker at once (laptop speakers + headset / earbuds), so a call is heard even when the
// headset is lying on the desk. Chrome / Edge only (setSinkId); elsewhere the normal output is used.
let outs = null, outsBusy = null;
async function allOutputs() {
  if (outs) return outs;
  if (outsBusy) return outsBusy;
  outsBusy = (async () => {
    try {
      const a = ac();
      if (!a || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices || !('setSinkId' in HTMLMediaElement.prototype)) return null;
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput' && d.deviceId && !['default', 'communications'].includes(d.deviceId));
      const seen = new Set(), list = [];
      devs.forEach(d => { const g = d.groupId || d.deviceId; if (!seen.has(g)) { seen.add(g); list.push(d); } });   // one per physical device
      if (list.length < 2) return null;                       // one speaker only: the normal output is enough
      const dest = a.createMediaStreamDestination();
      const els = (await Promise.all(list.map(async d => {
        const el = new Audio(); el.srcObject = dest.stream;
        try { await el.setSinkId(d.deviceId); await el.play(); return el; } catch { return null; }
      }))).filter(Boolean);
      if (els.length < 2) { els.forEach(el => { el.pause(); el.srcObject = null; }); return null; }
      outs = { dest, els };
      return outs;
    } catch { return null; } finally { outsBusy = null; }
  })();
  return outsBusy;
}
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', () => {
  if (outs) { outs.els.forEach(el => { try { el.pause(); el.srcObject = null; } catch {} }); outs = null; }   // headset plugged in / out
});

/** notes: [freqHz, startSec, durSec], soft sine envelope */
function tones(notes, { vol = 0.07, type = 'sine', to = null } = {}) {
  const a = ac(); if (!a) return;
  const t0 = a.currentTime + 0.01;
  notes.forEach(([f, s, d]) => {
    const o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t0 + s);
    g.gain.setValueAtTime(0.0001, t0 + s);
    g.gain.exponentialRampToValueAtTime(vol, t0 + s + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + s + d);
    o.connect(g).connect(to || a.destination);
    o.start(t0 + s); o.stop(t0 + s + d + 0.02);
  });
}

const LOUD = new Set(['ring', 'meeting']);   // calls and rings: on every speaker
const SOUNDS = {
  send: () => tones([[740, 0, 0.07], [988, 0.05, 0.09]], { vol: 0.05 }),                   // quick upward blip
  receive: () => tones([[1175, 0, 0.08], [880, 0.07, 0.12]], { vol: 0.07 }),               // soft "pop"
  submit: () => tones([[660, 0, 0.06], [880, 0.06, 0.06], [1320, 0.12, 0.1]], { vol: 0.05 }), // request sent
  request: () => tones([[523, 0, 0.12], [784, 0.1, 0.18]], { vol: 0.08, type: 'triangle' }), // new request for me
  approved: () => tones([[523, 0, 0.08], [659, 0.07, 0.08], [784, 0.14, 0.16]], { vol: 0.07 }), // happy arpeggio
  rejected: () => tones([[440, 0, 0.12], [330, 0.1, 0.2]], { vol: 0.07, type: 'triangle' }), // low, falling
  meeting: (to) => tones([[587, 0, 0.12], [784, 0.12, 0.12], [988, 0.24, 0.22]], { vol: 0.08, type: 'triangle', to }), // invitation to a meeting
  ring: (to) => tones([[880, 0, 0.09], [1175, 0.1, 0.09], [880, 0.2, 0.09], [1175, 0.3, 0.09],
    [880, 0.75, 0.09], [1175, 0.85, 0.09], [880, 0.95, 0.09], [1175, 1.05, 0.09]], { vol: 0.1, to }), // phone-like double trill
  ringback: () => tones([[425, 0, 1.0]], { vol: 0.05 }),                                   // the caller's "tuuut" while it rings
  calljoin: () => tones([[660, 0, 0.08], [990, 0.08, 0.12]], { vol: 0.06 }),               // connected
  callend: () => tones([[620, 0, 0.12], [420, 0.12, 0.18]], { vol: 0.06, type: 'triangle' }), // hung up
  info: () => tones([[880, 0, 0.1]], { vol: 0.05 })                                         // neutral tick
};
export function play(name) {
  if (!soundsOn()) return;
  if (LOUD.has(name)) {
    allOutputs().then(o => { try { SOUNDS[name](o ? o.dest : null); } catch {} }).catch(() => { try { SOUNDS[name](); } catch {} });
    return;
  }
  try { (SOUNDS[name] || SOUNDS.info)(); } catch {}
}
