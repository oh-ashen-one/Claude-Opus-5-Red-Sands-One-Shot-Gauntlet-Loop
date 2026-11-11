// tools/status.mjs '<json patch>' — merge a patch into public/status.json.
import fs from 'node:fs';
const P = new URL('../public/status.json', import.meta.url);
const cur = JSON.parse(fs.readFileSync(P, 'utf8'));
const patch = JSON.parse(process.argv[2] || '{}');
if (patch.piece) {
  cur.pieces = cur.pieces || [];
  const i = cur.pieces.findIndex(p => p.name === patch.piece.name);
  if (i >= 0) Object.assign(cur.pieces[i], patch.piece); else cur.pieces.push(patch.piece);
  delete patch.piece;
}
Object.assign(cur, patch);
cur.updated = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
fs.writeFileSync(P, JSON.stringify(cur, null, 2));
