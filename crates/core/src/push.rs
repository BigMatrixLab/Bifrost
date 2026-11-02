//! Uploads from this device into a folder another device shares with it.
//! Each file is one `Put` stream: the owner says how much it already has
//! from an earlier attempt, this side sends the rest in 1 MiB blocks with
//! their BLAKE3 hashes, and the owner answers with the name it saved under.
//! The list lives in memory; an interrupted file continues from what the
//! owner already verified when it is retried in the same session.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use iroh::endpoint::VarInt;
use iroh::EndpointId;
use parking_lot::Mutex;
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

use crate::db::{JobStats, PushRow};
use crate::inner::Inner;
use crate::proto::*;
use crate::receiver::{drop_conn, get_conn, request, JobError};
use crate::upload::{add_history, upload_fingerprint, HistoryEntry, Meter};
use crate::types::{CoreEvent, PushDto};
use crate::util::{backoff, human_bytes, now_ms, random_id, sanitize_filename, system_time_ms};


pub struct PushState {
    /// "queued", "uploading", "retrying", "completed", "failed", "canceled"
    pub status: &'static str,
    pub error: Option<String>,
    pub saved_as: Option<String>,
    pub updated_at: i64,
}

pub struct PushJob {
    pub id: String,
    pub peer: EndpointId,
    pub peer_name: String,
    pub share_id: String,
    pub share_name: String,
    pub local_path: PathBuf,
    pub remote_path: Vec<String>,
    pub created_at: i64,
    pub size: AtomicU64,
    pub mtime_ms: AtomicI64,
    pub sent: AtomicU64,
    pub state: Mutex<PushState>,
    pub cancel: Mutex<CancellationToken>,
    /// (bytes at the last tick, smoothed bytes/s)
    pub rate: Mutex<(u64, f64)>,
    /// Route and timing over all attempts, for the history receipt.
    pub stats: Mutex<JobStats>,
}

impl PushJob {
    fn status(&self) -> &'static str {
        self.state.lock().status
    }
    fn is_running(&self) -> bool {
        matches!(self.status(), "queued" | "uploading" | "retrying")
    }
}

enum PushErr {
    Retry(String),
    Fatal(String),
    Canceled,
}

fn from_job_err(e: JobError) -> PushErr {
    match e {
        JobError::Denied(m) | JobError::Fatal(m) => PushErr::Fatal(m),
        JobError::Missing(_) => PushErr::Fatal("The folder is no longer there on the owner's computer.".into()),
        other => PushErr::Retry(other.to_string()),
    }
}

fn from_remote(code: ErrCode, message: String) -> PushErr {
    match code {
        ErrCode::InUse | ErrCode::Paused => PushErr::Retry(message),
        _ => PushErr::Fatal(message),
    }
}

fn dto(j: &PushJob) -> PushDto {
    let bps = j.rate.lock().1;
    let st = j.state.lock();
    let size = j.size.load(Ordering::Relaxed);
    PushDto {
        id: j.id.clone(),
        peer_id: j.peer.to_string(),
        peer_name: j.peer_name.clone(),
        share_id: j.share_id.clone(),
        share_name: j.share_name.clone(),
        local_path: j.local_path.to_string_lossy().to_string(),
        remote_path: j.remote_path.clone(),
        name: j.remote_path.last().cloned().unwrap_or_default(),
        saved_as: st.saved_as.clone(),
        size,
        sent_bytes: if st.status == "completed" { size } else { j.sent.load(Ordering::Relaxed).min(size) },
        bps: if st.status == "uploading" { bps } else { 0.0 },
        status: st.status.into(),
        error: st.error.clone(),
        created_at: j.created_at,
        updated_at: st.updated_at,
    }
}

/// All uploads, newest first.
pub fn list(inner: &Inner) -> Vec<PushDto> {
    let jobs: Vec<Arc<PushJob>> = inner.pushes.lock().values().cloned().collect();
    let mut out: Vec<PushDto> = jobs.iter().map(|j| dto(j)).collect();
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| a.local_path.cmp(&b.local_path)));
    out
}

fn emit(inner: &Inner) {
    inner.emit(CoreEvent::Pushes(list(inner)));
}

