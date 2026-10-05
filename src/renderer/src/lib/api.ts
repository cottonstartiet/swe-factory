/**
 * Tauri backend bridge. Reconstructs the `window.api` surface the renderer historically got from the
 * Electron preload, but backed by Tauri commands via `invoke`. Keeping the same `window.api.<domain>`
 * shape means every existing call site keeps working unchanged after the Electron → Tauri migration.
 *
 * Two Tauri specifics are handled here:
 *  - Command arguments are passed as an object keyed by the Rust parameter name. Tauri converts the
 *    camelCase keys used here to the snake_case Rust params automatically.
 *  - `invoke` REJECTS when a Rust command returns `Err`. The commands model expected failures as
 *    resolved `{ ok: false, ... }` values, but unexpected errors (DB/lock/serialization) still reject.
 *    `result()` converts any such rejection into the discriminated-union failure the UI already
 *    handles, so a backend hiccup surfaces as an in-app error instead of an unhandled rejection.
 */
import { invoke } from '@tauri-apps/api/core'
import type { TerminalTarget } from '@shared/terminal-session'
import type { RemoteControlStatus } from '@shared/remote-control'
import type {
  CopilotPermissionProfile,
  CreateSavedPromptRequest,
  SavedPrompt,
  SessionLaunchMode,
  TaskQueueSettings,
  UpdateSavedPromptRequest
} from '@shared/settings'
import type {
  NativeAnswer,
  NativeSnapshot,
  NativeSnapshotUpdate,
  PlanTransitionAction,
  PromptContent
} from '@shared/native-session'
import { listen } from '@tauri-apps/api/event'
import type {
  EmbeddedDirectoryListing,
  EmbeddedTerminal,
  EmbeddedTerminalOutput,
  EmbeddedTerminalReplay,
  EmbeddedTerminalResult,
  EmbeddedTerminalStartRequest,
  EmbeddedTerminalUpdate
} from '@shared/embedded-terminal'

import type { AddRepositoryResult, Repository } from '@shared/repository'
import type {
  CreateWorktreeRequest,
  CreateWorktreeResult,
  DeleteWorktreeRequest,
  DeleteWorktreeResult,
  Worktree,
  WorktreeStatusResult
} from '@shared/worktree'
import type {
  BranchWebUrlRequest,
  BranchWebUrlResult,
  CommitRequest,
  CommitResult,
  CreateBranchRequest,
  CreateBranchResult,
  DetectMergeStateRequest,
  DetectMergeStateResult,
  DiscardAllChangesRequest,
  DiscardAllChangesResult,
  FetchResult,
  FindPullRequestRequest,
  FindPullRequestResult,
  LocalReviewChangedFilesRequest,
  LocalReviewChangedFilesResult,
  LocalReviewFileContentRequest,
  LocalReviewFileContentResult,
  LocalReviewFileDiffRequest,
  LocalReviewFileDiffResult,
  OpenPullRequestRequest,
  OpenPullRequestResult,
  PullResult,
  PushRequest,
  PushResult,
  RebaseOnDefaultRequest,
  RebaseOnDefaultResult,
  RecentCommitsRequest,
  RecentCommitsResult,
  RepoStatus,
  RepoStatusResult,
  RevertFilesRequest,
  RevertFilesResult,
  StageFilesRequest,
  StageFilesResult,
  UnpushedCommitsRequest,
  UnpushedCommitsResult,
  UnstageFilesRequest,
  UnstageFilesResult,
  WorkingCopyStatusRequest,
  WorkingCopyStatusResult
} from '@shared/repo'
import type {
  PrChangedFilesRequest,
  PrChangedFilesResult,
  PrCreateThreadRequest,
  PrFileContentRequest,
  PrFileContentResult,
  PrFileDiffRequest,
  PrFileDiffResult,
  PrMutationResult,
  PrReplyRequest,
  PrReviewDetailRequest,
  PrReviewDetailResult,
  PrSetThreadStatusRequest,
  PrSetVoteRequest
} from '@shared/pr-review'
import type {
  AutoReviewClaimRequest,
  AutoReviewClaimResult,
  RepoOpenPrsRequest,
  RepoOpenPrsResult,
  RepoPrThreadsRequest,
  RepoPrThreadsResult
} from '@shared/reviews'
import type { AppInfo, KeepAwakeResult, LaunchResult } from '@shared/system'
import type { LocalWebStatus } from '@shared/local-web'
import type { CopilotHistoryListResult } from '@shared/copilot-history'
import type { CopilotAnalyticsResult } from '@shared/copilot-analytics'
import {
  TASKS_CHANGED_EVENT,
  type ClaimTaskRunRequest,
  type ClaimTaskRunResult,
  type CreateTaskRequest,
  type CreateTaskResult,
  type DeleteTaskRequest,
  type DeleteTaskResult,
  type DiscardTaskAttachmentStageRequest,
  type MoveTaskRequest,
  type MoveTaskResult,
  type PickTaskAttachmentsRequest,
  type PickTaskAttachmentsResult,
  type SetTaskCopilotSessionRequest,
  type SetTaskQueueStatusRequest,
  type ReleaseTaskRunRequest,
  type Task,
  type UpdateTaskRequest,
  type UpdateTaskResult
} from '@shared/task'
import {
  TERMINAL_SESSIONS_UPDATE_EVENT,
  type StartTerminalSessionRequest,
  type TerminalSession,
  type TerminalSessionResult,
  type TerminalSessionUpdate,
  type TerminalTimelineEntry
} from '@shared/terminal-session'

