import type { IncomingMessage, ServerResponse } from 'node:http'

import { listPopular, search, fetchDetail } from './clawhub.js'
import { installFromCatalog, installView, uninstallFromCatalog } from './installs.js'
import { createSkill, deleteSkill, detailOf, fail, importPackage, setEnabled, stateOf } from './ops.js'
import type { OpsDeps } from './ops.js'
import { ROUTE_PREFIX } from '../shared/types.js'
import type { ApiEnvelope, ImportPayload } from '../shared/types.js'

interface RouterFace {
  register(options: { kind: 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }): () => void
}

const MAX_BODY_BYTES = 96 << 20

function json(res: ServerResponse, status: number, body: ApiEnvelope<unknown>): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function statusFor(code: string): number {
  if (code.startsWith('invalid_') || code === 'archive_invalid') return 400
  if (code === 'not_found') return 404
  if (code === 'conflict' || code === 'local_modified') return 409
  if (code === 'not_writable' || code === 'path_unsafe') return 403
  if (code === 'archive_too_large') return 413
  if (code === 'catalog_unreachable' || code === 'catalog_invalid') return 502
  if (code === 'policy_unavailable' || code === 'storage_unavailable') return 503
  return 500
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw fail('archive_too_large', '请求体过大')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) throw fail('archive_too_large', '请求体过大')
    chunks.push(buffer)
  }
  if (!chunks.length) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks, size).toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed as Record<string, unknown>
  } catch {
    throw fail('invalid_name', '请求体不是有效 JSON')
  }
}

/** Reject cross-site writes; the server only serves the local DSH web client. */
function checkedMutation(req: IncomingMessage): void {
  const contentType = String(req.headers['content-type'] ?? '')
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw fail('invalid_name', '请求必须是 application/json')
  }
  const site = String(req.headers['sec-fetch-site'] ?? '')
  if (site && site !== 'same-origin' && site !== 'none') throw fail('not_writable', '拒绝跨站请求')
  const origin = req.headers.origin
  const host = req.headers.host
  if (typeof origin === 'string' && typeof host === 'string' && origin) {
    try {
      if (new URL(origin).host !== host) throw fail('not_writable', '拒绝跨站请求')
    } catch {
      throw fail('not_writable', '无效的 Origin')
    }
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function registerRoutes(ctx: unknown, deps: OpsDeps, version: string): () => void {
  const host = ctx as { get?: (name: string) => unknown } | null
  let router: RouterFace | undefined
  try {
    router = typeof host?.get === 'function' ? (host.get('webServer') as RouterFace | undefined) : undefined
  } catch {
    router = undefined
  }
  if (!router || typeof router.register !== 'function') {
    console.warn('[dsh-skill-center] webServer unavailable; panel API disabled')
    return () => {}
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const method = req.method ?? 'GET'
    try {
      if (method === 'GET' && path === `${ROUTE_PREFIX}/api/health`) {
        json(res, 200, { ok: true, value: { name: 'dsh-skill-center', version } })
        return
      }
      if (method === 'GET' && path === `${ROUTE_PREFIX}/api/state`) {
        json(res, 200, { ok: true, value: await stateOf(deps) })
        return
      }
      if (method === 'GET' && path === `${ROUTE_PREFIX}/api/detail`) {
        json(res, 200, { ok: true, value: await detailOf(deps, url.searchParams.get('name') ?? '') })
        return
      }
      if (method === 'GET' && path === `${ROUTE_PREFIX}/api/catalog/popular`) {
        const cursor = url.searchParams.get('cursor') ?? undefined
        const limit = Number(url.searchParams.get('limit') ?? '10')
        const page = await listPopular({ limit: Number.isFinite(limit) ? limit : 10, cursor })
        const installed = deps.store.installs().map(record => record.key)
        json(res, 200, { ok: true, value: { ...page, installed } })
        return
      }
      if (method === 'GET' && path === `${ROUTE_PREFIX}/api/catalog/search`) {
        const items = await search({
          q: url.searchParams.get('q') ?? '',
          limit: Number(url.searchParams.get('limit') ?? '20') || 20,
        })
        const installed = deps.store.installs().map(record => record.key)
        json(res, 200, { ok: true, value: { items, nextCursor: null, installed } })
        return
      }
      if (method === 'GET' && path === `${ROUTE_PREFIX}/api/catalog/detail`) {
        const owner = url.searchParams.get('owner') ?? ''
        const slug = url.searchParams.get('slug') ?? ''
        const detail = await fetchDetail({ owner, slug })
        const installed = await installView(deps, `${owner}/${slug}`)
        json(res, 200, { ok: true, value: { item: detail.item, body: detail.body, files: detail.files, installed } })
        return
      }
      if (method === 'POST') {
        checkedMutation(req)
        const body = await readJson(req)
        if (path === `${ROUTE_PREFIX}/api/enable` || path === `${ROUTE_PREFIX}/api/disable`) {
          const name = text(body['name'])
          json(res, 200, { ok: true, value: await setEnabled(deps, name, path.endsWith('/enable')) })
          return
        }
        if (path === `${ROUTE_PREFIX}/api/create`) {
          const value = await createSkill(deps, {
            name: text(body['name']),
            description: text(body['description']),
            body: text(body['body']),
          })
          json(res, 200, { ok: true, value })
          return
        }
        if (path === `${ROUTE_PREFIX}/api/delete`) {
          json(res, 200, { ok: true, value: await deleteSkill(deps, text(body['name'])) })
          return
        }
        if (path === `${ROUTE_PREFIX}/api/import`) {
          const payload = body as unknown as ImportPayload
          json(res, 200, { ok: true, value: await importPackage(deps, payload) })
          return
        }
        if (path === `${ROUTE_PREFIX}/api/catalog/install`) {
          json(res, 200, {
            ok: true,
            value: await installFromCatalog(deps, {
              owner: text(body['owner']),
              slug: text(body['slug']),
              force: body['force'] === true,
            }),
          })
          return
        }
        if (path === `${ROUTE_PREFIX}/api/catalog/uninstall`) {
          json(res, 200, {
            ok: true,
            value: await uninstallFromCatalog(deps, { owner: text(body['owner']), slug: text(body['slug']) }),
          })
          return
        }
      }
      json(res, 404, { ok: false, error: { code: 'not_found', message: path } })
    } catch (error) {
      const coded = error as Error & { code?: string }
      const code = typeof coded?.code === 'string' ? coded.code : 'internal_error'
      json(res, statusFor(code), { ok: false, error: { code, message: String(coded?.message ?? coded) } })
    }
  }

  return router.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
}
