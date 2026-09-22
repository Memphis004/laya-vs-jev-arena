/* A human player for any arena: the same interface the model agents expose, driven by
   the keyboard. The left arena uses the left of the keyboard and the right arena uses
   the arrows, so two people can share one keyboard — or one person against a model.

     left side:   A / D move · W up · S down · F G H actions
     right side:  ← / → move · ↑ up · ↓ down · K L ; actions   */
"use strict";

export const KEYMAP = {
  1: {left: 'a', right: 'd', up: 'w', down: 's', a1: 'f', a2: 'g', a3: 'h', alt: ' '},
  2: {left: 'arrowleft', right: 'arrowright', up: 'arrowup', down: 'arrowdown', a1: 'k', a2: 'l', a3: ';', alt: 'enter'}
};

/** held keys plus a count of fresh presses, so a tap is never missed between frames */
export class Keys {
  constructor(){
    this.held = new Set();
    this.taps = new Map();
    const owned = new Set(Object.values(KEYMAP).flatMap(Object.values));
    addEventListener('keydown', e => {
      const k = e.key.toLowerCase();
      if (!owned.has(k)) return;
      // arrows and space would scroll the page, a focused dropdown would eat them, and
      // Space/Enter on a still-focused Restart button would restart the round
      if (e.target && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(e.target.tagName)) e.target.blur();
      e.preventDefault();
      if (!e.repeat) this.taps.set(k, (this.taps.get(k) || 0) + 1);
      this.held.add(k);
    });
    addEventListener('keyup', e => this.held.delete(e.key.toLowerCase()));
    addEventListener('blur', () => this.held.clear());
  }
  isDown(side, name){ return this.held.has(KEYMAP[side][name]); }
  /** consume one fresh press of a key */
  take(side, name){
    const k = KEYMAP[side][name], n = this.taps.get(k) || 0;
    if (n > 0){ this.taps.set(k, n - 1); return true; }
    return false;
  }
  clear(){ this.taps.clear(); }
}

export const keys = new Keys();

/** the fields each arena's HUD reads from an agent, with nothing to measure */
export class HumanPlayer {
  constructor(side){
    this.side = side; this.model = 'human'; this.servedModel = 'keyboard';
    this.decisions = 0; this.error = null; this.lastChoice = '—'; this.lastProbs = null;
    this.inputTokens = 0; this.outputTokens = 0;
  }
  get rate(){ return 0; }
  get p50(){ return 0; }
  get p95(){ return 0; }
  reset(){ this.decisions = 0; keys.clear(); }
  async prime(){ this.reset(); }
  start(){} stop(){}
}

export const HUMAN_HINT = {
  1: 'A/D · W · S · F G H', 2: '←/→ · ↑ · ↓ · K L ;'
};
