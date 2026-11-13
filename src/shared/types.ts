/** Shared constants and wire/view types for the host routes and the client panel. */

export const ROUTE_PREFIX = '/dsh-skill-center'
export const PANEL_ID = 'dsh-skill-center'
export const CREATOR_SKILL_NAME = 'skill-center-creator'
export const CREATE_TOOL_NAME = 'skill_center_create'

/** Host-native ranks: ~/.dsh/skills = 400, ~/.agents/skills = 450, presets = 299. */
export const DISABLED_OVERLAY_RANK = 298
export const CREATOR_SKILL_RANK = 350

export const CLAWHUB_BASE = 'https://clawhub.ai'
export const CATALOG_TIMEOUT_MS = 10_000
export const MAX_JSON_BYTES = 1 << 20
export const MAX_ZIP_BYTES = 32 << 20
export const MAX_ARCHIVE_FILES = 500
export const MAX_UNPACKED_BYTES = 64 << 20
export const MAX_ARCHIVE_DEPTH = 8
export const MAX_NAME_LENGTH = 128
export const MAX_BODY_BYTES = 1 << 18

export type RootKey = 'dsh' | 'agents' | 'preset'

export interface RootDescriptor {
  key: RootKey
  label: string
  path: string
  rank: number
  writable: boolean
  exists: boolean
}

export interface SkillCopy {
  root: RootKey
  path: string
  writable: boolean
  linked: boolean
}

export interface CatalogState {
  key: string
  name: string
  version: string
  updateAvailable: boolean
  localModified: boolean
  present: boolean
}

export const SKILL_GLYPHS = [
  'code',
  'git',
  'doc',
  'data',
  'image',
  'web',
  'security',
  'test',
  'deploy',
  'search',
  'agent',
  'generic',
] as const

export type SkillGlyph = (typeof SKILL_GLYPHS)[number]

export type SkillIconSource = 'override' | 'file' | 'market'

export interface SkillIcon {
  url?: string
  glyph?: SkillGlyph
  source: SkillIconSource
}

export interface SkillView {
  name: string
  description: string
  root: RootKey
  path: string
  enabled: boolean
  editable: boolean
  linked: boolean
  loadable: boolean
  modelInvocable: boolean
  userInvocable: boolean
  copies: SkillCopy[]
  catalog?: CatalogState
  icon?: SkillIcon
}

export interface StatePayload {
  roots: RootDescriptor[]
  skills: SkillView[]
  counts: Record<RootKey, number>
  writable: boolean
  warning: string | null
  truncated: boolean
}

export interface SkillDetailPayload {
  skill: SkillView
  document: string
  frontmatter: Record<string, string> | null
  body: string
}

export interface CatalogItem {
  key: string
  owner: string
  slug: string
  title: string
  summary: string
  downloads?: number
  version?: string
  icon?: string
  topics?: string[]
}

export interface CatalogListPayload {
  items: CatalogItem[]
  nextCursor: string | null
  installed: string[]
}

export interface CatalogDetailPayload {
  item: CatalogItem
  body: string
  files: number
  installed: CatalogState | null
}

export interface ImportEntry {
  path: string
  /** base64 of the file bytes. */
  data: string
}

export interface ImportPayload {
  kind: 'zip' | 'entries'
  name?: string
  /** base64 zip archive, when kind === 'zip'. */
  zip?: string
  entries?: ImportEntry[]
  conflict?: 'skip' | 'overwrite'
}

export type ApiEnvelope<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

export interface CreateFileInput {
  path: string
  content: string
}

export interface CreateInput {
  name: string
  description: string
  body: string
  /** Optional supporting files (references/, scripts/) written next to SKILL.md. */
  files?: CreateFileInput[]
}

export function isApiEnvelope(value: unknown): value is ApiEnvelope<unknown> {
  return typeof value === 'object' && value !== null && 'ok' in value
}
