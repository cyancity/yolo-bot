#!/usr/bin/env node
/** Validate against the installed DSH graph without writing its missing Cordis lib. */
import { mkdtemp, readFile, realpath, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const host = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harness = process.env.DSH_ROOT ? resolve(process.env.DSH_ROOT) : resolve(await realpath(join(host, 'node_modules', '@deepseek-ai', 'dsh-tools')), '../../..')
const temp = await mkdtemp(join(tmpdir(), 'wb-bot-verify-'))
const buildConfig = join(host, `.bot-verification-${randomUUID()}.tsconfig.json`)
const tsc = join(host, 'node_modules', 'typescript', 'bin', 'tsc')
const build = join(host, 'node_modules', 'tsdown', 'dist', 'run.mjs')

function run(label, args) {
  const child = spawnSync(process.execPath, args, { cwd: host, stdio: 'inherit', windowsHide: true })
  const exit = child.status ?? 1
  console.log(JSON.stringify({ check: label, exit }))
  if (child.error) throw child.error
  if (exit !== 0) throw new Error(`${label} exited ${exit}`)
}

try {
  const paths = { '@deepseek-ai/cosmokit': [join(harness, 'vendor', 'cosmokit', 'lib', 'types', 'index.d.ts')] }
  const cordisTypes = join(harness, 'vendor', 'cordis', 'lib', 'types', 'index.d.ts')
  let cordis = cordisTypes
  if (!existsSync(cordisTypes)) {
    const config = join(temp, 'cordis-tsconfig.json')
    await writeFile(config, JSON.stringify({
      extends: join(harness, 'vendor', 'cordis', 'tsconfig.json'),
      compilerOptions: { outDir: join(temp, 'cordis-types'), declaration: true, emitDeclarationOnly: true,
        composite: false, incremental: false, typeRoots: [join(host, 'node_modules', '@types')], paths }, references: [],
    }, null, 2))
    run('cordis-declarations-temp', [tsc, '-p', config])
    cordis = join(temp, 'cordis-types', 'index.d.ts')
  }
  paths['@deepseek-ai/cordis'] = [cordis]
  const modules = {
    'dsh-agent': 'core/agent', 'dsh-agent-loop': 'core/agent-loop', 'dsh-session': 'core/session',
    'dsh-session-projection': 'session/session-projection',
    'dsh-session-persistence-jsonl': 'session/session-persistence-jsonl', 'dsh-system-prompt': 'core/system-prompt',
  }
  for (const [name, dir] of Object.entries(modules)) paths[`@deepseek-ai/${name}`] = [join(harness, 'packages', dir, 'lib', 'types', 'index.d.ts')]
  const config = JSON.parse(await readFile(join(host, 'tsconfig.json'), 'utf8'))
  config.compilerOptions.typeRoots = [join(host, 'node_modules', '@types')]
  config.compilerOptions.paths = Object.fromEntries(Object.entries(paths).map(([name, values]) => [name, values.map(value => relative(host, value).replaceAll('\\', '/'))]))
  // Rolldown resolves this file reliably when all declaration paths are relative to the package.
  await writeFile(buildConfig, JSON.stringify(config, null, 2) + '\n')
  run('host-typecheck', [tsc, '--noEmit', '-p', buildConfig])
  run('host-build', [build, '--tsconfig', buildConfig])
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await rm(buildConfig, { force: true })
  await rm(temp, { recursive: true, force: true })
}
