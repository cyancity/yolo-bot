import { defineConfig } from 'vitest/config'

// Published @deepseek-ai/* resolve to prebuilt lib JS; inline them so the
// vite pipeline applies their subpath exports instead of node ESM loading.
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    // File-backed runtime tests compete for disk/CPU; bound concurrent workers.
    maxWorkers: 2,
    server: { deps: { inline: [/@deepseek-ai/] } },
  },
})
