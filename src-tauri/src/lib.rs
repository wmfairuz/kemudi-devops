mod actions;
mod app_inspect;
mod audit;
mod baseline;
mod setup;
mod certs;
mod config;
mod dashboard;
mod discover;
mod env;
mod error;
mod files;
mod fleet;
mod health;
mod logs;
mod mcp;
mod menu;
mod monitor;
mod newapp;
mod preflight;
mod pty;
mod queues;
mod db;
mod remote_files;
mod runners;
mod secops;
mod secret_cache;
mod session;
mod shots;
mod apps_log;
mod shell_integration;
mod snippets;
mod ssh;
mod ssh_hosts;
mod system;
mod tab_configs;
mod tune;
mod updates;
mod util;
mod vault;
mod watch;
mod workflows;

use std::sync::{Arc, LazyLock};

use tauri::{Emitter, Manager, RunEvent};

use audit::AuditLog;
use config::ConfigStore;
use env::LoginEnv;
use pty::PtyRegistry;

pub struct AppState {
    /// Captured once, in the background, at startup. The first spawn waits
    /// for it if it isn't ready yet.
    pub env: Arc<LazyLock<LoginEnv>>,
    pub ptys: PtyRegistry,
    pub config: ConfigStore,
    pub status: preflight::StatusBoard,
    /// Err holds why the audit DB couldn't open; actions still run.
    pub audit: Result<Arc<AuditLog>, String>,
    /// Background checks and what they found (Home's Needs attention).
    pub watch: watch::Watch,
}

impl AppState {
    /// The login env, waiting for the startup capture without blocking an
    /// async worker.
    pub async fn env_ready(&self) -> &LoginEnv {
        let env = self.env.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            LazyLock::force(&env);
        })
        .await;
        &self.env
    }

    /// `terminal.shell_integration` (on unless set to false).
    pub fn shell_integration(&self) -> bool {
        self.config
            .config()
            .is_none_or(|c| c.terminal.shell_integration != Some(false))
    }
}

/// Shrinks the main window to the work area of the screen it's on (and
/// moves it inside) when it's wider or taller than that screen.
fn fit_to_screen(app: &tauri::AppHandle) {
    let Some(w) = app.get_webview_window("main") else { return };
    let (Ok(Some(m)), Ok(size), Ok(pos)) = (w.current_monitor(), w.outer_size(), w.outer_position()) else {
        return;
    };
    let area = m.work_area();
    let (aw, ah) = (area.size.width, area.size.height);
    if aw == 0 || ah == 0 || (size.width <= aw && size.height <= ah) {
        return;
    }
    let (width, height) = (size.width.min(aw), size.height.min(ah));
    let max_x = area.position.x + i32::try_from(aw - width).unwrap_or(0);
    let max_y = area.position.y + i32::try_from(ah - height).unwrap_or(0);
    let _ = w.set_size(tauri::PhysicalSize::new(width, height));
    let _ = w.set_position(tauri::PhysicalPosition::new(
        pos.x.clamp(area.position.x, max_x),
        pos.y.clamp(area.position.y, max_y),
    ));
}

/// `$KEMUDI_DATA_DIR`, else ~/Library/Application Support/kemudi.
pub fn data_dir() -> Option<std::path::PathBuf> {
    match std::env::var_os("KEMUDI_DATA_DIR").filter(|v| !v.is_empty()) {
        Some(dir) => Some(dir.into()),
        None => dirs::data_dir().map(|d| d.join("kemudi")),
    }
}

fn open_audit() -> Result<Arc<AuditLog>, String> {
    let dir = data_dir().ok_or("no Application Support directory")?;
    AuditLog::open(&dir.join("audit.db"))
        .map(Arc::new)
        .map_err(|e| e.to_string())
}

