//! Tells the owner when another device downloaded from or uploaded to one of
//! its shared folders. Files finishing close together (a folder) are
//! collected into one notice: an in-app event for a toast and the sidebar,
//! and a system notification when notifications are on.

use std::time::{Duration, Instant};

use iroh::EndpointId;

use crate::inner::Inner;
use crate::types::{CoreEvent, PeerNotice};
use crate::util::{human_bytes, now_ms, random_id, short_peer};

/// A notice goes out once no file was added to it for this long...
const QUIET: Duration = Duration::from_secs(3);
/// ...or at the latest this long after its first file, for long batches.
const MAX_WAIT: Duration = Duration::from_secs(20);

pub struct Pending {
    kind: &'static str,
    peer: EndpointId,
    share_name: String,
    files: u32,
    first_name: String,
    bytes: u64,
    first_at: Instant,
    last_at: Instant,
}

/// Counts one finished file. `kind` is "downloaded" or "uploaded".
pub fn record(inner: &Inner, kind: &'static str, peer: EndpointId, share_name: &str, name: &str, bytes: u64) {
    let key = format!("{kind}|{peer}|{share_name}");
    let now = Instant::now();
    let mut map = inner.peer_notices.lock();
    let p = map.entry(key).or_insert_with(|| Pending {
        kind,
        peer,
        share_name: share_name.to_string(),
        files: 0,
        first_name: name.to_string(),
        bytes: 0,
        first_at: now,
        last_at: now,
    });
    p.files += 1;
    p.bytes += bytes;
    p.last_at = now;
}

/// Sends the notices that are ready (all of them with `all`). Called by the ticker.
pub fn flush(inner: &Inner, all: bool) {
    let ready: Vec<Pending> = {
        let mut map = inner.peer_notices.lock();
        let keys: Vec<String> = map
            .iter()
            .filter(|(_, p)| all || p.last_at.elapsed() >= QUIET || p.first_at.elapsed() >= MAX_WAIT)
            .map(|(k, _)| k.clone())
            .collect();
        keys.into_iter().filter_map(|k| map.remove(&k)).collect()
    };
    if ready.is_empty() {
        return;
    }
    let grants = inner.db.list_grants().unwrap_or_default();
    for p in ready {
        let peer_s = p.peer.to_string();
        let device_name = grants
            .iter()
            .find(|g| g.peer_id == peer_s)
            .map(|g| g.device_name.clone())
            .unwrap_or_else(|| short_peer(&peer_s));
        let what = if p.files == 1 {
            format!("{} ({})", p.first_name, human_bytes(p.bytes))
        } else {
            format!("{} files, {} (including {})", p.files, human_bytes(p.bytes), p.first_name)
        };
        let (title, body) = match p.kind {
            "uploaded" => (format!("{device_name} uploaded to \"{}\"", p.share_name), what),
            _ => (format!("{device_name} downloaded from \"{}\"", p.share_name), what),
        };
        inner.notify(&title, &body);
        inner.emit(CoreEvent::PeerActivity(PeerNotice {
            id: random_id(),
            kind: p.kind.into(),
            peer_id: peer_s,
            device_name,
            share_name: p.share_name,
            files: p.files,
            first_name: p.first_name,
            bytes: p.bytes,
            at: now_ms(),
        }));
    }
}
