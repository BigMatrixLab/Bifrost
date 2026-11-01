//! Bifrost core: direct, encrypted, resumable, verified file transfer.

mod db;
pub mod diag;
pub mod flow;
mod inner;
pub mod mmc;

/// `expires_at` of an invitation that never expires: 9999-12-31T23:59:59Z.
/// Still below 2^53, so it survives JSON in the UI as an exact number.
pub const NEVER_EXPIRES_MS: i64 = 253_402_300_799_000;
pub mod invite;
mod net;
pub mod proto;
mod receiver;
mod notice;
mod push;
mod sender;
mod sync;
pub mod types;
mod upload;
pub mod util;
pub mod words;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use iroh::endpoint::{presets, VarInt};
use iroh::{Endpoint, EndpointAddr, EndpointId, SecretKey};
use parking_lot::{Mutex, RwLock};
use serde::Deserialize;
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use tracing::warn;

use crate::db::{Db, InvitationRow, JobRow, ShareRow};
use crate::inner::{Inner, JobSlots, ShortCode};
use crate::invite::Invite;
use crate::net::route_of;
use crate::proto::{HelloStatus, Request, Response};
use crate::receiver::{get_conn, request, snapshot, spawn_job, JobError, StopReason};
use crate::util::{now_ms, random_id, sanitize_filename, short_peer, RateLimiter};

pub use crate::types::*;

pub struct CoreOptions {
    pub data_dir: PathBuf,
    pub default_device_name: String,
    pub default_download_dir: PathBuf,
    /// Loopback-only endpoint without relays or lookup (tests).
    pub local_only: bool,
    /// Write per-transfer diagnostic summaries to `<data_dir>/diagnostics/`
    /// and log interval/summary lines. The `RELAYLESS_DIAG` environment
    /// variable (0/1) overrides this.
    pub diagnostics: bool,
    /// Test-only: builds the endpoint from `presets::Minimal` (with this
    /// app's secret key, ALPN and QUIC transport settings already applied)
    /// and lets the caller adjust it, e.g. to use a local, rate-limited relay
    /// and no direct paths. `None` in the app.
    #[doc(hidden)]
    pub endpoint_hook: Option<EndpointHook>,
}

/// See [`CoreOptions::endpoint_hook`].
pub type EndpointHook = Box<dyn FnOnce(iroh::endpoint::Builder) -> iroh::endpoint::Builder + Send>;

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DownloadItem {
    pub path: Vec<String>,
    pub is_dir: bool,
}

#[derive(Clone)]
pub struct Core {
    inner: Arc<Inner>,
}

fn load_or_create_key(path: &Path) -> Result<SecretKey> {
    if let Ok(bytes) = std::fs::read(path) {
        if bytes.len() == 32 {
            let mut b = [0u8; 32];
            b.copy_from_slice(&bytes);
            return Ok(SecretKey::from_bytes(&b));
        }
    }
    let key = SecretKey::generate();
    std::fs::write(path, key.to_bytes()).context("saving device identity")?;
    Ok(key)
}

fn je(e: JobError) -> anyhow::Error {
    anyhow!("{e}")
}