type Args = Record<string, unknown>

function messageOf(err: unknown): string {
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message
  return 'Unexpected backend error.'
}

/**
 * Invoke a command whose result is a discriminated union, converting an unexpected Rust `Err`
 * (rejected promise) into the union's failure variant via `onError` so callers never see a rejection.
 */
async function result<T>(
  command: string,
  args: Args | undefined,
  onError: (message: string) => T
): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (err) {
    return onError(messageOf(err))
  }
}

/** Failure variants for the PR-review commands, whose results share one shape per provider. */
const adoFail = (message: string): { ok: false; code: 'az-failed'; message: string } => ({
  ok: false,
  code: 'az-failed',
  message
})
const ghFail = (message: string): { ok: false; code: 'gh-failed'; message: string } => ({
  ok: false,
  code: 'gh-failed',
  message
})

const api = {
  repositories: {
    pickAndAdd: (): Promise<AddRepositoryResult> =>
      result('repositories_pick_and_add', undefined, (message) => ({
        ok: false,
        error: 'unknown',
        message
      })),
    list: (): Promise<Repository[]> => invoke('repositories_list'),
    remove: (id: string): Promise<Repository[]> => invoke('repositories_remove', { id }),
    reorder: (orderedIds: string[]): Promise<Repository[]> =>
      invoke('repositories_reorder', { orderedIds })
  },
  worktrees: {
    listForRepository: (repositoryPath: string): Promise<Worktree[]> =>
      invoke('worktrees_list_for_repository', { repositoryPath }),
    create: (req: CreateWorktreeRequest): Promise<CreateWorktreeResult> =>
      result('worktrees_create', { ...req }, (message) => ({
        ok: false,
        error: 'unknown',
        message
      })),
    delete: (req: DeleteWorktreeRequest): Promise<DeleteWorktreeResult> =>
      result('worktrees_delete', { ...req }, (message) => ({
        ok: false,
        error: 'unknown',
        message
      })),
    status: (worktreePath: string): Promise<WorktreeStatusResult> =>
      result('worktrees_status', { worktreePath }, (message) => ({
        ok: false,
        error: 'unknown',
        message
      }))
  },
  repo: {
    defaultBranch: (repositoryPath: string): Promise<string | null> =>
      invoke('repo_default_branch', { repositoryPath }),
    currentBranch: (folderPath: string): Promise<string | null> =>
      invoke('repo_current_branch', { folderPath }),
    status: async (
      repositoryPath: string,
      branch: string
    ): Promise<RepoStatus | { error: string }> => {
      const res = await result<RepoStatusResult>(
        'repo_status',
        { repositoryPath, branch },
        (message) => ({ ok: false, error: message })
      )
      return res.ok ? res.status : { error: res.error }
    },
    fetch: (repositoryPath: string, branch?: string): Promise<FetchResult> =>
      result('repo_fetch', { repositoryPath, branch }, (error) => ({ ok: false, error })),
    pull: (repositoryPath: string, branch: string): Promise<PullResult> =>
      result('repo_pull', { repositoryPath, branch }, (error) => ({ ok: false, error })),
    pullCurrentBranch: (folderPath: string): Promise<PullResult> =>
      result('repo_pull_current_branch', { folderPath }, (error) => ({ ok: false, error })),
    userAlias: (repositoryPath: string): Promise<string> =>
      invoke('repo_user_alias', { repositoryPath }),
    createBranch: (req: CreateBranchRequest): Promise<CreateBranchResult> =>
      result('repo_create_branch', { ...req }, (message) => ({
        ok: false,
        error: 'unknown',
        message
      })),
    openPullRequest: (req: OpenPullRequestRequest): Promise<OpenPullRequestResult> =>
      result('repo_open_pull_request', { ...req }, (message) => ({
        ok: false,
        code: 'git-failed',
        message
      })),
    findActivePullRequest: (req: FindPullRequestRequest): Promise<FindPullRequestResult> =>
      result('repo_find_active_pull_request', { ...req }, (message) => ({
        ok: false,
        code: 'git-failed',
        message
      })),
    workingCopyStatus: (req: WorkingCopyStatusRequest): Promise<WorkingCopyStatusResult> =>
      result('repo_working_copy_status', { ...req }, (error) => ({ ok: false, error })),
    localReviewChangedFiles: (
      req: LocalReviewChangedFilesRequest
    ): Promise<LocalReviewChangedFilesResult> =>
      result('repo_local_review_changed_files', { ...req }, (error) => ({ ok: false, error })),
    localReviewFileDiff: (req: LocalReviewFileDiffRequest): Promise<LocalReviewFileDiffResult> =>
      result('repo_local_review_file_diff', { ...req }, (error) => ({ ok: false, error })),
    localReviewFileContent: (
      req: LocalReviewFileContentRequest
    ): Promise<LocalReviewFileContentResult> =>
      result('repo_local_review_file_content', { ...req }, (error) => ({ ok: false, error })),
    recentCommits: (req: RecentCommitsRequest): Promise<RecentCommitsResult> =>
      result('repo_recent_commits', { ...req }, (error) => ({ ok: false, error })),
    rebaseOnDefault: (req: RebaseOnDefaultRequest): Promise<RebaseOnDefaultResult> =>
      result('repo_rebase_on_default', { ...req }, (message) => ({
        ok: false,
        code: 'git-failed',
        message
      })),
    unpushedCommits: (req: UnpushedCommitsRequest): Promise<UnpushedCommitsResult> =>
      result('repo_unpushed_commits', { ...req }, (error) => ({ ok: false, error })),
    push: (req: PushRequest): Promise<PushResult> =>
      result('repo_push', { ...req }, (error) => ({ ok: false, error })),
    stageFiles: (req: StageFilesRequest): Promise<StageFilesResult> =>
      result('repo_stage_files', { ...req }, (error) => ({ ok: false, error })),
    unstageFiles: (req: UnstageFilesRequest): Promise<UnstageFilesResult> =>
      result('repo_unstage_files', { ...req }, (error) => ({ ok: false, error })),
    revertFiles: (req: RevertFilesRequest): Promise<RevertFilesResult> =>
      result('repo_revert_files', { ...req }, (error) => ({ ok: false, error })),
    discardAllChanges: (req: DiscardAllChangesRequest): Promise<DiscardAllChangesResult> =>
      result('repo_discard_all_changes', { ...req }, (error) => ({ ok: false, error })),
    commit: (req: CommitRequest): Promise<CommitResult> =>
      result('repo_commit', { ...req }, (error) => ({ ok: false, error })),
    branchWebUrl: (req: BranchWebUrlRequest): Promise<BranchWebUrlResult> =>
      result('repo_branch_web_url', { ...req }, () => ({ webUrl: null })),
    detectMergeState: (req: DetectMergeStateRequest): Promise<DetectMergeStateResult> =>
      result('repo_detect_merge_state', { ...req }, (error) => ({ ok: false, error }))
  },
  reviews: {
    claimAutoReview: (req: AutoReviewClaimRequest): Promise<AutoReviewClaimResult> =>
      invoke('reviews_claim_auto_trigger', { ...req }),
    openPrs: {
      ado: (req: RepoOpenPrsRequest): Promise<RepoOpenPrsResult> =>
        result('ado_repo_open_prs', { ...req }, (message) => ({
          ok: false,
          code: 'git-failed',
          message
        })),
      github: (req: RepoOpenPrsRequest): Promise<RepoOpenPrsResult> =>
        result('github_repo_open_prs', { ...req }, (message) => ({
          ok: false,
          code: 'gh-failed',
          message
        }))
    },
    prThreads: {
      ado: (req: RepoPrThreadsRequest): Promise<RepoPrThreadsResult> =>
        result('ado_pr_threads', { ...req }, (message) => ({
          ok: false,
          code: 'git-failed',
          message
        })),
      github: (req: RepoPrThreadsRequest): Promise<RepoPrThreadsResult> =>
        result('github_pr_threads', { ...req }, (message) => ({
          ok: false,
          code: 'gh-failed',
          message
        }))
    }
  },
  /**
   * In-app PR review workspace. Each entry pairs the Azure DevOps and GitHub commands for one
   * operation; `lib/pr-review.ts` picks the pair matching the repository's remote.
   */
  prReview: {
    detail: {
      ado: (req: PrReviewDetailRequest): Promise<PrReviewDetailResult> =>
        result('ado_pr_detail', { ...req }, (message) => adoFail(message)),
      github: (req: PrReviewDetailRequest): Promise<PrReviewDetailResult> =>
        result('github_pr_detail', { ...req }, (message) => ghFail(message))
    },
    changedFiles: {
      ado: (req: PrChangedFilesRequest): Promise<PrChangedFilesResult> =>
        result('ado_pr_changed_files', { ...req }, (message) => adoFail(message)),
      github: (req: PrChangedFilesRequest): Promise<PrChangedFilesResult> =>
        result('github_pr_changed_files', { ...req }, (message) => ghFail(message))
    },
    fileDiff: {
      ado: (req: PrFileDiffRequest): Promise<PrFileDiffResult> =>
        result('ado_pr_file_diff', { ...req }, (message) => adoFail(message)),
      github: (req: PrFileDiffRequest): Promise<PrFileDiffResult> =>
        result('github_pr_file_diff', { ...req }, (message) => ghFail(message))
    },
    fileContent: {
      ado: (req: PrFileContentRequest): Promise<PrFileContentResult> =>
        result('ado_pr_file_content', { ...req }, (message) => adoFail(message)),
      github: (req: PrFileContentRequest): Promise<PrFileContentResult> =>
        result('github_pr_file_content', { ...req }, (message) => ghFail(message))
    },
    createThread: {
      ado: (req: PrCreateThreadRequest): Promise<PrMutationResult> =>
        result('ado_pr_create_thread', { ...req }, (message) => adoFail(message)),
      github: (req: PrCreateThreadRequest): Promise<PrMutationResult> =>
        result('github_pr_create_thread', { ...req }, (message) => ghFail(message))
    },
    reply: {
      ado: (req: PrReplyRequest): Promise<PrMutationResult> =>
        result('ado_pr_reply', { ...req }, (message) => adoFail(message)),
      github: (req: PrReplyRequest): Promise<PrMutationResult> =>
        result('github_pr_reply', { ...req }, (message) => ghFail(message))
    },
    setThreadStatus: {
      ado: (req: PrSetThreadStatusRequest): Promise<PrMutationResult> =>
        result('ado_pr_set_thread_status', { ...req }, (message) => adoFail(message)),
      github: (req: PrSetThreadStatusRequest): Promise<PrMutationResult> =>
        result('github_pr_set_thread_status', { ...req }, (message) => ghFail(message))
    },
    setVote: {
      ado: (req: PrSetVoteRequest): Promise<PrMutationResult> =>
        result('ado_pr_set_vote', { ...req }, (message) => adoFail(message)),
      github: (req: PrSetVoteRequest): Promise<PrMutationResult> =>
        result('github_pr_set_vote', { ...req }, (message) => ghFail(message))
    }
  },
  system: {
    openInVSCode: (folderPath: string): Promise<LaunchResult> =>
      result('system_open_in_vscode', { folderPath }, (error) => ({ ok: false, error })),
    openInVSCodeScm: (folderPath: string): Promise<LaunchResult> =>
      result('system_open_in_vscode_scm', { folderPath }, (error) => ({ ok: false, error })),
    openInWindowsTerminal: (folderPath: string): Promise<LaunchResult> =>
      result('system_open_in_windows_terminal', { folderPath }, (error) => ({ ok: false, error })),
    openExternal: (url: string): Promise<LaunchResult> =>
      result('system_open_external', { url }, (error) => ({ ok: false, error })),
    openPath: (folderPath: string): Promise<LaunchResult> =>
      result('system_open_path', { folderPath }, (error) => ({ ok: false, error })),
    getAppInfo: (): Promise<AppInfo> => invoke('system_get_app_info'),
    getKeepAwake: (): Promise<KeepAwakeResult> =>
      result('system_get_keep_awake', undefined, (error) => ({
        ok: false,
        enabled: false,
        error
      })),
    setKeepAwake: (enabled: boolean): Promise<KeepAwakeResult> =>
      result('system_set_keep_awake', { enabled }, (error) => ({
        ok: false,
        enabled: !enabled,
        error
      }))
  },
  localWeb: {
    start: (): Promise<LocalWebStatus> => invoke('local_web_start'),
    status: (): Promise<LocalWebStatus> => invoke('local_web_status'),
    stop: (): Promise<LocalWebStatus> => invoke('local_web_stop')
  },
  remoteControl: {
    beginLink: (serverUrl: string): Promise<RemoteControlStatus> =>
      invoke('remote_control_begin_link', { serverUrl }),
    completeLink: (): Promise<RemoteControlStatus> => invoke('remote_control_complete_link'),
    acceptLink: (): Promise<RemoteControlStatus> => invoke('remote_control_accept_link'),
    status: (): Promise<RemoteControlStatus> => invoke('remote_control_status'),
    unlink: (): Promise<RemoteControlStatus> => invoke('remote_control_unlink')
  },
  settings: {
    sessionLaunchMode: (): Promise<SessionLaunchMode> => invoke('settings_session_launch_mode'),
    setSessionLaunchMode: (mode: SessionLaunchMode): Promise<void> =>
      invoke('settings_set_session_launch_mode', { mode }),
    copilotPermissionProfile: (): Promise<CopilotPermissionProfile> =>
      invoke('settings_copilot_permission_profile'),
    setCopilotPermissionProfile: (profile: CopilotPermissionProfile): Promise<void> =>
      invoke('settings_set_copilot_permission_profile', { profile }),
    taskQueue: (): Promise<TaskQueueSettings> => invoke('settings_task_queue'),
    setTaskQueue: (settings: TaskQueueSettings): Promise<void> =>
      invoke('settings_set_task_queue', { settings }),
    savedPrompts: (): Promise<SavedPrompt[]> => invoke('settings_saved_prompts'),
    createSavedPrompt: (request: CreateSavedPromptRequest): Promise<SavedPrompt> =>
      invoke('settings_create_saved_prompt', { ...request }),
    updateSavedPrompt: (request: UpdateSavedPromptRequest): Promise<SavedPrompt> =>
      invoke('settings_update_saved_prompt', { ...request }),
    deleteSavedPrompt: (id: string): Promise<void> =>
      invoke('settings_delete_saved_prompt', { id }),
    browserCodeReviewPrompt: (): Promise<SavedPrompt> =>
      invoke('settings_browser_code_review_prompt'),
    setBrowserCodeReviewPrompt: (id: string): Promise<void> =>
      invoke('settings_set_browser_code_review_prompt', { id })
  },
  copilotHistory: {
    list: (): Promise<CopilotHistoryListResult> =>
      result('copilot_history_list', undefined, (message) => ({
        ok: false,
        reason: 'unreadable',
        message
      }))
  },
  copilotAnalytics: {
    summary: (windowDays?: number, repository?: string): Promise<CopilotAnalyticsResult> =>
      result('copilot_analytics_summary', { windowDays, repository }, (message) => ({
        ok: false,
        reason: 'unreadable',
        message
      }))
  },
  nativeSessions: {
    enqueue: (
      target: TerminalTarget,
      id: string,
      prompt: PromptContent[],
      literal = false
    ): Promise<NativeSnapshot> => invoke('acp_session_enqueue', { target, id, prompt, literal }),
    queue: (
      target: TerminalTarget,
      action: string,
      itemId?: string,
      text?: string
    ): Promise<NativeSnapshot> => invoke('acp_session_queue', { target, action, itemId, text }),
    snapshot: (target: TerminalTarget): Promise<NativeSnapshot> =>
      invoke('native_session_snapshot', { target }),
    respond: (
      target: TerminalTarget,
      interactionId: string,
      answer: NativeAnswer
    ): Promise<NativeSnapshot> =>
      invoke('native_session_respond', { target, interactionId, answer }),
    planTransition: (
      target: TerminalTarget,
      action: PlanTransitionAction
    ): Promise<NativeSnapshot> => invoke('acp_session_plan_transition', { target, action }),
    reopenPlanTransition: (target: TerminalTarget): Promise<NativeSnapshot> =>
      invoke('acp_session_reopen_plan_transition', { target }),
    cancel: (target: TerminalTarget): Promise<void> => invoke('native_session_cancel', { target }),
    end: (target: TerminalTarget): Promise<void> => invoke('native_session_end', { target }),
    onUpdate: (cb: (snapshot: NativeSnapshotUpdate) => void): Promise<() => void> =>
      listen<NativeSnapshotUpdate>('native-sessions:update', (event) => cb(event.payload))
  },
  terminalSessions: {
    list: (): Promise<TerminalSession[]> => invoke('terminal_sessions_list'),
    start: (req: StartTerminalSessionRequest): Promise<TerminalSessionResult> =>
      result('terminal_sessions_start', { req }, (error) => ({ ok: false, error })),
    isRunning: (id: string): Promise<boolean> => invoke('terminal_sessions_is_running', { id }),
    focus: (id: string): Promise<LaunchResult> =>
      result('terminal_sessions_focus', { id }, (error) => ({ ok: false, error })),
    forget: (id: string): Promise<void> => invoke('terminal_sessions_forget', { id }),
    history: (id: string): Promise<TerminalTimelineEntry[]> =>
      invoke('terminal_sessions_history', { id }),
    onUpdate: (cb: (update: TerminalSessionUpdate) => void): Promise<() => void> =>
      listen<TerminalSessionUpdate>(TERMINAL_SESSIONS_UPDATE_EVENT, (event) => cb(event.payload))
  },
  embeddedTerminals: {
    list: (): Promise<EmbeddedTerminal[]> => invoke('embedded_terminals_list'),
    start: (request: EmbeddedTerminalStartRequest): Promise<EmbeddedTerminalResult> =>
      invoke('embedded_terminal_start', { request }),
    write: (terminalId: string, data: string): Promise<void> =>
      invoke('embedded_terminal_write', { terminalId, data }),
    resize: (terminalId: string, cols: number, rows: number): Promise<void> =>
      invoke('embedded_terminal_resize', { terminalId, cols, rows }),
    replay: (terminalId: string): Promise<EmbeddedTerminalReplay> =>
      invoke('embedded_terminal_replay', { terminalId }),
    close: (terminalId: string): Promise<void> => invoke('embedded_terminal_close', { terminalId }),
    listDirectories: (
      repositoryPath: string,
      rootPath: string,
      folderPath: string
    ): Promise<EmbeddedDirectoryListing> =>
      invoke('embedded_terminal_list_directories', {
        request: { repositoryPath, rootPath, folderPath }
      }),
    onOutput: (cb: (output: EmbeddedTerminalOutput) => void): Promise<() => void> =>
      listen<EmbeddedTerminalOutput>('embedded-terminals:output', (event) => cb(event.payload)),
    onUpdate: (cb: (update: EmbeddedTerminalUpdate) => void): Promise<() => void> =>
      listen<EmbeddedTerminalUpdate>('embedded-terminals:update', (event) => cb(event.payload))
  },
  tasks: {
    list: (): Promise<Task[]> => invoke('tasks_list'),
    onUpdate: (cb: () => void): Promise<() => void> => listen(TASKS_CHANGED_EVENT, () => cb()),
    pickAttachments: (req: PickTaskAttachmentsRequest): Promise<PickTaskAttachmentsResult> =>
      result('tasks_pick_attachments', { ...req }, (message) => ({
        ok: false,
        error: 'invalid-attachment',
        message
      })),
    discardAttachmentStage: (req: DiscardTaskAttachmentStageRequest): Promise<void> =>
      invoke('tasks_discard_attachment_stage', { ...req }),
    create: (req: CreateTaskRequest): Promise<CreateTaskResult> =>
      result('tasks_create', { ...req }, (message) => ({
        ok: false,
        error: 'unknown',
        message
      })),
    update: (req: UpdateTaskRequest): Promise<UpdateTaskResult> =>
      result('tasks_update', { ...req }, (message) => ({
        ok: false,
        error: 'unknown',
        message
      })),
    move: (req: MoveTaskRequest): Promise<MoveTaskResult> =>
      result('tasks_move', { ...req }, (message) => ({
        ok: false,
        error: 'unknown',
        message
      })),
    delete: (req: DeleteTaskRequest): Promise<DeleteTaskResult> =>
      result('tasks_delete', { ...req }, (message) => ({
        ok: false,
        error: 'unknown',
        message
      })),
    setCopilotSession: (req: SetTaskCopilotSessionRequest): Promise<UpdateTaskResult> =>
      result('tasks_set_copilot_session', { ...req }, (message) => ({
        ok: false,
        error: 'unknown',
        message
      })),
    setQueueStatus: (req: SetTaskQueueStatusRequest): Promise<UpdateTaskResult> =>
      result('tasks_set_queue_status', { ...req }, (message) => ({
        ok: false,
        error: 'unknown',
        message
      })),
    claimRun: (req: ClaimTaskRunRequest): Promise<ClaimTaskRunResult> =>
      result('tasks_claim_run', { ...req }, (message) => ({
        ok: false,
        error: 'unknown',
        message
      })),
    releaseRun: (req: ReleaseTaskRunRequest): Promise<UpdateTaskResult> =>
      result('tasks_release_run', { ...req }, (message) => ({
        ok: false,
        error: 'unknown',
        message
      }))
  }
}

export type Api = typeof api

declare global {
  interface Window {
    api: Api
  }
}

window.api = api

export { api }
