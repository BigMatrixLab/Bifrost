//! Bifrost desktop and Android app shell: Tauri commands, events, and
//! platform integration (menu-bar tray on desktop, background service on Android).

use std::path::PathBuf;
use std::sync::Mutex;

use bifrost_core::{
    AccessRequest, ActivityDto, Core, CoreEvent, CoreOptions, CreatedInvitation, DownloadItem, GrantDto, HistoryDto, IncomingDto, OutgoingDto,
    JobSnapshot, JoinResult, ListResult, NetworkStatus, PeerStatus, PushDto, RemoteDto, Settings, ShareDto, SyncDto,
};
use serde::Serialize;
#[cfg(desktop)]
use tauri::menu::{Menu, MenuItem};
#[cfg(desktop)]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
#[cfg(desktop)]
use tauri::{WebviewUrl, WebviewWindowBuilder};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tauri_plugin_notification::NotificationExt;
#[cfg(target_os = "android")]
use tauri_plugin_bifrost_android::BifrostAndroidExt;

struct AppState {
    core: Core,
}

type CmdResult<T> = Result<T, String>;

fn err(e: anyhow::Error) -> String {
    e.to_string()
}

// ---------------------------------------------------------------------- window management

/// Opens (or focuses) the main window. Closing the window destroys the
/// WebView entirely so it uses no memory while transfers continue in the tray.
#[cfg(desktop)]
fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Bifrost")
        .inner_size(1200.0, 780.0)
        .min_inner_size(960.0, 620.0)
        .theme(Some(tauri::Theme::Dark))
        .background_color(tauri::window::Color(18, 18, 18, 255))
        .center()
        .build();
    if let Err(e) = built {
        tracing::error!("failed to open window: {e}");
    }
}

/// Name shown to other devices. Windows reports `COMPUTERNAME` in all caps;
/// macOS has a cased Computer Name; anything else falls back to the hostname.
#[cfg(not(target_os = "android"))]
fn device_name() -> String {
    read_device_name().map(prettify_device_name).unwrap_or_else(|| {
        if cfg!(target_os = "macos") {
            "Mac".to_string()
        } else {
            "This PC".to_string()
        }
    })
}

#[cfg(not(target_os = "android"))]
fn read_device_name() -> Option<String> {
    #[cfg(target_os = "macos")]
    if let Some(name) = command_line("scutil", &["--get", "ComputerName"]) {
        return Some(name);
    }
    std::env::var("COMPUTERNAME")
        .ok()
        .filter(|n| !n.trim().is_empty())
        .or_else(|| std::env::var("HOSTNAME").ok().filter(|n| !n.trim().is_empty()))
        .or_else(|| command_line("hostname", &[]))
}

#[cfg(not(target_os = "android"))]
fn command_line(program: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(program).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let name = String::from_utf8(out.stdout).ok()?.trim().to_string();
    if name.is_empty() { None } else { Some(name) }
}

#[cfg(not(target_os = "android"))]
fn prettify_device_name(name: String) -> String {
    let name = name.trim().to_string();
    if name.chars().any(|c| c.is_lowercase()) {
        return name;
    }
    let mut chars = name.to_lowercase().chars().collect::<Vec<_>>();
    if let Some(first) = chars.first_mut() {
        *first = first.to_ascii_uppercase();
    }
    chars.into_iter().collect()
}

fn init_logging(dir: &std::path::Path) {
    let _ = std::fs::create_dir_all(dir);
    let path = dir.join("bifrost.log");
    if std::fs::metadata(&path).map(|m| m.len() > 5 * 1024 * 1024).unwrap_or(false) {
        let _ = std::fs::rename(&path, dir.join("bifrost.old.log"));
    }
    if let Ok(file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = tracing_subscriber::fmt()
            .with_env_filter(
                tracing_subscriber::EnvFilter::try_from_env("BIFROST_LOG")
                    .or_else(|_| tracing_subscriber::EnvFilter::try_from_env("RELAYLESS_LOG"))
                    .unwrap_or_else(|_| "bifrost_lib=info,bifrost_core=info,iroh=warn".into()),
            )
            .with_ansi(false)
            .with_writer(Mutex::new(file))
            .try_init();
    }
}

// ---------------------------------------------------------------------- commands

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Bootstrap {
    platform: String,
    settings: Settings,
    network: NetworkStatus,
    version: String,
    data_dir: String,
}

