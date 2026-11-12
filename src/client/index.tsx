import type { Context } from '@deepseek-ai/cordis'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { PANEL_ID, ROUTE_PREFIX } from '../shared/types.js'
import type {
  ApiEnvelope,
  CatalogDetailPayload,
  CatalogItem,
  CatalogListPayload,
  ImportEntry,
  SkillDetailPayload,
  SkillView,
  StatePayload,
} from '../shared/types.js'

const STYLE_ID = 'dsh-skill-center-style'
const PROBE_ROUNDS = 6
const PROBE_INTERVAL_MS = 350
const TOAST_MS = 2600
const SEARCH_DEBOUNCE_MS = 320
const MAX_UPLOAD_FILES = 500
const MAX_UPLOAD_BYTES = 64 << 20

const ROOT_LABELS: Record<SkillView['root'], string> = {
  dsh: '本地技能',
  agents: '公共技能',
  preset: '由插件提供',
}

interface SlotsFace {
  inject: (name: string, callback: () => unknown) => unknown
  register: (spec: Record<string, unknown>, component: unknown) => () => void
}

interface WorkspaceFace {
  startSession: (workspaceId: string | undefined, options?: { prompt?: string; clearPreviousDraft?: boolean }) => void
}

class ApiError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${ROUTE_PREFIX}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let payload: ApiEnvelope<T>
  try {
    payload = (await response.json()) as ApiEnvelope<T>
  } catch {
    throw new ApiError('internal_error', `请求失败（HTTP ${response.status}）`)
  }
  if (!payload.ok) throw new ApiError(payload.error.code, payload.error.message)
  return payload.value
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step))
  }
  return btoa(binary)
}

async function fileBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer())
}

function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = []
    const next = (): void => {
      reader.readEntries(batch => {
        if (!batch.length) {
          resolve(all)
          return
        }
        all.push(...batch)
        next()
      }, reject)
    }
    next()
  })
}

async function readEntry(
  entry: FileSystemEntry,
  prefix: string,
  entries: ImportEntry[],
  state: { total: number },
): Promise<void> {
  if (entry.name.startsWith('.') || entry.name === 'node_modules') return
  const path = prefix ? `${prefix}/${entry.name}` : entry.name
  if (entry.isDirectory) {
    const dir = entry as FileSystemDirectoryEntry
    for (const child of await readAllEntries(dir.createReader())) {
      await readEntry(child, path, entries, state)
    }
    return
  }
  if (!entry.isFile) return
  const fileEntry = entry as FileSystemFileEntry
  const file = await new Promise<File>((resolve, reject) => fileEntry.file(resolve, reject))
  state.total += file.size
  if (state.total > MAX_UPLOAD_BYTES) throw new Error('解压后总大小超过 64 MB 上限')
  if (entries.length >= MAX_UPLOAD_FILES) throw new Error(`文件数量超过 ${MAX_UPLOAD_FILES} 上限`)
  entries.push({ path, data: bytesToBase64(await fileBytes(file)) })
}

interface FsFileHandle {
  kind: 'file'
  name: string
  getFile: () => Promise<File>
}

interface FsDirectoryHandle {
  kind: 'directory'
  name: string
  values: () => AsyncIterableIterator<FsFileHandle | FsDirectoryHandle>
}

type FsWindow = Window & {
  showDirectoryPicker?: (options?: { mode?: 'read' }) => Promise<FsDirectoryHandle>
}

