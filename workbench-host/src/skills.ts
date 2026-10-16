/**
 * Bundled skill provider: scans <package>/skills/** for SKILL.md (depth ≤3)
 * and registers them at bundled rank (600), so user/project skills override.
 * Pattern follows dsh-skill-badge.
 */

import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { packagedPath } from './packaged.ts'
import { WorkforceError } from './workforce/types.ts'

const BUNDLED_SKILL_RANK = 600
const PROVIDER_NAME = 'cyancity-workbench'

const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url))

export interface SkillCandidateLike {
  name: string
  description: string
  invocation: { modelInvocable: boolean; userInvocable: boolean }
  provider: string
  source: 'bundled'
  resourceBase: { kind: 'directory'; path: string }
  rank: number
  locator: string
}

export interface SkillsService {
  registerProvider(create: (control: { invalidate(): void }) => {
    name: string
    list: (options: { signal?: AbortSignal }) => Promise<SkillCandidateLike[]>
    get: (candidate: SkillCandidateLike) => Promise<{
      name: string
      description: string
      invocation: SkillCandidateLike['invocation']
      provider: string
      source: 'bundled'
      resourceBase: SkillCandidateLike['resourceBase']
      content: string
    } | undefined>
  }): unknown
}

/** Parse `name`/`description` out of SKILL.md frontmatter (block scalars too). */
export function parseFrontmatter(text: string): { name?: string; description?: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return {}
  const out: { name?: string; description?: string } = {}
  const lines = m[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_-]+):\s*(.*)$/)
    if (!kv) continue
    let value = kv[2].replace(/^['"]|['"]$/g, '').trim()
    if ((value === '>' || value === '>-' || value === '|' || value === '|-' || value === '') && i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
      const block: string[] = []
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim())
      value = block.join(value.startsWith('|') ? '\n' : ' ')
    }
    if (kv[1] === 'name') out.name = value
    if (kv[1] === 'description') out.description = value
  }
  return out
}

/** Recursively find SKILL.md files under dir (max depth 3). */
export async function scanSkillFiles(dir: string, depth = 3): Promise<string[]> {
  if (depth < 0) return []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of entries) {
    if (e.isDirectory()) {
      out.push(...await scanSkillFiles(join(dir, e.name), depth - 1))
    } else if (e.isFile() && e.name === 'SKILL.md') {
      out.push(join(dir, e.name))
    }
  }
  return out
}

async function loadCandidates(): Promise<SkillCandidateLike[]> {
  const out: SkillCandidateLike[] = []
  for (const file of await scanSkillFiles(SKILLS_DIR)) {
    const dir = join(file, '..')
    const meta = parseFrontmatter(await readFile(file, 'utf8'))
    if (!meta.name) continue
    out.push({
      name: meta.name,
      description: meta.description ?? '',
      invocation: { modelInvocable: true, userInvocable: true },
      provider: PROVIDER_NAME,
      source: 'bundled',
      // The renderer hands resourceBase to the model's filesystem tools;
      // under app.asar those tools (rg-backed glob/grep) cannot see the
      // archive, so point at the asarUnpack'd mirror in packaged builds.
      resourceBase: { kind: 'directory', path: packagedPath(dir) },
      rank: BUNDLED_SKILL_RANK,
      locator: file,
    })
  }
  return out
}

/** Register bundled skills and borrow its official catalog invalidation control. */
export function registerSkills(ctx: { get(name: 'skills'): SkillsService | undefined }): () => void {
  const skills = ctx.get('skills')
  if (!skills || typeof skills.registerProvider !== 'function') throw new WorkforceError('unavailable', '原生技能服务不可用')
  let invalidate: (() => void) | undefined
  skills.registerProvider(control => {
    invalidate = control.invalidate
    return {
    name: PROVIDER_NAME,
    list: () => loadCandidates(),
    get: async candidate => {
      try {
        const content = await readFile(candidate.locator, 'utf8')
        return {
          name: candidate.name,
          description: candidate.description,
          invocation: candidate.invocation,
          provider: candidate.provider,
          source: candidate.source,
          resourceBase: candidate.resourceBase,
          content,
        }
      } catch {
        return undefined
      }
    },
    }
  })
  return () => {
    if (!invalidate) throw new WorkforceError('unavailable', '原生技能刷新服务不可用')
    invalidate()
  }
}
