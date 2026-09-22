/* Flappy — one sky per model, same seeded pipes on both.

   Flapping is a reflex: in testing, even a perfect bird that sees the world 0.3 s late
   dies within seconds, so no model behind a network or a Python server can flap by
   itself. The split is the same as every other game in the lab: the MODEL reads where
   the next gap is (top / middle / bottom), and CODE flies the bird there at 60 fps.
   The world speeds up, so the gap between pipes shrinks — whoever reads each new pipe
   sooner has more time to line up. */
"use strict";

export const FCFG = {
  H: 600,                 // virtual world height; everything scales to the canvas
  gravity: 1100, flap: -360, flapCooldown: 0.2,
  // tuned by simulating a perfect bird that reads the gap late: at these numbers a 0.4 s
  // reader matches a zero-delay one (~60 pipes) and a 1.3 s reader falls behind (~20)
  startSpeed: 120, accel: 2, maxSpeed: 360,
  spacing: 480, pipeW: 80, gap: 170,
  bandY: [150, 300, 450],  // gap centres: top, middle, bottom
  firstPipe: 520,
  lives: 3, invuln: 1.2, roundSec: 120
};
export const BAND_NAMES = ['top', 'middle', 'bottom'];
const BAND_WORDS = ['near the top', 'in the middle', 'near the bottom'];

