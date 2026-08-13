# Contributing

Changes and improvements are more than welcome! Feel free to fork and open a
pull request.

Please follow the house rules to have a bigger chance of your contribution being
merged.

## House rules

### How to make changes

 - To make changes, create a new branch based on `master` (do not create one
   from `gh-pages` unless strictly necessary) and make them there, then create a
   Pull Request to master.

   `gh-pages` is different from master in that it contains sharing features,
   analytics and other things that have no direct bearing with the game.
   `master` is the "pure" version of the game.

 - Development runs on npm. It needs Node.js `24.19.0`, the version `.nvmrc`
   pins, so `nvm use` selects it; `package.json` requires `>=24.19.0` with npm
   `>=11.0.0`.

   Install the dependencies once with `npm install`, then use `npm run dev`
   while you work: it serves the game and recompiles your changes, the
   stylesheet included, as you save them. `npm run build` writes the production
   bundle to `dist/`, and `npm run preview` serves that bundle the way a static
   host would. `index.html` no longer opens over `file://`, because the page
   loads a single ES module and a module graph needs a served origin.

   Dependencies are pinned exactly — no range, no `latest` — and
   `package-lock.json` is committed, so please commit the lockfile change with
   the manifest change that caused it and keep the two in step; CI installs with
   `npm ci`, which fails when they disagree (`DL-CI-03`). One transitive package
   is held at a version of its own through `package.json`'s `overrides` block
   (`DL-BUILD-19`). CI also runs `npm audit --audit-level=moderate` as its first
   quality stage, so an advisory published against anything in the tree fails
   the build rather than waiting for a review to find it (`DL-CI-07`); run
   `npm audit` yourself after any dependency change.

 - If you want to modify the CSS, please edit the SCSS files present in
   `style/`: `main.scss`, `helpers.scss` and the partials. No compiled
   stylesheet is committed any more, so there is no generated file to avoid
   editing: `src/main.ts` imports `style/main.scss`, the CSS enters through the
   module graph, and the build emits it.

   Design tokens are the one place to take care. `src/theme/tokens.ts` holds the
   values and `style/_tokens.scss` mirrors them, so change a token on both
   sides. The build stops with a Sass error if the two disagree.

 - `package.json`'s `scripts` block contains the tasks that help during
   development. Feel free to add useful tasks if needed.

 - Please use 2-space indentation when editing the TypeScript, SCSS and HTML,
   and keep lines within 80 columns. Name TypeScript identifiers in camelCase;
   SCSS selectors and HTML `id` and `class` names are kebab-case, as they
   already are. The game's sources are TypeScript modules under `src/`; the old
   `js/` scripts are gone.

   The 80-column rule is measured in bytes, so a line of prose carrying an
   em-dash or a curly quote is as long as it looks, and it holds for the
   Markdown here as well as for the sources. Two Markdown constructs cannot
   honour it and are exempt, because neither may be broken across source lines:
   a table row, and a Mermaid node label. `docs/DECISION_LOG.md` and
   `docs/TRACEABILITY_MATRIX.md` are almost entirely table rows for that reason;
   the prose around them is wrapped like source (`DL-DOC-06`).

   TypeScript `strict` is the gate, configured in `tsconfig.json` for the
   sources and `tsconfig.node.json` for the build tooling. `npm run typecheck`
   runs both.

 - Please test your modification thoroughly before submitting your Pull
   Request. Run `npm run typecheck`, `npm test` and `npm run test:snapshot`
   before you open it, `npm run test:e2e` as well if you touched the renderer,
   the run flow or the screens, and `npm run lint:styles` if you touched a
   stylesheet. That last one is the gate, and a plain `npx sass
   style/main.scss` is not a stand-in for it: the script adds
   `--fatal-deprecation`, so a deprecation warning fails the command, where the
   plain invocation prints the same warning and still exits `0`
   (`DL-BUILD-17`). Reach for plain `sass` when you want to read the compiled
   CSS, not to clear the gate. `.github/workflows/ci.yml` runs nine quality
   stages against every push and every Pull Request to `master`, in this order:
   the dependency advisory gate, the type check, the stylesheet deprecation
   gate, the unit suite, the snapshot gate, the dashboard gate, the executive
   deck gate, the build, and the recorded proof with the browser variants
   (`DL-CI-02`).

   `npm run test:snapshot` is its own command because the seeded snapshot suite
   is a separate regression gate, with its own configuration in
   `vitest.snapshot.config.ts`; it collects `tests/snapshot/*.spec.ts` — the
   top level of that directory only, so a spec in a subdirectory of it is not
   run — and `npm test` collects `tests/unit/**/*.test.ts` recursively, and
   neither picks up the other's specs. Snapshots are never rewritten by a normal
   run: re-recording is the explicit `vitest run --config
   vitest.snapshot.config.ts -u`, which declares every previously recorded run
   unreproducible, so please do it deliberately and say why.

   `npm run test:e2e` is the recorded gameplay proof, and it is the one gate
   that opens a browser. It builds the bundle, serves it on
   `http://127.0.0.1:4173` itself with `--strictPort` and
   `reuseExistingServer: false`, so a recording can never be made against a
   stale bundle, and runs five cases across five headless-Chromium projects. Two
   of them carry the two cases of `tests/e2e/gameplay-recording.spec.ts`, one
   case each by the tag that case declares. `gameplay-recording` plays a seeded
   run from the run-start screen through a merge, a stage clear and a 1-of-3
   relic reward to a terminal state and on into the run summary, and then
   decodes the file it recorded and makes that file carry the proof itself: a
   finite duration that reaches past the moment the relic was taken, the
   configured frame size, opening frames holding a rendered board rather than a
   black rectangle, the reward dialog and the stage that replaced it each
   located inside the recording by matching a clip taken from the live page and
   found in that order, and the merge measured over the merged tile's own cell,
   asserted disjoint from the cell the same turn spawned into, against both an
   absolute floor and a settled-window baseline — so the spawn animation
   running alongside the merge cannot satisfy the merge test (`DL-PW-08`).
   `diagnostics-surface` exercises the diagnostics overlay and the
   observability surfaces behind it, at the same viewport and with no video of
   its own. The other three — `variant-webgl-unavailable`,
   `variant-reduced-motion` and `variant-mobile` — run one tagged case each of
   `tests/e2e/browser-variants.spec.ts`. Only the recording project captures
   video, so the gate still produces exactly the one R11 artifact. Please run it
   whenever you touch the renderer, the run flow, the screens or the storage
   keys, because those are what it asserts against a real WebGL context rather
   than a DOM emulator.
   Recording is unconditional, so a `video.webm` lands under `test-results/`
   whether the run passed or failed — watch it before you push a rendering
   change, because a recording that exists and shows a blank board still fails
   the gate it exists to satisfy. It takes a little over a minute, most of it the
   filmed run itself, and leaves that video under `test-results/`; a trace and a
   screenshot join it only for a case that failed, because `trace` is
   `retain-on-failure` and `screenshot` is `only-on-failure` (`DL-PW-07`), so
   the video is the one artifact a passing run leaves behind. The HTML report
   lands under `playwright-report/`; both directories are git-ignored, and the
   workflow uploads `test-results/**/*.webm` as an artifact with
   `if-no-files-found: error` instead.

   `npm run e2e:install` provisions what that gate needs, and it needs running
   once rather than per run: it installs the pinned browser build and, on Linux,
   the system packages the browser links against, which means it wants root or
   `sudo` there. On macOS and Windows the system-package half is a no-op. If
   your machine already has those libraries, `npx playwright install chromium`
   installs the browser alone. Port 4173 has to be free, since the gate starts
   its own preview server with `--strictPort`.

   `npm run test:dashboard` is the dashboard-template gate: it feeds real
   exports through `docs/dashboards/dashboard.html` and checks every expression
   in `docs/dashboards/dashboard.json` against the metric families and labels
   the registry declares. `npm test` collects it as well, so run it on its own
   only when you have touched either template, the metrics vocabulary or the
   health check ids.

   `npm run test:deck` is the executive-deck gate: it holds
   `blitzy-deck/executive-summary.html` to the security premises the pinned
   Mermaid release is accepted under (`DL-DOC-09`), and to the presentational
   shape its governing rule fixes (`DL-DOC-14`) — the section count and the
   four slide types, one non-text visual per slide, the four-bullet and
   forty-word body-copy caps, no emoji and no fenced code block, the theme's
   custom-property and component-class sets, the three typefaces at their
   weights, the reveal.js configuration literal, and the figures and icons
   painted on both reveal.js events. Editing a slide can therefore fail this
   gate on a budget rather than on a premise. `npm test` collects it as well,
   so run it on its own only when you have touched the deck.

   The observability surfaces are exercisable: `src/observability/` carries the
   structured logger, the metrics registry, the diagnostics overlay, the tracer
   and the health surface, `src/main.ts` constructs all five, and `npm run dev`
   then `__blitzy2048.diagnostics.open()` in the browser console opens the
   overlay — `__blitzy2048.tracer.snapshot()` and
   `__blitzy2048.health.report()` answer from the same object. That handle is
   published by the boot and cleared when the application is disposed.
   `docs/OBSERVABILITY.md` records what each surface emits and how to reach it,
   and `README.md` carries the shorter route.

 - The architecture is documented in Mermaid diagrams rather than prose, under
   `docs/architecture/`, so please read them before changing how the pieces fit
   together. `ARCHITECTURE.md` carries Figure 1, *As-Is Architecture: Layered
   Globals with a Push-Based Actuator*, and Figure 2, *To-Be Architecture:
   Event-Driven Engine with Subscribed Renderer and Hook Bus*;
   `component-interaction.md`, `data-flow.md` and `hook-dispatch-sequence.md`
   carry the component-interaction, data-flow and hook-dispatch figures. The
   wiring itself is readable from `src/main.ts`, which is the only wiring site,
   and the configuration figure lives in `docs/CONFIGURATION.md`.

 - Please keep rationale out of code comments and put it in
   `docs/DECISION_LOG.md`, the single place the reasoning behind a non-obvious
   change is recorded. That document exists and is current, as do
   `docs/TRACEABILITY_MATRIX.md` and `docs/OBSERVABILITY.md`, which covers the
   observability surfaces: which of the six capability probes were reused and
   which was added, what each surface emits, and the procedure for exercising
   every one of them locally. A code comment carries a contract, an invariant,
   an external constraint, an ordering or timing constraint, or the provenance
   of a ported behaviour — not the reasoning behind a choice, and not a
   restatement of the architecture.

 - Two identifier namespaces join the code to those documents, and a comment
   cites an identifier rather than repeating what it stands for.
   `DL-<AREA>-<NN>` names one decision in `docs/DECISION_LOG.md` — for example
   `DL-TERM-04` or `DL-RNG-01`. A comment states *what* was decided and cites
   the identifier; the alternatives, the reasoning and the risks belong to the
   log row alone. `TR-<AREA>-<NN>` names one row of
   `docs/TRACEABILITY_MATRIX.md`, pairing a construct of the retired `js/`
   sources with the module that carries it now, with a row that has no `js/`
   source marked target-only. **Every row is declared by the one file that owns
   it, in that file's own header, and `tests/unit/quality/` gates both
   namespaces in both directions**: `decision-log-integrity.test.ts` fails a
   `DL-*` citation with no row, and `traceability-matrix.test.ts` fails a `TR-*`
   citation with no row and a row no file declares. So a construct you add takes
   both a row and a citation in the same change, and the citation names the
   retired file and its lines the way every ported module's header already does.
   `<NN>` is a two-digit ordinal, unique within its area and never reused once
   assigned; a new decision or row takes the next free ordinal in its area.

   `<AREA>` names one CONCERN, and the table below is the complete registry of
   them: every `DL-*` and every `TR-*` identifier in the tree resolves to one of
   these, and a new area is added here in the same change that first uses it. A
   concern that spans a TypeScript module and the stylesheet mirroring it —
   accessibility, the HUD, the tokens, the themes — is ONE area, so its
   ordinals are unique across both files.

   Two files are reached by more than one code, and neither is a pattern to
   follow — a new concern takes one code across both namespaces.
   `src/ui/screens/reward.ts` carries its decisions under `REWARD`, beside the
   stylesheet that concern spans, and its traceability rows under
   `REWARDSCREEN`. `src/engine/board-effects.ts` carries traceability rows under
   both `EFFECT` and `EFFECTS`, which is why one registry row names two codes.
   Every one of those codes is registered and resolves to the module named
   beside it, and ordinals are unique within each code.

   | Area | Owner |
   |---|---|
   | `ENGINE` | `src/engine/engine.ts` |
   | `GRID` | `src/engine/grid.ts` |
   | `TILE` | `src/engine/tile.ts` |
   | `MOVE` | `src/engine/move-resolver.ts` |
   | `TERM` | `src/engine/terminal-state.ts` |
   | `EVENT` | `src/engine/engine-events.ts` |
   | `HOOK` | `src/engine/hooks.ts` |
   | `EFFECT`, `EFFECTS` | `src/engine/board-effects.ts` |
   | `HOOKBUS` | `src/engine/hook-bus.ts` |
   | `TYPES` | `src/engine/types.ts` |
   | `CONFIG` | `src/config/rules-config.ts` |
   | `DEFAULT` | `src/config/default-config.ts` |
   | `STAGE` | `src/config/stage-config.ts` |
   | `RNG` | `src/rng/seeded-rng.ts`, `src/rng/rng-streams.ts` |
   | `RUN` | `src/run/run-state.ts` |
   | `RUNSTORE` | `src/run/run-state-store.ts` |
   | `RUNCTL` | `src/run/run-controller.ts` |
   | `STORE` | `src/storage/local-storage-manager.ts`, `src/storage/memory-storage.ts` |
   | `KEYS` | `src/storage/storage-keys.ts` |
   | `RELIC` | `src/relics/relic-types.ts` |
   | `REGISTRY` | `src/relics/relic-registry.ts` |
   | `DRAW` | `src/relics/relic-draw.ts` |
   | `SPAWN` | `src/relics/families/spawn-control.ts` |
   | `MERGE` | `src/relics/families/merge-magic.ts` |
   | `BOARD` | `src/relics/families/board-manipulation.ts` |
   | `RISK` | `src/relics/families/risk-reward-cursed.ts` |
   | `THREE` | `src/render/three-renderer.ts` |
   | `SCENE` | `src/render/scene.ts` |
   | `MESH` | `src/render/tile-mesh-factory.ts` |
   | `MATERIAL` | `src/render/tile-materials.ts` |
   | `ANIM` | `src/render/animations.ts` |
   | `PARTICLE` | `src/render/particles.ts` |
   | `CAMERA` | `src/render/camera-effects.ts` |
   | `NUMBER` | `src/render/number-only-renderer.ts` |
   | `WEBGL` | `src/render/webgl-support.ts` |
   | `LOOP` | `src/render/render-loop.ts` |
   | `TOKEN` | `src/theme/tokens.ts`, `style/_tokens.scss` |
   | `THEME` | `src/theme/themes.ts`, `style/_themes.scss` |
   | `RAMP` | `src/theme/tile-ramp.ts` |
   | `INPUT` | `src/input/input-manager.ts` |
   | `KEYMAP` | `src/input/keymap.ts` |
   | `TOUCH` | `src/input/touch-input.ts` |
   | `CONTROL` | `src/input/on-screen-controls.ts` |
   | `ROUTER` | `src/ui/screen-router.ts` |
   | `HUD` | `src/ui/screens/hud.ts`, `style/_hud.scss` |
   | `RUNSTART` | `src/ui/screens/run-start.ts` |
   | `STAGECLEAR` | `src/ui/screens/stage-progress.ts` |
   | `REWARDSCREEN` | `src/ui/screens/reward.ts` |
   | `GAMEOVER` | `src/ui/screens/game-over.ts` |
   | `CARD` | `src/ui/components/relic-card.ts` |
   | `SCORE` | `src/ui/components/score-panel.ts` |
   | `PANEL` | `src/ui/components/settings-panel.ts` |
   | `LIVE` | `src/ui/a11y/live-region.ts` |
   | `FOCUS` | `src/ui/a11y/focus-manager.ts` |
   | `ANNOUNCE` | `src/ui/a11y/engine-announcer.ts` |
   | `SETTINGS` | `src/ui/a11y/settings.ts` |
   | `A11Y` | `src/ui/a11y/**`, `style/_a11y.scss` |
   | `AUDIO` | `src/audio/sound-engine.ts`, `src/audio/sound-map.ts`, `src/config/audio-bounds.ts` |
   | `LOG` | `src/observability/logger.ts` |
   | `METRIC` | `src/observability/metrics.ts` |
   | `TRACE` | `src/observability/tracer.ts` |
   | `HEALTH` | `src/observability/health.ts` |
   | `DIAG` | `src/observability/diagnostics-overlay.ts` |
   | `MAIN` | `src/main.ts` |
   | `SHEET` | `style/main.scss` |
   | `HELPER` | `style/helpers.scss` |
   | `SCREEN` | `style/_screens.scss` |
   | `REWARD` | `style/_reward.scss`, `src/ui/screens/reward.ts` |
   | `SUMMARY` | `style/_summary.scss`, `src/ui/screens/run-summary.ts` |
   | `BUILD` | `vite.config.ts` |
   | `TEST` | `vitest.config.ts`, `vitest.snapshot.config.ts`, `tests/snapshot/**`, `tests/unit/quality/**` |
   | `PW` | `playwright.config.ts`, `tests/e2e/gameplay-recording.spec.ts` |
   | `CI` | `.github/workflows/ci.yml` |
   | `FIXTURE` | `tests/fixtures/**` |
   | `DOC` | `docs/**`, `README.md`, `CONTRIBUTING.md`, `blitzy-deck/**` |

