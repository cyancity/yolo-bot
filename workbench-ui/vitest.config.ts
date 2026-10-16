import { defineConfig } from 'vitest/config'

// Vendored npm deps ship prebuilt lib JS; deps.inline keeps them inside the
// vite pipeline. The css stub gives *.module.css deterministic class names —
// the real lightningcss hashes only exist in the shipped client bundle.
const cssStub = {
  name: 'workbench-css-stub',
  enforce: 'pre' as const,
  resolveId: (id: string) => (/\.css(?:\?.*)?$/.test(id) ? '\0workbench-css-stub' : null),
  load: (id: string) => (id === '\0workbench-css-stub' ? 'export default new Proxy({}, { get: (_, key) => String(key) })' : null),
}

export default defineConfig({
  plugins: [cssStub],
  test: {
    include: ['tests/**/*.spec.{ts,tsx}'],
    setupFiles: ['tests/setup.ts'],
    environment: 'node',
    server: { deps: { inline: [/@deepseek-ai/] } },
  },
})