fn set_state(inner: &Inner, j: &PushJob, status: &'static str, error: Option<String>) {
    {
        let mut st = j.state.lock();
        // A runner finishing its step after the user canceled must not revive it.
        if st.status == "canceled" && status != "queued" {
            return;
        }
        st.status = status;
        st.error = error;
        st.updated_at = now_ms();
    }
    persist(inner, j);
    emit(inner);
}

/// Saves an upload so it continues after a restart.
fn persist(inner: &Inner, j: &PushJob) {
    let stats = j.stats.lock().clone();
    let st = j.state.lock();
    let row = PushRow {
        id: j.id.clone(),
        peer_id: j.peer.to_string(),
        peer_name: j.peer_name.clone(),
        share_id: j.share_id.clone(),
        share_name: j.share_name.clone(),
        local_path: j.local_path.to_string_lossy().to_string(),
        remote_path: j.remote_path.clone(),
        size: j.size.load(Ordering::Relaxed),
        mtime_ms: j.mtime_ms.load(Ordering::Relaxed),
        status: st.status.to_string(),
        error: st.error.clone(),
        saved_as: st.saved_as.clone(),
        created_at: j.created_at,
        updated_at: st.updated_at,
        stats,
    };
    drop(st);
    if let Err(e) = inner.db.save_push(&row) {
        tracing::warn!("couldn't save upload {}: {e:#}", j.id);
    }
}

fn status_of(s: &str) -> &'static str {
    match s {
        "completed" => "completed",
        "failed" => "failed",
        "canceled" => "canceled",
        _ => "queued",
    }
}

/// Loads saved uploads at start-up and continues every unfinished one.
pub fn restore(inner: &Arc<Inner>) {
    let rows = match inner.db.list_pushes() {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("couldn't load uploads: {e:#}");
            return;
        }
    };
    let mut resumed = 0;
    for r in rows {
        let Ok(peer) = r.peer_id.parse::<EndpointId>() else { continue };
        let status = status_of(&r.status);
        let job = Arc::new(PushJob {
            id: r.id.clone(),
            peer,
            peer_name: r.peer_name,
            share_id: r.share_id,
            share_name: r.share_name,
            local_path: PathBuf::from(r.local_path),
            remote_path: r.remote_path,
            created_at: r.created_at,
            size: AtomicU64::new(r.size),
            mtime_ms: AtomicI64::new(r.mtime_ms),
            sent: AtomicU64::new(if status == "completed" { r.size } else { 0 }),
            state: Mutex::new(PushState { status, error: r.error, saved_as: r.saved_as, updated_at: r.updated_at }),
            cancel: Mutex::new(CancellationToken::new()),
            rate: Mutex::new((0, 0.0)),
            stats: Mutex::new(r.stats),
        });
        inner.pushes.lock().insert(job.id.clone(), job.clone());
        if status == "queued" {
            resumed += 1;
            spawn(inner, job);
        }
    }
    if resumed > 0 {
        inner.log("info", &format!("Continuing {resumed} unfinished upload(s)"), None);
    }
}

/// Progress rates, called every second by the ticker. Returns whether any upload is running.
pub fn tick(inner: &Inner) -> bool {
    let jobs: Vec<Arc<PushJob>> = inner.pushes.lock().values().cloned().collect();
    let mut running = false;
    for j in &jobs {
        let sent = j.sent.load(Ordering::Relaxed);
        {
            // Never hold `rate` while taking `state`: `dto` takes them the other way round.
            let mut r = j.rate.lock();
            let inst = sent.saturating_sub(r.0) as f64;
            r.1 = if r.1 == 0.0 { inst } else { r.1 * 0.7 + inst * 0.3 };
            r.0 = sent;
        }
        if j.is_running() {
            running = true;
        }
    }
    running
}

pub fn emit_list(inner: &Inner) {
    emit(inner);
}

// ---------------------------------------------------------------- queueing

/// A local file or folder chosen for upload, expanded: files with their path
/// below the chosen folder, and folders that contain no files.
struct Expanded {
    files: Vec<(PathBuf, Vec<String>, u64)>,
    empty_dirs: Vec<Vec<String>>,
}

