/* Endless runner — one track per model, same seeded obstacles on both.

   The world keeps speeding up. A model that answers fast but unsure and a model that
   answers sure but slow meet the same obstacles; whichever survives longer wins.
   The track is drawn in pseudo-3D (Subway Surfers style) straight onto a 2D canvas. */
"use strict";

export const RCFG = {
  startSpeed: 10,       // metres per second
  accel: 0.32,          // extra m/s every second
  maxSpeed: 42,
  laneSwitch: 0.22,     // seconds to slide one lane
  lookahead: 34,        // metres the runner "sees": what the model is told about
  firstRow: 45,         // metres before the first obstacle row
  gapMin: 16, gapMax: 28,
  roundSec: 120,
  lives: 3,             // a crash costs a life; the race lasts long enough to watch
  invuln: 1.4           // seconds of grace after a crash so one row can't take two lives
};

const LANES = [-1, 0, 1];
export const LANE_NAMES = {'-1': 'left', '0': 'middle', '1': 'right'};

export function mulberry32(seed){
  let a = seed >>> 0;
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export class Track {
  constructor(canvas, opts = {}){
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.accent = opts.accent || '#5ef2a8';
    this.onEvent = opts.onEvent || (() => {});
    this.controller = () => null;
    this.resize();
    this.reset(opts.seed || 7);
  }

  resize(){
    const r = this.cv.getBoundingClientRect();
    this.DPR = Math.min(window.devicePixelRatio || 1, 2);
    this.W = Math.max(200, Math.round(r.width)); this.H = Math.max(200, Math.round(r.height));
    this.cv.width = Math.round(this.W*this.DPR); this.cv.height = Math.round(this.H*this.DPR);
    this.ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
  }

  reset(seed){
    this.seed = seed;
    const rng = mulberry32(seed);
    // the whole course is generated up front from the seed: both tracks are identical
    this.rows = [];
    this.coins = [];
    let z = RCFG.firstRow;
    while (z < 6000){
      const n = rng() < 0.35 ? 2 : 1;                         // never block all three
      const lanes = LANES.slice().sort(() => rng() - 0.5).slice(0, n);
      const kind = rng() < 0.3 ? 'train' : 'barrier';
      this.rows.push({z, lanes, kind, len: kind === 'train' ? 9 : 1.2});
      const free = LANES.find(l => !lanes.includes(l));
      for (let k = 0; k < 4; k++) this.coins.push({z: z - 6 + k*3, lane: free, got: false});
      const tighten = Math.min(1, z / 3000);                // later rows come closer together
      z += RCFG.gapMax - (RCFG.gapMax - RCFG.gapMin)*tighten + rng()*6;
    }
    this.z = 0; this.speed = RCFG.startSpeed;
    this.lane = 0; this.laneX = 0; this.target = 0;
    this.alive = true; this.running = false;
    this.coinsGot = 0; this.t = 0; this.deathReason = '';
    this.lives = RCFG.lives; this.crashes = 0; this.grace = 0;
    this.anim = 0; this.shake = 0; this.flash = 0;
  }

  get distance(){ return Math.floor(this.z); }
  get score(){ return this.distance + this.coinsGot*10; }

  /** what the model is told: which lanes have something in the next `lookahead` metres */
  blockedAhead(){
    const out = {};
    for (const l of LANES) out[l] = null;
    for (const r of this.rows){
      const d = r.z - this.z;
      if (d + r.len < 0) continue;
      if (d > RCFG.lookahead) break;
      for (const l of r.lanes) if (out[l] === null) out[l] = Math.max(0, d);
    }
    return out;
  }

  sense(){
    const b = this.blockedAhead();
    const me = `I am in the ${LANE_NAMES[this.lane]} lane.`;
    const lanes = LANES.map(l => b[l] === null
      ? `The ${LANE_NAMES[l]} lane is empty.`
      : `There is a barrier in the ${LANE_NAMES[l]} lane.`).join(' ');
    return `${me} ${lanes}`;                                  // Laya-demo style plain text
  }

  step(dt){
    this.anim += dt;
    if (this.running && this.alive){
      this.t += dt;
      this.grace = Math.max(0, this.grace - dt);
      this.speed = Math.min(RCFG.maxSpeed, RCFG.startSpeed + RCFG.accel*this.t);
      this.z += this.speed*dt;

      const want = this.controller(this);
      if (want !== null && want !== undefined) this.target = want;
      // slide toward the target lane at a fixed rate, one lane at a time
      const dir = Math.sign(this.target - this.laneX);
      this.laneX += dir * dt / RCFG.laneSwitch;
      if ((dir > 0 && this.laneX > this.target) || (dir < 0 && this.laneX < this.target)) this.laneX = this.target;
      this.lane = Math.round(this.laneX);

      for (const c of this.coins){
        if (!c.got && Math.abs(c.z - this.z) < 0.8 && Math.abs(c.lane - this.laneX) < 0.4){
          c.got = true; this.coinsGot++; this.onEvent('coin', this);
        }
      }
      for (const r of this.rows){
        const d = r.z - this.z;
        if (d > 1) break;
        if (d + r.len < -0.5) continue;
        if (this.grace <= 0 && d <= 0.2 && d + r.len >= -0.2 && r.lanes.some(l => Math.abs(l - this.laneX) < 0.42)){
          this.crashes++; this.lives--;
          this.deathReason = r.kind === 'train' ? 'HIT A TRAIN' : 'HIT A BARRIER';
          this.shake = 1; this.flash = 1;
          if (this.lives <= 0){ this.alive = false; this.running = false; this.onEvent('crash', this); }
          else { this.grace = RCFG.invuln; this.onEvent('hit', this); }
          break;
        }
      }
    }
    this.draw(dt);
  }

  // ---------- rendering ----------
  proj(x, z){           // x in lanes, z metres ahead of the camera -> screen
    const hy = this.H*0.36, cz = z + 6;
    const s = 5.2 / cz;
    return {x: this.W/2 + x*this.W*0.34*s*1.25, y: hy + (this.H*0.95 - hy)*s*1.15, s};
  }

  draw(dt){
    const c = this.ctx, W = this.W, H = this.H, hy = H*0.36;
    c.save();
    if (this.shake > 0){ c.translate((Math.random()-.5)*14*this.shake, (Math.random()-.5)*10*this.shake); this.shake = Math.max(0, this.shake - dt*2); }

    // sky + skyline
    const sky = c.createLinearGradient(0, 0, 0, hy);
    sky.addColorStop(0, '#0d1b3a'); sky.addColorStop(1, '#3b2a5e');
    c.fillStyle = sky; c.fillRect(-20, -20, W+40, hy+20);
    c.fillStyle = 'rgba(255,200,120,0.18)';
    c.beginPath(); c.arc(W*0.8, hy*0.45, 34, 0, 7); c.fill();
    for (let i = 0; i < 14; i++){
      const bw = W/10, bx = ((i*bw*1.3 - this.z*0.6) % (W+bw*2) + W+bw*2) % (W+bw*2) - bw;
      const bh = hy*(0.25 + ((i*37)%10)/22);
      c.fillStyle = i % 2 ? '#1a1535' : '#221b44';
      c.fillRect(bx, hy - bh, bw*0.8, bh);
      c.fillStyle = 'rgba(255,214,120,0.25)';
      for (let wy = hy - bh + 8; wy < hy - 6; wy += 12) c.fillRect(bx + 6, wy, 4, 4);
    }

    // ground and track
    c.fillStyle = '#16122a'; c.fillRect(-20, hy, W+40, H-hy+20);
    const far = 90, L = this.proj(-1.6, far), R = this.proj(1.6, far), l0 = this.proj(-1.6, -5), r0 = this.proj(1.6, -5);
    c.fillStyle = '#2b2440';
    c.beginPath(); c.moveTo(L.x, L.y); c.lineTo(R.x, R.y); c.lineTo(r0.x, r0.y); c.lineTo(l0.x, l0.y); c.fill();
    // rail sleepers scroll with distance
    for (let k = 0; k < 40; k++){
      const z = k*2.5 - (this.z % 2.5);
      if (z < -5 || z > far) continue;
      const a = this.proj(-1.55, z), b = this.proj(1.55, z);
      c.strokeStyle = `rgba(120,100,160,${0.5 - z/far*0.45})`; c.lineWidth = Math.max(1, 6*a.s);
      c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
    }
    for (const lx of [-0.5, 0.5]){
      const a = this.proj(lx, far), b = this.proj(lx, -5);
      c.strokeStyle = 'rgba(255,255,255,0.16)'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
    }

    // obstacles and coins, far to near
    const items = [];
    for (const r of this.rows){
      const d = r.z - this.z;
      if (d > far) break;
      if (d + r.len < -4) continue;
      for (const l of r.lanes) items.push({d, l, r});
    }
    for (const co of this.coins){
      const d = co.z - this.z;
      if (!co.got && d > -2 && d < far) items.push({d, l: co.lane, coin: true});
    }
    items.sort((a, b) => b.d - a.d);
    for (const it of items){
      if (it.coin){
        const p = this.proj(it.l, it.d), rr = Math.max(2, 26*p.s*1.2);
        c.fillStyle = '#ffd76b'; c.beginPath();
        c.ellipse(p.x, p.y - rr*2.2, rr*Math.abs(Math.cos(this.anim*6)) + 1, rr, 0, 0, 7); c.fill();
        continue;
      }
      this.drawBlock(it.l, it.d, it.r);
    }

    this.drawRunner();

    if (this.flash > 0){
      c.fillStyle = `rgba(255,90,90,${this.flash*0.45})`; c.fillRect(-20, -20, W+40, H+40);
      this.flash = Math.max(0, this.flash - dt*1.5);
    }
    // speed lines
    if (this.running){
      c.strokeStyle = 'rgba(255,255,255,0.07)'; c.lineWidth = 2;
      for (let i = 0; i < Math.round(this.speed/3); i++){
        const a = (i*97 + this.anim*400) % 360 * Math.PI/180;
        const r1 = W*0.35 + ((i*53 + this.anim*900) % 300);
        c.beginPath(); c.moveTo(W/2 + Math.cos(a)*r1, hy + Math.sin(a)*r1*0.6);
        c.lineTo(W/2 + Math.cos(a)*(r1+60), hy + Math.sin(a)*(r1+60)*0.6); c.stroke();
      }
    }
    c.restore();
  }

  drawBlock(lane, d, r){
    const c = this.ctx;
    const near = Math.max(d, 0.4), farZ = d + r.len;
    if (farZ <= near) return;
    const h = r.kind === 'train' ? 2.6 : 1.1;
    const f1 = this.proj(lane - 0.42, near), f2 = this.proj(lane + 0.42, near);
    const b1 = this.proj(lane - 0.42, farZ), b2 = this.proj(lane + 0.42, farZ);
    const hf = h * 90 * f1.s, hb = h * 90 * b1.s;
    const top = r.kind === 'train' ? '#3c6fd1' : '#e0513f';
    const face = r.kind === 'train' ? '#2a4f9e' : '#b83a2c';
    // roof
    c.fillStyle = top; c.beginPath();
    c.moveTo(f1.x, f1.y - hf); c.lineTo(f2.x, f2.y - hf); c.lineTo(b2.x, b2.y - hb); c.lineTo(b1.x, b1.y - hb); c.fill();
    // side toward the centre, for depth
    const side = lane <= 0 ? [f2, b2] : [f1, b1];
    c.fillStyle = r.kind === 'train' ? '#22427f' : '#8f2d22';
    c.beginPath(); c.moveTo(side[0].x, side[0].y); c.lineTo(side[1].x, side[1].y);
    c.lineTo(side[1].x, side[1].y - hb); c.lineTo(side[0].x, side[0].y - hf); c.fill();
    // front face
    c.fillStyle = face; c.fillRect(f1.x, f1.y - hf, f2.x - f1.x, hf);
    c.fillStyle = 'rgba(255,255,255,0.85)';
    if (r.kind === 'barrier'){
      const stripes = 4, w = (f2.x - f1.x)/stripes;
      for (let i = 0; i < stripes; i += 2) c.fillRect(f1.x + i*w, f1.y - hf*0.72, w, hf*0.22);
    } else {
      c.fillStyle = '#ffe9a3';
      c.fillRect(f1.x + (f2.x-f1.x)*0.15, f1.y - hf*0.8, (f2.x-f1.x)*0.25, hf*0.2);
      c.fillRect(f1.x + (f2.x-f1.x)*0.6, f1.y - hf*0.8, (f2.x-f1.x)*0.25, hf*0.2);
    }
  }

  drawRunner(){
    if (this.grace > 0 && Math.floor(this.grace*12) % 2) return;     // blink while invulnerable
    const c = this.ctx, p = this.proj(this.laneX, 0.6), s = p.s*95;
    const run = this.alive && this.running ? this.anim*14 : 0;
    const bob = Math.abs(Math.sin(run))*s*0.12;
    const x = p.x, y = p.y - bob;
    c.save(); c.translate(x, y);
    if (!this.alive){ c.rotate(-1.2); }
    c.fillStyle = 'rgba(0,0,0,0.35)'; c.beginPath(); c.ellipse(0, bob, s*0.5, s*0.12, 0, 0, 7); c.fill();
    c.lineCap = 'round';
    const leg = (a, col) => { c.strokeStyle = col; c.lineWidth = s*0.16;
      c.beginPath(); c.moveTo(0, -s*0.9); c.lineTo(Math.sin(a)*s*0.35, -s*0.45); c.lineTo(Math.sin(a)*s*0.25, 0); c.stroke(); };
    leg(Math.sin(run), '#243a5e'); leg(-Math.sin(run), '#2f4c7a');
    c.fillStyle = this.accent;                                  // jersey in the model's colour
    c.beginPath(); c.roundRect(-s*0.24, -s*1.55, s*0.48, s*0.72, s*0.12); c.fill();
    c.strokeStyle = '#f1c9a5'; c.lineWidth = s*0.12;
    c.beginPath(); c.moveTo(-s*0.2, -s*1.4); c.lineTo(-s*0.36 - Math.sin(run)*s*0.2, -s*1.05); c.stroke();
    c.beginPath(); c.moveTo(s*0.2, -s*1.4); c.lineTo(s*0.36 + Math.sin(run)*s*0.2, -s*1.05); c.stroke();
    c.fillStyle = '#f1c9a5'; c.beginPath(); c.arc(0, -s*1.78, s*0.2, 0, 7); c.fill();
    c.fillStyle = '#20182e'; c.beginPath(); c.arc(0, -s*1.84, s*0.2, Math.PI, 0); c.fill();   // cap
    c.restore();
  }
}
