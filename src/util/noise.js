// Classic 2D value-noise + fbm. Cheap, seedable, good enough for island silhouette.
import { mulberry32 } from './rng.js';
const P = new Uint8Array(512);
{
  const r = mulberry32(1337);
  const p = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) { const j = (r() * (i + 1)) | 0; [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) P[i] = p[i & 255];
}
const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;
const grad = (h, x, y) => ((h & 1) ? -x : x) + ((h & 2) ? -y : y);
export function noise2(x, y) {
  const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
  x -= Math.floor(x); y -= Math.floor(y);
  const u = fade(x), v = fade(y);
  const A = P[X] + Y, B = P[X + 1] + Y;
  return lerp(lerp(grad(P[A], x, y), grad(P[B], x - 1, y), u),
              lerp(grad(P[A + 1], x, y - 1), grad(P[B + 1], x - 1, y - 1), u), v);
}
export function fbm(x, y, oct = 5, lac = 2.03, gain = 0.5) {
  let a = 0.5, f = 1, s = 0, n = 0;
  for (let i = 0; i < oct; i++) { s += a * noise2(x * f, y * f); n += a; a *= gain; f *= lac; }
  return s / n;
}
// Ridged fbm gives the sharp spines Tsushima's mountains read with.
export function ridged(x, y, oct = 5) {
  let a = 0.5, f = 1, s = 0, n = 0;
  for (let i = 0; i < oct; i++) {
    s += a * (1 - Math.abs(noise2(x * f, y * f))); n += a; a *= 0.5; f *= 2.07;
  }
  return s / n;
}
