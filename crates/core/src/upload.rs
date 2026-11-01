//! Owner side of uploads: lets a device with upload permission add files and
//! folders to a share, and delete what it added itself. Every file or folder
//! it creates is recorded in the `uploads` table with its device id, size and
//! modification time; a delete is only accepted when the item (and, for a
//! folder, everything inside it) is still recorded for that device and
//! unchanged since. Files the owner put there, or another device uploaded,
//! can't be deleted remotely.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, UNIX_EPOCH};

use anyhow::Result;
use iroh::endpoint::{Connection, RecvStream, SendStream, VarInt};
use iroh::EndpointId;

use crate::db::{HistoryRow, JobStats, ShareRow, UploadRow};
use crate::inner::{IncomingFile, IncomingState, Inner};
use crate::net::route_of;
use crate::proto::*;
use crate::types::{CoreEvent, IncomingDto};
use crate::util::{
    available_space, now_ms, read_exact_at, sanitize_filename, short_peer, system_time_ms, unique_path, write_all_at,
};

/// How long the owner waits for the next block before giving up on an upload.
const BLOCK_TIMEOUT: Duration = Duration::from_secs(90);

/// Partial uploads live next to their destination as `.bfup-<device>-<file>.rlpart`.
pub fn is_upload_temp(name: &str) -> bool {
    name.starts_with(".bfup-") && name.ends_with(".rlpart")
}

fn peer_tag(peer: EndpointId) -> String {
    blake3::hash(peer.as_bytes()).to_hex()[..16].to_string()
}

fn temp_name(peer: EndpointId, share_id: &str, comps: &[String], size: u64, mtime_ms: i64) -> String {
    let key = format!("{share_id}|{}|{size}|{mtime_ms}", comps.join("/"));
    let h = blake3::hash(key.as_bytes()).to_hex()[..16].to_string();
    format!(".bfup-{}-{h}.rlpart", peer_tag(peer))
}

fn rel_key(comps: &[String]) -> String {
    comps.join("/")
}

/// Whether an upload record still describes what is on disk.
fn owns(u: Option<&UploadRow>, is_dir: bool, size: u64, mtime_ms: i64) -> bool {
    match u {
        Some(u) if u.is_dir == is_dir => is_dir || (u.size == size && u.mtime_ms == mtime_ms),
        _ => false,
    }
}

/// This device's uploads in a share, by share-relative path.
pub fn owned_map(inner: &Inner, share_id: &str, peer: EndpointId) -> HashMap<String, UploadRow> {
    inner
        .db
        .uploads_by_peer(share_id, &peer.to_string())
        .unwrap_or_default()
        .into_iter()
        .map(|u| (u.path.clone(), u))
        .collect()
}

/// Whether the entry `name` in folder `dir` (share-relative) was uploaded by the asking device.
pub fn entry_is_mine(owned: &HashMap<String, UploadRow>, dir: &[String], name: &str, is_dir: bool, size: u64, mtime_ms: i64) -> bool {
    if owned.is_empty() {
        return false;
    }
    let mut p = dir.to_vec();
    p.push(name.to_string());
    owns(owned.get(&rel_key(&p)), is_dir, size, mtime_ms)
}

/// Destination path components from the network, made safe to create on
/// this computer. The same input always maps to the same names, so every
/// file of a folder upload lands in the same folders.
fn clean_comps(path: &[String]) -> Result<Vec<String>, Response> {
    if path.is_empty() || validate_components(path).is_err() {
        return Err(Response::err(ErrCode::BadRequest, "Invalid path."));
    }
    let comps: Vec<String> = path.iter().map(|c| sanitize_filename(c)).collect();
    if comps.iter().any(|c| is_upload_temp(c)) {
        return Err(Response::err(ErrCode::BadRequest, "That name is reserved."));
    }
    Ok(comps)
}

fn device_name(inner: &Inner, peer_s: &str) -> String {
    inner
        .db
        .list_grants()
        .unwrap_or_default()
        .into_iter()
        .find(|g| g.peer_id == peer_s)
        .map(|g| g.device_name)
        .unwrap_or_else(|| short_peer(peer_s))
}

