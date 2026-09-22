/* What this server offers, and the visitor's own Jev key.

   /api/config says whether Laya runs here (the Docker image switches it off) and whether
   the server has a key of its own. The key a visitor pastes lives only in their browser
   (localStorage) and rides along on each /api/jev call as X-Jev-Key.            */
"use strict";

const STORE = 'jevKey';

export function jevKey(){
  try { return localStorage.getItem(STORE) || ''; } catch { return ''; }
}
export function setJevKey(k){
  try { k ? localStorage.setItem(STORE, k.trim()) : localStorage.removeItem(STORE); } catch {}
}

export const config = fetch('/api/config').then(r => r.json())
  .catch(() => ({laya: true, serverKey: true}));

/** with Laya off, drop it from every player picker; a side that was Laya becomes Human */
config.then(c => {
  if (c.laya) return;
  const fix = () => {
    for (const sel of document.querySelectorAll('select[id^="agent"]')){
      const was = sel.value;
      for (const o of [...sel.options]) if (o.value === 'laya') o.remove();
      if (was === 'laya'){
        sel.value = 'human';
        sel.dispatchEvent(new Event('change'));
      }
    }
    for (const el of document.querySelectorAll('[data-laya]')) el.style.display = 'none';
  };
  document.readyState === 'loading' ? addEventListener('DOMContentLoaded', fix) : fix();
});
