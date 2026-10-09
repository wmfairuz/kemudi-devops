use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, State};

use super::{State as Reach, Status};
use crate::actions::invocation;
use crate::config::schema::{ActionKind, Vpn};
use crate::error::{AppError, AppResult};
use crate::pty::commands::pty_size;
use crate::pty::{Launch, PtyEvent, PtyId};
use crate::AppState;

#[tauri::command]
pub async fn status_get(state: State<'_, AppState>) -> AppResult<Vec<Status>> {
    Ok(state.status.all())
}

/// Probe now (all servers, or just `server_ids`) and return the results.
#[tauri::command]
pub async fn status_refresh(
    app: AppHandle,
    server_ids: Option<Vec<String>>,
) -> AppResult<Vec<Status>> {
    Ok(super::refresh(&app, server_ids.as_deref()).await)
}

/// Gate for SSH actions on VPN servers: Err(vpnDown) when the probe fails.
pub async fn ensure_reachable(app: &AppHandle, server_id: &str) -> AppResult<()> {
    let state: State<'_, AppState> = tauri::Manager::state(app);
    let Some(server) = state
        .config
        .config()
        .and_then(|c| c.server(server_id).cloned())
    else {
        return Ok(());
    };
    if server.vpn == Vpn::None {
        return Ok(());
    }
    let ids = [server_id.to_string()];
    let status = super::refresh(app, Some(&ids)).await.into_iter().next();
    match status {
        Some(s) if s.state == Reach::Up => Ok(()),
        Some(s) => Err(AppError::VpnDown(format!(
            "{} is unreachable ({}): {}",
            server.id,
            s.target.unwrap_or_else(|| "no target".into()),
            s.error.unwrap_or_else(|| "unknown error".into())
        ))),
        None => Ok(()),
    }
}

/// Open a local tab running the server's `vpn_connect` (so sudo can prompt).
#[tauri::command]
pub async fn vpn_connect(
    state: State<'_, AppState>,
    server_id: String,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    on_event: Channel<PtyEvent>,
) -> AppResult<PtyId> {
    let server = state
        .config
        .config()
        .and_then(|c| c.server(&server_id).cloned())
        .ok_or_else(|| AppError::NotFound(format!("server `{server_id}` isn't in Kemudi")))?;
    match server.vpn {
        Vpn::Openfortivpn => {
            let command = server
                .vpn_connect
                .filter(|c| !c.trim().is_empty())
                .ok_or_else(|| {
                    AppError::Invalid(format!("{server_id} has no `vpn_connect` command"))
                })?;
            let env = state.env_ready().await;
            let cmd = invocation::command_for(
                ActionKind::Local,
                "",
                &command,
                env,
                state.shell_integration(),
            );
            state.ptys.spawn(
                Launch::tracked(cmd),
                pty_size(cols, rows)?,
                on_data,
                on_event,
            )
        }
        Vpn::Globalprotect => Err(AppError::Invalid(
            "Connect GlobalProtect first, then retry.".into(),
        )),
        Vpn::None => Err(AppError::Invalid(format!("{server_id} doesn't use a VPN"))),
    }
}
