/**
 * G9 human input library — extension/humanize/ (ARCHITECTURE_V2 §6).
 *
 * Pure functions: no I/O, no timers, no clocks, no globals, no browser or
 * Node APIs (rule R2), so the extension's service worker and the daemon
 * import the very same file. Every planner takes a seeded generator and a
 * profile and returns a Plan — a timed list of Input.dispatch* events — which
 * extension/lib/humanize.js performs. Same seed, same profile, same intent:
 * the same plan, to the millisecond and the pixel.
 *
 * docs/HUMANIZE.md explains the model, every parameter and the honest limits.
 */

export { createRng, hashSeed } from './prng.js';
export { PROFILES } from './profiles.js';
export { resolveProfile, validateProfile, PROFILE_SCHEMA, LEVELS } from './profile.js';
export {
  planMove, pickTargetPoint, planClick, planHover, planDrag,
  fittsDuration, minimumJerk, BUTTONS, buttonName,
} from './mouse.js';
export { planScroll, notchesFor } from './wheel.js';
export {
  planType, planKeyPress, keyDefinition, physicalKey, shiftedOf, parseKeySpec,
  isKnownKey, directDefinition, KEY_TEXT_CAP,
  MODIFIERS, modifierMask, modifierList, QWERTY_NEIGHBOURS,
} from './keys.js';
export {
  effectiveText, validatePlan, sequence, planGap, initialPointer,
} from './plan.js';
export { fitProfile, MIN_SAMPLES } from './calibrate.js';
