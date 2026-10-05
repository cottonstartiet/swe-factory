import * as React from 'react'
import {
  CoffeeIcon,
  FolderGit2Icon,
  GaugeIcon,
  GitPullRequestIcon,
  HistoryIcon,
  KanbanSquareIcon,
  LineChartIcon,
  RadioTowerIcon,
  SettingsIcon,
  SquareTerminalIcon
} from 'lucide-react'
import { toast } from 'sonner'

import type { AppView } from '@/components/app-sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTerminalSessions } from '@/contexts/terminal-sessions-context'
import { LocalWebDialog } from '@/components/local-web-dialog'
import { RemoteControlDialog } from '@/components/remote-control-dialog'
import { cn } from '@/lib/utils'
import { isTerminalSessionFinished } from '@shared/terminal-session'
import { nativeSessionNeedsUserAction } from '@shared/native-session'

const TOP_ITEMS: ReadonlyArray<{
  view: AppView
  label: string
  Icon: typeof GaugeIcon
}> = [
  { view: 'dashboard', label: 'Dashboard', Icon: GaugeIcon },
  { view: 'tasks', label: 'Tasks', Icon: KanbanSquareIcon },
  { view: 'repositories', label: 'Repos', Icon: FolderGit2Icon },
  { view: 'reviews', label: 'Reviews', Icon: GitPullRequestIcon },
  { view: 'sessions', label: 'Sessions', Icon: SquareTerminalIcon },
  { view: 'history', label: 'History', Icon: HistoryIcon },
  { view: 'analytics', label: 'Analytics', Icon: LineChartIcon }
]

function RailButton({
  view,
  label,
  Icon,
  activeView,
  onSelect,
  indicatorLabel
}: {
  view: AppView
  label: string
  Icon: typeof GaugeIcon
  activeView: AppView
  onSelect: (view: AppView) => void
  indicatorLabel?: string
}): React.JSX.Element {
  const active = view === activeView
  const accessibleLabel = indicatorLabel ? `${label}, ${indicatorLabel}` : label
  return (
    <button
      type="button"
      aria-label={accessibleLabel}
      aria-current={active ? 'page' : undefined}
      onClick={() => onSelect(view)}
      className={cn(
        'relative flex w-14 flex-col items-center gap-0.5 rounded-md py-1.5 text-sidebar-foreground/65 transition-colors',
        'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        'focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-sidebar-ring/50',
        active && 'bg-sidebar-accent text-sidebar-accent-foreground'
      )}
    >
      {active ? (
        <span className="bg-sidebar-foreground absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r" />
      ) : null}
      <span className="relative">
        <Icon className="size-5" />
        {indicatorLabel ? (
          <span
            aria-hidden="true"
            data-status-indicator
            className="ring-sidebar absolute -top-1 -right-1 size-2.5 rounded-full bg-amber-500 ring-2"
          />
        ) : null}
      </span>
      <span className="max-w-full truncate text-[10px] leading-none font-medium">{label}</span>
    </button>
  )
}