impl Core {
    pub async fn start(opts: CoreOptions) -> Result<Core> {
        std::fs::create_dir_all(&opts.data_dir)?;
        let db = Db::open(&opts.data_dir.join("relayless.db"))?;
        let mut settings = db.load_settings().unwrap_or_default();
        if !settings.route_v2 {
            // Direct-only used to be the default, which leaves transfers stuck
            // at 0 when routers block a direct path. Move to direct-first with
            // encrypted relay fallback once; users can switch back in Settings.
            settings.connection_mode = "allow_relay".into();
            settings.route_v2 = true;
        }
        if !settings.congestion_v2 {
            // BBRv3 used to be the default. noq-proto's (experimental) BBRv3
            // can sit at its 4-packet minimum window for minutes without any
            // loss, and on loopback it ran 2-4x slower than Cubic and hung in
            // 2 of 3 benchmark sessions. Cubic's weakness, filling deep queues,
            // is now bounded by the receiver's adaptive flow window. Move once;
            // users can switch back in Settings.
            settings.congestion = "cubic".into();
            settings.congestion_v2 = true;
        }
        if !settings.tray_v2 {
            // Closing the window keeps Bifrost running in the tray, so shared
            // folders stay reachable and transfers continue. Move once; users
            // can turn it off in Settings.
            settings.close_to_tray = true;
            settings.tray_v2 = true;
        }
        if settings.device_name.trim().is_empty() {
            settings.device_name = opts.default_device_name.clone();
        }
        if settings.download_dir.trim().is_empty() {
            settings.download_dir = opts.default_download_dir.to_string_lossy().to_string();
        }
        let settings = settings.sanitized();
        db.save_settings(&settings)?;
        // Test-only: A/B congestion control on loopback without editing tests.
        // Applied to the endpoint only, never saved.
        let test_endpoint = opts.local_only || opts.endpoint_hook.is_some();
        let bind_congestion = match (test_endpoint, std::env::var("RELAYLESS_TEST_CONGESTION")) {
            (true, Ok(c)) => c,
            _ => settings.congestion.clone(),
        };
        let secret = load_or_create_key(&opts.data_dir.join("identity.key"))?;
        let endpoint = if let Some(hook) = opts.endpoint_hook {
            net::bind_custom(secret, &bind_congestion, hook).await?
        } else if opts.local_only {
            net::bind_local(secret, &bind_congestion).await?
        } else {
            net::bind_main(secret, &settings.congestion, &settings.relay_urls).await?
        };
        let congestion_active = net::congestion_name(&bind_congestion);
        let diag = diag::DiagConfig::resolve(
            opts.diagnostics,
            std::env::var(diag::ENV_VAR).ok().as_deref(),
            &opts.data_dir,
        );
        tracing::info!(
            target: "relayless_core::diag",
            "engine_config diagnostics={} congestion_active={} congestion_setting={} parallel_streams={} max_concurrent_jobs={} chunk_size_mib={} download_limit_kib_s={} upload_limit_kib_s={} connection_mode={} stream_window={} conn_window={} send_window={} max_bidi_streams={}",
            diag.enabled,
            congestion_active,
            settings.congestion,
            settings.parallel_streams,
            settings.max_concurrent_jobs,
            settings.chunk_size_mib,
            settings.download_limit_kbps,
            settings.upload_limit_kbps,
            settings.connection_mode,
            net::STREAM_WINDOW,
            net::CONN_WINDOW,
            net::SEND_WINDOW,
            net::MAX_BIDI_STREAMS,
        );
        let (events, _) = broadcast::channel(1024);
        let inner = Arc::new(Inner {
            rt: tokio::runtime::Handle::current(),
            db,
            endpoint,
            data_dir: opts.data_dir.clone(),
            upload_limiter: RateLimiter::new(util::kib_to_bytes_per_sec(settings.upload_limit_kbps)),
            download_limiter: RateLimiter::new(util::kib_to_bytes_per_sec(settings.download_limit_kbps)),
            slots: JobSlots::new(settings.max_concurrent_jobs as usize),
            diag,
            congestion_active,
            send_diags: Mutex::new(Default::default()),
            settings: RwLock::new(settings),
            events,
            shutdown: CancellationToken::new(),
            local_mode: opts.local_only,
            pending: Mutex::new(Default::default()),
            incoming: Mutex::new(Default::default()),
            failed_hellos: Mutex::new(Default::default()),
            uploads: Mutex::new(Default::default()),
            short_codes: Mutex::new(Default::default()),
            outgoing: Mutex::new(Default::default()),
            peers: Mutex::new(Default::default()),
            addr_hints: Mutex::new(Default::default()),
            jobs: Mutex::new(Default::default()),
            put_active: Mutex::new(Default::default()),
            put_lock: Mutex::new(()),
            incoming_files: Mutex::new(Default::default()),
            pushes: Mutex::new(Default::default()),
            push_slots: tokio::sync::Semaphore::new(2),
            net_wake: tokio::sync::Notify::new(),
            syncing: Mutex::new(Default::default()),
            sync_wake: tokio::sync::Notify::new(),
            peer_notices: Mutex::new(Default::default()),
        });
        prune_history(&inner);
        tokio::spawn(sender::accept_loop(inner.clone()));
        tokio::spawn(ticker(inner.clone()));
        tokio::spawn(network_watch(inner.clone()));
        if !inner.local_mode {
            tokio::spawn(republish_codes(inner.clone()));
        }
        let core = Core { inner };
        // Every unfinished transfer starts again by itself: downloads that were
        // running or waiting, and ones that stopped for a reason that may be
        // gone now (sender offline, access paused, disk full). Paused and
        // canceled ones stay as the user left them; a file that changed on
        // the sender waits for the user to choose the new version.
        for job in core.inner.db.list_jobs()? {
            let retry = job.status == JobStatus::NeedsAttention
                && !job.error.as_deref().unwrap_or("").to_lowercase().contains("changed");
            if job.status.auto_runs() || retry {
                spawn_job(&core.inner, &job.id);
            }
        }
        push::restore(&core.inner);
        tokio::spawn(sync::run(core.inner.clone()));
        Ok(core)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<CoreEvent> {
        self.inner.events.subscribe()
    }

    pub fn endpoint_id(&self) -> String {
        self.inner.endpoint.id().to_string()
    }

    /// Full dialable address (tests and diagnostics).
    pub fn endpoint_addr(&self) -> EndpointAddr {
        self.inner.endpoint.addr()
    }

    /// Tells the engine how to reach a peer directly (tests, LAN).
    pub fn add_peer_addr(&self, addr: EndpointAddr) {
        self.inner.addr_hints.lock().insert(addr.id, addr);
    }

    pub fn network_status(&self) -> NetworkStatus {
        network_status(&self.inner)
    }

    pub fn data_dir(&self) -> PathBuf {
        self.inner.data_dir.clone()
    }

    /// Folder with `transfers.jsonl` (one JSON summary per transfer), and
    /// whether diagnostics output is on.
    pub fn diagnostics(&self) -> (bool, PathBuf) {
        (self.inner.diag.enabled, self.inner.diag.dir.clone())
    }

    // ------------------------------------------------------------------ settings

    pub fn settings(&self) -> Settings {
        self.inner.settings()
    }

    pub fn update_settings(&self, s: Settings) -> Result<Settings> {
        let mut s = s.sanitized();
        let old = self.inner.settings();
        if s.device_name.is_empty() {
            s.device_name = old.device_name.clone();
        }
        if s.download_dir.trim().is_empty() {
            s.download_dir = old.download_dir.clone();
        }
        // One-time migration flags are never unset by a settings save.
        s.route_v2 |= old.route_v2;
        s.congestion_v2 |= old.congestion_v2;
        s.autostart_v1 |= old.autostart_v1;
        s.tray_v2 |= old.tray_v2;
        self.inner.db.save_settings(&s)?;
        self.inner.upload_limiter.set_rate(util::kib_to_bytes_per_sec(s.upload_limit_kbps));
        self.inner.download_limiter.set_rate(util::kib_to_bytes_per_sec(s.download_limit_kbps));
        if s.download_limit_kbps != old.download_limit_kbps
            || s.upload_limit_kbps != old.upload_limit_kbps
            || s.parallel_streams != old.parallel_streams
            || s.congestion != old.congestion
            || s.connection_mode != old.connection_mode
        {
            tracing::info!(
                target: "relayless_core::diag",
                "settings_changed download_limit_kib_s={} upload_limit_kib_s={} effective_download_bytes_s={} effective_upload_bytes_s={} parallel_streams={} connection_mode={} congestion_setting={} congestion_active={} (congestion applies after restart)",
                s.download_limit_kbps,
                s.upload_limit_kbps,
                self.inner.download_limiter.rate(),
                self.inner.upload_limiter.rate(),
                s.parallel_streams,
                s.connection_mode,
                s.congestion,
                self.inner.congestion_active,
            );
        }
        self.inner.slots.set_max(s.max_concurrent_jobs as usize);
        *self.inner.settings.write() = s.clone();
        if s.history_retention != old.history_retention && prune_history(&self.inner) > 0 {
            self.inner.emit(CoreEvent::HistoryChanged);
        }
        Ok(s)
    }

    // ------------------------------------------------------------------ shares

    fn share_dto(&self, s: &ShareRow, invs: &[InvitationRow], grants: &[db::GrantRow]) -> ShareDto {
        let now = now_ms();
        let codes = self.inner.short_codes.lock();
        ShareDto {
            id: s.id.clone(),
            name: s.name.clone(),
            root_path: s.root_path.clone(),
            active: s.active,
            created_at: s.created_at,
            invitations: invs
                .iter()
                .filter(|i| i.share_id == s.id)
                .map(|i| inv_dto(i, now, codes.get(&i.id).map(|c| c.code.clone())))
                .collect(),
            device_count: grants.iter().filter(|g| g.share_id == s.id).count() as u32,
        }
    }

    pub fn list_shares(&self) -> Result<Vec<ShareDto>> {
        let invs = self.inner.db.list_invitations()?;
        let grants = self.inner.db.list_grants()?;
        Ok(self.inner.db.list_shares()?.iter().map(|s| self.share_dto(s, &invs, &grants)).collect())
    }

    /// Shares a folder. What each invited device may do is set per
    /// invitation (and can be changed per device), not per folder.
    pub fn create_share(&self, path: &str, name: Option<String>) -> Result<ShareDto> {
        let p = std::fs::canonicalize(path).map_err(|_| anyhow!("That folder doesn't exist."))?;
        if !p.is_dir() {
            bail!("Choose a folder, not a file.");
        }
        let display = strip_verbatim(&p);
        if Path::new(&display).parent().is_none() || display.trim_end_matches(['\\', '/']).ends_with(':') {
            bail!("Choose a specific folder rather than a whole drive.");
        }
        let existing = self.inner.db.list_shares()?;
        if let Some(s) = existing.iter().find(|s| Path::new(&s.root_path) == Path::new(&display)) {
            self.inner.db.set_share_active(&s.id, true)?;
            self.inner.emit(CoreEvent::SharesChanged);
            return self
                .list_shares()?
                .into_iter()
                .find(|d| d.id == s.id)
                .ok_or_else(|| anyhow!("share vanished"));
        }
        let name = name
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "Shared folder".into()));
        let row = ShareRow { id: random_id(), root_path: display, name: name.clone(), active: true, created_at: now_ms() };
        self.inner.db.insert_share(&row)?;
        self.inner.log("info", &format!("Started sharing \"{name}\""), None);
        self.inner.emit(CoreEvent::SharesChanged);
        Ok(self.share_dto(&row, &[], &[]))
    }

    /// Changes what one device may do in one share. Applies to its next
    /// request; an upload in progress stops if uploading is no longer allowed.
    pub fn set_device_permission(&self, peer_id: &str, share_id: &str, permission: &str) -> Result<()> {
        let perm = normalize_permission(permission);
        let grant = self
            .inner
            .db
            .list_grants()?
            .into_iter()
            .find(|g| g.peer_id == peer_id && g.share_id == share_id)
            .ok_or_else(|| anyhow!("That device no longer has access to this folder."))?;
        if grant.permission != perm {
            self.inner.db.set_grant_permission(peer_id, share_id, perm)?;
            let share = self.inner.db.get_share(share_id)?.map(|s| s.name).unwrap_or_default();
            self.inner.log("info", &format!("{} can now {} in \"{share}\"", grant.device_name, permission_verb(perm)), None);
            self.inner.emit(CoreEvent::GrantsChanged);
        }
        Ok(())
    }
    pub fn set_share_active(&self, id: &str, active: bool) -> Result<()> {
        self.inner.db.set_share_active(id, active)?;
        if !active {
            self.close_peers_of_share(id);
        }
        let name = self.inner.db.get_share(id)?.map(|s| s.name).unwrap_or_default();
        self.inner.log("info", &format!("{} sharing \"{name}\"", if active { "Resumed" } else { "Stopped" }), None);
        self.inner.emit(CoreEvent::SharesChanged);
        Ok(())
    }

    pub fn delete_share(&self, id: &str) -> Result<()> {
        self.close_peers_of_share(id);
        for i in self.inner.db.list_invitations()?.iter().filter(|i| i.share_id == id) {
            self.drop_code(&i.id);
        }
        self.inner.db.delete_share(id)?;
        self.inner.emit(CoreEvent::SharesChanged);
        self.inner.emit(CoreEvent::GrantsChanged);
        Ok(())
    }

    /// Ends live sessions of peers whose access depended on this share.
    fn close_peers_of_share(&self, share_id: &str) {
        let grants = self.inner.db.list_grants().unwrap_or_default();
        let shares = self.inner.db.list_shares().unwrap_or_default();
        let peers: HashSet<String> = grants.iter().filter(|g| g.share_id == share_id).map(|g| g.peer_id.clone()).collect();
        for peer in peers {
            let still = grants.iter().any(|g| {
                g.peer_id == peer && g.share_id != share_id && shares.iter().any(|s| s.id == g.share_id && s.active)
            });
            if !still {
                self.close_incoming(&peer, b"sharing stopped");
            }
        }
    }

    fn close_incoming(&self, peer: &str, reason: &[u8]) {
        if let Ok(id) = peer.parse::<EndpointId>() {
            if let Some(conns) = self.inner.incoming.lock().get(&id) {
                for (_, c) in conns {
                    c.close(VarInt::from_u32(403), reason);
                }
            }
        }
    }

    // ------------------------------------------------------------------ invitations

    /// An invitation with the default permission from Settings.
    pub async fn create_invitation(
        &self,
        share_id: &str,
        expires_in_secs: u64,
        max_uses: Option<u32>,
        require_approval: bool,
        with_code: bool,
    ) -> Result<CreatedInvitation> {
        self.create_invitation_with(share_id, expires_in_secs, max_uses, require_approval, with_code, None).await
    }

    /// An invitation whose devices get `permission` ("download", "upload" or
    /// "both"; the default from Settings when `None`).
    pub async fn create_invitation_with(
        &self,
        share_id: &str,
        expires_in_secs: u64,
        max_uses: Option<u32>,
        require_approval: bool,
        with_code: bool,
        permission: Option<String>,
    ) -> Result<CreatedInvitation> {
        let permission =
            normalize_permission(&permission.unwrap_or_else(|| self.inner.settings().default_share_permission)).to_string();
        let share = self.inner.db.get_share(share_id)?.ok_or_else(|| anyhow!("Unknown share."))?;
        if !share.active {
            bail!("Resume sharing this folder first.");
        }
        let token = invite::new_token();
        let invite = Invite {
            endpoint_id: self.inner.endpoint.id(),
            token,
            relay_url: self.inner.endpoint.addr().relay_urls().next().cloned(),
        };
        let now = now_ms();
        // 0 = no expiry: stored as a far-future date, so every existing check
        // (`expires_at <= now`) keeps working and no schema change is needed.
        let expires_at = if expires_in_secs == 0 {
            NEVER_EXPIRES_MS
        } else {
            now + (expires_in_secs.clamp(300, 30 * 24 * 3600) as i64) * 1000
        };
        let row = InvitationRow {
            id: random_id(),
            share_id: share.id.clone(),
            token_hash: invite::token_hash(&invite.token_hex()),
            expires_at,
            max_uses: max_uses.filter(|m| *m > 0),
            use_count: 0,
            require_approval,
            revoked_at: None,
            created_at: now,
            permission,
        };
        self.inner.db.insert_invitation(&row)?;
        let encoded = invite.encode();
        let mut short_code = None;
        if with_code && !self.inner.local_mode {
            // The code is the invitation people share, so without it the
            // invitation is useless: undo it and report the error.
            match self.new_code(&invite, &row.id).await {
                Ok(c) => short_code = Some(c),
                Err(e) => {
                    let _ = self.inner.db.revoke_invitation(&row.id);
                    warn!("invitation code unavailable: {e:#}");
                    bail!("Couldn't create the invitation code. Check that this computer is online and try again.");
                }
            }
        }
        self.inner.log(
            "info",
            &format!("Created an invitation for \"{}\" ({})", share.name, permission_text(&row.permission)),
            None,
        );
        self.inner.emit(CoreEvent::SharesChanged);
        Ok(CreatedInvitation {
            invitation: inv_dto(&row, now, short_code.clone()),
            // The QR carries the code when there is one: short, and scannable anywhere.
            qr_svg: invite::qr_svg(short_code.as_deref().unwrap_or(&encoded)),
            invite: encoded,
            short_code_expires_at: short_code.as_ref().map(|_| expires_at),
            short_code,
        })
    }

    /// Creates the 16-character code for an invitation, saves it so it can be
    /// published again after a restart, and starts publishing it.
    async fn new_code(&self, invite: &Invite, invitation_id: &str) -> Result<String> {
        let code = invite::new_short_code();
        let c2 = code.clone();
        let (_, key) = tokio::task::spawn_blocking(move || invite::derive_code_keys(&c2)).await??;
        let sealed = invite::seal_for_code(invite, &key)?;
        publish_code(&self.inner, invitation_id, &code, &sealed).await?;
        self.inner.db.save_invitation_code(invitation_id, &code, &sealed)?;
        Ok(code)
    }

    fn drop_code(&self, invitation_id: &str) {
        let _ = self.inner.db.delete_invitation_code(invitation_id);
        if let Some(sc) = self.inner.short_codes.lock().remove(invitation_id) {
            self.inner.rt.spawn(async move { sc.endpoint.close().await });
        }
    }

    pub fn revoke_invitation(&self, id: &str) -> Result<()> {
        self.inner.db.revoke_invitation(id)?;
        self.drop_code(id);
        self.inner.log("info", "Revoked an invitation", None);
        self.inner.emit(CoreEvent::SharesChanged);
        Ok(())
    }

    // ------------------------------------------------------------------ devices with access (sender)

    pub fn list_grants(&self) -> Result<Vec<GrantDto>> {
        let shares = self.inner.db.list_shares()?;
        let incoming = self.inner.incoming.lock();
        Ok(self
            .inner
            .db
            .list_grants()?
            .into_iter()
            .map(|g| {
                let conn = g
                    .peer_id
                    .parse::<EndpointId>()
                    .ok()
                    .and_then(|id| incoming.get(&id).and_then(|v| v.last().map(|(_, c)| c.clone())));
                let share_name = shares.iter().find(|s| s.id == g.share_id).map(|s| s.name.clone()).unwrap_or_default();
                GrantDto {
                    safety_words: self.words_with(&g.peer_id),
                    peer_short: short_peer(&g.peer_id),
                    peer_id: g.peer_id,
                    device_name: g.device_name,
                    share_id: g.share_id,
                    share_name,
                    created_at: g.created_at,
                    last_seen_at: g.last_seen_at,
                    connected: conn.is_some(),
                    route: conn.as_ref().map(route_of).unwrap_or_else(RouteInfo::none),
                    permission: g.permission,
                }
            })
            .collect())
    }

    pub fn revoke_device(&self, peer_id: &str) -> Result<()> {
        let name = self
            .inner
            .db
            .list_grants()?
            .into_iter()
            .find(|g| g.peer_id == peer_id)
            .map(|g| g.device_name)
            .unwrap_or_else(|| short_peer(peer_id));
        self.inner.db.delete_grants_for_peer(peer_id)?;
        self.close_incoming(peer_id, b"access revoked");
        self.inner.log("warning", &format!("Removed access for {name}"), None);
        self.inner.emit(CoreEvent::GrantsChanged);
        self.inner.emit(CoreEvent::SharesChanged);
        Ok(())
    }

    pub fn pending_requests(&self) -> Vec<AccessRequest> {
        self.inner.pending.lock().values().map(|p| p.request.clone()).collect()
    }

    pub fn respond_access(&self, id: &str, approve: bool) -> Result<()> {
        let p = self.inner.pending.lock().remove(id).ok_or_else(|| anyhow!("That request is no longer waiting."))?;
        let _ = p.respond.send(approve);
        self.inner.emit(CoreEvent::AccessResolved(id.to_string()));
        Ok(())
    }

    // ------------------------------------------------------------------ joining (receiver)

    async fn resolve_code(&self, code: &str) -> Result<Invite> {
        use n0_future::StreamExt;
        let c2 = code.to_string();
        let (sk, key) = tokio::task::spawn_blocking(move || invite::derive_code_keys(&c2)).await??;
        let id = sk.public();
        let lookup = self.inner.endpoint.address_lookup().map_err(|e| anyhow!("{e}"))?;
        for attempt in 0..6 {
            let mut stream = lookup.resolve(id);
            let found = tokio::time::timeout(Duration::from_secs(10), async {
                while let Some(item) = stream.next().await {
                    if let Ok(Ok(item)) = item {
                        if let Some(ud) = item.user_data() {
                            return Some(ud.to_string());
                        }
                    }
                }
                None
            })
            .await
            .ok()
            .flatten();
            if let Some(sealed) = found {
                return invite::open_from_code(&sealed, &key);
            }
            if attempt < 5 {
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
        }
        bail!("No invitation found for that code. Check it with the sender: codes only work while Bifrost is open and online on their computer, and until the invitation expires or is revoked.")
    }

    pub async fn join(&self, input: &str) -> Result<JoinResult> {
        let input = input.trim();
        let inv = if invite::is_short_code(input) {
            self.inner.emit(CoreEvent::JoinStatus { message: "Looking up the code…".into(), safety_words: None });
            self.resolve_code(input).await?
        } else {
            Invite::decode(input)?
        };
        if inv.endpoint_id == self.inner.endpoint.id() {
            bail!("That invitation was created on this computer. Open it on the receiving computer instead.");
        }
        let peer = inv.endpoint_id;
        let mut addr = self
            .inner
            .addr_hints
            .lock()
            .get(&peer)
            .cloned()
            .unwrap_or_else(|| EndpointAddr::new(peer));
        if let Some(u) = &inv.relay_url {
            addr = addr.with_relay_url(u.clone());
        }
        let words = words::safety_words(self.inner.endpoint.id().as_bytes(), peer.as_bytes());
        self.inner.emit(CoreEvent::JoinStatus { message: "Connecting to the sender…".into(), safety_words: Some(words.clone()) });
        let conn = tokio::time::timeout(Duration::from_secs(40), self.inner.endpoint.connect(addr, proto::ALPN))
            .await
            .map_err(|_| anyhow!("Couldn't reach the sender. Make sure Bifrost is open on their computer and both of you are online."))?
            .map_err(|e| anyhow!("Couldn't reach the sender: {e}"))?;
        let device = self.inner.settings.read().device_name.clone();
        let inner = self.inner.clone();
        let w2 = words.clone();
        let hello = receiver::hello(&conn, Some(inv.token_hex()), &device, move |h| {
            inner.emit(CoreEvent::JoinStatus {
                message: h.message.clone().unwrap_or_else(|| "Waiting for the sender to approve this device…".into()),
                safety_words: Some(w2.clone()),
            });
        })
        .await
        .map_err(je)?;
        if hello.status != HelloStatus::Approved {
            conn.close(VarInt::from_u32(0), b"denied");
            bail!("{}", hello.message.unwrap_or_else(|| "The sender didn't accept this device.".into()));
        }
        let peer_s = peer.to_string();
        self.inner
            .db
            .upsert_remote(&peer_s, &hello.sender_name, inv.relay_url.as_ref().map(|u| u.to_string()).as_deref())?;
        let shares = receiver::wire_shares(&hello.shares);
        self.inner.db.set_remote_shares(&peer_s, &shares)?;
        receiver::adopt_conn(&self.inner, peer, conn);
        self.inner.log("success", &format!("Paired with {}", hello.sender_name), None);
        self.inner.emit(CoreEvent::RemotesChanged);
        Ok(JoinResult {
            peer_id: peer_s,
            sender_name: hello.sender_name,
            shares: shares.into_iter().map(|(id, name, permission)| RemoteShareDto { id, name, permission }).collect(),
            safety_words: words,
        })
    }

    /// Safety words for this device and another, or none for a bad id.
    fn words_with(&self, peer_id: &str) -> Vec<String> {
        peer_id
            .parse::<EndpointId>()
            .map(|p| words::safety_words(self.inner.endpoint.id().as_bytes(), p.as_bytes()))
            .unwrap_or_default()
    }

    // ------------------------------------------------------------------ history

    /// Finished transfers kept on this device, newest first.
    pub fn list_history(&self, since_ms: i64) -> Result<Vec<HistoryDto>> {
        let mut rows = self.inner.db.list_history(since_ms)?;
        let mut cache: std::collections::HashMap<String, Vec<String>> = Default::default();
        for r in &mut rows {
            r.safety_words = cache.entry(r.peer_id.clone()).or_insert_with(|| self.words_with(&r.peer_id)).clone();
        }
        Ok(rows)
    }

    pub fn clear_history(&self) -> Result<()> {
        self.inner.db.prune_history(i64::MAX)?;
        self.inner.log("info", "Cleared transfer history on this device", None);
        self.inner.emit(CoreEvent::HistoryChanged);
        Ok(())
    }

    // ------------------------------------------------------------------ remotes (receiver)

    pub fn list_remotes(&self) -> Result<Vec<RemoteDto>> {
        let peers = self.inner.peers.lock();
        Ok(self
            .inner
            .db
            .list_remotes()?
            .into_iter()
            .map(|(r, shares)| {
                let status = r
                    .peer_id
                    .parse::<EndpointId>()
                    .ok()
                    .and_then(|id| peers.get(&id).map(|p| p.status.lock().clone()))
                    .unwrap_or_else(|| PeerStatus {
                        peer_id: r.peer_id.clone(),
                        state: "disconnected".into(),
                        route: RouteInfo::none(),
                        message: None,
                    });
                RemoteDto {
                    safety_words: self.words_with(&r.peer_id),
                    peer_short: short_peer(&r.peer_id),
                    peer_id: r.peer_id,
                    name: r.name,
                    shares: shares.into_iter().map(|(id, name, permission)| RemoteShareDto { id, name, permission }).collect(),
                    created_at: r.created_at,
                    last_seen_at: r.last_seen_at,
                    status,
                }
            })
            .collect())
    }

    pub async fn remove_remote(&self, peer_id: &str) -> Result<()> {
        if let Ok(id) = peer_id.parse::<EndpointId>() {
            receiver::drop_conn(&self.inner, id).await;
            self.inner.peers.lock().remove(&id);
        }
        self.inner.db.delete_remote(peer_id)?;
        self.inner.emit(CoreEvent::RemotesChanged);
        Ok(())
    }

    pub async fn connect_remote(&self, peer_id: &str) -> Result<PeerStatus> {
        let id: EndpointId = peer_id.parse().map_err(|_| anyhow!("invalid device id"))?;
        get_conn(&self.inner, id).await.map_err(je)?;
        Ok(receiver::peer_conn(&self.inner, id).status.lock().clone())
    }

    pub async fn list_remote_dir(
        &self,
        peer_id: &str,
        share_id: &str,
        path: Vec<String>,
        offset: u32,
        limit: u32,
    ) -> Result<ListResult> {
        let id: EndpointId = peer_id.parse().map_err(|_| anyhow!("invalid device id"))?;
        let conn = get_conn(&self.inner, id).await.map_err(je)?;
        let resp = request(&conn, &Request::List { share: share_id.into(), path, offset, limit }).await.map_err(je)?;
        match resp {
            Response::List { entries, total, perm } => {
                // Older owners don't say: download only, as before.
                let permission = normalize_permission(perm.as_deref().unwrap_or("download")).to_string();
                if self.inner.db.set_remote_share_permission(peer_id, share_id, &permission).unwrap_or(false) {
                    self.inner.emit(CoreEvent::RemotesChanged);
                }
                Ok(ListResult {
                    entries: entries
                        .into_iter()
                        .map(|e| RemoteEntry { name: e.name, is_dir: e.dir, size: e.size, modified_ms: e.mtime_ms, mine: e.mine })
                        .collect(),
                    total,
                    offset,
                    permission,
                })
            }
            _ => bail!("Unexpected reply from sender."),
        }
    }

    // ------------------------------------------------------------------ uploads into others' shares

    /// Uploads local files and folders into `dir` of a share on another
    /// device. Needs upload permission from its owner. Returns upload ids.
    pub async fn start_upload(&self, peer_id: &str, share_id: &str, dir: Vec<String>, paths: Vec<String>) -> Result<Vec<String>> {
        let id: EndpointId = peer_id.parse().map_err(|_| anyhow!("invalid device id"))?;
        push::queue(&self.inner, id, share_id, dir, paths).await
    }

    pub fn list_pushes(&self) -> Vec<PushDto> {
        push::list(&self.inner)
    }

    pub fn cancel_push(&self, id: &str) -> Result<()> {
        push::cancel(&self.inner, id)
    }

    pub fn retry_push(&self, id: &str) -> Result<()> {
        push::retry(&self.inner, id)
    }

    pub fn remove_push(&self, id: &str) -> Result<()> {
        push::remove(&self.inner, id)
    }

    pub fn clear_pushes(&self) {
        push::clear_finished(&self.inner)
    }

    // ------------------------------------------------------------------ auto-sync of remote shares

    /// Remote shares this device downloads new files from automatically.
    pub fn list_syncs(&self) -> Vec<SyncDto> {
        sync::list(&self.inner)
    }

    /// Turns on auto-sync for a remote share. `dest_dir` defaults to
    /// `<download folder>/<share name>`. With `include_existing`, what is
    /// already in the share is downloaded too; otherwise only new files.
    pub fn enable_sync(&self, peer_id: &str, share_id: &str, dest_dir: Option<String>, include_existing: bool) -> Result<SyncDto> {
        sync::enable(&self.inner, peer_id, share_id, dest_dir, include_existing)
    }

    /// Turns auto-sync off. Downloaded files stay.
    pub fn disable_sync(&self, peer_id: &str, share_id: &str) -> Result<()> {
        sync::disable(&self.inner, peer_id, share_id)
    }

    /// Checks every synced folder now instead of at the next minute.
    pub fn sync_now(&self) {
        sync::kick(&self.inner)
    }

    /// Files other devices are uploading (or uploaded) into this device's shares.
    pub fn list_incoming(&self) -> Vec<IncomingDto> {
        upload::incoming_list(&self.inner)
    }

    pub fn remove_incoming(&self, id: &str) {
        upload::remove_incoming(&self.inner, id)
    }

    pub fn clear_incoming(&self) {
        upload::clear_incoming(&self.inner)
    }

    /// Creates a folder in a share on another device (a free name if taken).
    /// Returns the name it got.
    pub async fn remote_mkdir(&self, peer_id: &str, share_id: &str, path: Vec<String>) -> Result<String> {
        let id: EndpointId = peer_id.parse().map_err(|_| anyhow!("invalid device id"))?;
        proto::validate_components(&path).map_err(|_| anyhow!("invalid path"))?;
        if path.is_empty() {
            bail!("Enter a folder name.");
        }
        let conn = get_conn(&self.inner, id).await.map_err(je)?;
        match request(&conn, &Request::Mkdir { share: share_id.into(), path, unique: true }).await.map_err(je)? {
            Response::Created { name, .. } => Ok(name),
            _ => bail!("Unexpected reply from the owner."),
        }
    }

    /// Deletes a file or folder this device uploaded into another device's share.
    pub async fn remote_delete(&self, peer_id: &str, share_id: &str, path: Vec<String>) -> Result<()> {
        let id: EndpointId = peer_id.parse().map_err(|_| anyhow!("invalid device id"))?;
        proto::validate_components(&path).map_err(|_| anyhow!("invalid path"))?;
        if path.is_empty() {
            bail!("Choose a file or folder.");
        }
        let conn = get_conn(&self.inner, id).await.map_err(je)?;
        match request(&conn, &Request::Delete { share: share_id.into(), path }).await {
            Ok(_) => Ok(()),
            // Not-found from the owner reads as "file missing" for downloads; say it plainly here.
            Err(JobError::Missing(_)) => bail!("It's no longer there."),
            Err(e) => Err(je(e)),
        }
    }

    // ------------------------------------------------------------------ downloads

    pub async fn start_download(
        &self,
        peer_id: &str,
        share_id: &str,
        items: Vec<DownloadItem>,
        dest_dir: Option<String>,
    ) -> Result<Vec<String>> {
        let id: EndpointId = peer_id.parse().map_err(|_| anyhow!("invalid device id"))?;
        let conn = get_conn(&self.inner, id).await.map_err(je)?;
        let settings = self.inner.settings();
        let dest_root = PathBuf::from(dest_dir.filter(|d| !d.trim().is_empty()).unwrap_or(settings.download_dir.clone()));
        std::fs::create_dir_all(&dest_root).map_err(|e| anyhow!("Can't use the download folder: {e}"))?;

        // (remote path, local relative path, size, mtime)
        let mut files: Vec<(Vec<String>, PathBuf, u64, i64)> = Vec::new();
        for item in items {
            proto::validate_components(&item.path).map_err(|_| anyhow!("invalid path"))?;
            let Some(last) = item.path.last().cloned() else { continue };
            if item.is_dir {
                let resp = request(&conn, &Request::Walk { share: share_id.into(), path: item.path.clone() })
                    .await
                    .map_err(je)?;
                let Response::Walk { files: list, truncated } = resp else { bail!("Unexpected reply.") };
                if truncated {
                    self.inner.log("warning", &format!("\"{last}\" has too many files; only the first {} were queued", list.len()), None);
                }
                let base = PathBuf::from(sanitize_filename(&last));
                for f in list {
                    let mut rel = base.clone();
                    for c in &f.path {
                        rel.push(sanitize_filename(c));
                    }
                    let mut remote = item.path.clone();
                    remote.extend(f.path);
                    files.push((remote, rel, f.size, f.mtime_ms));
                }
            } else {
                let resp = request(&conn, &Request::Stat { share: share_id.into(), path: item.path.clone() })
                    .await
                    .map_err(je)?;
                let Response::Stat { size, mtime_ms, dir } = resp else { bail!("Unexpected reply.") };
                if dir {
                    bail!("\"{last}\" is a folder.");
                }
                files.push((item.path, PathBuf::from(sanitize_filename(&last)), size, mtime_ms));
            }
        }
        if files.is_empty() {
            bail!("Nothing to download.");
        }

        queue_files(&self.inner, peer_id, share_id, files, &dest_root)
    }

    pub fn list_jobs(&self) -> Result<Vec<JobSnapshot>> {
        let rows = self.inner.db.list_jobs()?;
        let remotes: std::collections::HashMap<String, String> =
            self.inner.db.list_remotes()?.into_iter().map(|(r, _)| (r.peer_id, r.name)).collect();
        let jobs = self.inner.jobs.lock().clone();
        Ok(rows
            .iter()
            .map(|row| {
                let name = remotes.get(&row.peer_id).map(|s| s.as_str());
                match jobs.get(&row.id) {
                    Some(h) => {
                        let r = h.row.lock().clone();
                        snapshot(&self.inner, &r, Some(h), name)
                    }
                    None => snapshot(&self.inner, row, None, name),
                }
            })
            .collect())
    }

    async fn stop_runner(&self, id: &str, reason: StopReason) {
        let h = self.inner.jobs.lock().get(id).cloned();
        if let Some(h) = h {
            *h.stop.lock() = Some(reason);
            h.cancel.cancel();
            for _ in 0..200 {
                if !self.inner.jobs.lock().contains_key(id) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
    }

    fn emit_row(&self, id: &str) {
        if let Ok(Some(row)) = self.inner.db.get_job(id) {
            self.inner.emit(CoreEvent::JobUpdated(snapshot(&self.inner, &row, None, None)));
        }
    }

    pub async fn pause_job(&self, id: &str) -> Result<()> {
        let row = self.inner.db.get_job(id)?.ok_or_else(|| anyhow!("Unknown transfer."))?;
        if matches!(row.status, JobStatus::Completed | JobStatus::Canceled) {
            return Ok(());
        }
        self.inner.db.set_job_status(id, JobStatus::Paused, None)?;
        self.stop_runner(id, StopReason::Pause).await;
        self.inner.db.set_job_status(id, JobStatus::Paused, None)?;
        self.emit_row(id);
        Ok(())
    }

    pub async fn resume_job(&self, id: &str) -> Result<()> {
        let row = self.inner.db.get_job(id)?.ok_or_else(|| anyhow!("Unknown transfer."))?;
        if row.status == JobStatus::Completed {
            return Ok(());
        }
        self.stop_runner(id, StopReason::Pause).await;
        self.inner.db.set_job_status(id, JobStatus::Queued, None)?;
        self.emit_row(id);
        spawn_job(&self.inner, id);
        Ok(())
    }

    /// Restarts a transfer against the sender's current version of the file.
    pub async fn restart_job(&self, id: &str) -> Result<()> {
        let row = self.inner.db.get_job(id)?.ok_or_else(|| anyhow!("Unknown transfer."))?;
        self.stop_runner(id, StopReason::Pause).await;
        let peer: EndpointId = row.peer_id.parse().map_err(|_| anyhow!("invalid device id"))?;
        let conn = get_conn(&self.inner, peer).await.map_err(je)?;
        let resp = request(&conn, &Request::Stat { share: row.share_id.clone(), path: row.remote_path.clone() })
            .await
            .map_err(je)?;
        let Response::Stat { size, mtime_ms, dir } = resp else { bail!("Unexpected reply.") };
        if dir {
            bail!("The sender replaced this file with a folder.");
        }
        let _ = std::fs::remove_file(&row.temp_path);
        self.inner.db.update_job_source(id, size, mtime_ms, size.div_ceil(row.chunk_size))?;
        self.inner.log("info", &format!("Restarted {} from the sender's current version", row.display_name), Some(id));
        self.emit_row(id);
        spawn_job(&self.inner, id);
        Ok(())
    }

    pub async fn cancel_job(&self, id: &str, delete_partial: bool) -> Result<()> {
        let row = self.inner.db.get_job(id)?.ok_or_else(|| anyhow!("Unknown transfer."))?;
        if row.status == JobStatus::Completed {
            return Ok(());
        }
        self.inner.db.set_job_status(id, JobStatus::Canceled, None)?;
        self.stop_runner(id, StopReason::Cancel).await;
        self.inner.db.set_job_status(id, JobStatus::Canceled, None)?;
        if delete_partial {
            let _ = std::fs::remove_file(&row.temp_path);
            self.inner.db.clear_chunks(id)?;
        }
        self.inner.log(
            "info",
            &format!(
                "Canceled {}{}",
                row.display_name,
                if delete_partial { " and deleted partial data" } else { " (partial data kept)" }
            ),
            Some(id),
        );
        self.emit_row(id);
        Ok(())
    }

    /// Removes a transfer from the list. Unfinished partial data is deleted.
    pub async fn remove_job(&self, id: &str) -> Result<()> {
        let row = self.inner.db.get_job(id)?.ok_or_else(|| anyhow!("Unknown transfer."))?;
        self.stop_runner(id, StopReason::Cancel).await;
        if row.status != JobStatus::Completed {
            let _ = std::fs::remove_file(&row.temp_path);
        }
        self.inner.db.delete_job(id)?;
        self.inner.emit(CoreEvent::JobRemoved(id.to_string()));
        Ok(())
    }

    /// Files this device is sending or has sent this session.
    pub fn list_outgoing(&self) -> Vec<OutgoingDto> {
        outgoing_list(&self.inner)
    }

    /// Forgets finished and stalled outgoing files (the list only). Paused
    /// files stay, so clearing the list doesn't resume them.
    pub fn clear_outgoing(&self) {
        self.inner.outgoing.lock().retain(|_, o| {
            o.active.load(Ordering::Relaxed) > 0 || (o.paused.load(Ordering::Relaxed) && !o.canceled.load(Ordering::Relaxed))
        });
        self.inner.emit(CoreEvent::Outgoing(outgoing_list(&self.inner)));
    }

    fn outgoing_file(&self, id: &str) -> Result<Arc<inner::OutgoingFile>> {
        self.inner.outgoing.lock().get(id).cloned().ok_or_else(|| anyhow!("Unknown transfer."))
    }

    fn outgoing_label(&self, of: &inner::OutgoingFile) -> String {
        let peer_s = of.peer.to_string();
        let device = self
            .inner
            .db
            .list_grants()
            .unwrap_or_default()
            .into_iter()
            .find(|g| g.peer_id == peer_s)
            .map(|g| g.device_name)
            .unwrap_or_else(|| short_peer(&peer_s));
        format!("{} to {device}", of.path.last().cloned().unwrap_or_default())
    }

    /// Stops sending a file to its receiver until resumed. The receiver keeps
    /// its progress and waits.
    pub fn pause_outgoing(&self, id: &str) -> Result<()> {
        let of = self.outgoing_file(id)?;
        if of.canceled.load(Ordering::Relaxed) || of.verified.load(Ordering::Relaxed) || of.paused.swap(true, Ordering::Relaxed) {
            return Ok(());
        }
        self.inner.log("info", &format!("Paused sending {}", self.outgoing_label(&of)), None);
        self.inner.emit(CoreEvent::Outgoing(outgoing_list(&self.inner)));
        Ok(())
    }

    /// Lets the receiver continue a paused file (it asks again within seconds).
    pub fn resume_outgoing(&self, id: &str) -> Result<()> {
        let of = self.outgoing_file(id)?;
        if of.canceled.load(Ordering::Relaxed) || !of.paused.swap(false, Ordering::Relaxed) {
            return Ok(());
        }
        of.last_ms.store(now_ms(), Ordering::Relaxed);
        self.inner.log("info", &format!("Resumed sending {}", self.outgoing_label(&of)), None);
        self.inner.emit(CoreEvent::Outgoing(outgoing_list(&self.inner)));
        Ok(())
    }

    /// Stops sending a file to its receiver for good: its download stops and
    /// keeps what it has. Removing the entry from the list allows it again.
    pub fn cancel_outgoing(&self, id: &str) -> Result<()> {
        let of = self.outgoing_file(id)?;
        if of.verified.load(Ordering::Relaxed) || of.canceled.swap(true, Ordering::Relaxed) {
            return Ok(());
        }
        of.paused.store(false, Ordering::Relaxed);
        self.inner.log("info", &format!("Stopped sending {}", self.outgoing_label(&of)), None);
        self.inner.emit(CoreEvent::Outgoing(outgoing_list(&self.inner)));
        Ok(())
    }

    /// Removes one outgoing file from the list (and lifts a cancel).
    pub fn remove_outgoing(&self, id: &str) {
        self.inner.outgoing.lock().remove(id);
        self.inner.emit(CoreEvent::Outgoing(outgoing_list(&self.inner)));
    }

    pub fn list_activity(&self, limit: u32) -> Result<Vec<ActivityDto>> {
        self.inner.db.list_activity(limit.min(1000))
    }

    /// Stops transfers (keeping their state so they resume next launch) and closes the network.
    pub async fn shutdown(&self) {
        let handles: Vec<_> = self.inner.jobs.lock().values().cloned().collect();
        for h in &handles {
            *h.stop.lock() = Some(StopReason::Shutdown);
        }
        self.inner.shutdown.cancel();
        for _ in 0..80 {
            if self.inner.jobs.lock().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        sender::flush_send_diags(&self.inner, None, "shutdown");
        notice::flush(&self.inner, true);
        let codes: Vec<_> = self.inner.short_codes.lock().drain().map(|(_, c)| c).collect();
        for c in codes {
            let _ = tokio::time::timeout(Duration::from_secs(2), c.endpoint.close()).await;
        }
        let _ = tokio::time::timeout(Duration::from_secs(3), self.inner.endpoint.close()).await;
    }
}

/// Publishes an invitation code: a lookup endpoint keyed by the code carries
/// the sealed invitation. It stays up while the invitation is active (checked
/// every minute: expiry, use limit, revocation) and stops on shutdown.
async fn publish_code(inner: &Arc<Inner>, invitation_id: &str, code: &str, sealed: &str) -> Result<()> {
    let c2 = code.to_string();
    let (sk, _) = tokio::task::spawn_blocking(move || invite::derive_code_keys(&c2)).await??;
    let user_data: iroh::address_lookup::UserData = sealed.parse().map_err(|_| anyhow!("code record too large"))?;
    let ep = Endpoint::builder(presets::N0)
        .secret_key(sk)
        .user_data_for_address_lookup(user_data)
        .bind()
        .await?;
    let _ = tokio::time::timeout(Duration::from_secs(8), ep.online()).await;
    inner
        .short_codes
        .lock()
        .insert(invitation_id.to_string(), ShortCode { code: code.to_string(), endpoint: ep });
    let inner = inner.clone();
    let id = invitation_id.to_string();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(60)) => {}
                _ = inner.shutdown.cancelled() => return,
            }
            // Revoked in the meantime: drop_code already closed it.
            if !inner.short_codes.lock().contains_key(&id) {
                return;
            }
            let active = matches!(inner.db.get_invitation(&id), Ok(Some(r)) if r.state(now_ms()) == "active");
            if !active {
                let _ = inner.db.delete_invitation_code(&id);
                let sc = inner.short_codes.lock().remove(&id);
                if let Some(sc) = sc {
                    sc.endpoint.close().await;
                }
                inner.emit(CoreEvent::SharesChanged);
                return;
            }
        }
    });
    Ok(())
}

