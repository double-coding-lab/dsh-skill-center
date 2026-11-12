import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join, posix } from 'node:path'

import { unzipSync } from 'fflate'

import { buildSkillDocument, isSkillName, normalizeSkillName, parseSkillDoc } from './frontmatter.js'
import { groupSkills, localRoots, rootKeyOf, scanLocalRoots, toView } from './roots.js'
import type { GroupedSkill, SkillEntry } from './roots.js'
import { CREATOR_SKILL_NAME, MAX_ARCHIVE_DEPTH, MAX_ARCHIVE_FILES, MAX_BODY_BYTES, MAX_NAME_LENGTH, MAX_UNPACKED_BYTES, MAX_ZIP_BYTES } from '../shared/types.js'
import type { CatalogState, CreateInput, ImportPayload, RootKey, SkillDetailPayload, SkillView, StatePayload } from '../shared/types.js'
import type { SkillCenterContext } from './provider.js'
import type { CatalogInstall, SkillStore } from './store.js'

export interface OpsDeps {
  ctx: SkillCenterContext
  store: SkillStore
  onChanged?: () => void
  syncAgents?: () => void
}

export function fail(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

function writableDshRoot(): string {
  const root = localRoots().find(item => item.key === 'dsh')
  if (!root) throw fail('storage_unavailable', '找不到 DSH 技能目录')
  return root.path
}

function agentsRoot(): string {
  const root = localRoots().find(item => item.key === 'agents')
  return root?.path ?? ''
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function hashFiles(files: Map<string, Uint8Array>): { path: string; sha256: string }[] {
  return [...files.entries()]
    .map(([path, bytes]) => ({ path, sha256: sha256(bytes) }))
    .sort((left, right) => left.path.localeCompare(right.path))
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.stat(path)
    return true
  } catch {
    return false
  }
}

async function isLinked(path: string): Promise<boolean> {
  try {
    return (await fs.lstat(path)).isSymbolicLink()
  } catch {
    return false
  }
}

const RETRY_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

/** Windows virus scanners briefly lock freshly written directories; retry the atomic rename. */
async function renameWithRetry(from: string, to: string, attempts = 6): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (attempt + 1 >= attempts || !RETRY_RENAME_CODES.has(code)) throw error
      await new Promise(resolve => setTimeout(resolve, 40 * (attempt + 1)))
    }
  }
}

export interface LocalIndex {
  groups: GroupedSkill[]
  roots: ReturnType<typeof localRoots>
  counts: Record<RootKey, number>
  truncated: boolean
}

export async function localIndex(): Promise<LocalIndex> {
  const scans = await scanLocalRoots()
  const counts: Record<RootKey, number> = { dsh: 0, agents: 0, preset: 0 }
  for (const scan of scans) counts[scan.root.key] = scan.entries.length
  return {
    groups: groupSkills(scans),
    roots: scans.map(scan => scan.root),
    counts,
    truncated: scans.some(scan => scan.truncated),
  }
}

function catalogState(store: SkillStore, name: string): CatalogState | undefined {
  const record = store.installs().find(item => item.name === name)
  if (!record) return undefined
  return {
    key: record.key,
    name: record.name,
    version: record.version,
    updateAvailable: false,
    localModified: false,
    present: true,
  }
}

interface PluginSkillSummary {
  name: string
  description?: string
}

interface AgentSkillsFace {
  snapshot?: (options?: unknown) => Promise<{ skills: { name: string; description?: string; path?: string }[] }>
  get?: (name: string, options?: unknown) => Promise<
    | {
        name?: string
        description?: string
        content?: string
        path?: string
        invocation?: { modelInvocable?: boolean; userInvocable?: boolean }
      }
    | undefined
  >
}

function firstAgentSkills(ctx: SkillCenterContext): AgentSkillsFace | undefined {
  const agents = ctx.get?.('agents') as { list?: () => { ctx?: { get?: (name: string) => unknown } }[] } | undefined
  return agents?.list?.()[0]?.ctx?.get?.('skills') as AgentSkillsFace | undefined
}

