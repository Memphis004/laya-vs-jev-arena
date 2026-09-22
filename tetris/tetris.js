/* Tetris — one board per model, the same seeded piece sequence on both.

   This follows Laya's own Tetris demo: code lists every place the current piece can land
   and describes each one in a plain sentence ("clears one line, leaves no holes, keeps
   the surface flat"); the model answers one yes/no question per placement — "would this
   leave the stack clean?" — and the piece goes to the placement it rates highest.

   Every piece has a timer that shrinks as the game goes on. If the model has not
   answered when it runs out, the piece drops where it spawned: speed starts to matter
   exactly when the game gets fast. */
"use strict";

export const TCFG = {
  cols: 10, rows: 20,
  timerStart: 3.5, timerMin: 1.5, timerStep: 0.03,   // seconds per piece, shrinking
  moveAnim: 0.28,                                      // slide + drop animation
  maxPieces: 150
};

const SHAPES = {
  I: [[0,1],[1,1],[2,1],[3,1]], O: [[1,0],[2,0],[1,1],[2,1]], T: [[0,1],[1,1],[2,1],[1,0]],
  S: [[1,0],[2,0],[0,1],[1,1]], Z: [[0,0],[1,0],[1,1],[2,1]], J: [[0,0],[0,1],[1,1],[2,1]],
  L: [[2,0],[0,1],[1,1],[2,1]]
};
export const COLORS = { I:'#4fd6ff', O:'#ffd34d', T:'#c77dff', S:'#5ef28a', Z:'#ff5e6c', J:'#5e8bff', L:'#ffa24d' };

