import * as THREE from 'three';
import { createSamurai } from './samurai.js';

// Player locomotion. Movement is momentum-based: a heavy armoured swordsman
// accelerates, leans, and loses speed through sharp reversals.
export async function createPlayer(ctx) {
  const { scene, world } = ctx;
  const root = new THREE.Group();
  root.name = 'player';
  // Yaw FIRST, then pitch and roll. In the default XYZ order the pitch is
  // applied outside the yaw, in world axes, so a terrain lean computed in the
  // body frame would still land on the wrong axis half the time.
  root.rotation.order = 'YXZ';
  scene.add(root);

  const samurai = createSamurai(ctx);
  root.add(samurai.group);
  ctx.samurai = samurai;

  let yaw = 0, speed = 0;
  let vy = 0, airborne = false, airTime = 0;
  // The dodge pose was already authored; without an impulse behind it and a
  // window of invulnerability it was an animation that did nothing, which is
  // most of why evasion read as weightless.
  let dodgeT = 0, dodgeCd = 0, iframes = 0;
  const dodgeDir = new THREE.Vector3(0, 0, 1);
  const DODGE_DUR = 0.26, DODGE_SPEED = 9.6, DODGE_CD = 0.54;
  const IFRAME_START = 0.06, IFRAME_LEN = 0.30;
  // Ground following. A drop deeper than a step is a fall, not a slide; a rise
  // is taken at a finite rate so a lip is stepped rather than teleported up.
  const STEP_DOWN = 0.22, STEP_RATE = 11;
  const want = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const rgt = new THREE.Vector3();

  // Shortest-arc angle difference in (-PI, PI]. The original inline version of
  // this was mangled and made turns snap or stall.
  const angleDelta = (from, to) =>
    THREE.MathUtils.euclideanModulo(to - from + Math.PI, Math.PI * 2) - Math.PI;

  const api = {
    root, group: root, position: root.position, samurai,
    speed: 0, grounded: true, mounted: false, airborne: false,
    dodging: false, invulnerable: false,
    get yaw() { return yaw; },

    setPosition(x, y, z, faceDeg = 0) {
      root.position.set(x, world.heightAt(x, z), z);
      yaw = THREE.MathUtils.degToRad(faceDeg);
      root.rotation.y = yaw;
      speed = 0;
      vy = 0; airborne = false; airTime = 0;
      dodgeT = 0; dodgeCd = 0; iframes = 0;
    },

    update(dt, c) {
      const inp = c.input;
      const camYaw = c.gcam ? c.gcam.yaw : 0;
      fwd.set(Math.sin(camYaw), 0, Math.cos(camYaw));
      rgt.set(fwd.z, 0, -fwd.x);
      want.set(0, 0, 0).addScaledVector(fwd, inp.move.y).addScaledVector(rgt, inp.move.x);

      const mag = Math.min(want.length(), 1);
      const sprinting = inp.sprint && mag > 0.1;
      const maxSpeed = sprinting ? 7.2 : 3.4;

      if (mag > 0.01) {
        want.normalize();
        const target = Math.atan2(want.x, want.z);
        const d = angleDelta(yaw, target);
        // Turning while fast costs speed — the body has to fight its momentum.
        const turnRate = THREE.MathUtils.lerp(11, 5.5, THREE.MathUtils.clamp(speed / 7.2, 0, 1));
        yaw += THREE.MathUtils.clamp(d, -turnRate * dt, turnRate * dt);
        speed -= Math.min(Math.abs(d) * speed * 1.5 * dt, speed * 0.6 * dt);
      }

      // Slopes cost speed uphill and give a little back downhill.
      const n = world.normalAt(root.position.x, root.position.z);
      const uphill = -(Math.sin(yaw) * n.x + Math.cos(yaw) * n.z);
      const slopeFactor = THREE.MathUtils.clamp(1 - uphill * 1.4, 0.45, 1.2);

      const accel = mag > 0.01 ? (sprinting ? 9 : 12) : 14;   // braking is sharper
      const targetSpeed = mag * maxSpeed * slopeFactor;
      speed += THREE.MathUtils.clamp(targetSpeed - speed, -accel * dt, accel * dt);
      speed = Math.max(0, speed);

      root.position.x += Math.sin(yaw) * speed * dt;
      root.position.z += Math.cos(yaw) * speed * dt;

      /* ---- dodge ---------------------------------------------------------- */
      dodgeCd = Math.max(0, dodgeCd - dt);
      dodgeT = Math.max(0, dodgeT - dt);
      iframes = Math.max(0, iframes - dt);
      if (inp.dodge && dodgeCd <= 0 && !airborne && !api.mounted) {
        // Committed at the moment of the press. No stick means a backstep off
        // the current heading, which is what a swordsman does when he is not
        // already going somewhere.
        if (mag > 0.01) dodgeDir.copy(want);
        else dodgeDir.set(-Math.sin(yaw), 0, -Math.cos(yaw));
        dodgeT = DODGE_DUR; dodgeCd = DODGE_CD; iframes = IFRAME_LEN;
        samurai.playAction('dodge');
      }
      if (dodgeT > 0) {
        // Ease-out burst, so it lands as a shove rather than a speed boost.
        const k = dodgeT / DODGE_DUR;
        const v = DODGE_SPEED * k * k;
        root.position.x += dodgeDir.x * v * dt;
        root.position.z += dodgeDir.z * v * dt;
        speed = Math.max(speed, v * 0.55);      // the gait keeps up with the burst
      }
      api.speed = speed;
      api.dodging = dodgeT > 0;
      // Active frames start a touch after the press and end before recovery.
      api.invulnerable = iframes > 0 && iframes <= IFRAME_LEN - IFRAME_START;

      // Jump. Vertical is integrated separately from ground-following so the
      // character genuinely leaves the surface instead of sliding along it.
      const ground = world.heightAt(root.position.x, root.position.z);
      if (inp.jump && !airborne && !api.mounted && dodgeT <= 0) {
        vy = 6.2 + Math.min(speed, 7.2) * 0.16;   // a run gets you a little more
        airborne = true; airTime = 0;
        samurai.playAction('dodge');              // the crouch-and-spring pose
      }
      if (airborne) {
        airTime += dt;
        vy -= 19.6 * dt;                          // gravity
        root.position.y += vy * dt;
        if (root.position.y <= ground && vy < 0) {
          root.position.y = ground; airborne = false;
          // Every landing costs something. The rig takes the impulse as a
          // pelvis spring, so a hop reads as a small compression and a real
          // drop folds him into a crouch; only a long fall also staggers.
          samurai.impact(-vy);
          if (airTime > 0.35) {                   // a real drop lands with weight
            samurai.playAction('stagger');
            if (c.gcam && c.gcam.kick) c.gcam.kick(Math.min(0.30, airTime * 0.24), 0.22);
          }
          vy = 0; airTime = 0;
        }
      } else {
        // This used to be a hard snap onto heightAt(), so running off a lip
        // teleported him down it instead of falling, and a sharp rise punched
        // the whole body upward inside one frame. Rises are now taken at a
        // finite rate — a step, not a jolt — and a drop deeper than a step
        // hands over to the airborne integrator and lets gravity do the work.
        const dy = ground - root.position.y;
        if (dy < -STEP_DOWN) {
          airborne = true; airTime = 0; vy = 0;
          root.position.y -= STEP_RATE * dt;
        } else if (dy > 0) {
          root.position.y += Math.min(dy, STEP_RATE * dt);
        } else {
          root.position.y += Math.max(dy, -STEP_RATE * dt);
        }
      }
      api.airborne = airborne;
      api.grounded = !airborne;
      root.rotation.y = yaw;

      // Plant the body on the surface rather than standing bolt upright on a
      // hill. The normal has to be rotated into the BODY frame first: using
      // n.x and n.z raw pinned the lean to world axes, so he leant the same way
      // on a slope no matter which direction he was facing — pivot on a hillside
      // and the roll stayed nailed to the world instead of following him round.
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      const lat = n.x * cy - n.z * sy;            // slope across the body, +X is left
      const fwdN = n.x * sy + n.z * cy;           // slope along the way he faces
      const tilt = 0.42;
      root.rotation.z = THREE.MathUtils.damp(root.rotation.z, -lat * tilt, 6, dt);
      root.rotation.x = THREE.MathUtils.damp(root.rotation.x, fwdN * tilt, 6, dt);

      if (inp.attack) samurai.playAction('attack_light');
      else if (inp.heavy) samurai.playAction('attack_heavy');
      else if (inp.parry) samurai.playAction('parry');

      samurai.update(dt, { speed, moving: speed > 0.12, sprinting, grounded: !airborne });
    },
  };

  // The quest repositions this on its first frame; this is only the pre-quest default.
  api.setPosition(-159, 0, 885, 200);
  return api;
}