/// After a restart, publishes the codes of invitations that are still active
/// again and forgets the rest.
async fn republish_codes(inner: Arc<Inner>) {
    let codes = match inner.db.list_invitation_codes() {
        Ok(c) => c,
        Err(e) => {
            warn!("can't read invitation codes: {e:#}");
            return;
        }
    };
    let mut changed = false;
    for (id, code, sealed) in codes {
        let active = matches!(inner.db.get_invitation(&id), Ok(Some(r)) if r.state(now_ms()) == "active");
        if !active {
            let _ = inner.db.delete_invitation_code(&id);
            continue;
        }
        match publish_code(&inner, &id, &code, &sealed).await {
            Ok(()) => changed = true,
            Err(e) => warn!("invitation code {id} not republished: {e:#}"),
        }
    }
    if changed {
        inner.emit(CoreEvent::SharesChanged);
    }
}

fn inv_dto(i: &InvitationRow, now: i64, code: Option<String>) -> InvitationDto {
    InvitationDto {
        id: i.id.clone(),
        share_id: i.share_id.clone(),
        expires_at: i.expires_at,
        max_uses: i.max_uses,
        use_count: i.use_count,
        require_approval: i.require_approval,
        created_at: i.created_at,
        state: i.state(now).into(),
        has_short_code: code.is_some(),
        short_code: code,
        permission: i.permission.clone(),
    }
}