### Changes that might not be accepted

The five categories this section used to name — undo/redo features,
save/reload features, changes to how the tiles look or their contents, changes
to the layout, and changes to the grid size — are superseded, because the
run-based roguelike feature set deliberately does all five. That list no longer
describes what will be declined. Decision `DL-DOC-02`.

That feature set is landing in stages, so here is what each of the five
categories now covers, and how much of it the game carries at this commit:

 - Undo/redo features — the accepted change is an undo relic, one of the
   charge-based board-manipulation relics; redo is not part of it. `src/relics/`
   carries the relic vocabulary, all sixteen relics across the four families,
   the registry and the seeded 1-of-3 draw, and `src/main.ts` composes them:
   relics are in play, they fire on the six named hooks, and a charge-based one
   spends its charges through the hook bus
 - Save/reload features — the board and the best score persist as they
   always did, and run state now persists beside them: `src/run/` carries the
   versioned envelope, its guarded store and the run controller, and the
   controller resumes the seed, the RNG cursors, the stage and the active relics
   on reload
 - Changes to how the tiles look or their contents — the accepted change
   renders tiles as extruded, emissive blocks, and it is in the game:
   `src/render/three-renderer.ts` draws the board where a WebGL context is
   available, and `src/render/number-only-renderer.ts` draws it where one is not
   or where the number-only preference is set
 - Changes to the layout — the accepted change is a screen flow, and the
   whole of it is in the game: run start, in-run HUD, stage clear, reward,
   terminal verdict and run summary. `src/ui/screen-router.ts` carries the state
   machine, its `TRANSITIONS` table is the whole edge set, and `src/main.ts`
   registers all six screen modules across the seven states —
   `src/ui/screens/run-start.ts`, `hud.ts`, `stage-progress.ts`, `reward.ts`,
   `game-over.ts` for both `won` and `gameOver`, and `run-summary.ts` —
   alongside the game region and the settings overlay. A cold load holds run
   start until the player begins; a met stage goal stops at stage clear until
   they continue; the reward screen renders the seeded 1-of-3 offer and the run
   controller applies the choice; and both terminal states lead to the summary,
   which shows the run that ended and its seed. The router owns focus placement,
   the focus traps, background inerting and the entry announcement for every
   state, and each screen supplies its own entry line
 - Changes to the grid size — the board dimension is configuration-driven
   rather than a literal, and this is the one of the five already in the game:
   `src/config/default-config.ts` carries the size, the engine reads it, and the
   renderer builds the board from the size each committed state carries

