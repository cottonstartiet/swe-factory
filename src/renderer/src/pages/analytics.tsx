import { useState } from 'react'
import { AlertTriangleIcon, RefreshCwIcon } from 'lucide-react'
import { toast } from 'sonner'

import { FlowPanel } from '@/components/analytics/flow-panel'
import { OverviewPanel } from '@/components/analytics/overview-panel'
import { Findings, PracticesPanel } from '@/components/analytics/practices-panel'
import { Section } from '@/components/analytics/shared'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useCopilotAnalytics } from '@/hooks/use-copilot-analytics'
import { useDailyFindings } from '@/hooks/use-daily-findings'
import { useCopilotLauncher } from '@/lib/copilot-launch'
import { cn } from '@/lib/utils'
import type { Repository } from '@shared/repository'

const COMMANDS = [
  { command: '/chronicle tips', label: 'Usage tips' },
  { command: '/chronicle cost-tips', label: 'Cost tips' },
  { command: '/chronicle standup', label: 'Standup summary' },
  { command: '/usage', label: 'Live session usage' },
  { command: '/context', label: 'Live context breakdown' }
]

export function AnalyticsPage({ repositories }: { repositories: Repository[] }): React.JSX.Element {
  const {
    summary,
    error,
    isLoading,
    windowDays,
    setWindowDays,
    refresh,
    repository,
    setRepository
  } = useCopilotAnalytics()
  const daily = useDailyFindings(summary, windowDays, repository, refresh)
  const launchCopilot = useCopilotLauncher()
  const [commandRepo, setCommandRepo] = useState('')
  const [launching, setLaunching] = useState(false)
  const [view, setView] = useState('overview')
  const target = repositories.find((repo) => repo.id === commandRepo) ?? repositories[0]
  const filterMatches =
    summary?.windowDays === windowDays && (summary.repository ?? '') === repository
  const showLoading = isLoading || (!error && summary !== null && !filterMatches)
  const options = [
    ...new Set([...(summary?.repositories ?? []), ...(repository ? [repository] : [])])
  ]

  const run = async (command: string): Promise<void> => {
    if (!target) {
      toast.error('Add a repository before running a Copilot command.')
      return
    }
    setLaunching(true)
    try {
      const result = await launchCopilot({
        folderPath: target.path,
        prompt: command,
        label: `${command} - ${target.name}`,
        repository: target.name
      })
      if (!result.ok) toast.error(result.error)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not start Copilot.')
    } finally {
      setLaunching(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className="space-y-2 border-b px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={String(windowDays)}
            onValueChange={(value) => setWindowDays(Number(value))}
          >
            <SelectTrigger className="w-28" aria-label="Analytics time range">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[7, 30, 90].map((days) => (
                <SelectItem key={days} value={String(days)}>
                  {days} days
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={repository ? `repo:${repository}` : '__all__'}
            onValueChange={(value) => setRepository(value === '__all__' ? '' : value.slice(5))}
          >
            <SelectTrigger className="w-64 max-w-full" aria-label="Analytics repository">
              <SelectValue placeholder="All repositories" />
            </SelectTrigger>
            <SelectContent className="max-w-[min(90vw,40rem)]">
              <SelectItem value="__all__">All repositories</SelectItem>
              {options.map((name) => (
                <SelectItem key={name} value={`repo:${name}`}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            className="ml-auto"
            variant="outline"
            size="icon"
            disabled={isLoading}
            aria-label="Refresh analytics"
            onClick={() => void refresh()}
          >
            <RefreshCwIcon className={cn(isLoading && 'animate-spin')} />
          </Button>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Copilot CLI / Read-only local analysis. Calendar days use this computer&apos;s timezone.
          {summary && filterMatches && !isLoading
            ? ` ${summary.fromDate} to ${summary.toDate}. Calculated ${new Date(summary.calculatedAt).toLocaleString()}.`
            : ''}
        </p>
      </header>

      <div className="space-y-4 p-4" aria-busy={showLoading}>
        {error ? (
          <div role="alert" className="flex items-start gap-3 rounded-lg border p-4">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
            <div className="min-w-0 space-y-2">
              <p className="text-sm font-medium">Could not calculate analytics</p>
              <p className="break-words text-xs text-muted-foreground">{error}</p>
              <Button size="sm" variant="outline" onClick={() => void refresh()}>
                Try again
              </Button>
            </div>
          </div>
        ) : showLoading ? (
          <div role="status" className="space-y-4">
            <p className="text-xs text-muted-foreground">Reading local Copilot CLI history...</p>
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : summary ? (
          <>
            {summary.coverage.warnings.length ? (
              <Section title="Data availability">
                <ul
                  role="status"
                  className="space-y-1 text-xs leading-relaxed text-muted-foreground"
                >
                  {summary.coverage.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </Section>
            ) : null}
            {summary.totals.sessions === 0 ? (
              <Section title="No activity in this selection">
                <p className="max-w-[80ch] text-sm leading-relaxed text-muted-foreground">
                  Try another repository or date range, or run a Copilot CLI session and refresh.
                  History is read from the local CLI session store. Missing or deleted history
                  cannot be reconstructed.
                </p>
              </Section>
            ) : null}
            <Tabs value={view} onValueChange={setView}>
              <TabsList aria-label="Analytics views">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="flow">Flow</TabsTrigger>
                <TabsTrigger value="practices">Practices</TabsTrigger>
              </TabsList>
              <p className="mb-2 text-xs text-muted-foreground">
                Comparisons use the preceding {summary.windowDays} calendar days. Today is partial;
                increases are not automatically improvements.
              </p>
              <TabsContent value="overview" className="space-y-4">
                <OverviewPanel summary={summary} />
                {daily.findings.length ? (
                  <Section
                    title="Worth a look"
                    description={`Top local coaching observations, recalculated daily${
                      daily.generatedAt
                        ? ` (last updated ${new Date(daily.generatedAt).toLocaleDateString()})`
                        : ''
                    }. Open Practices for explanations and private examples.`}
                  >
                    <Findings findings={daily.findings} />
                  </Section>
                ) : null}
              </TabsContent>
              <TabsContent value="flow">
                <FlowPanel summary={summary} />
              </TabsContent>
              <TabsContent value="practices">
                <PracticesPanel
                  key={`${repository}:${windowDays}:${summary.calculatedAt}`}
                  practices={summary.practices}
                />
              </TabsContent>
            </Tabs>
          </>
        ) : null}

        <Section
          title="Copilot CLI commands"
          description="Explicitly starts a Copilot session in the selected repository. These commands are separate from the local report and may use AI credits."
          actions={
            target ? (
              <Select value={target.id} onValueChange={setCommandRepo}>
                <SelectTrigger className="w-44" aria-label="Command target repository">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {repositories.map((repo) => (
                    <SelectItem key={repo.id} value={repo.id}>
                      {repo.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : undefined
          }
        >
          <div className="flex flex-wrap gap-2">
            {COMMANDS.map((command) => (
              <Button
                key={command.command}
                size="sm"
                variant="outline"
                disabled={!target || launching}
                title={command.command}
                onClick={() => void run(command.command)}
              >
                {command.label}
              </Button>
            ))}
          </div>
          {!target ? (
            <p className="text-xs text-muted-foreground">Add a repository to run CLI commands.</p>
          ) : null}
        </Section>
      </div>
    </div>
  )
}