export function mulberry32(seed){
  let a = seed >>> 0;
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

/** the four rotations of a shape, each normalised to its top-left corner */
function rotations(kind){
  const out = [], seen = new Set();
  let cells = SHAPES[kind];
  for (let r = 0; r < 4; r++){
    const minX = Math.min(...cells.map(c => c[0])), minY = Math.min(...cells.map(c => c[1]));
    const norm = cells.map(([x, y]) => [x - minX, y - minY]).sort((a, b) => a[1]-b[1] || a[0]-b[0]);
    const key = JSON.stringify(norm);
    if (!seen.has(key)){ seen.add(key); out.push(norm); }
    cells = cells.map(([x, y]) => [-y, x]);
  }
  return out;
}
const ROT = Object.fromEntries(Object.keys(SHAPES).map(k => [k, rotations(k)]));

function heights(board){
  const H = [];
  for (let x = 0; x < TCFG.cols; x++){
    let h = 0;
    for (let y = 0; y < TCFG.rows; y++) if (board[y][x]){ h = TCFG.rows - y; break; }
    H.push(h);
  }
  return H;
}
function holes(board){
  let n = 0;
  for (let x = 0; x < TCFG.cols; x++){
    let roof = false;
    for (let y = 0; y < TCFG.rows; y++){ if (board[y][x]) roof = true; else if (roof) n++; }
  }
  return n;
}
const bumpiness = H => H.slice(1).reduce((s, h, i) => s + Math.abs(h - H[i]), 0);

export class Board {
  constructor(canvas, opts = {}){
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.onEvent = opts.onEvent || (() => {});
    this.accent = opts.accent || '#5ef2a8';
    this.resize(); this.reset(opts.seed || 7);
  }

  resize(){
    const r = this.cv.getBoundingClientRect();
    this.DPR = Math.min(window.devicePixelRatio || 1, 2);
    this.W = Math.max(200, Math.round(r.width)); this.H = Math.max(200, Math.round(r.height));
    this.cv.width = Math.round(this.W*this.DPR); this.cv.height = Math.round(this.H*this.DPR);
    this.ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
  }

  reset(seed){
    this.rng = mulberry32(seed);
    this.bag = [];
    this.grid = Array.from({length: TCFG.rows}, () => Array(TCFG.cols).fill(null));
    this.lines = 0; this.pieces = 0; this.timeouts = 0; this.over = false; this.running = false;
    this.anim = null; this.flashRows = []; this.flashT = 0; this.t = 0;
    this.next = this.draw7();
    this.spawn();
  }

  /** 7-bag randomiser: every seven pieces contain one of each, like modern Tetris */
  draw7(){
    if (!this.bag.length){
      this.bag = Object.keys(SHAPES);
      for (let i = this.bag.length - 1; i > 0; i--){ const j = Math.floor(this.rng()*(i+1)); [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]]; }
    }
    return this.bag.pop();
  }

  spawn(){
    this.kind = this.next; this.next = this.draw7();
    this.rot = 0; this.px = 3; this.py = 0;
    this.timer = Math.max(TCFG.timerMin, TCFG.timerStart - TCFG.timerStep*this.pieces);
    this.timerMax = this.timer;
    this.decision = null;                    // set by the model: index into this.options
    this.options = this.enumerate();
    this.pieceId = (this.pieceId || 0) + 1;  // lets a late answer for an old piece be ignored
    if (!this.fits(ROT[this.kind][0], this.px, this.py)){ this.over = true; this.running = false; this.onEvent('topout', this); }
  }

  fits(cells, x, y){
    for (const [cx, cy] of cells){
      const gx = x + cx, gy = y + cy;
      if (gx < 0 || gx >= TCFG.cols || gy >= TCFG.rows) return false;
      if (gy >= 0 && this.grid[gy][gx]) return false;
    }
    return true;
  }
  dropY(cells, x){ let y = 0; if (!this.fits(cells, x, 0)) return null; while (this.fits(cells, x, y + 1)) y++; return y; }

  /** every distinct landing spot for the current piece, with what it would do */
  enumerate(){
    const opts = [], h0 = holes(this.grid), b0 = bumpiness(heights(this.grid));
    const maxH0 = Math.max(...heights(this.grid));
    ROT[this.kind].forEach((cells, r) => {
      const w = Math.max(...cells.map(c => c[0])) + 1;
      for (let x = 0; x <= TCFG.cols - w; x++){
        const y = this.dropY(cells, x);
        if (y === null) continue;
        const g = this.grid.map(row => row.slice());
        for (const [cx, cy] of cells) if (y + cy >= 0) g[y + cy][x + cx] = this.kind;
        const full = g.filter(row => row.every(Boolean)).length;
        const kept = g.filter(row => !row.every(Boolean));
        while (kept.length < TCFG.rows) kept.unshift(Array(TCFG.cols).fill(null));
        const H = heights(kept);
        opts.push({r, x, y, lines: full, newHoles: Math.max(0, holes(kept) - h0),
                   bumpDelta: bumpiness(H) - b0, heightDelta: Math.max(...H) - maxH0,
                   landing: TCFG.rows - y});
      }
    });
    for (const o of opts) o.text = describe(o);
    return opts;
  }

  /** the placement the model picked, animated in; or the spawn spot if time ran out */
  place(opt, timedOut){
    const cells = ROT[this.kind][opt ? opt.r : this.rot];
    const x = opt ? opt.x : this.px, y = opt ? opt.y : this.dropY(cells, this.px);
    if (y === null){ this.over = true; this.running = false; this.onEvent('topout', this); return; }
    this.anim = {cells, fromX: this.px, x, y, t: 0, timedOut};
  }

  commit(){
    const {cells, x, y, timedOut} = this.anim;
    for (const [cx, cy] of cells){
      if (y + cy < 0){ this.over = true; this.running = false; this.onEvent('topout', this); return; }
      this.grid[y + cy][x + cx] = this.kind;
    }
    const full = [];
    this.grid.forEach((row, i) => { if (row.every(Boolean)) full.push(i); });
    if (full.length){
      this.flashRows = full; this.flashT = 0.25;
      this.grid = this.grid.filter((_, i) => !full.includes(i));
      while (this.grid.length < TCFG.rows) this.grid.unshift(Array(TCFG.cols).fill(null));
      this.lines += full.length;
      this.onEvent('lines', this, full.length);
    } else this.onEvent('lock', this);
    if (timedOut) this.timeouts++;
    this.pieces++;
    this.anim = null;
    if (this.pieces >= TCFG.maxPieces){ this.over = true; this.running = false; this.onEvent('done', this); return; }
    this.spawn();
  }

  step(dt){
    if (this.flashT > 0) this.flashT -= dt;
    if (this.running && !this.over){
      this.t += dt;
      if (this.anim){
        this.anim.t += dt;
        if (this.anim.t >= TCFG.moveAnim) this.commit();
      } else if (this.decision !== null){
        this.place(this.options[this.decision], false);
      } else {
        this.timer -= dt;
        if (this.timer <= 0) this.place(null, true);      // too slow: drops where it spawned
      }
    }
    this.draw();
  }

  get holes(){ return holes(this.grid); }

  // ---------- manual play ----------
  /** slide the falling piece one column, if it fits */
  tryMove(dx){
    if (this.anim || this.over) return;
    if (this.fits(ROT[this.kind][this.rot], this.px + dx, this.py)) this.px += dx;
  }
  /** rotate clockwise, nudging off a wall if the rotation would poke through it */
  tryRotate(){
    if (this.anim || this.over) return;
    const n = ROT[this.kind].length, nr = (this.rot + 1) % n, cells = ROT[this.kind][nr];
    for (const kick of [0, -1, 1, -2, 2]){
      if (this.fits(cells, this.px + kick, this.py)){ this.rot = nr; this.px += kick; return; }
    }
  }
  /** drop the piece straight down where it is */
  hardDrop(){ if (!this.anim && !this.over) this.place(null, false); }

  draw(){
    const c = this.ctx, W = this.W, H = this.H;
    c.fillStyle = '#0b0918'; c.fillRect(0, 0, W, H);
    const cell = Math.floor(Math.min((H - 30) / TCFG.rows, (W*0.62) / TCFG.cols));
    const bw = cell*TCFG.cols, bh = cell*TCFG.rows;
    const ox = Math.round((W - bw)/2 - W*0.08), oy = Math.round((H - bh)/2);

    // well
    c.fillStyle = '#120f26'; c.fillRect(ox - 4, oy - 4, bw + 8, bh + 8);
    c.strokeStyle = this.accent; c.globalAlpha = 0.5; c.lineWidth = 2; c.strokeRect(ox - 4, oy - 4, bw + 8, bh + 8); c.globalAlpha = 1;
    c.strokeStyle = 'rgba(255,255,255,0.04)'; c.lineWidth = 1;
    for (let x = 1; x < TCFG.cols; x++){ c.beginPath(); c.moveTo(ox + x*cell, oy); c.lineTo(ox + x*cell, oy + bh); c.stroke(); }
    for (let y = 1; y < TCFG.rows; y++){ c.beginPath(); c.moveTo(ox, oy + y*cell); c.lineTo(ox + bw, oy + y*cell); c.stroke(); }

    const block = (x, y, col, alpha = 1) => {
      c.globalAlpha = alpha;
      c.fillStyle = col; c.fillRect(ox + x*cell + 1, oy + y*cell + 1, cell - 2, cell - 2);
      c.fillStyle = 'rgba(255,255,255,0.28)'; c.fillRect(ox + x*cell + 1, oy + y*cell + 1, cell - 2, Math.max(2, cell*0.18));
      c.fillStyle = 'rgba(0,0,0,0.25)'; c.fillRect(ox + x*cell + 1, oy + y*cell + cell*0.78, cell - 2, cell*0.2);
      c.globalAlpha = 1;
    };
    this.grid.forEach((row, y) => row.forEach((k, x) => { if (k) block(x, y, COLORS[k]); }));
    if (this.flashT > 0){ c.fillStyle = `rgba(255,255,255,${this.flashT*2.5})`; c.fillRect(ox, oy, bw, bh); }

    if (!this.over){
      if (this.anim){
        // slide sideways then fall into place
        const k = Math.min(1, this.anim.t / TCFG.moveAnim);
        const fx = this.anim.fromX + (this.anim.x - this.anim.fromX)*Math.min(1, k*2);
        const fy = k < 0.5 ? 0 : this.anim.y*((k - 0.5)*2);
        for (const [cx, cy] of this.anim.cells) block(fx + cx, fy + cy, COLORS[this.kind]);
      } else {
        const cells = ROT[this.kind][this.rot];
        for (const [cx, cy] of cells) block(this.px + cx, this.py + cy, COLORS[this.kind]);
        // timer bar under the well
        const k = Math.max(0, this.timer / this.timerMax);
        c.fillStyle = 'rgba(255,255,255,0.08)'; c.fillRect(ox, oy + bh + 8, bw, 6);
        c.fillStyle = k > 0.35 ? this.accent : '#ff7a6b'; c.fillRect(ox, oy + bh + 8, bw*k, 6);
      }
    }

    // side panel: next piece and live counts
    const sx = ox + bw + 24;
    c.fillStyle = '#9a8fbf'; c.font = '600 12px ui-monospace, monospace';
    c.fillText('NEXT', sx, oy + 14);
    const nc = ROT[this.next][0], s = Math.max(10, cell*0.7);
    for (const [cx, cy] of nc){ c.fillStyle = COLORS[this.next]; c.fillRect(sx + cx*s, oy + 26 + cy*s, s - 2, s - 2); }
    const rows = [['LINES', this.lines], ['PIECES', this.pieces], ['HOLES', this.holes], ['TOO SLOW', this.timeouts]];
    rows.forEach(([k, v], i) => {
      c.fillStyle = '#9a8fbf'; c.font = '600 12px ui-monospace, monospace'; c.fillText(k, sx, oy + 110 + i*56);
      c.fillStyle = k === 'TOO SLOW' && v ? '#ff7a6b' : '#efe9ff'; c.font = '700 28px ui-monospace, monospace'; c.fillText(String(v), sx, oy + 140 + i*56);
    });
  }
}

/** a placement in plain words, in the style of Laya's Tetris demo */
export function describe(o){
  const parts = [];
  if (o.lines) parts.push(`clears ${['', 'one line', 'two lines', 'three lines', 'four lines'][o.lines]}`);
  parts.push(o.newHoles === 0 ? 'leaves no holes'
    : `leaves ${['', 'one hole', 'two holes', 'three holes'][Math.min(3, o.newHoles)]} under it`);
  if (o.bumpDelta <= -1) parts.push('makes the surface flatter');
  else if (o.bumpDelta >= 3) parts.push('makes a tall bump on top');
  else if (o.bumpDelta >= 1) parts.push('makes a small bump on top');
  else parts.push('keeps the surface as flat');
  if (o.heightDelta >= 2) parts.push('makes the stack taller');
  const last = parts.pop();
  return `The piece ${parts.length ? parts.join(', ') + ' and ' : ''}${last}.`;
}
