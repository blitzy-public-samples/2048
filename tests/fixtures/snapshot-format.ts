// Stable text renderings of engine and run state, for the seeded snapshot
// gate.
//
// Decisions: DL-FIXTURE-04 (docs/DECISION_LOG.md).

import type { SerializedGameState, SerializedTile } from '../../src/engine/types';
import { RNG_STREAM_NAMES } from '../../src/rng/rng-streams';
import type { RngCursorMap, RngStreams } from '../../src/rng/rng-streams';
import type { RunState } from '../../src/run/run-state';

/** Width of one rendered cell. Fits every tile value the ramp defines. */
const CELL_WIDTH = 6;

/** What an empty cell renders as. */
const EMPTY_CELL = '.';

/** What a cell holding something other than a tile renders as. */
const MALFORMED_CELL = '?';

/** One cell of a serialised grid, or `null`. */
function readCell(value: unknown): SerializedTile | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  return value as SerializedTile;
}

/**
 * Renders one board as a fixed-width grid under a metadata line.
 *
 * @param state Board snapshot to render.
 * @returns The rendering, with no trailing newline.
 */
export function formatBoard(state: SerializedGameState): string {
  const size = state.grid.size;
  const lines: string[] = [
    `size ${String(size)}  score ${String(state.score)}  ` +
      `over ${String(state.over)}  won ${String(state.won)}  ` +
      `keepPlaying ${String(state.keepPlaying)}`,
  ];

  for (let y = 0; y < size; y += 1) {
    const rendered: string[] = [];

    for (let x = 0; x < size; x += 1) {
      const column = state.grid.cells[x];
      const cell = Array.isArray(column) ? readCell(column[y]) : null;

      if (cell === null) {
        rendered.push(EMPTY_CELL.padStart(CELL_WIDTH));

        continue;
      }

      const value = cell.value;

      if (typeof value !== 'number') {
        rendered.push(MALFORMED_CELL.padStart(CELL_WIDTH));

        continue;
      }

      const position = cell.position;
      const placed =
        typeof position === 'object' &&
        position !== null &&
        position.x === x &&
        position.y === y;

      rendered.push(
        (placed
          ? String(value)
          : `${String(value)}@${String(position?.x)},${String(position?.y)}`
        ).padStart(CELL_WIDTH),
      );
    }

    lines.push(rendered.join(''));
  }

  return lines.join('\n');
}

/** Renders a cursor map in the substream declaration order. */
export function formatCursors(cursors: RngCursorMap): string {
  return RNG_STREAM_NAMES.map(
    (name) => `  ${name.padEnd(16)}${String(cursors[name])}`,
  ).join('\n');
}

/** Renders the substreams' current cursors. Consumes no draw. */
export function formatStreamCursors(streams: RngStreams): string {
  return formatCursors(streams.snapshotCursors());
}

/** Options that control what a run rendering shows rather than redacts. */
export interface FormatRunOptions {
  /** Show `runId` verbatim. */
  readonly showRunId?: boolean;
}

/** What a redacted run identifier renders as. */
const REDACTED_RUN_ID = '<originated>';

/**
 * Renders one run-state envelope, member by member, in the order the interface
 * declares them.
 *
 * @param state Envelope to render.
 * @param options Whether to show the run identifier.
 * @returns The rendering, with no trailing newline.
 */
export function formatRunState(
  state: RunState,
  options: FormatRunOptions = {},
): string {
  const relics =
    state.relics.length === 0
      ? '  (none)'
      : state.relics
          .map((relic, index) => {
            const charges =
              relic.charges === undefined
                ? 'no charge limit'
                : `${String(relic.charges)} charges`;

            return `  ${String(index + 1)}. ${relic.id} (${charges})`;
          })
          .join('\n');

  return [
    `schemaVersion  ${String(state.schemaVersion)}`,
    `runId          ${options.showRunId === true ? state.runId : REDACTED_RUN_ID}`,
    `seed           ${state.seed}`,
    `stageIndex     ${String(state.stageIndex)}`,
    `stageGoal      ${state.stageGoal.kind} ${String(state.stageGoal.target)}`,
    `goalProgress   ${String(state.goalProgress)}`,
    'rngCursor',
    formatCursors(state.rngCursor),
    'relics (pickup order)',
    relics,
    'board',
    formatBoard(state.board),
  ].join('\n');
}

/** Renders a sequence of drawn numbers, one per line, numbered from 1. */
export function formatDraws(draws: readonly number[]): string {
  return draws
    .map((draw, index) => `  ${String(index + 1).padStart(2)}. ${String(draw)}`)
    .join('\n');
}

/** Renders a sequence of drawn values of any kind, one per line, numbered. */
export function formatPicks(picks: readonly (string | number | undefined)[]): string {
  return picks
    .map(
      (pick, index) =>
        `  ${String(index + 1).padStart(2)}. ${pick === undefined ? '(none)' : String(pick)}`,
    )
    .join('\n');
}
