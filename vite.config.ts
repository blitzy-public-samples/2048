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
    // measures about 803 kB minified and 218 kB gzipped, which is the transfer
    // size a static host actually serves. It is raised to just above the
    // measured figure rather than switched off, so a chunk growing beyond what
    // the renderer needs still trips the advisory.
    //
    // The measured figure moved from 734 kB when the observability layer was
    // wired in: the structured logger, the metrics registry and the diagnostics
    // surface were all present in the tree but unreachable, so none of them was
    // reaching the bundle. They are reachable now, which is the point of that
    // work, and the ceiling follows the measurement rather than the reverse.
    //
    // ONE CHUNK, deliberately. Splitting `three` into a vendor chunk would gain
    // cross-deploy caching and cost a second request, and it would not silence
    // the advisory either, because the vendor chunk alone exceeds the default.
    // A single chunk keeps the emitted directory the copy-and-serve artifact the
    // deployment mandate asks for.
    chunkSizeWarningLimit: 850,

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
