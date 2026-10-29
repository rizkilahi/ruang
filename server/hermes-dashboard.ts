import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  ACTIVITY_LABELS, BOARD_SLUG, PLATFORMS, PROFILE_NAME, TASK_ID, boardsFromJson, mapLimit, parseLogLines, recordCommand, redactLogLine, taskDetailFromJson, tasksFromJson, text,
  type ActivityKind, type ActivitySnapshot, type AgentActivity, type AgentActivitySnapshot, type CalendarSnapshot, type Channel, type ChannelSnapshot, type KanbanBoard, type KnowledgeSnapshot,
  type LogFile, type LogsSnapshot, type Profile, type RuntimeSnapshot, type ScheduledJob, type Session, type Skill, type Source, type Task, type TaskBoardSnapshot, type TaskDetail,
  type TaskDetailSnapshot, type UsageInsights,
} from './mission-control.js'

// Data layer that reads the running Hermes dashboard (REST) instead of spawning the `hermes` CLI.
// Every collector returns the same snapshot types the CLI collectors do, so the UI, the privacy
// redaction and the profile lock work unchanged. The bearer token is only ever sent in the
// Authorization header: it is never logged, put in an error message or returned by the API.

export type SourceMode = 'dashboard' | 'cli' | 'auto'
export const DEFAULT_DASHBOARD_URL = 'http://127.0.0.1:9119'
export const TOKEN_ENV_KEY = 'HERMES3D_OFFICE_TOKEN'
/** An agent counts as working while its open session had activity within this many seconds. */
export const ACTIVE_WINDOW_SECONDS = 90
const DEFAULT_TIMEOUT_MS = 5_000
const TOKEN_FILE_CACHE_MS = 30_000

