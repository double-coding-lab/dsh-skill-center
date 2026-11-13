import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

import { isSkillName } from './frontmatter.js'

export const policySchema = z.object({
  version: z.literal(1),
  disabled: z.array(z.string()),
  updatedAt: z.number(),
})

export type PolicyRecord = z.infer<typeof policySchema>

export const catalogInstallSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  installedAt: z.number(),
  files: z.array(z.object({ path: z.string().min(1), sha256: z.string().min(1) })),
  icon: z.string().min(1).optional(),
})

export type CatalogInstall = z.infer<typeof catalogInstallSchema>

export const iconOverrideSchema = z.object({
  version: z.literal(1),
  kind: z.enum(['image', 'glyph']),
  value: z.string().min(1),
  updatedAt: z.number(),
})

export type IconOverride = z.infer<typeof iconOverrideSchema>

export const skillCenterDomain = defineDomain({
  name: 'dsh_skill_center',
  version: 1,
  tables: {
    policy: domainTable<string, PolicyRecord>(policySchema),
    catalog_installs: domainTable<string, CatalogInstall>(catalogInstallSchema),
    icon_overrides: domainTable<string, IconOverride>(iconOverrideSchema),
  },
})

export interface StorageFace {
  open?: (spec: typeof skillCenterDomain) => Promise<DomainHandle>
}

export interface DomainHandle {
  close?: () => Promise<void>
  table(name: 'policy'): TableHandle<string, PolicyRecord>
  table(name: 'catalog_installs'): TableHandle<string, CatalogInstall>
  table(name: 'icon_overrides'): TableHandle<string, IconOverride>
}

export interface TableHandle<K extends string, V> {
  get(key: K): V | undefined
  entries(): IterableIterator<[K, V]>
  put(key: K, value: V): Promise<void>
  delete(key: K): Promise<boolean>
}

const DEFAULT_POLICY: PolicyRecord = { version: 1, disabled: [], updatedAt: 0 }

/** Domain-backed policy and install ledger; falls back to fail-closed read-only when storage is absent. */
export class SkillStore {
  private domain: DomainHandle | null = null
  private opening: Promise<DomainHandle | null> | null = null
  private readonly ctx: unknown

  /** True when the policy could not be read; callers must treat every skill as disabled. */
  failClosed = false
  /** False when writes are refused (storage missing or unreadable). */
  writable = true
  warning: string | null = null

  constructor(ctx: unknown) {
    this.ctx = ctx
  }

  private async open(): Promise<DomainHandle | null> {
    if (this.domain) return this.domain
    if (this.opening) return this.opening
    const opening = this.openOnce()
    this.opening = opening
    try {
      return await opening
    } finally {
      if (this.opening === opening) this.opening = null
    }
  }

  private async openOnce(): Promise<DomainHandle | null> {
    const face = this.ctx as {
      get?: (name: string) => unknown
      reflect?: { get?: (name: string) => unknown }
    } | null
    let facility: StorageFace | undefined
    try {
      const reflected = face?.reflect?.get?.('storageDomain')
      facility = (reflected ?? face?.get?.('storageDomain')) as StorageFace | undefined
    } catch {
      facility = undefined
    }
    if (!facility || typeof facility.open !== 'function') {
      this.writable = false
      this.failClosed = true
      this.warning = '技能策略存储不可用：当前按全部停用处理，且禁止写入。'
      return null
    }
    try {
      const domain = await facility.open(skillCenterDomain)
      this.domain = domain
      this.writable = true
      this.failClosed = false
      this.warning = null
      return domain
    } catch (error) {
      this.writable = false
      this.failClosed = true
      this.warning = `技能策略读取失败：${error instanceof Error ? error.message : String(error)}`
      return null
    }
  }

  async ready(): Promise<void> {
    await this.open()
  }

  async close(): Promise<void> {
    const domain = this.domain
    this.domain = null
    this.opening = null
    if (typeof domain?.close === 'function') await domain.close().catch(() => undefined)
  }

  private policyTable(): TableHandle<string, PolicyRecord> | null {
    return this.domain ? this.domain.table('policy') : null
  }

  private catalogTable(): TableHandle<string, CatalogInstall> | null {
    return this.domain ? this.domain.table('catalog_installs') : null
  }

  private iconTable(): TableHandle<string, IconOverride> | null {
    return this.domain ? this.domain.table('icon_overrides') : null
  }

  policy(): PolicyRecord {
    const stored = this.policyTable()?.get('default')
    if (!stored) return DEFAULT_POLICY
    return stored
  }

  disabledSet(): Set<string> {
    return new Set(this.policy().disabled)
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    if (!isSkillName(name)) throw Object.assign(new Error(`非法技能名：${name}`), { code: 'invalid_name' })
    await this.ready()
    const table = this.policyTable()
    if (!table || !this.writable) {
      throw Object.assign(new Error('技能策略存储不可写'), { code: 'policy_unavailable' })
    }
    const current = this.policy()
    const disabled = new Set(current.disabled)
    if (enabled) disabled.delete(name)
    else disabled.add(name)
    await table.put('default', { version: 1, disabled: [...disabled].sort(), updatedAt: Date.now() })
  }

  installs(): CatalogInstall[] {
    const table = this.catalogTable()
    if (!table) return []
    return [...table.entries()].map(([, value]) => value)
  }

  install(key: string): CatalogInstall | undefined {
    return this.catalogTable()?.get(key)
  }

  async putInstall(record: CatalogInstall): Promise<void> {
    await this.ready()
    const table = this.catalogTable()
    if (!table || !this.writable) throw Object.assign(new Error('技能账本不可写'), { code: 'policy_unavailable' })
    await table.put(record.key, record)
  }

  async deleteInstall(key: string): Promise<void> {
    await this.ready()
    const table = this.catalogTable()
    if (!table || !this.writable) return
    await table.delete(key)
  }

  iconOverride(name: string): IconOverride | undefined {
    return this.iconTable()?.get(name)
  }

  async setIconOverride(name: string, record: IconOverride): Promise<void> {
    await this.ready()
    const table = this.iconTable()
    if (!table || !this.writable) {
      throw Object.assign(new Error('技能图标存储不可写'), { code: 'policy_unavailable' })
    }
    await table.put(name, record)
  }

  async deleteIconOverride(name: string): Promise<void> {
    await this.ready()
    const table = this.iconTable()
    if (!table || !this.writable) return
    await table.delete(name)
  }
}