pub(crate) fn permission_text(p: &str) -> &'static str {
    match normalize_permission(p) {
        "upload" => "upload only",
        "both" => "download and upload",
        _ => "download only",
    }
}

/// "download", "upload", "download and upload" (for "X can now …").
fn permission_verb(p: &str) -> &'static str {
    match normalize_permission(p) {
        "upload" => "only upload",
        "both" => "download and upload",
        _ => "only download",
    }
}

/// Removes the `\\?\` prefix Windows canonicalization adds, for display and storage.
fn strip_verbatim(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s
    }
}

/// Creates download jobs for remote files: (remote path, local path below `dest_root`, size, mtime).
/// Never overwrites: a taken name gets " (n)".
pub(crate) fn queue_files(
    inner: &Arc<Inner>,
    peer_id: &str,
    share_id: &str,
    files: Vec<(Vec<String>, PathBuf, u64, i64)>,
    dest_root: &Path,
) -> Result<Vec<String>> {
    let chunk_size = inner.settings().chunk_size_mib as u64 * 1024 * 1024;
    let mut used: HashSet<PathBuf> = inner
        .db
        .list_jobs()?
        .into_iter()
        .filter(|j| !matches!(j.status, JobStatus::Completed | JobStatus::Canceled))
        .map(|j| PathBuf::from(j.dest_path))
        .collect();
    let mut ids = Vec::new();
    let mut total = 0u64;
    let now = now_ms();
    for (remote, rel, size, mtime_ms) in files {
        let mut dest = util::unique_path(&dest_root.join(&rel));
        let mut n = 1;
        while used.contains(&dest) {
            let stem = rel.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let ext = rel.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
            dest = util::unique_path(&dest_root.join(&rel).with_file_name(format!("{stem} ({n}){ext}")));
            n += 1;
        }
        used.insert(dest.clone());
        let temp = PathBuf::from(format!("{}.rlpart", dest.to_string_lossy()));
        let row = JobRow {
            id: random_id(),
            peer_id: peer_id.to_string(),
            share_id: share_id.to_string(),
            display_name: remote.last().cloned().unwrap_or_default(),
            remote_path: remote,
            size,
            mtime_ms,
            chunk_size,
            total_chunks: size.div_ceil(chunk_size),
            dest_path: dest.to_string_lossy().to_string(),
            temp_path: temp.to_string_lossy().to_string(),
            verified_bytes: 0,
            status: JobStatus::Queued,
            error: None,
            created_at: now,
            updated_at: now,
            completed_at: None,
            stats: Default::default(),
        };
        inner.db.insert_job(&row)?;
        total += size;
        ids.push(row.id.clone());
    }
    let peer_name = inner.db.get_remote(peer_id)?.map(|r| r.name).unwrap_or_default();
    inner.log(
        "info",
        &format!("Queued {} file(s), {} from {peer_name}", ids.len(), util::human_bytes(total)),
        None,
    );
    for id in &ids {
        spawn_job(inner, id);
    }
    Ok(ids)
}