export interface DashboardConfig { mode: SourceMode; url: string; timeoutMs: number; activeWindowSeconds: number }

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function readDashboardConfig(env: NodeJS.ProcessEnv = process.env): DashboardConfig {
  const raw = (env.RUANG_HERMES_SOURCE ?? '').trim().toLowerCase()
  const mode: SourceMode = raw === 'dashboard' || raw === 'cli' || raw === 'auto' ? raw : 'auto'
  return {
    mode,
    url: (env.RUANG_HERMES_DASHBOARD_URL ?? '').trim() || DEFAULT_DASHBOARD_URL,
    timeoutMs: positive(env.RUANG_HERMES_DASHBOARD_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    activeWindowSeconds: positive(env.RUANG_ACTIVE_WINDOW_SECONDS, ACTIVE_WINDOW_SECONDS),
  }
}

// ---------------------------------------------------------------------------
// Errors

/** `connect`, `timeout` and `auth` mean the dashboard cannot be used right now (the auto mode falls back to the CLI). */
export type DashboardErrorKind = 'connect' | 'timeout' | 'auth' | 'http' | 'format'
export class DashboardError extends Error {
  constructor(message: string, readonly kind: DashboardErrorKind, readonly status?: number) { super(message) }
}
export function isUnreachable(error: unknown): boolean {
  return error instanceof DashboardError && (error.kind === 'connect' || error.kind === 'timeout' || error.kind === 'auth')
}

// ---------------------------------------------------------------------------
// Token. Env first, then the HERMES3D_OFFICE_TOKEN line of ~/.hermes/.env, read at runtime.

/** Value of `KEY=value` in dotenv text (quotes and a leading `export` allowed); the last definition wins. */
export function parseEnvValue(content: string, key: string): string | undefined {
  let value: string | undefined
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match || match[1] !== key) continue
    let raw = match[2].trim()
    const quoted = raw.match(/^(["'])(.*)\1/)
    raw = quoted ? quoted[2] : raw.replace(/\s+#.*$/, '')
    if (raw) value = raw
  }
  return value
}

export function createTokenProvider(env: NodeJS.ProcessEnv = process.env, readFile: (path: string) => string = (path) => readFileSync(path, 'utf8')) {
  let cached: { token: string | undefined; expires: number } | undefined
  const get = (now = Date.now()): string | undefined => {
    const fromEnv = (env.RUANG_HERMES_DASHBOARD_TOKEN ?? '').trim()
    if (fromEnv) return fromEnv
    if (cached && cached.expires > now) return cached.token
    let token: string | undefined
    // The shared Hermes home first (~/.hermes), then HERMES_HOME when a profile home is set.
    const homes = [join(homedir(), '.hermes'), env.HERMES_HOME?.trim()].filter((home, index, all): home is string => Boolean(home) && all.indexOf(home) === index)
    for (const home of homes) {
      try { token = parseEnvValue(readFile(join(home, '.env')), TOKEN_ENV_KEY) } catch { token = undefined }
      if (token) break
    }
    cached = { token, expires: now + TOKEN_FILE_CACHE_MS }
    return token
  }
  return Object.assign(get, { clear: () => { cached = undefined } })
}

// ---------------------------------------------------------------------------
// HTTP client

export type Query = Record<string, string | number | boolean | undefined>
/** GET a dashboard path and return the decoded JSON. Throws DashboardError. */
export type Fetcher = (path: string, query?: Query) => Promise<unknown>

export interface ClientOptions {
  baseUrl?: string
  token?: () => string | undefined
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export function createDashboardClient(options: ClientOptions = {}): Fetcher {
  const baseUrl = options.baseUrl ?? DEFAULT_DASHBOARD_URL
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const doFetch = options.fetchImpl ?? fetch
  const token = options.token ?? (() => undefined)
  return async (path, query = {}) => {
    const started = Date.now()
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value))
    const label = `dashboard GET ${path}${params.size ? `?${params}` : ''}`
    const log = (ok: boolean, error?: string) => recordCommand({ command: label, ok, durationMs: Date.now() - started, at: new Date(started).toISOString(), ...(error ? { error } : {}) })
    const fail = (message: string, kind: DashboardErrorKind, status?: number): never => { log(false, message); throw new DashboardError(message, kind, status) }
    let url: URL
    try {
      url = new URL(path, baseUrl)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol')
      params.forEach((value, key) => url.searchParams.set(key, value))
    } catch { return fail('Dashboard URL is invalid.', 'connect') }
    const secret = token()
    let response: Response
    try {
      response = await doFetch(url, { headers: { Accept: 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) }, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' })
    } catch (error) {
      const name = (error as { name?: string } | undefined)?.name
      return name === 'TimeoutError' || name === 'AbortError' ? fail('Dashboard request timed out.', 'timeout') : fail('Dashboard could not be reached.', 'connect')
    }
    if (response.status === 401 || response.status === 403) return fail(`Dashboard rejected the access token (HTTP ${response.status}).`, 'auth', response.status)
    if (!response.ok) { void response.body?.cancel().catch(() => undefined); return fail(`Dashboard answered HTTP ${response.status}.`, 'http', response.status) }
    try {
      const body = await response.json()
      log(true)
      return body
    } catch { return fail('Dashboard returned data that could not be parsed.', 'format') }
  }
}

// ---------------------------------------------------------------------------
// Collection context. In `auto` mode (propagate) every DashboardError aborts the collector so the
// caller can fall back to the CLI; otherwise a failure becomes an unavailable source.

export interface DashboardContext { get: Fetcher; propagate: boolean; now?: () => number; activeWindowSeconds?: number }

function describeFailure(error: unknown): NonNullable<Source<unknown>['error']> {
  if (error instanceof DashboardError) return { code: error.kind === 'timeout' ? 'TIMEOUT' : 'COMMAND_FAILED', message: error.kind === 'timeout' ? 'Read timed out.' : error.message }
  return { code: 'COMMAND_FAILED', message: 'Hermes dashboard returned data in an unexpected shape.' }
}

async function dread<T>(ctx: DashboardContext, task: () => Promise<T>, fallback: T): Promise<Source<T>> {
  try {
    return { availability: 'available', data: await task() }
  } catch (error) {
    if (ctx.propagate && error instanceof DashboardError) throw error
    return { availability: 'unavailable', data: fallback, error: describeFailure(error) }
  }
}

const nowOf = (ctx: DashboardContext) => (ctx.now ?? Date.now)()
const format = (message: string) => new DashboardError(message, 'format')

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function listOf(value: unknown, key?: string): Record<string, unknown>[] | undefined {
  const list = Array.isArray(value) ? value : key ? record(value)?.[key] : undefined
  return Array.isArray(list) ? list.filter((item): item is Record<string, unknown> => record(item) !== undefined) : undefined
}
function num(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : 0 }

// ---------------------------------------------------------------------------
// Runtime (profiles)

export function mapProfiles(body: unknown): Profile[] {
  const rows = listOf(body, 'profiles')
  if (!rows || rows.length === 0) throw format('Unrecognized dashboard profile list.')
  return rows.flatMap((row): Profile[] => {
    const name = text(row.name)
    if (!name) return []
    return [{ name, model: text(row.model) ?? 'Not configured', gateway: row.gateway_running === true ? 'Running' : row.gateway_running === false ? 'Stopped' : 'Unknown' }]
  })
}

export async function collectDashboardRuntime(ctx: DashboardContext, openCode: Source<string>): Promise<RuntimeSnapshot> {
  const profiles = await dread(ctx, async () => mapProfiles(await ctx.get('/api/profiles')), [] as Profile[])
  return { profiles, openCode, fetchedAt: new Date().toISOString(), via: 'dashboard' }
}

// ---------------------------------------------------------------------------
// Kanban

const KANBAN = '/api/plugins/kanban'
const KANBAN_CONCURRENCY = 4

export function mapBoardTasks(body: unknown): Task[] {
  const columns = listOf(record(body)?.columns)
  if (!columns) throw format('Unrecognized dashboard Kanban board.')
  return tasksFromJson(columns.flatMap((column) => listOf(column.tasks) ?? []))
}

export async function collectDashboardTaskBoard(ctx: DashboardContext): Promise<TaskBoardSnapshot> {
  const fetchedAt = new Date().toISOString()
  const boards = await dread(ctx, async () => boardsFromJson(record(await ctx.get(`${KANBAN}/boards`))?.boards), [] as KanbanBoard[])
  if (boards.availability !== 'available' || boards.data.length === 0) {
    return { tasks: await dread(ctx, async () => mapBoardTasks(await ctx.get(`${KANBAN}/board`)), [] as Task[]), fetchedAt }
  }
  const withTasks = boards.data.filter((board) => board.total > 0 || board.current)
  const results = await mapLimit(withTasks, KANBAN_CONCURRENCY, (board) => dread(ctx, async () => mapBoardTasks(await ctx.get(`${KANBAN}/board`, { board: board.slug })), [] as Task[]))
  const failedBoards = withTasks.filter((_, index) => results[index].availability !== 'available').map((board) => board.slug)
  if (withTasks.length > 0 && failedBoards.length === withTasks.length) return { tasks: results[0], boards: boards.data, fetchedAt }
  const tasks = results.flatMap((result, index) => result.availability === 'available' ? result.data.map((task) => ({ ...task, board: withTasks[index].slug })) : [])
  return { tasks: { availability: 'available', data: tasks }, boards: boards.data, ...(failedBoards.length ? { failedBoards } : {}), fetchedAt }
}

/** The dashboard nests the links as `links.{parents,children}` and the latest summary inside the task. */
export function mapTaskDetail(body: unknown): TaskDetail {
  const root = record(body)
  const task = record(root?.task)
  if (!root || !task) throw format('Unrecognized dashboard Kanban task.')
  const links = record(root.links)
  return taskDetailFromJson({ task, parents: links?.parents, children: links?.children, comments: root.comments, events: root.events, runs: root.runs, latest_summary: task.latest_summary })
}

export async function collectDashboardTaskDetail(ctx: DashboardContext, id: string, board?: string): Promise<TaskDetailSnapshot> {
  if (!TASK_ID.test(id)) throw new Error('Invalid task id.')
  if (board !== undefined && !BOARD_SLUG.test(board)) throw new Error('Invalid board.')
  const task = await dread<TaskDetail | null>(ctx, async () => mapTaskDetail(await ctx.get(`${KANBAN}/tasks/${encodeURIComponent(id)}`, { board })), null)
  return { task, fetchedAt: new Date().toISOString() }
}

// ---------------------------------------------------------------------------
// Cron

const OVERDUE_GRACE_MS = 15 * 60_000

export function mapCronJobs(body: unknown, now = Date.now()): ScheduledJob[] {
  const rows = listOf(body, 'jobs')
  if (!rows) throw format('Unrecognized dashboard cron list.')
  return rows.flatMap((row): ScheduledJob[] => {
    const id = text(row.id)
    const schedule = record(row.schedule)
    const display = text(row.schedule_display) ?? text(schedule?.display) ?? text(schedule?.expr)
    if (!display) return []
    const state = text(row.state)?.toLowerCase()
    const status = state === 'paused' || row.paused_at ? 'paused' : state === 'completed' ? 'completed' : row.enabled === false ? 'disabled' : 'active'
    const nextRun = text(row.next_run_at)
    const late = status === 'active' && nextRun !== undefined && Number.isFinite(Date.parse(nextRun)) && now - Date.parse(nextRun) > OVERDUE_GRACE_MS
    const repeat = record(row.repeat)
    const times = typeof repeat?.times === 'number' && repeat.times > 0 ? repeat.times : undefined
    const lastRun = text(row.last_run_at)
    const agent = text(row.profile_name) ?? text(row.profile)
    return [{
      name: text(row.name) ?? id ?? display,
      schedule: display,
      ...(id ? { id } : {}),
      status,
      ...(nextRun ? { nextRun } : {}),
      ...(late ? { overdue: true } : {}),
      repeat: times ? `${num(repeat?.completed)}/${times}` : '∞',
      // Only the timestamp and the ok/failed outcome are exposed; error text is never returned.
      ...(lastRun && text(row.last_status) ? { lastRun, lastRunOk: row.last_status === 'ok' } : {}),
      ...(agent ? { agent } : {}),
    }]
  })
}

export async function collectDashboardCalendar(ctx: DashboardContext): Promise<CalendarSnapshot> {
  const jobs = await dread(ctx, async () => mapCronJobs(await ctx.get('/api/cron/jobs', { profile: 'all' }), nowOf(ctx)), [] as ScheduledJob[])
  return { jobs, fetchedAt: new Date().toISOString() }
}

// ---------------------------------------------------------------------------
// Sessions (activity list, live agent activity, usage)

type Row = Record<string, unknown>
export interface ProfileSessions { profile: string; ok: boolean; rows: Row[] }

const ACTIVITY_LIST_LIMIT = 20
const SESSION_PAGE = 20
const USAGE_SESSION_LIMIT = 100

/** Latest activity of a session, in epoch seconds: Hermes' own activity stamp, else the last message, else the start. */
export function sessionActivityAt(row: Row): number | undefined {
  for (const key of ['last_activity_at', 'last_active', 'started_at']) {
    const value = row[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  }
  return undefined
}

export function relativeAge(seconds: number, now: number): string {
  const delta = Math.max(0, Math.round(now / 1000 - seconds))
  if (delta < 60) return 'just now'
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`
  if (delta < 86_400) return `${Math.floor(delta / 3600)}h ago`
  return `${Math.floor(delta / 86_400)}d ago`
}

export function mapSessions(rows: { profile: string; row: Row }[], now: number): Session[] {
  return rows.flatMap(({ profile, row }): Session[] => {
    const preview = text(row.preview)
    const title = text(row.title) ?? preview ?? 'Untitled session'
    const at = sessionActivityAt(row)
    const workspace = text(row.cwd)
    const source = text(row.source)
    const id = text(row.id)
    return [{
      title: redactLogLine(title, 300),
      preview: preview ? redactLogLine(preview, 300) : '',
      lastActive: at ? relativeAge(at, now) : 'Unknown',
      ...(id ? { id } : {}),
      ...(workspace ? { workspace: redactLogLine(workspace, 300) } : {}),
      ...(source ? { source } : {}),
      // The owning profile, so the profile lock can withhold the titles of locked agents.
      actor: profile,
    }]
  })
}

async function fetchSessionRows(ctx: DashboardContext, profile: string, limit: number): Promise<Row[]> {
  const rows = listOf(await ctx.get('/api/sessions', { limit, order: 'recent', profile }), 'sessions')
  if (!rows) throw format('Unrecognized dashboard session list.')
  return rows
}

/** Latest sessions of every profile. A profile that cannot be read is marked `ok: false` (in auto mode any dashboard error aborts, so the CLI takes over). */
export async function collectDashboardSessions(ctx: DashboardContext, profiles: readonly string[], limit = SESSION_PAGE): Promise<ProfileSessions[]> {
  return mapLimit(profiles.filter((profile) => PROFILE_NAME.test(profile)), 5, async (profile): Promise<ProfileSessions> => {
    try {
      return { profile, ok: true, rows: await fetchSessionRows(ctx, profile, limit) }
    } catch (error) {
      if (ctx.propagate && error instanceof DashboardError) throw error
      return { profile, ok: false, rows: [] }
    }
  })
}

export function buildDashboardActivity(sessions: readonly ProfileSessions[], now: number): ActivitySnapshot {
  const readable = sessions.filter((item) => item.ok)
  const fetchedAt = new Date().toISOString()
  if (sessions.length > 0 && readable.length === 0) return { sessions: { availability: 'unavailable', data: [], error: { code: 'COMMAND_FAILED', message: 'Hermes dashboard sessions could not be read.' } }, fetchedAt }
  const merged = readable.flatMap(({ profile, rows }) => rows.map((row) => ({ profile, row, at: sessionActivityAt(row) ?? 0 })))
  merged.sort((a, b) => b.at - a.at)
  return { sessions: { availability: 'available', data: mapSessions(merged.slice(0, ACTIVITY_LIST_LIMIT), now) }, fetchedAt }
}

const CHAT_SOURCES = new Set(['telegram', 'discord', 'slack', 'whatsapp', 'signal', 'matrix', 'mattermost', 'email', 'sms', 'dingtalk', 'feishu', 'wecom', 'weixin', 'bluebubbles', 'qqbot', 'yuanbao', 'imessage', 'webhook', 'api_server'])
const TOOLISH = /\b(tool|terminal|bash|shell|exec|command|browser|read_file|write_file|search|patch|web_|mcp)/i

function activityKind(source: string | undefined, description: string | undefined): ActivityKind {
  const name = (source ?? '').toLowerCase()
  if (name === 'cron') return 'cron'
  if (CHAT_SOURCES.has(name)) return 'chat'
  return description && TOOLISH.test(description) ? 'tools' : 'thinking'
}

function describeActivity(row: Row): string | undefined {
  const description = text(row.last_activity_description)
  if (!description) return undefined
  const short = redactLogLine(description.replace(/\s+/g, ' '), 140)
  return short.charAt(0).toUpperCase() + short.slice(1)
}

/**
 * Live activity per profile from its sessions: working while a session has not ended and had activity
 * within the window. The activity description Hermes records becomes the label and the detail.
 */
export function buildDashboardAgentActivity(sessions: readonly ProfileSessions[], now: number, windowSeconds = ACTIVE_WINDOW_SECONDS): AgentActivitySnapshot {
  const agents = sessions.map(({ profile, ok, rows }): AgentActivity => {
    if (!ok) return { profile, availability: 'unavailable', active: false, mentionsOpenCode: false }
    const live = rows
      .filter((row) => row.ended_at === null || row.ended_at === undefined)
      .flatMap((row) => { const at = sessionActivityAt(row); return at !== undefined && now / 1000 - at < windowSeconds ? [{ row, at }] : [] })
      .sort((a, b) => b.at - a.at)[0]
    if (!live) return { profile, availability: 'available', active: false, mentionsOpenCode: false }
    const detail = describeActivity(live.row)
    const kind = activityKind(text(live.row.source), detail)
    return { profile, availability: 'available', active: true, kind, label: detail ?? ACTIVITY_LABELS[kind], ...(detail ? { detail } : {}), lastSeen: new Date(live.at * 1000).toISOString(), mentionsOpenCode: /\bopencode\b/i.test(detail ?? '') }
  })
  return { agents, fetchedAt: new Date().toISOString(), via: 'dashboard', window: `${windowSeconds}s` }
}

// ---------------------------------------------------------------------------
// Skills and channels (status)

const PROVENANCE_TRUST: Record<string, string> = { bundled: 'builtin', hub: 'community', agent: 'local', external: 'external' }

export function mapSkills(body: unknown): Skill[] {
  const rows = listOf(body, 'skills')
  if (!rows) throw format('Unrecognized dashboard skill list.')
  return rows.flatMap((row): Skill[] => {
    const name = text(row.name)
    if (!name || row.enabled === false) return []
    const provenance = text(row.provenance) ?? 'unknown'
    return [{ name, category: text(row.category) ?? '', source: provenance, trust: PROVENANCE_TRUST[provenance] ?? provenance, status: 'enabled' }]
  })
}

export async function collectDashboardKnowledge(ctx: DashboardContext): Promise<KnowledgeSnapshot> {
  return { skills: await dread(ctx, async () => mapSkills(await ctx.get('/api/skills')), [] as Skill[]), fetchedAt: new Date().toISOString() }
}

export function mapChannels(body: unknown): { channels: Channel[]; activeSessions?: number } {
  const root = record(body)
  const platforms = record(root?.gateway_platforms)
  if (!root || !platforms) throw format('Unrecognized dashboard status.')
  const canonical = new Map(PLATFORMS.map((name) => [name.toLowerCase(), name]))
  const channels = Object.entries(platforms).map(([key, value]): Channel => {
    const name = canonical.get(key.replace(/[_-]/g, ' ').toLowerCase()) ?? key.charAt(0).toUpperCase() + key.slice(1)
    return { name, status: text(record(value)?.state)?.toLowerCase() === 'connected' ? 'Connected' : 'Configured' }
  })
  return { channels, ...(typeof root.active_sessions === 'number' ? { activeSessions: root.active_sessions } : {}) }
}

export async function collectDashboardChannels(ctx: DashboardContext): Promise<ChannelSnapshot> {
  const result = await dread(ctx, async () => mapChannels(await ctx.get('/api/status')), { channels: [] as Channel[] } as { channels: Channel[]; activeSessions?: number })
  return {
    channels: { availability: result.availability, data: result.data.channels, ...(result.error && { error: result.error }) },
    ...(result.availability === 'available' && result.data.activeSessions !== undefined ? { activeSessions: result.data.activeSessions } : {}),
    fetchedAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Logs

const LOG_TAIL_LINES = 200

export async function collectDashboardLogs(ctx: DashboardContext, files: readonly { name: string; label: string }[]): Promise<LogsSnapshot> {
  const results = await Promise.all(files.map(async ({ name, label }): Promise<LogFile> => ({
    name,
    label,
    source: await dread(ctx, async () => {
      const lines = record(await ctx.get('/api/logs', { file: name, lines: LOG_TAIL_LINES }))?.lines
      if (!Array.isArray(lines)) throw format('Unrecognized dashboard log.')
      return parseLogLines(lines.filter((line): line is string => typeof line === 'string').join('\n'))
    }, []),
  })))
  return { files: results, fetchedAt: new Date().toISOString() }
}

// ---------------------------------------------------------------------------
// Usage. Totals, cost, models and tools come from /api/analytics/usage as Hermes reports them.
// The dashboard has no per-session-source or message totals, so those two come from the latest
// sessions of the agent (only when that page covers the whole period).

const DAY_MS = 86_400_000

function sessionTokens(row: Row): number {
  return num(row.input_tokens) + num(row.output_tokens) + num(row.cache_read_tokens) + num(row.cache_write_tokens)
}

function ranked<K extends 'model' | 'source'>(key: K, groups: Map<string, { sessions: number; tokens: number }>) {
  return [...groups].map(([name, value]) => ({ [key]: name, ...value }) as { [P in K]: string } & { sessions: number; tokens: number }).sort((a, b) => b.tokens - a.tokens)
}

export function mapUsage(body: unknown, days: number, sessions: { rows: Row[]; total?: number }, now: number): UsageInsights {
  const root = record(body)
  const totals = record(root?.totals)
  if (!root || !totals) throw format('Unrecognized dashboard usage.')
  const inputTokens = num(totals.total_input)
  const outputTokens = num(totals.total_output)
  const cutoff = (now - days * DAY_MS) / 1000
  const inPeriod = sessions.rows.filter((row) => num(row.started_at) >= cutoff)
  const covers = sessions.rows.length < USAGE_SESSION_LIMIT || (sessions.total ?? 0) <= sessions.rows.length || sessions.rows.some((row) => num(row.started_at) < cutoff)
  const group = (field: 'model' | 'source') => inPeriod.reduce((groups, row) => {
    const name = text(row[field]) ?? 'unknown'
    const current = groups.get(name) ?? { sessions: 0, tokens: 0 }
    return groups.set(name, { sessions: current.sessions + 1, tokens: current.tokens + sessionTokens(row) })
  }, new Map<string, { sessions: number; tokens: number }>())
  const byModel = (listOf(root.by_model) ?? []).flatMap((row) => { const model = text(row.model); return model ? [{ model, sessions: num(row.sessions), tokens: num(row.input_tokens) + num(row.output_tokens) }] : [] })
  const tools = (listOf(root.tools) ?? []).flatMap((row) => { const tool = text(row.tool); return tool ? [{ tool, calls: num(row.count) }] : [] }).sort((a, b) => b.calls - a.calls)
  const cost = num(totals.total_actual_cost) > 0 ? num(totals.total_actual_cost) : num(totals.total_estimated_cost)
  const top = inPeriod.reduce<Row | undefined>((best, row) => (!best || sessionTokens(row) > sessionTokens(best) ? row : best), undefined)
  const sessionCount = num(totals.total_sessions)
  return {
    days,
    sessions: sessionCount,
    messages: inPeriod.reduce((sum, row) => sum + num(row.message_count), 0),
    toolCalls: tools.reduce((sum, tool) => sum + tool.calls, 0),
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens + num(totals.total_cache_read),
    ...(cost > 0 ? { estimatedCost: `~$${cost.toFixed(2)}`, costUsd: cost } : {}),
    models: covers && inPeriod.length > 0 ? ranked('model', group('model')) : byModel.sort((a, b) => b.tokens - a.tokens),
    tools,
    sources: covers && inPeriod.length > 0 ? ranked('source', group('source')) : [],
    ...(top && sessionTokens(top) > 0 ? { topSession: { tokens: sessionTokens(top), date: new Date(num(top.started_at) * 1000).toISOString().slice(0, 10) } } : {}),
  }
}

export interface DashboardAgentUsage { agent: string; usage?: UsageInsights; error?: string }

/** Usage of every profile; the caller sums them (same aggregation as the CLI path). */
export async function collectDashboardUsage(ctx: DashboardContext, days: number, profiles: readonly string[]): Promise<DashboardAgentUsage[]> {
  const names = profiles.filter((name) => PROFILE_NAME.test(name))
  return mapLimit(names.length > 0 ? names : ['default'], 4, async (agent): Promise<DashboardAgentUsage> => {
    try {
      const profile = names.length > 0 ? agent : undefined
      const [usage, sessions] = await Promise.all([
        ctx.get('/api/analytics/usage', { days, profile }),
        ctx.get('/api/sessions', { limit: USAGE_SESSION_LIMIT, order: 'recent', profile }),
      ])
      const rows = listOf(sessions, 'sessions')
      if (!rows) throw format('Unrecognized dashboard session list.')
      return { agent, usage: mapUsage(usage, days, { rows, total: num(record(sessions)?.total) }, nowOf(ctx)) }
    } catch (error) {
      if (ctx.propagate && error instanceof DashboardError) throw error
      return { agent, error: describeFailure(error).message }
    }
  })
}