async function pluginSkills(ctx: SkillCenterContext, localNames: Set<string>): Promise<PluginSkillSummary[]> {
  let skills = firstAgentSkills(ctx)
  if (!skills || typeof skills.snapshot !== 'function') {
    const presets = ctx.get?.('agentPresets') as
      | { acquireScope?: (id: string) => Promise<{ key: string; [Symbol.asyncDispose]?: () => Promise<void> }>; defaultPreset?: string }
      | undefined
    const presetId = typeof presets?.defaultPreset === 'string' ? presets.defaultPreset : undefined
    if (presets && typeof presets.acquireScope === 'function' && presetId) {
      let lease: { key: string; [Symbol.asyncDispose]?: () => Promise<void> } | undefined
      try {
        lease = await presets.acquireScope(presetId)
        const rootSkills = ctx.skills
        const snapshot = await rootSkills.snapshot({ scope: lease.key })
        return snapshot.skills
          .filter(item => !localNames.has(item.name) && item.name !== CREATOR_SKILL_NAME)
          .map(item => ({ name: item.name, description: item.description }))
      } catch {
        return []
      } finally {
        try {
          await lease?.[Symbol.asyncDispose]?.()
        } catch {
          /* ignore */
        }
      }
    }
    return []
  }
  try {
    const snapshot = await skills.snapshot({ cwd: undefined })
    return snapshot.skills
      .filter(item => !localNames.has(item.name) && item.name !== CREATOR_SKILL_NAME)
      .map(item => ({ name: item.name, description: item.description }))
  } catch {
    return []
  }
}

export async function stateOf(deps: OpsDeps): Promise<StatePayload> {
  deps.syncAgents?.()
  await deps.store.ready()
  const index = await localIndex()
  const disabled = deps.store.disabledSet()
  const localNames = new Set(index.groups.map(group => group.name))
  const skills: SkillView[] = index.groups.map(group => {
    const view = toView(group, disabled)
    const catalog = catalogState(deps.store, group.name)
    return catalog ? { ...view, catalog } : view
  })
  for (const plugin of await pluginSkills(deps.ctx, localNames)) {
    skills.push({
      name: plugin.name,
      description: plugin.description ?? '',
      root: 'preset',
      path: '',
      enabled: !disabled.has(plugin.name),
      editable: false,
      linked: false,
      loadable: true,
      modelInvocable: true,
      userInvocable: true,
      copies: [],
    })
  }
  const counts: Record<RootKey, number> = { ...index.counts }
  counts.preset = skills.filter(skill => skill.root === 'preset').length
  return {
    roots: index.roots,
    skills,
    counts,
    writable: deps.store.writable,
    warning: deps.store.warning,
    truncated: index.truncated,
  }
}

async function presetDetail(deps: OpsDeps, name: string): Promise<SkillDetailPayload | null> {
  const skills = firstAgentSkills(deps.ctx)
  if (!skills || typeof skills.get !== 'function') return null
  let definition: Awaited<ReturnType<NonNullable<AgentSkillsFace['get']>>>
  try {
    definition = await skills.get(name, { cwd: undefined })
  } catch {
    return null
  }
  if (!definition) return null
  const enabled = !deps.store.disabledSet().has(name)
  const content = definition.content ?? ''
  return {
    skill: {
      name,
      description: definition.description ?? '',
      root: 'preset',
      path: definition.path ?? '',
      enabled,
      editable: false,
      linked: false,
      loadable: true,
      modelInvocable: definition.invocation?.modelInvocable ?? true,
      userInvocable: definition.invocation?.userInvocable ?? true,
      copies: [],
    },
    document: content,
    frontmatter: null,
    body: content,
  }
}

export async function detailOf(deps: OpsDeps, name: string): Promise<SkillDetailPayload> {
  if (!isSkillName(name)) throw fail('invalid_name', `非法技能名：${name}`)
  const index = await localIndex()
  const group = index.groups.find(item => item.name === name)
  if (!group) {
    const preset = await presetDetail(deps, name)
    if (preset) return preset
    throw fail('not_found', `技能不存在：${name}`)
  }
  const document = await fs.readFile(group.winner.path, 'utf8')
  const parsed = parseSkillDoc(document)
  const view = toView(group, deps.store.disabledSet())
  const catalog = catalogState(deps.store, name)
  const record = deps.store.installs().find(item => item.name === name)
  if (catalog && record) {
    const localModified = await isModified(group.winner.dir, record)
    catalog.localModified = localModified
    const detail = await peekCatalogVersion(deps, record.key)
    catalog.updateAvailable = detail !== undefined && detail !== record.version
  }
  return {
    skill: catalog ? { ...view, catalog } : view,
    document,
    frontmatter: parsed.hasFrontmatter ? parsed.map : null,
    body: parsed.body,
  }
}

