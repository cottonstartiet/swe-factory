import {
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel
} from '@microsoft/signalr'

import {
  REMOTE_PROTOCOL_VERSION,
  type RemoteCommand,
  type RemoteCommandResult,
  type RemoteEvent,
  type RemoteHost
} from '@shared/remote-control'
import type { NativeSnapshotUpdate } from '@shared/native-session'
import type { Task } from '@shared/task'
import type { TerminalSession } from '@shared/terminal-session'

export type RemoteSnapshot = { tasks: Task[]; sessions: TerminalSession[] }
export type RemoteMode = 'detecting' | 'lan' | 'cloud'

type SnapshotListener = (snapshot: RemoteSnapshot) => void
type NativeSnapshotListener = (snapshot: NativeSnapshotUpdate) => void
type ResyncListener = () => void
type CloudConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected'

let cloudTransport: CloudRemoteTransport | null = null

function errorFromResponse(body: string, status: number): Error {
  let parsed: { error?: unknown } | null = null
  try {
    parsed = JSON.parse(body) as { error?: unknown }
  } catch {
    parsed = null
  }
  if (typeof parsed?.error === 'string' && parsed.error.trim()) return new Error(parsed.error)
  return new Error(body || `Request failed (${status}).`)
}

async function fetchJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method ?? 'GET'
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
      ...init.headers
    }
  })
  if (!response.ok) throw errorFromResponse(await response.text(), response.status)
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export async function detectRemoteMode(): Promise<RemoteMode> {
  if (location.hash.length > 1 || sessionStorage.getItem('swe-factory-remote-mode') === 'lan') {
    sessionStorage.setItem('swe-factory-remote-mode', 'lan')
    return 'lan'
  }
  try {
    const response = await fetch('/api/auth/session', { headers: { accept: 'application/json' } })
    if (response.headers.get('content-type')?.includes('application/json')) {
      sessionStorage.setItem('swe-factory-remote-mode', 'cloud')
      return 'cloud'
    }
  } catch {
    // The LAN server has no auth endpoint; its fallback may be unavailable during startup.
  }
  sessionStorage.setItem('swe-factory-remote-mode', 'lan')
  return 'lan'
}

export type CloudAuthSession =
  | { authenticated: false }
  | {
      authenticated: true
      user: { subject: string; displayName: string }
      csrfToken: string
    }

export function cloudAuthSession(): Promise<CloudAuthSession> {
  return fetchJson<CloudAuthSession>('/api/auth/session')
}

export function cloudLogin(userName: string, password: string): Promise<CloudAuthSession> {
  return fetchJson('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ userName, password })
  }).then(() => cloudAuthSession())
}

export function cloudHosts(): Promise<RemoteHost[]> {
  return fetchJson('/api/hosts')
}

export type CloudLinkChallenge = {
  hostId: string
  hostName: string
  protocolVersion: string
  expiresAt: string
  confirmed: boolean
  currentSubject: string
}

export function cloudLinkChallenge(code: string): Promise<CloudLinkChallenge> {
  return fetchJson(`/api/link/challenges/${encodeURIComponent(code)}`)
}

export function cloudConfirmLink(code: string, csrfToken: string): Promise<void> {
  return fetchJson(`/api/link/challenges/${encodeURIComponent(code)}/confirm`, {
    method: 'POST',
    headers: { 'x-swe-factory-csrf': csrfToken },
    body: '{}'
  })
}

export class CloudRemoteTransport {
  private readonly listeners = new Set<SnapshotListener>()
  private readonly nativeListeners = new Set<NativeSnapshotListener>()
  private readonly resyncListeners = new Set<ResyncListener>()
  private connection: HubConnection | null = null
  private snapshot: RemoteSnapshot = { tasks: [], sessions: [] }
  private sequence = 0
  private resyncing: Promise<void> | null = null

  constructor(
    readonly host: RemoteHost,
    private readonly onConnectionStateChange: (state: CloudConnectionState) => void = () => undefined
  ) {}

