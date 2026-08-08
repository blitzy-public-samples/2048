# Contributing
Changes and improvements are more than welcome! Feel free to fork and open a pull request.

Please follow the house rules to have a bigger chance of your contribution being merged.

## House rules

### How to make changes
 - To make changes, create a new branch based on `master` (do not create one from `gh-pages` unless strictly necessary) and make them there, then create a Pull Request to master.
 `gh-pages` is different from master in that it contains sharing features, analytics and other things that have no direct bearing with the game. `master` is the "pure" version of the game.
 - Development runs on npm. It needs Node.js `24.19.0`, the version `.nvmrc` pins, so `nvm use` selects it; `package.json` requires `>=24.19.0` with npm `>=11.0.0`.

   Install the dependencies once with `npm install`, then use `npm run dev` while you work: it serves the game and recompiles your changes, the stylesheet included, as you save them. `npm run build` writes the production bundle to `dist/`, and `npm run preview` serves that bundle the way a static host would. `index.html` no longer opens over `file://`, because the page loads a single ES module and a module graph needs a served origin.
 - If you want to modify the CSS, please edit the SCSS files present in `style/`: `main.scss`, `helpers.scss` and the partials. No compiled stylesheet is committed any more, so there is no generated file to avoid editing: `src/main.ts` imports `style/main.scss`, the CSS enters through the module graph, and the build emits it.

   Design tokens are the one place to take care. `src/theme/tokens.ts` holds the values and `style/_tokens.scss` mirrors them, so change a token on both sides. The build stops with a Sass error if the two disagree.
 - `package.json`'s `scripts` block contains the tasks that help during development. Feel free to add useful tasks if needed.
 - Please use 2-space indentation when editing the TypeScript, SCSS and HTML, and keep lines within 80 columns. Name TypeScript identifiers in camelCase; SCSS selectors and HTML `id` and `class` names are kebab-case, as they already are. The game's sources are TypeScript modules under `src/`; the old `js/` scripts are gone.

   TypeScript `strict` is the gate, configured in `tsconfig.json` for the sources and `tsconfig.node.json` for the build tooling. `npm run typecheck` runs both.
 - Please test your modification thoroughly before submitting your Pull Request. Run `npm run typecheck`, `npm test` and `npm run test:snapshot` before you open it; at this commit those are the three gates with a suite to run.

   `npm run test:snapshot` is its own command because the seeded snapshot suite is a separate regression gate, with its own configuration in `vitest.snapshot.config.ts`; it collects `tests/snapshot/**/*.spec.ts` and `npm test` collects `tests/unit/**/*.test.ts`, and neither picks up the other's specs. Snapshots are never rewritten by a normal run: re-recording is the explicit `vitest run --config vitest.snapshot.config.ts -u`, which declares every previously recorded run unreproducible, so please do it deliberately and say why. `npm run test:e2e` is still configured ahead of its suite and exits reporting that it found no tests until `tests/e2e/gameplay-recording.spec.ts` lands; from that change onwards please run it whenever you touch the renderer or the run flow, and `npm run e2e:install` fetches the browser it needs the first time. The observability surfaces ARE exercisable: `src/observability/` carries the structured logger, the metrics registry, the diagnostics overlay, the tracer and the health surface, the first three are wired into `src/main.ts`, and `npm run dev` then `__blitzy2048.diagnostics.open()` in the browser console opens the overlay. `README.md` records what the source tree can satisfy at this commit.
 - The architecture is documented in diagrams rather than prose, so please read them before changing how the pieces fit together. `docs/architecture/ARCHITECTURE.md` carries Figure 1, *As-Is Architecture: Layered Globals with a Push-Based Actuator*, and Figure 2, *To-Be Architecture: Event-Driven Engine with Subscribed Renderer and Hook Bus*; `docs/architecture/component-interaction.md`, `docs/architecture/data-flow.md` and `docs/architecture/hook-dispatch-sequence.md` carry the component-interaction, data-flow and hook-dispatch figures.

   Please keep rationale out of code comments and put it in `docs/DECISION_LOG.md`, the single place the reasoning behind a non-obvious change is recorded; `docs/OBSERVABILITY.md` covers the observability surfaces. Each of these documents lands with the code it describes. A code comment carries a contract, an invariant, an external constraint, an ordering or timing constraint, or the provenance of a ported behaviour — not the reasoning behind a choice.
 - Two identifier namespaces join the code to those two documents, and a comment cites an identifier rather than repeating what it stands for. `DL-<AREA>-<NN>` names one decision in `docs/DECISION_LOG.md` — for example `DL-TERM-04` or `DL-RNG-01`. A comment states *what* was decided and cites the identifier; the alternatives, the reasoning and the risks belong to the log row alone. `TR-<AREA>-<NN>` names one row of `docs/TRACEABILITY_MATRIX.md`, pairing a construct of the retired `js/` sources with the module that carries it now; a row with no `js/` source is marked target-only. `<AREA>` is the module area — `ENGINE`, `GRID`, `TILE`, `MOVE`, `TERM`, `EVENT`, `HOOK`, `HOOKBUS`, `CONFIG`, `STAGE`, `RNG`, `RUN`, `RUNSTORE`, `STORE`, `RELIC`, `LOG`, `METRIC`, `RAMP`, `THEME`, `TOKEN`, `MATERIAL`, `MESH`, `ANIM`, `CAMERA`, `PARTICLE`, `LOOP`, `NUMBER`, `INPUT`, `CONTROL`, `SCORE`, `LIVE`, `FOCUS`, `SETTINGS`, `A11Y`, `AUDIO`, `MAIN`, `TEST`, `PW`, `FIXTURE` — and `<NN>` is a two-digit ordinal within it. Numbers are never reused once assigned, and a new decision takes the next free ordinal in its area.