We are still conservative with the core game, so these will have to be evaluated
carefully before being merged:

 - Changes to the classic 4×4 move, merge, spawn and win rules, which are
   preserved as the default experience
 - Changes to the palette, the generated tile colour ramp or the motion
   vocabulary, which are the default theme and the source the 2.5D materials are
   derived from. Further palettes and themes are welcome as additions beside
   them
 - Changes to best-score persistence, whose storage key and format are frozen
   so an existing best score survives the upgrade

And these are out of scope, so please don't send them: a true 4×4×4 six-axis
mode, cross-run meta-progression, any backend, server-side leaderboard or
networked seed, an AI solver, and a seed-based replay viewer.

### Changes that are welcome

 - Bug fixes
 - Compatibility improvements
 - "Under the hood" enhancements
 - Small changes that don't have an impact on the core gameplay

Compatibility improvements are measured against the current baseline: a browser
with ES modules, which the page needs because it loads a single module graph.
The legacy polyfills are gone.

WebGL is not part of that baseline. It is the prerequisite for the 2.5D board
`src/render/three-renderer.ts` draws, and where a WebGL context is unavailable
the number-only rendering mode is the supported path.
`src/render/webgl-support.ts` probes for a context at startup and reports the
result either way, and `src/main.ts` selects accordingly: the Three.js board
where a context is available and the number-only preference is not set, the
number-only board otherwise. That mode is therefore both the WebGL fallback and
a first-class accessible way to read the board, and switching the preference
swaps the renderer without a reload.
