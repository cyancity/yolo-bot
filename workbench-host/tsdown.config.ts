import { defineConfig } from 'tsdown'

// Host plugin and extension declarations; native modules stay host-provided.
export default defineConfig({
  entry: { index: 'src/index.ts', extension: 'src/extension.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  external: [/^@deepseek-ai\//],
})
