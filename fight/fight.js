/* Kombat — a two-fighter arena where each side is driven by a model decision.

   Same contract as the snake lab: one world, one tick, both fighters sensing the
   same shape of state and answering the same typed questions. A fight is a harsher
   latency test than the snake — blocking is a reaction problem, so a slow loop does
   not merely wander, it eats the hit. */
"use strict";

export const FCFG = {
  arenaW: 1200,
  groundY: 0.82,        // fraction of canvas height
  walkSpeed: 210,       // px/sec
  jumpV: 620,
  gravity: 1700,
  health: 100,
  roundMs: 90000,
  hurtRadius: 46,       // body half-width for hit detection
  // frame data in ms at timeScale 1; startup telegraphs the move, active can hit,
  // recovery is the punish window
  moves: {
    PUNCH: {startup: 130, active: 90,  recovery: 210, reach: 118, dmg: 7,  push: 46},
    KICK:  {startup: 240, active: 120, recovery: 360, reach: 168, dmg: 14, push: 96}
  },
  blockScale: 0.18,     // damage taken while blocking
  hitStun: 280,
  blockStun: 150
};

const ACTIONS = ['ADVANCE', 'RETREAT', 'PUNCH', 'KICK', 'BLOCK', 'JUMP'];

export class Fighter {
  constructor(side, opts = {}){
    this.side = side;                 // -1 = left fighter, +1 = right fighter
    this.name = opts.name || (side < 0 ? 'P1' : 'P2');
    this.palette = opts.palette || (side < 0
      ? {skin:'#f0c9a0', main:'#2f7f55', trim:'#5ef2a8', band:'#1b5a3a'}
      : {skin:'#e9c3a8', main:'#2f6f9f', trim:'#5ec8f2', band:'#1b4a6a'});
    this.reset(opts.x || 0);
  }

  reset(x){
    this.x = x; this.y = 0; this.vy = 0;
    this.facing = this.side < 0 ? 1 : -1;
    this.health = FCFG.health;
    this.state = 'idle';
    this.move = null;
    this.phase = null;        // 'startup' | 'active' | 'recovery'
    this.timer = 0;
    this.stun = 0;
    this.hitLanded = false;
    this.anim = 0;
    this.flash = 0;
    // per-round tallies the export reads
    this.stats = {thrown: 0, landed: 0, blocked: 0, whiffed: 0, taken: 0, dealt: 0, blocks: 0};
  }

  get airborne(){ return this.y < -1; }
  get busy(){ return this.state === 'attack' || this.state === 'hit' || this.airborne; }
  get canAct(){ return this.stun <= 0 && this.state !== 'hit' && this.state !== 'ko'; }

  startMove(kind, scale){
    if (!this.canAct || this.state === 'attack' || this.airborne) return false;
    const m = FCFG.moves[kind];
    if (!m) return false;
    this.state = 'attack'; this.move = kind; this.phase = 'startup';
    this.timer = m.startup * scale;
    this.hitLanded = false;
    this.stats.thrown++;
    return true;
  }
}

export class Ring {
  constructor(canvas, opts = {}){
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.onEvent = opts.onEvent || (() => {});
    this.timeScale = 1;
    this.running = false;
    this.over = false;
    this.winner = null;
    this.elapsed = 0;
    this.shake = 0;
    this.sparks = [];
    this.W = 0; this.H = 0; this.DPR = 1;
    this.left = new Fighter(-1, {name: opts.leftName, palette: opts.leftPalette});
    this.right = new Fighter(1, {name: opts.rightName, palette: opts.rightPalette});
    this.resize();
    this.reset();
  }

  resize(){
    const r = this.cv.getBoundingClientRect();
    this.DPR = Math.min(window.devicePixelRatio || 1, 2);
    this.W = Math.max(320, Math.round(r.width));
    this.H = Math.max(200, Math.round(r.height));
    this.cv.width = Math.round(this.W * this.DPR);
    this.cv.height = Math.round(this.H * this.DPR);
    this.ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
    this.buildBackdrop();
  }

  get ground(){ return this.H * FCFG.groundY; }
  get scale(){ return Math.min(1, this.W / FCFG.arenaW); }

  reset(){
    const inset = this.W * 0.26;
    this.left.reset(inset);
    this.right.reset(this.W - inset);
    this.elapsed = 0; this.over = false; this.winner = null;
    this.sparks = []; this.shake = 0;
  }

  start(){ this.reset(); this.running = true; this.onEvent('start', this); }

