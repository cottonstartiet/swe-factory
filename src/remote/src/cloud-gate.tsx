import * as React from 'react'
import { LaptopIcon, LoaderCircleIcon, LogInIcon, RadioTowerIcon } from 'lucide-react'

import type { RemoteHost } from '@shared/remote-control'
import {
  CloudRemoteTransport,
  cloudAuthSession,
  cloudConfirmLink,
  cloudHosts,
  cloudLinkChallenge,
  cloudLogin,
  setCloudTransport,
  type CloudAuthSession,
  type CloudLinkChallenge
} from './remote-api'

type CloudHostContextValue = {
  hosts: RemoteHost[]
  selected: RemoteHost
  select: (host: RemoteHost) => void
}

const CloudHostContext = React.createContext<CloudHostContextValue | null>(null)

export function CloudHostSelect(): React.JSX.Element | null {
  const value = React.useContext(CloudHostContext)
  if (!value || value.hosts.length < 2) return null
  return (
    <select
      aria-label="Selected SWE Factory host"
      value={value.selected.id}
      onChange={(event) => {
        const host = value.hosts.find((candidate) => candidate.id === event.target.value)
        if (host) value.select(host)
      }}
      className="remote-touch max-w-44 rounded-md border bg-background px-2 text-xs font-medium"
    >
      {value.hosts.map((host) => (
        <option key={host.id} value={host.id}>
          {host.name} {host.online ? '' : '(offline)'}
        </option>
      ))}
    </select>
  )
}

function Shell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-6 text-foreground">
      <div className="w-full max-w-sm space-y-4 rounded-xl border bg-card p-5">{children}</div>
    </main>
  )
}

function Login({
  onAuthenticated
}: {
  onAuthenticated: (session: Extract<CloudAuthSession, { authenticated: true }>) => void
}): React.JSX.Element {
  const [userName, setUserName] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [error, setError] = React.useState('')
  const [pending, setPending] = React.useState(false)

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    setPending(true)
    setError('')
    try {
      const session = await cloudLogin(userName, password)
      if (!session.authenticated) throw new Error('Login did not create a session.')
      onAuthenticated(session)
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : 'Login failed.')
    } finally {
      setPending(false)
    }
  }

  return (
    <Shell>
      <div>
        <h1 className="text-base font-semibold">Sign in to SWE Factory Remote</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Demo authentication is enabled for this deployment.
        </p>
      </div>
      <form className="space-y-3" onSubmit={(event) => void submit(event)}>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Username</span>
          <input
            className="remote-touch w-full rounded-md border bg-background px-3 text-sm"
            autoComplete="username"
            value={userName}
            onChange={(event) => setUserName(event.target.value)}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Password</span>
          <input
            className="remote-touch w-full rounded-md border bg-background px-3 text-sm"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <button
          type="submit"
          disabled={pending || !userName || !password}
          className="remote-touch flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {pending ? <LoaderCircleIcon className="size-4 animate-spin" /> : <LogInIcon className="size-4" />}
          Sign in
        </button>
      </form>
    </Shell>
  )
}

function LinkConfirmation({
  session,
  code,
  onDone
}: {
  session: Extract<CloudAuthSession, { authenticated: true }>
  code: string
  onDone: () => void
}): React.JSX.Element {
  const [challenge, setChallenge] = React.useState<CloudLinkChallenge | null>(null)
  const [error, setError] = React.useState('')
  const [pending, setPending] = React.useState(false)

  React.useEffect(() => {
    void cloudLinkChallenge(code).then(setChallenge).catch((value) => {
      setError(value instanceof Error ? value.message : 'This link is invalid or expired.')
    })
  }, [code])

  const confirm = async (): Promise<void> => {
    setPending(true)
    setError('')
    try {
      await cloudConfirmLink(code, session.csrfToken)
      history.replaceState(null, '', '/')
      onDone()
    } catch (confirmError) {
      setError(confirmError instanceof Error ? confirmError.message : 'Could not link this host.')
    } finally {
      setPending(false)
    }
  }

  return (
    <Shell>
      <div className="flex items-start gap-3">
        <LaptopIcon className="mt-0.5 size-5 shrink-0" />
        <div>
          <h1 className="text-base font-semibold">Link this SWE Factory host?</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {challenge
              ? `${challenge.hostName} will be controlled by ${session.user.displayName}.`
              : 'Loading the link request.'}
          </p>
        </div>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <button
        type="button"
        disabled={!challenge || pending || challenge.confirmed}
        onClick={() => void confirm()}
        className="remote-touch flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {pending ? <LoaderCircleIcon className="size-4 animate-spin" /> : <RadioTowerIcon className="size-4" />}
        Confirm link
      </button>
    </Shell>
  )
}