  async start(): Promise<void> {
    if (this.connection?.state === HubConnectionState.Connected) return
    this.onConnectionStateChange('connecting')
    const connection = new HubConnectionBuilder()
      .withUrl('/hubs/remote')
      .withAutomaticReconnect({
        nextRetryDelayInMilliseconds: ({ previousRetryCount }) => {
          const delay = Math.min(1000 * 2 ** Math.min(previousRetryCount, 4), 10000)
          return Math.round(delay * (0.8 + Math.random() * 0.4))
        }
      })
      .configureLogging(LogLevel.Warning)
      .build()
    connection.on('RemoteEvent', (event: RemoteEvent) => {
      if (event.protocolVersion !== REMOTE_PROTOCOL_VERSION) return
      if (event.sequence <= this.sequence) return
      if (this.sequence && event.sequence !== this.sequence + 1) void this.resync()
      this.sequence = event.sequence
      if (event.type === 'snapshot') {
        const snapshot = event.payload as RemoteSnapshot
        this.snapshot = snapshot
        for (const listener of this.listeners) listener(snapshot)
      } else if (event.type === 'sessions.native') {
        const snapshot = event.payload as NativeSnapshotUpdate
        for (const listener of this.nativeListeners) listener(snapshot)
      }
    })
    connection.on('HostPresenceChanged', (online: boolean) => {
      this.host.online = online
      if (online) {
        this.sequence = 0
        void this.resync()
      }
    })
    connection.onreconnecting(() => {
      this.onConnectionStateChange('reconnecting')
    })
    connection.onreconnected(async () => {
      this.sequence = 0
      await connection.invoke('SubscribeHost', this.host.id)
      await this.resync()
      this.onConnectionStateChange('connected')
    })
    connection.onclose(() => {
      this.onConnectionStateChange('disconnected')
    })
    this.connection = connection
    try {
      await connection.start()
      await connection.invoke('SubscribeHost', this.host.id)
      this.onConnectionStateChange('connected')
    } catch (error) {
      this.connection = null
      this.onConnectionStateChange('disconnected')
      throw error
    }
  }

  async stop(): Promise<void> {
    if (!this.connection) return
    if (this.connection.state === HubConnectionState.Connected) {
      await this.connection.invoke('UnsubscribeHost', this.host.id)
    }
    await this.connection.stop()
    this.connection = null
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener)
    if (this.snapshot.tasks.length || this.snapshot.sessions.length) listener(this.snapshot)
    return () => this.listeners.delete(listener)
  }

  subscribeNative(listener: NativeSnapshotListener, onResync?: ResyncListener): () => void {
    this.nativeListeners.add(listener)
    if (onResync) this.resyncListeners.add(onResync)
    return () => {
      this.nativeListeners.delete(listener)
      if (onResync) this.resyncListeners.delete(onResync)
    }
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.connection || this.connection.state !== HubConnectionState.Connected) {
      throw new Error('The selected SWE Factory host is offline.')
    }
    const command = commandForRequest(path, init)
    if (command.type === 'sessions.history') {
      const entries: unknown[] = []
      let cursor: number | null = 0
      while (cursor !== null) {
        const pageCommand = {
          ...command,
          id: crypto.randomUUID(),
          payload: { ...(command.payload as object), cursor, limit: 10 }
        }
        const page = await this.invokeCommand<{
          entries: unknown[]
          nextCursor: number | null
        }>(pageCommand)
        entries.push(...page.entries)
        cursor = page.nextCursor
      }
      return entries as T
    }
    return this.invokeCommand<T>(command)
  }

  private async invokeCommand<T>(command: RemoteCommand): Promise<T> {
    const result = await this.connection!.invoke<RemoteCommandResult<T>>(
      'ExecuteCommand',
      this.host.id,
      command
    )
    if (!result.ok) throw new Error(result.errorMessage || 'The remote command failed.')
    return result.payload as T
  }

  private async resync(): Promise<void> {
    if (!this.connection || this.connection.state !== HubConnectionState.Connected) return
    if (this.resyncing) return this.resyncing
    this.resyncing = this.invokeCommand<RemoteSnapshot>(
      commandForRequest('/api/tasks', { method: 'GET' })
    )
      .then((snapshot) => {
        this.snapshot = snapshot
        for (const listener of this.listeners) listener(snapshot)
        for (const listener of this.resyncListeners) listener()
      })
      .catch((error: unknown) => {
        console.warn('Remote state resynchronization failed.', error)
      })
      .finally(() => {
        this.resyncing = null
      })
    return this.resyncing
  }
}

