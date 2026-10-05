import * as React from 'react'
import {
  ArrowLeftIcon,
  BotIcon,
  CircleAlertIcon,
  GaugeIcon,
  KanbanSquareIcon,
  LoaderCircleIcon,
  PlayIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SendIcon,
  SquareIcon,
  SquareTerminalIcon,
  Trash2Icon,
  WifiOffIcon
} from 'lucide-react'

import {
  nativeKey,
  nativeSessionNeedsUserAction,
  nativeSessionPresentationStatus
} from '@shared/native-session'
import type { Repository } from '@shared/repository'
import type { CreateTaskResult, Task, TaskStatus } from '@shared/task'
import {
  isTerminalSessionFinished,
  type TerminalSession,
  type TerminalTimelineEntry
} from '@shared/terminal-session'
import type { Worktree } from '@shared/worktree'
import { RemoteNativeSessionsProvider, useRemoteNativeSessions } from './native-session-store'
import {
  detectRemoteMode,
  remoteRequest as request,
  subscribeRemoteSnapshots,
  type RemoteMode
} from './remote-api'
import { CloudGate, CloudHostSelect } from './cloud-gate'
import { sessionCardPresentation } from './session-card-presentation'
import { RemotePlanCompletion, RemoteSessionInteraction } from './session-interaction'
import { RemoteTimelineEntry } from './session-timeline-entry'
import { remoteTimelinePresentation } from './session-timeline-presentation'

type View = 'dashboard' | 'tasks' | 'sessions'
const STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'review', 'done']
const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done'
}
const MAIN_BRANCH_VALUE = '__main-branch__'
const NEW_WORKTREE_VALUE = '__new-worktree__'
const VALID_WORKTREE_NAME = /^[A-Za-z0-9._-]+$/
const MAX_WORKTREE_NAME_LENGTH = 64

function worktreeLabel(path: string): string {
  const index = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return index < 0 ? path : path.slice(index + 1)
}

function validateWorktreeName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'Name is required.'
  if (trimmed.length > MAX_WORKTREE_NAME_LENGTH)
    return `Name must be ≤ ${MAX_WORKTREE_NAME_LENGTH} characters.`
  if (!VALID_WORKTREE_NAME.test(trimmed))
    return 'Only letters, digits, dot, underscore, and hyphen are allowed.'
  return null
}

function StatusDot({ status }: { status: TerminalSession['status'] }): React.JSX.Element {
  const tone =
    status === 'error'
      ? 'bg-destructive'
      : status === 'waiting-input'
        ? 'bg-amber-500'
        : status === 'working' || status === 'starting'
          ? 'bg-blue-500'
          : status === 'done'
            ? 'bg-muted-foreground/50'
            : 'bg-emerald-500'
  return <span className={`size-2 shrink-0 rounded-full ${tone}`} />
}

function LanPairingGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [state, setState] = React.useState<'pairing' | 'ready' | 'expired' | 'error'>('pairing')
  const [message, setMessage] = React.useState('')

  React.useEffect(() => {
    const secret = location.hash.slice(1)
    const pair = secret
      ? request<{ ok: true }>('/api/pair', {
          method: 'POST',
          body: JSON.stringify({ secret })
        }).then(() => history.replaceState(null, '', `${location.pathname}${location.search}`))
      : request<Task[]>('/api/tasks')
    void pair
      .then(() => setState('ready'))
      .catch((error) => {
        const text = error instanceof Error ? error.message : 'Pairing failed.'
        setMessage(text)
        setState(text.includes('Pairing expired') ? 'expired' : 'error')
      })
  }, [])

  if (state === 'ready') return <>{children}</>
  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-6 text-foreground">
      <div className="w-full max-w-sm space-y-4 rounded-xl border bg-card p-5 text-center">
        {state === 'pairing' ? (
          <LoaderCircleIcon className="mx-auto size-8 animate-spin text-muted-foreground" />
        ) : (
          <WifiOffIcon className="mx-auto size-8 text-muted-foreground" />
        )}
        <div>
          <h1 className="text-base font-semibold">
            {state === 'pairing' ? 'Connecting to SWE Factory' : 'Scan the QR code again'}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {state === 'pairing'
              ? 'Establishing a temporary local-network session.'
              : message || 'This pairing is no longer valid.'}
          </p>
        </div>
      </div>
    </main>
  )
}

function RemoteGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [mode, setMode] = React.useState<RemoteMode>('detecting')
  React.useEffect(() => {
    void detectRemoteMode().then(setMode)
  }, [])
  if (mode === 'detecting') {
    return (
      <main className="flex min-h-svh items-center justify-center bg-background">
        <LoaderCircleIcon className="size-8 animate-spin text-muted-foreground" />
      </main>
    )
  }
  return mode === 'cloud' ? (
    <CloudGate>{children}</CloudGate>
  ) : (
    <LanPairingGate>{children}</LanPairingGate>
  )
}

function DashboardSession({
  session,
  tasks,
  onOpenSession
}: {
  session: TerminalSession
  tasks: Task[]
  onOpenSession: (id: string, requestId?: string) => void
}): React.JSX.Element {
  const { snapshots, errors } = useRemoteNativeSessions()
  const snapshot =
    snapshots[session.id]?.session.generation === session.generation
      ? snapshots[session.id]
      : undefined
  const needsAction = nativeSessionNeedsUserAction(session, snapshot)
  const status = nativeSessionPresentationStatus(session, snapshot)
  const presentation = sessionCardPresentation(session, tasks)
  const connectionError = errors[nativeKey(session, 'connection')]
  return (
    <article className={needsAction ? 'bg-amber-500/[0.035]' : undefined}>
      <button
        type="button"
        onClick={() => onOpenSession(session.id)}
        className="remote-touch flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <StatusDot status={status} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{presentation.title}</span>
          {needsAction ? (
            <span className="block truncate text-xs text-foreground">
              {snapshot?.interactions[0]?.message ??
                (snapshot?.planTransitionAvailable
                  ? 'Plan complete. Choose the next step.'
                  : presentation.detail)}
            </span>
          ) : presentation.detail ? (
            <span className="block truncate text-xs text-muted-foreground">
              {presentation.detail}
            </span>
          ) : null}
        </span>
      </button>
      {session.transport !== 'external' && snapshot && needsAction ? (
        <div className="space-y-3 border-t px-4 py-3">
          {snapshot.interactions[0] ? (
            <RemoteSessionInteraction
              session={session}
              interaction={snapshot.interactions[0]}
              compact
              onOpenSession={(requestId) => onOpenSession(session.id, requestId)}
            />
          ) : null}
          {snapshot.interactions.length > 1 ? (
            <button
              type="button"
              onClick={() => onOpenSession(session.id, snapshot.interactions[1]?.id)}
              className="remote-touch rounded-md px-3 text-sm font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              View {snapshot.interactions.length - 1} more request
              {snapshot.interactions.length === 2 ? '' : 's'}
            </button>
          ) : null}
          <RemotePlanCompletion
            session={session}
            compact
            onOpenSession={(requestId) => onOpenSession(session.id, requestId)}
          />
        </div>
      ) : null}
      {session.transport === 'external' && needsAction ? (
        <p className="border-t px-4 py-3 text-xs text-muted-foreground">
          Continue this request in the external Copilot terminal on the host.
        </p>
      ) : null}
      {connectionError ? (
        <p role="alert" className="border-t px-4 py-3 text-sm text-destructive">
          {connectionError}
        </p>
      ) : null}
    </article>
  )
}

