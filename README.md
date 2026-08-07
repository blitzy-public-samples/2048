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
 - The board is drawn by the number-only renderer, which is both a first-class accessible rendering mode and the fallback for a machine without WebGL; at this commit it draws the board whether or not a WebGL context is available. The Three.js renderer arrives with `src/render/three-renderer.ts`.
 - `npm test` runs the unit suite and passes: the suites under `tests/unit/` cover the grid, the tiles and the move resolver, the hook bus and the typed event contract, the rules and stage configuration, the seeded RNG and its substreams, the storage layer and the frozen best-score contract, the run-state envelope, the on-screen controls, the live-region announcer and the structured logger. Board and storage fixtures live in `tests/fixtures/`.
 - `npm run test:snapshot` exits reporting no test files. The runner is configured as a separate regression gate, but `tests/snapshot/` holds no spec yet. `npm run test:e2e` builds and serves `dist/` and then finds no spec to run either, because `tests/e2e/gameplay-recording.spec.ts` has not landed, so no gameplay video exists yet.
 - `src/observability/` carries the structured logger and the metrics registry so far, and the unit suite exercises both. The tracer, the health report and the diagnostics overlay that `npm run dev` is to expose arrive with `tracer.ts`, `health.ts` and `diagnostics-overlay.ts` beside them. The stylesheet already carries the overlay's presentation.

### Observability available today

Two of the observability modules are in place, and both are exercisable from a unit test or from application code right now:

 - `src/observability/logger.ts` — structured JSON log records carrying the run correlation identifier, a level filter, a subscriber registry, a bounded recent-record buffer with a JSON-lines export, and the three reporter adapters the engine, input and storage layers each declare a contract for. It holds the single derivation of a run correlation identifier: `deriveCorrelationId(runSeed)`. Exercise it with `npx vitest run --config vitest.config.ts tests/unit/observability/logger.test.ts`, or subscribe a sink to a logger and read `logger.snapshot()`.
 - `src/observability/metrics.ts` — the in-page counter, gauge and histogram registry, the canonical `game2048_*` family names, the pull integration with the hook bus's dispatch counts, `toPrometheusText()` for the Prometheus text exposition, `snapshot()` for the JSON form and `download()` for the file. Exercise it with `npx vitest run --config vitest.config.ts tests/unit/observability/metrics.test.ts`.

Neither is wired into `src/main.ts` yet: the browser build reports through the render sink and writes to the console. The remaining Rule 3 surfaces are planned and not present — `src/observability/tracer.ts`, `src/observability/health.ts` and `src/observability/diagnostics-overlay.ts`, together with `docs/OBSERVABILITY.md` and the two dashboard templates under `docs/dashboards/`. There is no diagnostics overlay to open in `npm run dev` at this commit; the stylesheet already carries its presentation. The exact local workflow for each surface is documented once, in `docs/OBSERVABILITY.md`, when that document lands with the modules it describes.

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
 - [`docs/DECISION_LOG.md`](docs/DECISION_LOG.md) — the decisions behind the toolchain and the architecture, with their alternatives and risks; rationale lives there and nowhere else. Every source file cites the `DL-*` identifiers of the decisions behind it rather than restating them
 - [`docs/TRACEABILITY_MATRIX.md`](docs/TRACEABILITY_MATRIX.md) — the bidirectional map from each construct of the retired `js/` sources to the module that carries it now. Every source file cites the `TR-*` identifiers of its own rows

## Contributing
Changes and improvements are more than welcome! Feel free to fork and open a pull request. Please make your changes in a specific branch and request to pull into `master`! If you can, please make sure the game fully works before sending the PR, as that will help speed up the process.

You can find the same information in the [contributing guide.](https://github.com/gabrielecirulli/2048/blob/master/CONTRIBUTING.md) [`CONTRIBUTING.md`](CONTRIBUTING.md) in this repository carries the house rules, and its build, style and testing instructions are the npm commands above.

## License
2048 is licensed under the [MIT license.](https://github.com/gabrielecirulli/2048/blob/master/LICENSE.txt)

## Donations
I made this in my spare time, and it's hosted on GitHub (which means I don't have any hosting costs), but if you enjoyed the game and feel like buying me coffee, you can donate at my BTC address: `1Ec6onfsQmoP9kkL3zkpB6c5sA4PVcXU2i`. Thank you very much!