/// `kemudi --mcp`: Kemudi as a stdio MCP server for Claude (it talks to the
/// running app; see mcp.rs).
pub fn mcp_bridge() {
    mcp::bridge();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState {
            env: Arc::new(LazyLock::new(LoginEnv::capture)),
            ptys: PtyRegistry::default(),
            config: ConfigStore::new(config::config_path()),
            status: preflight::StatusBoard::default(),
            audit: open_audit(),
            watch: watch::Watch::load(),
        })
        .menu(menu::build)
        .on_menu_event(|app, event| {
            let _ = app.emit("menu", event.id().as_ref());
        })
        .setup(|app| {
            // A Claude session's `kemudi --mcp` reaches the app through this.
            mcp::serve(app.handle().clone());
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let env = &*handle.state::<AppState>().env;
                if let Some(w) = &env.warning {
                    eprintln!("kemudi: {w}");
                }
            });
            match config::watcher::start(app.handle()) {
                Ok(watcher) => {
                    app.manage(watcher);
                }
                Err(e) => eprintln!("kemudi: config hot-reload disabled: {e}"),
            }
            // A size saved across two screens (or a bigger one since gone)
            // comes back wider than the screen: fit it to the one it's on.
            fit_to_screen(app.handle());
            let later = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(400));
                let h = later.clone();
                let _ = later.run_on_main_thread(move || fit_to_screen(&h));
            });
            preflight::start_poller(app.handle().clone());
            watch::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::commands::pty_spawn,
            pty::commands::pty_write,
            pty::commands::pty_resize,
            pty::commands::pty_kill,
            pty::commands::pty_cwd,
            system::open_url,
            system::env_report,
            system::app_quiet,
            system::ssh_hosts,
            config::commands::config_get,
            config::commands::config_reload,
            config::commands::config_create,
            config::commands::config_open,
            config::commands::config_reveal,
            config::commands::action_set_confirm,
            config::commands::action_definition,
            config::commands::action_set_run,
            config::commands::action_set_danger,
            config::forms::server_save,
            config::forms::server_delete,
            config::forms::server_duplicate,
            config::forms::servers_set_group,
            config::forms::team_save,
            config::forms::team_delete,
            config::forms::app_save,
            config::forms::app_delete,
            config::action_forms::action_add,
            config::action_forms::action_remove,
            config::settings_form::settings_save,
            config::settings_form::baseline_save,
            baseline::baseline_check,
            baseline::baseline_install,
            dashboard::dashboard_status,
            dashboard::dashboard_maintenance,
            dashboard::dashboard_auth,
            dashboard::dashboard_runs,
            dashboard::dashboard_workers,
            runners::runners_plan,
            runners::runners_add,
            shots::app_shot,
            shots::app_shot_take,
            apps_log::apps_log,
            setup::setup_check,
            setup::setup_plan,
            setup::setup_source,
            setup::setup_save,
            setup::server_set_setup,
            mcp::mcp_reply,
            ssh_hosts::ssh_host_info,
            ssh_hosts::ssh_host_save,
            ssh_hosts::ssh_keys,
            ssh_hosts::ssh_managed_hosts,
            ssh_hosts::ssh_host_list,
            watch::watch_get,
            watch::watch_refresh,
            watch::watch_security,
            watch::watch_snooze,
            watch::watch_settings_get,
            watch::watch_settings_set,
            ssh_hosts::ssh_host_delete,
            ssh_hosts::ssh_host_adopt,
            ssh_hosts::ssh_config_open,
            ssh_hosts::ssh_test,
            tab_configs::tab_configs_list,
            tab_configs::tab_config_save,
            tab_configs::tab_config_delete,
            tab_configs::tab_configs_reveal,
            monitor::monitor_sample,
            monitor::monitor_disks,
            monitor::app_detect_repo,
            app_inspect::app_inspect,
            secret_cache::inspect_secrets,
            secret_cache::inspect_secrets_retry,
            remote_files::remote_file_read,
            remote_files::remote_file_write,
            remote_files::remote_file_restore,
            remote_files::vhost_probe,
            files::files_list,
            files::files_download,
            files::files_upload,
            files::files_reveal,
            files::files_choose_folder,
            files::files_choose_files,
            files::files_principals,
            files::files_chown,
            files::files_chmod,
            files::files_rename,
            files::files_delete,
            files::files_create,
            files::files_paste,
            files::files_find,
            logs::logs_sources,
            logs::logs_read,
            queues::queues_status,
            queues::queues_failed_detail,
            queues::queues_act,
            db::db_tables,
            db::db_query,
            db::db_update,
            db::db_queries,
            db::db_query_save,
            db::db_query_saved_edit,
            db::db_history_clear,
            db::db_write,
            db::db_insert_row,
            db::db_delete_row,
            db::db_schema,
            db::db_dump,
            db::db_dump_cancel,
            health::health_check,
            health::health_composer_audit,
            certs::certs_list,
            certs::certs_renew_start,
            certs::certs_renew_status,
            certs::certs_renew_continue,
            certs::certs_renew_finish,
            certs::certs_dns_check,
            discover::discover_apps,
            discover::app_detect_php,
            discover::app_detect_url,
            tune::tune_analyze,
            tune::tune_apply,
            tune::tune_undo,
            remote_files::vhost_create,
            newapp::newapp_probe,
            newapp::newapp_repo_check,
            newapp::newapp_create_key,
            newapp::newapp_script,
            newapp::newapp_run,
            config::forms::new_app_hook_save,
            config::forms::app_move,
            config::forms::server_move,
            workflows::workflow_script,
            workflows::workflow_run,
            updates::update_check,
            fleet::asg_instances,
            fleet::aws_profiles,
            fleet::asg_groups,
            fleet::rds_databases,
            updates::update_install,
            workflows::workflow_branch_run,
            workflows::workflow_watch_run,
            config::forms::workflow_save,
            config::forms::workflow_delete,
            snippets::snippets_list,
            vault::vault_list,
            vault::vault_save,
            vault::vault_delete,
            vault::vault_fill,
            vault::vault_copy,
            vault::vault_server_notes,
            vault::vault_server_notes_save,
            snippets::snippet_save,
            snippets::snippet_delete,
            actions::commands::action_render,
            actions::commands::action_run,
            actions::commands::action_send,
            actions::commands::action_render_mac,
            preflight::commands::status_get,
            preflight::commands::status_refresh,
            preflight::commands::vpn_connect,
            audit::commands::audit_list,
            session::session_load,
            session::session_save,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            handle.state::<AppState>().ptys.kill_all();
        }
    });
}
