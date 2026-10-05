/* eslint-disable react-refresh/only-export-components */
import * as React from 'react'

import {
  acceptNativeSnapshot,
  mergeNativeSnapshot,
  nativeKey,
  rekeyNativeState,
  type NativeAnswer,
  type NativeDraft,
  type NativeSnapshot,
  type NativeSnapshotUpdate,
  type PlanTransitionAction,
  type PromptContent
} from '@shared/native-session'
import {
  isTerminalSessionFinished,
  type TerminalSession,
  type TerminalTarget
} from '@shared/terminal-session'
import { remoteRequest, subscribeRemoteNativeSnapshots } from './remote-api'

type RemoteNativeSessionsValue = {
  snapshots: Record<string, NativeSnapshot | undefined>
  drafts: Record<string, NativeDraft | undefined>
  busy: Record<string, boolean | undefined>
  errors: Record<string, string | undefined>
  setDraft: (
    key: string,
    draft: NativeDraft | ((previous: NativeDraft) => NativeDraft)
  ) => void
  refresh: (session: TerminalSession) => Promise<void>
  respond: (
    session: TerminalSession,
    interactionId: string,
    answer: NativeAnswer,
    prepare?: () => Promise<void>
  ) => Promise<boolean>
  prompt: (
    session: TerminalSession,
    prompt: string,
    request?: string,
    attachments?: PromptContent[]
  ) => Promise<boolean>
  transitionPlan: (session: TerminalSession, action: PlanTransitionAction) => Promise<boolean>
  reopenPlan: (session: TerminalSession) => Promise<boolean>
  cancel: (session: TerminalSession) => Promise<boolean>
  end: (session: TerminalSession) => Promise<boolean>
}

const RemoteNativeSessionsContext = React.createContext<RemoteNativeSessionsValue | null>(null)

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function target(session: TerminalSession): TerminalTarget {
  if (!session.generation || session.transport === 'external') {
    throw new Error('This is not a connected in-app session.')
  }
  return { id: session.id, generation: session.generation }
}

