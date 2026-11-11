import * as THREE from 'three';
import { createEngine } from './core/engine.js';
import { createInput } from './core/input.js';
import { createTimeOfDay } from './core/time.js';
import { createWorld } from './world/world.js';
import { createPlayer } from './actors/player.js';
import { createGameCamera } from './game/camera.js';
import { createPostFX } from './core/postfx.js';
import { createHUD } from './game/hud.js';
import { createHorse } from './actors/horse.js';
import { createEnemies } from './actors/enemy.js';
import { createCombat } from './game/combat.js';
import { createAudio } from './game/audio.js';
import { createQuest } from './game/quest.js';

const canvas = document.getElementById('c');
const { renderer, scene, camera } = createEngine(canvas);
const input = createInput(canvas);
const tod = createTimeOfDay();
const clock = new THREE.Clock();

const ctx = { THREE, renderer, scene, camera, input, tod, state: {} };

const world = await createWorld(ctx);      ctx.world = world;
const player = await createPlayer(ctx);    ctx.player = player;
const gcam = createGameCamera(ctx);        ctx.gcam = gcam;
const post = createPostFX(ctx);            ctx.post = post;
const hud = createHUD(ctx);                ctx.hud = hud;
const horse = createHorse(ctx);            ctx.horse = horse;   scene.add(horse.group);
const enemies = createEnemies(ctx);        ctx.enemies = enemies; scene.add(enemies.group);
const combat = createCombat(ctx);          ctx.combat = combat;
const audio = createAudio(ctx);            ctx.audio = audio;
const quest = createQuest(ctx);            ctx.quest = quest;

// Order matters: world drives wind/light, actors read it, combat reads actors,
// quest reads combat, camera frames the result, hud reports it.
const systems = [world, horse, enemies, player, combat, quest, gcam, audio, hud];

// Audio can only start after a user gesture; headless runs stay silent.
addEventListener('pointerdown', () => audio.start(), { once: true });
addEventListener('keydown', () => audio.start(), { once: true });

let frames = 0, fpsAccum = 0, fps = 0;
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 1 / 20);
  input.poll();
  tod.update(dt);
  for (const s of systems) s.update?.(dt, ctx);
  post.render(dt);
  input.consume();

  fpsAccum += dt; frames++;
  if (fpsAccum >= 0.5) { fps = frames / fpsAccum; frames = 0; fpsAccum = 0; }
}
frame();

// ---- Debug API. Critics and the screenshot harness drive the game through this. ----
window.__GAME = {
  ctx, ready: true,
  get fps() { return fps; },
  setTime(t) { tod.t = t; tod.update(0); },
  teleport(x, z, faceDeg = 0) {
    const y = world.heightAt(x, z);
    player.setPosition(x, y, z, faceDeg);
    gcam.snap();
  },
  drive(fields) { input.scripted = true; Object.assign(input, fields); },
  release() { input.scripted = null; },
  poseCount: 0,
};
