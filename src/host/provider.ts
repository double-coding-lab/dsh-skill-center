import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { parseSkillDoc } from './frontmatter.js'
import { groupSkills, scanLocalRoots } from './roots.js'
import { CREATOR_SKILL_NAME, CREATOR_SKILL_RANK, DISABLED_OVERLAY_RANK } from '../shared/types.js'
import type { SkillStore } from './store.js'

export const PROVIDER_NAME = 'dsh-skill-center'

interface Invocation {
  modelInvocable: boolean
  userInvocable: boolean
}

export interface ProviderControl {
  signal?: AbortSignal
  invalidate?: () => void
}

export interface ProviderCandidate {
  name: string
  description: string
  invocation: Invocation
  provider: string
  source: string
  rank: number
  path?: string
  locator?: { kind: 'disabled'; name: string } | { kind: 'bundled' }
  resourceBase?: { kind: 'directory'; path: string }
}

export interface ProviderDefinition {
  name: string
  description: string
  invocation: Invocation
  source: string
  provider: string
  content: string
  path?: string
  resourceBase?: { kind: 'directory'; path: string }
}

export interface SkillProvider {
  name: string
  list(options?: unknown): Promise<ProviderCandidate[]>
  get(candidate: ProviderCandidate, options?: unknown): Promise<ProviderDefinition | undefined>
}

export interface SkillsFace {
  registerProvider(create: (control: ProviderControl) => SkillProvider): () => void
  snapshot(options?: unknown): Promise<{ skills: { name: string; description?: string; source?: string; provider?: string }[]; complete?: boolean }>
}

export interface AgentLike {
  id: string
  ctx?: { get?: (name: string) => unknown }
}

export interface SkillCenterContext {
  skills: SkillsFace
  on?: (event: string, listener: (payload: { agent: AgentLike }) => void) => (() => void) | undefined
  get?: (name: string) => unknown
  emit?: (event: string, ...args: unknown[]) => void
  effect?: (fn: () => unknown, label?: string) => void
}

const BUNDLED_DOC = fileURLToPath(new URL('../../skills/skill-center-creator/SKILL.md', import.meta.url))
const BUNDLED_DIR = fileURLToPath(new URL('../../skills/skill-center-creator/', import.meta.url))

let bundledCache: { description: string; content: string } | null = null

async function readBundled(): Promise<{ description: string; content: string }> {
  if (bundledCache) return bundledCache
  const content = await fs.readFile(BUNDLED_DOC, 'utf8')
  const doc = parseSkillDoc(content)
  bundledCache = {
    description: (doc.map['description'] ?? '创建 DSH 技能：问清用途后生成规范的 SKILL.md 并落盘。').trim(),
    content,
  }
  return bundledCache
}

let knownNamesCache: { at: number; names: string[] } | null = null

async function knownNames(): Promise<string[]> {
  const now = Date.now()
  if (knownNamesCache && now - knownNamesCache.at < 3000) return knownNamesCache.names
  const scans = await scanLocalRoots()
  const names = new Set<string>()
  for (const scan of scans) for (const entry of scan.entries) names.add(entry.name)
  knownNamesCache = { at: now, names: [...names] }
  return knownNamesCache.names
}

export function invalidateKnownNames(): void {
  knownNamesCache = null
}

async function disabledCandidate(name: string, description: string): Promise<ProviderCandidate> {
  return {
    name,
    description: description || `已在技能中心停用：${name}`,
    invocation: { modelInvocable: false, userInvocable: false },
    provider: PROVIDER_NAME,
    source: 'policy',
    rank: DISABLED_OVERLAY_RANK,
    locator: { kind: 'disabled', name },
  }
}

export function createProvider(control: ProviderControl, store: SkillStore): SkillProvider {
  const registered = (): boolean => true
  return {
    name: PROVIDER_NAME,
    async list(): Promise<ProviderCandidate[]> {
      try {
        const candidates: ProviderCandidate[] = []
        if (registered()) {
          const disabled = store.failClosed ? new Set(await knownNames()) : store.disabledSet()
          for (const name of disabled) candidates.push(await disabledCandidate(name, ''))
        }
        try {
          const bundled = await readBundled()
          candidates.push({
            name: CREATOR_SKILL_NAME,
            description: bundled.description,
            invocation: { modelInvocable: true, userInvocable: true },
            provider: PROVIDER_NAME,
            source: 'bundled',
            rank: CREATOR_SKILL_RANK,
            path: BUNDLED_DOC,
            locator: { kind: 'bundled' },
            resourceBase: { kind: 'directory', path: BUNDLED_DIR },
          })
        } catch {
          /* 包内 creator 技能缺失时只发布停用覆盖 */
        }
        return candidates
      } catch {
        return []
      }
    },
    async get(candidate: ProviderCandidate): Promise<ProviderDefinition | undefined> {
      const locator = candidate.locator
      if (locator?.kind === 'bundled') {
        try {
          const bundled = await readBundled()
          return {
            name: CREATOR_SKILL_NAME,
            description: bundled.description,
            invocation: { modelInvocable: true, userInvocable: true },
            source: 'bundled',
            provider: PROVIDER_NAME,
            content: bundled.content,
            path: BUNDLED_DOC,
            resourceBase: { kind: 'directory', path: BUNDLED_DIR },
          }
        } catch {
          return undefined
        }
      }
      if (locator?.kind === 'disabled') {
        const scans = await scanLocalRoots()
        const group = groupSkills(scans).find(item => item.name === locator.name)
        if (!group) return undefined
        let content = ''
        try {
          content = await fs.readFile(group.winner.path, 'utf8')
        } catch {
          content = `---\nname: ${locator.name}\ndescription: 已在技能中心停用\n---\n`
        }
        return {
          name: group.name,
          description: group.winner.description,
          invocation: { modelInvocable: false, userInvocable: false },
          source: 'policy',
          provider: PROVIDER_NAME,
          content,
          path: group.winner.path,
        }
      }
      return undefined
    },
  }
}