async function peekCatalogVersion(deps: OpsDeps, key: string): Promise<string | undefined> {
  const [owner, slug] = key.split('/')
  if (!owner || !slug) return undefined
  try {
    const { fetchDetail } = await import('./clawhub.js')
    const detail = await fetchDetail({ owner, slug })
    return detail.version
  } catch {
    return undefined
  }
}

export async function isModified(dir: string, record: CatalogInstall): Promise<boolean> {
  for (const file of record.files) {
    try {
      const bytes = await fs.readFile(join(dir, file.path))
      if (sha256(bytes) !== file.sha256) return true
    } catch {
      return true
    }
  }
  try {
    const dirents = await fs.readdir(dir, { recursive: true, withFileTypes: true })
    const present = dirents.filter(item => item.isFile()).length
    return present !== record.files.length
  } catch {
    return true
  }
}

export async function setEnabled(deps: OpsDeps, name: string, enabled: boolean): Promise<{ name: string; enabled: boolean }> {
  await deps.store.setEnabled(name, enabled)
  deps.onChanged?.()
  return { name, enabled }
}

async function ensureCreateTarget(root: string, name: string): Promise<void> {
  const bundle = join(root, name)
  const file = join(root, `${name}.md`)
  if ((await exists(bundle)) || (await exists(file))) {
    throw fail('conflict', `同名技能已存在：${name}`)
  }
}

export async function createSkill(deps: OpsDeps, input: CreateInput): Promise<{ name: string; path: string }> {
  await deps.store.ready()
  const name = normalizeSkillName(String(input.name ?? ''))
  if (!name) throw fail('invalid_name', `无法生成合法 kebab-case 名称：${String(input.name ?? '')}`)
  if (name.length > MAX_NAME_LENGTH) throw fail('invalid_name', '技能名过长')
  const description = String(input.description ?? '').trim()
  const body = String(input.body ?? '').trim()
  if (!description) throw fail('invalid_name', '技能简介不能为空')
  if (!body) throw fail('invalid_name', '技能正文不能为空')
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) throw fail('archive_too_large', '技能正文过大')

  const extras = new Map<string, string>()
  let extraBytes = 0
  for (const file of input.files ?? []) {
    const path = normalizeArchivePath(String(file?.path ?? ''))
    if (!path) throw fail('path_unsafe', `附属文件路径非法：${String(file?.path ?? '')}`)
    if (path.toLowerCase() === 'skill.md') throw fail('invalid_name', '附属文件不能覆盖 SKILL.md')
    const content = String(file?.content ?? '')
    extraBytes += Buffer.byteLength(content, 'utf8')
    if (Buffer.byteLength(content, 'utf8') > MAX_BODY_BYTES) throw fail('archive_too_large', `附属文件过大：${path}`)
    if (extraBytes > MAX_UNPACKED_BYTES) throw fail('archive_too_large', '附属文件总大小超出限制')
    if (extras.size >= MAX_ARCHIVE_FILES) throw fail('archive_too_large', `附属文件数量超出限制（${MAX_ARCHIVE_FILES}）`)
    extras.set(path, content)
  }

  const root = writableDshRoot()
  const index = await localIndex()
  if (index.groups.some(group => group.name === name)) throw fail('conflict', `同名技能已存在：${name}`)
  await ensureCreateTarget(root, name)
  await fs.mkdir(root, { recursive: true })

  const target = join(root, name)
  const stage = join(root, `.skill-center-${randomUUID()}`)
  try {
    await fs.mkdir(stage, { recursive: true })
    await fs.writeFile(join(stage, 'SKILL.md'), buildSkillDocument({ name, description, body }), 'utf8')
    for (const [path, content] of extras) {
      const destination = join(stage, ...path.split('/'))
      await fs.mkdir(dirname(destination), { recursive: true })
      await fs.writeFile(destination, content, 'utf8')
    }
    await renameWithRetry(stage, target)
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  deps.onChanged?.()
  return { name, path: join(target, 'SKILL.md') }
}

