import {
  aggregateUsage, collectActivity, collectAgentActivity, collectCalendar, collectChannels, collectKnowledge, collectLogs, collectSnapshot, collectTaskBoard, collectTaskDetail, collectUsage,
  commandHealth, BOARD_SLUG, INSIGHT_DAYS, LOG_FILES, TASK_ID, USAGE_PERIODS, buildDashboard, buildOfficeSnapshot, read, recordCommand, systemRun,
  type ActivitySnapshot, type AgentActivitySnapshot, type AgentUsage, type CalendarSnapshot, type ChannelSnapshot, type DashboardSnapshot, type KnowledgeSnapshot, type LogsSnapshot, type OfficeSnapshot,
  type Run, type RuntimeSnapshot, type TaskBoardSnapshot, type TaskDetailSnapshot, type UsageSnapshot,
} from './mission-control.js'
import {
  DashboardError, buildDashboardActivity, buildDashboardAgentActivity, collectDashboardCalendar, collectDashboardChannels, collectDashboardKnowledge, collectDashboardLogs, collectDashboardRuntime,
  collectDashboardSessions, collectDashboardTaskBoard, collectDashboardTaskDetail, collectDashboardUsage, createDashboardClient, createTokenProvider, isUnreachable, readDashboardConfig,
  type DashboardConfig, type DashboardContext, type Fetcher, type ProfileSessions,
} from './hermes-dashboard.js'

// Where the Hermes data comes from. RUANG_HERMES_SOURCE: `dashboard` (REST only), `cli` (the old
// `hermes` commands only) or `auto` (default: dashboard, falling back to the CLI when the dashboard
// cannot be reached, answers 401/403 or returns data in an unexpected shape).

const CACHE_MS = 10_000
const INSIGHTS_CACHE_MS = 60_000
const FALLBACK_COOLDOWN_MS = 30_000
const OPENCODE_CACHE_MS = 300_000
const SESSIONS_SHARE_MS = 4_000

function cachedSource<T>(collect: () => Promise<T>, ttl: number | ((value: T) => number) = CACHE_MS) {
  let entry: { value: T; expires: number } | undefined
  let inflight: Promise<T> | undefined
  const get = (now = Date.now()): Promise<T> => {
    if (entry && entry.expires > now) return Promise.resolve(entry.value)
    inflight ??= collect().then((value) => {
      entry = { value, expires: Date.now() + (typeof ttl === 'function' ? ttl(value) : ttl) }
      return value
    }).finally(() => { inflight = undefined })
    return inflight
  }
  return Object.assign(get, { clear: () => { entry = undefined } })
}

export interface HermesSourceOptions { config?: DashboardConfig; client?: Fetcher; run?: Run; now?: () => number }