async function readDirectoryHandle(
  handle: FsDirectoryHandle,
  prefix: string,
  entries: ImportEntry[],
  state: { total: number },
): Promise<void> {
  for await (const child of handle.values()) {
    if (child.name.startsWith('.') || child.name === 'node_modules') continue
    const path = `${prefix}/${child.name}`
    if (child.kind === 'directory') {
      await readDirectoryHandle(child, path, entries, state)
      continue
    }
    const file = await child.getFile()
    state.total += file.size
    if (state.total > MAX_UPLOAD_BYTES) throw new Error('解压后总大小超过 64 MB 上限')
    if (entries.length >= MAX_UPLOAD_FILES) throw new Error(`文件数量超过 ${MAX_UPLOAD_FILES} 上限`)
    entries.push({ path, data: bytesToBase64(await fileBytes(file)) })
  }
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function formatDownloads(value: number | undefined): string {
  if (value === undefined) return ''
  if (value < 1000) return `${value} 次下载`
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k 次下载`
  return `${(value / 1_000_000).toFixed(1)}M 次下载`
}

function matches(skill: SkillView, keyword: string): boolean {
  if (!keyword) return true
  const needle = keyword.toLowerCase()
  return skill.name.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle)
}

export function apply(ctx: Context): () => void {
  try {
    return applyInner(ctx)
  } catch (error) {
    console.error('[dsh-skill-center] apply failed', error)
    throw error
  }
}

function applyInner(ctx: Context): () => void {
  installStyles()
  const get = (ctx as Context & { get?: (name: string) => unknown }).get?.bind(ctx)
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const startCreate = (description: string): void => {
    const workspace = get?.('uiWorkspace') as WorkspaceFace | undefined
    const prompt = `/skill-center-creator 请帮我创建一个技能：${description.trim()}`
    if (workspace && typeof workspace.startSession === 'function') {
      workspace.startSession(undefined, { prompt, clearPreviousDraft: true })
      return
    }
    throw new ApiError('internal_error', '当前 DSH 版本不支持从面板打开会话')
  }

  const mount = (round: number): void => {
    if (disposed) return
    const slots = get?.('slots') as SlotsFace | undefined
    if (slots === undefined) {
      if (round < PROBE_ROUNDS) timer = setTimeout(() => mount(round + 1), PROBE_INTERVAL_MS)
      else console.warn('[dsh-skill-center] slots service unavailable; panel not mounted')
      return
    }
    try {
      slots.inject('main', () =>
        slots.register({ name: 'main', key: PANEL_ID }, () => <Panel onCreate={startCreate} />),
      )
      slots.inject('sidebar.panellist', () =>
        slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 24, label: () => '技能中心' }, PanelIcon),
      )
    } catch (error) {
      console.error('[dsh-skill-center] panel registration failed', error)
    }
  }

  mount(0)
  return () => {
    disposed = true
    if (timer !== undefined) clearTimeout(timer)
  }
}

// ── 面板 ────────────────────────────────────────────────────────────────────

type Tab = 'installed' | 'discover'

type Dialog =
  | { kind: 'create' }
  | { kind: 'upload' }
  | { kind: 'delete'; skill: SkillView }
  | null

type Route =
  | { kind: 'list' }
  | { kind: 'skill'; name: string }
  | { kind: 'catalog'; item: CatalogItem }

function Panel({ onCreate }: { onCreate: (description: string) => void }): JSX.Element {
  const [tab, setTab] = useState<Tab>('installed')
  const [state, setState] = useState<StatePayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [dialog, setDialog] = useState<Dialog>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const [catalogVersion, setCatalogVersion] = useState(0)
  const [route, setRoute] = useState<Route>({ kind: 'list' })

  const refresh = async (quiet = false): Promise<void> => {
    if (!quiet) setRefreshing(true)
    try {
      const next = await api<StatePayload>('/api/state')
      setState(next)
      setBanner(null)
    } catch (error) {
      setBanner(errorText(error))
    } finally {
      setLoading(false)
      if (!quiet) setRefreshing(false)
    }
  }

  useEffect(() => {
    void refresh(true)
  }, [])

  useEffect(() => {
    if (!toast) return undefined
    const id = window.setTimeout(() => setToast(null), TOAST_MS)
    return () => window.clearTimeout(id)
  }, [toast])

  useEffect(() => {
    if (!addOpen) return undefined
    const close = (): void => setAddOpen(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [addOpen])

  const mark = (name: string, value: boolean): void => {
    setPending(current => {
      const next = { ...current }
      if (value) next[name] = true
      else delete next[name]
      return next
    })
  }

  const toggle = async (skill: SkillView, enabled: boolean): Promise<void> => {
    mark(skill.name, true)
    try {
      await api(`/api/${enabled ? 'enable' : 'disable'}`, { name: skill.name })
      setState(current =>
        current
          ? { ...current, skills: current.skills.map(item => (item.name === skill.name ? { ...item, enabled } : item)) }
          : current,
      )
    } catch (error) {
      setBanner(errorText(error))
    } finally {
      mark(skill.name, false)
    }
  }

  const writable = state?.writable !== false
  const skills = state?.skills ?? []
  const visible = useMemo(() => skills.filter(skill => matches(skill, query.trim())), [skills, query])

  return (
    <div className="dsc-root">
      <div className="dsc-inner">
        {route.kind === 'list'
          ? (
            <>
        <header className="dsc-head">
          <div className="dsc-head-title">
            <h1>技能中心</h1>
          </div>
          <div className="dsc-head-actions">
            <button
              type="button"
              className="dsc-btn dsc-btn-ghost"
              onClick={() => void refresh()}
              disabled={refreshing}
            >
              {refreshing ? <Spinner size={14} /> : <IconRefresh size={14} />}
              刷新
            </button>
            <div className="dsc-add">
              <button
                type="button"
                className="dsc-btn dsc-btn-primary"
                aria-haspopup="menu"
                aria-expanded={addOpen}
                onClick={event => {
                  event.stopPropagation()
                  setAddOpen(current => !current)
                }}
              >
                <IconPlus size={14} />
                添加
                <IconChevron size={12} />
              </button>
              {addOpen ? (
                <>
                  <div className="dsc-mask" onClick={() => setAddOpen(false)} />
                  <div className="dsc-menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!writable}
                      onClick={() => {
                        setAddOpen(false)
                        setDialog({ kind: 'upload' })
                      }}
                    >
                      <IconUpload size={14} />
                      上传技能
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!writable}
                      onClick={() => {
                        setAddOpen(false)
                        setDialog({ kind: 'create' })
                      }}
                    >
                      <IconSpark size={14} />
                      创建技能
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </header>

        <nav className="dsc-tabs" role="tablist" aria-label="技能中心视图">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'installed'}
            className={tab === 'installed' ? 'dsc-tab is-active' : 'dsc-tab'}
            onClick={() => setTab('installed')}
          >
            已安装
            {state ? <span className="dsc-tab-count">{skills.length}</span> : null}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'discover'}
            className={tab === 'discover' ? 'dsc-tab is-active' : 'dsc-tab'}
            onClick={() => setTab('discover')}
          >
            市场
          </button>
        </nav>

        {banner ? <div className="dsc-banner is-error">{banner}</div> : null}
        {state?.warning ? <div className="dsc-banner is-warn">{state.warning}</div> : null}
        {state?.truncated ? <div className="dsc-banner is-warn">技能数量超过扫描上限，列表已截断。</div> : null}

        {tab === 'installed' ? (
          <InstalledTab
            state={state}
            skills={visible}
            loading={loading}
            query={query}
            onQuery={setQuery}
            writable={writable}
            pending={pending}
            onToggle={toggle}
            onOpen={skill => setRoute({ kind: 'skill', name: skill.name })}
            onDelete={skill => setDialog({ kind: 'delete', skill })}
            onUpload={() => setDialog({ kind: 'upload' })}
            onCreate={() => setDialog({ kind: 'create' })}
          />
        ) : (
          <DiscoverTab
            version={catalogVersion}
            onOpen={item => setRoute({ kind: 'catalog', item })}
            onInstalled={message => {
              setToast(message)
              void refresh(true)
            }}
            onNotify={setToast}
          />
        )}
            </>
          )
          : route.kind === 'skill'
            ? (
              <SkillPage
                name={route.name}
                writable={writable}
                onBack={() => setRoute({ kind: 'list' })}
                onChanged={async message => {
                  await refresh(true)
                  setToast(message)
                }}
                onDelete={skill => setDialog({ kind: 'delete', skill })}
              />
            )
            : (
              <CatalogPage
                item={route.item}
                onBack={() => setRoute({ kind: 'list' })}
                onChanged={async message => {
                  await refresh(true)
                  setCatalogVersion(current => current + 1)
                  setToast(message)
                }}
              />
            )}
      </div>

      {dialog?.kind === 'delete' ? (
        <DeleteDialog
          skill={dialog.skill}
          onClose={() => setDialog(null)}
          onDeleted={async message => {
            setDialog(null)
            setRoute({ kind: 'list' })
            await refresh(true)
            setToast(message)
          }}
        />
      ) : null}

      {dialog?.kind === 'create' ? (
        <CreateDialog
          onClose={() => setDialog(null)}
          onCreate={description => {
            onCreate(description)
            setDialog(null)
            setToast('已在新会话中打开技能创建器')
          }}
        />
      ) : null}

      {dialog?.kind === 'upload' ? (
        <UploadDialog
          onClose={() => setDialog(null)}
          onDone={async name => {
            setDialog(null)
            await refresh(true)
            setToast(`已导入 ${name}`)
          }}
        />
      ) : null}

      {toast ? <div className="dsc-toast">{toast}</div> : null}
    </div>
  )
}

// ── 已安装 ──────────────────────────────────────────────────────────────────

interface InstalledProps {
  state: StatePayload | null
  skills: SkillView[]
  loading: boolean
  query: string
  onQuery: (value: string) => void
  writable: boolean
  pending: Record<string, boolean>
  onToggle: (skill: SkillView, enabled: boolean) => Promise<void>
  onOpen: (skill: SkillView) => void
  onDelete: (skill: SkillView) => void
  onUpload: () => void
  onCreate: () => void
}

const GROUP_ORDER: SkillView['root'][] = ['dsh', 'agents', 'preset']

function InstalledTab(props: InstalledProps): JSX.Element {
  const { state, skills, loading, query, onQuery, writable, pending } = props

  if (loading && state === null) {
    return (
      <div className="dsc-loading">
        <Spinner size={18} />
        正在读取技能目录
      </div>
    )
  }

  const total = state?.skills.length ?? 0
  const groups = GROUP_ORDER.map(key => ({
    key,
    items: skills.filter(skill => skill.root === key),
  })).filter(group => group.items.length > 0)

  return (
    <div className="dsc-pane">
      {total > 0 ? (
        <SearchBox value={query} onChange={onQuery} placeholder="搜索技能名称或描述" />
      ) : null}

      {total === 0 ? (
        <EmptyState
          title="还没有本地技能"
          hint={writable ? '上传一个技能包，或让 AI 帮你写一个。' : '当前为只读模式，无法写入技能目录。'}
          actions={
            writable ? (
              <>
                <button type="button" className="dsc-btn dsc-btn-outline" onClick={props.onUpload}>
                  <IconUpload size={14} />
                  上传技能
                </button>
                <button type="button" className="dsc-btn dsc-btn-primary" onClick={props.onCreate}>
                  <IconSpark size={14} />
                  创建技能
                </button>
              </>
            ) : null
          }
        />
      ) : groups.length === 0 ? (
        <EmptyState
          title="没有匹配的技能"
          hint={`没有找到包含「${query.trim()}」的技能。`}
          actions={
            <button type="button" className="dsc-btn dsc-btn-outline" onClick={() => onQuery('')}>
              清除搜索
            </button>
          }
        />
      ) : (
        groups.map(group => (
          <section className="dsc-section" key={group.key}>
            <div className="dsc-section-head">
              <h2>
                {ROOT_LABELS[group.key]}
                <span className="dsc-count">{group.items.length}</span>
              </h2>
            </div>
            <div className="dsc-list">
              {group.items.map(skill => (
                <SkillRow
                  key={`${group.key}:${skill.name}`}
                  skill={skill}
                  busy={pending[skill.name] === true}
                  writable={writable}
                  onToggle={props.onToggle}
                  onOpen={props.onOpen}
                  onDelete={props.onDelete}
                />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  )
}

function SkillRow(props: {
  skill: SkillView
  busy: boolean
  writable: boolean
  onToggle: (skill: SkillView, enabled: boolean) => Promise<void>
  onOpen: (skill: SkillView) => void
  onDelete: (skill: SkillView) => void
}): JSX.Element {
  const { skill, busy, writable } = props
  const badges: JSX.Element[] = []
  if (skill.catalog) {
    badges.push(
      <span className="dsc-badge is-market" key="market">
        市场
        {skill.catalog.updateAvailable ? <i className="dsc-dot" /> : null}
      </span>,
    )
  }
  if (!skill.loadable) {
    badges.push(
      <span className="dsc-badge is-warn" key="broken">
        结构不完整
      </span>,
    )
  }
  if (skill.linked) {
    badges.push(
      <span className="dsc-badge" key="link">
        符号链接
      </span>,
    )
  }

  return (
    <div className={busy ? 'dsc-row is-busy' : 'dsc-row'}>
      <button type="button" className="dsc-row-hit" onClick={() => props.onOpen(skill)}>
        <span className="dsc-row-title">
          <strong>{skill.name}</strong>
          {badges}
        </span>
        <span className="dsc-row-desc">{skill.description || '没有描述'}</span>
      </button>

      <div className="dsc-row-actions">
        {busy ? (
          <span className="dsc-switch-slot">
            <Spinner size={16} />
          </span>
        ) : (
          <Toggle
            checked={skill.enabled}
            disabled={!writable}
            label={`${skill.enabled ? '停用' : '启用'} ${skill.name}`}
            onChange={enabled => void props.onToggle(skill, enabled)}
          />
        )}
        {skill.editable ? (
          <RowMenu
            name={skill.name}
            market={Boolean(skill.catalog)}
            onOpen={() => props.onOpen(skill)}
            onDelete={() => props.onDelete(skill)}
          />
        ) : null}
      </div>
    </div>
  )
}

const MARKDOWN_LABELS = {
  code: {
    copyLabel: '复制',
    copiedLabel: '已复制',
    toolbarLabels: { codeLabel: '代码', wrapLabel: '自动换行', unwrapLabel: '取消换行' },
  },
  footnotes: '脚注',
}

function MarkdownPreview({ text }: { text: string }): JSX.Element {
  if (!text.trim()) return <p className="dsc-note">没有正文。</p>
  return (
    <div className="dsc-md">
      <MarkdownText text={text} variant="body" omitHtml labels={MARKDOWN_LABELS} />
    </div>
  )
}

function Toggle(props: {
  checked: boolean
  disabled: boolean
  label: string
  onChange: (checked: boolean) => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      className="dsc-switch"
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span className="dsc-switch-thumb" />
    </button>
  )
}

function RowMenu(props: { name: string; market: boolean; onOpen: () => void; onDelete: () => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return undefined
    const close = (): void => setOpen(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [open])

  return (
    <div className="dsc-row-menu">
      <IconButton
        label={`${props.name} 的操作`}
        active={open}
        onClick={event => {
          event.stopPropagation()
          setOpen(current => !current)
        }}
      >
        <IconMore size={16} />
      </IconButton>
      {open ? (
        <div className="dsc-menu is-row" role="menu" onClick={event => event.stopPropagation()}>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              props.onOpen()
            }}
          >
            <IconInfo size={14} />
            查看详情
          </button>
          <button
            type="button"
            role="menuitem"
            className="is-danger"
            onClick={() => {
              setOpen(false)
              props.onDelete()
            }}
          >
            <IconTrash size={14} />
            {props.market ? '卸载' : '删除'}
          </button>
        </div>
      ) : null}
    </div>
  )
}

function IconButton(props: {
  label: string
  active?: boolean
  disabled?: boolean
  className?: string
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      className={`dsc-icon-btn${props.active ? ' is-active' : ''}${props.className ? ` ${props.className}` : ''}`}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}

function SearchBox(props: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  autoFocus?: boolean
}): JSX.Element {
  return (
    <label className="dsc-search">
      <IconSearch size={14} />
      <input
        value={props.value}
        placeholder={props.placeholder}
        autoComplete="off"
        spellCheck={false}
        autoFocus={props.autoFocus === true}
        onChange={event => props.onChange(event.target.value)}
      />
      {props.value ? (
        <button
          type="button"
          className="dsc-search-clear"
          aria-label="清空搜索"
          onMouseDown={event => event.preventDefault()}
          onClick={() => props.onChange('')}
        >
          <IconX size={12} />
        </button>
      ) : null}
    </label>
  )
}

function EmptyState(props: { title: string; hint: string; actions?: JSX.Element | null }): JSX.Element {
  return (
    <div className="dsc-empty">
      <span className="dsc-empty-icon">
        <IconStack size={22} />
      </span>
      <p className="dsc-empty-title">{props.title}</p>
      <p className="dsc-empty-hint">{props.hint}</p>
      {props.actions ? <div className="dsc-empty-actions">{props.actions}</div> : null}
    </div>
  )
}

// ── 市场 ────────────────────────────────────────────────────────────────────

function DiscoverTab(props: {
  version: number
  onOpen: (item: CatalogItem) => void
  onInstalled: (message: string) => void
  onNotify: (message: string) => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [applied, setApplied] = useState('')
  const [items, setItems] = useState<CatalogItem[]>([])
  const [installed, setInstalled] = useState<string[]>([])
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const [removing, setRemoving] = useState<CatalogItem | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [more, setMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const seq = useRef(0)

  useEffect(() => {
    const timer = window.setTimeout(() => setApplied(query.trim()), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [query])

  useEffect(() => {
    const id = ++seq.current
    setLoading(true)
    setError(null)
    const run = async (): Promise<void> => {
      try {
        const payload =
          applied.length >= 2
            ? await api<CatalogListPayload>(`/api/catalog/search?q=${encodeURIComponent(applied)}&limit=40`)
            : await api<CatalogListPayload>('/api/catalog/popular?limit=30')
        if (seq.current !== id) return
        setItems(payload.items)
        setInstalled(payload.installed)
        setCursor(payload.nextCursor)
      } catch (caught) {
        if (seq.current === id) setError(errorText(caught))
      } finally {
        if (seq.current === id) setLoading(false)
      }
    }
    void run()
  }, [applied, props.version, retry])

  const loadMore = async (): Promise<void> => {
    if (!cursor || more) return
    setMore(true)
    try {
      const payload = await api<CatalogListPayload>(
        `/api/catalog/popular?limit=30&cursor=${encodeURIComponent(cursor)}`,
      )
      setItems(current => {
        const seen = new Set(current.map(item => item.key))
        return [...current, ...payload.items.filter(item => !seen.has(item.key))]
      })
      setInstalled(payload.installed)
      setCursor(payload.nextCursor)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setMore(false)
    }
  }

  const install = async (item: CatalogItem): Promise<void> => {
    if (pending[item.key] || installed.includes(item.key)) return
    setPending(current => ({ ...current, [item.key]: true }))
    try {
      const result = await api<{ name: string; version: string }>('/api/catalog/install', {
        owner: item.owner,
        slug: item.slug,
      })
      setInstalled(current => (current.includes(item.key) ? current : [...current, item.key]))
      props.onInstalled(`已安装 ${result.name} ${result.version}`)
    } catch (caught) {
      props.onNotify(errorText(caught))
    } finally {
      setPending(current => {
        const next = { ...current }
        delete next[item.key]
        return next
      })
    }
  }

  const uninstall = async (item: CatalogItem): Promise<void> => {
    const result = await api<{ name: string }>('/api/catalog/uninstall', {
      owner: item.owner,
      slug: item.slug,
    })
    setInstalled(current => current.filter(key => key !== item.key))
    props.onInstalled(`已卸载 ${result.name}`)
  }

  const searching = applied.length >= 2
  const typingSearch = query.trim().length >= 2
  const busyNow = loading || query.trim() !== applied

  return (
    <div className="dsc-pane">
      <SearchBox value={query} onChange={setQuery} placeholder="搜索技能" />

      {error ? (
        <div className="dsc-banner is-error">
          {error}
          <button type="button" className="dsc-link" onClick={() => setRetry(current => current + 1)}>
            重试
          </button>
        </div>
      ) : null}

      {busyNow ? (
        <div className="dsc-loading">
          <Spinner size={18} />
          {typingSearch ? '正在搜索' : '正在加载榜单'}
        </div>
      ) : items.length === 0 ? (
        <div className="dsc-loading">
          <Spinner size={18} />
          {searching ? '正在搜索' : '正在加载榜单'}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title={searching ? '没有找到相关技能' : '榜单暂时为空'}
          hint={searching ? `没有匹配「${applied}」的技能。` : '稍后再试，或检查网络连接。'}
          actions={
            searching ? (
              <button type="button" className="dsc-btn dsc-btn-outline" onClick={() => setQuery('')}>
                清除搜索
              </button>
            ) : (
              <button type="button" className="dsc-btn dsc-btn-outline" onClick={() => setRetry(current => current + 1)}>
                重新加载
              </button>
            )
          }
        />
      ) : (
        <>
          <div className="dsc-grid">
            {items.map(item => (
              <CatalogCard
                key={item.key}
                item={item}
                installed={installed.includes(item.key)}
                installing={pending[item.key] === true}
                onOpen={() => props.onOpen(item)}
                onInstall={() => void install(item)}
                onUninstall={() => setRemoving(item)}
              />
            ))}
          </div>
          {cursor ? (
            <div className="dsc-more">
              <button type="button" className="dsc-btn dsc-btn-outline" disabled={more} onClick={() => void loadMore()}>
                {more ? <Spinner size={14} /> : null}
                {more ? '正在加载' : '加载更多'}
              </button>
            </div>
          ) : null}
        </>
      )}

      {removing ? (
        <ConfirmDialog
          title={`卸载「${removing.title}」？`}
          message="卸载后它提供的功能会消失。"
          confirmLabel="卸载"
          onClose={() => setRemoving(null)}
          onConfirm={() => uninstall(removing)}
        />
      ) : null}
    </div>
  )
}

function CatalogCard(props: {
  item: CatalogItem
  installed: boolean
  installing: boolean
  onOpen: () => void
  onInstall: () => void
  onUninstall: () => void
}): JSX.Element {
  const { item } = props
  const initial = (item.title || item.slug).slice(0, 1).toUpperCase()
  return (
    <article
      className="dsc-card"
      role="button"
      tabIndex={0}
      aria-label={`查看 ${item.title}`}
      onClick={props.onOpen}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          props.onOpen()
        }
      }}
    >
      <span className="dsc-card-top">
        <span className="dsc-avatar">{initial}</span>
        <span className="dsc-card-title">
          <strong>{item.title}</strong>
          <span>{item.owner}</span>
        </span>
        {item.version ? <span className="dsc-badge dsc-card-version">{item.version}</span> : null}
      </span>
      <span className="dsc-card-summary">{item.summary || '没有摘要'}</span>
      <span className="dsc-card-foot">
        <span className="dsc-card-meta">{formatDownloads(item.downloads)}</span>
        <span className="dsc-card-badges">
          {props.installed ? (
            <span className="dsc-card-installed">
              <span className="dsc-install-btn is-done" role="img" aria-label={`已安装 ${item.title}`}>
                <IconCheck size={16} />
              </span>
              <span className="dsc-card-uninstall">
                <button
                  type="button"
                  className="dsc-install-btn is-remove"
                  aria-label={`卸载 ${item.title}`}
                  onClick={event => {
                    event.stopPropagation()
                    props.onUninstall()
                  }}
                >
                  <IconTrash size={14} />
                </button>
              </span>
            </span>
          ) : (
            <button
              type="button"
              className={props.installing ? 'dsc-install-btn is-busy' : 'dsc-install-btn'}
              aria-label={`安装 ${item.title}`}
              disabled={props.installing}
              onClick={event => {
                event.stopPropagation()
                if (!props.installing) props.onInstall()
              }}
            >
              {props.installing ? <Spinner size={14} /> : <IconPlus size={16} />}
            </button>
          )}
        </span>
      </span>
    </article>
  )
}

// ── 弹窗 ────────────────────────────────────────────────────────────────────

function DialogShell(props: {
  title: string
  subtitle?: string
  wide?: boolean
  compact?: boolean
  headerExtra?: React.ReactNode
  onClose: () => void
  children: React.ReactNode
  footer: React.ReactNode
}): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.onClose])

  return createPortal(
    <div
      className="dsc-overlay"
      onMouseDown={event => {
        if (event.target === event.currentTarget) props.onClose()
      }}
    >
      <div
        className={`dsc-dialog${props.wide ? ' is-wide' : ''}${props.compact ? ' is-compact' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
      >
        <header className="dsc-dialog-head">
          <div className="dsc-dialog-titles">
            <h2>{props.title}</h2>
            {props.subtitle ? <p>{props.subtitle}</p> : null}
          </div>
          <div className="dsc-dialog-head-actions">
            {props.headerExtra}
            <IconButton label="关闭" className="dsc-dialog-close" onClick={props.onClose}>
              <IconX size={14} />
            </IconButton>
          </div>
        </header>
        <div className="dsc-dialog-body">{props.children}</div>
        <footer className="dsc-dialog-foot">{props.footer}</footer>
      </div>
    </div>,
    document.body,
  )
}

function ConfirmDialog(props: {
  title: string
  message: string
  detail?: string
  note?: string
  confirmLabel: string
  onClose: () => void
  onConfirm: () => Promise<void>
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await props.onConfirm()
      props.onClose()
    } catch (caught) {
      setError(errorText(caught))
      setBusy(false)
    }
  }

  return (
    <DialogShell
      title={props.title}
      compact
      onClose={props.onClose}
      footer={
        <>
          <button type="button" className="dsc-btn dsc-btn-outline" disabled={busy} onClick={props.onClose}>
            取消
          </button>
          <button
            type="button"
            className="dsc-btn dsc-btn-primary dsc-btn-danger-solid"
            disabled={busy}
            onClick={() => void run()}
          >
            {busy ? <Spinner size={14} /> : null}
            {busy ? '正在处理' : props.confirmLabel}
          </button>
        </>
      }
    >
      {error ? <div className="dsc-banner is-error">{error}</div> : null}
      <p className="dsc-dialog-desc">{props.message}</p>
      {props.detail ? <p className="dsc-path">{props.detail}</p> : null}
      {props.note ? <p className="dsc-note">{props.note}</p> : null}
    </DialogShell>
  )
}