fn expand_dir(root: &Path) -> Expanded {
    let mut files = Vec::new();
    let mut empty_dirs = Vec::new();
    let mut stack: Vec<(PathBuf, Vec<String>)> = vec![(root.to_path_buf(), vec![])];
    while let Some((dir, rel)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        let mut any = false;
        for e in rd.flatten() {
            let Ok(ft) = e.file_type() else { continue };
            // System files (.DS_Store, Thumbs.db, ...) stay behind; a folder
            // holding only those counts as empty.
            if ft.is_symlink() || crate::util::is_system_file(&e.file_name().to_string_lossy()) {
                continue;
            }
            any = true;
            let mut r = rel.clone();
            r.push(sanitize_filename(&e.file_name().to_string_lossy()));
            if ft.is_dir() {
                stack.push((e.path(), r));
            } else if ft.is_file() {
                let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                files.push((e.path(), r, size));
                if files.len() >= MAX_WALK_FILES {
                    return Expanded { files, empty_dirs };
                }
            }
        }
        if !any && !rel.is_empty() {
            empty_dirs.push(rel);
        }
    }
    files.sort_by(|a, b| a.1.cmp(&b.1));
    Expanded { files, empty_dirs }
}

/// Queues local files and folders for upload into `dir` of a share.
/// A folder is created under a free name on the owner's side first, so an
/// upload never mixes into or replaces something already there.
pub async fn queue(inner: &Arc<Inner>, peer: EndpointId, share_id: &str, dir: Vec<String>, paths: Vec<String>) -> Result<Vec<String>> {
    validate_components(&dir).map_err(|_| anyhow!("Invalid folder."))?;
    let peer_s = peer.to_string();
    let (remote, shares) = inner
        .db
        .list_remotes()?
        .into_iter()
        .find(|(r, _)| r.peer_id == peer_s)
        .ok_or_else(|| anyhow!("Unknown device."))?;
    let (_, share_name, perm) = shares
        .into_iter()
        .find(|(id, _, _)| id == share_id)
        .ok_or_else(|| anyhow!("This folder is no longer shared with you."))?;
    if !crate::types::perm_can_upload(&perm) {
        bail!("The owner doesn't allow uploads to this folder.");
    }
    if paths.is_empty() {
        bail!("Nothing to upload.");
    }
    let conn = get_conn(inner, peer).await.map_err(|e| anyhow!("{e}"))?;

    let mut planned: Vec<(PathBuf, Vec<String>, u64)> = Vec::new();
    for p in paths {
        let local = PathBuf::from(&p);
        let meta = std::fs::metadata(&local).map_err(|_| anyhow!("Can't read \"{p}\"."))?;
        let name = local
            .file_name()
            .map(|n| sanitize_filename(&n.to_string_lossy()))
            .ok_or_else(|| anyhow!("Choose a file or folder, not a whole drive."))?;
        if meta.is_file() {
            let mut remote_path = dir.clone();
            remote_path.push(name);
            planned.push((local, remote_path, meta.len()));
        } else if meta.is_dir() {
            let mut top = dir.clone();
            top.push(name);
            let resp = request(&conn, &Request::Mkdir { share: share_id.into(), path: top.clone(), unique: true })
                .await
                .map_err(|e| anyhow!("{e}"))?;
            let Response::Created { name: made, .. } = resp else { bail!("Unexpected reply from the owner.") };
            *top.last_mut().expect("not empty") = made;
            let local2 = local.clone();
            let ex = tokio::task::spawn_blocking(move || expand_dir(&local2)).await?;
            if ex.files.len() >= MAX_WALK_FILES {
                inner.log("warning", &format!("\"{p}\" has too many files; only the first {} were queued", ex.files.len()), None);
            }
            for d in ex.empty_dirs {
                let mut path = top.clone();
                path.extend(d);
                request(&conn, &Request::Mkdir { share: share_id.into(), path, unique: false })
                    .await
                    .map_err(|e| anyhow!("{e}"))?;
            }
            for (f, rel, size) in ex.files {
                let mut remote_path = top.clone();
                remote_path.extend(rel);
                planned.push((f, remote_path, size));
            }
        }
    }

    let now = now_ms();
    let mut ids = Vec::new();
    let mut total = 0u64;
    for (local, remote_path, size) in planned {
        if remote_path.len() > 128 {
            continue;
        }
        total += size;
        let job = Arc::new(PushJob {
            id: random_id(),
            peer,
            peer_name: remote.name.clone(),
            share_id: share_id.to_string(),
            share_name: share_name.clone(),
            local_path: local,
            remote_path,
            created_at: now,
            size: AtomicU64::new(size),
            mtime_ms: AtomicI64::new(0),
            sent: AtomicU64::new(0),
            state: Mutex::new(PushState { status: "queued", error: None, saved_as: None, updated_at: now }),
            cancel: Mutex::new(CancellationToken::new()),
            rate: Mutex::new((0, 0.0)),
            stats: Mutex::new(JobStats::default()),
        });
        ids.push(job.id.clone());
        inner.pushes.lock().insert(job.id.clone(), job.clone());
        persist(inner, &job);
        spawn(inner, job);
    }
    inner.log(
        "info",
        &format!("Uploading {} file(s), {} to \"{share_name}\" on {}", ids.len(), human_bytes(total), remote.name),
        None,
    );
    emit(inner);
    Ok(ids)
}

