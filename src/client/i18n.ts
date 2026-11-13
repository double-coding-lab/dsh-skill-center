import { useEffect, useState } from 'react'

import { EN } from './en.js'

export interface LocaleSnapshot {
  active: string
  revision: number
}

export interface LocaleFace {
  getSnapshot: () => LocaleSnapshot
  subscribe: (listener: () => void) => () => void
}

let localeFace: LocaleFace | undefined

export function bindLocale(face: LocaleFace | undefined): void {
  localeFace = face
}

export function currentLocale(): string {
  return localeFace?.getSnapshot().active ?? 'zh'
}

export function useLocaleRevision(): number {
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (localeFace === undefined) return
    return localeFace.subscribe(() => setRevision(value => value + 1))
  }, [])
  return revision
}

export function tr(key: string, params?: Record<string, string | number>): string {
  const template = currentLocale().toLowerCase().startsWith('en') ? EN[key] ?? key : key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name]
    return value === undefined ? whole : String(value)
  })
}