function HostPicker({
  hosts,
  onSelect
}: {
  hosts: RemoteHost[]
  onSelect: (host: RemoteHost) => void
}): React.JSX.Element {
  return (
    <Shell>
      <div>
        <h1 className="text-base font-semibold">Choose a SWE Factory host</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Only online hosts can stream and control local sessions.
        </p>
      </div>
      {hosts.length === 0 ? (
        <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          No laptops are linked. Open Remote Control in the SWE Factory desktop app to link one.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          {hosts.map((host) => (
            <button
              key={host.id}
              type="button"
              onClick={() => onSelect(host)}
              className="remote-touch flex w-full items-center gap-3 border-b px-3 py-3 text-left last:border-b-0 hover:bg-accent"
            >
              <span className={`size-2.5 rounded-full ${host.online ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{host.name}</span>
                <span className="block text-xs text-muted-foreground">{host.online ? 'Online' : 'Offline'}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </Shell>
  )
}

export function CloudGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [session, setSession] = React.useState<CloudAuthSession | null>(null)
  const [hosts, setHosts] = React.useState<RemoteHost[] | null>(null)
  const [selected, setSelected] = React.useState<RemoteHost | null>(null)
  const [ready, setReady] = React.useState(false)
  const [error, setError] = React.useState('')
  const code = new URLSearchParams(location.search).get('code')

  const loadHosts = React.useCallback(async (): Promise<void> => {
    const values = await cloudHosts()
    setHosts(values)
    const remembered = sessionStorage.getItem('swe-factory-host')
    const preferred = values.find((host) => host.id === remembered)
    if (preferred) setSelected(preferred)
    else if (values.length === 1) setSelected(values[0]!)
  }, [])

  React.useEffect(() => {
    void cloudAuthSession().then(setSession).catch((value) => {
      setError(value instanceof Error ? value.message : 'Could not load the remote session.')
    })
  }, [])

  React.useEffect(() => {
    if (!session?.authenticated || code) return
    void loadHosts().catch((value) => {
      setError(value instanceof Error ? value.message : 'Could not load linked hosts.')
    })
  }, [code, loadHosts, session])

  React.useEffect(() => {
    if (!selected) return
    let active = true
    const transport = new CloudRemoteTransport(selected, (state) => {
      if (active) setReady(state === 'connected')
    })
    setCloudTransport(transport)
    sessionStorage.setItem('swe-factory-host', selected.id)
    setReady(false)
    void transport
      .start()
      .catch((value) => {
        if (active) {
          setError(value instanceof Error ? value.message : 'Could not connect to the selected host.')
        }
      })
    return () => {
      active = false
      setReady(false)
      setCloudTransport(null)
      void transport.stop()
    }
  }, [selected])

  if (error) {
    return (
      <Shell>
        <h1 className="text-base font-semibold">Remote control is unavailable</h1>
        <p className="text-sm text-destructive">{error}</p>
      </Shell>
    )
  }
  if (!session) {
    return (
      <Shell>
        <LoaderCircleIcon className="mx-auto size-8 animate-spin text-muted-foreground" />
      </Shell>
    )
  }
  if (!session.authenticated) return <Login onAuthenticated={setSession} />
  if (code) return <LinkConfirmation session={session} code={code} onDone={() => void loadHosts()} />
  if (!hosts) {
    return (
      <Shell>
        <LoaderCircleIcon className="mx-auto size-8 animate-spin text-muted-foreground" />
      </Shell>
    )
  }
  if (!selected) return <HostPicker hosts={hosts} onSelect={setSelected} />
  if (!ready) {
    return (
      <Shell>
        <LoaderCircleIcon className="mx-auto size-8 animate-spin text-muted-foreground" />
        <p className="text-center text-sm text-muted-foreground">Connecting to {selected.name}</p>
      </Shell>
    )
  }
  return (
    <CloudHostContext.Provider value={{ hosts, selected, select: setSelected }}>
      {children}
    </CloudHostContext.Provider>
  )
}
