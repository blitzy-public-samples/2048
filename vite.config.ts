// Vite configuration for the static 2048 bundle.
//
// The entry graph is the root index.html alone: its one module script reaches
// src/main.ts, which imports style/main.scss, so SCSS compiles through Dart
// Sass into the same graph. `vite build` emits dist/ as a self-contained
// static directory — no SSR entry, API route or serverless adapter is
// configured, and none may be. That directory is the deployed artifact: it
// carries the bundle, the stylesheet and the referenced assets, and no source
// map.
//
// The SCSS pipeline also carries the token bridge: src/theme/tokens.ts declares
// the token values once, reading the board dimension from DEFAULT_BOARD_SIZE of
// src/config/default-config.ts, and emitSassTokenProjection() renders them as
// one Sass map that `css.preprocessorOptions.scss.additionalData` delivers as
// $blitzy-token-projection. style/main.scss passes that map to
// style/_tokens.scss as its `$projection`, and that file raises a Sass @error,
// failing this build, where a projected value disagrees with the fallback
// declared beside it. Nothing is written into style/: the projection reaches
// Dart Sass as source text.
//
// Both servers bind the loopback address only, so neither exposes the LAN or the
// container network by default. Binding additional interfaces is a deliberate
// per-invocation opt-in: `npm run dev -- --host <address>` and
// `npm run preview -- --host <address>` override the value below.
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of this
// file's area enumerated:
//   TR-BUILD-01  Rakefile                the Ruby/Rake build path, superseded by
//                                        this configuration and the npm scripts
//   TR-BUILD-02  CONTRIBUTING.md L12-L15 the `gem install sass` / `sass --watch`
//                (source branch)         workflow, superseded by the Dart Sass
//                                        pipeline configured here
//   TR-BUILD-03  style/main.css          the committed generated stylesheet,
//                                        deleted and now emitted into dist/ by
//                                        this build
//   TR-BUILD-04  index.html L88-L97      the ten ordered script tags, replaced
//                (source branch)         by the single module entry this graph
//                                        starts from
//   TR-BUILD-05  target-only row         the token bridge:
//                                        `emitSassTokenProjection()` delivered
//                                        through `additionalData`
//   TR-BUILD-06  target-only row         the loopback binding of both servers
//
// Decisions behind this file, argued in docs/DECISION_LOG.md and named here
// only so the construct can be found from the log:
//   DL-BUILD-01  the root index.html as the whole entry graph, with no SSR
//                entry, API route or serverless adapter configured
//   DL-BUILD-02  dist/ emitted with no source map
//   DL-BUILD-03  the token projection delivered as source text, with nothing
//                written into style/
//   DL-BUILD-04  both servers bound to the loopback interface, with additional
//                interfaces a per-invocation opt-in
import { defineConfig } from 'vite';

// The specifier carries its `.ts` extension, as do the two application modules
// this one reaches, so every import in this file's chain resolves under Vite's
// native config loader as well as under the bundling loader. Application
// modules outside that chain use extensionless specifiers.
import { emitSassTokenProjection } from './src/theme/tokens.ts';

// Address both servers bind. The loopback interface only: the development
// server and the preview server answer requests from this machine and from
// nothing else. `--host` on the command line overrides it.
const LOOPBACK_HOST = '127.0.0.1';

export default defineConfig({
  base: './',

  // favicon.ico and the meta/*.png files reach dist/ as assets referenced by
  // index.html, with rewritten hrefs, so no directory is copied verbatim.
  publicDir: false,

  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,

    target: 'es2022',

    // Ceiling on one emitted chunk before the build advises splitting it, in kB.
    //
    // Raised from the 500 default because `three` is a runtime dependency of
    // this bundle and is roughly 600 kB minified on its own: the whole bundle
    // measures about 930 kB minified and 257 kB gzipped, which is the transfer
    // size a static host actually serves. It is raised to just above the
    // measured figure rather than switched off, so a chunk growing beyond what
    // the renderer needs still trips the advisory.
    //
    // THE FIGURE HAS MOVED TWICE, AND FOR THE SAME REASON BOTH TIMES: a module
    // that nothing reaches is a module the bundler leaves out, so wiring one up
    // adds it to the payload. 734 kB became 803 kB when the observability layer
    // was reached — the structured logger, the metrics registry and the
    // diagnostics surface — and 803 kB became 930 kB when the RELIC subsystem
    // and the TRACER were reached: the sixteen relics of the four family
    // modules, the pickup-ordered registry, the rarity-weighted sampler and the
    // span layer were all present in the tree and unreachable from the entry
    // point, so none of them was in the bundle. They are reachable now, which is
    // the point of that work, and the ceiling follows the measurement rather
    // than the reverse.
    //
    // ONE CHUNK, deliberately. Splitting `three` into a vendor chunk would gain
    // cross-deploy caching and cost a second request, and it would not silence
    // the advisory either, because the vendor chunk alone exceeds the default.
    // A single chunk keeps the emitted directory the copy-and-serve artifact the
    // deployment mandate asks for.
    chunkSizeWarningLimit: 950,

    // No source map is emitted. `npm run build` produces the directory that is
    // copied verbatim to a static host, so every file dist/ carries is
    // publicly reachable there; a map would publish the TypeScript sources and
    // their comments alongside the bundle, and would resolve the file paths
    // that src/observability/logger.ts redacts out of a stack trace.
    sourcemap: false,
  },

  css: {
    preprocessorOptions: {
      scss: {
        // The authoritative token values, rendered as one Sass map and
        // prepended to each stylesheet Dart Sass compiles here.
        // style/main.scss declares the same variable `!default` so a plain
        // `sass style/main.scss` invocation, which prepends nothing, still
        // compiles.
        additionalData: emitSassTokenProjection(),
      },
    },
  },

  server: {
    port: 5173,
    // Loopback only. The server answers on 127.0.0.1 and on no other
    // interface.
    host: LOOPBACK_HOST,
  },

  preview: {
    // Port that playwright.config.ts starts and polls. `--port` and
    // `--strictPort` on the command line override it.
    port: 4173,
    host: LOOPBACK_HOST,
  },
});
