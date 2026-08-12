// Vite configuration for the static 2048 bundle.
//
// Both servers bind the loopback address only, so neither exposes the LAN or
// the container network by default. Binding additional interfaces is a
// deliberate per-invocation opt-in: `npm run dev -- --host <address>` and `npm
// run preview -- --host <address>` override the value below.
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
// Decisions: DL-BUILD-01, DL-BUILD-02, DL-BUILD-03, DL-BUILD-04
// (docs/DECISION_LOG.md).
import { defineConfig } from 'vite';

// The specifier carries its `.ts` extension, as do the two application modules
// this one reaches, so every import in this file's chain resolves under Vite's
// native config loader as well as under the bundling loader.
import { emitSassTokenProjection } from './src/theme/tokens.ts';

// Address both servers bind. The loopback interface only: the development
// server and the preview server answer requests from this machine and from
// nothing else.
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
    // MEASURED, not chosen: the emitted bundle is 1064 kB minified and 294 kB
    // gzipped at this commit, and the ceiling sits just above that figure so a
    // chunk growing beyond what the composed application needs still trips the
    // advisory. The figure moves whenever a module becomes reachable from the
    // entry point, because a module nothing reaches is one the bundler leaves
    // out. The bundle is emitted as ONE chunk. Decisions DL-BUILD-12,
    // DL-BUILD-13.
    chunkSizeWarningLimit: 1100,

    // No source map is emitted, and none may be: `npm run build` produces the
    // directory copied verbatim to a static host, so every file dist/ carries
    // is publicly reachable there. This is also what the stack-path redaction
    // of src/observability/logger.ts relies on. Decision DL-BUILD-02.
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
    // Port that playwright.config.ts starts and polls.
    port: 4173,
    host: LOOPBACK_HOST,
  },
});
