// The platform's own `Math.random`, captured before any product module runs.
//
// The reference is also usable the other way round: a suite that wants a
// genuinely fresh initialisation calls `vi.resetModules`, imports the modules
// under test dynamically, and compares against the value captured here.
//
// Provenance — the two randomness call sites Contract 6 replaced, and the only
// two the repository ever held: js/game_manager.js L71 var value = Math.random
// < 0.9 ? 2: 4; js/grid.js L41 cells[Math.floor(Math.random * cells.length)]
//
// `Math.random` is read here and never written. This module assigns to no
// global, installs no hook, registers no test hook and holds no state beyond
// the two constants below.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

/**
 * `Math.random` as this environment supplied it, read at module evaluation.
 *
 * Compared by identity, never called: a suite asserting the invariant needs
 * the reference, not its output.
 */
export const PLATFORM_MATH_RANDOM: () => number = Math.random;

/**
 * The property descriptor `Math.random` was installed under, read at module
 * evaluation.
 */
export const PLATFORM_MATH_RANDOM_DESCRIPTOR: PropertyDescriptor | undefined =
  Object.getOwnPropertyDescriptor(Math, 'random');