function parsedBody(init: RequestInit): Record<string, unknown> {
  if (typeof init.body !== 'string' || !init.body) return {}
  return JSON.parse(init.body) as Record<string, unknown>
}

function commandForRequest(path: string, init: RequestInit): RemoteCommand {
  const method = init.method ?? 'GET'
  const body = parsedBody(init)
  const session = path.match(/^\/api\/sessions\/([^/]+)\/(.+)$/)
  const task = path.match(/^\/api\/tasks\/([^/]+)(?:\/(.+))?$/)
  let type: RemoteCommand['type']
  let payload: Record<string, unknown> = body

  if (path === '/api/tasks' && method === 'GET') type = 'snapshot.get'
  else if (path === '/api/sessions' && method === 'GET') type = 'snapshot.get'
  else if (path === '/api/repositories') type = 'repositories.list'
  else if (/^\/api\/repositories\/[^/]+\/worktrees$/.test(path)) {
    type = 'worktrees.list'
    payload = { repositoryId: decodeURIComponent(path.split('/')[3]!) }
  } else if (path === '/api/tasks' && method === 'POST') type = 'tasks.create'
  else if (task) {
    payload = { ...body, taskId: decodeURIComponent(task[1]!) }
    if (method === 'DELETE') type = 'tasks.delete'
    else if (task[2] === 'move') type = 'tasks.move'
    else if (task[2] === 'start') type = 'tasks.start'
    else type = 'tasks.update'
  } else if (session) {
    payload = { ...body, sessionId: decodeURIComponent(session[1]!) }
    const action = session[2]
    if (action === 'history') type = 'sessions.history'
    else if (action === 'snapshot') type = 'sessions.snapshot'
    else if (action === 'respond') type = 'sessions.respond'
    else if (action === 'prompt') type = 'sessions.prompt'
    else if (action === 'plan') type = 'sessions.plan'
    else if (action === 'plan/reopen') type = 'sessions.plan.reopen'
    else if (action === 'cancel') type = 'sessions.cancel'
    else if (action === 'end') type = 'sessions.end'
    else throw new Error(`Unsupported remote session request: ${path}`)
  } else {
    throw new Error(`Unsupported remote request: ${method} ${path}`)
  }

  return {
    id: crypto.randomUUID(),
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    type,
    payload
  }
}

export function setCloudTransport(transport: CloudRemoteTransport | null): void {
  cloudTransport = transport
}

export function subscribeRemoteSnapshots(listener: SnapshotListener): () => void {
  if (cloudTransport) return cloudTransport.subscribe(listener)
  let socket: WebSocket | null = null
  let retry = 0
  let stopped = false
  const connect = (): void => {
    socket = new WebSocket(
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/events`
    )
    socket.onopen = () => {
      retry = 0
    }
    socket.onmessage = (event) => {
      const payload = JSON.parse(String(event.data)) as { type: string } & RemoteSnapshot
      if (payload.type === 'snapshot') listener({ tasks: payload.tasks, sessions: payload.sessions })
    }
    socket.onclose = () => {
      if (!stopped) window.setTimeout(connect, Math.min(1000 * 2 ** retry++, 10000))
    }
  }
  connect()
  return () => {
    stopped = true
    socket?.close()
  }
}

export function subscribeRemoteNativeSnapshots(
  listener: NativeSnapshotListener,
  onResync?: ResyncListener
): (() => void) | null {
  return cloudTransport?.subscribeNative(listener, onResync) ?? null
}

export async function remoteRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (cloudTransport) {
    const value = await cloudTransport.request<unknown>(path, init)
    if (path === '/api/tasks' && (init.method ?? 'GET') === 'GET') {
      return (value as RemoteSnapshot).tasks as T
    }
    if (path === '/api/sessions' && (init.method ?? 'GET') === 'GET') {
      return (value as RemoteSnapshot).sessions as T
    }
    return value as T
  }

  const method = init.method ?? 'GET'
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(method === 'GET' ? {} : { 'content-type': 'application/json', 'x-swe-factory-lan': '1' }),
      ...init.headers
    }
  })
  if (!response.ok) throw errorFromResponse(await response.text(), response.status)
  return response.json() as Promise<T>
}
