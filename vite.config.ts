// Vite configuration for the static 2048 bundle.
//
// Both servers bind the loopback address only, so neither exposes the LAN or
// the container network by default. Binding additional interfaces is a
// deliberate per-invocation opt-in: `npm run dev -- --host <address>` and `npm
// run preview -- --host <address>` override the value below.
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

    // Ceiling on one emitted chunk before the build advises splitting it, in
    // kB. Tracks the measured bundle size. Decisions DL-BUILD-12, DL-BUILD-13.
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