fn canonical_root(share: &ShareRow) -> Result<PathBuf, Response> {
    std::fs::canonicalize(&share.root_path)
        .map_err(|_| Response::err(ErrCode::NotFound, "The shared folder is missing on the owner's computer."))
}

/// Walks `dirs` below the share root, creating missing folders and recording
/// them as uploaded by `peer`. Returns the canonical folder, always inside the root.
fn ensure_dirs(inner: &Inner, share: &ShareRow, peer: EndpointId, root_c: &Path, dirs: &[String]) -> Result<PathBuf, Response> {
    let peer_s = peer.to_string();
    let mut cur = root_c.to_path_buf();
    let mut rel: Vec<String> = Vec::new();
    for c in dirs {
        rel.push(c.clone());
        let next = cur.join(c);
        match std::fs::symlink_metadata(&next) {
            Ok(m) if m.file_type().is_symlink() => {
                let real = std::fs::canonicalize(&next).map_err(|_| Response::err(ErrCode::NotFound, "Not found."))?;
                if !real.starts_with(root_c) || !real.is_dir() {
                    return Err(Response::err(ErrCode::Denied, "Outside the shared folder."));
                }
                cur = real;
            }
            Ok(m) if m.is_dir() => cur = next,
            Ok(_) => return Err(Response::err(ErrCode::Io, format!("A file named \"{c}\" is in the way."))),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                match std::fs::create_dir(&next) {
                    Ok(()) => {
                        let _ = inner.db.record_upload(&share.id, &rel_key(&rel), &peer_s, true, 0, 0);
                    }
                    Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(e) => return Err(Response::err(ErrCode::Io, format!("Couldn't create the folder: {e}"))),
                }
                cur = next;
            }
            Err(e) => return Err(Response::err(ErrCode::Io, format!("Can't open folder: {e}"))),
        }
    }
    let real = std::fs::canonicalize(&cur).map_err(|_| Response::err(ErrCode::NotFound, "Not found."))?;
    if !real.starts_with(root_c) {
        return Err(Response::err(ErrCode::Denied, "Outside the shared folder."));
    }
    Ok(real)
}

/// Finds an existing folder below the root without creating anything.
fn find_dir(root_c: &Path, dirs: &[String]) -> Option<PathBuf> {
    let mut p = root_c.to_path_buf();
    for c in dirs {
        p.push(c);
    }
    let real = std::fs::canonicalize(&p).ok()?;
    (real.starts_with(root_c) && real.is_dir()).then_some(real)
}

/// Removes the active-upload marker for a temp file when the upload ends.
struct ActiveGuard<'a> {
    inner: &'a Inner,
    temp: PathBuf,
}

impl Drop for ActiveGuard<'_> {
    fn drop(&mut self) {
        self.inner.put_active.lock().remove(&self.temp);
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, Response> + Send + 'static) -> Result<T, Response> {
    tokio::task::spawn_blocking(f)
        .await
        .unwrap_or_else(|_| Err(Response::err(ErrCode::Io, "internal error")))
}