function Dashboard({
  tasks,
  sessions,
  onOpenSession,
  onOpenTasks
}: {
  tasks: Task[]
  sessions: TerminalSession[]
  onOpenSession: (id: string, requestId?: string) => void
  onOpenTasks: () => void
}): React.JSX.Element {
  const { snapshots } = useRemoteNativeSessions()
  const active = sessions.filter((session) => !isTerminalSessionFinished(session.status))
  const attention = active.filter((session) =>
    nativeSessionNeedsUserAction(session, snapshots[session.id])
  )
  const queued = tasks.filter((task) => task.queueStatus === 'queued')
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 sm:p-6">
      <section>
        <h2 className="text-base font-semibold">Activity</h2>
        <p className="text-sm text-muted-foreground">Live work from the SWE Factory host.</p>
      </section>
      <section className="overflow-hidden rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold">Active sessions</h3>
            <p className="text-xs text-muted-foreground">
              {active.length} running · {attention.length} need attention
            </p>
          </div>
          <BotIcon className="size-4 text-muted-foreground" />
        </div>
        {active.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No Copilot sessions are running.</p>
        ) : (
          <div className="divide-y">
            {active.map((session) => (
              <DashboardSession
                key={session.id}
                session={session}
                tasks={tasks}
                onOpenSession={onOpenSession}
              />
            ))}
          </div>
        )}
      </section>
      <button
        type="button"
        onClick={onOpenTasks}
        className="remote-touch flex items-center justify-between rounded-lg border bg-card px-4 py-3 text-left hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <span>
          <span className="block text-sm font-semibold">Task queue</span>
          <span className="block text-xs text-muted-foreground">
            {tasks.length} tasks · {queued.length} queued
          </span>
        </span>
        <KanbanSquareIcon className="size-4 text-muted-foreground" />
      </button>
    </div>
  )
}

