import type { UserConfig } from 'tsdown'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Host half is a one-line Loader row; the browser half (lib/client.js) is the
// shared client-bundle preset's __ModuleLoader__.load factory artifact.

// Upstream's aggregate faces (`--env.DSH_BUILD_FACE host|client`) consume
// lib/types emitted by the repo-wide composite project, which this package is
// not part of. Remove this package from the aggregate passes — a falsey entry
// removes it before entry resolution, the same mechanism as the preset's own
// SKIP_WORKSPACE_BUILD.
export default async (ctx: { env?: Record<string, unknown> }) => {
  if (ctx.env?.DSH_BUILD_FACE !== undefined) return [{ entry: '' }]
  // Static imports cannot work: only one preset exists in a package checkout or native workspace.
  const vendored = new URL('../build-support/tsdown.client.ts', import.meta.url)
  const preset = existsSync(fileURLToPath(vendored)) ? vendored : new URL('../../client/tsdown.client.ts', import.meta.url)
  const { clientBundle } = await import(preset.href)
  const bundle = clientBundle('@cyancity/yolo-bot-ui', ['src/index.ts'])
  const configs = (bundle(ctx) as UserConfig[]).map(config => config.name === '@cyancity/yolo-bot-ui/client'
    ? {
      ...config,
      minify: true,
      // tsdown forces CJS resolution to node; the lower-level override keeps
      // conditional imports (notably vfile) on their real browser entries.
      inputOptions: { ...config.inputOptions, platform: 'browser' },
    }
    : config)
  configs.push({
    name: '@cyancity/yolo-bot-ui/extension-types',
    entry: { extension: 'src/extension.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'browser',
    fixedExtension: false,
    clean: false,
    dts: true,
    external: ['react', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-slots'],
  })
  return configs
}