fn spawn(inner: &Arc<Inner>, job: Arc<PushJob>) {
    let token = CancellationToken::new();
    *job.cancel.lock() = token.clone();
    let inner = inner.clone();
    let rt = inner.rt.clone();
    rt.spawn(async move { run(&inner, &job, token).await });
}

async fn run(inner: &Arc<Inner>, job: &Arc<PushJob>, token: CancellationToken) {
    let mut attempt = 0u32;
    loop {
        // A slot per attempt: an upload waiting for an offline owner doesn't
        // hold up uploads to other devices.
        let permit = tokio::select! {
            p = inner.push_slots.acquire() => match p { Ok(p) => p, Err(_) => return },
            _ = token.cancelled() => return,
            _ = inner.shutdown.cancelled() => return,
        };
        if token.is_cancelled() {
            return;
        }
        set_state(inner, job, "uploading", None);
        let res = tokio::select! {
            r = push_once(inner, job) => r,
            _ = token.cancelled() => Err(PushErr::Canceled),
            _ = inner.shutdown.cancelled() => Err(PushErr::Canceled),
        };
        match res {
            Ok(Done { name: saved, fingerprint }) => {
                job.state.lock().saved_as = Some(saved.clone());
                set_state(inner, job, "completed", None);
                let stats = job.stats.lock().clone();
                add_history(
                    inner,
                    HistoryEntry {
                        id: format!("us-{}", job.id),
                        direction: "sent",
                        peer_id: job.peer.to_string(),
                        peer_name: job.peer_name.clone(),
                        name: saved.clone(),
                        size: job.size.load(Ordering::Relaxed),
                        started_at: job.created_at,
                        stats,
                        fingerprint,
                    },
                );
                inner.log(
                    "success",
                    &format!("Uploaded \"{saved}\" to \"{}\" on {}", job.share_name, job.peer_name),
                    None,
                );
                return;
            }
            Err(PushErr::Canceled) => return,
            Err(PushErr::Fatal(m)) => {
                inner.log("error", &format!("Upload of \"{}\" failed: {m}", file_label(job)), None);
                set_state(inner, job, "failed", Some(m));
                return;
            }
            Err(PushErr::Retry(m)) => {
                // Network trouble or the owner being offline: keep trying
                // (like downloads), sooner when the network comes back.
                attempt = attempt.saturating_add(1);
                if attempt == 3 {
                    inner.log("warning", &format!("Waiting for {} to upload \"{}\": {m}", job.peer_name, file_label(job)), None);
                }
                drop(permit);
                drop_conn(inner, job.peer).await;
                set_state(inner, job, "retrying", Some(m));
                tokio::select! {
                    _ = tokio::time::sleep(backoff(attempt)) => {}
                    _ = inner.net_wake.notified() => {}
                    _ = token.cancelled() => return,
                    _ = inner.shutdown.cancelled() => return,
                }
            }
        }
    }
}

fn file_label(job: &PushJob) -> String {
    job.remote_path.last().cloned().unwrap_or_default()
}

