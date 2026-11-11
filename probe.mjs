import fs from 'node:fs';
import { heightAt, slopeAt } from './src/world/terrain.js';
const poses = JSON.parse(fs.readFileSync('tools/poses.json','utf8'));
for (const p of poses) console.log(p.id.padEnd(18), 'h=', heightAt(p.x,p.z).toFixed(1).padStart(7), 'slope=', slopeAt(p.x,p.z).toFixed(3));
console.log('--- height grid ---');
let hdr='       '; for (let x=-800;x<=800;x+=200) hdr += ('x'+x).padStart(7); console.log(hdr);
for (let z=-800; z<=800; z+=200){ let row=''; for (let x=-800;x<=800;x+=200){ row += heightAt(x,z).toFixed(0).padStart(7); } console.log(('z='+z).padStart(7), row); }