function DeleteDialog(props: {
  skill: SkillView
  onClose: () => void
  onDeleted: (message: string) => Promise<void>
}): JSX.Element {
  const { skill } = props
  const path = skill.copies[0]?.path ?? skill.path
  const verb = skill.catalog ? '卸载' : '删除'
  return (
    <ConfirmDialog
      title={`${verb}「${skill.name}」？`}
      message={`${verb}后它提供的功能会消失。`}
      detail={path}
      note={skill.root === 'agents' ? `该技能位于公共技能目录，${verb}后其他工具也将无法使用。` : undefined}
      confirmLabel={verb}
      onClose={props.onClose}
      onConfirm={async () => {
        const result = await api<{ name: string; removed: string }>('/api/delete', { name: skill.name })
        await props.onDeleted(`已${verb} ${result.name}`)
      }}
    />
  )
}

function SkillPage(props: {
  name: string
  writable: boolean
  onBack: () => void
  onChanged: (message: string) => Promise<void>
  onDelete: (skill: SkillView) => void
}): JSX.Element {
  const { name } = props
  const [data, setData] = useState<SkillDetailPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [enabled, setEnabled] = useState(true)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setData(null)
    setLoadError(null)
    api<SkillDetailPayload>(`/api/detail?name=${encodeURIComponent(name)}`)
      .then(payload => {
        if (!alive) return
        setData(payload)
        setEnabled(payload.skill.enabled)
      })
      .catch(caught => {
        if (alive) setLoadError(errorText(caught))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [name])

  const view = data?.skill

  const applyToggle = async (next: boolean): Promise<void> => {
    setBusy(true)
    setActionError(null)
    try {
      await api(`/api/${next ? 'enable' : 'disable'}`, { name })
      setEnabled(next)
      await props.onChanged(next ? '已启用' : '已停用')
    } catch (caught) {
      setActionError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  const subtitle = view
    ? [
        ROOT_LABELS[view.root],
        view.catalog ? `市场安装 ${view.catalog.version}` : '',
        view.loadable ? '' : '结构不完整',
      ]
        .filter(Boolean)
        .join(' · ')
    : ''

  return (
    <div className="dsc-page">
      <button type="button" className="dsc-crumb" aria-label="返回技能中心" onClick={props.onBack}>
        <span className="dsc-crumb-icon">
          <IconChevron size={14} />
        </span>
        <span>技能中心</span>
      </button>
      <header className="dsc-page-head">
        <div className="dsc-page-titles">
          <h1>{name}</h1>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        {view ? (
          <div className="dsc-page-head-actions">
            {props.writable && view.editable ? (
              <button
                type="button"
                className="dsc-btn dsc-btn-sm dsc-btn-danger-outline"
                disabled={busy}
                onClick={() => props.onDelete(view)}
              >
                <IconTrash size={13} />
                {view.catalog ? '卸载' : '删除'}
              </button>
            ) : null}
            {busy ? (
              <span className="dsc-switch-slot">
                <Spinner size={16} />
              </span>
            ) : (
              <Toggle
                checked={enabled}
                disabled={!props.writable}
                label={`${enabled ? '停用' : '启用'} ${name}`}
                onChange={next => void applyToggle(next)}
              />
            )}
          </div>
        ) : null}
      </header>

      {loading ? (
        <div className="dsc-loading">
          <Spinner size={16} />
          正在读取详情
        </div>
      ) : loadError ? (
        <div className="dsc-banner is-error">{loadError}</div>
      ) : view ? (
        <>
          {actionError ? <div className="dsc-banner is-error">{actionError}</div> : null}

          {view.description ? <p className="dsc-page-desc">{view.description}</p> : null}

          <dl className="dsc-meta-list">
            <div>
              <dt>路径</dt>
              <dd className="dsc-mono">{view.copies[0]?.path || view.path || '—'}</dd>
            </div>
            {view.copies.length > 1
              ? view.copies.map(copy => (
                  <div key={`${copy.root}:${copy.path}`}>
                    <dt>{ROOT_LABELS[copy.root] ?? copy.root}</dt>
                    <dd className="dsc-mono">{copy.path}</dd>
                  </div>
                ))
              : null}
            {view.catalog ? (
              <>
                <div>
                  <dt>市场来源</dt>
                  <dd className="dsc-mono">{view.catalog.key}</dd>
                </div>
                <div>
                  <dt>版本</dt>
                  <dd>
                    {view.catalog.version}
                    {view.catalog.updateAvailable ? <span className="dsc-badge is-ok">有新版本</span> : null}
                    {view.catalog.localModified ? <span className="dsc-badge is-warn">本地已修改</span> : null}
                  </dd>
                </div>
              </>
            ) : null}
            {view.linked ? (
              <div>
                <dt>链接</dt>
                <dd>符号链接指向外部目录，只读且不可删除。</dd>
              </div>
            ) : null}
          </dl>

          <MarkdownPreview text={data?.body || data?.document || ''} />
        </>
      ) : null}
    </div>
  )
}

function codeOf(error: unknown): string {
  return error instanceof ApiError ? error.code : ''
}

function CatalogPage(props: {
  item: CatalogItem
  onBack: () => void
  onChanged: (message: string) => Promise<void>
}): JSX.Element {
  const { item } = props
  const [detail, setDetail] = useState<CatalogDetailPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)
  const [confirmUninstall, setConfirmUninstall] = useState(false)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setDetail(null)
    setLoadError(null)
    api<CatalogDetailPayload>(
      `/api/catalog/detail?owner=${encodeURIComponent(item.owner)}&slug=${encodeURIComponent(item.slug)}`,
    )
      .then(payload => {
        if (!alive) return
        setDetail(payload)
      })
      .catch(caught => {
        if (alive) setLoadError(errorText(caught))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [item.owner, item.slug])

  const installed = detail?.installed ?? null

  const install = async (force: boolean): Promise<void> => {
    setBusy(true)
    setActionError(null)
    setConflict(null)
    try {
      const result = await api<{ name: string; version: string }>('/api/catalog/install', {
        owner: item.owner,
        slug: item.slug,
        force,
      })
      await props.onChanged(`已安装 ${result.name} ${result.version}`)
      props.onBack()
    } catch (caught) {
      const code = codeOf(caught)
      if (code === 'conflict' || code === 'local_modified') setConflict(errorText(caught))
      else setActionError(errorText(caught))
      setBusy(false)
    }
  }

  const uninstall = async (): Promise<void> => {
    const result = await api<{ name: string }>('/api/catalog/uninstall', {
      owner: item.owner,
      slug: item.slug,
    })
    await props.onChanged(`已卸载 ${result.name}`)
    props.onBack()
  }

  const installLabel = installed
    ? installed.updateAvailable
      ? '更新到最新版'
      : '重新安装'
    : '安装'
  const versionText = detail?.item.version ?? item.version

  return (
    <div className="dsc-page">
      <button type="button" className="dsc-crumb" aria-label="返回技能中心" onClick={props.onBack}>
        <span className="dsc-crumb-icon">
          <IconChevron size={14} />
        </span>
        <span>技能中心</span>
      </button>
      <header className="dsc-page-head">
        <div className="dsc-page-titles">
          <div className="dsc-page-title-row">
            <h1>{item.title}</h1>
            {installed ? (
              <span className="dsc-page-badges">
                <span className={installed.present ? 'dsc-badge is-ok' : 'dsc-badge is-warn'}>
                  {installed.present
                    ? versionText
                      ? '已安装'
                      : `已安装 ${installed.version}`
                    : '已丢失，可清理'}
                </span>
                {installed.updateAvailable ? <span className="dsc-badge is-ok">有新版本</span> : null}
                {installed.localModified ? <span className="dsc-badge is-warn">本地已修改</span> : null}
              </span>
            ) : null}
          </div>
          <p>
            {item.owner}/{item.slug}
            {versionText ? ` · ${versionText}` : ''}
            {item.downloads !== undefined ? ` · ${formatDownloads(item.downloads)}` : ''}
          </p>
        </div>
        <div className="dsc-page-head-actions">
          <button
            type="button"
            className="dsc-btn dsc-btn-primary dsc-btn-sm"
            disabled={busy || loading || loadError !== null}
            onClick={() => void install(installed?.localModified === true)}
          >
            {busy ? <Spinner size={14} /> : installed?.updateAvailable ? <IconRefresh size={14} /> : <IconDownload size={14} />}
            {busy ? '正在安装' : installLabel}
          </button>
          {installed?.present ? (
            <button
              type="button"
              className="dsc-btn dsc-btn-sm dsc-btn-danger-outline"
              disabled={busy}
              onClick={() => setConfirmUninstall(true)}
            >
              <IconTrash size={13} />
              卸载
            </button>
          ) : null}
        </div>
      </header>

      {loading ? (
        <div className="dsc-loading">
          <Spinner size={16} />
          正在读取市场详情
        </div>
      ) : loadError ? (
        <div className="dsc-banner is-error">{loadError}</div>
      ) : (
        <>
          {actionError ? <div className="dsc-banner is-error">{actionError}</div> : null}

          {installed?.localModified ? (
            <p className="dsc-note">本地文件与安装记录不一致，继续安装会覆盖你的修改。</p>
          ) : null}

          <MarkdownPreview text={detail?.body || item.summary || ''} />

          {conflict ? (
            <div className="dsc-confirm">
              <p>{conflict}</p>
              <div className="dsc-confirm-actions">
                <button type="button" className="dsc-btn dsc-btn-ghost" onClick={() => setConflict(null)}>
                  取消
                </button>
                <button
                  type="button"
                  className="dsc-btn dsc-btn-danger-outline"
                  disabled={busy}
                  onClick={() => void install(true)}
                >
                  {busy ? <Spinner size={14} /> : null}
                  覆盖安装
                </button>
              </div>
            </div>
          ) : null}
        </>
      )}

      {confirmUninstall && installed ? (
        <ConfirmDialog
          title={`卸载「${installed.name}」？`}
          message="卸载后它提供的功能会消失。"
          confirmLabel="卸载"
          onClose={() => setConfirmUninstall(false)}
          onConfirm={uninstall}
        />
      ) : null}
    </div>
  )
}

function CreateDialog(props: {
  onClose: () => void
  onCreate: (description: string) => void
}): JSX.Element {
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)
  const ready = description.trim().length > 0

  const submit = (): void => {
    if (!ready) return
    try {
      props.onCreate(description.trim())
    } catch (caught) {
      setError(errorText(caught))
    }
  }

  return (
    <DialogShell
      title="创建技能"
      onClose={props.onClose}
      footer={
        <>
          <span className="dsc-foot-gap" />
          <button type="button" className="dsc-btn dsc-btn-outline" onClick={props.onClose}>
            <IconX size={14} />
            关闭
          </button>
          <button type="button" className="dsc-btn dsc-btn-primary" disabled={!ready} onClick={submit}>
            <IconSpark size={14} />
            去创建
          </button>
        </>
      }
    >
      {error ? <div className="dsc-banner is-error">{error}</div> : null}
      <label className="dsc-field">
        <span className="dsc-field-label">你想让它做什么？</span>
        <textarea
          className="dsc-textarea"
          rows={4}
          autoFocus
          value={description}
          placeholder="例如：把会议纪要整理成结构化的周报，固定包含进展、风险、下周计划"
          onChange={event => setDescription(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit()
          }}
        />
      </label>
    </DialogShell>
  )
}

function UploadDialog(props: {
  onClose: () => void
  onDone: (name: string) => Promise<void>
}): JSX.Element {
  const [picked, setPicked] = useState<{ kind: 'file' | 'folder'; name: string; meta: string } | null>(null)
  const [payload, setPayload] = useState<{ body: Record<string, unknown>; label: string } | null>(null)
  const [skipped, setSkipped] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const folderRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const folder = folderRef.current
    if (!folder) return
    folder.setAttribute('webkitdirectory', '')
    folder.setAttribute('directory', '')
  }, [])

  const reset = (): void => {
    setSkipped(null)
    setError(null)
    setPayload(null)
    setPicked(null)
  }

  const pickZip = async (files: FileList | null): Promise<void> => {
    const file = files?.[0]
    if (!file) return
    reset()
    if (file.size > 32 << 20) {
      setError('压缩包超过 32 MB 上限')
      return
    }
    setReading(true)
    try {
      const bytes = await fileBytes(file)
      setPayload({
        body: { kind: 'zip', zip: bytesToBase64(bytes) },
        label: file.name,
      })
      setPicked({ kind: 'file', name: file.name, meta: formatBytes(file.size) })
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setReading(false)
    }
  }

  const pickFolderEntry = async (root: FileSystemEntry): Promise<void> => {
    reset()
    setReading(true)
    try {
      const entries: ImportEntry[] = []
      const state = { total: 0 }
      await readEntry(root, '', entries, state)
      if (!entries.length) {
        setError('文件夹里没有可导入的文件，请确认包含 SKILL.md')
        return
      }
      setPayload({ body: { kind: 'entries', entries }, label: 'folder' })
      setPicked({
        kind: 'folder',
        name: root.name,
        meta: `${entries.length} 个文件 · ${formatBytes(state.total)}`,
      })
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setReading(false)
    }
  }

  const pickFolder = async (files: FileList | null): Promise<void> => {
    const list = Array.from(files ?? [])
    if (!list.length) return
    reset()
    setReading(true)
    try {
      const entries: ImportEntry[] = []
      let total = 0
      let root = ''
      for (const file of list) {
        const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
        if (path.split('/').some(segment => segment.startsWith('.') || segment === 'node_modules')) continue
        root = root || path.split('/')[0] || ''
        total += file.size
        if (total > MAX_UPLOAD_BYTES) {
          setError('解压后总大小超过 64 MB 上限')
          return
        }
        if (entries.length >= MAX_UPLOAD_FILES) {
          setError(`文件数量超过 ${MAX_UPLOAD_FILES} 上限`)
          return
        }
        entries.push({ path, data: bytesToBase64(await fileBytes(file)) })
      }
      if (!entries.length) {
        setError('文件夹里没有可导入的文件，请确认包含 SKILL.md')
        return
      }
      setPayload({ body: { kind: 'entries', entries }, label: 'folder' })
      setPicked({
        kind: 'folder',
        name: root || '文件夹',
        meta: `${entries.length} 个文件 · ${formatBytes(total)}`,
      })
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setReading(false)
    }
  }

  const chooseFolder = (): void => {
    const picker = (window as FsWindow).showDirectoryPicker
    if (typeof picker !== 'function') {
      folderRef.current?.click()
      return
    }
    void (async () => {
      try {
        const handle = await picker.call(window, { mode: 'read' })
        reset()
        setReading(true)
        try {
          const entries: ImportEntry[] = []
          const state = { total: 0 }
          await readDirectoryHandle(handle, handle.name, entries, state)
          if (!entries.length) {
            setError('文件夹里没有可导入的文件，请确认包含 SKILL.md')
            return
          }
          setPayload({ body: { kind: 'entries', entries }, label: 'folder' })
          setPicked({
            kind: 'folder',
            name: handle.name,
            meta: `${entries.length} 个文件 · ${formatBytes(state.total)}`,
          })
        } catch (caught) {
          setError(errorText(caught))
        } finally {
          setReading(false)
        }
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return
        setError(errorText(caught))
      }
    })()
  }

  const pickMarkdown = async (files: FileList | null): Promise<void> => {
    const file = files?.[0]
    if (!file) return
    reset()
    setReading(true)
    try {
      const bytes = await fileBytes(file)
      const requested = file.name.replace(/\.md$/i, '')
      setPayload({
        body: { kind: 'entries', entries: [{ path: 'SKILL.md', data: bytesToBase64(bytes) }], name: requested },
        label: file.name,
      })
      setPicked({ kind: 'file', name: file.name, meta: formatBytes(file.size) })
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setReading(false)
    }
  }

  const pickFile = (files: FileList | null): void => {
    const file = files?.[0]
    if (!file) return
    if (/\.zip$/i.test(file.name)) void pickZip(files)
    else void pickMarkdown(files)
  }

  const dragEnter = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    if (!event.dataTransfer.types.includes('Files')) return
    dragDepth.current += 1
    setDragging(true)
  }

  const dragLeave = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    dragDepth.current = Math.max(dragDepth.current - 1, 0)
    if (dragDepth.current === 0) setDragging(false)
  }

  const drop = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    const items = Array.from(event.dataTransfer.items ?? [])
    const dropped = items.map(item => item.webkitGetAsEntry())
    const dirs = dropped.filter((entry): entry is FileSystemEntry => Boolean(entry?.isDirectory))
    if (dirs.length) {
      if (dropped.length !== 1) {
        setError('请一次拖入一个文件夹')
        return
      }
      const dir = dirs[0]
      if (!dir) return
      void pickFolderEntry(dir)
      return
    }
    const files = event.dataTransfer.files
    if (files.length !== 1) {
      setError('请一次拖入一个 .zip / .md 文件，或一个文件夹')
      return
    }
    const file = files[0]
    if (!file) return
    if (/\.zip$/i.test(file.name)) void pickZip(files)
    else if (/\.md$/i.test(file.name)) void pickMarkdown(files)
    else setError('请拖入 .zip / .md 文件，或一个文件夹')
  }

  const submit = async (overwrite = false): Promise<void> => {
    if (!payload) return
    setBusy(true)
    setError(null)
    try {
      const body = overwrite ? { ...payload.body, conflict: 'overwrite' } : payload.body
      const result = await api<{ name: string; skipped: boolean; overwritten: boolean; files: number }>(
        '/api/import',
        body,
      )
      if (result.skipped) {
        setSkipped(result.name)
        return
      }
      await props.onDone(result.name)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogShell
      title="上传技能"
      onClose={props.onClose}
      footer={
        <>
          <span className="dsc-foot-gap" />
          <button type="button" className="dsc-btn dsc-btn-outline" onClick={props.onClose}>
            <IconX size={14} />
            关闭
          </button>
          <button
            type="button"
            className="dsc-btn dsc-btn-primary"
            disabled={!payload || reading || busy || skipped !== null}
            onClick={() => void submit()}
          >
            {busy || reading ? <Spinner size={14} /> : <IconUpload size={14} />}
            {busy ? '正在导入' : '导入'}
          </button>
        </>
      }
    >
      <input
        ref={fileRef}
        type="file"
        accept=".zip,.md,application/zip,text/markdown"
        className="dsc-hidden"
        onChange={event => {
          pickFile(event.target.files)
          event.target.value = ''
        }}
      />
      <input
        ref={folderRef}
        type="file"
        multiple
        className="dsc-hidden"
        onChange={event => {
          void pickFolder(event.target.files)
          event.target.value = ''
        }}
      />

      <div
        className={dragging ? 'dsc-picker is-dragging' : 'dsc-picker'}
        onDragEnter={dragEnter}
        onDragLeave={dragLeave}
        onDragOver={event => {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }}
        onDrop={drop}
      >
        <button type="button" className="dsc-pick" onClick={() => fileRef.current?.click()}>
          <span className="dsc-pick-icon">
            <IconFile size={20} />
          </span>
          <span className="dsc-pick-title">选择文件</span>
          <span className="dsc-pick-hint">.zip 或 .md</span>
        </button>
        <button type="button" className="dsc-pick" onClick={chooseFolder}>
          <span className="dsc-pick-icon">
            <IconFolder size={20} />
          </span>
          <span className="dsc-pick-title">选择文件夹</span>
          <span className="dsc-pick-hint">包含 SKILL.md</span>
        </button>
      </div>

      {picked ? (
        <div className="dsc-picked">
          <span className="dsc-picked-icon">
            {picked.kind === 'folder' ? <IconFolder size={16} /> : <IconFile size={16} />}
          </span>
          <span className="dsc-picked-name">{picked.name}</span>
          <span className="dsc-picked-meta">{picked.meta}</span>
          <IconButton label="移除已选内容" onClick={reset}>
            <IconX size={12} />
          </IconButton>
        </div>
      ) : null}

      {error ? (
        <div className="dsc-field-error" role="alert">
          <IconInfo size={14} />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="dsc-req">
        <span className="dsc-req-title">文件要求</span>
        <ul>
          <li>文件夹或 .zip 需要包含 SKILL.md 文件</li>
          <li>.md 文件需包含 YAML 格式的技能名称和描述</li>
          <li>最多 500 个文件，解压后不超过 64 MB</li>
        </ul>
      </div>

      {reading ? (
        <div className="dsc-loading is-inline">
          <Spinner size={14} />
          正在读取文件
        </div>
      ) : null}

      {skipped ? (
        <div className="dsc-confirm">
          <p>已存在同名技能 {skipped}。覆盖会整体替换原目录。</p>
          <div className="dsc-confirm-actions">
            <button type="button" className="dsc-btn dsc-btn-ghost" onClick={() => setSkipped(null)}>
              取消
            </button>
            <button
              type="button"
              className="dsc-btn dsc-btn-danger-outline"
              disabled={busy}
              onClick={() => void submit(true)}
            >
              {busy ? <Spinner size={14} /> : null}
              覆盖导入
            </button>
          </div>
        </div>
      ) : null}
    </DialogShell>
  )
}

// ── 图标 ────────────────────────────────────────────────────────────────────

function Svg(props: { size?: number; children: React.ReactNode }): JSX.Element {
  const size = props.size ?? 16
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {props.children}
    </svg>
  )
}

function PanelIcon(): JSX.Element {
  return (
    <Svg size={16}>
      <path d="M4 7.5 12 3l8 4.5-8 4.5-8-4.5Z" />
      <path d="M4 12.5 12 17l8-4.5" />
      <path d="M4 17.5 12 22l8-4.5" />
    </Svg>
  )
}

function IconStack(props: { size?: number }): JSX.Element {
  return (
    <Svg size={props.size}>
      <path d="M4 7.5 12 3l8 4.5-8 4.5-8-4.5Z" />
      <path d="M4 12.5 12 17l8-4.5" />
      <path d="M4 17.5 12 22l8-4.5" />
    </Svg>
  )
}

function IconRefresh(props: { size?: number }): JSX.Element {
  return (
    <Svg size={props.size}>
      <path d="M20 11a8 8 0 1 0-2.5 6.4" />
      <path d="M20 4v7h-7" />
    </Svg>
  )
}

function IconPlus(props: { size?: number }): JSX.Element {
  return (
    <Svg size={props.size}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  )
}

function IconChevron(props: { size?: number }): JSX.Element {
  return (
    <Svg size={props.size}>
      <path d="m6 9 6 6 6-6" />
    </Svg>
  )
}

function IconCheck(props: { size?: number }): JSX.Element {
  return (
    <Svg size={props.size}>
      <path d="m5 12.5 4.5 4.5L19 7" />
    </Svg>
  )
}

function IconUpload(props: { size?: number }): JSX.Element {
  return (
    <Svg size={props.size}>
      <path d="M12 16V4" />
      <path d="m7 9 5-5 5 5" />
      <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
    </Svg>
  )
}

function IconDownload(props: { size?: number }): JSX.Element {
  return (
    <Svg size={props.size}>
      <path d="M12 4v12" />
      <path d="m7 11 5 5 5-5" />
      <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
    </Svg>
  )
}

function IconSpark(props: { size?: number }): JSX.Element {
  return (
    <Svg size={props.size}>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
    </Svg>
  )
}

function IconSearch(props: { size?: number }): JSX.Element {
  return (
    <Svg size={props.size}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </Svg>
  )
}

function IconX(props: { size?: number }): JSX.Element {
  return (
    <Svg size={props.size}>
      <path d="m6 6 12 12M18 6 6 18" />
    </Svg>
  )
}

function IconMore(props: { size?: number }): JSX.Element {
  return (
    <Svg size={props.size}>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </Svg>
  )
}

function IconInfo(props: { size?: number }): JSX.Element {
  return (
    <Svg size={props.size}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </Svg>
  )
}

function IconTrash(props: { size?: number }): JSX.Element {
  return (
    <Svg size={props.size}>
      <path d="M4 7h16M10 4h4M6 7l1 13h10l1-13" />
      <path d="M10 11v6M14 11v6" />
    </Svg>
  )
}

function IconArchive(props: { size?: number }): JSX.Element {
  return (
    <Svg size={props.size}>
      <path d="M4 8v11a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V8" />
      <path d="M3 4h18v4H3z" />
      <path d="M10 12h4" />
    </Svg>
  )
}

function IconFolder(props: { size?: number }): JSX.Element {
  return (
    <Svg size={props.size}>
      <path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" />
    </Svg>
  )
}

function IconFile(props: { size?: number }): JSX.Element {
  return (
    <Svg size={props.size}>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
      <path d="M9 13h6M9 17h6" />
    </Svg>
  )
}

function Spinner(props: { size?: number }): JSX.Element {
  const size = props.size ?? 16
  return (
    <svg className="dsc-spinner" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}

// ── 样式 ────────────────────────────────────────────────────────────────────

function installStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.dsc-root{height:100%;overflow:auto;padding:0 clamp(24px,4vw,48px);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:14px/22px var(--dsw-font-family)}
.dsc-inner{box-sizing:border-box;max-width:960px;margin:0 auto;padding:28px 0 48px}
.dsc-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px}
.dsc-head-title{display:flex;align-items:baseline;gap:10px;min-width:0}
.dsc-head-title h1{margin:0;font-size:20px;font-weight:500;line-height:28px}
.dsc-head-title span{font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.dsc-head-actions{display:flex;align-items:center;gap:8px}
.dsc-add{position:relative}
.dsc-mask{position:fixed;inset:0;z-index:10}
.dsc-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:11;box-sizing:border-box;display:flex;flex-direction:column;gap:2px;width:168px;padding:4px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent)}
.dsc-menu.is-row{width:150px}
.dsc-menu button{display:flex;align-items:center;gap:8px;width:100%;height:32px;padding:0 10px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}
.dsc-menu button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsc-menu button:disabled{opacity:.4;cursor:not-allowed}
.dsc-menu button.is-danger{color:var(--dsw-alias-state-error-primary)}
.dsc-tabs{display:flex;flex-wrap:nowrap;align-items:center;gap:8px;margin-bottom:16px;overflow-x:auto;overflow-y:hidden;scrollbar-width:none}
.dsc-tabs::-webkit-scrollbar{display:none}
.dsc-tab{box-sizing:border-box;display:inline-flex;align-items:center;height:28px;padding:0 10px;border:0;border-radius:14px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:14px;line-height:22px;white-space:nowrap;cursor:pointer}
.dsc-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsc-tab.is-active{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsc-tab-count{margin-left:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsc-tab.is-active .dsc-tab-count{color:var(--dsw-alias-label-secondary)}
.dsc-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;padding:0 14px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;white-space:nowrap;cursor:pointer}
.dsc-btn-sm{height:28px;padding:0 10px;font-size:12px;line-height:18px;border-radius:var(--dsw-radius-sm)}
.dsc-btn:disabled{opacity:.4;cursor:not-allowed}
.dsc-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsc-btn-outline{border:.5px solid var(--dsw-alias-border-l3)}
.dsc-btn-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsc-btn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dsc-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dsc-btn-danger{color:var(--dsw-alias-state-error-primary)}
.dsc-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsc-btn-danger-outline{border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,transparent);color:var(--dsw-alias-state-error-primary)}
.dsc-btn-danger-outline:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
.dsc-btn-danger-solid{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground)}
.dsc-btn-danger-solid:hover:not(:disabled){background:var(--dsw-alias-state-error-primary)}
.dsc-link{margin-left:8px;padding:0;border:0;background:transparent;color:var(--dsw-alias-state-business-primary);font:inherit;cursor:pointer}
.dsc-banner{display:flex;align-items:center;gap:4px;margin-bottom:12px;padding:9px 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);font-size:13px;line-height:20px}
.dsc-banner.is-error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent);color:var(--dsw-alias-state-error-primary)}
.dsc-banner.is-warn{color:var(--dsw-alias-label-secondary)}
.dsc-pane{display:flex;flex-direction:column}
.dsc-search{box-sizing:border-box;display:flex;align-items:center;gap:6px;height:36px;margin:0 0 16px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-tertiary);cursor:text;transition:border-color .15s}
.dsc-search:hover{border-color:var(--dsw-alias-border-l2)}
.dsc-search:focus-within{border-color:var(--dsw-alias-state-business-primary)}
.dsc-search input{flex:1;min-width:0;height:100%;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px}
.dsc-search input::placeholder{color:var(--dsw-alias-label-caption)}
.dsc-search-clear{flex:none;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dsc-search-clear:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsc-section{margin-bottom:20px}
.dsc-section-head{display:flex;align-items:baseline;gap:8px;min-width:0;margin-bottom:4px}
.dsc-section-head h2{margin:0;font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary);white-space:nowrap}
.dsc-count{margin-left:6px;font-size:12px;line-height:18px;font-weight:400;color:var(--dsw-alias-label-tertiary)}
.dsc-list{display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}
.dsc-row{display:flex;align-items:center;gap:12px;padding:0 12px;border-bottom:.5px solid var(--dsw-alias-border-l3);transition:background-color .15s}
.dsc-row:last-child{border-bottom:0}
.dsc-row:hover{background:var(--dsw-alias-bg-layer-2)}
.dsc-row.is-busy{opacity:.75}
.dsc-row-hit{display:flex;flex:1;min-width:0;flex-direction:column;gap:2px;padding:12px 0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dsc-row-hit:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px;border-radius:var(--dsw-radius-sm)}
.dsc-row-title{display:flex;align-items:center;gap:6px;min-width:0;font-size:14px;line-height:20px}
.dsc-row-title strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.dsc-row-desc{margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsc-row-actions{display:flex;align-items:center;gap:4px;flex:none}
.dsc-row-menu{position:relative;display:inline-flex}
.dsc-switch-slot{display:inline-flex;align-items:center;justify-content:center;width:36px;height:20px;color:var(--dsw-alias-label-tertiary)}
.dsc-switch{position:relative;box-sizing:border-box;width:36px;height:20px;margin:0;padding:2px;border:0;border-radius:999px;corner-shape:round;background:var(--dsw-alias-border-l3);cursor:pointer;transition:background-color .12s ease}
.dsc-switch-thumb{display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-switch-thumb);transition:transform .12s ease}
.dsc-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}
.dsc-switch[aria-checked=true] .dsc-switch-thumb{transform:translateX(16px);background:var(--dsw-alias-label-primary-foreground)}
.dsc-switch:disabled{opacity:.5;cursor:default}
.dsc-switch:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsc-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dsc-icon-btn:hover:not(:disabled),.dsc-icon-btn.is-active{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsc-icon-btn:disabled{opacity:.4;cursor:not-allowed}
.dsc-icon-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dsc-crumb{display:flex;width:100%;align-items:center;gap:6px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12.5px;line-height:17px;text-align:left;cursor:pointer}
.dsc-crumb:hover{color:var(--dsw-alias-label-primary)}
.dsc-crumb:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsc-crumb-icon{display:inline-flex;transform:rotate(90deg)}
.dsc-page{display:flex;flex-direction:column;gap:16px}
.dsc-page-head{display:flex;align-items:flex-start;gap:10px;margin-top:16px}
.dsc-page-head-actions{display:flex;align-items:center;gap:16px;margin-left:auto;margin-top:2px}
.dsc-page-titles{flex:1;min-width:0}
.dsc-page-titles h1{margin:0;overflow-wrap:anywhere;font-size:20px;font-weight:500;line-height:28px}
.dsc-page-titles p{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsc-page-title-row{display:flex;align-items:center;gap:8px;min-width:0}
.dsc-page-title-row h1{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;overflow-wrap:normal}
.dsc-page-badges{display:flex;align-items:center;gap:4px;flex:none}
.dsc-page-desc{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}
.dsc-page .dsc-md{max-height:none}
.dsc-path{margin:0;overflow-wrap:anywhere;font:12px/18px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--dsw-alias-label-tertiary)}
.dsc-badge{display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:10px;line-height:18px;white-space:nowrap}
.dsc-badge.is-market{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent);color:var(--dsw-alias-state-business-primary)}
.dsc-badge.is-ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent);color:var(--dsw-alias-state-success-primary)}
.dsc-badge.is-warn{background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-tertiary)) 16%,transparent);color:var(--dsw-alias-label-secondary)}
.dsc-dot{width:5px;height:5px;border-radius:50%;background:currentColor}
.dsc-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:56px 24px;text-align:center}
.dsc-empty-icon{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;margin-bottom:12px;border-radius:50%;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary)}
.dsc-empty-title{margin:0;font-size:14px;font-weight:500;line-height:22px}
.dsc-empty-hint{margin:4px 0 0;max-width:380px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.dsc-empty-actions{display:flex;gap:8px;margin-top:16px}
.dsc-loading{display:flex;align-items:center;justify-content:center;gap:8px;padding:48px 24px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.dsc-loading.is-inline{padding:8px 0;justify-content:flex-start}
.dsc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
.dsc-card{box-sizing:border-box;position:relative;display:flex;flex-direction:column;gap:10px;padding:16px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;text-align:left;cursor:pointer;transition:border-color .15s,background-color .15s}
.dsc-card:hover{border-color:var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2)}
.dsc-card:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dsc-card-top{display:flex;align-items:center;gap:10px;min-width:0;padding-right:44px}
.dsc-card-version{position:absolute;top:16px;right:16px;flex:none}
.dsc-avatar{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;flex:none;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:15px;font-weight:500}
.dsc-card-title{display:flex;flex:1;flex-direction:column;min-width:0}
.dsc-card-title strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:500;line-height:20px}
.dsc-card-title span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsc-card-summary{display:-webkit-box;min-height:36px;margin:0;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;font-size:13px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsc-card-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:auto}
.dsc-card-meta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption)}
.dsc-card-badges{display:flex;align-items:center;gap:6px;flex:none}
.dsc-card-installed{display:inline-flex;align-items:center;flex:none}
.dsc-card-uninstall{display:flex;align-items:center;justify-content:flex-end;width:0;opacity:0;overflow:hidden;pointer-events:none;transition:width .26s cubic-bezier(.2,0,0,1),opacity .18s ease}
.dsc-card:hover .dsc-card-uninstall,.dsc-card:focus-within .dsc-card-uninstall{width:34px;opacity:1;pointer-events:auto}
.dsc-install-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;flex:none;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-state-success-primary)}
button.dsc-install-btn{border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);box-shadow:0 1px 2px color-mix(in srgb,#000 6%,transparent);opacity:0;pointer-events:none;cursor:pointer;transition:opacity .15s,background-color .15s,border-color .15s,box-shadow .15s,color .15s}
.dsc-card:hover button.dsc-install-btn,.dsc-card:focus-within button.dsc-install-btn{opacity:1;pointer-events:auto}
button.dsc-install-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid,var(--dsw-alias-interactive-bg-hover));border-color:var(--dsw-alias-border-l4);color:var(--dsw-alias-label-primary);box-shadow:0 2px 5px color-mix(in srgb,#000 8%,transparent)}
button.dsc-install-btn.is-busy{opacity:1;pointer-events:auto;cursor:progress;border-color:transparent;background:transparent;box-shadow:none}
button.dsc-install-btn.is-remove{color:var(--dsw-alias-state-error-primary)}
button.dsc-install-btn.is-remove:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,transparent);color:var(--dsw-alias-state-error-primary)}
.dsc-install-btn.is-done svg{animation:dsc-pop .18s ease-out}
@keyframes dsc-pop{from{transform:scale(.4);opacity:0}to{transform:scale(1);opacity:1}}
@media (hover:none){button.dsc-install-btn{opacity:1;pointer-events:auto}.dsc-card-uninstall{width:34px;opacity:1;pointer-events:auto}}
.dsc-more{display:flex;justify-content:center;margin-top:16px}
.dsc-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}
.dsc-dialog{display:flex;flex-direction:column;box-sizing:border-box;width:560px;max-width:100%;max-height:calc(100dvh - 48px);gap:20px;padding:0 0 24px;overflow:hidden;border:0;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent)}
.dsc-dialog.is-wide{width:720px}
.dsc-dialog.is-compact{width:380px}
.dsc-dialog-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:22px 14px 12px 24px}
.dsc-dialog-head-actions{display:flex;align-items:center;gap:8px;flex:none}
.dsc-dialog-close{color:var(--dsw-alias-label-secondary)}
.dsc-dialog-titles{min-width:0}
.dsc-dialog-titles h2{margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:16px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary)}
.dsc-dialog-titles p{margin:2px 0 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsc-dialog-body{display:flex;flex-direction:column;gap:12px;padding:0 24px;overflow:auto}
.dsc-dialog-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:0 24px}
.dsc-foot-gap{flex:1}
.dsc-foot-hint{min-width:0;margin-right:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsc-dialog-desc{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.dsc-meta-list{display:flex;flex-direction:column;gap:8px;margin:0}
.dsc-meta-list div{display:flex;gap:12px;min-width:0}
.dsc-meta-list dt{flex:none;width:72px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsc-meta-list dd{display:flex;align-items:center;gap:6px;min-width:0;margin:0;overflow-wrap:anywhere;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsc-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dsc-md{max-height:320px;padding:4px 0;overflow:auto;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}
.dsc-md>*:first-child{margin-top:10px}
.dsc-md>*:last-child{margin-bottom:10px}
.dsc-md pre{overflow:auto}
.dsc-note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsc-confirm{display:flex;flex-direction:column;gap:8px;padding:12px;border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}
.dsc-confirm p{margin:0;font-size:13px;line-height:20px}
.dsc-confirm code{overflow-wrap:anywhere;font:12px/18px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--dsw-alias-label-tertiary)}
.dsc-confirm-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
.dsc-field{display:flex;flex-direction:column;gap:6px}
.dsc-field-label{font-size:13px;font-weight:500;line-height:20px}
.dsc-textarea{box-sizing:border-box;width:100%;min-height:96px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);outline:0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;resize:vertical}
.dsc-textarea::placeholder{color:var(--dsw-alias-label-caption)}
.dsc-textarea:focus{border-color:var(--dsw-alias-state-business-primary)}
.dsc-picker{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.dsc-pick{box-sizing:border-box;display:flex;flex-direction:column;align-items:center;gap:4px;padding:18px 12px;border:1px dashed var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;text-align:center;cursor:pointer;transition:border-color .15s,background-color .15s,box-shadow .15s,transform .15s}
.dsc-pick:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover);box-shadow:0 2px 8px color-mix(in srgb,#000 6%,transparent);transform:translateY(-1px)}
.dsc-pick:hover .dsc-pick-icon{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}
.dsc-pick:active{background:var(--dsw-alias-interactive-bg-hover-solid,var(--dsw-alias-interactive-bg-hover));box-shadow:none;transform:translateY(0)}
.dsc-pick:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dsc-picker.is-dragging .dsc-pick{border-color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 4%,var(--dsw-alias-bg-layer-1));box-shadow:none;transform:none}
.dsc-field-error{display:flex;align-items:flex-start;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.dsc-field-error svg{flex:none;margin-top:2px}
.dsc-pick-icon{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;margin-bottom:2px;border-radius:50%;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);transition:background-color .15s,color .15s}
.dsc-pick-title{font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}
.dsc-pick-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsc-picked{display:flex;align-items:center;gap:8px;min-width:0;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);font-size:13px;line-height:20px}
.dsc-picked-icon{display:inline-flex;flex:none;color:var(--dsw-alias-label-tertiary)}
.dsc-picked-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.dsc-picked-meta{flex:none;margin-left:auto;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsc-picked .dsc-icon-btn{width:22px;height:22px;flex:none}
.dsc-req{display:flex;flex-direction:column;gap:6px}
.dsc-req-title{font-size:13px;font-weight:500;line-height:20px}
.dsc-req ul{display:flex;flex-direction:column;gap:2px;margin:0;padding-left:18px;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.dsc-hidden{display:none}
.dsc-toast{position:fixed;left:50%;bottom:28px;z-index:3000;transform:translateX(-50%);padding:8px 14px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-tooltip-bg);color:var(--dsw-static-neutral-bluish-00,#fff);font-size:13px;line-height:20px;white-space:nowrap;box-shadow:var(--dsw-elevation-prominent)}
.dsc-spinner{display:inline-block;flex:none;transform-origin:50% 50%;animation:dsc-spin .8s linear infinite}
@keyframes dsc-spin{to{transform:rotate(360deg)}}
@media (max-width:720px){.dsc-root{padding:0 16px}.dsc-head-actions{width:100%;justify-content:flex-end}.dsc-dialog.is-wide{width:100%}}
@media (prefers-reduced-motion:reduce){.dsc-spinner{animation-duration:1.6s}}
`
  document.head.append(style)
}
