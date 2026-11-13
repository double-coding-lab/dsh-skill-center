import { parseSkillDoc } from './frontmatter.js'
import { normalizeCatalogIcon } from './icon.js'
import { CATALOG_TIMEOUT_MS, CLAWHUB_BASE, MAX_JSON_BYTES, MAX_ZIP_BYTES } from '../shared/types.js'
import type { CatalogItem } from '../shared/types.js'

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const USER_AGENT = 'dsh-skill-center/0.1.0'

export interface CatalogDetail {
  item: CatalogItem
  body: string
  version: string
  files: number
}

let queue: Promise<unknown> = Promise.resolve()

function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task)
  queue = next.catch(() => undefined)
  return next
}

export function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER_RE.test(value)
}

function fail(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

function safeText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

async function readBody(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined)
    throw fail('archive_too_large', '目录响应超出大小限制')
  }
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = response.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) throw fail('archive_too_large', '目录响应超出大小限制')
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, size)
}

async function request(path: string, accept: string, limit: number): Promise<Buffer> {
  let response: Response
  try {
    response = await fetch(`${CLAWHUB_BASE}${path}`, {
      headers: { accept, 'user-agent': USER_AGENT },
      redirect: 'error',
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    })
  } catch {
    throw fail('catalog_unreachable', 'ClawHub 暂时无法连接')
  }
  if (!response.ok) throw fail('catalog_unreachable', `ClawHub 返回 ${response.status}`)
  return readBody(response, limit)
}

async function requestJson(path: string): Promise<Record<string, unknown>> {
  const bytes = await request(path, 'application/json', MAX_JSON_BYTES)
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed as Record<string, unknown>
  } catch {
    throw fail('catalog_invalid', 'ClawHub 返回了无效 JSON')
  }
}

function topicsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const topics = value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim().slice(0, 48))
    .filter(Boolean)
    .slice(0, 8)
  return topics.length ? topics : undefined
}

function itemOf(
  owner: unknown,
  slug: unknown,
  title: unknown,
  summary: unknown,
  downloads: unknown,
  version: unknown,
  icon: unknown,
  topics: unknown,
): CatalogItem | null {
  if (!isIdentifier(owner) || !isIdentifier(slug)) return null
  const item: CatalogItem = {
    key: `${owner}/${slug}`,
    owner,
    slug,
    title: safeText(title, 200) || slug,
    summary: safeText(summary, 500),
  }
  const downloadsValue = count(downloads)
  if (downloadsValue !== undefined) item.downloads = downloadsValue
  const versionText = safeText(version, 64)
  if (versionText) item.version = versionText
  const iconText = normalizeCatalogIcon(icon)
  if (iconText) item.icon = iconText
  const topicsList = topicsOf(topics)
  if (topicsList) item.topics = topicsList
  return item
}

function versionOf(value: unknown): string | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const tags = (value as { tags?: unknown }).tags
    if (tags && typeof tags === 'object' && !Array.isArray(tags)) {
      const latest = (tags as Record<string, unknown>)['latest']
      if (typeof latest === 'string' && latest.trim()) return latest.trim()
    }
  }
  return undefined
}

const POPULAR_PAGE_SIZE = 10
const POPULAR_MAX = 30

export async function listPopular(options: { limit?: number; cursor?: string } = {}): Promise<{ items: CatalogItem[]; nextCursor: string | null }> {
  const requested = Math.min(Math.max(options.limit ?? POPULAR_PAGE_SIZE, 1), POPULAR_MAX)
  const limit = Math.ceil(requested / POPULAR_PAGE_SIZE) * POPULAR_PAGE_SIZE
  return serial(async () => {
    const items: CatalogItem[] = []
    const seen = new Set<string>()
    let cursor = options.cursor
    let nextCursor: string | null = null
    for (let page = 0; page < POPULAR_MAX / POPULAR_PAGE_SIZE && items.length < limit; page += 1) {
      const params = new URLSearchParams({ sort: 'downloads', limit: String(POPULAR_PAGE_SIZE) })
      if (cursor) params.set('cursor', cursor)
      const payload = await requestJson(`/api/v1/skills?${params.toString()}`)
      const raw = Array.isArray(payload['items']) ? (payload['items'] as unknown[]) : []
      for (const value of raw) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue
        const record = value as Record<string, unknown>
        const item = itemOf(
          record['ownerHandle'],
          record['slug'],
          record['displayName'],
          record['summary'],
          (record['stats'] as Record<string, unknown> | undefined)?.['downloads'],
          versionOf(record),
          record['icon'],
          record['topics'],
        )
        if (item && !seen.has(item.key)) {
          seen.add(item.key)
          items.push(item)
        }
      }
      const next = payload['nextCursor']
      nextCursor = typeof next === 'string' && next ? next : null
      if (!nextCursor) break
      cursor = nextCursor
    }
    return { items, nextCursor }
  })
}