/** Builds the cached accessors the API serves. Options exist for tests; the module-level instance uses the environment. */
export function createHermesSource(options: HermesSourceOptions = {}) {
  const config = options.config ?? readDashboardConfig()
  const run = options.run ?? systemRun
  const clock = options.now ?? Date.now
  const client = options.client ?? createDashboardClient({ baseUrl: config.url, token: createTokenProvider(), timeoutMs: config.timeoutMs })
  const auto = config.mode === 'auto'
  let downUntil = 0

  /** Dashboard first (unless mode is `cli`); in auto mode a dashboard failure is logged and the CLI answers instead. */
  async function via<T>(what: string, dashboard: (context: DashboardContext) => Promise<T>, cli: () => Promise<T>): Promise<T> {
    if (config.mode === 'cli') return cli()
    if (auto && clock() < downUntil) return cli()
    try {
      return await dashboard({ get: client, propagate: auto, now: clock, activeWindowSeconds: config.activeWindowSeconds })
    } catch (error) {
      if (!auto || !(error instanceof DashboardError)) throw error
      if (isUnreachable(error)) downUntil = clock() + FALLBACK_COOLDOWN_MS
      recordCommand({ command: `dashboard ${what} failed (${error.kind}), falling back to the hermes CLI${isUnreachable(error) ? ` for ${FALLBACK_COOLDOWN_MS / 1000}s` : ''}`, ok: false, durationMs: 0, at: new Date(clock()).toISOString(), error: error.message })
      return cli()
    }
  }

  const openCodeSource = cachedSource(() => read(run, 'opencode', ['--version'], (value) => value.trim().split('\n').pop()?.trim() || 'Unknown', 'Unknown'), OPENCODE_CACHE_MS)
  const runtimeSource = cachedSource(() => via<RuntimeSnapshot>('profiles', async (context) => collectDashboardRuntime(context, await openCodeSource()), () => collectSnapshot(run)))

  const profileNames = async () => {
    const runtime = await runtimeSource()
    return runtime.profiles.availability === 'available' ? runtime.profiles.data.map((profile) => profile.name) : []
  }

  // Activity list and live agent activity read the same session pages, so they share one fetch.
  let sessionsMemo: { key: string; at: number; promise: Promise<ProfileSessions[]> } | undefined
  function sharedSessions(context: DashboardContext, names: string[]): Promise<ProfileSessions[]> {
    const key = names.join(',')
    if (sessionsMemo && sessionsMemo.key === key && clock() - sessionsMemo.at < SESSIONS_SHARE_MS) return sessionsMemo.promise
    const promise = collectDashboardSessions(context, names)
    const memo = { key, at: clock(), promise }
    sessionsMemo = memo
    promise.catch(() => { if (sessionsMemo === memo) sessionsMemo = undefined })
    return promise
  }

  const taskBoardSource = cachedSource(() => via<TaskBoardSnapshot>('kanban', collectDashboardTaskBoard, () => collectTaskBoard(run)))
  const calendarSource = cachedSource(() => via<CalendarSnapshot>('cron', collectDashboardCalendar, () => collectCalendar(run)))
  const activitySource = cachedSource(() => via<ActivitySnapshot>('sessions', async (context) => buildDashboardActivity(await sharedSessions(context, await profileNames()), clock()), () => collectActivity(run)))
  const knowledgeSource = cachedSource(() => via<KnowledgeSnapshot>('skills', collectDashboardKnowledge, () => collectKnowledge(run)))
  const channelSource = cachedSource(() => via<ChannelSnapshot>('status', collectDashboardChannels, () => collectChannels(run)))
  const logsSource = cachedSource(() => via<LogsSnapshot>('logs', (context) => collectDashboardLogs(context, LOG_FILES), () => collectLogs(run)), 5_000)
  const agentActivitySource = cachedSource(async () => {
    const names = await profileNames()
    return via<AgentActivitySnapshot>('agent activity', async (context) => buildDashboardAgentActivity(await sharedSessions(context, names), clock(), config.activeWindowSeconds), () => collectAgentActivity(names, run))
  }, (value) => (value.via === 'dashboard' ? 5_000 : 15_000))
  const usageSources = new Map(USAGE_PERIODS.map((days) => [days, cachedSource(async () => {
    const names = await profileNames()
    return via<UsageSnapshot>('usage', async (context) => aggregateUsage(days, (await collectDashboardUsage(context, days, names)).map((item): AgentUsage => item.usage ? { agent: item.agent, availability: 'available', usage: item.usage } : { agent: item.agent, availability: 'unavailable', error: item.error ?? 'Usage could not be read.' })), () => collectUsage(days, names, run))
  }, INSIGHTS_CACHE_MS)]))

  const getSnapshot = (now = Date.now()): Promise<RuntimeSnapshot> => runtimeSource(now)
  const getTaskBoard = (now = Date.now()): Promise<TaskBoardSnapshot> => taskBoardSource(now)
  const getCalendar = (now = Date.now()): Promise<CalendarSnapshot> => calendarSource(now)
  const getActivity = (now = Date.now()): Promise<ActivitySnapshot> => activitySource(now)
  const getKnowledge = (now = Date.now()): Promise<KnowledgeSnapshot> => knowledgeSource(now)
  const getChannels = (now = Date.now()): Promise<ChannelSnapshot> => channelSource(now)
  const getLogs = (now = Date.now()): Promise<LogsSnapshot> => logsSource(now)

  return {
    config,
    getSnapshot,
    clearSnapshotCache: () => runtimeSource.clear(),
    getTaskBoard,
    getCalendar,
    getActivity,
    getKnowledge,
    getChannels,
    getLogs,
    /** Token usage of every agent over 1, 7 or 30 days (anything else reads as 7). */
    getUsage: (days: number, now = Date.now()): Promise<UsageSnapshot> => (usageSources.get(days as typeof USAGE_PERIODS[number]) ?? usageSources.get(INSIGHT_DAYS)!)(now),
    /** Details of a task on the current board snapshot; `board` picks the board it lives on. Undefined for ids Hermes did not list. */
    async getTaskDetail(id: string, now = Date.now(), board?: string): Promise<TaskDetailSnapshot | undefined> {
      if (!TASK_ID.test(id) || (board !== undefined && !BOARD_SLUG.test(board))) return undefined
      const snapshot = await getTaskBoard(now)
      if (snapshot.tasks.availability === 'available' && !snapshot.tasks.data.some((task) => task.id === id && task.board === board)) return undefined
      return via<TaskDetailSnapshot>('task detail', (context) => collectDashboardTaskDetail(context, id, board), () => collectTaskDetail(id, run, board))
    },
    async getOffice(now = Date.now()): Promise<OfficeSnapshot> {
      const [runtime, board, activity, agentActivity] = await Promise.all([getSnapshot(now), getTaskBoard(now), getActivity(now), agentActivitySource(now)])
      return buildOfficeSnapshot(runtime, board, activity, { agentActivity })
    },
    async getDashboard(now = Date.now()): Promise<DashboardSnapshot> {
      const [runtime, board, calendar, activity, knowledge, channels, agentActivity] = await Promise.all([getSnapshot(now), getTaskBoard(now), getCalendar(now), getActivity(now), getKnowledge(now), getChannels(now), agentActivitySource(now)])
      const office = buildOfficeSnapshot(runtime, board, activity, { agentActivity })
      return buildDashboard({ runtime, board, calendar, activity, knowledge, channels, office, commands: commandHealth() })
    },
  }
}

const source = createHermesSource()
export const { getSnapshot, clearSnapshotCache, getTaskBoard, getCalendar, getActivity, getKnowledge, getChannels, getLogs, getUsage, getTaskDetail, getOffice, getDashboard } = source
export const hermesSourceMode = source.config.mode