export interface ProviderRegistration {
  invalidateAll(): void
  /** Register into any agent registry that appeared after apply (restored sessions create theirs late). */
  syncAgents(): void
  dispose(): void
  invalidatorCount(): number
}

/**
 * Register the policy provider globally and again inside every live agent.
 * Agent presets mount skill-filesystem in a nearer layer; a global registration
 * alone cannot shadow preset-scoped skills.
 */
export function registerProviders(ctx: SkillCenterContext, store: SkillStore): ProviderRegistration {
  const invalidators = new Set<() => void>()
  const agentRegistrations = new Map<string, () => void>()
  const disposals: (() => void)[] = []

  const create = (control: ProviderControl): SkillProvider => {
    const invalidate = control.invalidate
    if (typeof invalidate === 'function') {
      invalidators.add(invalidate)
      control.signal?.addEventListener('abort', () => invalidators.delete(invalidate), { once: true })
    }
    return createProvider(control, store)
  }

  try {
    disposals.push(ctx.skills.registerProvider(create))
  } catch (error) {
    console.warn('[dsh-skill-center] global provider registration failed', error)
  }

  const install = (agent: AgentLike | undefined): void => {
    if (!agent || agentRegistrations.has(agent.id)) return
    const skills = agent.ctx?.get?.('skills') as SkillsFace | undefined
    if (!skills || typeof skills.registerProvider !== 'function') return
    try {
      agentRegistrations.set(agent.id, skills.registerProvider(create))
    } catch (error) {
      console.warn('[dsh-skill-center] agent provider registration failed', error)
    }
  }

  const uninstall = (agent: AgentLike | undefined): void => {
    if (!agent) return
    const dispose = agentRegistrations.get(agent.id)
    agentRegistrations.delete(agent.id)
    if (typeof dispose === 'function') dispose()
  }

  const stopCreated = ctx.on?.('agent/created', ({ agent }) => install(agent))
  const stopDisposed = ctx.on?.('agent/disposed', ({ agent }) => uninstall(agent))
  if (typeof stopCreated === 'function') disposals.push(stopCreated)
  if (typeof stopDisposed === 'function') disposals.push(stopDisposed)

  const syncAgents = (): void => {
    const agents = ctx.get?.('agents') as { list?: () => AgentLike[] } | undefined
    if (!agents || typeof agents.list !== 'function') return
    try {
      for (const agent of agents.list()) install(agent)
    } catch {
      /* agents 服务不可枚举时依赖后续 agent/created */
    }
  }
  syncAgents()

  return {
    syncAgents,
    invalidateAll(): void {
      for (const invalidate of invalidators) {
        try {
          invalidate()
        } catch {
          /* 单个 provider 失效失败不影响其余 */
        }
      }
    },
    invalidatorCount(): number {
      return invalidators.size
    },
    dispose(): void {
      for (const dispose of disposals) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
      for (const dispose of agentRegistrations.values()) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
      agentRegistrations.clear()
      invalidators.clear()
    },
  }
}

/** Emit the two events the Web client actually forwards so its skill menu refreshes. */
export function notifyCatalogChange(ctx: SkillCenterContext, registration: ProviderRegistration): void {
  registration.syncAgents()
  registration.invalidateAll()
  invalidateKnownNames()
  try {
    ctx.emit?.('commands/change')
  } catch {
    /* ignore */
  }
  try {
    const sessions = ctx.get?.('sessions') as { list?: () => { id?: string; header?: { id?: string; agentPreset?: string } }[] } | undefined
    const list = typeof sessions?.list === 'function' ? sessions.list() : []
    for (const session of list) {
      const id = session?.id ?? session?.header?.id
      const preset = session?.header?.agentPreset
      if (typeof id !== 'string' || typeof preset !== 'string' || !preset) continue
      ctx.emit?.('agent-preset/selected', id, preset)
    }
  } catch {
    /* ignore */
  }
}