  /** pace the fight to the slower model: every attack must be slower to land than
      one round trip, or the other side physically cannot block it */
  setPacing(latencySec){
    const lat = Math.max(0.12, latencySec);
    // a kick's startup is the reaction window; give the slow side ~1.15 round trips
    this.timeScale = Math.max(1, (lat * 1150) / FCFG.moves.KICK.startup);
    return this.timeScale;
  }

  // ---------- state for the models ----------
  senseFor(who){
    const me = who === 'left' ? this.left : this.right;
    const foe = who === 'left' ? this.right : this.left;
    const gap = Math.abs(me.x - foe.x);
    const kick = FCFG.moves.KICK.reach * this.scale;
    const punch = FCFG.moves.PUNCH.reach * this.scale;
    const toWall = me.side < 0 ? me.x : this.W - me.x;
    return {
      me: {
        health: Math.round(me.health),
        state: me.state === 'attack' ? `throwing a ${me.move}` : me.state,
        can_act_now: me.canAct && me.state !== 'attack' && !me.airborne,
        distance_to_the_wall_behind_me: Math.round(toWall),
        cornered: toWall < 120
      },
      opponent: {
        health: Math.round(foe.health),
        state: foe.state === 'attack' ? `throwing a ${foe.move}` : foe.state,
        // what the opponent is doing RIGHT NOW is the whole basis for blocking
        is_winding_up_an_attack: foe.state === 'attack' && foe.phase === 'startup',
        is_attacking_now: foe.state === 'attack' && foe.phase === 'active',
        is_recovering_and_open: foe.state === 'attack' && foe.phase === 'recovery',
        is_blocking: foe.state === 'block',
        is_in_the_air: foe.airborne
      },
      spacing: {
        gap_px: Math.round(gap),
        my_punch_reaches_at_px: Math.round(punch),
        my_kick_reaches_at_px: Math.round(kick),
        punch_would_connect: gap <= punch,
        kick_would_connect: gap <= kick,
        too_far_to_hit: gap > kick
      },
      clock: {seconds_left: Math.max(0, Math.round((FCFG.roundMs - this.elapsed)/1000))}
    };
  }

  // ---------- simulation ----------
  step(dt, leftCmd, rightCmd){
    if (this.running && !this.over){
      this.elapsed += dt*1000;
      this.advance(this.left, this.right, leftCmd, dt);
      this.advance(this.right, this.left, rightCmd, dt);
      this.separate();
      if (this.elapsed >= FCFG.roundMs) this.finish('TIME');
    }
    this.draw(dt);
  }

  advance(me, foe, cmd, dt){
    const scale = this.timeScale;
    me.anim += dt;
    me.flash = Math.max(0, me.flash - dt*4);
    me.facing = foe.x > me.x ? 1 : -1;

    if (me.stun > 0){
      me.stun -= dt*1000;
      if (me.stun <= 0 && me.state === 'hit') me.state = 'idle';
    }

    // gravity
    if (me.airborne || me.vy !== 0){
      me.vy += FCFG.gravity * dt;
      me.y += me.vy * dt;
      if (me.y >= 0){ me.y = 0; me.vy = 0; if (me.state === 'jump') me.state = 'idle'; }
    }

    // attack timeline
    if (me.state === 'attack'){
      const m = FCFG.moves[me.move];
      me.timer -= dt*1000;
      if (me.timer <= 0){
        if (me.phase === 'startup'){ me.phase = 'active'; me.timer = m.active * scale; }
        else if (me.phase === 'active'){
          if (!me.hitLanded){
            me.stats.whiffed++;
            this.onEvent('whiff', this, {f: me, move: me.move});
          }
          me.phase = 'recovery'; me.timer = m.recovery * scale;
        }
        else { me.state = 'idle'; me.move = null; me.phase = null; }
      }
      if (me.phase === 'active' && !me.hitLanded) this.resolveHit(me, foe, m);
      return;                                  // committed: no movement mid-move
    }

    if (!me.canAct) return;
    const action = cmd && cmd.action;

    if (action === 'BLOCK'){ me.state = 'block'; return; }
    if (me.state === 'block') me.state = 'idle';

    if (action === 'PUNCH' || action === 'KICK'){
      if (cmd.fresh && me.startMove(action, scale)){
        cmd.fresh = false;
        this.onEvent('swing', this, {f: me, move: action});
        return;
      }
    }
    if (action === 'JUMP' && !me.airborne && cmd.fresh){
      cmd.fresh = false;
      me.vy = -FCFG.jumpV; me.y = -1; me.state = 'jump';
      this.onEvent('jump', this, {f: me});
      return;
    }
    if (action === 'ADVANCE' || action === 'RETREAT'){
      const dir = action === 'ADVANCE' ? me.facing : -me.facing;
      me.x += dir * FCFG.walkSpeed * this.scale * dt;
      me.x = Math.max(70, Math.min(this.W - 70, me.x));
      me.state = 'walk';
      return;
    }
    if (!me.airborne) me.state = 'idle';
  }