async fn push_once(inner: &Arc<Inner>, job: &PushJob) -> Result<Done, PushErr> {
    let meta = tokio::fs::metadata(&job.local_path)
        .await
        .map_err(|_| PushErr::Fatal("The file is no longer available on this device.".into()))?;
    if !meta.is_file() {
        return Err(PushErr::Fatal("The file is no longer available on this device.".into()));
    }
    let size = meta.len();
    let mtime_ms = system_time_ms(meta.modified());
    let (old_size, old_mtime) = (job.size.swap(size, Ordering::Relaxed), job.mtime_ms.swap(mtime_ms, Ordering::Relaxed));
    if old_mtime != 0 && (old_size != size || old_mtime != mtime_ms) {
        // Changed since the last attempt: the owner's partial copy is stale.
        job.sent.store(0, Ordering::Relaxed);
        send_abort(inner.clone(), job.peer, job.share_id.clone(), job.remote_path.clone(), old_size, old_mtime);
    }

    let conn = get_conn(inner, job.peer).await.map_err(from_job_err)?;
    let (mut send, mut recv) = conn.open_bi().await.map_err(|e| PushErr::Retry(e.to_string()))?;
    let req = Request::Put { share: job.share_id.clone(), path: job.remote_path.clone(), size, mtime_ms };
    write_frame(&mut send, &req).await.map_err(|e| PushErr::Retry(e.to_string()))?;
    let first: Response = tokio::time::timeout(Duration::from_secs(60), read_frame(&mut recv))
        .await
        .map_err(|_| PushErr::Retry("The owner stopped responding.".into()))?
        .map_err(|e| PushErr::Retry(format!("Connection interrupted ({e})")))?;
    let have = match first {
        Response::PutReady { have } if have <= size => have,
        Response::Error { code, message } => return Err(from_remote(code, message)),
        _ => return Err(PushErr::Fatal("Unexpected reply from the owner.".into())),
    };
    job.sent.store(have, Ordering::Relaxed);

    let mut meter = Meter::new(&conn);
    let res = send_rest(inner, job, &conn, &mut send, &mut recv, have, size, mtime_ms, &mut meter).await;
    let s = meter.stats();
    {
        let mut t = job.stats.lock();
        t.direct_bytes += s.direct_bytes;
        t.relay_bytes += s.relay_bytes;
        t.active_ms += s.active_ms;
        t.peak_bps = t.peak_bps.max(s.peak_bps);
    }
    res
}

/// Streams the file from `have` and waits for the owner's answer. Blocks
/// before `have` are only read and hashed, for the end-to-end fingerprint.
#[allow(clippy::too_many_arguments)]
async fn send_rest(
    inner: &Arc<Inner>,
    job: &PushJob,
    conn: &iroh::endpoint::Connection,
    send: &mut iroh::endpoint::SendStream,
    recv: &mut iroh::endpoint::RecvStream,
    have: u64,
    size: u64,
    mtime_ms: i64,
    meter: &mut Meter,
) -> Result<Done, PushErr> {
    let mut file = tokio::fs::File::open(&job.local_path)
        .await
        .map_err(|e| PushErr::Fatal(format!("Couldn't read the file: {e}")))?;
    let mut hashes: Vec<[u8; 32]> = Vec::with_capacity(size.div_ceil(BLOCK) as usize);
    let mut buf = vec![0u8; BLOCK as usize];
    let mut pos = 0u64;
    while pos < size {
        let n = (size - pos).min(BLOCK) as usize;
        file.read_exact(&mut buf[..n]).await.map_err(|e| PushErr::Fatal(format!("Couldn't read the file: {e}")))?;
        let hash = blake3::hash(&buf[..n]);
        hashes.push(*hash.as_bytes());
        if pos >= have {
            inner.upload_limiter.acquire(n).await;
            let wrote = async {
                send.write_all(&buf[..n]).await?;
                send.write_all(hash.as_bytes()).await?;
                anyhow::Ok(())
            }
            .await;
            if let Err(e) = wrote {
                // The owner may have refused mid-way; its reason is waiting on the stream.
                return Err(match tokio::time::timeout(Duration::from_secs(5), read_frame::<Response>(recv)).await {
                    Ok(Ok(Response::Error { code, message })) => from_remote(code, message),
                    _ => PushErr::Retry(format!("Connection interrupted ({e})")),
                });
            }
            meter.add(conn, n as u64);
            job.sent.store(pos + n as u64, Ordering::Relaxed);
        }
        pos += n as u64;
    }
    let fingerprint = upload_fingerprint(&hashes);
    // Don't deliver a mix of two versions.
    let after = tokio::fs::metadata(&job.local_path).await.ok();
    if after.as_ref().is_none_or(|m| m.len() != size || system_time_ms(m.modified()) != mtime_ms) {
        let _ = send.reset(VarInt::from_u32(2));
        return Err(PushErr::Retry("The file changed while uploading; sending it again.".into()));
    }
    send.finish().map_err(|e| PushErr::Retry(e.to_string()))?;
    // The owner reads the whole file back before answering.
    let done: Response = tokio::time::timeout(Duration::from_secs(600), read_frame(recv))
        .await
        .map_err(|_| PushErr::Retry("The owner stopped responding.".into()))?
        .map_err(|e| PushErr::Retry(format!("Connection interrupted ({e})")))?;
    match done {
        Response::Created { name, fingerprint: theirs } => {
            if theirs.as_deref().is_some_and(|t| t != fingerprint) {
                return Err(PushErr::Fatal(format!(
                    "The copy saved as \"{name}\" doesn't match this file. Delete it and upload again."
                )));
            }
            Ok(Done { name, fingerprint })
        }
        Response::Error { code, message } => Err(from_remote(code, message)),
        _ => Err(PushErr::Fatal("Unexpected reply from the owner.".into())),
    }
}

