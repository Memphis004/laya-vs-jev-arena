/* Fight sound, synthesized — no audio files to ship or load.

   Every hit is built from the same two ingredients a real impact has: a pitched
   body that drops fast (the thud) and a noise transient (the crack). Changing a
   punch into a kick is mostly moving those two numbers, which is why these are
   written as data rather than as separate functions.

   The AudioContext can only start from a user gesture, so nothing is created until
   unlock() is called from a click. */
"use strict";

const VOICES = {
  // short, snappy, high crack
  punch: {thudFrom: 210, thudTo: 60, thudMs: 140, thudGain: 0.55,
          noiseMs: 70, noiseGain: 0.34, noiseHz: 1900, q: 0.9},
  // heavier body, lower, longer tail
  kick:  {thudFrom: 140, thudTo: 38, thudMs: 260, thudGain: 0.75,
          noiseMs: 120, noiseGain: 0.40, noiseHz: 1200, q: 0.8}
};

export class Sfx {
  constructor(){
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.volume = 0.8;
    this.last = {};          // per-voice throttle so a stuck state cannot machine-gun
  }

  /** call from a click: browsers refuse to start audio any other way */
  unlock(){
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    // a touch of space so impacts do not sound like clicks in a dead room
    this.master.connect(this.ctx.destination);
  }

  setMuted(m){
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.01);
  }

  get t(){ return this.ctx.currentTime; }

  ready(name, minGapMs = 45){
    if (!this.ctx || this.muted) return false;
    const now = performance.now();
    if (this.last[name] && now - this.last[name] < minGapMs) return false;
    this.last[name] = now;
    return true;
  }

  // ---------- primitives ----------
  noiseBuffer(ms){
    const n = Math.max(1, Math.floor(this.ctx.sampleRate * ms/1000));
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random()*2 - 1) * (1 - i/n);  // decaying
    return buf;
  }

  noise(ms, gain, hz, q = 1, type = 'bandpass', sweepTo = null){
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ms);
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = hz; f.Q.value = q;
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, this.t + ms/1000);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, this.t);
    g.gain.exponentialRampToValueAtTime(0.0001, this.t + ms/1000);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start();
    src.stop(this.t + ms/1000 + 0.02);
  }

  tone(from, to, ms, gain, type = 'sine'){
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(from, this.t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, to), this.t + ms/1000);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, this.t);
    g.gain.exponentialRampToValueAtTime(0.0001, this.t + ms/1000);
    o.connect(g); g.connect(this.master);
    o.start();
    o.stop(this.t + ms/1000 + 0.02);
  }

  // ---------- the fight's voices ----------
  /** the whoosh as a move winds up — pitched by weight so you can hear a kick coming */
  swing(move){
    if (!this.ready('swing:'+move, 60)) return;
    const heavy = move === 'KICK';
    this.noise(heavy ? 260 : 150, heavy ? 0.16 : 0.12,
               heavy ? 700 : 1400, 1.4, 'bandpass', heavy ? 240 : 500);
  }

  /** clean connect: body thud plus a crack */
  hit(move){
    if (!this.ready('hit', 30)) return;
    const v = VOICES[move === 'KICK' ? 'kick' : 'punch'];
    this.tone(v.thudFrom, v.thudTo, v.thudMs, v.thudGain, 'sine');
    this.noise(v.noiseMs, v.noiseGain, v.noiseHz, v.q);
    if (move === 'KICK') this.tone(70, 34, 320, 0.4, 'triangle');   // extra weight
  }

  /** blocked: bright metallic clang, no low body — the hit never reached them */
  block(){
    if (!this.ready('block', 30)) return;
    const pair = [1180, 1570];                     // detuned, slightly inharmonic
    for (const hz of pair) this.tone(hz, hz*0.86, 190, 0.16, 'square');
    this.noise(90, 0.22, 3200, 3.0, 'bandpass');
    this.tone(150, 90, 120, 0.2, 'sine');          // the shove behind the guard
  }

  /** whiffed attack: air only, no impact at all */
  whiff(){
    if (!this.ready('whiff', 60)) return;
    this.noise(220, 0.13, 900, 1.1, 'bandpass', 300);
  }

  jump(){
    if (!this.ready('jump', 80)) return;
    this.tone(280, 620, 160, 0.16, 'triangle');
  }

  /** the finish: everything drops an octave and the room shakes */
  ko(){
    if (!this.ready('ko', 400)) return;
    this.tone(180, 28, 900, 0.85, 'sine');
    this.tone(90, 20, 1200, 0.5, 'triangle');
    this.noise(420, 0.4, 700, 0.7, 'lowpass');
    setTimeout(() => this.ready('ko2', 0) && this.tone(120, 24, 1400, 0.4, 'sine'), 120);
  }

  /** round start: two rising bell tones */
  bell(){
    if (!this.ready('bell', 400)) return;
    this.tone(660, 655, 420, 0.22, 'triangle');
    setTimeout(() => { if (this.ctx && !this.muted) this.tone(990, 984, 620, 0.22, 'triangle'); }, 190);
  }

  /** time over, nobody knocked out */
  timeUp(){
    if (!this.ready('timeUp', 400)) return;
    this.tone(440, 436, 700, 0.2, 'sawtooth');
  }
}