  resolveHit(me, foe, m){
    const gap = Math.abs(me.x - foe.x);
    if (gap > m.reach * this.scale) return;
    if (foe.airborne) return;                        // jumped it
    me.hitLanded = true;

    const blocking = foe.state === 'block' && foe.facing !== me.facing;
    const dmg = blocking ? m.dmg * FCFG.blockScale : m.dmg;
    foe.health = Math.max(0, foe.health - dmg);
    foe.x = Math.max(70, Math.min(this.W - 70, foe.x + me.facing * m.push * this.scale * (blocking ? 0.6 : 1)));
    foe.stun = (blocking ? FCFG.blockStun : FCFG.hitStun) * this.timeScale;
    foe.state = blocking ? 'block' : 'hit';
    foe.flash = 1;

    me.stats.dealt += dmg;
    foe.stats.taken += dmg;
    if (blocking){ me.stats.blocked++; foe.stats.blocks++; }
    else me.stats.landed++;

    this.shake = blocking ? 4 : 11;
    this.spark(foe.x - me.facing*30, this.ground - 96 - Math.random()*40,
      blocking ? '#9fd8ff' : '#ffd76b', blocking ? 10 : 22);
    this.onEvent(blocking ? 'block' : 'hit', this, {by: me, on: foe, dmg, move: me.move});

    if (foe.health <= 0){
      foe.state = 'ko';
      this.onEvent('ko', this, {by: me, on: foe});
      this.finish(me.side < 0 ? 'LEFT' : 'RIGHT');
    }
  }

  separate(){
    const minGap = 78 * this.scale;
    const gap = Math.abs(this.left.x - this.right.x);
    if (gap < minGap){
      const push = (minGap - gap)/2;
      this.left.x = Math.max(70, this.left.x - push);
      this.right.x = Math.min(this.W - 70, this.right.x + push);
    }
  }

  finish(reason){
    if (this.over) return;
    this.over = true; this.running = false;
    if (reason === 'TIME'){
      this.winner = this.left.health === this.right.health ? 'DRAW'
        : (this.left.health > this.right.health ? 'LEFT' : 'RIGHT');
      this.endReason = 'TIME — most health left';
    } else {
      this.winner = reason;
      this.endReason = 'K.O.';
    }
    this.onEvent('end', this);
  }

  spark(x, y, color, n){
    for (let i = 0; i < n; i++){
      const a = Math.random()*Math.PI*2, s = 60 + Math.random()*260;
      this.sparks.push({x, y, vx: Math.cos(a)*s, vy: Math.sin(a)*s - 60,
        life: 0.3 + Math.random()*0.4, r: 1.5 + Math.random()*3.5, color});
    }
  }

  // ---------- rendering ----------
  buildBackdrop(){
    const g = document.createElement('canvas');
    g.width = Math.round(this.W*this.DPR); g.height = Math.round(this.H*this.DPR);
    const x = g.getContext('2d');
    x.setTransform(this.DPR,0,0,this.DPR,0,0);
    const gy = this.ground;

    const sky = x.createLinearGradient(0,0,0,gy);
    sky.addColorStop(0,'#120b1c'); sky.addColorStop(0.6,'#1a1226'); sky.addColorStop(1,'#241a33');
    x.fillStyle = sky; x.fillRect(0,0,this.W,gy);

    // moon + distant pillars
    x.beginPath(); x.arc(this.W*0.78, gy*0.3, 54, 0, 7);
    x.fillStyle='rgba(255,236,196,0.16)'; x.fill();
    for (let i = 0; i < 9; i++){
      const px = (i+0.5)*(this.W/9), w = 46, h = gy*(0.34 + (i%3)*0.07);
      x.fillStyle = 'rgba(10,6,16,0.55)';
      x.fillRect(px - w/2, gy - h, w, h);
      x.fillStyle = 'rgba(255,190,120,0.05)';
      x.fillRect(px - w/2 + 10, gy - h + 20, 10, h - 40);
    }

    const floor = x.createLinearGradient(0, gy, 0, this.H);
    floor.addColorStop(0,'#2a2036'); floor.addColorStop(1,'#120c18');
    x.fillStyle = floor; x.fillRect(0, gy, this.W, this.H-gy);
    x.strokeStyle = 'rgba(255,215,107,0.16)'; x.lineWidth = 2;
    x.beginPath(); x.moveTo(0, gy); x.lineTo(this.W, gy); x.stroke();
    for (let i = 1; i < 14; i++){
      const t = i/14, px = this.W*t;
      x.strokeStyle = 'rgba(255,215,107,0.05)'; x.lineWidth = 1;
      x.beginPath(); x.moveTo(px, gy); x.lineTo(this.W*0.5 + (px-this.W*0.5)*2.4, this.H); x.stroke();
    }
    this.backdrop = g;
  }

