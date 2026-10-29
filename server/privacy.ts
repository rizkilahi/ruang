import type { MemorySnapshot } from './memory.js'
import type { ActivitySnapshot, CalendarSnapshot, DashboardSnapshot, LogsSnapshot, OfficeSnapshot, Session, TaskBoardSnapshot, UsageSnapshot } from './mission-control.js'
import { isHidden, type Privacy } from './profile-lock.js'

// Withholds the private data of locked agents (see profile-lock.ts) from each snapshot, per
// request. The snapshots themselves are cached and shared, so these return redacted copies.
// Sessions, logs and the latest session come from the active Hermes profile, `default`.

export const PRIVATE_TASK = '🔒 Private task'
export const PRIVATE_JOB = '🔒 Private job'
export const PRIVATE_SESSION = '🔒 Private session'
const DEFAULT_AGENT = 'default'

const quiet = (privacy: Privacy) => !privacy.all && privacy.hidden.size === 0

export function redactOffice(office: OfficeSnapshot, privacy: Privacy): OfficeSnapshot {
  if (quiet(privacy) && privacy.locked.size === 0) return office
  return {
    ...office,
    stations: office.stations.map((station) => {
      if (!isHidden(privacy, station.id)) return privacy.locked.has(station.id) ? { ...station, privacy: 'unlocked' as const } : station
      const busy = station.state !== 'Idle' && station.state !== 'Offline' && station.state !== 'Unknown'
      // Provenance names the kind of live activity (chat, cron, tools…), so it is withheld too.
      return { ...station, privacy: 'locked' as const, currentTask: '🔒 Private', recentActivity: '🔒 Private', provenance: '🔒 Private (profile lock)', activity: busy && station.activity ? `🔒 ${station.state}` : station.state === 'Idle' ? 'On a break' : '' }
    }),
  }
}

export function redactTasks(board: TaskBoardSnapshot, privacy: Privacy): TaskBoardSnapshot {
  if (quiet(privacy)) return board
  return { ...board, tasks: { ...board.tasks, data: board.tasks.data.map((task) => isHidden(privacy, task.assignee) ? { ...task, title: PRIVATE_TASK, private: true } : task) } }
}

export function redactCalendar(calendar: CalendarSnapshot, privacy: Privacy): CalendarSnapshot {
  if (quiet(privacy)) return calendar
  return { ...calendar, jobs: { ...calendar.jobs, data: calendar.jobs.data.map((job) => isHidden(privacy, job.agent ?? DEFAULT_AGENT) ? { ...job, name: PRIVATE_JOB, private: true } : job) } }
}

// A session belongs to its `actor` (the Hermes profile, set by the dashboard source); the CLI
// source lists the active profile's sessions only and leaves `actor` empty, so those are `default`.
const redactSession = (session: Session, privacy: Privacy): Session => isHidden(privacy, session.actor ?? DEFAULT_AGENT) ? { ...session, title: PRIVATE_SESSION, preview: '', workspace: undefined } : session

export function redactActivity(activity: ActivitySnapshot, privacy: Privacy): ActivitySnapshot {
  if (quiet(privacy)) return activity
  return { ...activity, sessions: { ...activity.sessions, data: activity.sessions.data.map((session) => redactSession(session, privacy)) } }
}

export function redactDashboard(dashboard: DashboardSnapshot, privacy: Privacy): DashboardSnapshot {
  if (quiet(privacy) || !dashboard.activity.latest) return dashboard
  return { ...dashboard, activity: { ...dashboard.activity, latest: redactSession(dashboard.activity.latest, privacy) } }
}

export function redactLogs(logs: LogsSnapshot, privacy: Privacy): LogsSnapshot {
  if (!isHidden(privacy, DEFAULT_AGENT)) return logs
  return { ...logs, files: logs.files.map((file) => ({ ...file, source: { availability: 'unavailable', data: [], error: { code: 'LOCKED', message: '🔒 These are the logs of the locked default agent. Unlock it to read them.' } } })) }
}

export function redactUsage(usage: UsageSnapshot, privacy: Privacy): UsageSnapshot {
  if (quiet(privacy)) return usage
  return { ...usage, agents: usage.agents.map((agent) => isHidden(privacy, agent.agent) && agent.usage ? { ...agent, usage: { ...agent.usage, topSession: undefined } } : agent) }
}

export function redactMemory(memory: MemorySnapshot, privacy: Privacy): MemorySnapshot {
  if (quiet(privacy)) return memory
  return { ...memory, agents: memory.agents.map((agent) => isHidden(privacy, agent.profile) ? { profile: agent.profile, label: agent.label, path: agent.path, kind: agent.kind, available: false, reason: '🔒 Locked', locked: true, contextFiles: [] } : agent) }
}
