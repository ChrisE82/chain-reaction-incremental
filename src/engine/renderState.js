// src/engine/renderState.js
// Shared mutable render state. Updated by calcUnits() in main.js on each resize.
// Import this object in any module that needs canvas/scale/offset values.

export const rs = {
  ctx:              null,   // set to canvas.getContext('2d') during init
  canvas:           null,   // set to the canvas element during init
  gameScale:        1,
  gameOffsetX:      0,
  gameOffsetY:      0,
  gamePlayH:        178,
  W:                0,
  H:                0,
  dpr:              1,
  currentArenaScale: 1,     // updated each frame in main.js loop
}
