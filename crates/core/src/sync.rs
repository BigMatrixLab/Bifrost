//! Auto-sync: for a remote share the user turned it on for, checks the
//! owner's folder every minute (and when the network comes back) and queues
//! downloads for files it hasn't seen before. It only ever adds files on this
//! device: whatever the owner deletes or renames stays here, and a file the
//! user deletes here is not downloaded again while it still exists there.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use iroh::EndpointId;

use crate::db::SyncRow;
use crate::inner::Inner;
use crate::proto::{Request, Response};
use crate::receiver::{get_conn, request};
use crate::types::{perm_can_download, CoreEvent, SyncDto};
use crate::util::{now_ms, sanitize_filename};

/// How often each synced folder is checked for new files.
pub const INTERVAL: Duration = Duration::from_secs(60);

fn key(peer_id: &str, share_id: &str) -> String {
    format!("{peer_id}|{share_id}")
}

/// Asks for a pass over every synced folder now.
pub fn kick(inner: &Inner) {
    inner.sync_wake.notify_one();
}

pub async fn run(inner: Arc<Inner>) {
    // Let the endpoint come up before the first pass.
    tokio::select! {
        _ = tokio::time::sleep(Duration::from_secs(3)) => {}
        _ = inner.shutdown.cancelled() => return,
    }
    loop {
        for row in inner.db.list_syncs().unwrap_or_default() {
            if inner.shutdown.is_cancelled() {
                return;
            }
            let _ = pass(&inner, row).await;
        }
        tokio::select! {
            _ = tokio::time::sleep(INTERVAL) => {}
            _ = inner.sync_wake.notified() => {}
            _ = inner.shutdown.cancelled() => return,
        }
    }
}

/// Marks a folder as being checked; cleared on drop.
struct Running<'a>(&'a Inner, String);

impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.0.syncing.lock().remove(&self.1);
        self.0.emit(CoreEvent::SyncsChanged);
    }
}

/// One check of one synced folder. Returns how many downloads it queued.
pub async fn pass(inner: &Arc<Inner>, mut row: SyncRow) -> Result<usize> {
    let k = key(&row.peer_id, &row.share_id);
    if !inner.syncing.lock().insert(k.clone()) {
        return Ok(0);
    }
    let _running = Running(inner, k);
    inner.emit(CoreEvent::SyncsChanged);
    let res = pass_inner(inner, &mut row).await;
    row.last_sync_at = Some(now_ms());
    row.last_error = res.as_ref().err().map(|e| e.to_string());
    // Only touch the row if sync wasn't turned off meanwhile.
    let still_on = inner
        .db
        .list_syncs()
        .unwrap_or_default()
        .iter()
        .any(|s| s.peer_id == row.peer_id && s.share_id == row.share_id);
    if still_on {
        let _ = inner.db.upsert_sync(&row);
    }
    res
}

async fn pass_inner(inner: &Arc<Inner>, row: &mut SyncRow) -> Result<usize> {
    let peer: EndpointId = row.peer_id.parse().map_err(|_| anyhow!("Invalid device id."))?;
    let (remote, shares) = inner
        .db
        .list_remotes()?
        .into_iter()
        .find(|(r, _)| r.peer_id == row.peer_id)
        .ok_or_else(|| anyhow!("This device is no longer paired."))?;
    let Some((_, share_name, perm)) = shares.into_iter().find(|(id, _, _)| *id == row.share_id) else {
        bail!("This folder is no longer shared with you.");
    };
    if !perm_can_download(&perm) {
        bail!("The owner doesn't allow downloads from this folder.");
    }
    let conn = get_conn(inner, peer).await.map_err(|e| anyhow!("{e}"))?;
    let resp = request(&conn, &Request::Walk { share: row.share_id.clone(), path: vec![] })
        .await
        .map_err(|e| anyhow!("{e}"))?;
    let Response::Walk { files, truncated } = resp else { bail!("Unexpected reply from the owner.") };
    // Older owners still list system files (.DS_Store, Thumbs.db, ...).
    let files: Vec<_> = files.into_iter().filter(|f| !crate::util::in_system_path(&f.path)).collect();

    let seen = inner.db.sync_seen(&row.peer_id, &row.share_id)?;
    let present: HashSet<String> = files.iter().map(|f| f.path.join("/")).collect();
    // Forget files that are gone there, so they come again if they return.
    // Nothing is deleted here.
    if !truncated {
        let gone: Vec<String> = seen.difference(&present).cloned().collect();
        if !gone.is_empty() {
            inner.db.remove_sync_seen(&row.peer_id, &row.share_id, &gone)?;
        }
    }
    if !row.baseline_done {
        // Turned on for new files only: what is there now counts as seen.
        let all: Vec<String> = present.into_iter().collect();
        inner.db.add_sync_seen(&row.peer_id, &row.share_id, &all)?;
        row.baseline_done = true;
        return Ok(0);
    }

    let dest_root = PathBuf::from(&row.dest_dir);
    std::fs::create_dir_all(&dest_root).map_err(|e| anyhow!("Can't use the sync folder: {e}"))?;
    let mut queue = Vec::new();
    let mut mark = Vec::new();
    for f in files {
        let k = f.path.join("/");
        if seen.contains(&k) || f.path.is_empty() {
            continue;
        }
        let mut rel = PathBuf::new();
        for c in &f.path {
            rel.push(sanitize_filename(c));
        }
        // Already here with the same size (e.g. synced before): nothing to fetch.
        let local = dest_root.join(&rel);
        if std::fs::metadata(&local).is_ok_and(|m| m.is_file() && m.len() == f.size) {
            mark.push(k);
            continue;
        }
        mark.push(k);
        queue.push((f.path, rel, f.size, f.mtime_ms));
    }
    let n = queue.len();
    if n > 0 {
        crate::queue_files(inner, &row.peer_id, &row.share_id, queue, &dest_root)?;
        inner.log("info", &format!("Sync: {n} new file(s) in \"{share_name}\" from {}", remote.name), None);
    }
    if !mark.is_empty() {
        inner.db.add_sync_seen(&row.peer_id, &row.share_id, &mark)?;
    }
    if truncated {
        bail!("The folder has more files than Bifrost syncs (50,000); only those were checked.");
    }
    Ok(n)
}