export async function deleteSkill(deps: OpsDeps, name: string): Promise<{ name: string; removed: string }> {
  if (!isSkillName(name)) throw fail('invalid_name', `非法技能名：${name}`)
  const index = await localIndex()
  const group = index.groups.find(item => item.name === name)
  if (!group) throw fail('not_found', `技能不存在：${name}`)
  const copy = group.copies.find(item => item.root.key === 'dsh' && !item.entry.linked)
    ?? group.copies.find(item => item.root.key === 'agents' && !item.entry.linked)
  if (!copy) throw fail('not_writable', '只能删除本地或公共技能目录中的非链接技能')
  const root = copy.root.key === 'dsh' ? writableDshRoot() : agentsRoot()
  if (!root) throw fail('storage_unavailable', '找不到目标技能目录')

  const resolved = copy.entry.kind === 'bundle' ? copy.entry.dir : copy.entry.path
  if (!resolved.startsWith(root)) throw fail('path_unsafe', '目标路径越界')
  if (await isLinked(resolved)) throw fail('path_unsafe', '符号链接技能不允许删除')

  await fs.rm(resolved, { recursive: true, force: true })
  for (const record of deps.store.installs()) {
    if (record.name === name) await deps.store.deleteInstall(record.key)
  }
  if (deps.store.disabledSet().has(name)) {
    await deps.store.setEnabled(name, true).catch(() => undefined)
  }
  deps.onChanged?.()
  return { name, removed: resolved }
}

// ── 导入 ────────────────────────────────────────────────────────────────────

const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._\-/ ]+$/

function decode(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'))
}

