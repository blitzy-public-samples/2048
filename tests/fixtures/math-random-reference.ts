// The platform's own `Math.random`, captured before any product module runs.
//
// Validation gate V2 requires an assertion that the product never patches
// `Math.random`. That assertion is only worth anything if the reference it
// compares against was read before the modules under test were initialised: a
// module that patched the platform generator while being imported would
// otherwise become the baseline every later comparison agreed with.
//
// This module exists so that reference can be taken first. A test file imports
// it as its first import declaration, and an ES module's dependencies are
// evaluated in the order their import declarations appear, so this file's body
// runs before the body of any module declared after it. Nothing here imports
// from src/, so the capture cannot be preceded by product code through this
// file's own dependencies either.
//
// The reference is also usable the other way round: a suite that wants a
// genuinely fresh initialisation calls `vi.resetModules()`, imports the modules
// under test dynamically, and compares against the value captured here.
//
// Provenance — the two randomness call sites Contract 6 replaced, and the only
// two the repository ever held:
//   js/game_manager.js L71  var value = Math.random() < 0.9 ? 2 : 4;
//   js/grid.js L41          cells[Math.floor(Math.random() * cells.length)]
//
// `Math.random` is read here and never written. This module assigns to no
// global, installs no hook, registers no test hook and holds no state beyond
// the two constants below.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

/**
 * `Math.random` as this environment supplied it, read at module evaluation.
 *
 * Compared by identity, never called: a suite asserting the invariant needs the
 * reference, not its output.
 */
export const PLATFORM_MATH_RANDOM: () => number = Math.random;

/**
 * The property descriptor `Math.random` was installed under, read at module
 * evaluation.
 *
 * A patch that replaced the function through `Object.defineProperty` rather
 * than by assignment is visible here even where the two functions compare
 * equal: the descriptor's own attributes change with it.
 */
export const PLATFORM_MATH_RANDOM_DESCRIPTOR: PropertyDescriptor | undefined =
  Object.getOwnPropertyDescriptor(Math, 'random');
