import { defineConfig } from 'vite';

// Deployment-parity mandate (AAP R12): `vite build` must emit a FULLY STATIC bundle
// that is deployable by copying `dist/` to any static host (GitHub Pages, Netlify,
// S3, a local filesystem). No SSR, no API routes, no serverless functions, and no
// runtime Node process. `base: './'` keeps every emitted asset URL relative so the
// same output works from a sub-path (e.g. project pages) or from a plain directory.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
  },
  css: {
    // Dart Sass (`sass` package) replaces the end-of-life Ruby Sass CLI.
    // Deprecation warnings from the legacy `@import` / slash-division syntax are
    // intentionally NOT silenced and NOT promoted to errors: the migration to
    // `@use` + `math.div()` is source work tracked by the AAP.
    preprocessorOptions: {
      scss: {},
    },
  },
  server: {
    host: true,
    port: 5173,
    strictPort: false,
  },
  preview: {
    host: true,
    port: 4173,
    strictPort: false,
  },
});