/// Snapshot of outgoing files, newest activity first.
pub(crate) fn outgoing_list(inner: &Inner) -> Vec<OutgoingDto> {
    let grants = inner.db.list_grants().unwrap_or_default();
    let shares = inner.db.list_shares().unwrap_or_default();
    let now = now_ms();
    let mut out: Vec<OutgoingDto> = inner
        .outgoing
        .lock()
        .values()
        .map(|o| {
            let peer_s = o.peer.to_string();
            let size = o.size.load(Ordering::Relaxed);
            let sent = o.progress();
            let active = o.active.load(Ordering::Relaxed) > 0;
            let last = o.last_ms.load(Ordering::Relaxed);
            let status = if o.verified.load(Ordering::Relaxed) {
                "verified"
            } else if o.canceled.load(Ordering::Relaxed) {
                "canceled"
            } else if o.paused.load(Ordering::Relaxed) {
                "paused"
            } else if sent >= size && !active {
                "delivered"
            } else if active || now - last < 15_000 {
                "sending"
            } else {
                "waiting"
            };
            let route = inner
                .incoming
                .lock()
                .get(&o.peer)
                .and_then(|v| v.last().map(|(_, c)| route_of(c).kind))
                .unwrap_or_else(|| "none".into());
            OutgoingDto {
                route,
                id: o.id.clone(),
                device_name: grants
                    .iter()
                    .find(|g| g.peer_id == peer_s)
                    .map(|g| g.device_name.clone())
                    .unwrap_or_else(|| short_peer(&peer_s)),
                peer_id: peer_s,
                share_name: shares.iter().find(|s| s.id == o.share_id).map(|s| s.name.clone()).unwrap_or_default(),
                name: o.path.last().cloned().unwrap_or_default(),
                path: o.path.clone(),
                size,
                sent_bytes: if status == "verified" { size } else { sent },
                bps: if status == "sending" { o.rate.lock().1 } else { 0.0 },
                status: status.into(),
                started_at: o.started_ms,
                updated_at: last,
            }
        })
        .collect();
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    out
}

