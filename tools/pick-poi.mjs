// Find POI sites that are genuinely FLAT (a ring of props must not drape down a
// ravine) and far from every world encounter anchor, so quest set-pieces don't
// land inside somebody else's Mongol outpost.
import { heightAt, slopeAt } from '../src/world/terrain.js';

const ENC = [
  [-296,121],[-217,392],[-130,508],[-159,15],[-710,102],[-507,740],[15,189],
  [218,421],[-449,-72],[-681,450],[-420,624],[-101,276],[218,566],[-449,200],
];

// Max height deviation across a ring of radius r — the actual thing that broke
// the village: props at r=17 spanned 17 vertical metres.
function flatness(cx, cz, r) {
  const h0 = heightAt(cx, cz);
  let dev = 0;
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    for (const rr of [r * 0.6, r]) {
      dev = Math.max(dev, Math.abs(heightAt(cx + Math.cos(a) * rr, cz + Math.sin(a) * rr) - h0));
    }
  }
  return dev;
}
const encDist = (x, z) => Math.min(...ENC.map(([ex, ez]) => Math.hypot(x - ex, z - ez)));

function find(name, r, want, pred) {
  const out = [];
  for (let x = -950; x <= 950; x += 23) {
    for (let z = -950; z <= 950; z += 23) {
      const h = heightAt(x, z);
      if (!pred(x, z, h)) continue;
      if (slopeAt(x, z) > 0.12) continue;
      if (encDist(x, z) < 110) continue;
      const f = flatness(x, z, r);
      if (f > 3.2) continue;
      if (out.every(p => Math.hypot(p.x - x, p.z - z) > 240)) out.push({ x, z, h: +h.toFixed(1), dev: +f.toFixed(1), enc: Math.round(encDist(x, z)) });
      if (out.length >= want) break;
    }
    if (out.length >= want) break;
  }
  console.log(name.padEnd(8), JSON.stringify(out));
}

find('village', 20, 3, (x, z, h) => h > 14 && h < 70 && z > 200);
find('shrine',  12, 3, (x, z, h) => h > 10 && h < 60);
find('camp',    16, 3, (x, z, h) => h > 25 && h < 95);
find('summit',  14, 3, (x, z, h) => h > 120);
find('shore',   14, 3, (x, z, h) => h > 2.5 && h < 9);
