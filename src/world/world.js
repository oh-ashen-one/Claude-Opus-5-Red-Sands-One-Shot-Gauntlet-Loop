import * as THREE from 'three';
import { createTerrain, heightAt, normalAt, slopeAt, ISLAND } from './terrain.js';
import { createSky } from './sky.js';
import { createWind } from './wind.js';
import { createGrass } from './grass.js';
import { createWater } from './water.js';
import { createTrees } from './trees.js';
import { createVFX } from './vfx.js';

export async function createWorld(ctx) {
  const { scene } = ctx;
  const wind = createWind();          ctx.wind = wind;
  const sky = createSky(ctx);         ctx.sky = sky;
  const terrain = createTerrain(ctx); scene.add(terrain);
  const water = createWater(ctx);     scene.add(water.mesh);
  const grass = createGrass(ctx);     scene.add(grass.mesh);
  const trees = createTrees(ctx);     scene.add(trees.group);
  const vfx = createVFX(ctx);         scene.add(vfx.group);

  const subsystems = [sky, water, grass, trees, vfx];

  return {
    terrain, sky, water, grass, trees, vfx, wind, ISLAND,
    heightAt, normalAt, slopeAt,
    update(dt, c) {
      wind.update(dt);
      for (const s of subsystems) s.update?.(dt, c);
    },
  };
}