function Tasks({
  tasks,
  refresh
}: {
  tasks: Task[]
  refresh: () => Promise<void>
}): React.JSX.Element {
  const [status, setStatus] = React.useState<TaskStatus>('todo')
  const [creating, setCreating] = React.useState(false)
  const [editing, setEditing] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [repositories, setRepositories] = React.useState<Repository[]>([])
  const [repositoryId, setRepositoryId] = React.useState('')
  const [repositoriesLoading, setRepositoriesLoading] = React.useState(false)
  const [repositoryError, setRepositoryError] = React.useState('')
  const [worktrees, setWorktrees] = React.useState<Worktree[]>([])
  const [worktreesLoading, setWorktreesLoading] = React.useState(false)
  const [worktreeError, setWorktreeError] = React.useState('')
  const [worktreeSelection, setWorktreeSelection] = React.useState('')
  const [newWorktreeName, setNewWorktreeName] = React.useState('')
  const [createError, setCreateError] = React.useState('')
  const worktreeRequestRef = React.useRef(0)
  const shown = tasks
    .filter((task) => task.status === status)
    .sort((a, b) => a.sortOrder - b.sortOrder)
  const repository = repositories.find((item) => item.id === repositoryId) ?? null
  const creatingNewWorktree = worktreeSelection === NEW_WORKTREE_VALUE
  const newWorktreeNameError = creatingNewWorktree ? validateWorktreeName(newWorktreeName) : null
  const visibleWorktreeNameError = newWorktreeName ? newWorktreeNameError : null

  const mutate = async (key: string, operation: () => Promise<unknown>): Promise<void> => {
    setBusy(key)
    try {
      await operation()
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  const loadWorktrees = React.useCallback(async (nextRepositoryId: string): Promise<void> => {
    const requestId = ++worktreeRequestRef.current
    setWorktrees([])
    setWorktreeError('')
    if (!nextRepositoryId) return
    setWorktreesLoading(true)
    try {
      const next = await request<Worktree[]>(
        `/api/repositories/${encodeURIComponent(nextRepositoryId)}/worktrees`
      )
      if (requestId === worktreeRequestRef.current) {
        setWorktrees(next.filter((worktree) => !worktree.isMain))
      }
    } catch (error) {
      if (requestId === worktreeRequestRef.current) {
        setWorktreeError(
          error instanceof Error ? error.message : 'Could not load the repository worktrees.'
        )
      }
    } finally {
      if (requestId === worktreeRequestRef.current) setWorktreesLoading(false)
    }
  }, [])

  const openCreate = async (): Promise<void> => {
    setCreating(true)
    setCreateError('')
    setRepositoryError('')
    setNewWorktreeName('')
    setRepositoriesLoading(true)
    try {
      const next = await request<Repository[]>('/api/repositories')
      setRepositories(next)
      const selected = next.some((item) => item.id === repositoryId)
        ? repositoryId
        : (next[0]?.id ?? '')
      setRepositoryId(selected)
      setWorktreeSelection(selected ? MAIN_BRANCH_VALUE : '')
      await loadWorktrees(selected)
    } catch (error) {
      setRepositoryId('')
      setWorktreeSelection('')
      setRepositoryError(
        error instanceof Error ? error.message : 'Could not load configured repositories.'
      )
    } finally {
      setRepositoriesLoading(false)
    }
  }

  const create = async (form: HTMLFormElement): Promise<void> => {
    const data = new FormData(form)
    setCreateError('')
    if (!repository) {
      setCreateError('Select a repository.')
      return
    }
    if (!worktreeSelection) {
      setCreateError('Select where this task will run.')
      return
    }
    if (creatingNewWorktree && newWorktreeNameError) {
      setCreateError(newWorktreeNameError)
      return
    }
    const selectedWorktree = worktrees.find((worktree) => worktree.path === worktreeSelection)
    if (worktreeSelection !== MAIN_BRANCH_VALUE && !creatingNewWorktree && !selectedWorktree) {
      setCreateError('Select an available worktree.')
      return
    }

    setBusy('create')
    try {
      const result = await request<CreateTaskResult>('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          title: String(data.get('title') ?? ''),
          description: String(data.get('description') ?? ''),
          repositoryId: repository.id,
          worktreePath:
            worktreeSelection === MAIN_BRANCH_VALUE || creatingNewWorktree
              ? repository.path
              : selectedWorktree?.path,
          pendingWorktreeName: creatingNewWorktree ? newWorktreeName.trim() : null
        })
      })
      if (!result.ok) {
        setCreateError(result.message ?? 'Could not create the task.')
        return
      }
      await refresh()
      setCreating(false)
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Could not create the task.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 sm:p-6">
      <div className="flex gap-2 overflow-x-auto pb-1">
        {STATUSES.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setStatus(item)}
            className={`remote-touch shrink-0 rounded-md px-3 text-sm font-medium ${
              status === item
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground'
            }`}
          >
            {STATUS_LABEL[item]} {tasks.filter((task) => task.status === item).length}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            if (creating) {
              setCreating(false)
            } else {
              void openCreate()
            }
          }}
          className="remote-touch ml-auto flex shrink-0 items-center gap-2 rounded-md border px-3 text-sm font-medium"
        >
          <PlusIcon className="size-4" /> {creating ? 'Close' : 'Add'}
        </button>
      </div>
      {creating ? (
        <form
          className="space-y-3 rounded-lg border bg-card p-4"
          onSubmit={(event) => {
            event.preventDefault()
            void create(event.currentTarget)
          }}
        >
          <label className="space-y-1.5 text-sm font-medium">
            <span>Title</span>
            <input
              name="title"
              required
              autoFocus
              placeholder="Fix the login bug"
              className="h-11 w-full rounded-md border bg-background px-3"
            />
          </label>
          <label className="space-y-1.5 text-sm font-medium">
            <span>Description</span>
            <textarea
              name="description"
              placeholder="Add more context for this task…"
              className="min-h-24 w-full rounded-md border bg-background p-3"
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1.5 text-sm font-medium">
              <span>Repository</span>
              <select
                value={repositoryId}
                disabled={repositoriesLoading || repositories.length === 0}
                onChange={(event) => {
                  const next = event.target.value
                  setRepositoryId(next)
                  setWorktreeSelection(next ? MAIN_BRANCH_VALUE : '')
                  setNewWorktreeName('')
                  setCreateError('')
                  void loadWorktrees(next)
                }}
                className="remote-touch w-full rounded-md border bg-background px-3 text-sm"
              >
                <option value="">
                  {repositoriesLoading ? 'Loading repositories…' : 'Select a repository'}
                </option>
                {repositories.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1.5 text-sm font-medium">
              <span>Run in</span>
              <select
                value={worktreeSelection}
                disabled={!repository || worktreesLoading || Boolean(worktreeError)}
                onChange={(event) => {
                  setWorktreeSelection(event.target.value)
                  setNewWorktreeName('')
                  setCreateError('')
                }}
                className="remote-touch w-full rounded-md border bg-background px-3 text-sm"
              >
                <option value="">
                  {worktreesLoading ? 'Loading worktrees…' : 'Select a worktree'}
                </option>
                <option value={MAIN_BRANCH_VALUE}>Main branch</option>
                {worktrees.map((worktree) => (
                  <option key={worktree.path} value={worktree.path}>
                    {worktree.branch ?? worktreeLabel(worktree.path)}
                  </option>
                ))}
                <option value={NEW_WORKTREE_VALUE}>+ Create new worktree…</option>
              </select>
            </label>
            {creatingNewWorktree ? (
              <label className="space-y-1.5 text-sm font-medium sm:col-span-2">
                <span>New worktree name</span>
                <input
                  value={newWorktreeName}
                  onChange={(event) => {
                    setNewWorktreeName(event.target.value)
                    setCreateError('')
                  }}
                  placeholder="feature-x"
                  aria-invalid={visibleWorktreeNameError ? true : undefined}
                  className="h-11 w-full rounded-md border bg-background px-3"
                />
                <span
                  className={
                    visibleWorktreeNameError ? 'text-destructive' : 'text-muted-foreground'
                  }
                >
                  {visibleWorktreeNameError ??
                    'The worktree will be created when this task moves to In Progress.'}
                </span>
              </label>
            ) : null}
            {repositories.length === 0 && !repositoriesLoading && !repositoryError ? (
              <p className="text-sm text-muted-foreground sm:col-span-2">
                Add a repository in SWE Factory on your desktop first.
              </p>
            ) : null}
            {repositoryError ? (
              <p role="alert" className="text-sm text-destructive sm:col-span-2">
                {repositoryError}
              </p>
            ) : null}
            {worktreeError ? (
              <p role="alert" className="text-sm text-destructive sm:col-span-2">
                {worktreeError}
              </p>
            ) : null}
            {createError ? (
              <p role="alert" className="text-sm text-destructive sm:col-span-2">
                {createError}
              </p>
            ) : null}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setCreating(false)}
              className="remote-touch flex-1 rounded-md border px-4 text-sm font-medium"
            >
              Cancel
            </button>
            <button
              disabled={
                busy === 'create' ||
                repositoriesLoading ||
                worktreesLoading ||
                !repository ||
                !worktreeSelection
              }
              className="remote-touch flex-[2] rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {busy === 'create' ? 'Creating…' : 'Create task'}
            </button>
          </div>
        </form>
      ) : null}
      <div className="space-y-3">
        {shown.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No tasks in {STATUS_LABEL[status]}.
          </p>
        ) : (
          shown.map((task) => (
            <article key={task.id} className="rounded-lg border bg-card p-4">
              {editing === task.id ? (
                <form
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault()
                    const data = new FormData(event.currentTarget)
                    void mutate(task.id, () =>
                      request(`/api/tasks/${task.id}`, {
                        method: 'PUT',
                        body: JSON.stringify({
                          title: String(data.get('title') ?? ''),
                          description: String(data.get('description') ?? ''),
                          repositoryId: task.repositoryId,
                          repositoryName: task.repositoryName,
                          repositoryPath: task.repositoryPath,
                          worktreePath: task.worktreePath,
                          worktreeBranch: task.worktreeBranch,
                          pendingWorktreeName: task.pendingWorktreeName
                        })
                      })
                    ).then(() => setEditing(null))
                  }}
                >
                  <input
                    name="title"
                    required
                    defaultValue={task.title}
                    className="h-11 w-full rounded-md border bg-background px-3"
                  />
                  <textarea
                    name="description"
                    defaultValue={task.description}
                    className="min-h-24 w-full rounded-md border bg-background p-3"
                  />
                  <div className="flex gap-2">
                    <button className="remote-touch rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground">
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(null)}
                      className="remote-touch rounded-md border px-4 text-sm"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-semibold">{task.title}</h3>
                      {task.description ? (
                        <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                          {task.description}
                        </p>
                      ) : null}
                      <p className="mt-2 truncate font-mono text-xs text-muted-foreground">
                        {task.repositoryName} · {task.worktreePath}
                      </p>
                    </div>
                    <button
                      aria-label={`Edit ${task.title}`}
                      onClick={() => setEditing(task.id)}
                      className="remote-touch flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
                    >
                      <PencilIcon className="size-4" />
                    </button>
                    <button
                      aria-label={`Delete ${task.title}`}
                      disabled={busy === task.id}
                      onClick={() =>
                        void mutate(task.id, () =>
                          request(`/api/tasks/${task.id}`, { method: 'DELETE' })
                        )
                      }
                      className="remote-touch flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2Icon className="size-4" />
                    </button>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <select
                      aria-label={`Move ${task.title}`}
                      value={task.status}
                      disabled={busy === task.id}
                      onChange={(event) =>
                        void mutate(task.id, () =>
                          request(`/api/tasks/${task.id}/move`, {
                            method: 'POST',
                            body: JSON.stringify({ status: event.target.value })
                          })
                        )
                      }
                      className="remote-touch rounded-md border bg-background px-3 text-sm"
                    >
                      {STATUSES.map((item) => (
                        <option key={item} value={item}>
                          {STATUS_LABEL[item]}
                        </option>
                      ))}
                    </select>
                    {task.status === 'todo' || task.status === 'review' ? (
                      <button
                        disabled={busy === task.id}
                        onClick={() =>
                          void mutate(task.id, () =>
                            request(`/api/tasks/${task.id}/start`, { method: 'POST', body: '{}' })
                          )
                        }
                        className="remote-touch flex items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground"
                      >
                        <PlayIcon className="size-4" /> Start
                      </button>
                    ) : null}
                  </div>
                </>
              )}
            </article>
          ))
        )}
      </div>
    </div>
  )
}

