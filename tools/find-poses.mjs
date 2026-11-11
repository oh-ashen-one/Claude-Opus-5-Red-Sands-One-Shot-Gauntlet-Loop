// Scans the island and reports genuinely representative spots, so poses land on
// real ground instead of guesses. Prints candidates per category.
import { heightAt, slopeAt, ISLAND } from '../src/world/terrain.js';
const cats = {
  meadow:  { h: [12, 70],  s: [0, 0.14], want: 6 },
  ridge:   { h: [95, 175], s: [0.05, 0.30], want: 6 },
  summit:  { h: [175, 400], s: [0, 0.5], want: 4 },
  coast:   { h: [1.5, 7],  s: [0, 0.12], want: 6 },
  slope:   { h: [55, 110], s: [0.20, 0.42], want: 4 },
};
const out = {}; for (const k in cats) out[k] = [];
const R = ISLAND.size * 0.42;
for (let x = -R; x <= R; x += 37) {
  for (let z = -R; z <= R; z += 37) {
    const h = heightAt(x, z), s = slopeAt(x, z);
    for (const k in cats) {
      const c = cats[k];
      if (h >= c.h[0] && h <= c.h[1] && s >= c.s[0] && s <= c.s[1] && out[k].length < 400)
        out[k].push({ x: Math.round(x), z: Math.round(z), h: +h.toFixed(1), s: +s.toFixed(3) });
    }
  }
}
for (const k in cats) {
  const list = out[k];
  // Spread the picks apart so they are not all the same hillside.
  const picked = [];
  for (const c of list) {
    if (picked.every(p => Math.hypot(p.x - c.x, p.z - c.z) > 260)) picked.push(c);
    if (picked.length >= cats[k].want) break;
  }
  console.log(k.padEnd(8), JSON.stringify(picked));
}
