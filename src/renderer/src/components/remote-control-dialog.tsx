import * as React from 'react'
import {
  ExternalLinkIcon,
  LaptopIcon,
  LinkIcon,
  LoaderCircleIcon,
  RadioTowerIcon,
  UnlinkIcon
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import type { RemoteControlStatus } from '@shared/remote-control'

const EMPTY: RemoteControlStatus = {
  linked: false,
  connection: 'unlinked',
  serverUrl: null,
  hostId: null,
  hostName: null,
  ownerDisplayName: null,
  linkUrl: null,
  linkExpiresAt: null,
  error: null
}

function connectionLabel(status: RemoteControlStatus): string {
  switch (status.connection) {
    case 'online':
      return 'Connected'
    case 'connecting':
      return 'Connecting'
    case 'reconnecting':
      return 'Reconnecting'
    case 'linking':
      return 'Waiting for browser confirmation'
    case 'confirming':
      return 'Waiting for confirmation on this laptop'
    case 'revoked':
      return 'Link revoked'
    case 'error':
      return 'Connection error'
    default:
      return 'Offline'
  }
}

export function RemoteControlDialog({
  open,
  onOpenChange,
  onOpenLocalWeb
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenLocalWeb: () => void
}): React.JSX.Element {
  const [status, setStatus] = React.useState<RemoteControlStatus>(EMPTY)
  const [serverUrl, setServerUrl] = React.useState('')
  const [pending, setPending] = React.useState(false)

  const refresh = React.useCallback(async (): Promise<RemoteControlStatus> => {
    const next = await window.api.remoteControl.status()
    setStatus(next)
    if (next.serverUrl) setServerUrl(next.serverUrl)
    return next
  }, [])

  React.useEffect(() => {
    if (!open) return
    void refresh().catch((error) =>
      toast.error(error instanceof Error ? error.message : 'Could not read remote control status.')
    )
  }, [open, refresh])

  React.useEffect(() => {
    if (!open || status.connection !== 'linking') return
    const timer = window.setInterval(() => {
      void window.api.remoteControl
        .completeLink()
        .then((next) => {
          setStatus(next)
          if (next.connection === 'confirming') {
            toast.success('Browser confirmation received.')
          }
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          if (!message.includes('No remote link is pending')) setStatus((current) => ({ ...current, error: message }))
        })
    }, 2500)
    return () => window.clearInterval(timer)
  }, [open, status.connection])

  const beginLink = async (): Promise<void> => {
    setPending(true)
    try {
      const next = await window.api.remoteControl.beginLink(serverUrl)
      setStatus(next)
      if (next.linkUrl) {
        const opened = await window.api.system.openExternal(next.linkUrl)
        if (!opened.ok) throw new Error(opened.error)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not start remote linking.')
    } finally {
      setPending(false)
    }
  }

  const openRemote = async (): Promise<void> => {
    if (!status.serverUrl) return
    const result = await window.api.system.openExternal(status.serverUrl)
    if (!result.ok) toast.error(result.error)
  }

  const unlink = async (): Promise<void> => {
    setPending(true)
    try {
      setStatus(await window.api.remoteControl.unlink())
      toast.success('Remote control link removed from this host.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not unlink remote control.')
    } finally {
      setPending(false)
    }
  }

  const acceptLink = async (): Promise<void> => {
    setPending(true)
    try {
      const next = await window.api.remoteControl.acceptLink()
      setStatus(next)
      toast.success('This SWE Factory host is linked.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not accept the remote link.')
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Remote control</DialogTitle>
          <DialogDescription>
            Link this laptop to the hosted SWE Factory web app through an outbound encrypted
            connection.
          </DialogDescription>
        </DialogHeader>

        {status.connection === 'confirming' ? (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-lg border bg-muted/35 p-3">
              <LaptopIcon className="mt-0.5 size-4 shrink-0" />
              <div>
                <p className="text-sm font-medium">Confirm the account on this laptop</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Link {status.hostName} to {status.ownerDisplayName}? Only accept if this is the
                  account you signed into in the browser.
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                className="flex-1"
                disabled={pending}
                onClick={() => void acceptLink()}
              >
                {pending ? <LoaderCircleIcon className="animate-spin" /> : <LinkIcon />}
                Accept link
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => void unlink()}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : status.linked ? (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-lg border bg-muted/35 p-3">
              <LaptopIcon className="mt-0.5 size-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{status.hostName}</p>
                <p className="text-xs text-muted-foreground">
                  {status.ownerDisplayName} · {connectionLabel(status)}
                </p>
              </div>
              <span
                aria-label={connectionLabel(status)}
                className={`mt-1 size-2.5 shrink-0 rounded-full ${
                  status.connection === 'online'
                    ? 'bg-emerald-500'
                    : status.connection === 'error' || status.connection === 'revoked'
                      ? 'bg-destructive'
                      : 'bg-amber-500'
                }`}
              />
            </div>
            {status.error ? (
              <p role="alert" className="text-sm text-destructive">
                {status.error}
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button type="button" className="flex-1" onClick={() => void openRemote()}>
                <ExternalLinkIcon />
                Open remote
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => void unlink()}
              >
                {pending ? <LoaderCircleIcon className="animate-spin" /> : <UnlinkIcon />}
                Unlink
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Session content is relayed while this host is online. The current demo server can see
              live payloads in memory but must not persist or log them.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <label className="space-y-2">
              <span className="text-sm font-medium">Remote server URL</span>
              <Input
                type="url"
                value={serverUrl}
                onChange={(event) => setServerUrl(event.target.value)}
                placeholder="https://remote.example.com"
                disabled={status.connection === 'linking'}
              />
            </label>
            {status.connection === 'linking' ? (
              <div className="flex items-start gap-3 rounded-lg border bg-muted/35 p-3">
                <LoaderCircleIcon className="mt-0.5 size-4 shrink-0 animate-spin" />
                <div>
                  <p className="text-sm font-medium">Confirm the link in your browser</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    This dialog will connect automatically after the signed-in account approves
                    {status.hostName ? ` ${status.hostName}` : ' this host'}.
                  </p>
                </div>
              </div>
            ) : (
              <Button
                type="button"
                className="w-full"
                disabled={pending || !serverUrl.trim()}
                onClick={() => void beginLink()}
              >
                {pending ? <LoaderCircleIcon className="animate-spin" /> : <LinkIcon />}
                Link and open browser
              </Button>
            )}
            {status.error ? (
              <p role="alert" className="text-sm text-destructive">
                {status.error}
              </p>
            ) : null}
          </div>
        )}

        <div className="border-t pt-4">
          <Button
            type="button"
            variant="ghost"
            className="w-full justify-start"
            onClick={() => {
              onOpenChange(false)
              onOpenLocalWeb()
            }}
          >
            <RadioTowerIcon />
            Use local-network web UI instead
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
