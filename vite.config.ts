// Vite configuration for the static 2048 bundle.
//
// Supersedes Rakefile, the repository's only previous build-tooling entry
// point, and the hand-run Ruby Sass CLI that produced the committed
// style/main.css.
//
// CONFIGURED HERE
//   entry    the root index.html, whose one `<script type="module">` reaches
//            src/main.ts. src/main.ts imports style/main.scss, so the
//            stylesheet enters through the module graph; the source HTML
//            carries no stylesheet <link> of its own.
//   output   dist/ — index.html plus hash-named JS, CSS, font and image
//            assets, and one source map.
//   base     relative. Emitted URLs resolve against index.html.
//   css      SCSS through Dart Sass, the `sass` dependency, which Vite
//            selects with no preprocessor options.
//   servers  `vite` on 5173 with HMR; `vite preview` on 4173 over dist/.
//
// NOT CONFIGURED HERE
//   - build.ssr, ssr.*, and every server-side-rendering, API-route,
//     middleware and serverless-adapter option. dist/ runs no server process
//     and needs no Node process to be served.
//   - plugins of any kind, including legacy browser targeting, service
//     worker, web app manifest and offline caching.
//   - resolve.alias. Import specifiers are plain relative paths, matching
//     tsconfig.json, vitest.config.ts and vitest.snapshot.config.ts.
//   - define, esbuild.drop, pure annotations and build.minify overrides.
//     Nothing removes console, debugger or Performance API calls from the dev
//     server or from dist/; the src/observability surface reaches both.
//   - css.preprocessorOptions, including loadPaths, additionalData,
//     silenceDeprecations, fatalDeprecations and logger overrides. Vite 8
//     exposes only the modern Sass compiler API, and every @use and @import
//     under style/ resolves relatively. Sass deprecation warnings are
//     reported and are not build failures.
//   - additional build inputs and HTML globbing. The entry graph is the root
//     index.html alone; blitzy-deck/ and docs/ are outside it.
//
// Rationale for every decision embodied here: docs/DECISION_LOG.md.
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs in the emitted HTML and CSS. The dev server serves
  // from '/'.
  base: './',

  // No directory is copied verbatim into the output. favicon.ico and the
  // three meta/*.png files reach dist/ as assets referenced by index.html,
  // with their hrefs rewritten to the emitted files.
  publicDir: false,

  build: {
    // Directory name published to .gitignore, README.md and the CI workflow.
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,

    // Language level of tsconfig.json's `target`.
    target: 'es2022',

    // Source map for the built JavaScript, emitted as a static file beside it.
    sourcemap: true,
  },

  server: {
    port: 5173,
    // Binds every interface. The server answers on 127.0.0.1 and on the
    // container address.
    host: true,
  },

  preview: {
    // Port that playwright.config.ts starts and polls when PREVIEW_PORT is
    // unset. `--port` and `--strictPort` on the command line override it;
    // parallel clones offset the port that way.
    port: 4173,
    host: true,
  },
});