  draw(dt){
    const ctx = this.ctx;
    ctx.save();
    if (this.shake > 0){
      ctx.translate((Math.random()-0.5)*this.shake, (Math.random()-0.5)*this.shake);
      this.shake = Math.max(0, this.shake - dt*46);
    }
    ctx.clearRect(-20,-20,this.W+40,this.H+40);
    if (this.backdrop) ctx.drawImage(this.backdrop, 0, 0, this.W, this.H);
    const order = this.left.x <= this.right.x ? [this.left, this.right] : [this.right, this.left];
    for (const f of order) this.drawFighter(f);
    this.drawSparks(dt);
    ctx.restore();
  }

  drawSparks(dt){
    const ctx = this.ctx;
    for (let i = this.sparks.length-1; i >= 0; i--){
      const p = this.sparks[i];
      p.x += p.vx*dt; p.y += p.vy*dt; p.vy += 900*dt; p.vx *= 0.94;
      p.life -= dt;
      if (p.life <= 0){ this.sparks.splice(i,1); continue; }
      ctx.globalAlpha = Math.max(0, p.life*2);
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** limb angles per state; everything is drawn from these so poses stay readable */
  poseOf(f){
    const t = f.anim;
    const bob = f.state === 'walk' ? Math.sin(t*11)*4 : Math.sin(t*2.2)*2;
    const p = {
      lean: 0, bob,
      armBack: -0.5, armFront: 0.6, foreBack: -1.0, foreFront: 1.1,
      legBack: 0.35, legFront: -0.3, kneeBack: 0.2, kneeFront: 0.25,
      guard: 0
    };
    if (f.state === 'block'){
      p.armBack = 1.5; p.armFront = 1.5; p.foreBack = -2.4; p.foreFront = -2.4;
      p.lean = -0.12; p.guard = 1;
    } else if (f.state === 'hit'){
      p.lean = -0.4; p.armFront = -1.4; p.armBack = -1.0; p.foreFront = -0.6;
    } else if (f.state === 'ko'){
      p.lean = -1.5; p.armFront = -2.2; p.armBack = -2.0; p.legFront = -1.1; p.legBack = 0.9;
    } else if (f.state === 'attack'){
      const m = FCFG.moves[f.move];
      const total = (f.phase === 'startup' ? m.startup : f.phase === 'active' ? m.active : m.recovery) * this.timeScale;
      const k = 1 - Math.max(0, Math.min(1, f.timer/total));       // 0..1 through the phase
      const ext = f.phase === 'startup' ? k*0.35 : f.phase === 'active' ? 1 : 1 - k;
      if (f.move === 'PUNCH'){
        p.armFront = -0.15 - ext*1.35; p.foreFront = -0.1 - ext*0.05;
        p.armBack = 1.1; p.foreBack = -1.6; p.lean = 0.12*ext;
      } else {
        p.legFront = -0.2 - ext*1.5; p.kneeFront = 0.6 - ext*0.55;
        p.armBack = -1.5; p.armFront = -0.4; p.foreBack = -0.8; p.lean = -0.25*ext;
      }
    } else if (f.state === 'walk'){
      p.legFront = Math.sin(t*11)*0.55; p.legBack = -Math.sin(t*11)*0.55;
      p.armFront = 0.5 + Math.sin(t*11)*0.35; p.armBack = -0.4 - Math.sin(t*11)*0.35;
    } else if (f.airborne){
      p.legFront = -0.9; p.legBack = 0.5; p.kneeFront = 1.1; p.armFront = -1.6; p.armBack = -1.2;
    }
    return p;
  }

  drawFighter(f){
    const ctx = this.ctx, pal = f.palette, s = this.scale;
    const gx = f.x, gy = this.ground + f.y;
    const p = this.poseOf(f);
    const U = 108 * s;                       // body unit: hip-to-shoulder height

    // ground shadow shrinks with height
    const lift = Math.max(0, -f.y);
    ctx.save();
    ctx.globalAlpha = 0.4 * (1 - Math.min(0.7, lift/320));
    ctx.beginPath();
    ctx.ellipse(gx, this.ground + 6, 54*s*(1 - Math.min(0.4, lift/500)), 12*s, 0, 0, 7);
    ctx.fillStyle = '#000'; ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.translate(gx, gy);
    ctx.scale(f.facing, 1);
    ctx.rotate(p.lean);
    ctx.translate(0, p.bob);

    const hip = {x: 0, y: -U*0.92};
    const sh  = {x: 0, y: -U*1.72};
    const limb = (a, b, w, color) => {
      ctx.strokeStyle = color; ctx.lineWidth = w; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    };
    const joint = (o, ang, len) => ({x: o.x + Math.sin(ang)*len, y: o.y + Math.cos(ang)*len});

    // back leg and arm first so they read as behind the torso
    const kneeB = joint(hip, p.legBack, U*0.52);
    const footB = joint(kneeB, p.legBack + p.kneeBack, U*0.52);
    limb(hip, kneeB, 26*s, shade(pal.main, -22));
    limb(kneeB, footB, 21*s, shade(pal.main, -22));
    this.boot(footB, s, shade(pal.band, -20));

    const elbB = joint(sh, p.armBack, U*0.46);
    const handB = joint(elbB, p.armBack + p.foreBack, U*0.44);
    limb(sh, elbB, 21*s, shade(pal.skin, -30));
    limb(elbB, handB, 18*s, shade(pal.skin, -30));
    this.fist(handB, s, shade(pal.band, -10));

    // torso
    ctx.beginPath();
    ctx.moveTo(-U*0.30, hip.y);
    ctx.lineTo(-U*0.40, sh.y + U*0.10);
    ctx.quadraticCurveTo(0, sh.y - U*0.12, U*0.40, sh.y + U*0.10);
    ctx.lineTo(U*0.30, hip.y);
    ctx.closePath();
    const tg = ctx.createLinearGradient(0, sh.y, 0, hip.y);
    tg.addColorStop(0, shade(pal.main, 18)); tg.addColorStop(1, shade(pal.main, -18));
    ctx.fillStyle = tg; ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 2; ctx.stroke();

    // belt
    ctx.fillStyle = pal.trim;
    ctx.fillRect(-U*0.32, hip.y - U*0.10, U*0.64, U*0.11);

    // front leg
    const kneeF = joint(hip, p.legFront, U*0.54);
    const footF = joint(kneeF, p.legFront + p.kneeFront, U*0.54);
    limb(hip, kneeF, 28*s, pal.main);
    limb(kneeF, footF, 22*s, pal.main);
    this.boot(footF, s, pal.band);

    // head
    const head = {x: 0, y: sh.y - U*0.30};
    ctx.beginPath(); ctx.ellipse(head.x, head.y, U*0.26, U*0.30, 0, 0, 7);
    ctx.fillStyle = pal.skin; ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = pal.trim;                                   // headband
    ctx.fillRect(-U*0.27, head.y - U*0.14, U*0.54, U*0.11);
    ctx.fillStyle = '#12151c';                                  // eye
    ctx.beginPath(); ctx.ellipse(U*0.11, head.y + U*0.02, U*0.045, U*0.055, 0, 0, 7); ctx.fill();

    // front arm last: it carries the punch
    const elbF = joint(sh, p.armFront, U*0.48);
    const handF = joint(elbF, p.armFront + p.foreFront, U*0.46);
    limb(sh, elbF, 23*s, pal.skin);
    limb(elbF, handF, 19*s, pal.skin);
    this.fist(handF, s, pal.band);

    // guard glow while blocking, impact flash when hit
    if (p.guard){
      ctx.strokeStyle = 'rgba(159,216,255,0.55)'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(U*0.30, sh.y + U*0.10, U*0.52, -1.3, 1.3); ctx.stroke();
    }
    if (f.flash > 0){
      ctx.globalAlpha = f.flash*0.55;
      ctx.fillStyle = '#ff6b6b';
      ctx.beginPath(); ctx.ellipse(0, sh.y + U*0.3, U*0.55, U*0.85, 0, 0, 7); ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  fist(pt, s, color){
    const ctx = this.ctx;
    ctx.beginPath(); ctx.arc(pt.x, pt.y, 13*s, 0, 7);
    ctx.fillStyle = color; ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1.5; ctx.stroke();
  }
  boot(pt, s, color){
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.ellipse(pt.x + 7*s, pt.y + 4*s, 18*s, 10*s, 0, 0, 7);
    ctx.fillStyle = color; ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1.5; ctx.stroke();
  }
}

function shade(hex, amt){
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, (n >> 16) + amt));
  const g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt));
  const b = Math.max(0, Math.min(255, (n & 255) + amt));
  return `rgb(${r},${g},${b})`;
}

export { ACTIONS };
