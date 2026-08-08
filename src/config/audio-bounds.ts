/**
 * The mute and volume bounds, declared once for the two layers that share them.
 *
 * WHY THIS MODULE EXISTS
 *   Two layers need these four values and neither may depend on the other. The
 *   accessibility surface (src/ui/a11y/settings.ts) holds the player's volume
 *   and mute PREFERENCE and has to validate and confine what it is given; the
 *   audio layer (src/audio/sound-map.ts and its engine) applies that preference
 *   to a master gain and has to confine it again at the point of use, because
 *   the engine is usable with no preference store at all.
 *
 *   They were declared twice, in both places, and the two declarations
 *   DISAGREED on the starting volume — so which volume a player heard depended
 *   on which of the two owners had last written the master gain. Collapsing them
 *   onto one declaration fixed that, but the declaration was put in the audio
 *   layer and re-exported by the accessibility surface, which made the leaf of
 *   the src/ui/ import graph depend on src/audio/ — an inversion its own
 *   contract forbids, since a preference is a preference whether or not this
 *   build ever plays a sound.
 *
 *   src/config/ is the neutral home: it imports nothing from src/ui/,
 *   src/audio/, src/engine/, src/render/ or src/observability/, so both
 *   consumers reach it without either reaching the other. Each re-exports these
 *   names under its own published names, so no caller of either was changed.
 *
 * DECLARATIONS ONLY. No platform state is read, no mutable state is held and
 * nothing is done on load: these are four literals and the relationship between
 * them.
 *
 * Nothing here is ported. js/ plays no sound and exposes no volume, so these
 * are target-only rows of docs/TRACEABILITY_MATRIX.md.
 */

/**
 * Lowest accepted volume: silence.
 *
 * The value a mute applies to the master gain, rather than a separate muted
 * flag on the gain node, so unmuting restores the volume that was in force.
 */
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