function SessionDetail({
  session,
  selectedRequestId,
  onBack
}: {
  session: TerminalSession
  selectedRequestId: string | null
  onBack: () => void
}): React.JSX.Element {
  const [history, setHistory] = React.useState<TerminalTimelineEntry[]>([])
  const [historyError, setHistoryError] = React.useState('')
  const { snapshots, drafts, setDraft, busy, errors, prompt, cancel, end } =
    useRemoteNativeSessions()
  const snapshot =
    snapshots[session.id]?.session.generation === session.generation
      ? snapshots[session.id]
      : undefined
  const composerKey = nativeKey(session)
  const lifecycleKey = nativeKey(session, 'lifecycle')
  const connectionKey = nativeKey(session, 'connection')
  const message = String(drafts[composerKey]?.message ?? '')

  React.useEffect(() => {
    if (session.transport !== 'external') return
    const sessionId = session.id
    queueMicrotask(() => {
      void request<TerminalTimelineEntry[]>(
        `/api/sessions/${encodeURIComponent(sessionId)}/history`
      )
        .then((entries) => {
          setHistory(entries)
          setHistoryError('')
        })
        .catch((error) =>
          setHistoryError(error instanceof Error ? error.message : 'Could not load session.')
        )
    })
  }, [session.id, session.transport])

  React.useEffect(() => {
    if (
      !selectedRequestId ||
      !snapshot?.interactions.some((item) => item.id === selectedRequestId)
    ) {
      return
    }
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(`native-request-${selectedRequestId}`)
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      target?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [selectedRequestId, snapshot])

  const entries = snapshot?.entries ?? history
  const status = nativeSessionPresentationStatus(session, snapshot)
  const error = historyError || errors[connectionKey]
  const hasPendingAction =
    Boolean(snapshot?.interactions.length) || Boolean(snapshot?.planTransitionAvailable)
  const timelineContext = {
    sessionFinished: isTerminalSessionFinished(session.status),
    hasLiveInteraction: Boolean(snapshot?.interactions.length)
  }
  const visibleEntryCount = entries.reduce(
    (count, entry) =>
      remoteTimelinePresentation(entry, timelineContext).display === 'omit' ? count : count + 1,
    0
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b px-3 py-2">
        <button
          onClick={onBack}
          className="remote-touch flex size-11 items-center justify-center rounded-md hover:bg-accent"
          aria-label="Back to sessions"
        >
          <ArrowLeftIcon className="size-5" />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{session.label}</h2>
          <p className="truncate text-xs text-muted-foreground">
            {session.repository || session.folderPath}
          </p>
        </div>
        <StatusDot status={status} />
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 sm:p-4">
        {error ? (
          <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {entries.map((entry) => (
          <RemoteTimelineEntry
            key={`${entry.kind}-${entry.seq}`}
            entry={entry}
            context={timelineContext}
          />
        ))}
        {entries.length > 0 && visibleEntryCount === 0 && session.status === 'working' ? (
          <p role="status" className="text-sm text-muted-foreground">
            Copilot is working…
          </p>
        ) : null}
        {snapshot?.interactions.map((interaction) => (
          <div
            key={interaction.id}
            className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4"
          >
            <RemoteSessionInteraction
              session={session}
              interaction={interaction}
              onOpenSession={() => undefined}
            />
          </div>
        ))}
        <RemotePlanCompletion session={session} onOpenSession={() => undefined} />
        {!snapshot && session.transport !== 'external' && !error ? (
          <p role="status" className="text-sm text-muted-foreground">
            Synchronizing session controls...
          </p>
        ) : null}
      </div>
      {session.transport !== 'external' &&
      session.generation &&
      !isTerminalSessionFinished(session.status) &&
      !hasPendingAction ? (
        <div className="remote-safe-bottom space-y-2 border-t bg-background p-3">
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (message.trim()) void prompt(session, message)
            }}
          >
            <textarea
              value={message}
              onChange={(event) => setDraft(composerKey, { message: event.target.value })}
              placeholder="Message Copilot"
              className="min-h-11 flex-1 resize-none rounded-md border bg-background px-3 py-2"
            />
            <button
              disabled={busy[composerKey] || !message.trim()}
              className="remote-touch flex size-11 items-center justify-center rounded-md bg-primary text-primary-foreground disabled:opacity-50"
              aria-label="Send"
            >
              <SendIcon className="size-4" />
            </button>
          </form>
          {errors[composerKey] ? (
            <p role="alert" className="text-sm text-destructive">
              {errors[composerKey]}
            </p>
          ) : null}
          <div className="flex gap-2">
            <button
              disabled={busy[lifecycleKey]}
              onClick={() => void cancel(session)}
              className="remote-touch flex items-center gap-2 rounded-md border px-3 text-sm disabled:opacity-50"
            >
              <SquareIcon className="size-3.5" /> Stop turn
            </button>
            <button
              disabled={busy[lifecycleKey]}
              onClick={() => void end(session)}
              className="remote-touch rounded-md px-3 text-sm text-muted-foreground disabled:opacity-50"
            >
              End session
            </button>
          </div>
          {errors[lifecycleKey] ? (
            <p role="alert" className="text-sm text-destructive">
              {errors[lifecycleKey]}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function Sessions({
  tasks,
  sessions,
  selectedId,
  selectedRequestId,
  select
}: {
  tasks: Task[]
  sessions: TerminalSession[]
  selectedId: string | null
  selectedRequestId: string | null
  select: (id: string | null, requestId?: string) => void
}): React.JSX.Element {
  const { snapshots } = useRemoteNativeSessions()
  const activeSessions = sessions.filter((session) => !isTerminalSessionFinished(session.status))
  const selected = activeSessions.find((session) => session.id === selectedId)
  if (selected)
    return (
      <SessionDetail
        session={selected}
        selectedRequestId={selectedRequestId}
        onBack={() => select(null)}
      />
    )
  return (
    <div className="mx-auto w-full max-w-4xl p-4 sm:p-6">
      {activeSessions.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <SquareTerminalIcon className="mx-auto size-8 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium">No Copilot sessions are running</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          {activeSessions.map((session) => {
            const presentation = sessionCardPresentation(session, tasks)
            const snapshot =
              snapshots[session.id]?.session.generation === session.generation
                ? snapshots[session.id]
                : undefined
            const status = nativeSessionPresentationStatus(session, snapshot)
            const detail =
              snapshot?.interactions[0]?.message ??
              (snapshot?.planTransitionAvailable
                ? 'Plan complete. Choose the next step.'
                : presentation.detail)
            return (
              <button
                key={session.id}
                onClick={() => select(session.id)}
                className="remote-touch flex w-full items-center gap-3 border-b px-4 py-3 text-left last:border-b-0 hover:bg-accent"
              >
                <StatusDot status={status} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{presentation.title}</span>
                  {detail ? (
                    <span className="block truncate text-xs text-muted-foreground">{detail}</span>
                  ) : null}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function AppContent(): React.JSX.Element {
  const [view, setView] = React.useState<View>('dashboard')
  const [tasks, setTasks] = React.useState<Task[]>([])
  const [sessions, setSessions] = React.useState<TerminalSession[]>([])
  const [selectedSession, setSelectedSession] = React.useState<string | null>(null)
  const [selectedRequest, setSelectedRequest] = React.useState<string | null>(null)
  const [connected, setConnected] = React.useState(false)
  const [error, setError] = React.useState('')

  const refresh = React.useCallback(async (): Promise<void> => {
    const [nextTasks, nextSessions] = await Promise.all([
      request<Task[]>('/api/tasks'),
      request<TerminalSession[]>('/api/sessions')
    ])
    setTasks(nextTasks)
    setSessions(nextSessions)
  }, [])

  React.useEffect(() => {
    queueMicrotask(() => {
      void refresh().catch((loadError) =>
        setError(loadError instanceof Error ? loadError.message : 'Could not load SWE Factory.')
      )
    })
    const unsubscribe = subscribeRemoteSnapshots((snapshot) => {
      setConnected(true)
      setError('')
      setTasks(snapshot.tasks)
      setSessions(snapshot.sessions)
    })
    return unsubscribe
  }, [refresh])

  const openSession = (id: string, requestId?: string): void => {
    setSelectedSession(id)
    setSelectedRequest(requestId ?? null)
    setView('sessions')
  }

  const nav: { view: View; label: string; Icon: typeof GaugeIcon }[] = [
    { view: 'dashboard', label: 'Dashboard', Icon: GaugeIcon },
    { view: 'tasks', label: 'Tasks', Icon: KanbanSquareIcon },
    { view: 'sessions', label: 'Sessions', Icon: SquareTerminalIcon }
  ]

  return (
    <RemoteNativeSessionsProvider sessions={sessions}>
      <div className="flex h-svh flex-col bg-background text-foreground">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-sm font-semibold">SWE Factory</h1>
            <p className="text-xs text-muted-foreground">
              {nav.find((item) => item.view === view)?.label}
            </p>
          </div>
          <span
            className={`flex items-center gap-2 text-xs ${connected ? 'text-muted-foreground' : 'text-destructive'}`}
          >
            {connected ? (
              <span className="size-2 rounded-full bg-emerald-500" />
            ) : (
              <CircleAlertIcon className="size-3.5" />
            )}
            {connected ? 'Live' : 'Reconnecting'}
          </span>
          <CloudHostSelect />
          <button
            onClick={() => void refresh()}
            aria-label="Refresh"
            className="remote-touch flex size-11 items-center justify-center rounded-md hover:bg-accent"
          >
            <RefreshCwIcon className="size-4" />
          </button>
        </header>
        {error ? (
          <p className="border-b bg-destructive/5 px-4 py-2 text-sm text-destructive">{error}</p>
        ) : null}
        <main className="min-h-0 flex-1 overflow-y-auto">
          {view === 'dashboard' ? (
            <Dashboard
              tasks={tasks}
              sessions={sessions}
              onOpenSession={openSession}
              onOpenTasks={() => setView('tasks')}
            />
          ) : view === 'tasks' ? (
            <Tasks tasks={tasks} refresh={refresh} />
          ) : (
            <Sessions
              tasks={tasks}
              sessions={sessions}
              selectedId={selectedSession}
              selectedRequestId={selectedRequest}
              select={(id, requestId) => {
                setSelectedSession(id)
                setSelectedRequest(requestId ?? null)
              }}
            />
          )}
        </main>
        {!selectedSession || view !== 'sessions' ? (
          <nav
            className="remote-safe-bottom grid shrink-0 grid-cols-3 border-t bg-background px-2 pt-2"
            aria-label="Primary"
          >
            {nav.map(({ view: item, label, Icon }) => (
              <button
                key={item}
                onClick={() => setView(item)}
                className={`remote-touch flex flex-col items-center justify-center gap-1 rounded-md text-xs font-medium ${view === item ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'}`}
              >
                <Icon className="size-5" /> {label}
              </button>
            ))}
          </nav>
        ) : null}
      </div>
    </RemoteNativeSessionsProvider>
  )
}

export function RemoteApp(): React.JSX.Element {
  return (
    <RemoteGate>
      <AppContent />
    </RemoteGate>
  )
}
