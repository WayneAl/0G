import { defineConfig } from "vite";

/**
 * Two entry points, no framework.
 *
 * `base` is an env var because the same `dist/` is served from a domain root in
 * development and from `/0G/` on GitHub Pages; every asset URL and
 * `import.meta.env.BASE_URL` (which `config.ts` uses to find `directory.json`)
 * follows it.
 */
export default defineConfig({
  base: process.env["BASE_PATH"] ?? "/",
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        docs: "docs/index.html",
      },
    },
  },
});