struct Done {
    name: String,
    fingerprint: String,
}

/// Tells the owner to drop the partial data of an upload (best effort).
fn send_abort(inner: Arc<Inner>, peer: EndpointId, share: String, path: Vec<String>, size: u64, mtime_ms: i64) {
    if mtime_ms == 0 {
        return;
    }
    let rt = inner.rt.clone();
    rt.spawn(async move {
        // Let the owner notice the closed stream first.
        tokio::time::sleep(Duration::from_millis(1500)).await;
        if let Ok(conn) = get_conn(&inner, peer).await {
            let _ = request(&conn, &Request::PutAbort { share, path, size, mtime_ms }).await;
        }
    });
}

fn get(inner: &Inner, id: &str) -> Result<Arc<PushJob>> {
    inner.pushes.lock().get(id).cloned().ok_or_else(|| anyhow!("Unknown upload."))
}

fn stop(inner: &Arc<Inner>, job: &PushJob) {
    job.cancel.lock().cancel();
    let sent = job.sent.load(Ordering::Relaxed);
    if sent > 0 && job.status() != "completed" {
        send_abort(
            inner.clone(),
            job.peer,
            job.share_id.clone(),
            job.remote_path.clone(),
            job.size.load(Ordering::Relaxed),
            job.mtime_ms.load(Ordering::Relaxed),
        );
    }
}

pub fn cancel(inner: &Arc<Inner>, id: &str) -> Result<()> {
    let job = get(inner, id)?;
    if job.is_running() {
        stop(inner, &job);
        job.sent.store(0, Ordering::Relaxed);
        set_state(inner, &job, "canceled", None);
    }
    Ok(())
}

pub fn retry(inner: &Arc<Inner>, id: &str) -> Result<()> {
    let job = get(inner, id)?;
    if matches!(job.status(), "failed" | "canceled") {
        job.cancel.lock().cancel();
        set_state(inner, &job, "queued", None);
        spawn(inner, job);
    }
    Ok(())
}

pub fn remove(inner: &Arc<Inner>, id: &str) -> Result<()> {
    let job = get(inner, id)?;
    if job.is_running() {
        stop(inner, &job);
        set_state(inner, &job, "canceled", None);
    }
    inner.pushes.lock().remove(id);
    let _ = inner.db.delete_push(id);
    emit(inner);
    Ok(())
}

pub fn clear_finished(inner: &Inner) {
    inner.pushes.lock().retain(|_, j| j.status() != "completed");
    let _ = inner.db.delete_finished_pushes();
    emit(inner);
}