/// Applies the history retention setting. Returns how many entries went.
fn prune_history(inner: &Inner) -> usize {
    let cutoff = inner.settings().history_cutoff(now_ms());
    if cutoff == i64::MIN {
        return 0;
    }
    inner.db.prune_history(cutoff).unwrap_or(0)
}

fn network_status(inner: &Inner) -> NetworkStatus {
    let addr = inner.endpoint.addr();
    let relay = addr.relay_urls().next().map(|u| u.to_string());
    let direct = addr.ip_addrs().count();
    let id = inner.endpoint.id().to_string();
    NetworkStatus {
        endpoint_short: short_peer(&id),
        endpoint_id: id,
        online: relay.is_some() || (inner.local_mode && direct > 0),
        relay_url: relay,
        direct_addrs: direct,
    }
}

async fn network_watch(inner: Arc<Inner>) {
    let mut last: Option<(bool, Option<String>, usize)> = None;
    loop {
        let st = network_status(&inner);
        let key = (st.online, st.relay_url.clone(), st.direct_addrs);
        if last.as_ref() != Some(&key) {
            let changed = last.is_some();
            let online = st.online;
            last = Some(key);
            inner.emit(CoreEvent::Network(st));
            // Back online, or on a different network: everything waiting to
            // retry tries again now, and folder syncs check for new files.
            if changed && online {
                inner.log("info", "Network is back: resuming waiting transfers", None);
                inner.net_wake.notify_waiters();
                sync::kick(&inner);
            }
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(3)) => {}
            _ = inner.shutdown.cancelled() => return,
        }
    }
}