pub fn list(inner: &Inner) -> Vec<SyncDto> {
    let running = inner.syncing.lock().clone();
    inner
        .db
        .list_syncs()
        .unwrap_or_default()
        .into_iter()
        .map(|s| SyncDto {
            syncing: running.contains(&key(&s.peer_id, &s.share_id)),
            peer_id: s.peer_id,
            share_id: s.share_id,
            dest_dir: s.dest_dir,
            enabled_at: s.created_at,
            last_sync_at: s.last_sync_at,
            last_error: s.last_error,
        })
        .collect()
}

/// Turns sync on (or changes its folder). With `include_existing`, files
/// already in the share are downloaded too; otherwise only new ones.
pub fn enable(inner: &Arc<Inner>, peer_id: &str, share_id: &str, dest_dir: Option<String>, include_existing: bool) -> Result<SyncDto> {
    let (_, shares) = inner
        .db
        .list_remotes()?
        .into_iter()
        .find(|(r, _)| r.peer_id == peer_id)
        .ok_or_else(|| anyhow!("Unknown device."))?;
    let (_, share_name, perm) = shares
        .into_iter()
        .find(|(id, _, _)| id == share_id)
        .ok_or_else(|| anyhow!("This folder is no longer shared with you."))?;
    if !perm_can_download(&perm) {
        bail!("The owner doesn't allow downloads from this folder, so it can't be synced.");
    }
    let dest = match dest_dir.filter(|d| !d.trim().is_empty()) {
        Some(d) => d,
        None => PathBuf::from(&inner.settings().download_dir).join(sanitize_filename(&share_name)).to_string_lossy().to_string(),
    };
    std::fs::create_dir_all(&dest).map_err(|e| anyhow!("Can't use that folder: {e}"))?;
    let existing = inner.db.list_syncs()?.into_iter().find(|s| s.peer_id == peer_id && s.share_id == share_id);
    let row = match existing {
        Some(mut s) => {
            s.dest_dir = dest;
            s
        }
        None => SyncRow {
            peer_id: peer_id.into(),
            share_id: share_id.into(),
            dest_dir: dest,
            created_at: now_ms(),
            baseline_done: include_existing,
            last_sync_at: None,
            last_error: None,
        },
    };
    inner.db.upsert_sync(&row)?;
    inner.log("info", &format!("Auto-sync on for \"{share_name}\" into {}", row.dest_dir), None);
    inner.emit(CoreEvent::SyncsChanged);
    let inner2 = inner.clone();
    let r2 = row.clone();
    inner.rt.spawn(async move {
        let _ = pass(&inner2, r2).await;
    });
    list(inner)
        .into_iter()
        .find(|s| s.peer_id == peer_id && s.share_id == share_id)
        .ok_or_else(|| anyhow!("sync vanished"))
}

pub fn disable(inner: &Inner, peer_id: &str, share_id: &str) -> Result<()> {
    inner.db.delete_sync(peer_id, share_id)?;
    inner.log("info", "Auto-sync off for a folder. Files already downloaded stay.", None);
    inner.emit(CoreEvent::SyncsChanged);
    Ok(())
}