function KeepAwakeButton({
  enabled,
  pending,
  onToggle
}: {
  enabled: boolean
  pending: boolean
  onToggle: () => void
}): React.JSX.Element {
  const tooltip = pending
    ? 'Checking automatic sleep state'
    : enabled
      ? 'Automatic sleep is blocked until turned off or SWE Factory exits'
      : 'Prevent automatic sleep while SWE Factory is open'

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex w-14">
          <button
            type="button"
            aria-label={`Prevent automatic computer sleep: ${enabled ? 'on' : 'off'}`}
            aria-pressed={enabled}
            aria-busy={pending}
            disabled={pending}
            onClick={onToggle}
            className={cn(
              'flex w-14 flex-col items-center gap-0.5 rounded-md py-1.5 text-sidebar-foreground/65 transition-colors',
              'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
              'focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-sidebar-ring/50',
              'disabled:pointer-events-none disabled:opacity-50',
              enabled && 'bg-sidebar-accent text-sidebar-accent-foreground'
            )}
          >
            <CoffeeIcon className="size-5" />
            <span className="max-w-full truncate text-[10px] leading-none font-medium">Awake</span>
          </button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

export function ActivityRail({
  activeView,
  onSelect
}: {
  activeView: AppView
  onSelect: (view: AppView) => void
}): React.JSX.Element {
  const { sessions, embeddedTerminals, nativeById } = useTerminalSessions()
  const [keepAwakeEnabled, setKeepAwakeEnabled] = React.useState(false)
  const [keepAwakePending, setKeepAwakePending] = React.useState(true)
  const [localWebOpen, setLocalWebOpen] = React.useState(false)
  const [remoteControlOpen, setRemoteControlOpen] = React.useState(false)
  const sessionsNeedingAction = React.useMemo(
    () =>
      sessions.filter((session) => {
        if (isTerminalSessionFinished(session.status)) return false
        return nativeSessionNeedsUserAction(session, nativeById[session.id])
      }).length +
      embeddedTerminals.filter((terminal) => terminal.status === 'waiting-input').length,
    [embeddedTerminals, nativeById, sessions]
  )
  const dashboardIndicatorLabel =
    sessionsNeedingAction > 0
      ? `${sessionsNeedingAction} running ${
          sessionsNeedingAction === 1 ? 'session needs' : 'sessions need'
        } your action`
      : undefined
  React.useEffect(() => {
    let cancelled = false

    void window.api.system.getKeepAwake().then((result) => {
      if (cancelled) return
      setKeepAwakeEnabled(result.enabled)
      setKeepAwakePending(false)
      if (!result.ok) toast.error(`Could not read keep-awake state: ${result.error}`)
    })

    return () => {
      cancelled = true
    }
  }, [])

  const handleKeepAwakeToggle = React.useCallback(async (): Promise<void> => {
    if (keepAwakePending) return
    setKeepAwakePending(true)
    const result = await window.api.system.setKeepAwake(!keepAwakeEnabled)
    setKeepAwakeEnabled(result.enabled)
    setKeepAwakePending(false)
    if (!result.ok) toast.error(`Could not change keep-awake state: ${result.error}`)
  }, [keepAwakeEnabled, keepAwakePending])

  return (
    <nav
      aria-label="Primary"
      className="bg-sidebar z-20 flex h-[calc(100svh-1.25rem)] w-16 shrink-0 flex-col items-center border-r border-sidebar-border py-2"
    >
      <div className="flex flex-col gap-1">
        {TOP_ITEMS.map((item) => (
          <RailButton
            key={item.view}
            {...item}
            activeView={activeView}
            onSelect={onSelect}
            indicatorLabel={item.view === 'dashboard' ? dashboardIndicatorLabel : undefined}
          />
        ))}
      </div>
      <div className="mt-auto flex flex-col gap-1">
        <button
          type="button"
          aria-label="Remote control"
          aria-pressed={remoteControlOpen}
          onClick={() => setRemoteControlOpen(true)}
          className={cn(
            'relative flex w-14 flex-col items-center gap-0.5 rounded-md py-1.5 text-sidebar-foreground/65 transition-colors',
            'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
            'focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-sidebar-ring/50',
            remoteControlOpen && 'bg-sidebar-accent text-sidebar-accent-foreground'
          )}
        >
          <span className="relative">
            <RadioTowerIcon className="size-5" />
          </span>
          <span className="max-w-full truncate text-[10px] leading-none font-medium">Remote</span>
        </button>
        <KeepAwakeButton
          enabled={keepAwakeEnabled}
          pending={keepAwakePending}
          onToggle={() => void handleKeepAwakeToggle()}
        />
        <RailButton
          view="settings"
          label="Settings"
          Icon={SettingsIcon}
          activeView={activeView}
          onSelect={onSelect}
        />
      </div>
      <RemoteControlDialog
        open={remoteControlOpen}
        onOpenChange={setRemoteControlOpen}
        onOpenLocalWeb={() => setLocalWebOpen(true)}
      />
      <LocalWebDialog
        open={localWebOpen}
        onOpenChange={setLocalWebOpen}
        onStatusChange={() => undefined}
      />
    </nav>
  )
}
