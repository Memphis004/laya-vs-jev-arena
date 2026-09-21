/* Viper — arena engine + realistic snake renderer.
   One Arena owns one canvas, one snake, its own apples and its own loop state.
   Steering comes from a pluggable controller: keyboard for the human, Jev for the AI. */
"use strict";

export const CFG = {
  speed: 150,
  sprint: 240,
  turn: 3.2,          // rad/sec at full steer
  spacing: 4.6,       // px between spine points
  startLen: 95,
  growPx: 36,         // how much LONGER the snake gets per apple, in pixels
  headR: 18,
  bodyR: 17,
  apples: 3,
  rayMax: 420,
  get growPer(){ return Math.max(1, Math.round(this.growPx / this.spacing)); },
  passThroughSelf: true,   // the snake glides over its own body
  wrapWalls: true          // leaving one edge brings the snake back on the opposite edge
};

/** shortest signed distance on a wrapping axis: in a 1000px arena, going from x=950
    to x=50 is +100 through the edge, not -900 across the middle */
function wrapDelta(d, size){
  if (!CFG.wrapWalls) return d;
  d = ((d % size) + size) % size;
  return d > size/2 ? d - size : d;
}

const TAU = Math.PI * 2;

/** deterministic PRNG so both arenas can run the same apple sequence from one seed */
export function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export class Arena {
  constructor(canvas, opts = {}){
    this.cv = canvas;
    this.seed = opts.seed || 2026;
    this.rng = mulberry32(this.seed);
    this.ctx = canvas.getContext('2d');
    this.hue = opts.hue || 'green';
    this.controller = opts.controller || (() => ({steer: 0, sprint: false}));
    this.onEvent = opts.onEvent || (() => {});
    this.W = 0; this.H = 0; this.DPR = 1;
    this.ground = null;
    this.tick = 0;
    this.running = false;
    this.baseSpeed = CFG.speed;
    this.sprintSpeed = CFG.sprint;
    this.turnRate = CFG.turn;
    this.dead = false;
    this.deathReason = '';
    this.score = 0;
    this.resize();
  }

  // ---------- palette ----------
  get pal(){
    return this.hue === 'cyan' ? {
      bodyTop:'#2f6f9f', bodyBot:'#12293d', rim:'150,220,255', dark:'6,26,44',
      headTop:'#3d86b8', headMid:'#2b6c98', headBot:'#123047', eye:'#7fe9ff',
      ground:['#131f2a','#0c1620','#060c12'], blade:'90,160,200'
    } : {
      bodyTop:'#2f7f55', bodyBot:'#143d2a', rim:'150,240,185', dark:'8,40,26',
      headTop:'#3d9a67', headMid:'#2c7c52', headBot:'#123d28', eye:'#f6d64a',
      ground:['#12281f','#0c1c16','#060f0c'], blade:'80,190,110'
    };
  }

  // ---------- sizing ----------
  resize(){
    const r = this.cv.getBoundingClientRect();
    this.DPR = Math.min(window.devicePixelRatio || 1, 2);
    this.W = Math.max(60, Math.round(r.width));
    this.H = Math.max(60, Math.round(r.height));
    this.cv.width = Math.round(this.W * this.DPR);
    this.cv.height = Math.round(this.H * this.DPR);
    this.ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
    this.buildGround();
  }

  buildGround(){
    const {W, H, DPR, pal} = this;
    const g = document.createElement('canvas');
    g.width = Math.round(W*DPR); g.height = Math.round(H*DPR);
    const x = g.getContext('2d');
    x.setTransform(DPR,0,0,DPR,0,0);

    const grad = x.createRadialGradient(W/2, H*0.42, 40, W/2, H*0.5, Math.max(W,H)*0.8);
    grad.addColorStop(0, pal.ground[0]);
    grad.addColorStop(0.55, pal.ground[1]);
    grad.addColorStop(1, pal.ground[2]);
    x.fillStyle = grad; x.fillRect(0,0,W,H);

    for (let i = 0; i < Math.round(W*H/1100); i++){
      x.fillStyle = `rgba(${160+Math.random()*60|0},${190+Math.random()*50|0},${180+Math.random()*50|0},${Math.random()*0.045})`;
      x.beginPath(); x.arc(Math.random()*W, Math.random()*H, Math.random()*1.5+.2, 0, TAU); x.fill();
    }
    for (let i = 0; i < Math.round(W*H/2800); i++){
      const px = Math.random()*W, py = Math.random()*H, h = 6+Math.random()*15, lean = (Math.random()-.5)*8;
      x.strokeStyle = `rgba(${pal.blade},${0.05+Math.random()*0.06})`;
      x.lineWidth = 1+Math.random(); x.lineCap = 'round';
      x.beginPath(); x.moveTo(px,py);
      x.quadraticCurveTo(px+lean*.4, py-h*.6, px+lean, py-h); x.stroke();
    }
    const v = x.createRadialGradient(W/2,H/2,Math.min(W,H)*0.28,W/2,H/2,Math.max(W,H)*0.75);
    v.addColorStop(0,'rgba(0,0,0,0)'); v.addColorStop(1,'rgba(0,0,0,0.55)');
    x.fillStyle = v; x.fillRect(0,0,W,H);
    this.ground = g;
  }

  // ---------- lifecycle ----------
  reset(seed){
    if (seed !== undefined) this.seed = seed;
    this.rng = mulberry32(this.seed);
    this.tick = 0;
    // spawn in the left third heading east, with a tail short enough to fit the arena
    const cx = Math.max(CFG.headR*2, this.W*0.34), cy = this.H/2;
    const fits = Math.floor((cx - CFG.headR) / CFG.spacing);
    const len = Math.max(24, Math.min(CFG.startLen, fits));
    this.snake = {ang: 0, targetGrow: 0, spine: [], speed: this.baseSpeed, tongue: 0, blink: 0, sprinting: false};
    for (let i = 0; i < len; i++)
      this.snake.spine.push({x: cx - i*CFG.spacing, y: cy});
    this.apples = []; this.particles = [];
    this.score = 0; this.dead = false; this.deathReason = '';
    for (let i = 0; i < CFG.apples; i++) this.apples.push(this.spawnApple());
  }

  start(seed){
    this.reset(seed);
    this.running = true;
    this.startedAt = performance.now();
    this.survivedMs = 0;
    this.onEvent('start', this);
  }

  kill(reason){
    if (this.dead) return;
    this.dead = true; this.running = false; this.deathReason = reason;
    this.survivedMs = performance.now() - (this.startedAt || performance.now());
    this.burst(this.snake.spine[0].x, this.snake.spine[0].y, '#9ef0c4', 40);
    this.onEvent('death', this);
  }

  spawnApple(){
    const m = 48;
    for (let t = 0; t < 60; t++){
      const p = {x: m + this.rng()*(this.W-2*m), y: m + this.rng()*(this.H-2*m), born: this.tick, r: 15};
      let ok = true;
      for (let i = 0; i < this.snake.spine.length; i += 4){
        const s = this.snake.spine[i];
        if (Math.hypot(wrapDelta(s.x-p.x, this.W), wrapDelta(s.y-p.y, this.H)) < 70){ ok = false; break; }
      }
      if (ok) return p;
    }
    return {x: m + this.rng()*(this.W-2*m), y: m + this.rng()*(this.H-2*m), born: this.tick, r: 15};
  }

  /** Pace the world to the controller's latency, in BOTH axes.

      Distance: one decision moves the snake at most `fraction` of the short side.
      Heading: one decision turns the snake at most `maxTurnRad`. Scaling only the
      speed leaves a snake that can spin a full circle between two answers, which
      traps a slow controller in a fixed-radius orbit around the apple: it aims,
      the answer lands tens of degrees later, it aims again, forever. */
  setPacing(latencySec, fraction = 0.15, turnRadius = 34, maxTurnRad = 1.5){
    const lat = Math.max(0.3, latencySec);
    const span = Math.min(this.W, this.H);
    this.baseSpeed = Math.max(45, Math.min(CFG.speed, span * fraction / lat));
    this.sprintSpeed = this.baseSpeed * 1.6;
    // Two limits on turning, and the snake takes the tighter-turning one that is safe:
    //  - tight enough to reach an apple beside it: a turn radius near 34px. At a 139px
    //    radius every apple inside that circle is unreachable and even a perfect
    //    controller orbits it (measured: 2.5 apples/min).
    //  - loose enough that one round trip of the slower model turns it at most ~85°,
    //    or a stale answer spins it past the apple (2.2 rad/s at 1s latency: 0.1/min).
    this.turnRate = Math.min(CFG.turn, this.baseSpeed / turnRadius, maxTurnRad / lat);
    return this.baseSpeed;
  }

  get length(){ return this.snake ? this.snake.spine.length : 0; }
  get head(){ return this.snake.spine[0]; }

  // ---------- sensing (shared by AI controller) ----------
  /** distance until something that can kill blocks a ray leaving the head at `ang`.
      With `passThroughSelf` the body is not an obstacle, so only walls block. */
  raycast(ang, skipSegments){
    const h = this.head, step = 9, max = CFG.rayMax;
    const dx = Math.cos(ang), dy = Math.sin(ang);
    const sp = this.snake.spine;
    for (let d = step; d <= max; d += step){
      const x = h.x + dx*d, y = h.y + dy*d;
      if (x < 2 || y < 2 || x > this.W-2 || y > this.H-2) return d;
      if (CFG.passThroughSelf) continue;
      for (let i = skipSegments; i < sp.length; i += 3){
        const p = sp[i];
        const r = CFG.bodyR * 0.9;
        if ((x-p.x)**2 + (y-p.y)**2 < r*r) return d;
      }
    }
    return max;
  }

  nearestApple(){
    const h = this.head;
    let best = null, bd = Infinity;
    for (const a of this.apples){
      const d = Math.hypot(wrapDelta(a.x-h.x, this.W), wrapDelta(a.y-h.y, this.H));
      if (d < bd){ bd = d; best = a; }
    }
    return {apple: best, dist: bd};
  }

  /** compact, human-readable world snapshot for a language-driven controller */
  sense(){
    if (CFG.wrapWalls) return this.senseWrapped();
    const h = this.head, ang = this.snake.ang;
    const skip = Math.ceil(CFG.headR*2.6 / CFG.spacing) + 10;
    const offsets = [-90, -60, -30, 0, 30, 60, 90];
    const clearance = {};
    for (const o of offsets){
      const key = o === 0 ? 'ahead' : `${Math.abs(o)}deg_${o < 0 ? 'left' : 'right'}`;
      clearance[key] = Math.round(this.raycast(ang + o*Math.PI/180, skip));
    }
    const {apple, dist} = this.nearestApple();
    let bearing = 0;
    if (apple){
      bearing = Math.atan2(apple.y-h.y, apple.x-h.x) - ang;
      while (bearing > Math.PI) bearing -= TAU;
      while (bearing < -Math.PI) bearing += TAU;
    }
    const deg = Math.round(bearing*180/Math.PI);
    return {
      arena: {width: this.W, height: this.H},
      snake: {
        length_px: Math.round(this.length * CFG.spacing),
        speed_px_per_sec: Math.round(this.snake.speed),
        distance_to_left_wall: Math.round(h.x),
        distance_to_right_wall: Math.round(this.W - h.x),
        distance_to_top_wall: Math.round(h.y),
        distance_to_bottom_wall: Math.round(this.H - h.y)
      },
      // how far the snake can travel that way before hitting a wall; the snake passes
      // harmlessly over its own body, so only walls are obstacles
      clearance_px: clearance,
      nearest_apple: apple ? {
        distance_px: Math.round(dist),
        direction: deg === 0 ? 'dead ahead'
          : `${Math.abs(deg)} degrees to the ${deg < 0 ? 'left' : 'right'} of the current heading`,
        bearing_degrees: deg,
        is_behind_the_snake: Math.abs(deg) > 100,
        side: deg < -5 ? 'left' : deg > 5 ? 'right' : 'straight ahead'
      } : null
    };
  }

  /** State for a wrapping arena. Nothing can kill the snake here, so wall distances and
      clearance rays would only be noise; what matters is where the apple is by the
      SHORTEST route, which may run out one edge and in the opposite one. */
  senseWrapped(){
    const h = this.head, ang = this.snake.ang;
    const {apple, dist} = this.nearestApple();
    let deg = 0, throughEdge = false;
    if (apple){
      const dx = wrapDelta(apple.x - h.x, this.W), dy = wrapDelta(apple.y - h.y, this.H);
      throughEdge = Math.abs(dx - (apple.x - h.x)) > 1 || Math.abs(dy - (apple.y - h.y)) > 1;
      let b = Math.atan2(dy, dx) - ang;
      while (b > Math.PI) b -= TAU;
      while (b < -Math.PI) b += TAU;
      deg = Math.round(b*180/Math.PI);
    }
    return {
      arena: {width: this.W, height: this.H,
              edges: 'wrap around: leaving one edge re-enters from the opposite edge'},
      snake: {length_px: Math.round(this.length * CFG.spacing),
              speed_px_per_sec: Math.round(this.snake.speed)},
      nearest_apple: apple ? {
        distance_px: Math.round(dist),
        direction: deg === 0 ? 'dead ahead'
          : `${Math.abs(deg)} degrees to the ${deg < 0 ? 'left' : 'right'} of the current heading`,
        bearing_degrees: deg,
        is_behind_the_snake: Math.abs(deg) > 100,
        side: deg < -5 ? 'left' : deg > 5 ? 'right' : 'straight ahead',
        shortest_route_goes_through_an_edge: throughEdge
      } : null
    };
  }

  // ---------- simulation ----------
  update(dt, steer, sprint){
    const s = this.snake;
    s.ang += Math.max(-1, Math.min(1, steer)) * this.turnRate * dt;
    s.sprinting = !!sprint;
    const target = sprint ? this.sprintSpeed : this.baseSpeed;
    s.speed += (target - s.speed) * Math.min(1, dt*6);

    const ang = s.ang + Math.sin(this.tick*0.11)*0.15;   // natural slither
    const head = s.spine[0];
    const nx = head.x + Math.cos(ang)*s.speed*dt;
    const ny = head.y + Math.sin(ang)*s.speed*dt;

    // With wrapping walls the spine is kept in UNWRAPPED coordinates: the body stays one
    // continuous curve and the renderer draws it again shifted by one arena, so a snake
    // halfway through an edge shows up on both sides with no line across the screen.
    if (!CFG.wrapWalls &&
        (nx < CFG.headR || nx > this.W-CFG.headR || ny < CFG.headR || ny > this.H-CFG.headR))
      return this.kill('HIT THE WALL');

    // spine[0] tracks the head exactly; a new node is recorded only once the head has
    // travelled a full `spacing`, so node density never depends on the current speed
    head.x = nx; head.y = ny;
    const nxt = s.spine[1];
    if (!nxt || Math.hypot(nx-nxt.x, ny-nxt.y) >= CFG.spacing){
      s.spine.unshift({x: nx, y: ny});
      if (s.targetGrow > 0) s.targetGrow--; else s.spine.pop();
    }

    s.tongue += dt * (sprint ? 7 : 4.5);
    s.blink -= dt*2.2;
    if (s.blink < -1.5 && Math.random() < 0.02) s.blink = 1;

    const h = s.spine[0];
    if (!CFG.passThroughSelf){
      const skip = Math.ceil(CFG.headR*2.6 / CFG.spacing) + 12;
      for (let i = skip; i < s.spine.length; i += 2){
        const p = s.spine[i];
        const r = CFG.headR*0.7 + this.radiusAt(i/(s.spine.length-1))*0.7;
        if ((h.x-p.x)**2 + (h.y-p.y)**2 < r*r) return this.kill('BIT ITSELF');
      }
    }

    if (CFG.wrapWalls) this.recenter();

    for (let i = this.apples.length-1; i >= 0; i--){
      const a = this.apples[i];
      if (Math.hypot(wrapDelta(h.x-a.x, this.W), wrapDelta(h.y-a.y, this.H)) < CFG.headR + a.r){
        this.apples.splice(i,1);
        this.score += 10;
        s.targetGrow += CFG.growPer;
        this.burst(a.x, a.y, '#ff6b52', 24);
        this.apples.push(this.spawnApple());
        this.onEvent('eat', this);
      }
    }
    this.tick++;
  }

  step(dt){
    if (this.running){
      const c = this.controller(this) || {};
      this.update(dt, c.steer || 0, !!c.sprint);
    }
    this.draw(this.running ? dt : dt*0.5);
  }

  // ---------- geometry ----------
  radiusAt(u){
    let r;
    if (u < 0.08)      r = CFG.bodyR * (0.82 + (u/0.08)*0.18);
    else if (u < 0.82) r = CFG.bodyR * (1 - 0.08*(u-0.08)/0.74);
    else {
      const k = (u - 0.82)/0.18;
      r = CFG.bodyR * 0.92 * Math.pow(1 - k, 0.85);
    }
    return r * (1 - 0.035*Math.sin(u*Math.PI*5));
  }

  outline(){
    const sp = this.snake.spine, n = sp.length, left = [], right = [];
    const step = Math.max(1, Math.floor(n/170));
    for (let i = 0; i < n; i += step){
      const a = sp[Math.max(0,i-1)], b = sp[Math.min(n-1,i+1)];
      let dx = b.x-a.x, dy = b.y-a.y;
      const L = Math.hypot(dx,dy) || 1; dx/=L; dy/=L;
      const r = this.radiusAt(i/(n-1));
      left.push({x: sp[i].x - dy*r, y: sp[i].y + dx*r});
      right.push({x: sp[i].x + dy*r, y: sp[i].y - dx*r});
    }
    return {left, right};
  }

  curveThrough(pts, connect){
    const ctx = this.ctx;
    if (connect) ctx.lineTo(pts[0].x, pts[0].y);
    else ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length-1; i++){
      const mx = (pts[i].x + pts[i+1].x)/2, my = (pts[i].y + pts[i+1].y)/2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    const last = pts[pts.length-1];
    ctx.lineTo(last.x, last.y);
  }

  bodyPath(){
    const {left, right} = this.outline();
    this.ctx.beginPath();
    this.curveThrough(left, false);
    this.curveThrough(right.slice().reverse(), true);
    this.ctx.closePath();
  }

  recenter(){
    const sp = this.snake.spine;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of sp){
      if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
    }
    const sx = x0 >= this.W ? -this.W : x1 < 0 ? this.W : 0;
    const sy = y0 >= this.H ? -this.H : y1 < 0 ? this.H : 0;
    if (sx || sy) for (const p of sp){ p.x += sx; p.y += sy; }
  }

  bodyBounds(){
    const sp = this.snake.spine;
    let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
    for (let i=0;i<sp.length;i+=4){
      const s = sp[i];
      if(s.x<x0)x0=s.x; if(s.y<y0)y0=s.y; if(s.x>x1)x1=s.x; if(s.y>y1)y1=s.y;
    }
    const pad = CFG.bodyR+4;
    return {x:x0-pad, y:y0-pad, w:(x1-x0)+pad*2, h:(y1-y0)+pad*2};
  }

  // ---------- rendering ----------
  draw(dt){
    const ctx = this.ctx;
    ctx.clearRect(0,0,this.W,this.H);
    if (this.ground) ctx.drawImage(this.ground, 0, 0, this.W, this.H);
    for (const a of this.apples) this.drawApple(a);
    if (this.snake) this.drawSnakeTiled();
    this.drawParticles(dt);
  }

  /** draw the snake at every one-arena shift that reaches the canvas */
  drawSnakeTiled(){
    if (!CFG.wrapWalls) return this.drawSnake();
    const bb = this.bodyBounds(), pad = 40;
    for (const oy of [-this.H, 0, this.H]){
      for (const ox of [-this.W, 0, this.W]){
        if (bb.x + ox > this.W + pad || bb.x + bb.w + ox < -pad) continue;
        if (bb.y + oy > this.H + pad || bb.y + bb.h + oy < -pad) continue;
        this.ctx.save();
        this.ctx.translate(ox, oy);
        this.drawSnake();
        this.ctx.restore();
      }
    }
  }

  drawSnake(){
    const ctx = this.ctx, sp = this.snake.spine, n = sp.length, pal = this.pal;

    ctx.save();
    ctx.translate(6, 9);
    this.bodyPath();
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 10;
    ctx.fill();
    ctx.restore();

    ctx.save();
    this.bodyPath(); ctx.clip();

    const bb = this.bodyBounds();
    const g = ctx.createLinearGradient(bb.x, bb.y, bb.x, bb.y+bb.h);
    g.addColorStop(0, pal.bodyTop); g.addColorStop(1, pal.bodyBot);
    ctx.fillStyle = g; ctx.fillRect(bb.x, bb.y, bb.w, bb.h);

    const step = Math.max(1, Math.floor(n/150));
    for (let i = 0; i < n-step; i += step){
      const r = this.radiusAt(i/(n-1));
      const a = sp[i], b = sp[i+step];
      let dx=b.x-a.x, dy=b.y-a.y;
      const L=Math.hypot(dx,dy)||1; dx/=L; dy/=L;
      ctx.lineWidth = r*0.5; ctx.lineCap = 'round';
      ctx.strokeStyle = `rgba(${pal.rim},0.13)`;
      ctx.beginPath();
      ctx.moveTo(a.x - dy*r*0.55, a.y + dx*r*0.55);
      ctx.lineTo(b.x - dy*r*0.55, b.y + dx*r*0.55); ctx.stroke();
      ctx.strokeStyle = 'rgba(0,20,12,0.30)';
      ctx.beginPath();
      ctx.moveTo(a.x + dy*r*0.6, a.y - dx*r*0.6);
      ctx.lineTo(b.x + dy*r*0.6, b.y - dx*r*0.6); ctx.stroke();
    }

    for (let i = 0; i < n; i += 9){
      const r = this.radiusAt(i/(n-1));
      if (r < 1.6) continue;
      const a = sp[Math.max(0,i-2)], b = sp[Math.min(n-1,i+2)];
      let dx=b.x-a.x, dy=b.y-a.y;
      const L=Math.hypot(dx,dy)||1; dx/=L; dy/=L;
      const p = sp[i], ph = i*0.32, sz = r*(0.62 + 0.3*Math.sin(ph));
      ctx.save();
      ctx.translate(p.x, p.y); ctx.rotate(Math.atan2(dy,dx));
      ctx.fillStyle = `rgba(${pal.dark},${0.42 + 0.14*Math.sin(ph)})`;
      ctx.beginPath();
      ctx.moveTo(0,-sz); ctx.lineTo(sz*1.25,0); ctx.lineTo(0,sz); ctx.lineTo(-sz*1.25,0);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = `rgba(${pal.rim},0.06)`;
      ctx.beginPath();
      ctx.moveTo(0,-sz*0.5); ctx.lineTo(sz*0.6,0); ctx.lineTo(0,sz*0.5); ctx.lineTo(-sz*0.6,0);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }

    this.drawScales();
    ctx.restore();

    this.bodyPath();
    ctx.strokeStyle = 'rgba(4,18,12,0.85)'; ctx.lineWidth = 1.6; ctx.stroke();
    this.drawHead();
  }

  drawScales(){
    const ctx = this.ctx, sp = this.snake.spine, n = sp.length, pal = this.pal;
    ctx.lineWidth = 0.9;
    const stride = n > 400 ? 8 : n > 250 ? 6 : 4;
    const rows = n > 400 ? 1 : 2;
    for (let i = 2; i < n-2; i += stride){
      const r = this.radiusAt(i/(n-1));
      if (r < 2.2) continue;
      const a = sp[i-2], b = sp[i+2];
      let dx=b.x-a.x, dy=b.y-a.y;
      const L=Math.hypot(dx,dy)||1; dx/=L; dy/=L;
      const p = sp[i], face = Math.atan2(dy,dx);
      for (let k = -rows; k <= rows; k++){
        const off = (k/2.6)*r;
        const s = r*0.30*(1 - Math.abs(k)/3.4);
        if (s < 0.6) continue;
        ctx.strokeStyle = `rgba(${pal.rim},${0.10 - Math.abs(k)*0.018})`;
        ctx.beginPath();
        ctx.arc(p.x - dy*off, p.y + dx*off, s, face-2.3, face+2.3);
        ctx.stroke();
      }
    }
  }

  drawHead(){
    const ctx = this.ctx, sp = this.snake.spine, pal = this.pal;
    const head = sp[0];
    const nx = sp[0].x - sp[Math.min(6, sp.length-1)].x;
    const ny = sp[0].y - sp[Math.min(6, sp.length-1)].y;
    const a = Math.atan2(ny, nx) || this.snake.ang;
    const R = CFG.headR;

    ctx.save();
    ctx.translate(head.x, head.y); ctx.rotate(a);

    ctx.save(); ctx.translate(6,9);
    ctx.beginPath(); ctx.ellipse(0,0,R*1.35,R*0.95,0,0,TAU);
    ctx.fillStyle='rgba(0,0,0,0.38)';
    ctx.shadowColor='rgba(0,0,0,0.45)'; ctx.shadowBlur = 8;
    ctx.fill(); ctx.restore();

    const tg = Math.max(0, Math.sin(this.snake.tongue));
    if (tg > 0.05){
      const L = R*1.5*tg, wob = Math.sin(this.tick*0.4)*2;
      ctx.strokeStyle = '#ff5b7a'; ctx.lineWidth = 2; ctx.lineCap='round';
      ctx.beginPath(); ctx.moveTo(R*1.2, 0); ctx.lineTo(R*1.2+L*0.62, wob*0.4); ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(R*1.2+L*0.62, wob*0.4); ctx.lineTo(R*1.2+L, wob-3.2);
      ctx.moveTo(R*1.2+L*0.62, wob*0.4); ctx.lineTo(R*1.2+L, wob+3.2);
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.moveTo(R*1.30, 0);
    ctx.bezierCurveTo(R*1.26, -R*0.42, R*0.85, -R*0.80, R*0.18, -R*0.92);
    ctx.bezierCurveTo(-R*0.55, -R*1.02, -R*1.10, -R*0.86, -R*1.45, -R*0.66);
    ctx.lineTo(-R*1.45, R*0.66);
    ctx.bezierCurveTo(-R*1.10, R*0.86, -R*0.55, R*1.02, R*0.18, R*0.92);
    ctx.bezierCurveTo(R*0.85, R*0.80, R*1.26, R*0.42, R*1.30, 0);
    ctx.closePath();
    const hg = ctx.createLinearGradient(0,-R,0,R);
    hg.addColorStop(0, pal.headTop); hg.addColorStop(0.5, pal.headMid); hg.addColorStop(1, pal.headBot);
    ctx.fillStyle = hg; ctx.fill();
    ctx.strokeStyle = 'rgba(4,18,12,0.9)'; ctx.lineWidth = 1.6; ctx.stroke();

    ctx.save(); ctx.clip();
    ctx.strokeStyle = `rgba(${pal.rim},0.10)`; ctx.lineWidth = 1;
    for (let i=-3;i<=3;i++){
      ctx.beginPath(); ctx.arc(-R*0.2 + i*R*0.26, 0, R*0.55, -1.1, 1.1); ctx.stroke();
    }
    ctx.fillStyle = `rgba(${pal.rim},0.10)`;
    ctx.beginPath(); ctx.ellipse(R*0.1,-R*0.45,R*0.85,R*0.28,-0.1,0,TAU); ctx.fill();
    ctx.strokeStyle='rgba(4,18,12,0.45)'; ctx.lineWidth=1.4;
    for (const s2 of [-1,1]){
      ctx.beginPath();
      ctx.moveTo(R*1.18, s2*R*0.12);
      ctx.quadraticCurveTo(R*0.2, s2*R*0.78, -R*1.4, s2*R*0.60);
      ctx.stroke();
    }
    ctx.fillStyle='rgba(6,28,18,0.35)';
    for (const s2 of [-1,1]){
      ctx.beginPath(); ctx.ellipse(R*0.36, s2*R*0.80, R*0.52, R*0.18, s2*0.22, 0, TAU); ctx.fill();
    }
    ctx.restore();

    ctx.fillStyle='rgba(3,16,10,0.8)';
    ctx.beginPath(); ctx.ellipse(R*0.92,-R*0.28,1.3,0.9,0,0,TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(R*0.92, R*0.28,1.3,0.9,0,0,TAU); ctx.fill();

    const blink = this.snake.blink > 0 ? Math.sin((1-this.snake.blink)*Math.PI) : 0;
    for (const s of [-1, 1]){
      const ex = R*0.36, ey = s*R*0.56, er = R*0.30;
      ctx.beginPath(); ctx.ellipse(ex, ey, er*1.12, er*(1-blink*0.92), 0, 0, TAU);
      ctx.fillStyle = pal.eye; ctx.fill();
      ctx.strokeStyle='rgba(4,18,12,0.85)'; ctx.lineWidth=1.1; ctx.stroke();
      if (blink < 0.6){
        ctx.beginPath(); ctx.ellipse(ex+er*0.18, ey, er*0.30, er*0.80*(1-blink), 0, 0, TAU);
        ctx.fillStyle = '#0a1a10'; ctx.fill();
        ctx.beginPath(); ctx.arc(ex+er*0.45, ey-er*0.38, er*0.20, 0, TAU);
        ctx.fillStyle='rgba(255,255,255,0.75)'; ctx.fill();
      }
    }
    ctx.restore();
  }

  drawApple(p){
    const ctx = this.ctx;
    const r = p.r * (1 + 0.07*Math.sin((this.tick - p.born)*0.09));
    ctx.save(); ctx.translate(p.x, p.y);

    ctx.save(); ctx.translate(4,7);
    ctx.beginPath(); ctx.ellipse(0,0,r,r*0.7,0,0,TAU);
    ctx.fillStyle='rgba(0,0,0,0.35)';
    ctx.shadowColor='rgba(0,0,0,0.4)'; ctx.shadowBlur = 6;
    ctx.fill(); ctx.restore();

    ctx.beginPath(); ctx.arc(0,0,r*2.4,0,TAU);
    const glow = ctx.createRadialGradient(0,0,r*0.4,0,0,r*2.4);
    glow.addColorStop(0,'rgba(255,110,90,0.22)'); glow.addColorStop(1,'rgba(255,110,90,0)');
    ctx.fillStyle = glow; ctx.fill();

    ctx.beginPath();
    ctx.moveTo(0,-r*0.85);
    ctx.bezierCurveTo(r*1.1,-r*1.15, r*1.15,r*0.6, 0,r);
    ctx.bezierCurveTo(-r*1.15,r*0.6, -r*1.1,-r*1.15, 0,-r*0.85);
    ctx.closePath();
    const ag = ctx.createRadialGradient(-r*0.35,-r*0.4,r*0.15,0,0,r*1.35);
    ag.addColorStop(0,'#ff8a6b'); ag.addColorStop(0.5,'#e03a35'); ag.addColorStop(1,'#8c1614');
    ctx.fillStyle = ag; ctx.fill();

    ctx.strokeStyle='#6b4a22'; ctx.lineWidth=2; ctx.lineCap='round';
    ctx.beginPath(); ctx.moveTo(0,-r*0.8); ctx.quadraticCurveTo(r*0.2,-r*1.35, r*0.05,-r*1.6); ctx.stroke();
    ctx.fillStyle='#3f8a45';
    ctx.beginPath(); ctx.ellipse(r*0.5,-r*1.3, r*0.42, r*0.2, -0.5, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(-r*0.36,-r*0.36, r*0.24, r*0.36, -0.6, 0, TAU);
    ctx.fillStyle='rgba(255,255,255,0.55)'; ctx.fill();
    ctx.restore();
  }

  burst(x, y, color, n){
    for (let i = 0; i < n; i++){
      const a = Math.random()*TAU, s = 40 + Math.random()*180;
      this.particles.push({x, y, vx: Math.cos(a)*s, vy: Math.sin(a)*s,
        life: 0.5 + Math.random()*0.5, r: 1.4 + Math.random()*3, color});
    }
  }

  drawParticles(dt){
    const ctx = this.ctx;
    for (let i = this.particles.length-1; i >= 0; i--){
      const p = this.particles[i];
      p.x += p.vx*dt; p.y += p.vy*dt;
      p.vx *= 0.93; p.vy *= 0.93; p.vy += 220*dt;
      p.life -= dt;
      if (p.life <= 0){ this.particles.splice(i,1); continue; }
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}
