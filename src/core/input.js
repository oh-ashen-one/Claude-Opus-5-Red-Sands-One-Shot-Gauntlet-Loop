// Keyboard/mouse state. Deterministic override hook for headless critique.
export function createInput(canvas) {
  const keys = new Set();
  const state = {
    move: { x: 0, y: 0 },        // -1..1 strafe / forward
    look: { x: 0, y: 0 },        // accumulated mouse delta, consumed per frame
    sprint: false, attack: false, heavy: false, parry: false, dodge: false,
    interact: false, mount: false, wind: false, stanceCycle: 0, jump: false,
    locked: false, scripted: null, // when scripted, external driver sets fields
  };
  const down = e => {
    keys.add(e.code);
    if (e.code === 'Space') { state.jump = true; e.preventDefault(); }
    if (e.code === 'KeyC' || e.code === 'ControlLeft') state.dodge = true;
    if (e.code === 'KeyE') state.interact = true;
    if (e.code === 'KeyF') state.mount = true;
    if (e.code === 'KeyQ') state.wind = true;
    if (e.code === 'Digit1') state.stanceCycle = 1;
    if (e.code === 'Digit2') state.stanceCycle = 2;
    if (e.code === 'Digit3') state.stanceCycle = 3;
    if (e.code === 'Digit4') state.stanceCycle = 4;
  };
  const up = e => keys.delete(e.code);
  addEventListener('keydown', down);
  addEventListener('keyup', up);
  canvas.addEventListener('mousedown', e => {
    if (!state.locked) { canvas.requestPointerLock?.(); return; }
    if (e.button === 0) state.attack = true;
    if (e.button === 2) state.heavy = true;
  });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  addEventListener('mousemove', e => {
    if (!state.locked) return;
    state.look.x += e.movementX; state.look.y += e.movementY;
  });
  addEventListener('mouseup', e => { if (e.button === 2) state.parry = true; });
  document.addEventListener('pointerlockchange', () => {
    state.locked = document.pointerLockElement === canvas;
  });

  state.poll = () => {
    if (state.scripted) return; // headless driver owns the fields
    state.move.y = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    state.move.x = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    state.sprint = keys.has('ShiftLeft') || keys.has('ShiftRight');
  };
  state.consume = () => {
    state.attack = state.heavy = state.parry = state.dodge = state.jump = false;
    state.interact = state.mount = state.wind = false;
    state.stanceCycle = 0; state.look.x = 0; state.look.y = 0;
  };
  return state;
}