export async function search(options: { q: string; limit?: number }): Promise<CatalogItem[]> {
  const query = typeof options.q === 'string' ? options.q.trim() : ''
  if (query.length < 2 || query.length > 100) throw fail('invalid_name', '搜索词需为 2–100 个字符')
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100)
  return serial(async () => {
    const params = new URLSearchParams({ q: query, limit: String(limit) })
    const payload = await requestJson(`/api/v1/search?${params.toString()}`)
    const raw = Array.isArray(payload['results']) ? (payload['results'] as unknown[]) : []
    const items: CatalogItem[] = []
    for (const value of raw) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const record = value as Record<string, unknown>
      const reference = (record['install'] as Record<string, unknown> | undefined)?.['reference']
      const parts = typeof reference === 'string' ? reference.split('/') : []
      const canonical = typeof record['canonicalUrl'] === 'string' ? record['canonicalUrl'].split('/') : []
      const owner = parts[0] ?? canonical[1]
      const slug = parts[1] ?? canonical[3]
      const native = record['native'] as Record<string, unknown> | undefined
      const nativeSkill = native?.['skill'] as Record<string, unknown> | undefined
      const item = itemOf(
        owner,
        slug,
        record['displayName'],
        record['summary'],
        record['downloads'],
        versionOf(record),
        record['icon'],
        record['topics'] ?? nativeSkill?.['categories'],
      )
      if (item) items.push(item)
      if (items.length >= limit) break
    }
    return items
  })
}

export async function fetchDetail(options: { owner: string; slug: string }): Promise<CatalogDetail> {
  const { owner, slug } = options
  if (!isIdentifier(owner) || !isIdentifier(slug)) throw fail('invalid_name', '目录技能标识无效')
  return serial(async () => {
    const payload = await requestJson(`/api/v1/skills/${encodeURIComponent(slug)}?owner=${encodeURIComponent(owner)}`)
    const skill = payload['skill'] && typeof payload['skill'] === 'object' ? (payload['skill'] as Record<string, unknown>) : {}
    const latest = payload['latestVersion'] && typeof payload['latestVersion'] === 'object'
      ? (payload['latestVersion'] as Record<string, unknown>)
      : {}
    const description = typeof skill['description'] === 'string' ? skill['description'] : ''
    const parsed = parseSkillDoc(description)
    const item = itemOf(
      owner,
      slug,
      skill['displayName'],
      skill['summary'] || parsed.map['description'],
      (skill['stats'] as Record<string, unknown> | undefined)?.['downloads'],
      latest['version'] ?? versionOf(skill),
      skill['icon'],
      skill['topics'] ?? skill['categories'],
    )
    if (!item) throw fail('catalog_invalid', 'ClawHub 返回了无效的技能详情')
    return {
      item,
      body: parsed.hasFrontmatter ? parsed.body : description,
      version: safeText(latest['version'], 64) || item.version || '0.0.0',
      files: 0,
    }
  })
}

/** Download the published archive and return it as base64 (install path reuses the import validator). */
export async function downloadArchive(options: { owner: string; slug: string }): Promise<string> {
  const { owner, slug } = options
  if (!isIdentifier(owner) || !isIdentifier(slug)) throw fail('invalid_name', '目录技能标识无效')
  return serial(async () => {
    const params = new URLSearchParams({ slug, owner })
    const bytes = await request(`/api/v1/download?${params.toString()}`, 'application/zip', MAX_ZIP_BYTES)
    return bytes.toString('base64')
  })
}