/// Answers with an error while the client may still be sending, then tells
/// it to stop so its next write fails and it reads this answer.
async fn refuse(send: &mut SendStream, recv: &mut RecvStream, resp: Response) -> Result<()> {
    write_frame(send, &resp).await?;
    let _ = recv.stop(VarInt::from_u32(1));
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn handle_put(
    inner: &Arc<Inner>,
    peer: EndpointId,
    conn: &Connection,
    send: &mut SendStream,
    recv: &mut RecvStream,
    share: &ShareRow,
    path: Vec<String>,
    size: u64,
    mtime_ms: i64,
) -> Result<()> {
    let comps = match clean_comps(&path) {
        Ok(c) => c,
        Err(r) => return refuse(send, recv, r).await,
    };
    let tname = temp_name(peer, &share.id, &comps, size, mtime_ms);

    // Folders, temp file and what an earlier attempt already delivered.
    let prepared = {
        let inner = inner.clone();
        let share = share.clone();
        let comps = comps.clone();
        let tname = tname.clone();
        blocking(move || {
            let root_c = canonical_root(&share)?;
            let dir = ensure_dirs(&inner, &share, peer, &root_c, &comps[..comps.len() - 1])?;
            let temp = dir.join(&tname);
            if std::fs::symlink_metadata(&temp).is_ok_and(|m| !m.is_file()) {
                return Err(Response::err(ErrCode::Io, "Can't write the upload here."));
            }
            let file = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(&temp)
                .map_err(|e| Response::err(ErrCode::Io, format!("Can't write on the owner's computer: {e}")))?;
            let len = file.metadata().map(|m| m.len()).unwrap_or(0);
            // Blocks are written only after their hash checks out, so the
            // file holds verified data; a cut-off block is sent again.
            let have = if len == size { size } else { len.min(size) / BLOCK * BLOCK };
            file.set_len(have).map_err(|e| Response::err(ErrCode::Io, format!("Can't write on the owner's computer: {e}")))?;
            let need = size - have;
            if available_space(&dir).is_some_and(|free| free < need.saturating_add(64 * 1024 * 1024)) {
                return Err(Response::err(ErrCode::Io, "Not enough free space on the owner's computer."));
            }
            Ok((dir, temp, file, have))
        })
        .await
    };
    let (dir, temp, file, have) = match prepared {
        Ok(p) => p,
        Err(r) => return refuse(send, recv, r).await,
    };
    if !inner.put_active.lock().insert(temp.clone()) {
        return refuse(send, recv, Response::err(ErrCode::InUse, "This file is already being uploaded.")).await;
    }
    let _active = ActiveGuard { inner, temp: temp.clone() };

    // Shown on the Transfers page while it arrives.
    let track = incoming_for(inner, peer, &share.id, &comps, size, &tname);
    track.received.store(have, Ordering::Relaxed);
    track.active.store(1, Ordering::Relaxed);
    track.last_ms.store(now_ms(), Ordering::Relaxed);
    *track.state.lock() = IncomingState { status: "receiving", error: None, saved_as: None };
    let _track = TrackGuard { inner, track: track.clone() };
    emit_incoming(inner);

    write_frame(send, &Response::PutReady { have }).await?;

    let started_at = now_ms();
    let mut meter = Meter::new(conn);
    let file = Arc::new(file);
    let mut pos = have;
    let mut buf = vec![0u8; BLOCK as usize + 32];
    let mut blocks = 0u32;
    while pos < size {
        let n = (size - pos).min(BLOCK) as usize;
        let read = tokio::time::timeout(BLOCK_TIMEOUT, recv.read_exact(&mut buf[..n + 32])).await;
        if !matches!(read, Ok(Ok(()))) {
            // The uploader went away: keep what arrived so it can continue later.
            let f = file.clone();
            let _ = tokio::task::spawn_blocking(move || f.sync_data()).await;
            anyhow::bail!("upload interrupted at {pos} of {size} bytes");
        }
        if blake3::hash(&buf[..n]).as_bytes() != &buf[n..n + 32] {
            let r = Response::err(ErrCode::BadRequest, "Data was damaged on the way. Try again.");
            return refuse_tracked(inner, &track, send, recv, r).await;
        }
        inner.download_limiter.acquire(n).await;
        let block = buf[..n].to_vec();
        let f = file.clone();
        let at = pos;
        let wrote = tokio::task::spawn_blocking(move || write_all_at(&f, &block, at)).await;
        match wrote {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                let r = Response::err(ErrCode::Io, format!("Couldn't save on the owner's computer: {e}"));
                return refuse_tracked(inner, &track, send, recv, r).await;
            }
            Err(_) => return refuse_tracked(inner, &track, send, recv, Response::err(ErrCode::Io, "internal error")).await,
        }
        pos += n as u64;
        blocks += 1;
        meter.add(conn, n as u64);
        track.received.store(pos, Ordering::Relaxed);
        track.last_ms.store(now_ms(), Ordering::Relaxed);
        // The owner may change the permission or stop sharing mid-upload.
        if blocks % 16 == 0 {
            if let Err(r) = crate::sender::authorize_upload(inner, peer, &share.id) {
                let f = file.clone();
                let _ = tokio::task::spawn_blocking(move || f.sync_data()).await;
                return refuse_tracked(inner, &track, send, recv, r).await;
            }
        }
    }

    // Complete: make it durable, check the whole file again (its fingerprint
    // must match the uploader's), keep the uploader's modification time, and
    // move it to a free name. Never replaces an existing file.
    let name = comps.last().cloned().unwrap_or_default();
    let finished = {
        let inner = inner.clone();
        let share_id = share.id.clone();
        let peer_s = peer.to_string();
        let dir_comps = comps[..comps.len() - 1].to_vec();
        let name = name.clone();
        let temp = temp.clone();
        blocking(move || {
            file.sync_all().map_err(|e| Response::err(ErrCode::Io, format!("Couldn't save on the owner's computer: {e}")))?;
            let fingerprint = file_fingerprint(&file, size)
                .map_err(|e| Response::err(ErrCode::Io, format!("Couldn't read back the saved file: {e}")))?;
            if mtime_ms > 0 {
                let _ = file.set_modified(UNIX_EPOCH + Duration::from_millis(mtime_ms as u64));
            }
            drop(file);
            let _g = inner.put_lock.lock();
            let mut dest = unique_path(&dir.join(&name));
            let mut placed = false;
            for _ in 0..20 {
                match std::fs::hard_link(&temp, &dest) {
                    Ok(()) => {
                        let _ = std::fs::remove_file(&temp);
                        placed = true;
                        break;
                    }
                    Err(e) if e.kind() == io::ErrorKind::AlreadyExists => dest = unique_path(&dest),
                    // No hard links on this file system (FAT, some phone storage).
                    Err(_) if !dest.exists() => {
                        std::fs::rename(&temp, &dest)
                            .map_err(|e| Response::err(ErrCode::Io, format!("Couldn't save on the owner's computer: {e}")))?;
                        placed = true;
                        break;
                    }
                    Err(_) => dest = unique_path(&dest),
                }
            }
            if !placed {
                return Err(Response::err(ErrCode::Io, "Couldn't find a free name for the file."));
            }
            let final_name = dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or(name);
            let meta = std::fs::metadata(&dest).map_err(|e| Response::err(ErrCode::Io, format!("{e}")))?;
            let mut rel = dir_comps;
            rel.push(final_name.clone());
            let _ = inner.db.record_upload(&share_id, &rel_key(&rel), &peer_s, false, meta.len(), system_time_ms(meta.modified()));
            Ok((final_name, fingerprint))
        })
        .await
    };
    match finished {
        Ok((final_name, fingerprint)) => {
            let peer_s = peer.to_string();
            let who = device_name(inner, &peer_s);
            *track.state.lock() = IncomingState { status: "completed", error: None, saved_as: Some(final_name.clone()) };
            track.received.store(size, Ordering::Relaxed);
            add_history(
                inner,
                HistoryEntry {
                    id: format!("ur-{}-{}", short_peer(&peer_s), track.id),
                    direction: "received",
                    peer_id: peer_s,
                    peer_name: who.clone(),
                    name: final_name.clone(),
                    size,
                    started_at: track.started_ms.min(started_at),
                    stats: meter.stats(),
                    fingerprint: fingerprint.clone(),
                },
            );
            inner.log(
                "success",
                &format!("{who} uploaded \"{final_name}\" ({}) to \"{}\"", crate::util::human_bytes(size), share.name),
                None,
            );
            crate::notice::record(inner, "uploaded", peer, &share.name, &final_name, size);
            write_frame(send, &Response::Created { name: final_name, fingerprint: Some(fingerprint) }).await?;
        }
        Err(r) => {
            set_failed(&track, &r);
            write_frame(send, &r).await?
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- fingerprints, stats and history

/// BLAKE3 over the BLAKE3 hashes of the file's 1 MiB blocks, as hex. Both
/// devices compute it for an upload and keep it in their history.
pub fn upload_fingerprint(block_hashes: &[[u8; 32]]) -> String {
    data_encoding::HEXLOWER.encode(&chunk_hash_from_blocks(block_hashes))
}

/// Reads the whole file back and computes its upload fingerprint.
fn file_fingerprint(f: &std::fs::File, size: u64) -> io::Result<String> {
    let mut hashes = Vec::with_capacity(size.div_ceil(BLOCK) as usize);
    let mut buf = vec![0u8; BLOCK as usize];
    let mut pos = 0;
    while pos < size {
        let n = (size - pos).min(BLOCK) as usize;
        read_exact_at(f, &mut buf[..n], pos)?;
        hashes.push(*blake3::hash(&buf[..n]).as_bytes());
        pos += n as u64;
    }
    Ok(upload_fingerprint(&hashes))
}

/// Route and speed counters of one upload stream, for the history receipt.
pub struct Meter {
    started: Instant,
    direct: u64,
    relay: u64,
    is_direct: bool,
    since_route: u32,
    win_start: Instant,
    win_bytes: u64,
    peak: f64,
}

impl Meter {
    pub fn new(conn: &Connection) -> Self {
        let now = Instant::now();
        Meter {
            started: now,
            direct: 0,
            relay: 0,
            is_direct: route_of(conn).is_direct(),
            since_route: 0,
            win_start: now,
            win_bytes: 0,
            peak: 0.0,
        }
    }

    pub fn add(&mut self, conn: &Connection, n: u64) {
        self.since_route += 1;
        if self.since_route >= 16 {
            self.since_route = 0;
            self.is_direct = route_of(conn).is_direct();
        }
        if self.is_direct {
            self.direct += n;
        } else {
            self.relay += n;
        }
        self.win_bytes += n;
        let el = self.win_start.elapsed().as_secs_f64();
        if el >= 1.0 {
            self.peak = self.peak.max(self.win_bytes as f64 / el);
            self.win_start = Instant::now();
            self.win_bytes = 0;
        }
    }

    pub fn stats(&self) -> JobStats {
        let active_ms = self.started.elapsed().as_millis() as u64;
        let total = self.direct + self.relay;
        // Short uploads end before a full window: the average is a floor for the peak.
        let avg = if active_ms > 0 { total as f64 / (active_ms as f64 / 1000.0) } else { 0.0 };
        JobStats { direct_bytes: self.direct, relay_bytes: self.relay, active_ms, peak_bps: self.peak.max(avg) }
    }
}

pub struct HistoryEntry {
    pub id: String,
    pub direction: &'static str,
    pub peer_id: String,
    pub peer_name: String,
    pub name: String,
    pub size: u64,
    pub started_at: i64,
    pub stats: JobStats,
    pub fingerprint: String,
}

/// Keeps a finished upload in this device's history (if history is on).
pub fn add_history(inner: &Inner, h: HistoryEntry) {
    let settings = inner.settings();
    if !settings.history_on() {
        return;
    }
    let row = HistoryRow {
        id: h.id,
        direction: h.direction.into(),
        peer_id: h.peer_id,
        peer_name: h.peer_name,
        name: if settings.history_names { h.name.clone() } else { String::new() },
        ext: crate::receiver::ext_of(&h.name),
        size: h.size,
        started_at: h.started_at,
        finished_at: now_ms(),
        stats: h.stats,
        blocks: h.size.div_ceil(BLOCK),
        fingerprint: h.fingerprint,
    };
    if inner.db.insert_history(&row).is_ok() {
        inner.emit(CoreEvent::HistoryChanged);
    }
}

// ---------------------------------------------------------------- incoming uploads (Transfers page)

fn incoming_for(inner: &Inner, peer: EndpointId, share_id: &str, comps: &[String], size: u64, key: &str) -> Arc<IncomingFile> {
    let id = blake3::hash(key.as_bytes()).to_hex()[..16].to_string();
    let mut map = inner.incoming_files.lock();
    let f = map
        .entry(id.clone())
        .or_insert_with(|| {
            Arc::new(IncomingFile {
                id: id.clone(),
                peer,
                share_id: share_id.to_string(),
                path: comps.to_vec(),
                size,
                received: AtomicU64::new(0),
                active: AtomicU32::new(0),
                started_ms: now_ms(),
                last_ms: AtomicI64::new(now_ms()),
                state: parking_lot::Mutex::new(IncomingState { status: "receiving", error: None, saved_as: None }),
                rate: parking_lot::Mutex::new((0, 0.0)),
            })
        })
        .clone();
    // Keep the list bounded: drop the oldest idle entries.
    if map.len() > 200 {
        let mut idle: Vec<(i64, String)> = map
            .values()
            .filter(|f| f.active.load(Ordering::Relaxed) == 0)
            .map(|f| (f.last_ms.load(Ordering::Relaxed), f.id.clone()))
            .collect();
        idle.sort();
        let extra = map.len() - 200;
        for (_, k) in idle.into_iter().take(extra) {
            map.remove(&k);
        }
    }
    f
}

/// Marks a stream's upload as no longer active when the stream ends.
struct TrackGuard<'a> {
    inner: &'a Inner,
    track: Arc<IncomingFile>,
}

impl Drop for TrackGuard<'_> {
    fn drop(&mut self) {
        self.track.active.store(0, Ordering::Relaxed);
        {
            let mut st = self.track.state.lock();
            if st.status == "receiving" {
                st.status = "interrupted";
            }
        }
        self.track.last_ms.store(now_ms(), Ordering::Relaxed);
        emit_incoming(self.inner);
    }
}

fn set_failed(track: &IncomingFile, r: &Response) {
    let msg = match r {
        Response::Error { message, .. } => message.clone(),
        _ => "Upload failed.".into(),
    };
    *track.state.lock() = IncomingState { status: "failed", error: Some(msg), saved_as: None };
}

async fn refuse_tracked(inner: &Inner, track: &IncomingFile, send: &mut SendStream, recv: &mut RecvStream, resp: Response) -> Result<()> {
    set_failed(track, &resp);
    emit_incoming(inner);
    refuse(send, recv, resp).await
}

/// Uploads into this device's shares, newest activity first.
pub fn incoming_list(inner: &Inner) -> Vec<IncomingDto> {
    let files: Vec<Arc<IncomingFile>> = inner.incoming_files.lock().values().cloned().collect();
    let grants = inner.db.list_grants().unwrap_or_default();
    let shares = inner.db.list_shares().unwrap_or_default();
    let mut out: Vec<IncomingDto> = files
        .iter()
        .map(|f| {
            let peer_s = f.peer.to_string();
            let bps = f.rate.lock().1;
            let st = f.state.lock();
            let route = inner
                .incoming
                .lock()
                .get(&f.peer)
                .and_then(|v| v.last().map(|(_, c)| route_of(c).kind))
                .unwrap_or_else(|| "none".into());
            IncomingDto {
                id: f.id.clone(),
                device_name: grants
                    .iter()
                    .find(|g| g.peer_id == peer_s)
                    .map(|g| g.device_name.clone())
                    .unwrap_or_else(|| short_peer(&peer_s)),
                peer_id: peer_s,
                share_id: f.share_id.clone(),
                share_name: shares.iter().find(|s| s.id == f.share_id).map(|s| s.name.clone()).unwrap_or_default(),
                name: f.path.last().cloned().unwrap_or_default(),
                path: f.path.clone(),
                saved_as: st.saved_as.clone(),
                size: f.size,
                received_bytes: if st.status == "completed" { f.size } else { f.received.load(Ordering::Relaxed).min(f.size) },
                bps: if st.status == "receiving" { bps } else { 0.0 },
                status: st.status.into(),
                error: st.error.clone(),
                started_at: f.started_ms,
                updated_at: f.last_ms.load(Ordering::Relaxed),
                route,
            }
        })
        .collect();
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    out
}

pub fn emit_incoming(inner: &Inner) {
    inner.emit(CoreEvent::Incoming(incoming_list(inner)));
}

/// Progress rates, called every second by the ticker. Returns whether any upload is arriving.
pub fn incoming_tick(inner: &Inner) -> bool {
    let files: Vec<Arc<IncomingFile>> = inner.incoming_files.lock().values().cloned().collect();
    let mut busy = false;
    for f in &files {
        let got = f.received.load(Ordering::Relaxed);
        {
            let mut r = f.rate.lock();
            let inst = got.saturating_sub(r.0) as f64;
            r.1 = if r.1 == 0.0 { inst } else { r.1 * 0.7 + inst * 0.3 };
            r.0 = got;
        }
        if f.active.load(Ordering::Relaxed) > 0 {
            busy = true;
        }
    }
    busy
}

pub fn remove_incoming(inner: &Inner, id: &str) {
    let mut map = inner.incoming_files.lock();
    if map.get(id).is_some_and(|f| f.active.load(Ordering::Relaxed) == 0) {
        map.remove(id);
    }
    drop(map);
    emit_incoming(inner);
}

pub fn clear_incoming(inner: &Inner) {
    inner.incoming_files.lock().retain(|_, f| f.state.lock().status != "completed");
    emit_incoming(inner);
}

/// Drops the partial data of an upload the device gave up on.
pub async fn handle_put_abort(inner: &Arc<Inner>, peer: EndpointId, share: &ShareRow, path: Vec<String>, size: u64, mtime_ms: i64) -> Response {
    let comps = match clean_comps(&path) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let tname = temp_name(peer, &share.id, &comps, size, mtime_ms);
    let share = share.clone();
    let inner = inner.clone();
    blocking(move || {
        let root_c = canonical_root(&share)?;
        if let Some(dir) = find_dir(&root_c, &comps[..comps.len() - 1]) {
            let temp = dir.join(&tname);
            if !inner.put_active.lock().contains(&temp) {
                let _ = std::fs::remove_file(&temp);
            }
        }
        Ok(Response::Ack)
    })
    .await
    .unwrap_or_else(|r| r)
}

pub async fn handle_mkdir(inner: &Arc<Inner>, peer: EndpointId, share: &ShareRow, path: Vec<String>, unique: bool) -> Response {
    let comps = match clean_comps(&path) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let share = share.clone();
    let inner = inner.clone();
    blocking(move || {
        let root_c = canonical_root(&share)?;
        let parent = ensure_dirs(&inner, &share, peer, &root_c, &comps[..comps.len() - 1])?;
        let name = comps.last().cloned().unwrap_or_default();
        let target = parent.join(&name);
        let created = if unique {
            let _g = inner.put_lock.lock();
            let mut dest = unique_path(&target);
            let mut made = None;
            for _ in 0..20 {
                match std::fs::create_dir(&dest) {
                    Ok(()) => {
                        made = Some(dest.clone());
                        break;
                    }
                    Err(e) if e.kind() == io::ErrorKind::AlreadyExists => dest = unique_path(&dest),
                    Err(e) => return Err(Response::err(ErrCode::Io, format!("Couldn't create the folder: {e}"))),
                }
            }
            made.ok_or_else(|| Response::err(ErrCode::Io, "Couldn't find a free folder name."))?
        } else {
            match std::fs::symlink_metadata(&target) {
                Ok(m) if m.is_dir() => return Ok(Response::Created { name, fingerprint: None }),
                Ok(_) => return Err(Response::err(ErrCode::Io, format!("A file named \"{name}\" is in the way."))),
                Err(_) => match std::fs::create_dir(&target) {
                    Ok(()) => target.clone(),
                    Err(e) if e.kind() == io::ErrorKind::AlreadyExists => return Ok(Response::Created { name, fingerprint: None }),
                    Err(e) => return Err(Response::err(ErrCode::Io, format!("Couldn't create the folder: {e}"))),
                },
            }
        };
        let final_name = created.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or(name);
        let mut rel = comps[..comps.len() - 1].to_vec();
        rel.push(final_name.clone());
        let _ = inner.db.record_upload(&share.id, &rel_key(&rel), &peer.to_string(), true, 0, 0);
        Ok(Response::Created { name: final_name, fingerprint: None })
    })
    .await
    .unwrap_or_else(|r| r)
}

const NOT_YOURS: &str = "You can only delete files and folders you uploaded.";

/// Checks that everything below `dir` was uploaded by this device and is unchanged.
fn check_tree(dir: &Path, rel: &[String], owned: &HashMap<String, UploadRow>, my_temp_prefix: &str) -> Result<(), Response> {
    let rd = std::fs::read_dir(dir).map_err(|e| Response::err(ErrCode::Io, format!("Can't open folder: {e}")))?;
    for e in rd {
        let e = e.map_err(|e| Response::err(ErrCode::Io, format!("Can't open folder: {e}")))?;
        let ft = e.file_type().map_err(|e| Response::err(ErrCode::Io, format!("{e}")))?;
        let name = e.file_name().to_string_lossy().to_string();
        if ft.is_symlink() {
            return Err(Response::err(ErrCode::Denied, "This folder has items you didn't upload, so you can't delete it."));
        }
        if ft.is_file() && is_upload_temp(&name) {
            if name.starts_with(my_temp_prefix) {
                continue;
            }
            return Err(Response::err(ErrCode::Denied, "Someone is still uploading into this folder."));
        }
        let mut sub = rel.to_vec();
        sub.push(name);
        let meta = e.metadata().map_err(|e| Response::err(ErrCode::Io, format!("{e}")))?;
        let mine = owns(owned.get(&rel_key(&sub)), ft.is_dir(), meta.len(), system_time_ms(meta.modified()));
        if !mine {
            return Err(Response::err(ErrCode::Denied, "This folder has items you didn't upload, so you can't delete it."));
        }
        if ft.is_dir() {
            check_tree(&e.path(), &sub, owned, my_temp_prefix)?;
        }
    }
    Ok(())
}

pub async fn handle_delete(inner: &Arc<Inner>, peer: EndpointId, share: &ShareRow, path: Vec<String>) -> Response {
    if path.is_empty() || validate_components(&path).is_err() || path.iter().any(|c| is_upload_temp(c)) {
        return Response::err(ErrCode::BadRequest, "Invalid path.");
    }
    let owned = owned_map(inner, &share.id, peer);
    let share2 = share.clone();
    let inner2 = inner.clone();
    let p2 = path.clone();
    let res = blocking(move || {
        let root = PathBuf::from(&share2.root_path);
        let parent = crate::sender::resolve_in_share(&root, &p2[..p2.len() - 1])?;
        let target = parent.join(&p2[p2.len() - 1]);
        let meta = std::fs::symlink_metadata(&target).map_err(|_| Response::err(ErrCode::NotFound, "Not found."))?;
        if meta.file_type().is_symlink() {
            return Err(Response::err(ErrCode::Denied, NOT_YOURS));
        }
        let rel = rel_key(&p2);
        let _g = inner2.put_lock.lock();
        if meta.is_dir() {
            if !owns(owned.get(&rel), true, 0, 0) {
                return Err(Response::err(ErrCode::Denied, NOT_YOURS));
            }
            check_tree(&target, &p2, &owned, &format!(".bfup-{}-", peer_tag(peer)))?;
            std::fs::remove_dir_all(&target).map_err(|e| Response::err(ErrCode::Io, format!("Couldn't delete: {e}")))?;
        } else {
            if !owns(owned.get(&rel), false, meta.len(), system_time_ms(meta.modified())) {
                return Err(Response::err(ErrCode::Denied, NOT_YOURS));
            }
            std::fs::remove_file(&target).map_err(|e| Response::err(ErrCode::Io, format!("Couldn't delete: {e}")))?;
        }
        let _ = inner2.db.delete_uploads_under(&share2.id, &rel);
        Ok(())
    })
    .await;
    match res {
        Ok(()) => {
            let who = device_name(inner, &peer.to_string());
            inner.log(
                "info",
                &format!("{who} deleted \"{}\" from \"{}\"", path.last().cloned().unwrap_or_default(), share.name),
                None,
            );
            Response::Ack
        }
        Err(r) => r,
    }
}
