import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { invocationOf, isSkillName, parseSkillDoc } from './frontmatter.js'
import { iconFileAt, iconRoute } from './icon.js'
import type { IconFile } from './icon.js'
import type { RootDescriptor, RootKey, SkillCopy, SkillView } from '../shared/types.js'

const MAX_ENTRIES_PER_ROOT = 1000

export interface SkillEntry {
  name: string
  description: string
  path: string
  dir: string
  kind: 'bundle' | 'file'
  linked: boolean
  modelInvocable: boolean
  userInvocable: boolean
  loadable: boolean
  declaredName: string | null
  icon?: IconFile
}

export interface RootScan {
  root: RootDescriptor
  entries: SkillEntry[]
  truncated: boolean
}

export function resolveDshHome(): string {
  const fromEnv = process.env['DSH_HOME']
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : join(homedir(), '.dsh')
}

export function resolveAgentsHome(): string {
  const fromEnv = process.env['DSH_AGENTS_HOME']
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : join(homedir(), '.agents')
}

export function localRoots(): RootDescriptor[] {
  return [
    {
      key: 'dsh',
      label: 'DSH',
      path: join(resolveDshHome(), 'skills'),
      rank: 400,
      writable: true,
      exists: false,
    },
    {
      key: 'agents',
      label: '公共技能',
      path: join(resolveAgentsHome(), 'skills'),
      rank: 450,
      writable: false,
      exists: false,
    },
  ]
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isFile()
  } catch {
    return false
  }
}

async function entryOf(name: string, fullPath: string, kind: 'bundle' | 'file', linked: boolean): Promise<SkillEntry | null> {
  const docPath = kind === 'bundle' ? join(fullPath, 'SKILL.md') : fullPath
  let raw: string
  try {
    raw = await fs.readFile(docPath, 'utf8')
  } catch {
    if (kind === 'bundle') return null
    return null
  }
  const doc = parseSkillDoc(raw)
  const declared = doc.map['name']?.trim() ?? ''
  const skillName = isSkillName(declared) ? declared : isSkillName(name) ? name : ''
  if (!skillName) return null
  const description = (doc.map['description'] ?? '').trim()
  const invocation = invocationOf(doc.map)
  const icon = kind === 'bundle'
    ? await iconFileAt(fullPath, doc.map['icon'])
    : await iconFileAt(dirname(fullPath), doc.map['icon'], false)
  return {
    name: skillName,
    description,
    path: docPath,
    dir: kind === 'bundle' ? fullPath : fullPath,
    kind,
    linked,
    modelInvocable: invocation.modelInvocable,
    userInvocable: invocation.userInvocable,
    loadable: doc.hasFrontmatter && description.length > 0,
    declaredName: declared || null,
    ...(icon === undefined ? {} : { icon }),
  }
}

export async function scanRoot(root: RootDescriptor): Promise<RootScan> {
  const exists = await isDirectory(root.path)
  const descriptor: RootDescriptor = { ...root, exists }
  if (!exists) return { root: descriptor, entries: [], truncated: false }

  let dirents
  try {
    dirents = await fs.readdir(root.path, { withFileTypes: true })
  } catch {
    return { root: descriptor, entries: [], truncated: false }
  }

  const entries: SkillEntry[] = []
  let truncated = false
  for (const dirent of dirents.sort((left, right) => left.name.localeCompare(right.name))) {
    if (dirent.name.startsWith('.') || dirent.name === 'node_modules') continue
    if (entries.length >= MAX_ENTRIES_PER_ROOT) {
      truncated = true
      break
    }
    const fullPath = join(root.path, dirent.name)
    let linked = dirent.isSymbolicLink()
    let directory = dirent.isDirectory()
    let file = dirent.isFile()
    if (linked) {
      directory = await isDirectory(fullPath)
      file = !directory && (await isFile(fullPath))
    }
    if (directory) {
      const entry = await entryOf(dirent.name, fullPath, 'bundle', linked)
      if (entry) entries.push(entry)
      continue
    }
    if (file && dirent.name.toLowerCase().endsWith('.md')) {
      const entry = await entryOf(dirent.name.replace(/\.md$/i, ''), fullPath, 'file', linked)
      if (entry) entries.push(entry)
    }
  }
  return { root: descriptor, entries, truncated }
}

export async function scanLocalRoots(): Promise<RootScan[]> {
  const roots = localRoots()
  const scans: RootScan[] = []
  for (const root of roots) scans.push(await scanRoot(root))
  return scans
}

export interface GroupedSkill {
  name: string
  winner: SkillEntry
  copies: { entry: SkillEntry; root: RootDescriptor }[]
}

/** Group by canonical name; the lowest-rank copy wins, the rest stay as alternatives. */
export function groupSkills(scans: RootScan[]): GroupedSkill[] {
  const groups = new Map<string, { entry: SkillEntry; root: RootDescriptor }[]>()
  for (const scan of scans) {
    for (const entry of scan.entries) {
      const list = groups.get(entry.name) ?? []
      list.push({ entry, root: scan.root })
      groups.set(entry.name, list)
    }
  }
  const result: GroupedSkill[] = []
  for (const [name, list] of groups) {
    list.sort((left, right) => left.root.rank - right.root.rank || left.entry.path.localeCompare(right.entry.path))
    const first = list[0]
    if (!first) continue
    result.push({ name, winner: first.entry, copies: list })
  }
  result.sort((left, right) => left.name.localeCompare(right.name))
  return result
}

export function toView(group: GroupedSkill, disabled: ReadonlySet<string>): SkillView {
  const copies: SkillCopy[] = group.copies.map(({ entry, root }) => ({
    root: root.key,
    path: entry.path,
    writable: root.writable,
    linked: entry.linked,
  }))
  const winnerRoot = group.copies[0]?.root.key ?? 'dsh'
  const iconEntry = group.copies.map(copy => copy.entry).find(entry => entry.icon !== undefined)
  const deletable = group.copies.some(
    copy => (copy.root.key === 'dsh' || copy.root.key === 'agents') && !copy.entry.linked,
  )
  return {
    name: group.name,
    description: group.winner.description,
    root: winnerRoot,
    path: group.winner.path,
    enabled: !disabled.has(group.name),
    editable: deletable,
    linked: group.winner.linked,
    loadable: group.winner.loadable,
    modelInvocable: group.winner.modelInvocable,
    userInvocable: group.winner.userInvocable,
    copies,
    ...(iconEntry?.icon === undefined
      ? {}
      : { icon: { url: iconRoute(group.name, iconEntry.icon.version), source: 'file' as const } }),
  }
}

export async function readSkillDocument(path: string): Promise<string> {
  return fs.readFile(path, 'utf8')
}

export function rootKeyOf(path: string): RootKey {
  const used = localRoots().find(root => path.startsWith(root.path))
  return used?.key ?? 'dsh'
}
