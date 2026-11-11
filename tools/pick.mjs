import { heightAt, slopeAt } from '../src/world/terrain.js';
// Sun azimuth at golden hour, from core/time.js: (t*360+90)%360, and THREE's
// spherical mapping x=sinφ·sinθ, z=sinφ·cosθ. Report where the sun actually is.
const t = 0.726;
const az = (t * 360 + 90) % 360, th = az * Math.PI / 180;
console.log('sun azimuth', az.toFixed(1), 'dir x=', Math.sin(th).toFixed(2), 'z=', Math.cos(th).toFixed(2));
// Facing the sun means player yaw such that (sin yaw, cos yaw) ≈ sun xz.
console.log('face-the-sun degrees =', (Math.atan2(Math.sin(th), Math.cos(th)) * 180 / Math.PI).toFixed(0));
const best = (pred, n = 4) => {
  const out = [];
  for (let x = -1000; x <= 1000; x += 29) for (let z = -1000; z <= 1000; z += 29) {
    const h = heightAt(x, z), s = slopeAt(x, z);
    if (pred(x, z, h, s) && out.every(p => Math.hypot(p.x - x, p.z - z) > 300)) out.push({ x, z, h: +h.toFixed(1), s: +s.toFixed(2) });
    if (out.length >= n) return out;
  }
  return out;
};
console.log('meadow+Z  ', JSON.stringify(best((x,z,h,s)=> z>100 && h>14 && h<60 && s<0.10)));
console.log('ridge+Z   ', JSON.stringify(best((x,z,h,s)=> z>0 && h>100 && h<160 && s<0.25)));
console.log('coast+Z   ', JSON.stringify(best((x,z,h,s)=> z>500 && h>2 && h<8 && s<0.09)));
console.log('summit    ', JSON.stringify(best((x,z,h,s)=> h>180 && s<0.45)));
console.log('valley    ', JSON.stringify(best((x,z,h,s)=> h>8 && h<26 && s<0.06 && Math.abs(z)<420)));
