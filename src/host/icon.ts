import { promises as fs } from 'node:fs'
import { extname, isAbsolute, relative, resolve, win32 } from 'node:path'

import { ROUTE_PREFIX } from '../shared/types.js'

export const MAX_ICON_BYTES = 256 * 1024
export const MAX_INLINE_ICON_BYTES = 32 * 1024

export const ICON_MEDIA_TYPES = new Map([
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
])

export const ICON_CANDIDATES = ['icon.svg', 'icon.png', 'icon.webp', 'icon.jpg', 'icon.jpeg']

const DATA_ICON_RE = /^data:(image\/(?:svg\+xml|png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/
const REMOTE_SCHEME_RE = /^[A-Za-z][A-Za-z\d+.-]*:/

export interface IconFile {
  path: string
  mediaType: string
  version: string
}

export interface DataIcon {
  mediaType: string
  bytes: Buffer
}

export function mediaTypeOf(path: string): string | undefined {
  return ICON_MEDIA_TYPES.get(extname(path).toLowerCase())
}

function inside(parent: string, child: string): boolean {
  const local = relative(parent, child)
  return local !== '' && !local.startsWith('..') && !isAbsolute(local)
}

export function isRelativeIconPath(value: string): boolean {
  return (
    value.length > 0
    && !isAbsolute(value)
    && !win32.isAbsolute(value)
    && !REMOTE_SCHEME_RE.test(value)
    && !value.includes('\0')
  )
}

async function fileIcon(target: string, root: string): Promise<IconFile | undefined> {
  let real: string
  try {
    real = await fs.realpath(target)
  } catch {
    return undefined
  }
  if (!inside(root, real)) return undefined
  const mediaType = mediaTypeOf(real)
  if (!mediaType) return undefined
  let stat
  try {
    stat = await fs.stat(real)
  } catch {
    return undefined
  }
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_ICON_BYTES) return undefined
  return { path: real, mediaType, version: `${Math.round(stat.mtimeMs)}-${stat.size}` }
}

/** Resolve a skill's declared or conventional icon without leaving its directory. */
export async function iconFileAt(baseDir: string, declared?: string, autoDetect = true): Promise<IconFile | undefined> {
  let root: string
  try {
    root = await fs.realpath(baseDir)
  } catch {
    return undefined
  }
  if (declared && isRelativeIconPath(declared.trim())) {
    const explicit = await fileIcon(resolve(root, declared.trim()), root)
    if (explicit) return explicit
  }
  if (!autoDetect) return undefined
  for (const name of ICON_CANDIDATES) {
    const found = await fileIcon(resolve(root, name), root)
    if (found) return found
  }
  return undefined
}

export function parseDataIcon(value: string, limit = MAX_ICON_BYTES): DataIcon | undefined {
  const match = DATA_ICON_RE.exec(value.trim())
  if (!match) return undefined
  const mediaType = match[1] as string
  const payload = (match[2] as string).replace(/\s+/g, '')
  if (!payload) return undefined
  let bytes: Buffer
  try {
    bytes = Buffer.from(payload, 'base64')
  } catch {
    return undefined
  }
  if (!bytes.byteLength || bytes.byteLength > limit) return undefined
  return { mediaType, bytes }
}

/** Accept only HTTPS or inline image data from the catalog. */
export function normalizeCatalogIcon(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text) return undefined
  if (text.startsWith('data:')) {
    return parseDataIcon(text, MAX_INLINE_ICON_BYTES) ? text : undefined
  }
  try {
    const url = new URL(text, 'https://clawhub.ai')
    return url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

export function iconRoute(name: string, version: string | number): string {
  const params = new URLSearchParams({ name, v: String(version) })
  return `${ROUTE_PREFIX}/api/skill-icon?${params.toString()}`
}
