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
 - Please use 2-space indentation when editing the TypeScript, SCSS and HTML, keep lines within 80 columns, and name things in camelCase. The game's sources are TypeScript modules under `src/`; the old `js/` scripts are gone.  
 TypeScript `strict` is the gate, configured in `tsconfig.json` for the sources and `tsconfig.node.json` for the build tooling. `npm run typecheck` runs both.
 - Please test your modification thoroughly before submitting your Pull Request. Run `npm run typecheck`, `npm test` and `npm run test:snapshot` before you open it, and `npm run test:e2e` as well if you touched the renderer or the run flow — `npm run e2e:install` fetches the browser it needs the first time.  
 `npm run test:snapshot` is its own command because the seeded snapshot suite is a separate regression gate, with its own configuration in `vitest.snapshot.config.ts`. To exercise the observability surfaces by hand, run `npm run dev` and open the diagnostics overlay. `README.md` records which of these the source tree can satisfy at this commit.
 - The architecture is documented in diagrams rather than prose, so please read them before changing how the pieces fit together. `docs/architecture/ARCHITECTURE.md` carries Figure 1, *As-Is Architecture: Layered Globals with a Push-Based Actuator*, and Figure 2, *To-Be Architecture: Event-Driven Engine with Subscribed Renderer and Hook Bus*; `docs/architecture/component-interaction.md`, `docs/architecture/data-flow.md` and `docs/architecture/hook-dispatch-sequence.md` carry the component-interaction, data-flow and hook-dispatch figures.  
 Please keep rationale out of code comments and put it in `docs/DECISION_LOG.md`, the single place the reasoning behind a non-obvious change is recorded; `docs/OBSERVABILITY.md` covers the observability surfaces. Each of these documents lands with the code it describes.

### Changes that might not be accepted
The five categories this section used to name — undo/redo features, save/reload features, changes to how the tiles look or their contents, changes to the layout, and changes to the grid size — are superseded. The run-based roguelike feature set deliberately does all five, so that list no longer describes what will be declined. `docs/DECISION_LOG.md` carries the supersession record.

Each of the five is now part of the game:

 - Undo and redo — an undo relic, alongside the other charge-based board-manipulation relics
 - Save and reload — run state persists the active relics, the current stage and the run seed, beside the best score
 - How the tiles look — tiles render as extruded, emissive blocks
 - The layout — a screen flow: run start, in-run HUD, reward screen, stage progress and run summary
 - The grid size — the board dimension is configuration-driven rather than a literal

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

Compatibility improvements are measured against the current baseline: a browser with ES modules and WebGL. The legacy polyfills are gone, and where WebGL is unavailable the number-only rendering mode is the supported path.
