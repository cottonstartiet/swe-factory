import * as React from 'react'

import type { AnalyticsFinding, CopilotAnalyticsSummary } from '@shared/copilot-analytics'

type Snapshot = { date: string; generatedAt: string; findings: AnalyticsFinding[] }

const MAX_FINDINGS = 3

function localDate(date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function read(key: string): Snapshot | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? 'null') as Snapshot | null
    return parsed && typeof parsed.date === 'string' && Array.isArray(parsed.findings)
      ? parsed
      : null
  } catch {
    return null
  }
}

/**
 * "Worth a look" findings are recalculated once per local day. Within a day the stored snapshot is
 * reused; on day rollover (timer or returning to a stale window) `refresh` is called and the
 * snapshot is replaced from the fresh summary.
 */
export function useDailyFindings(
  summary: CopilotAnalyticsSummary | null,
  windowDays: number,
  repository: string,
  refresh: () => Promise<void>
): { findings: AnalyticsFinding[]; generatedAt: string | null } {
  const key = `analytics.worthALook.v1:${windowDays}:${repository}`
  const [day, setDay] = React.useState(() => localDate())
  const matches = summary?.windowDays === windowDays && (summary.repository ?? '') === repository

  const snapshot = React.useMemo((): Snapshot | null => {
    if (!summary || !matches) return null
    const stored = read(key)
    if (stored && stored.date === day) return stored
    const fresh: Snapshot = {
      date: day,
      generatedAt: summary.calculatedAt,
      findings: summary.practices.findings.slice(0, MAX_FINDINGS)
    }
    try {
      localStorage.setItem(key, JSON.stringify(fresh))
    } catch {
      // Storage unavailable; the snapshot just won't persist.
    }
    return fresh
  }, [summary, matches, key, day])

  React.useEffect(() => {
    const check = (): void => {
      const today = localDate()
      if (today !== day) {
        setDay(today)
        void refresh()
      }
    }
    const next = new Date()
    next.setHours(24, 0, 5, 0)
    const timer = window.setTimeout(check, next.getTime() - Date.now())
    document.addEventListener('visibilitychange', check)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', check)
    }
  }, [day, refresh])

  return { findings: snapshot?.findings ?? [], generatedAt: snapshot?.generatedAt ?? null }
}
