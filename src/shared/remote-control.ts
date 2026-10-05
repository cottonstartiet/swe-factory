export const REMOTE_PROTOCOL_VERSION = '1' as const

export type RemoteCommandType =
  | 'snapshot.get'
  | 'repositories.list'
  | 'worktrees.list'
  | 'tasks.create'
  | 'tasks.update'
  | 'tasks.move'
  | 'tasks.delete'
  | 'tasks.start'
  | 'sessions.history'
  | 'sessions.snapshot'
  | 'sessions.respond'
  | 'sessions.prompt'
  | 'sessions.plan'
  | 'sessions.plan.reopen'
  | 'sessions.cancel'
  | 'sessions.end'

export type RemoteEventType =
  | 'snapshot'
  | 'tasks.changed'
  | 'sessions.changed'
  | 'sessions.native'
  | 'host.error'

export type RemoteCommand<T = unknown> = {
  id: string
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION
  type: RemoteCommandType
  expectedRevision?: number | null
  payload: T
}

export type RemoteCommandResult<T = unknown> = {
  id: string
  ok: boolean
  errorCode?: string | null
  errorMessage?: string | null
  revision?: number | null
  payload?: T | null
}

export type RemoteEvent<T = unknown> = {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION
  type: RemoteEventType
  sequence: number
  revision?: number | null
  payload: T
}

export type RemoteHost = {
  id: string
  name: string
  protocolVersion: string
  linkedAt: string
  online: boolean
}

export type RemoteControlStatus = {
  linked: boolean
  connection:
    | 'unlinked'
    | 'linking'
    | 'confirming'
    | 'offline'
    | 'connecting'
    | 'online'
    | 'reconnecting'
    | 'revoked'
    | 'error'
  serverUrl: string | null
  hostId: string | null
  hostName: string | null
  ownerDisplayName: string | null
  linkUrl: string | null
  linkExpiresAt: string | null
  error: string | null
}
