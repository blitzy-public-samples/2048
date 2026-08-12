/**
 * The mute and volume bounds, declared once for the two layers that share
 * them.
 *
 * src/config/ is the neutral home: it imports nothing from src/ui/,
 * src/audio/, src/engine/, src/render/ or src/observability/, so both
 * consumers reach it without either reaching the other. Each re-exports these
 * names under its own published names, so no caller of either was changed.
 *
 * Declarations only. No platform state is read, no mutable state is held and
 * nothing is done on load: these are four literals and the relationship
 * between them.
 *
 * Nothing here is ported. js/ plays no sound and exposes no volume, so these
 * are target-only rows of docs/TRACEABILITY_MATRIX.md, one apiece, every row
 * this file owns enumerated:
 *   TR-AUDIO-08  target-only row  `MIN_VOLUME`, the silence bound
 *   TR-AUDIO-09  target-only row  `MAX_VOLUME`, the unattenuated bound
 *   TR-AUDIO-10  target-only row  `DEFAULT_VOLUME`, the volume in force
 *                                 before anything is chosen
 *   TR-AUDIO-11  target-only row  `DEFAULT_MUTED`, the mute state before
 *                                 anything is chosen
 */

/** Lowest accepted volume: silence. */
export const MIN_VOLUME = 0;

/** Highest accepted volume: unattenuated. */
export const MAX_VOLUME = 1;

/**
 * The volume in force before anything is chosen.
 *
 * Unattenuated, so no attenuation is applied that the player did not ask for;
 * the accessibility surface is what lowers it.
 */
export const DEFAULT_VOLUME: number = MAX_VOLUME;

/** Whether the audio layer is muted before anything is chosen. */
export const DEFAULT_MUTED = false;