export function RemoteNativeSessionsProvider({
  sessions,
  children
}: {
  sessions: TerminalSession[]
  children: React.ReactNode
}): React.JSX.Element {
  const [snapshots, setSnapshots] = React.useState<
    Record<string, NativeSnapshot | undefined>
  >({})
  const [drafts, setDrafts] = React.useState<Record<string, NativeDraft | undefined>>({})
  const [busy, setBusy] = React.useState<Record<string, boolean | undefined>>({})
  const [errors, setErrors] = React.useState<Record<string, string | undefined>>({})
  const snapshotsRef = React.useRef(snapshots)
  const knownRef = React.useRef<Record<string, TerminalSession | undefined>>({})
  const sessionsRef = React.useRef(sessions)
  const refreshing = React.useRef(new Map<string, Promise<void>>())
  const submitting = React.useRef(new Set<string>())

  sessionsRef.current = sessions
  knownRef.current = Object.fromEntries(sessions.map((session) => [session.id, session]))

  const apply = React.useCallback((incoming: NativeSnapshot): boolean => {
    const previous = snapshotsRef.current[incoming.session.id]
    if (!acceptNativeSnapshot(incoming, previous, knownRef.current[incoming.session.id])) {
      return false
    }
    const snapshot = mergeNativeSnapshot(incoming, previous)
    if (!snapshot) return false
    const next = { ...snapshotsRef.current, [incoming.session.id]: snapshot }
    if (snapshot.replacesId && snapshot.replacesId !== incoming.session.id) {
      delete next[snapshot.replacesId]
      setDrafts((current) => rekeyNativeState(current, snapshot.replacesId!, snapshot.session))
      setErrors((current) => rekeyNativeState(current, snapshot.replacesId!, snapshot.session))
    }
    snapshotsRef.current = next
    setSnapshots(snapshotsRef.current)
    return true
  }, [])

  const refresh = React.useCallback(
    (session: TerminalSession): Promise<void> => {
      const identity = nativeKey(session, 'connection')
      const pending = refreshing.current.get(identity)
      if (pending) return pending
      const operation = remoteRequest<NativeSnapshot>(
        `/api/sessions/${encodeURIComponent(session.id)}/snapshot`,
        {
          method: 'POST',
          body: JSON.stringify({ generation: target(session).generation })
        }
      )
        .then((snapshot) => {
          apply(snapshot)
          setErrors((current) =>
            current[identity] ? { ...current, [identity]: undefined } : current
          )
        })
        .catch((error) => {
          setErrors((current) => ({ ...current, [identity]: errorText(error) }))
          throw error
        })
        .finally(() => refreshing.current.delete(identity))
      refreshing.current.set(identity, operation)
      return operation
    },
    [apply]
  )

  const activeIdentity = sessions
    .filter(
      (session) =>
        session.transport !== 'external' && !isTerminalSessionFinished(session.status)
    )
    .map((session) => `${session.id}:${session.generation}`)
    .join('|')

  React.useEffect(() => {
    for (const session of sessionsRef.current) {
      if (
        session.transport !== 'external' &&
        !isTerminalSessionFinished(session.status)
      ) {
        void refresh(session).catch(() => undefined)
      }
    }
  }, [activeIdentity, refresh])

  React.useEffect(() => {
    const refreshActive = (): void => {
      for (const session of sessionsRef.current) {
        if (
          session.transport !== 'external' &&
          !isTerminalSessionFinished(session.status)
        ) {
          void refresh(session).catch(() => undefined)
        }
      }
    }
    const unsubscribe = subscribeRemoteNativeSnapshots(
      (snapshot: NativeSnapshotUpdate) => {
        if (apply(snapshot)) return
        const session = knownRef.current[snapshot.session.id]
        if (session) void refresh(session).catch(() => undefined)
      },
      refreshActive
    )
    if (unsubscribe) return unsubscribe

    let active = true
    let polling = false
    const reconcile = async (): Promise<void> => {
      if (!active || polling || document.visibilityState !== 'visible') return
      polling = true
      try {
        await Promise.all(
          sessionsRef.current
            .filter(
              (session) =>
                session.transport !== 'external' && !isTerminalSessionFinished(session.status)
            )
            .map((session) => refresh(session).catch(() => undefined))
        )
      } finally {
        polling = false
      }
    }
    queueMicrotask(() => void reconcile())
    const timer = window.setInterval(() => void reconcile(), 2500)
    const visible = (): void => {
      if (document.visibilityState === 'visible') void reconcile()
    }
    document.addEventListener('visibilitychange', visible)
    return () => {
      active = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [apply, refresh])

  const setDraft = React.useCallback(
    (key: string, draft: NativeDraft | ((previous: NativeDraft) => NativeDraft)): void => {
      setDrafts((current) => ({
        ...current,
        [key]: typeof draft === 'function' ? draft(current[key] ?? {}) : draft
      }))
    },
    []
  )

  const run = React.useCallback(
    async (
      session: TerminalSession,
      key: string,
      operation: () => Promise<NativeSnapshot | void>,
      clearDraft = false
    ): Promise<boolean> => {
      if (submitting.current.has(key)) return false
      const submittedDraft = drafts[key]
      submitting.current.add(key)
      setBusy((current) => ({ ...current, [key]: true }))
      setErrors((current) => ({ ...current, [key]: undefined }))
      try {
        const snapshot = await operation()
        if (snapshot) apply(snapshot)
        if (clearDraft) {
          setDrafts((current) => {
            if (current[key] !== submittedDraft) return current
            const next = { ...current }
            delete next[key]
            return next
          })
        }
        return true
      } catch (error) {
        setErrors((current) => ({ ...current, [key]: errorText(error) }))
        void refresh(session).catch(() => undefined)
        return false
      } finally {
        submitting.current.delete(key)
        setBusy((current) => ({ ...current, [key]: false }))
      }
    },
    [apply, drafts, refresh]
  )

  const respond = React.useCallback(
    (
      session: TerminalSession,
      interactionId: string,
      answer: NativeAnswer,
      prepare?: () => Promise<void>
    ): Promise<boolean> => {
      const key = nativeKey(session, interactionId)
      return run(
        session,
        key,
        async () => {
          await prepare?.()
          return remoteRequest<NativeSnapshot>(
            `/api/sessions/${encodeURIComponent(session.id)}/respond`,
            {
              method: 'POST',
              body: JSON.stringify({
                generation: target(session).generation,
                interactionId,
                answer
              })
            }
          )
        },
        true
      )
    },
    [run]
  )

  const prompt = React.useCallback(
    (
      session: TerminalSession,
      promptText: string,
      request = 'composer',
      attachments: PromptContent[] = []
    ): Promise<boolean> => {
      const key = nativeKey(session, request)
      const prompt = promptText.trim()
        ? [{ type: 'text' as const, text: promptText }, ...attachments]
        : attachments
      return run(
        session,
        key,
        () =>
          remoteRequest<NativeSnapshot>(
            `/api/sessions/${encodeURIComponent(session.id)}/prompt`,
            {
              method: 'POST',
              body: JSON.stringify({
                generation: target(session).generation,
                id: crypto.randomUUID(),
                prompt
              })
            }
          ),
        true
      )
    },
    [run]
  )

  const transitionPlan = React.useCallback(
    (session: TerminalSession, action: PlanTransitionAction): Promise<boolean> =>
      run(session, nativeKey(session, 'plan-transition'), () =>
        remoteRequest<NativeSnapshot>(
          `/api/sessions/${encodeURIComponent(session.id)}/plan`,
          {
            method: 'POST',
            body: JSON.stringify({ generation: target(session).generation, action })
          }
        )
      ),
    [run]
  )

  const reopenPlan = React.useCallback(
    (session: TerminalSession): Promise<boolean> =>
      run(session, nativeKey(session, 'plan-reopen'), () =>
        remoteRequest<NativeSnapshot>(
          `/api/sessions/${encodeURIComponent(session.id)}/plan/reopen`,
          {
            method: 'POST',
            body: JSON.stringify({ generation: target(session).generation })
          }
        )
      ),
    [run]
  )

  const lifecycle = React.useCallback(
    (session: TerminalSession, action: 'cancel' | 'end'): Promise<boolean> =>
      run(session, nativeKey(session, 'lifecycle'), () =>
        remoteRequest<void>(`/api/sessions/${encodeURIComponent(session.id)}/${action}`, {
          method: 'POST',
          body: JSON.stringify({ generation: target(session).generation })
        })
      ),
    [run]
  )

  const value = React.useMemo<RemoteNativeSessionsValue>(
    () => ({
      snapshots,
      drafts,
      busy,
      errors,
      setDraft,
      refresh,
      respond,
      prompt,
      transitionPlan,
      reopenPlan,
      cancel: (session) => lifecycle(session, 'cancel'),
      end: (session) => lifecycle(session, 'end')
    }),
    [
      snapshots,
      drafts,
      busy,
      errors,
      setDraft,
      refresh,
      respond,
      prompt,
      transitionPlan,
      reopenPlan,
      lifecycle
    ]
  )

  return (
    <RemoteNativeSessionsContext.Provider value={value}>
      {children}
    </RemoteNativeSessionsContext.Provider>
  )
}

export function useRemoteNativeSessions(): RemoteNativeSessionsValue {
  const value = React.useContext(RemoteNativeSessionsContext)
  if (!value) {
    throw new Error('useRemoteNativeSessions must be used within RemoteNativeSessionsProvider.')
  }
  return value
}