### Changes that might not be accepted
The five categories this section used to name — undo/redo features, save/reload features, changes to how the tiles look or their contents, changes to the layout, and changes to the grid size — are superseded, because the run-based roguelike feature set deliberately does all five. That list no longer describes what will be declined.

That feature set is landing in stages, so here is what each of the five categories now covers, and how much of it the game carries at this commit:

 - Undo/redo features — the accepted change is an undo relic, one of the charge-based board-manipulation relics; redo is not part of it. `src/relics/` carries the relic vocabulary, all sixteen relics across the four families, the registry and the seeded 1-of-3 draw. Nothing outside that folder constructs them yet, so no relic is in play
 - Save/reload features — the board and the best score persist as they always did, and run state now persists beside them: `src/run/` carries the versioned envelope, its guarded store and the run controller, and the controller resumes the seed, the RNG cursors and the stage on reload. The active-relic list it carries stays empty until relics are in play
 - Changes to how the tiles look or their contents — the accepted change renders tiles as extruded, emissive blocks, and it is in the game: `src/render/three-renderer.ts` draws the board where a WebGL context is available, and `src/render/number-only-renderer.ts` draws it where one is not or where the number-only preference is set
 - Changes to the layout — the accepted change is a screen flow: run start, in-run HUD, reward screen, stage progress and run summary. The in-run HUD has landed as `src/ui/screens/hud.ts`, and `src/ui/screen-router.ts` owns the game region and the settings overlay; the other four screens have markup roots in `index.html` and no module yet
 - Changes to the grid size — the board dimension is configuration-driven rather than a literal, and this is the one of the five already in the game: `src/config/default-config.ts` carries the size, the engine reads it, and the renderer builds the board from the size each committed state carries

We are still conservative with the core game, so these will have to be evaluated carefully before being merged:

 - Changes to the classic 4×4 move, merge, spawn and win rules, which are preserved as the default experience
 - Changes to the palette, the generated tile colour ramp or the motion vocabulary, which are the default theme and the source the 2.5D materials are derived from. Further palettes and themes are welcome as additions beside them
 - Changes to best-score persistence, whose storage key and format are frozen so an existing best score survives the upgrade

And these are out of scope, so please don't send them: a true 4×4×4 six-axis mode, cross-run meta-progression, any backend, server-side leaderboard or networked seed, an AI solver, and a seed-based replay viewer.

### Changes that are welcome
 - Bug fixes
 - Compatibility improvements
 - "Under the hood" enhancements
 - Small changes that don't have an impact on the core gameplay

Compatibility improvements are measured against the current baseline: a browser with ES modules, which the page needs because it loads a single module graph. The legacy polyfills are gone.

WebGL is not part of that baseline. It is the prerequisite for the 2.5D board that arrives with `src/render/three-renderer.ts`, and where a WebGL context is unavailable the number-only rendering mode is the supported path. That mode is also a first-class accessible way to read the board, and it is what draws the board at this commit whether or not a context is available; `src/render/webgl-support.ts` probes for one and reports the result either way.