export function mulberry32(seed){
  let a = seed >>> 0;
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

export class Sky {
  constructor(canvas, opts = {}){
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.body = opts.body || '#5ef2a8';
    this.onEvent = opts.onEvent || (() => {});
    this.controller = () => null;          // returns the believed band (0,1,2) or null
    this.manual = false;                   // a human flaps directly: controller returns 'flap'
    this.resize(); this.reset(opts.seed || 7);
  }

  resize(){
    const r = this.cv.getBoundingClientRect();
    this.DPR = Math.min(window.devicePixelRatio || 1, 2);
    this.W = Math.max(200, Math.round(r.width)); this.Hpx = Math.max(200, Math.round(r.height));
    this.cv.width = Math.round(this.W*this.DPR); this.cv.height = Math.round(this.Hpx*this.DPR);
    this.k = this.Hpx / FCFG.H;              // virtual units -> pixels
    this.ctx.setTransform(this.DPR*this.k, 0, 0, this.DPR*this.k, 0, 0);
    this.VW = this.W / this.k;               // visible world width in virtual units
  }

  reset(seed){
    const rng = mulberry32(seed);
    this.pipes = [];
    let band = 1;
    for (let i = 0; i < 400; i++){
      // gaps move at most one band per pipe: top straight to bottom is a climb the bird
      // can't physically make once the world is fast
      const r = rng();
      band = r < 0.2 ? band : (band === 1 ? (r < 0.6 ? 0 : 2) : 1);
      this.pipes.push({x: FCFG.firstPipe + i*FCFG.spacing, band, passed: false});
    }
    this.x = 0; this.y = FCFG.H/2; this.vy = 0; this.speed = FCFG.startSpeed;
    this.t = 0; this.cool = 0; this.wing = 0;
    this.lives = FCFG.lives; this.grace = 0; this.crashes = 0; this.passed = 0;
    this.alive = true; this.running = false; this.flash = 0; this.shake = 0; this.target = 1;
    this.deathReason = '';
  }

  get birdX(){ return this.x + this.VW*0.3; }
  nextPipe(){ return this.pipes.find(p => p.x + FCFG.pipeW > this.birdX - 14); }

  /** what the model is told: only where the next gap is. In testing, a sentence that also
      said where the BIRD is made Laya answer with the bird's position instead (0/6). */
  sense(){
    const p = this.nextPipe();
    return `The next gap is ${BAND_WORDS[p.band]} of the screen.`;
  }

  step(dt){
    this.wing += dt;
    if (this.running && this.alive){
      this.t += dt;
      this.speed = Math.min(FCFG.maxSpeed, FCFG.startSpeed + FCFG.accel*this.t);
      this.x += this.speed*dt;
      this.grace = Math.max(0, this.grace - dt);

      const belief = this.controller(this);
      this.cool -= dt;
      if (this.manual){
        // a person plays real Flappy: every tap is a flap, no autopilot
        if (belief === 'flap'){ this.vy = FCFG.flap; this.wing = 0; }
      } else {
        if (belief !== null && belief !== undefined) this.target = belief;
        // autopilot: hold the believed gap's centre with short flaps
        const ty = FCFG.bandY[this.target];
        if (this.y > ty + 8 && this.vy >= 0 && this.cool <= 0){ this.vy = FCFG.flap; this.cool = FCFG.flapCooldown; this.wing = 0; }
      }
      this.vy += FCFG.gravity*dt; this.y += this.vy*dt;

      if (this.y < 14){ this.y = 14; this.vy = Math.max(0, this.vy); }
      for (const p of this.pipes){
        if (p.x > this.birdX + 20) break;
        if (!p.passed && p.x + FCFG.pipeW < this.birdX - 14){ p.passed = true; this.passed++; this.onEvent('pass', this); }
      }
      const p = this.nextPipe();
      const inPipe = this.birdX + 14 > p.x && this.birdX - 14 < p.x + FCFG.pipeW;
      const gy = FCFG.bandY[p.band];
      const hitPipe = inPipe && Math.abs(this.y - gy) > FCFG.gap/2 - 14;
      const hitGround = this.y > FCFG.H - 40;
      if ((hitPipe || hitGround) && this.grace <= 0){
        this.crashes++; this.lives--; this.flash = 1; this.shake = 1;
        this.deathReason = hitGround ? 'HIT THE GROUND' : 'HIT A PIPE';
        if (this.lives <= 0){ this.alive = false; this.running = false; this.onEvent('crash', this); }
        else { this.grace = FCFG.invuln; this.vy = FCFG.flap; this.onEvent('hit', this); }
      }
      if (hitGround) { this.y = FCFG.H - 41; this.vy = Math.min(this.vy, FCFG.flap); }
    }
    this.draw(dt);
  }

  draw(dt){
    const c = this.ctx, VW = this.VW, H = FCFG.H;
    c.save();
    if (this.shake > 0){ c.translate((Math.random()-.5)*10*this.shake, (Math.random()-.5)*8*this.shake); this.shake = Math.max(0, this.shake - dt*2.5); }
    const sky = c.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#4fb7e8'); sky.addColorStop(0.7, '#a6e3f5'); sky.addColorStop(1, '#d9f3f8');
    c.fillStyle = sky; c.fillRect(-20, -20, VW + 40, H + 40);
    // clouds and hills scroll slower than the pipes: depth for free
    c.fillStyle = 'rgba(255,255,255,0.8)';
    for (let i = 0; i < 6; i++){
      const cx = ((i*260 - this.x*0.15) % (VW + 300) + VW + 300) % (VW + 300) - 150, cy = 70 + (i*53)%120;
      c.beginPath(); c.arc(cx, cy, 26, 0, 7); c.arc(cx+28, cy-10, 32, 0, 7); c.arc(cx+62, cy, 24, 0, 7); c.fill();
    }
    c.fillStyle = '#8fd07c';
    for (let i = 0; i < 8; i++){
      const hx = ((i*220 - this.x*0.35) % (VW + 440) + VW + 440) % (VW + 440) - 220;
      c.beginPath(); c.ellipse(hx, H - 40, 170, 90, 0, Math.PI, 0); c.fill();
    }
    // pipes
    for (const p of this.pipes){
      const sx = p.x - this.x;
      if (sx > VW + 20) break;
      if (sx + FCFG.pipeW < -20) continue;
      const gy = FCFG.bandY[p.band], top = gy - FCFG.gap/2, bot = gy + FCFG.gap/2;
      const g = c.createLinearGradient(sx, 0, sx + FCFG.pipeW, 0);
      g.addColorStop(0, '#3f9b2f'); g.addColorStop(0.45, '#7fd35a'); g.addColorStop(1, '#2f7a22');
      c.fillStyle = g; c.strokeStyle = '#1d4d15'; c.lineWidth = 3;
      c.fillRect(sx, -10, FCFG.pipeW, top + 10); c.strokeRect(sx, -10, FCFG.pipeW, top + 10);
      c.fillRect(sx, bot, FCFG.pipeW, H - bot); c.strokeRect(sx, bot, FCFG.pipeW, H - bot);
      c.fillRect(sx - 6, top - 26, FCFG.pipeW + 12, 26); c.strokeRect(sx - 6, top - 26, FCFG.pipeW + 12, 26);
      c.fillRect(sx - 6, bot, FCFG.pipeW + 12, 26); c.strokeRect(sx - 6, bot, FCFG.pipeW + 12, 26);
    }
    // ground
    c.fillStyle = '#dcc57a'; c.fillRect(-20, H - 40, VW + 40, 60);
    c.fillStyle = '#7ec04f'; c.fillRect(-20, H - 44, VW + 40, 8);
    c.strokeStyle = 'rgba(120,90,40,0.35)'; c.lineWidth = 3;
    for (let i = 0; i < VW/24 + 2; i++){ const gx = i*24 - (this.x % 24); c.beginPath(); c.moveTo(gx, H - 30); c.lineTo(gx + 12, H - 14); c.stroke(); }

    // the believed gap: a faint band, so viewers can see what the model thinks
    if (!this.manual && (this.running || !this.alive)){
      const ty = FCFG.bandY[this.target];
      c.fillStyle = 'rgba(255,255,255,0.10)'; c.fillRect(-10, ty - 10, VW + 20, 20);
    }
    this.drawBird();
    if (this.flash > 0){ c.fillStyle = `rgba(255,255,255,${this.flash*0.7})`; c.fillRect(-20, -20, VW + 40, H + 40); this.flash = Math.max(0, this.flash - dt*3); }
    c.restore();
  }

  drawBird(){
    if (this.grace > 0 && Math.floor(this.grace*12) % 2) return;
    const c = this.ctx;                                              // the bird sits at a fixed screen x
    const bx = this.VW*0.3, by = this.y;
    const tilt = Math.max(-0.5, Math.min(1.2, this.vy/500));
    c.save(); c.translate(bx, by); c.rotate(this.alive ? tilt : 1.4);
    c.fillStyle = this.body; c.strokeStyle = '#1b2430'; c.lineWidth = 2.5;
    c.beginPath(); c.ellipse(0, 0, 20, 16, 0, 0, 7); c.fill(); c.stroke();
    c.fillStyle = 'rgba(255,255,255,0.35)'; c.beginPath(); c.ellipse(-4, 5, 12, 7, 0, 0, 7); c.fill();
    const flapUp = this.wing < 0.12;                                  // wing snaps up on a flap
    c.fillStyle = '#f5f5f5'; c.beginPath(); c.ellipse(-6, flapUp ? -8 : 2, 11, 7, flapUp ? -0.6 : 0.3, 0, 7); c.fill(); c.stroke();
    c.fillStyle = '#fff'; c.beginPath(); c.arc(9, -6, 6, 0, 7); c.fill(); c.stroke();
    c.fillStyle = '#111'; c.beginPath(); c.arc(11, -6, 2.6, 0, 7); c.fill();
    c.fillStyle = '#ff8a3c'; c.beginPath(); c.moveTo(16, -1); c.lineTo(29, 3); c.lineTo(16, 8); c.closePath(); c.fill(); c.stroke();
    c.restore();
  }
}
