import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

/**
 * Test config, kept SEPARATE from vite.config.ts on purpose.
 *
 * vite.config.ts carries the dev-server proxy (VITE_API_TARGET) and the
 * tailwind plugin. Merging test config into it would put a `test` key on the
 * config the dev server and the production build both read; keeping them apart
 * means `npm run dev` and `npm run build` cannot be affected by anything done
 * for the sake of tests.
 *
 * Tailwind is deliberately NOT loaded here: no test asserts on generated
 * utility CSS (the guard for that is a grep over dist/, see the refactor
 * gates), and loading it would slow every run for no benefit.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    // Third mirror of the '@/' alias (tsconfig.app.json + vite.config.ts are the
    // other two). vitest resolves through its own config, so without this every
    // test importing '@/...' fails while the app builds fine.
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    globals: true,
    // Two projects rather than one environment, because most of the value here
    // is in PURE tests (YAML emission, size arithmetic, grouping) which run an
    // order of magnitude faster without a DOM. A test that needs one opts in by
    // being named *.dom.test.ts(x).
    //
    // `projects` and not the older `environmentMatchGlobs`: that option is
    // deprecated in vitest 3 and warns on every run.
    projects: [
      {
        extends: true,
        test: {
          name: 'pure',
          environment: 'node',
          include: ['src/**/*.test.{ts,tsx}'],
          exclude: ['src/**/*.dom.test.{ts,tsx}'],
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['src/**/*.dom.test.{ts,tsx}'],
        },
      },
    ],
    // draftFromYaml.fidelity.test.mjs is NOT a vitest file — it is a
    // standalone tsx script (`npm run test:fidelity`) and the YAML-integrity
    // fence. Excluded so vitest neither runs nor reports on it; it keeps its
    // own script and must stay 59/59.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.fidelity.test.mjs'],
    coverage: {
      provider: 'v8',
      // Pure logic is what we can meaningfully cover; JSX-heavy parts are
      // verified by eye per the layout rules, so they are not counted.
      include: ['src/**/model/**', 'src/lib/**', 'src/hooks/**'],
      exclude: ['**/*.test.*', 'src/lib/draftFromYaml.fidelity.test.mjs'],
      reporter: ['text-summary'],
    },
  },
})
