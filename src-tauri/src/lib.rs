mod ado;
mod az;
mod command;
mod cloud_remote;
mod copilot_acp_sessions;
mod copilot_analytics;
mod copilot_history;
mod db;
mod desktop_notifications;
mod embedded_terminals;
mod error;
mod gh;
mod git;
mod github;
mod local_review;
mod local_web;
mod pr_review;
mod process;
mod repo;
mod repositories;
mod remote_control;
mod reviews;
mod session_attention;
mod session_interactions;
mod settings;
mod signalr_transport;
mod system;
mod tasks;
mod terminal_sessions;
#[cfg(desktop)]
mod tray;
mod worktrees;

use std::sync::Mutex;

use tauri::Manager;
#[cfg(all(windows, debug_assertions))]
use tauri_plugin_deep_link::DeepLinkExt;

use db::DbState;
use terminal_sessions::TerminalSessionMonitor;

/// Build and run the SWE Factory Tauri application.
///
/// Plugins mirror the Electron capabilities that survive the migration:
/// dialog (folder picker), opener (open external URLs / paths / apps), process
/// (relaunch after update), log (diagnostics), single-instance (focus the
/// existing window on a second launch so update-on-relaunch never races), and
/// updater (auto-update against GitHub Releases, replacing electron-updater).
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Err(error) = tray::show_main_window(app) {
                eprintln!("failed to restore SWE Factory from second-instance activation: {error}");
            }
        }));
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
        builder = builder.on_window_event(tray::handle_window_event);
    }

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(all(windows, debug_assertions))]
            app.deep_link().register_all()?;
            let conn = db::init(&app.path().app_data_dir()?)?;
            app.manage(DbState(Mutex::new(conn)));
            app.manage(system::KeepAwakeState::default());
            app.manage(embedded_terminals::EmbeddedTerminalManager::default());
            app.manage(TerminalSessionMonitor::default());
            app.manage(terminal_sessions::AcpSessionManager::default());
            app.manage(copilot_acp_sessions::SessionManager::default());
            app.manage(local_web::LocalWebState::default());
            app.manage(cloud_remote::CloudRemoteState::default());
            if let Err(e) = tasks::cleanup_attachment_storage(app.handle()) {
                eprintln!("failed to clean task attachment storage: {e}");
            }
            #[cfg(desktop)]
            tray::setup(app)?;
            // Restore native history; external status watches belong to this app run only.
            if let Err(e) = terminal_sessions::init(app.handle()) {
                eprintln!("failed to restore terminal session watches: {e}");
            }
            if let Err(e) = tasks::reconcile_run_claims(app.handle()) {
                eprintln!("failed to reconcile task run claims: {e}");
            }
            cloud_remote::initialize(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            repositories::repositories_list,
            repositories::repositories_remove,
            repositories::repositories_reorder,
            repositories::repositories_pick_and_add,
            worktrees::worktrees_list_for_repository,
            worktrees::worktrees_create,
            worktrees::worktrees_delete,
            worktrees::worktrees_status,
            copilot_history::copilot_history_list,
            copilot_analytics::copilot_analytics_summary,
            system::system_open_in_vscode,
            system::system_open_in_vscode_scm,
            system::system_open_in_windows_terminal,
            system::system_open_external,
            system::system_open_path,
            system::system_get_app_info,
            system::system_get_keep_awake,
            system::system_set_keep_awake,
            desktop_notifications::desktop_notification_show,
            local_web::local_web_start,
            local_web::local_web_status,
            local_web::local_web_stop,
            cloud_remote::remote_control_begin_link,
            cloud_remote::remote_control_complete_link,
            cloud_remote::remote_control_accept_link,
            cloud_remote::remote_control_status,
            cloud_remote::remote_control_unlink,
            settings::settings_session_launch_mode,
            settings::settings_set_session_launch_mode,
            settings::settings_copilot_permission_profile,
            settings::settings_set_copilot_permission_profile,
            settings::settings_task_queue,
            settings::settings_set_task_queue,
            settings::settings_saved_prompts,
            settings::settings_create_saved_prompt,
            settings::settings_update_saved_prompt,
            settings::settings_delete_saved_prompt,
            settings::settings_browser_code_review_prompt,
            settings::settings_set_browser_code_review_prompt,
            embedded_terminals::embedded_terminals_list,
            embedded_terminals::embedded_terminal_start,
            embedded_terminals::embedded_terminal_write,
            embedded_terminals::embedded_terminal_resize,
            embedded_terminals::embedded_terminal_replay,
            embedded_terminals::embedded_terminal_close,
            embedded_terminals::embedded_terminal_list_directories,
            ado::ado_pr_threads,
            ado::ado_repo_open_prs,
            ado::ado_pr_detail,
            ado::ado_pr_changed_files,
            ado::ado_pr_file_diff,
            ado::ado_pr_file_content,
            ado::ado_pr_create_thread,
            ado::ado_pr_reply,
            ado::ado_pr_set_thread_status,
            ado::ado_pr_set_vote,
            github::github_repo_open_prs,
            github::github_pr_threads,
            github::github_pr_detail,
            github::github_pr_changed_files,
            github::github_pr_file_diff,
            github::github_pr_file_content,
            github::github_pr_create_thread,
            github::github_pr_reply,
            github::github_pr_set_thread_status,
            github::github_pr_set_vote,
            reviews::reviews_claim_auto_trigger,
            repo::repo_default_branch,
            repo::repo_current_branch,
            repo::repo_status,
            repo::repo_fetch,
            repo::repo_pull,
            repo::repo_pull_current_branch,
            repo::repo_user_alias,
            repo::repo_create_branch,
            repo::repo_open_pull_request,
            repo::repo_find_active_pull_request,
            repo::repo_working_copy_status,
            local_review::repo_local_review_changed_files,
            local_review::repo_local_review_file_diff,
            local_review::repo_local_review_file_content,
            repo::repo_recent_commits,
            repo::repo_rebase_on_default,
            repo::repo_unpushed_commits,
            repo::repo_push,
            repo::repo_stage_files,
            repo::repo_unstage_files,
            repo::repo_revert_files,
            repo::repo_discard_all_changes,
            repo::repo_commit,
            repo::repo_branch_web_url,
            repo::repo_detect_merge_state,
            tasks::tasks_list,
            tasks::tasks_pick_attachments,
            tasks::tasks_discard_attachment_stage,
            tasks::tasks_create,
            tasks::tasks_update,
            tasks::tasks_move,
            tasks::tasks_delete,
            tasks::tasks_set_copilot_session,
            tasks::tasks_set_queue_status,
            tasks::tasks_claim_run,
            tasks::tasks_release_run,
            terminal_sessions::terminal_sessions_list,
            terminal_sessions::terminal_sessions_start,
            terminal_sessions::terminal_sessions_history,
            terminal_sessions::terminal_sessions_is_running,
            terminal_sessions::terminal_sessions_focus,
            terminal_sessions::terminal_sessions_forget,
            copilot_acp_sessions::native_session_snapshot,
            copilot_acp_sessions::native_session_respond,
            copilot_acp_sessions::acp_session_reopen_plan_transition,
            copilot_acp_sessions::acp_session_plan_transition,
            copilot_acp_sessions::native_session_cancel,
            copilot_acp_sessions::native_session_end,
            copilot_acp_sessions::acp_session_enqueue,
            copilot_acp_sessions::acp_session_queue,
        ])
        .build(tauri::generate_context!())
        .expect("error while building SWE Factory")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                app.state::<system::KeepAwakeState>().shutdown();
                local_web::shutdown(app);
                cloud_remote::shutdown(app);
                embedded_terminals::shutdown(app);
            }
            if let tauri::RunEvent::ExitRequested { api, .. } = &event {
                let manager = app.state::<copilot_acp_sessions::SessionManager>();
                if !manager
                    .shutdown_complete
                    .load(std::sync::atomic::Ordering::SeqCst)
                {
                    api.prevent_exit();
                    if !manager
                        .exiting
                        .swap(true, std::sync::atomic::Ordering::SeqCst)
                    {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            copilot_acp_sessions::shutdown(&app).await;
                            app.state::<copilot_acp_sessions::SessionManager>()
                                .shutdown_complete
                                .store(true, std::sync::atomic::Ordering::SeqCst);
                            app.exit(0);
                        });
                    }
                }
            }
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<system::KeepAwakeState>().shutdown();
                local_web::shutdown(app);
                cloud_remote::shutdown(app);
                embedded_terminals::shutdown(app);
                tauri::async_runtime::block_on(copilot_acp_sessions::shutdown(app));
            }
        });
}