#[tauri::command]
fn bootstrap(s: State<AppState>) -> Bootstrap {
    Bootstrap {
        platform: std::env::consts::OS.to_string(),
        settings: s.core.settings(),
        network: s.core.network_status(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        data_dir: s.core.data_dir().to_string_lossy().to_string(),
    }
}

#[tauri::command]
fn network_status(s: State<AppState>) -> NetworkStatus {
    s.core.network_status()
}

#[tauri::command]
fn update_settings(s: State<AppState>, settings: Settings) -> CmdResult<Settings> {
    let out = s.core.update_settings(settings).map_err(err)?;
    bifrost_core::set_low_priority(out.low_priority);
    Ok(out)
}

#[tauri::command]
fn list_shares(s: State<AppState>) -> CmdResult<Vec<ShareDto>> {
    s.core.list_shares().map_err(err)
}

#[tauri::command]
fn create_share(s: State<AppState>, path: String, name: Option<String>) -> CmdResult<ShareDto> {
    s.core.create_share(&path, name).map_err(err)
}

#[tauri::command]
fn set_device_permission(s: State<AppState>, peer_id: String, share_id: String, permission: String) -> CmdResult<()> {
    s.core.set_device_permission(&peer_id, &share_id, &permission).map_err(err)
}

#[tauri::command]
async fn start_upload(
    s: State<'_, AppState>,
    peer_id: String,
    share_id: String,
    dir: Vec<String>,
    paths: Vec<String>,
) -> CmdResult<Vec<String>> {
    s.core.start_upload(&peer_id, &share_id, dir, paths).await.map_err(err)
}

#[tauri::command]
fn list_pushes(s: State<AppState>) -> Vec<PushDto> {
    s.core.list_pushes()
}

#[tauri::command]
async fn cancel_push(s: State<'_, AppState>, id: String) -> CmdResult<()> {
    s.core.cancel_push(&id).map_err(err)
}

#[tauri::command]
async fn retry_push(s: State<'_, AppState>, id: String) -> CmdResult<()> {
    s.core.retry_push(&id).map_err(err)
}

#[tauri::command]
async fn remove_push(s: State<'_, AppState>, id: String) -> CmdResult<()> {
    s.core.remove_push(&id).map_err(err)
}

#[tauri::command]
fn clear_pushes(s: State<AppState>) {
    s.core.clear_pushes()
}

#[tauri::command]
fn list_syncs(s: State<AppState>) -> Vec<SyncDto> {
    s.core.list_syncs()
}

#[tauri::command]
async fn enable_sync(
    s: State<'_, AppState>,
    peer_id: String,
    share_id: String,
    dest_dir: Option<String>,
    include_existing: bool,
) -> CmdResult<SyncDto> {
    s.core.enable_sync(&peer_id, &share_id, dest_dir, include_existing).map_err(err)
}

#[tauri::command]
fn disable_sync(s: State<AppState>, peer_id: String, share_id: String) -> CmdResult<()> {
    s.core.disable_sync(&peer_id, &share_id).map_err(err)
}

#[tauri::command]
fn sync_now(s: State<AppState>) {
    s.core.sync_now()
}

#[tauri::command]
fn list_incoming(s: State<AppState>) -> Vec<IncomingDto> {
    s.core.list_incoming()
}

#[tauri::command]
fn remove_incoming(s: State<AppState>, id: String) {
    s.core.remove_incoming(&id)
}

#[tauri::command]
fn clear_incoming(s: State<AppState>) {
    s.core.clear_incoming()
}

#[tauri::command]
async fn remote_mkdir(s: State<'_, AppState>, peer_id: String, share_id: String, path: Vec<String>) -> CmdResult<String> {
    s.core.remote_mkdir(&peer_id, &share_id, path).await.map_err(err)
}

#[tauri::command]
async fn remote_delete(s: State<'_, AppState>, peer_id: String, share_id: String, path: Vec<String>) -> CmdResult<()> {
    s.core.remote_delete(&peer_id, &share_id, path).await.map_err(err)
}

#[tauri::command]
fn set_share_active(s: State<AppState>, id: String, active: bool) -> CmdResult<()> {
    s.core.set_share_active(&id, active).map_err(err)
}

#[tauri::command]
fn delete_share(s: State<AppState>, id: String) -> CmdResult<()> {
    s.core.delete_share(&id).map_err(err)
}

#[tauri::command]
async fn create_invitation(
    s: State<'_, AppState>,
    share_id: String,
    expires_in_secs: u64,
    max_uses: Option<u32>,
    require_approval: bool,
    with_code: bool,
    permission: Option<String>,
) -> CmdResult<CreatedInvitation> {
    s.core
        .create_invitation_with(&share_id, expires_in_secs, max_uses, require_approval, with_code, permission)
        .await
        .map_err(err)
}

#[tauri::command]
fn revoke_invitation(s: State<AppState>, id: String) -> CmdResult<()> {
    s.core.revoke_invitation(&id).map_err(err)
}

#[tauri::command]
fn list_grants(s: State<AppState>) -> CmdResult<Vec<GrantDto>> {
    s.core.list_grants().map_err(err)
}

#[tauri::command]
fn revoke_device(s: State<AppState>, peer_id: String) -> CmdResult<()> {
    s.core.revoke_device(&peer_id).map_err(err)
}

#[tauri::command]
fn pending_requests(s: State<AppState>) -> Vec<AccessRequest> {
    s.core.pending_requests()
}

#[tauri::command]
fn respond_access(s: State<AppState>, id: String, approve: bool) -> CmdResult<()> {
    s.core.respond_access(&id, approve).map_err(err)
}

#[tauri::command]
async fn join(s: State<'_, AppState>, input: String) -> CmdResult<JoinResult> {
    s.core.join(&input).await.map_err(err)
}

#[tauri::command]
fn list_remotes(s: State<AppState>) -> CmdResult<Vec<RemoteDto>> {
    s.core.list_remotes().map_err(err)
}

#[tauri::command]
async fn remove_remote(s: State<'_, AppState>, peer_id: String) -> CmdResult<()> {
    s.core.remove_remote(&peer_id).await.map_err(err)
}

#[tauri::command]
async fn connect_remote(s: State<'_, AppState>, peer_id: String) -> CmdResult<PeerStatus> {
    s.core.connect_remote(&peer_id).await.map_err(err)
}

#[tauri::command]
async fn list_remote_dir(
    s: State<'_, AppState>,
    peer_id: String,
    share_id: String,
    path: Vec<String>,
    offset: u32,
    limit: u32,
) -> CmdResult<ListResult> {
    s.core.list_remote_dir(&peer_id, &share_id, path, offset, limit).await.map_err(err)
}

#[tauri::command]
async fn start_download(
    s: State<'_, AppState>,
    peer_id: String,
    share_id: String,
    items: Vec<DownloadItem>,
    dest_dir: Option<String>,
) -> CmdResult<Vec<String>> {
    s.core.start_download(&peer_id, &share_id, items, dest_dir).await.map_err(err)
}

#[tauri::command]
fn list_jobs(s: State<AppState>) -> CmdResult<Vec<JobSnapshot>> {
    s.core.list_jobs().map_err(err)
}

#[tauri::command]
async fn pause_job(s: State<'_, AppState>, id: String) -> CmdResult<()> {
    s.core.pause_job(&id).await.map_err(err)
}

#[tauri::command]
async fn resume_job(s: State<'_, AppState>, id: String) -> CmdResult<()> {
    s.core.resume_job(&id).await.map_err(err)
}

#[tauri::command]
async fn restart_job(s: State<'_, AppState>, id: String) -> CmdResult<()> {
    s.core.restart_job(&id).await.map_err(err)
}

#[tauri::command]
async fn cancel_job(s: State<'_, AppState>, id: String, delete_partial: bool) -> CmdResult<()> {
    s.core.cancel_job(&id, delete_partial).await.map_err(err)
}

#[tauri::command]
async fn remove_job(s: State<'_, AppState>, id: String) -> CmdResult<()> {
    s.core.remove_job(&id).await.map_err(err)
}

#[tauri::command]
fn list_activity(s: State<AppState>, limit: u32) -> CmdResult<Vec<ActivityDto>> {
    s.core.list_activity(limit).map_err(err)
}

#[tauri::command]
fn list_history(s: State<AppState>, since_ms: i64) -> CmdResult<Vec<HistoryDto>> {
    s.core.list_history(since_ms).map_err(err)
}

#[tauri::command]
fn clear_history(s: State<AppState>) -> CmdResult<()> {
    s.core.clear_history().map_err(err)
}

#[tauri::command]
fn list_outgoing(s: State<AppState>) -> Vec<OutgoingDto> {
    s.core.list_outgoing()
}

#[tauri::command]
fn clear_outgoing(s: State<AppState>) {
    s.core.clear_outgoing()
}

#[tauri::command]
fn pause_outgoing(s: State<AppState>, id: String) -> CmdResult<()> {
    s.core.pause_outgoing(&id).map_err(err)
}

#[tauri::command]
fn resume_outgoing(s: State<AppState>, id: String) -> CmdResult<()> {
    s.core.resume_outgoing(&id).map_err(err)
}

#[tauri::command]
fn cancel_outgoing(s: State<AppState>, id: String) -> CmdResult<()> {
    s.core.cancel_outgoing(&id).map_err(err)
}

#[tauri::command]
fn remove_outgoing(s: State<AppState>, id: String) {
    s.core.remove_outgoing(&id)
}

/// Shows the file in the system file manager (Explorer, Finder, or the desktop's file app).
#[tauri::command]
fn reveal_path(path: String) -> CmdResult<()> {
    let p = PathBuf::from(&path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("explorer.exe");
        if p.is_file() {
            cmd.raw_arg(format!("/select,\"{}\"", p.display()));
        } else {
            cmd.arg(&p);
        }
        cmd.spawn().map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("open");
        if p.is_file() {
            cmd.arg("-R");
        }
        cmd.arg(&p);
        cmd.spawn().map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(target_os = "android")]
    {
        let _ = p;
        Err("Use Open on Android.".into())
    }
    #[cfg(not(any(windows, target_os = "android", target_os = "macos")))]
    {
        let target = if p.is_file() { p.parent().map(PathBuf::from).unwrap_or(p) } else { p };
        std::process::Command::new("xdg-open").arg(target).spawn().map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalDir {
    path: String,
    parent: Option<String>,
    dirs: Vec<String>,
    /// Files with their sizes, for picking files to upload.
    files: Vec<LocalFile>,
    root: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalFile {
    name: String,
    size: u64,
}

/// Root for the in-app folder picker (Android has no native folder picker that
/// returns real paths; desktop uses the system dialog instead).
fn storage_root() -> PathBuf {
    if cfg!(target_os = "android") {
        PathBuf::from("/storage/emulated/0")
    } else {
        std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/"))
    }
}

#[tauri::command]
fn list_local_dir(path: Option<String>) -> CmdResult<LocalDir> {
    let root = storage_root();
    let dir = path.filter(|p| !p.trim().is_empty()).map(PathBuf::from).unwrap_or_else(|| root.clone());
    let rd = std::fs::read_dir(&dir).map_err(|e| {
        if e.kind() == std::io::ErrorKind::PermissionDenied {
            "Bifrost doesn't have permission to read this folder. Allow \"All files access\" in Settings.".to_string()
        } else {
            format!("Can't open {}: {e}", dir.display())
        }
    })?;
    let mut dirs: Vec<String> = Vec::new();
    let mut files: Vec<LocalFile> = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        match e.file_type() {
            Ok(t) if t.is_dir() => dirs.push(name),
            Ok(t) if t.is_file() => files.push(LocalFile { name, size: e.metadata().map(|m| m.len()).unwrap_or(0) }),
            _ => {}
        }
    }
    dirs.sort_by_key(|a| a.to_lowercase());
    files.sort_by_key(|f| f.name.to_lowercase());
    let parent = if dir == root { None } else { dir.parent().map(|p| p.to_string_lossy().to_string()) };
    Ok(LocalDir {
        path: dir.to_string_lossy().to_string(),
        parent,
        dirs,
        files,
        root: root.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn make_dir(parent: String, name: String) -> CmdResult<String> {
    let name = bifrost_core::util::sanitize_filename(name.trim());
    let p = PathBuf::from(parent).join(name);
    std::fs::create_dir_all(&p).map_err(|e| format!("Couldn't create the folder: {e}"))?;
    Ok(p.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------- Android

/// Writes one line to logcat (used by the CI emulator smoke test).
#[cfg(target_os = "android")]
fn logcat(msg: &str) {
    use std::ffi::CString;
    extern "C" {
        fn __android_log_write(prio: i32, tag: *const std::ffi::c_char, text: *const std::ffi::c_char) -> i32;
    }
    let tag = CString::new("Bifrost").unwrap_or_default();
    let text = CString::new(msg.replace('\0', "")).unwrap_or_default();
    // 4 = ANDROID_LOG_INFO
    unsafe {
        __android_log_write(4, tag.as_ptr(), text.as_ptr());
    }
}

/// Keeps a foreground service (with a live notification) running while files
/// are moving, so Android doesn't suspend transfers when the screen turns off.
/// The service lingers two minutes after activity stops to bridge short gaps.
#[cfg(target_os = "android")]
fn spawn_service_controller(app: AppHandle, core: Core) {
    use std::time::{Duration, Instant};
    use bifrost_core::{util::human_bytes, UploadDto};

    tauri::async_runtime::spawn(async move {
        let mut rx = core.subscribe();
        let mut tick = tokio::time::interval(Duration::from_secs(2));
        let mut uploads: Vec<UploadDto> = Vec::new();
        // Files this phone is uploading into others' shares.
        let mut pushing: usize = 0;
        // Files others are uploading into this phone's shares.
        let mut arriving: usize = 0;
        let mut shown: Option<(String, String)> = None;
        let mut last_active = Instant::now() - Duration::from_secs(3600);
        loop {
            tokio::select! {
                ev = rx.recv() => match ev {
                    Ok(CoreEvent::Uploads(u)) => uploads = u,
                    Ok(CoreEvent::Pushes(p)) => {
                        pushing = p.iter().filter(|x| matches!(x.status.as_str(), "queued" | "uploading" | "retrying")).count();
                    }
                    Ok(CoreEvent::Incoming(i)) => {
                        arriving = i.iter().filter(|x| x.status == "receiving").count();
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    _ => {}
                },
                _ = tick.tick() => {
                    let jobs = core.list_jobs().unwrap_or_default();
                    let active: Vec<&JobSnapshot> = jobs.iter().filter(|j| j.status.auto_runs()).collect();
                    let down: f64 = active.iter().map(|j| j.speed_bps).sum();
                    let up: f64 = uploads.iter().map(|u| u.bps).sum();
                    let want = if !active.is_empty() || !uploads.is_empty() || pushing > 0 || arriving > 0 {
                        last_active = Instant::now();
                        let title = match (active.len(), uploads.len()) {
                            (0, 0) if pushing == 0 => format!("Receiving {arriving} upload{}", if arriving == 1 { "" } else { "s" }),
                            (0, 0) => format!("Uploading {pushing} file{}", if pushing == 1 { "" } else { "s" }),
                            (0, _) => format!("Sending to {}", uploads[0].device_name),
                            (1, 0) => format!("Receiving {}", active[0].display_name),
                            (n, 0) => format!("Receiving {n} files"),
                            _ => "Receiving and sending".to_string(),
                        };
                        let done: u64 = active.iter().map(|j| j.done_bytes).sum();
                        let total: u64 = active.iter().map(|j| j.size).sum();
                        let mut parts = Vec::new();
                        if down > 1.0 { parts.push(format!("↓ {}/s", human_bytes(down as u64))); }
                        if up > 1.0 { parts.push(format!("↑ {}/s", human_bytes(up as u64))); }
                        if total > 0 { parts.push(format!("{} of {}", human_bytes(done), human_bytes(total))); }
                        if down < 1.0 && up < 1.0 && !active.is_empty() {
                            parts.push("Waiting for the other computer".into());
                        }
                        Some((title, parts.join(" · ")))
                    } else if last_active.elapsed() < Duration::from_secs(120) {
                        Some(("Bifrost".to_string(), "Ready. Transfers finished or paused.".to_string()))
                    } else {
                        None
                    };
                    if want != shown {
                        let app2 = app.clone();
                        let w = want.clone();
                        let _ = tauri::async_runtime::spawn_blocking(move || {
                            let plugin = app2.bifrost_android();
                            match w {
                                Some((t, x)) => plugin.set_service(t, x),
                                None => plugin.stop_service(),
                            }
                        })
                        .await;
                        shown = want;
                    }
                }
            }
        }
    });
}

// ---------------------------------------------------------------------- entry point

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ));
    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_bifrost_android::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            init_logging(&data_dir.join("logs"));

            #[cfg(target_os = "android")]
            let (downloads, name) = {
                let model = app.bifrost_android().device_info().map(|d| d.model).unwrap_or_default();
                (
                    PathBuf::from("/storage/emulated/0/Download/Bifrost"),
                    if model.trim().is_empty() { "Android phone".to_string() } else { model },
                )
            };
            #[cfg(not(target_os = "android"))]
            let (downloads, name) = (
                app.path()
                    .download_dir()
                    .map(|d| d.join("Bifrost"))
                    .unwrap_or_else(|_| data_dir.join("Downloads")),
                device_name(),
            );

            let core = tauri::async_runtime::block_on(Core::start(CoreOptions {
                data_dir: data_dir.clone(),
                default_device_name: name,
                default_download_dir: downloads,
                local_only: false,
                // Per-transfer summaries in <app data>/diagnostics; BIFROST_DIAG=0 turns them off.
                diagnostics: true,
                endpoint_hook: None,
            }))
            .map_err(|e| -> Box<dyn std::error::Error> { e.to_string().into() })?;
            bifrost_core::set_low_priority(core.settings().low_priority);
            tracing::info!("Bifrost {} started as {}", env!("CARGO_PKG_VERSION"), core.endpoint_id());
            #[cfg(target_os = "android")]
            logcat(&format!("Bifrost engine started as {}", core.endpoint_id()));

            // Forward engine events to the UI and to system notifications.
            let handle = app.handle().clone();
            let mut rx = core.subscribe();
            tauri::async_runtime::spawn(async move {
                loop {
                    match rx.recv().await {
                        Ok(ev) => {
                            if let CoreEvent::Notify { title, body } = &ev {
                                let _ = handle.notification().builder().title(title).body(body).show();
                                continue;
                            }
                            // Only emit when a window exists; nothing to render otherwise.
                            if handle.get_webview_window("main").is_some() {
                                let _ = handle.emit(ev.name(), ev.payload());
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(_) => break,
                    }
                }
            });
            #[cfg(target_os = "android")]
            spawn_service_controller(app.handle().clone(), core.clone());
            app.manage(AppState { core });

            #[cfg(desktop)]
            {
                // Tray icon: transfers keep running when the window is closed.
                let open = MenuItem::with_id(app, "open", "Open Bifrost", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "Quit (stops transfers)", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&open, &quit])?;
                let mut tray = TrayIconBuilder::with_id("main")
                    .tooltip("Bifrost")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "open" => show_main(app),
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            show_main(tray.app_handle());
                        }
                    });
                if let Some(icon) = app.default_window_icon() {
                    tray = tray.icon(icon.clone());
                }
                tray.build(app)?;

                // Start with Windows by default, once: after that the user's
                // choice in Settings sticks.
                {
                    use tauri_plugin_autostart::ManagerExt;
                    let state = app.state::<AppState>();
                    let mut s = state.core.settings();
                    if !s.autostart_v1 {
                        match app.autolaunch().enable() {
                            Ok(()) => tracing::info!("enabled start at sign-in"),
                            Err(e) => tracing::warn!("couldn't enable start at sign-in: {e}"),
                        }
                        s.autostart_v1 = true;
                        let _ = state.core.update_settings(s);
                    }
                }

                if !std::env::args().any(|a| a == "--minimized") {
                    show_main(app.handle());
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            network_status,
            update_settings,
            list_shares,
            create_share,
            set_device_permission,
            start_upload,
            list_pushes,
            cancel_push,
            retry_push,
            remove_push,
            clear_pushes,
            list_syncs,
            enable_sync,
            disable_sync,
            sync_now,
            list_incoming,
            remove_incoming,
            clear_incoming,
            remote_mkdir,
            remote_delete,
            set_share_active,
            delete_share,
            create_invitation,
            revoke_invitation,
            list_grants,
            revoke_device,
            pending_requests,
            respond_access,
            join,
            list_remotes,
            remove_remote,
            connect_remote,
            list_remote_dir,
            start_download,
            list_jobs,
            pause_job,
            resume_job,
            restart_job,
            cancel_job,
            remove_job,
            list_activity,
            list_history,
            clear_history,
            list_outgoing,
            clear_outgoing,
            pause_outgoing,
            resume_outgoing,
            cancel_outgoing,
            remove_outgoing,
            reveal_path,
            list_local_dir,
            make_dir,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Bifrost");

    app.run(|app, event| match event {
        #[cfg(desktop)]
        RunEvent::ExitRequested { api, code, .. } => {
            // The last window closing is not a request to quit: keep running in the tray.
            if code.is_none() {
                let keep = app.try_state::<AppState>().map(|s| s.core.settings().close_to_tray).unwrap_or(true);
                if keep {
                    api.prevent_exit();
                }
            }
        }
        RunEvent::Exit => {
            if let Some(s) = app.try_state::<AppState>() {
                let core = s.core.clone();
                tauri::async_runtime::block_on(core.shutdown());
            }
        }
        _ => {}
    });
}
