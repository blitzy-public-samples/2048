# 2048
A small clone of [1024](https://play.google.com/store/apps/details?id=com.veewo.a1024), based on [Saming's 2048](http://saming.fr/p/2048/) (also a clone). 2048 was indirectly inspired by [Threes](https://asherv.com/threes/).

Made just for fun. [Play it here!](http://gabrielecirulli.github.io/2048/)

The official app can also be found on the [Play Store](https://play.google.com/store/apps/details?id=com.gabrielecirulli.app2048) and [App Store!](https://itunes.apple.com/us/app/2048-by-gabriele-cirulli/id868076805)

### Contributions

[Anna Harren](https://github.com/iirelu/) and [sigod](https://github.com/sigod) are maintainers for this repository.

Other notable contributors:

 - [TimPetricola](https://github.com/TimPetricola) added best score storage
 - [chrisprice](https://github.com/chrisprice) added custom code for swipe handling on mobile
 - [marcingajda](https://github.com/marcingajda) made swipes work on Windows Phone
 - [mgarciaisaia](https://github.com/mgarciaisaia) added support for Android 2.3

Many thanks to [rayhaanj](https://github.com/rayhaanj), [Mechazawa](https://github.com/Mechazawa), [grant](https://github.com/grant), [remram44](https://github.com/remram44) and [ghoullier](https://github.com/ghoullier) for the many other good contributions.

### Screenshot

<p align="center">
  <img src="https://cloud.githubusercontent.com/assets/1175750/8614312/280e5dc2-26f1-11e5-9f1f-5891c3ca8b26.png" alt="Screenshot"/>
</p>

That screenshot is fake, by the way. I never reached 2048 :smile:

## Building and running

Development and release builds run on npm. The pinned runtime is Node.js `24.19.0` — `.nvmrc` carries that version so `nvm use` selects it, and `package.json` requires Node `>=24.19.0` with npm `>=11.0.0`.

Install the dependencies once with `npm install`, then run any of the scripts below. They are the whole script surface; which of them the source tree can currently satisfy is recorded under [What runs today](#what-runs-today).

 - `npm run dev` — start the development server, with hot module replacement, on `http://127.0.0.1:5173`
 - `npm run build` — write the production bundle to `dist/`
 - `npm run preview` — serve the built `dist/` on `http://127.0.0.1:4173`, the way a static host would
 - `npm run typecheck` — type-check the application sources, the tests and the build tooling
 - `npm test` — run the unit suite
 - `npm run test:snapshot` — run the seeded snapshot suite, a separate regression gate
 - `npm run test:e2e` — run the browser suite that records the gameplay video; `npm run e2e:install` fetches the browser it needs the first time

Both servers bind `127.0.0.1` and no other interface, so those two URLs answer on this machine only. Reaching a server from another device is an explicit opt-in: `npm run dev -- --host <address>`, or `npm run preview -- --host <address>`.

### What runs today

The TypeScript rewrite is landing in stages. At this commit:

 - `npm install`, `npm run typecheck`, `npm run dev`, `npm run build` and `npm run preview` all work as described. The type check covers `src/`, `tests/` and the four tooling configs and reports no diagnostics, and the build writes a static bundle to `dist/`.
 - The board is drawn by the Three.js renderer where a WebGL context is available, and by the number-only renderer where one is not or where the number-only preference is set. `src/main.ts` probes the context at startup, picks accordingly, and switches modes when the preference changes without a reload. The number-only renderer is therefore both a first-class accessible rendering mode and the WebGL fallback.
 - The run is persisted and resumed. `src/run/run-controller.ts` reads the versioned run-state envelope before anything else is composed, plays the seed and the run identifier it finds there, resumes each RNG substream from the draw count it recorded, supplies the engine's stage and relic contexts from it, and writes it back on every commit. A reload therefore continues the run it interrupted — same seed, same sequence, same stage — rather than starting a new one. The envelope lives under its own namespaced key and WRAPS a copy of the board snapshot: `gameState` remains the board's home and `bestScore` keeps its frozen string format, so a save written by the original game still loads. Stage goals advance along the configured ladder as they are met. The relic modules have landed — the relic types, the four families, the registry and the seeded draw — but nothing outside `src/relics/` constructs them yet and the reward screen has not landed, so the relic context stays empty until an envelope carrying relics is loaded.
 - `npm test` runs the unit suite and passes: the suites under `tests/unit/` cover the grid, the tiles and the move resolver, the hook bus and the typed event contract, the rules and stage configuration, the seeded RNG and its substreams, the storage layer and the frozen best-score contract, the run-state envelope and the run controller, both board renderers and the selection between them, the input layer and the on-screen controls, the screen router and the settings dialog, the live-region announcer and its engine translation, the palette contrast floors, and the structured logger, the metrics registry, the diagnostics surface, the tracer and the health surface. Further suites drive the real composition root end to end — the input wiring, the run persistence, and the observability wiring, which asserts the logger, the registry, the tracer, the health surface and the diagnostics surface against the running page. Board, storage, relic and WebGL fixtures live in `tests/fixtures/`.
 - `npm run test:snapshot` runs the seeded snapshot gate and passes: three spec files under `tests/snapshot/` with their stored snapshots under `tests/snapshot/__snapshots__/`. `seeded-boards.spec.ts` records a seed plus a move list producing an exact board — across five seeds, the four non-empty board fixtures, five board sizes and four configured rule changes. `seeded-rewards.spec.ts` records two layers: the RNG draw primitives a rarity-weighted 1-of-3 reward offer is assembled from — the raw rarity draws and the shrinking-pool positions, which carry no relic identifier and are therefore insensitive to the catalogue's membership and order — and, in its final section, the offers the composed production path actually makes, by relic identifier, rarity, charge budget and bound hooks. `reload-continuity.spec.ts` records that a run torn down mid-list and rebuilt from storage alone reaches byte-for-byte the state an uninterrupted run reached. The gate is separate from `npm test` on both directory and file suffix, and neither collects the other's specs. Snapshots are never rewritten by `npm run test:snapshot`; re-recording is the explicit `vitest run --config vitest.snapshot.config.ts -u`, which is a decision to declare every previously recorded run unreproducible.
 - `npm run test:e2e` builds and serves `dist/` and then finds no spec to run, because `tests/e2e/gameplay-recording.spec.ts` has not landed, so no gameplay video exists yet.
 - `src/observability/` carries five modules: the structured logger, the metrics registry, the diagnostics surface, the Performance-API tracer and the health surface. `src/main.ts` constructs all five. Spans are opened across the input, move-resolution, hook-dispatch, relic-handler, render-commit and frame-callback boundaries; the six capability probes are performed and rolled up by the health surface, which also derives the renderer and storage readiness verdicts; and the diagnostics surface reads the registry, the tracer and the health surface. All five are exercised by the unit suite.

### Observability available today

All five observability modules are in place, all five are constructed by `src/main.ts`, and each is exercisable from a unit test or from a running page right now:

 - `src/observability/logger.ts` — structured JSON log records carrying the run correlation identifier, a level filter, a subscriber registry, a bounded recent-record buffer with a JSON-lines export, and the three reporter adapters the engine, input and storage layers each declare a contract for. It holds the single derivation of a run correlation identifier: `deriveCorrelationId(runSeed, runId)`. Passing the run instance identifies one run; passing the seed alone groups every replay of that seed under one value, and the instance form keeps that seed-derived prefix so a stream can still be grouped by seed. `src/main.ts` uses the instance form. Exercise it with `npx vitest run --config vitest.config.ts tests/unit/observability/logger.test.ts`, or open the page and read any console record: every one carries the identifier.
 - `src/observability/metrics.ts` — the in-page counter, gauge and histogram registry, the canonical `game2048_*` family names, the pull integration with the hook bus's dispatch counts, `toPrometheusText()` for the Prometheus text exposition, `snapshot()` for the JSON form and `download()` for the file. Every count and timing any layer reports now lands here: the sink in `src/main.ts` normalises each dotted report name into the `game2048_` namespace and keeps the original as a `report` label. Exercise it with `npx vitest run --config vitest.config.ts tests/unit/observability/metrics.test.ts`.
 - `src/observability/diagnostics-overlay.ts` — the in-page surface that reads the registry, standing in for the metrics endpoint a static bundle has no server to serve. It renders the run panel, the health panel read from the health surface, the trace panel read from the tracer, the per-hook dispatch counts pulled from the hook bus, the metric series with per-histogram quantiles and the recent log records, and offers refresh, export and close controls. Exercise it with `npx vitest run --config vitest.config.ts tests/unit/observability/diagnostics-overlay.test.ts`, or run `npm run dev` and call `__blitzy2048.diagnostics.open()` from the browser console. The bootstrap publishes the running application under that name for exactly this purpose, and it carries `diagnostics`, `logger`, `metrics`, `tracer` and `health` alongside the engine.
 - `src/observability/tracer.ts` — the Performance-API span recorder: one span per module boundary of the input -> engine -> hook bus -> relic handler -> render -> frame chain, `performance.mark`/`measure` pairs where the platform offers them, a bounded span buffer, the frame-budget statistics and the turn-latency histogram. `src/main.ts` constructs one tracer, attaches the turn and stage spans to the engine's emitter, injects the hook-dispatch and relic-handler wrappers into the hook bus, subscribes the renderer through the render-commit wrapper and hands the frame lifecycle pair to the render loop. Exercise it with `npx vitest run --config vitest.config.ts tests/unit/observability/tracer.test.ts`, or run `npm run dev` and call `__blitzy2048.tracer.snapshot()` from the browser console.
 - `src/observability/health.ts` — the six capability checks, their three-state roll-up report, the per-check log record, the per-check status gauge and the renderer and storage readiness verdicts. `src/main.ts` constructs one surface, hands it the live storage manager so the construction-time probe result is reused, logs the readiness verdict at startup and passes the surface to the diagnostics health panel. Exercise it with `npx vitest run --config vitest.config.ts tests/unit/observability/health.test.ts`, or call `__blitzy2048.health.report()` from the browser console.

Health is reported for six capability probes: `Function.prototype.bind`, `Element.classList`, `requestAnimationFrame`, the resolved pointer event family, Web Storage writability and the WebGL context the Three.js renderer needs. The last is new; the other five were already being performed by the original sources and their results were discarded, so reporting them is the reuse Rule 3 asks for. Three are performed by `src/observability/health.ts` itself and three by the modules that own them — `detectPointerEventFamily` in `src/input/touch-input.ts`, `probeWebStorage` in `src/storage/local-storage-manager.ts` and `probeWebGLSupport` in `src/render/webgl-support.ts`. Each verdict is recorded as a gauge as well as shown, so the exported snapshot carries the same answers as the panel.

The tracer and the health surface are reached by the composition root. `src/observability/tracer.ts` opens one `input.dispatch` span per input, nests `engine.move.resolve`, `hook.dispatch` and `relic.handler` under it, spans each renderer commit as `render.commit`, spans each frame callback as `render.frame`, and opens an `engine.turn` span from `move:before` through `state:commit` alongside an `engine.stage` span per stage; `src/observability/health.ts` performs the six probes, rolls them up into a three-state report and derives the renderer and storage readiness verdicts the page logs at startup. Both are handed to the diagnostics surface, and both are on the object `start()` returns, so `__blitzy2048.tracer.snapshot()` and `__blitzy2048.health.report()` answer from the running page. Exercise them with `npx vitest run --config vitest.config.ts tests/unit/observability/tracer.test.ts`, the matching `health.test.ts`, and `tests/unit/observability/composition.test.ts` for the wiring. `docs/OBSERVABILITY.md` and the two dashboard templates under `docs/dashboards/` have not landed; the exact local workflow for each surface is documented once, in `docs/OBSERVABILITY.md`, when that document lands.

### Deploying

The build is configured so that one install and one build command — `npm install`, then `npm run build` — is the entire path from a clean machine to a deployable folder. Its output is a fully static bundle in `dist/`: HTML, CSS and JavaScript, plus the font and image assets they reference.

Deployment is copying `dist/` to any static host — GitHub Pages, Netlify, S3, or a directory on a machine that serves files. There is no server, no server-side rendering, no API routes and no serverless functions, and nothing in `dist/` needs a Node process at runtime.

### Opening the game locally

The game used to run straight from the filesystem, by opening `index.html` over `file://` with no preprocessing. It no longer does: the page loads a single ES module, and a module graph needs a served origin. Use `npm run dev` while developing, or `npm run preview` for the built output.

### Further documentation

`docs/` has not landed at this commit. Each document below arrives with the code it describes, so this is the map of where a subject is documented rather than a reading list available now.

 - [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md) — Figure 1, *As-Is Architecture: Layered Globals with a Push-Based Actuator*, and Figure 2, *To-Be Architecture: Event-Driven Engine with Subscribed Renderer and Hook Bus*
 - [`docs/architecture/component-interaction.md`](docs/architecture/component-interaction.md) — Figure 3, *Component Interaction: Input, Engine, Hook Bus, Relics, Renderer, Persistence*
 - [`docs/architecture/data-flow.md`](docs/architecture/data-flow.md) — Figure 4, *Turn Data Flow: From Keystroke to Composited Frame and Persisted Run State*, and Figure 7, *Seeded Determinism: One Run Seed Fanned into Named RNG Substreams*
 - [`docs/architecture/hook-dispatch-sequence.md`](docs/architecture/hook-dispatch-sequence.md) — Figure 5, *Hook Dispatch Sequence: Pickup-Order Fan-Out with Charge Guard and Error Isolation*
 - [`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md) — the logging, tracing, metrics and health surfaces, and how to exercise each one against `npm run dev`
 - [`docs/DECISION_LOG.md`](docs/DECISION_LOG.md) — the decisions behind the toolchain and the architecture, with their alternatives and risks; rationale lives there and nowhere else. Every TypeScript module under `src/`, every stylesheet under `style/` and each of the four TypeScript tooling configurations cites the `DL-*` identifiers of the decisions behind it rather than restating them; a test suite that is a decision's designated evidence cites that decision's identifier, and the suites for the engine, config, RNG, storage, health and tracer layers do. `CONTRIBUTING.md` carries the complete registry of the `<AREA>` segment
 - [`docs/TRACEABILITY_MATRIX.md`](docs/TRACEABILITY_MATRIX.md) — the bidirectional map from each construct of the retired `js/` sources to the module that carries it now. Every TypeScript module under `src/`, every stylesheet under `style/` and each of the four TypeScript tooling configurations cites the `TR-*` identifiers of its own rows, and a row with no `js/` source is marked target-only

## Contributing
Changes and improvements are more than welcome! Feel free to fork and open a pull request. Please make your changes in a specific branch and request to pull into `master`! If you can, please make sure the game fully works before sending the PR, as that will help speed up the process.

You can find the same information in the [contributing guide.](https://github.com/gabrielecirulli/2048/blob/master/CONTRIBUTING.md) [`CONTRIBUTING.md`](CONTRIBUTING.md) in this repository carries the house rules, and its build, style and testing instructions are the npm commands above.

## License
2048 is licensed under the [MIT license.](https://github.com/gabrielecirulli/2048/blob/master/LICENSE.txt)

## Donations
I made this in my spare time, and it's hosted on GitHub (which means I don't have any hosting costs), but if you enjoyed the game and feel like buying me coffee, you can donate at my BTC address: `1Ec6onfsQmoP9kkL3zkpB6c5sA4PVcXU2i`. Thank you very much!
