import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { buildSkillDocument, normalizeSkillName, parseSkillDoc } from './frontmatter.js'
import { downloadArchive, fetchDetail } from './clawhub.js'
import { dshSkillsRoot, fail, hashFiles, isModified, localIndex, unpackPayload, writeSkillFiles } from './ops.js'
import type { OpsDeps } from './ops.js'
import type { CatalogInstall } from './store.js'

export interface InstallInput {
  owner: string
  slug: string
  force?: boolean
}

export interface InstallResult {
  name: string
  version: string
  path: string
  overwritten: boolean
  files: number
}

export async function installFromCatalog(deps: OpsDeps, input: InstallInput): Promise<InstallResult> {
  await deps.store.ready()
  if (!deps.store.writable) throw fail('policy_unavailable', '技能存储不可写')
  const key = `${input.owner}/${input.slug}`
  const detail = await fetchDetail({ owner: input.owner, slug: input.slug })
  const archive = await downloadArchive({ owner: input.owner, slug: input.slug })
  const unpacked = unpackPayload({ kind: 'zip', zip: archive })
  const document = unpacked.files.get('SKILL.md')
  if (!document) throw fail('archive_invalid', '技能包缺少 SKILL.md')
  const parsed = parseSkillDoc(new TextDecoder().decode(document))
  const declared = (parsed.map['name'] ?? '').trim()
  const name = normalizeSkillName(declared || input.slug || unpacked.name)
  if (!name) throw fail('invalid_name', '无法得到合法技能名')
  if (!(parsed.map['description'] ?? '').trim()) throw fail('archive_invalid', 'SKILL.md 缺少 description')

  const record = deps.store.install(key)
  const index = await localIndex()
  const group = index.groups.find(item => item.name === name)
  const ownedByRecord = record !== undefined && record.name === name
  if (record && !ownedByRecord) {
    throw fail('conflict', `该市场条目已安装为 ${record.name}，与当前名称 ${name} 不一致`)
  }

  if (record) {
    const dir = join(dshSkillsRoot(), record.name)
    if (!input.force && (await isModified(dir, record))) {
      throw fail('local_modified', '本地文件已被修改，继续安装会覆盖这些修改')
    }
  } else if (group?.copies.some(item => item.root.key === 'dsh')) {
    // Only a DSH-root copy collides; an agents-only copy stays untouched and the new DSH copy simply wins.
    if (!input.force) throw fail('conflict', `同名技能已存在：${name}`)
  }

  const target = await writeSkillFiles(name, unpacked.files)
  const next: CatalogInstall = {
    key,
    name,
    version: detail.version,
    installedAt: Date.now(),
    files: hashFiles(unpacked.files),
    ...(detail.item.icon === undefined ? {} : { icon: detail.item.icon }),
  }
  await deps.store.putInstall(next)
  deps.onChanged?.()
  return {
    name,
    version: detail.version,
    path: target,
    overwritten: record !== undefined || group !== undefined,
    files: unpacked.files.size,
  }
}

export async function uninstallFromCatalog(deps: OpsDeps, input: { owner: string; slug: string }): Promise<{ name: string; removed: string }> {
  await deps.store.ready()
  const key = `${input.owner}/${input.slug}`
  const record = deps.store.install(key)
  if (!record) throw fail('not_found', '该技能不是从市场安装的')
  const root = dshSkillsRoot()
  const target = join(root, record.name)
  if (!target.startsWith(root)) throw fail('path_unsafe', '目标路径越界')
  await fs.rm(target, { recursive: true, force: true })
  await deps.store.deleteInstall(key)
  await deps.store.deleteIconOverride(record.name)
  if (deps.store.disabledSet().has(record.name)) {
    await deps.store.setEnabled(record.name, true).catch(() => undefined)
  }
  deps.onChanged?.()
  return { name: record.name, removed: target }
}

export async function installedKeys(deps: OpsDeps): Promise<string[]> {
  await deps.store.ready()
  return deps.store.installs().map(record => record.key)
}

export interface CatalogInstallView {
  key: string
  name: string
  version: string
  updateAvailable: boolean
  localModified: boolean
  present: boolean
}

export async function installView(deps: OpsDeps, key: string): Promise<CatalogInstallView | null> {
  await deps.store.ready()
  const record = deps.store.install(key)
  if (!record) return null
  const dir = join(dshSkillsRoot(), record.name)
  let present = true
  try {
    await fs.stat(dir)
  } catch {
    present = false
  }
  const localModified = present ? await isModified(dir, record) : false
  let updateAvailable = false
  try {
    const [owner, slug] = key.split('/')
    if (owner && slug) {
      const detail = await fetchDetail({ owner, slug })
      updateAvailable = detail.version !== record.version
    }
  } catch {
    updateAvailable = false
  }
  return {
    key,
    name: record.name,
    version: record.version,
    updateAvailable,
    localModified,
    present,
  }
}

export function skillDocumentOf(input: { name: string; description: string; body: string }): string {
  return buildSkillDocument(input)
}
