import { readFileSync } from 'node:fs'

import type { Context } from '@deepseek-ai/cordis'

import { notifyCatalogChange, registerProviders } from './host/provider.js'
import type { ProviderRegistration, SkillCenterContext } from './host/provider.js'
import { registerRoutes } from './host/routes.js'
import { SkillStore } from './host/store.js'
import { registerCreateTool } from './host/tool.js'
import type { ToolHost } from './host/tool.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

export const name = 'dsh-skill-center'
export const version = pkg.version
// Optional services resolve lazily: a missing tools/webServer only degrades one surface.
export const inject = ['skills']

export async function apply(ctx: Context): Promise<() => void> {
  const center = ctx as unknown as SkillCenterContext
  const store = new SkillStore(ctx)
  await store.ready().catch((error: unknown) => {
    console.warn('[dsh-skill-center] policy store unavailable', error)
  })

  let registration: ProviderRegistration | undefined
  const deps = {
    ctx: center,
    store,
    onChanged: (): void => {
      if (registration) notifyCatalogChange(center, registration)
    },
    syncAgents: (): void => {
      registration?.syncAgents()
    },
  }

  registration = registerProviders(center, store)
  const disposeTool = registerCreateTool(ctx as unknown as ToolHost, deps)
  const disposeRoutes = registerRoutes(ctx, deps, version)

  store.warning && console.warn(`[dsh-skill-center] ${store.warning}`)

  return (): void => {
    try {
      disposeRoutes()
    } catch {
      /* ignore */
    }
    try {
      disposeTool()
    } catch {
      /* ignore */
    }
    registration?.dispose()
  }
}