/// Coalesced progress events: at most two per second per active transfer.
async fn ticker(inner: Arc<Inner>) {
    let mut tick: u64 = 0;
    let mut had_uploads = false;
    let mut had_outgoing = false;
    let mut had_pushes = false;
    let mut had_incoming = false;
    loop {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(500)) => {}
            _ = inner.shutdown.cancelled() => return,
        }
        tick += 1;
        if tick % 7200 == 0 && prune_history(&inner) > 0 {
            inner.emit(CoreEvent::HistoryChanged);
        }
        let handles: Vec<_> = inner.jobs.lock().values().cloned().collect();
        for h in handles {
            if h.status() == JobStatus::Downloading {
                receiver::emit_job(&inner, &h);
            }
        }
        if tick % 2 == 0 {
            // Uploads into others' shares.
            let pushing = push::tick(&inner);
            if pushing || had_pushes {
                had_pushes = pushing;
                push::emit_list(&inner);
            }
            // Owner notices for downloads and uploads by other devices.
            notice::flush(&inner, false);
            // Uploads into this device's shares.
            let arriving = upload::incoming_tick(&inner);
            if arriving || had_incoming {
                had_incoming = arriving;
                upload::emit_incoming(&inner);
            }
            // Sender diagnostics: close out files idle for 15 s.
            sender::flush_send_diags(&inner, Some(Duration::from_secs(15)), "idle");
            if tick % 10 == 0 {
                sender::sample_send_diags(&inner);
            }
            // Per-file send rates and the outgoing list.
            let files: Vec<_> = inner.outgoing.lock().values().cloned().collect();
            let mut busy = false;
            for o in &files {
                let p = o.progress();
                let mut r = o.rate.lock();
                let inst = p.saturating_sub(r.0) as f64;
                r.1 = if r.1 == 0.0 { inst } else { r.1 * 0.7 + inst * 0.3 };
                r.0 = p;
                if o.active.load(Ordering::Relaxed) > 0 || now_ms() - o.last_ms.load(Ordering::Relaxed) < 20_000 {
                    busy = true;
                }
            }
            if busy || had_outgoing {
                had_outgoing = busy;
                inner.emit(CoreEvent::Outgoing(outgoing_list(&inner)));
            }
            let stats: Vec<_> = inner.uploads.lock().iter().map(|(k, v)| (*k, v.clone())).collect();
            if stats.is_empty() && !had_uploads {
                continue;
            }
            let grants = inner.db.list_grants().unwrap_or_default();
            let mut list = Vec::new();
            for (peer, s) in stats {
                let sent = s.sent.load(Ordering::Relaxed);
                let bps = {
                    let mut r = s.rate.lock();
                    let inst = sent.saturating_sub(r.0) as f64;
                    r.1 = if r.1 == 0.0 { inst } else { r.1 * 0.7 + inst * 0.3 };
                    r.0 = sent;
                    r.1
                };
                let files = s.files();
                if bps < 1.0 && files.is_empty() {
                    continue;
                }
                let ps = peer.to_string();
                list.push(UploadDto {
                    device_name: grants
                        .iter()
                        .find(|g| g.peer_id == ps)
                        .map(|g| g.device_name.clone())
                        .unwrap_or_else(|| short_peer(&ps)),
                    peer_id: ps,
                    bps,
                    total_sent: sent,
                    files,
                });
            }
            if !list.is_empty() || had_uploads {
                had_uploads = !list.is_empty();
                inner.emit(CoreEvent::Uploads(list));
            }
        }
    }
}

/// Lowers (or restores) this process's CPU scheduling priority so transfers
/// yield to whatever else the user is doing. Network throughput is unaffected.
pub fn set_low_priority(enable: bool) {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::Threading::{
            GetCurrentProcess, SetPriorityClass, BELOW_NORMAL_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS,
        };
        let class = if enable { BELOW_NORMAL_PRIORITY_CLASS } else { NORMAL_PRIORITY_CLASS };
        SetPriorityClass(GetCurrentProcess(), class);
    }
    #[cfg(not(windows))]
    let _ = enable;
}