export function normalizeArchivePath(input: string): string | null {
  const raw = String(input ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
  if (!raw || raw.length > 512) return null
  if (raw.startsWith('/') || raw.startsWith('//') || /^[A-Za-z]:/.test(raw)) return null
  if (!SAFE_PATH.test(raw)) return null
  const parts = raw.split('/').filter(part => part.length > 0 && part !== '.')
  if (!parts.length || parts.length > MAX_ARCHIVE_DEPTH) return null
  return parts.join('/')
}

export interface ArchiveFiles {
  name: string
  files: Map<string, Uint8Array>
}

/** Validate the payload, locate the SKILL.md root, strip a single wrapper directory. */
export function unpackPayload(payload: ImportPayload): ArchiveFiles {
  let raw: Map<string, Uint8Array>
  if (payload.kind === 'zip') {
    const encoded = typeof payload.zip === 'string' ? payload.zip : ''
    if (!encoded) throw fail('archive_invalid', '压缩包为空')
    const bytes = decode(encoded)
    if (bytes.byteLength > MAX_ZIP_BYTES) throw fail('archive_too_large', '压缩包过大')
    let unzipped: Record<string, Uint8Array>
    try {
      unzipped = unzipSync(bytes)
    } catch {
      throw fail('archive_invalid', 'ZIP 压缩包无法解压')
    }
    raw = new Map(Object.entries(unzipped).filter(([path]) => !path.endsWith('/')))
  } else {
    const entries = Array.isArray(payload.entries) ? payload.entries : []
    if (!entries.length) throw fail('archive_invalid', '没有可导入的文件')
    raw = new Map()
    for (const entry of entries) {
      const path = typeof entry?.path === 'string' ? entry.path : ''
      const data = typeof entry?.data === 'string' ? entry.data : ''
      if (!path || !data) continue
      raw.set(path, decode(data))
    }
  }

  const normalized = new Map<string, Uint8Array>()
  let total = 0
  for (const [path, bytes] of raw) {
    const safe = normalizeArchivePath(path)
    if (!safe) throw fail('path_unsafe', `压缩包包含非法路径：${path}`)
    total += bytes.byteLength
    if (bytes.byteLength > MAX_ZIP_BYTES) throw fail('archive_too_large', `单文件过大：${safe}`)
    if (total > MAX_UNPACKED_BYTES) throw fail('archive_too_large', '解压总大小超出限制')
    if (normalized.size >= MAX_ARCHIVE_FILES) throw fail('archive_too_large', `文件数量超出限制（${MAX_ARCHIVE_FILES}）`)
    normalized.set(safe, bytes)
  }

  const docs = [...normalized.keys()].filter(path => path.toLowerCase().endsWith('skill.md'))
  if (docs.length !== 1) throw fail('archive_invalid', docs.length === 0 ? '压缩包缺少 SKILL.md' : '压缩包包含多个 SKILL.md')
  const documentPath = docs[0] as string
  const prefix = posix.dirname(documentPath)
  const root = prefix === '.' ? '' : prefix

  const files = new Map<string, Uint8Array>()
  for (const [path, bytes] of normalized) {
    if (root && !path.startsWith(`${root}/`)) continue
    const relative = root ? path.slice(root.length + 1) : path
    if (!relative) continue
    files.set(relative, bytes)
  }
  return { name: root ? posix.basename(root) : '', files }
}

export interface ImportResult {
  name: string
  path: string
  overwritten: boolean
  skipped: boolean
  files: number
}

export async function importPackage(deps: OpsDeps, payload: ImportPayload): Promise<ImportResult> {
  await deps.store.ready()
  const archive = unpackPayload(payload)
  const document = archive.files.get('SKILL.md')
  if (!document) throw fail('archive_invalid', '压缩包缺少 SKILL.md')
  const parsed = parseSkillDoc(new TextDecoder().decode(document))
  const declared = (parsed.map['name'] ?? '').trim()
  const requested = typeof payload.name === 'string' ? payload.name : ''
  const name = normalizeSkillName(isSkillName(declared) ? declared : requested || archive.name)
  if (!name) throw fail('invalid_name', '无法从压缩包中得到合法技能名')
  if (!(parsed.map['description'] ?? '').trim()) throw fail('archive_invalid', 'SKILL.md 缺少 description')

  const index = await localIndex()
  const existing = index.groups.find(group => group.name === name)
  const existingDsh = existing?.copies.find(item => item.root.key === 'dsh')
  if (existingDsh && payload.conflict !== 'overwrite') {
    return { name, path: '', overwritten: false, skipped: true, files: archive.files.size }
  }

  const root = writableDshRoot()
  await fs.mkdir(root, { recursive: true })
  const target = join(root, name)
  const stage = join(root, `.skill-center-${randomUUID()}`)
  const backup = join(root, `.skill-center-backup-${randomUUID()}`)
  let movedAside = false
  try {
    await fs.mkdir(stage, { recursive: true })
    for (const [path, bytes] of archive.files) {
      const destination = join(stage, ...path.split('/'))
      await fs.mkdir(dirname(destination), { recursive: true })
      await fs.writeFile(destination, bytes)
    }
    if (await exists(target)) {
      await renameWithRetry(target, backup)
      movedAside = true
    }
    await renameWithRetry(stage, target)
    if (movedAside) await fs.rm(backup, { recursive: true, force: true }).catch(() => undefined)
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined)
    if (movedAside) await renameWithRetry(backup, target).catch(() => undefined)
    throw error
  }
  deps.onChanged?.()
  return { name, path: target, overwritten: existingDsh !== undefined, skipped: false, files: archive.files.size }
}

/** Write a validated file set into `~/.dsh/skills/<name>` with stage + rename. */
export async function writeSkillFiles(name: string, files: Map<string, Uint8Array>): Promise<string> {
  const root = writableDshRoot()
  await fs.mkdir(root, { recursive: true })
  const target = join(root, name)
  const stage = join(root, `.skill-center-${randomUUID()}`)
  const backup = join(root, `.skill-center-backup-${randomUUID()}`)
  let movedAside = false
  try {
    await fs.mkdir(stage, { recursive: true })
    for (const [path, bytes] of files) {
      const destination = join(stage, ...path.split('/'))
      await fs.mkdir(dirname(destination), { recursive: true })
      await fs.writeFile(destination, bytes)
    }
    if (await exists(target)) {
      if (await isLinked(target)) throw fail('path_unsafe', '目标是符号链接，拒绝覆盖')
      await renameWithRetry(target, backup)
      movedAside = true
    }
    await renameWithRetry(stage, target)
    if (movedAside) await fs.rm(backup, { recursive: true, force: true }).catch(() => undefined)
    return target
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined)
    if (movedAside) await renameWithRetry(backup, target).catch(() => undefined)
    throw error
  }
}

export function agentsSkillsRoot(): string {
  return agentsRoot()
}

export function dshSkillsRoot(): string {
  return writableDshRoot()
}

export function entryRootKey(entry: SkillEntry): RootKey {
  return rootKeyOf(entry.path)
}
