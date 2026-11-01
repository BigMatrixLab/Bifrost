//! SQLite persistence. WAL mode; chunk state is only committed after the
//! corresponding file data has been flushed, so the database never claims
//! more progress than is durably on disk.

use std::path::Path;

use anyhow::Result;
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};

use crate::types::{ActivityDto, HistoryDto, JobStatus, Settings};
use crate::util::now_ms;

pub struct Db {
    conn: Mutex<Connection>,
}

#[derive(Clone, Debug)]
pub struct ShareRow {
    pub id: String,
    pub root_path: String,
    pub name: String,
    pub active: bool,
    pub created_at: i64,
}

/// A file or folder a remote device created in one of this device's shares.
/// `path` is the share-relative path, components joined with '/'.
#[derive(Clone, Debug)]
pub struct UploadRow {
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime_ms: i64,
}

#[derive(Clone, Debug)]
pub struct InvitationRow {
    pub id: String,
    pub share_id: String,
    pub token_hash: String,
    pub expires_at: i64,
    pub max_uses: Option<u32>,
    pub use_count: u32,
    pub require_approval: bool,
    pub revoked_at: Option<i64>,
    pub created_at: i64,
    /// What a device that joins with it may do: "download", "upload" or "both".
    pub permission: String,
}

impl InvitationRow {
    pub fn state(&self, now: i64) -> &'static str {
        if self.revoked_at.is_some() {
            "revoked"
        } else if self.expires_at <= now {
            "expired"
        } else if self.max_uses.is_some_and(|m| self.use_count >= m) {
            "used_up"
        } else {
            "active"
        }
    }
}

#[derive(Clone, Debug)]
pub struct GrantRow {
    pub peer_id: String,
    pub share_id: String,
    pub device_name: String,
    pub created_at: i64,
    pub last_seen_at: i64,
    /// What this device may do in this share: "download", "upload" or "both".
    pub permission: String,
}

#[derive(Clone, Debug)]
pub struct RemoteRow {
    pub peer_id: String,
    pub name: String,
    pub relay_url: Option<String>,
    pub created_at: i64,
    pub last_seen_at: i64,
}

#[derive(Clone, Debug)]
pub struct JobRow {
    pub id: String,
    pub peer_id: String,
    pub share_id: String,
    pub remote_path: Vec<String>,
    pub display_name: String,
    pub size: u64,
    pub mtime_ms: i64,
    pub chunk_size: u64,
    pub total_chunks: u64,
    pub dest_path: String,
    pub temp_path: String,
    pub verified_bytes: u64,
    pub status: JobStatus,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub completed_at: Option<i64>,
    pub stats: JobStats,
}

/// Per-job route and timing counters, kept for the privacy receipt.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct JobStats {
    pub direct_bytes: u64,
    pub relay_bytes: u64,
    pub active_ms: u64,
    pub peak_bps: f64,
}

/// One finished transfer, sent or received. Lives only on this device.
#[derive(Clone, Debug)]
pub struct HistoryRow {
    pub id: String,
    /// "received" or "sent"
    pub direction: String,
    pub peer_id: String,
    pub peer_name: String,
    /// Empty when the user chose not to keep file names.
    pub name: String,
    pub ext: String,
    pub size: u64,
    pub started_at: i64,
    pub finished_at: i64,
    pub stats: JobStats,
    pub blocks: u64,
    pub fingerprint: String,
}

const SCHEMA_V1: &str = r#"
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS shares(
  id TEXT PRIMARY KEY, root_path TEXT NOT NULL, display_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS invitations(
  id TEXT PRIMARY KEY, share_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL, max_uses INTEGER, use_count INTEGER NOT NULL DEFAULT 0,
  require_approval INTEGER NOT NULL DEFAULT 1, revoked_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS grants(
  peer_id TEXT NOT NULL, share_id TEXT NOT NULL, device_name TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, PRIMARY KEY(peer_id, share_id));
CREATE TABLE IF NOT EXISTS remotes(
  peer_id TEXT PRIMARY KEY, name TEXT NOT NULL, relay_url TEXT,
  created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS remote_shares(
  peer_id TEXT NOT NULL, share_id TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(peer_id, share_id));
CREATE TABLE IF NOT EXISTS jobs(
  id TEXT PRIMARY KEY, peer_id TEXT NOT NULL, share_id TEXT NOT NULL, remote_path TEXT NOT NULL,
  display_name TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL,
  chunk_size INTEGER NOT NULL, total_chunks INTEGER NOT NULL, dest_path TEXT NOT NULL,
  temp_path TEXT NOT NULL, verified_bytes INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
  error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER);
CREATE TABLE IF NOT EXISTS chunks(
  job_id TEXT NOT NULL, idx INTEGER NOT NULL, hash BLOB NOT NULL, PRIMARY KEY(job_id, idx)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS activity(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, level TEXT NOT NULL,
  message TEXT NOT NULL, job_id TEXT);
"#;

/// Chunk-hash schemes: 1 = BLAKE3 of the chunk bytes (v1 protocol),
/// 2 = BLAKE3 over the chunk's 1 MiB block hashes (v2 protocol).
pub const SCHEME_BLOCKS: u8 = 2;

const SCHEMA_V2: &str = r#"
ALTER TABLE chunks ADD COLUMN scheme INTEGER NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS partials(
  job_id TEXT NOT NULL, idx INTEGER NOT NULL, done INTEGER NOT NULL, hashes BLOB NOT NULL,
  PRIMARY KEY(job_id, idx)) WITHOUT ROWID;
"#;

const SCHEMA_V3: &str = r#"
ALTER TABLE jobs ADD COLUMN direct_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN relay_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN active_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN peak_bps REAL NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS history(
  id TEXT PRIMARY KEY, direction TEXT NOT NULL, peer_id TEXT NOT NULL, peer_name TEXT NOT NULL,
  name TEXT NOT NULL, ext TEXT NOT NULL, size INTEGER NOT NULL,
  started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL, active_ms INTEGER NOT NULL,
  direct_bytes INTEGER NOT NULL, relay_bytes INTEGER NOT NULL, peak_bps REAL NOT NULL,
  blocks INTEGER NOT NULL, fingerprint TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS history_finished ON history(finished_at);
"#;

/// The 16-character code of each invitation and its sealed record (the
/// invitation encrypted under the code), so the code can be published again
/// after a restart. Stays on this device, like the identity key.
const SCHEMA_V4: &str = r#"
CREATE TABLE IF NOT EXISTS invitation_codes(
  invitation_id TEXT PRIMARY KEY, code TEXT NOT NULL, sealed TEXT NOT NULL);
"#;

/// Per-share permission (owner side), the permission a remote share grants
/// this device (receiver side), and who uploaded what into this device's
/// shares, so a device can only delete what it uploaded.
const SCHEMA_V5: &str = r#"
ALTER TABLE shares ADD COLUMN permission TEXT NOT NULL DEFAULT 'download';
ALTER TABLE remote_shares ADD COLUMN permission TEXT NOT NULL DEFAULT 'download';
CREATE TABLE IF NOT EXISTS uploads(
  share_id TEXT NOT NULL, path TEXT NOT NULL, peer_id TEXT NOT NULL, is_dir INTEGER NOT NULL,
  size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(share_id, path)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS uploads_peer ON uploads(share_id, peer_id);
"#;

/// Permission moves from the share to each device's access: every invitation
/// carries one, and a device gets it when it joins. Existing invitations and
/// devices keep what their share allowed, so nothing changes on upgrade.
/// (`shares.permission` stays in the table but is no longer used.)
const SCHEMA_V7: &str = r#"
ALTER TABLE grants ADD COLUMN permission TEXT NOT NULL DEFAULT 'download';
ALTER TABLE invitations ADD COLUMN permission TEXT NOT NULL DEFAULT 'download';
UPDATE grants SET permission=COALESCE((SELECT s.permission FROM shares s WHERE s.id=grants.share_id), 'download');
UPDATE invitations SET permission=COALESCE((SELECT s.permission FROM shares s WHERE s.id=invitations.share_id), 'download');
"#;

/// Uploads from this device (so they continue after a restart), and
/// auto-synced remote shares with the files each sync has already seen.
const SCHEMA_V6: &str = r#"
CREATE TABLE IF NOT EXISTS pushes(
  id TEXT PRIMARY KEY, peer_id TEXT NOT NULL, peer_name TEXT NOT NULL, share_id TEXT NOT NULL,
  share_name TEXT NOT NULL, local_path TEXT NOT NULL, remote_path TEXT NOT NULL, size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL, status TEXT NOT NULL, error TEXT, saved_as TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  direct_bytes INTEGER NOT NULL DEFAULT 0, relay_bytes INTEGER NOT NULL DEFAULT 0,
  active_ms INTEGER NOT NULL DEFAULT 0, peak_bps REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sync_shares(
  peer_id TEXT NOT NULL, share_id TEXT NOT NULL, dest_dir TEXT NOT NULL, created_at INTEGER NOT NULL,
  baseline_done INTEGER NOT NULL DEFAULT 0, last_sync_at INTEGER, last_error TEXT,
  PRIMARY KEY(peer_id, share_id));
CREATE TABLE IF NOT EXISTS sync_seen(
  peer_id TEXT NOT NULL, share_id TEXT NOT NULL, path TEXT NOT NULL,
  PRIMARY KEY(peer_id, share_id, path)) WITHOUT ROWID;
"#;

/// An upload from this device into another device's share.
#[derive(Clone, Debug)]
pub struct PushRow {
    pub id: String,
    pub peer_id: String,
    pub peer_name: String,
    pub share_id: String,
    pub share_name: String,
    pub local_path: String,
    pub remote_path: Vec<String>,
    pub size: u64,
    pub mtime_ms: i64,
    pub status: String,
    pub error: Option<String>,
    pub saved_as: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub stats: JobStats,
}

/// A remote share this device downloads new files from automatically.
#[derive(Clone, Debug)]
pub struct SyncRow {
    pub peer_id: String,
    pub share_id: String,
    pub dest_dir: String,
    pub created_at: i64,
    /// Set once the files present when sync was turned on were recorded (or queued).
    pub baseline_done: bool,
    pub last_sync_at: Option<i64>,
    pub last_error: Option<String>,
}

/// Verified prefix of a chunk: (chunk index, bytes done, block hashes).
pub type Partial = (u64, u64, Vec<[u8; 32]>);

fn pack_hashes(h: &[[u8; 32]]) -> Vec<u8> {
    h.iter().flat_map(|x| x.iter().copied()).collect()
}

fn unpack_hashes(b: &[u8]) -> Vec<[u8; 32]> {
    b.chunks_exact(32)
        .map(|c| {
            let mut a = [0u8; 32];
            a.copy_from_slice(c);
            a
        })
        .collect()
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if version < 1 {
            conn.execute_batch(SCHEMA_V1)?;
            conn.pragma_update(None, "user_version", 1)?;
        }
        if version < 2 {
            conn.execute_batch(SCHEMA_V2)?;
            conn.pragma_update(None, "user_version", 2)?;
        }
        if version < 3 {
            conn.execute_batch(SCHEMA_V3)?;
            conn.pragma_update(None, "user_version", 3)?;
        }
        if version < 4 {
            conn.execute_batch(SCHEMA_V4)?;
            conn.pragma_update(None, "user_version", 4)?;
        }
        if version < 5 {
            conn.execute_batch(SCHEMA_V5)?;
            conn.pragma_update(None, "user_version", 5)?;
        }
        if version < 6 {
            conn.execute_batch(SCHEMA_V6)?;
            conn.pragma_update(None, "user_version", 6)?;
        }
        if version < 7 {
            conn.execute_batch(SCHEMA_V7)?;
            conn.pragma_update(None, "user_version", 7)?;
        }
        Ok(Db { conn: Mutex::new(conn) })
    }

    // ---------------------------------------------------------------- settings

    pub fn load_settings(&self) -> Option<Settings> {
        let c = self.conn.lock();
        let v: Option<String> = c
            .query_row("SELECT value FROM settings WHERE key='settings'", [], |r| r.get(0))
            .optional()
            .ok()
            .flatten();
        v.and_then(|s| serde_json::from_str(&s).ok())
    }

    pub fn save_settings(&self, s: &Settings) -> Result<()> {
        let c = self.conn.lock();
        c.execute(
            "INSERT INTO settings(key,value) VALUES('settings',?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![serde_json::to_string(s)?],
        )?;
        Ok(())
    }

    // ---------------------------------------------------------------- shares

    pub fn insert_share(&self, s: &ShareRow) -> Result<()> {
        self.conn.lock().execute(
            "INSERT INTO shares(id,root_path,display_name,active,created_at) VALUES(?1,?2,?3,?4,?5)",
            params![s.id, s.root_path, s.name, s.active, s.created_at],
        )?;
        Ok(())
    }

    pub fn list_shares(&self) -> Result<Vec<ShareRow>> {
        let c = self.conn.lock();
        let mut st = c.prepare(
            "SELECT id,root_path,display_name,active,created_at FROM shares ORDER BY created_at",
        )?;
        let rows = st
            .query_map([], |r| {
                Ok(ShareRow {
                    id: r.get(0)?,
                    root_path: r.get(1)?,
                    name: r.get(2)?,
                    active: r.get(3)?,
                    created_at: r.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn get_share(&self, id: &str) -> Result<Option<ShareRow>> {
        Ok(self.list_shares()?.into_iter().find(|s| s.id == id))
    }

    pub fn set_share_active(&self, id: &str, active: bool) -> Result<()> {
        self.conn
            .lock()
            .execute("UPDATE shares SET active=?2 WHERE id=?1", params![id, active])?;
        Ok(())
    }

    pub fn delete_share(&self, id: &str) -> Result<()> {
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        tx.execute("DELETE FROM shares WHERE id=?1", params![id])?;
        tx.execute("DELETE FROM invitations WHERE share_id=?1", params![id])?;
        tx.execute("DELETE FROM grants WHERE share_id=?1", params![id])?;
        tx.execute("DELETE FROM uploads WHERE share_id=?1", params![id])?;
        tx.commit()?;
        Ok(())
    }

    // ---------------------------------------------------------------- uploads from this device

    pub fn save_push(&self, p: &PushRow) -> Result<()> {
        self.conn.lock().execute(
            "INSERT OR REPLACE INTO pushes(id,peer_id,peer_name,share_id,share_name,local_path,remote_path,size,mtime_ms,
               status,error,saved_as,created_at,updated_at,direct_bytes,relay_bytes,active_ms,peak_bps)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)",
            params![
                p.id,
                p.peer_id,
                p.peer_name,
                p.share_id,
                p.share_name,
                p.local_path,
                serde_json::to_string(&p.remote_path)?,
                p.size as i64,
                p.mtime_ms,
                p.status,
                p.error,
                p.saved_as,
                p.created_at,
                p.updated_at,
                p.stats.direct_bytes as i64,
                p.stats.relay_bytes as i64,
                p.stats.active_ms as i64,
                p.stats.peak_bps,
            ],
        )?;
        Ok(())
    }

    pub fn list_pushes(&self) -> Result<Vec<PushRow>> {
        let c = self.conn.lock();
        let mut st = c.prepare(
            "SELECT id,peer_id,peer_name,share_id,share_name,local_path,remote_path,size,mtime_ms,status,error,saved_as,
               created_at,updated_at,direct_bytes,relay_bytes,active_ms,peak_bps FROM pushes",
        )?;
        let rows = st
            .query_map([], |r| {
                let rp: String = r.get(6)?;
                Ok(PushRow {
                    id: r.get(0)?,
                    peer_id: r.get(1)?,
                    peer_name: r.get(2)?,
                    share_id: r.get(3)?,
                    share_name: r.get(4)?,
                    local_path: r.get(5)?,
                    remote_path: serde_json::from_str(&rp).unwrap_or_default(),
                    size: r.get::<_, i64>(7)? as u64,
                    mtime_ms: r.get(8)?,
                    status: r.get(9)?,
                    error: r.get(10)?,
                    saved_as: r.get(11)?,
                    created_at: r.get(12)?,
                    updated_at: r.get(13)?,
                    stats: JobStats {
                        direct_bytes: r.get::<_, i64>(14)? as u64,
                        relay_bytes: r.get::<_, i64>(15)? as u64,
                        active_ms: r.get::<_, i64>(16)? as u64,
                        peak_bps: r.get(17)?,
                    },
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn delete_push(&self, id: &str) -> Result<()> {
        self.conn.lock().execute("DELETE FROM pushes WHERE id=?1", params![id])?;
        Ok(())
    }

    pub fn delete_finished_pushes(&self) -> Result<()> {
        self.conn.lock().execute("DELETE FROM pushes WHERE status='completed'", [])?;
        Ok(())
    }

    // ---------------------------------------------------------------- auto-sync of remote shares

    pub fn upsert_sync(&self, s: &SyncRow) -> Result<()> {
        self.conn.lock().execute(
            "INSERT INTO sync_shares(peer_id,share_id,dest_dir,created_at,baseline_done,last_sync_at,last_error)
             VALUES(?1,?2,?3,?4,?5,?6,?7)
             ON CONFLICT(peer_id,share_id) DO UPDATE SET dest_dir=excluded.dest_dir, baseline_done=excluded.baseline_done,
               last_sync_at=excluded.last_sync_at, last_error=excluded.last_error",
            params![s.peer_id, s.share_id, s.dest_dir, s.created_at, s.baseline_done, s.last_sync_at, s.last_error],
        )?;
        Ok(())
    }

    pub fn list_syncs(&self) -> Result<Vec<SyncRow>> {
        let c = self.conn.lock();
        let mut st = c.prepare(
            "SELECT peer_id,share_id,dest_dir,created_at,baseline_done,last_sync_at,last_error FROM sync_shares",
        )?;
        let rows = st
            .query_map([], |r| {
                Ok(SyncRow {
                    peer_id: r.get(0)?,
                    share_id: r.get(1)?,
                    dest_dir: r.get(2)?,
                    created_at: r.get(3)?,
                    baseline_done: r.get(4)?,
                    last_sync_at: r.get(5)?,
                    last_error: r.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Turns sync off and forgets what it had seen.
    pub fn delete_sync(&self, peer_id: &str, share_id: &str) -> Result<()> {
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        tx.execute("DELETE FROM sync_shares WHERE peer_id=?1 AND share_id=?2", params![peer_id, share_id])?;
        tx.execute("DELETE FROM sync_seen WHERE peer_id=?1 AND share_id=?2", params![peer_id, share_id])?;
        tx.commit()?;
        Ok(())
    }

    pub fn sync_seen(&self, peer_id: &str, share_id: &str) -> Result<std::collections::HashSet<String>> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT path FROM sync_seen WHERE peer_id=?1 AND share_id=?2")?;
        let rows = st
            .query_map(params![peer_id, share_id], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<std::collections::HashSet<_>>>()?;
        Ok(rows)
    }

    pub fn remove_sync_seen(&self, peer_id: &str, share_id: &str, paths: &[String]) -> Result<()> {
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        {
            let mut st = tx.prepare("DELETE FROM sync_seen WHERE peer_id=?1 AND share_id=?2 AND path=?3")?;
            for p in paths {
                st.execute(params![peer_id, share_id, p])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn add_sync_seen(&self, peer_id: &str, share_id: &str, paths: &[String]) -> Result<()> {
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        {
            let mut st = tx.prepare("INSERT OR IGNORE INTO sync_seen(peer_id,share_id,path) VALUES(?1,?2,?3)")?;
            for p in paths {
                st.execute(params![peer_id, share_id, p])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    // ---------------------------------------------------------------- uploads (who created what in a share)

    #[allow(clippy::too_many_arguments)]
    pub fn record_upload(&self, share_id: &str, path: &str, peer_id: &str, is_dir: bool, size: u64, mtime_ms: i64) -> Result<()> {
        self.conn.lock().execute(
            "INSERT INTO uploads(share_id,path,peer_id,is_dir,size,mtime_ms,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)
             ON CONFLICT(share_id,path) DO UPDATE SET peer_id=excluded.peer_id, is_dir=excluded.is_dir,
               size=excluded.size, mtime_ms=excluded.mtime_ms, created_at=excluded.created_at",
            params![share_id, path, peer_id, is_dir, size as i64, mtime_ms, now_ms()],
        )?;
        Ok(())
    }

    /// Everything one device uploaded into a share.
    pub fn uploads_by_peer(&self, share_id: &str, peer_id: &str) -> Result<Vec<UploadRow>> {
        let c = self.conn.lock();
        let mut st = c.prepare(
            "SELECT path,is_dir,size,mtime_ms FROM uploads WHERE share_id=?1 AND peer_id=?2",
        )?;
        let rows = st
            .query_map(params![share_id, peer_id], |r| {
                Ok(UploadRow {
                    path: r.get(0)?,
                    is_dir: r.get(1)?,
                    size: r.get::<_, i64>(2)? as u64,
                    mtime_ms: r.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Forgets a path and everything below it.
    pub fn delete_uploads_under(&self, share_id: &str, path: &str) -> Result<()> {
        self.conn.lock().execute(
            "DELETE FROM uploads WHERE share_id=?1 AND (path=?2 OR substr(path,1,length(?2)+1)=?2||'/')",
            params![share_id, path],
        )?;
        Ok(())
    }

    // ---------------------------------------------------------------- invitations

    pub fn insert_invitation(&self, i: &InvitationRow) -> Result<()> {
        self.conn.lock().execute(
            "INSERT INTO invitations(id,share_id,token_hash,expires_at,max_uses,use_count,require_approval,revoked_at,created_at,permission)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                i.id,
                i.share_id,
                i.token_hash,
                i.expires_at,
                i.max_uses,
                i.use_count,
                i.require_approval,
                i.revoked_at,
                i.created_at,
                i.permission
            ],
        )?;
        Ok(())
    }

    fn map_invitation(r: &rusqlite::Row) -> rusqlite::Result<InvitationRow> {
        Ok(InvitationRow {
            id: r.get(0)?,
            share_id: r.get(1)?,
            token_hash: r.get(2)?,
            expires_at: r.get(3)?,
            max_uses: r.get(4)?,
            use_count: r.get(5)?,
            require_approval: r.get(6)?,
            revoked_at: r.get(7)?,
            created_at: r.get(8)?,
            permission: crate::types::normalize_permission(&r.get::<_, String>(9)?).to_string(),
        })
    }

    pub fn list_invitations(&self) -> Result<Vec<InvitationRow>> {
        let c = self.conn.lock();
        let mut st = c.prepare(
            "SELECT id,share_id,token_hash,expires_at,max_uses,use_count,require_approval,revoked_at,created_at,permission
             FROM invitations ORDER BY created_at DESC",
        )?;
        let rows = st
            .query_map([], Self::map_invitation)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn find_invitation_by_hash(&self, token_hash: &str) -> Result<Option<InvitationRow>> {
        let c = self.conn.lock();
        Ok(c.query_row(
            "SELECT id,share_id,token_hash,expires_at,max_uses,use_count,require_approval,revoked_at,created_at,permission
             FROM invitations WHERE token_hash=?1",
            params![token_hash],
            Self::map_invitation,
        )
        .optional()?)
    }

    pub fn increment_invitation_use(&self, id: &str) -> Result<()> {
        self.conn.lock().execute(
            "UPDATE invitations SET use_count=use_count+1 WHERE id=?1",
            params![id],
        )?;
        Ok(())
    }

    pub fn revoke_invitation(&self, id: &str) -> Result<()> {
        self.conn.lock().execute(
            "UPDATE invitations SET revoked_at=?2 WHERE id=?1 AND revoked_at IS NULL",
            params![id, now_ms()],
        )?;
        Ok(())
    }

    pub fn get_invitation(&self, id: &str) -> Result<Option<InvitationRow>> {
        let c = self.conn.lock();
        Ok(c.query_row(
            "SELECT id,share_id,token_hash,expires_at,max_uses,use_count,require_approval,revoked_at,created_at,permission
             FROM invitations WHERE id=?1",
            params![id],
            Self::map_invitation,
        )
        .optional()?)
    }

    pub fn save_invitation_code(&self, invitation_id: &str, code: &str, sealed: &str) -> Result<()> {
        self.conn.lock().execute(
            "INSERT OR REPLACE INTO invitation_codes(invitation_id,code,sealed) VALUES(?1,?2,?3)",
            params![invitation_id, code, sealed],
        )?;
        Ok(())
    }

    /// (invitation id, code, sealed record) for every saved code.
    pub fn list_invitation_codes(&self) -> Result<Vec<(String, String, String)>> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT invitation_id,code,sealed FROM invitation_codes")?;
        let rows = st
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn delete_invitation_code(&self, invitation_id: &str) -> Result<()> {
        self.conn.lock().execute("DELETE FROM invitation_codes WHERE invitation_id=?1", params![invitation_id])?;
        Ok(())
    }

    // ---------------------------------------------------------------- grants

    /// Gives a device access to a share with the invitation's permission.
    pub fn upsert_grant(&self, peer_id: &str, share_id: &str, device_name: &str, permission: &str) -> Result<()> {
        let now = now_ms();
        self.conn.lock().execute(
            "INSERT INTO grants(peer_id,share_id,device_name,created_at,last_seen_at,permission) VALUES(?1,?2,?3,?4,?4,?5)
             ON CONFLICT(peer_id,share_id) DO UPDATE SET device_name=excluded.device_name, last_seen_at=excluded.last_seen_at,
               permission=excluded.permission",
            params![peer_id, share_id, device_name, now, permission],
        )?;
        Ok(())
    }

    /// Changes what one device may do in one share. Returns whether it had access.
    pub fn set_grant_permission(&self, peer_id: &str, share_id: &str, permission: &str) -> Result<bool> {
        let n = self.conn.lock().execute(
            "UPDATE grants SET permission=?3 WHERE peer_id=?1 AND share_id=?2",
            params![peer_id, share_id, permission],
        )?;
        Ok(n > 0)
    }

    pub fn list_grants(&self) -> Result<Vec<GrantRow>> {
        let c = self.conn.lock();
        let mut st = c.prepare(
            "SELECT peer_id,share_id,device_name,created_at,last_seen_at,permission FROM grants ORDER BY last_seen_at DESC",
        )?;
        let rows = st
            .query_map([], |r| {
                Ok(GrantRow {
                    peer_id: r.get(0)?,
                    share_id: r.get(1)?,
                    device_name: r.get(2)?,
                    created_at: r.get(3)?,
                    last_seen_at: r.get(4)?,
                    permission: crate::types::normalize_permission(&r.get::<_, String>(5)?).to_string(),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn touch_grants(&self, peer_id: &str) -> Result<()> {
        self.conn.lock().execute(
            "UPDATE grants SET last_seen_at=?2 WHERE peer_id=?1",
            params![peer_id, now_ms()],
        )?;
        Ok(())
    }

    pub fn delete_grants_for_peer(&self, peer_id: &str) -> Result<()> {
        self.conn
            .lock()
            .execute("DELETE FROM grants WHERE peer_id=?1", params![peer_id])?;
        Ok(())
    }

    // ---------------------------------------------------------------- remotes

    pub fn upsert_remote(&self, peer_id: &str, name: &str, relay_url: Option<&str>) -> Result<()> {
        let now = now_ms();
        self.conn.lock().execute(
            "INSERT INTO remotes(peer_id,name,relay_url,created_at,last_seen_at) VALUES(?1,?2,?3,?4,?4)
             ON CONFLICT(peer_id) DO UPDATE SET name=excluded.name,
               relay_url=COALESCE(excluded.relay_url, remotes.relay_url), last_seen_at=excluded.last_seen_at",
            params![peer_id, name, relay_url, now],
        )?;
        Ok(())
    }

    /// Replaces the shares a remote offers: (id, name, permission).
    pub fn set_remote_shares(&self, peer_id: &str, shares: &[(String, String, String)]) -> Result<()> {
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        tx.execute("DELETE FROM remote_shares WHERE peer_id=?1", params![peer_id])?;
        for (id, name, perm) in shares {
            tx.execute(
                "INSERT INTO remote_shares(peer_id,share_id,name,permission) VALUES(?1,?2,?3,?4)",
                params![peer_id, id, name, perm],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Updates the cached permission of one remote share. Returns whether it changed.
    pub fn set_remote_share_permission(&self, peer_id: &str, share_id: &str, permission: &str) -> Result<bool> {
        let n = self.conn.lock().execute(
            "UPDATE remote_shares SET permission=?3 WHERE peer_id=?1 AND share_id=?2 AND permission<>?3",
            params![peer_id, share_id, permission],
        )?;
        Ok(n > 0)
    }

    /// Remotes with their shares: (id, name, permission).
    pub fn list_remotes(&self) -> Result<Vec<(RemoteRow, Vec<(String, String, String)>)>> {
        let c = self.conn.lock();
        let mut st = c.prepare(
            "SELECT peer_id,name,relay_url,created_at,last_seen_at FROM remotes ORDER BY last_seen_at DESC",
        )?;
        let remotes = st
            .query_map([], |r| {
                Ok(RemoteRow {
                    peer_id: r.get(0)?,
                    name: r.get(1)?,
                    relay_url: r.get(2)?,
                    created_at: r.get(3)?,
                    last_seen_at: r.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut st2 = c.prepare("SELECT share_id,name,permission FROM remote_shares WHERE peer_id=?1 ORDER BY name")?;
        let mut out = Vec::new();
        for r in remotes {
            let shares = st2
                .query_map(params![r.peer_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            out.push((r, shares));
        }
        Ok(out)
    }

    pub fn get_remote(&self, peer_id: &str) -> Result<Option<RemoteRow>> {
        let c = self.conn.lock();
        Ok(c.query_row(
            "SELECT peer_id,name,relay_url,created_at,last_seen_at FROM remotes WHERE peer_id=?1",
            params![peer_id],
            |r| {
                Ok(RemoteRow {
                    peer_id: r.get(0)?,
                    name: r.get(1)?,
                    relay_url: r.get(2)?,
                    created_at: r.get(3)?,
                    last_seen_at: r.get(4)?,
                })
            },
        )
        .optional()?)
    }

    pub fn delete_remote(&self, peer_id: &str) -> Result<()> {
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        tx.execute("DELETE FROM remotes WHERE peer_id=?1", params![peer_id])?;
        tx.execute("DELETE FROM remote_shares WHERE peer_id=?1", params![peer_id])?;
        tx.execute("DELETE FROM sync_shares WHERE peer_id=?1", params![peer_id])?;
        tx.execute("DELETE FROM sync_seen WHERE peer_id=?1", params![peer_id])?;
        tx.commit()?;
        Ok(())
    }

    // ---------------------------------------------------------------- jobs

    pub fn insert_job(&self, j: &JobRow) -> Result<()> {
        self.conn.lock().execute(
            "INSERT INTO jobs(id,peer_id,share_id,remote_path,display_name,size,mtime_ms,chunk_size,total_chunks,
              dest_path,temp_path,verified_bytes,status,error,created_at,updated_at,completed_at,
              direct_bytes,relay_bytes,active_ms,peak_bps)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)",
            params![
                j.id,
                j.peer_id,
                j.share_id,
                serde_json::to_string(&j.remote_path)?,
                j.display_name,
                j.size as i64,
                j.mtime_ms,
                j.chunk_size as i64,
                j.total_chunks as i64,
                j.dest_path,
                j.temp_path,
                j.verified_bytes as i64,
                j.status.as_str(),
                j.error,
                j.created_at,
                j.updated_at,
                j.completed_at,
                j.stats.direct_bytes as i64,
                j.stats.relay_bytes as i64,
                j.stats.active_ms as i64,
                j.stats.peak_bps
            ],
        )?;
        Ok(())
    }

    fn map_job(r: &rusqlite::Row) -> rusqlite::Result<JobRow> {
        let path: String = r.get(3)?;
        let status: String = r.get(12)?;
        Ok(JobRow {
            id: r.get(0)?,
            peer_id: r.get(1)?,
            share_id: r.get(2)?,
            remote_path: serde_json::from_str(&path).unwrap_or_default(),
            display_name: r.get(4)?,
            size: r.get::<_, i64>(5)? as u64,
            mtime_ms: r.get(6)?,
            chunk_size: r.get::<_, i64>(7)? as u64,
            total_chunks: r.get::<_, i64>(8)? as u64,
            dest_path: r.get(9)?,
            temp_path: r.get(10)?,
            verified_bytes: r.get::<_, i64>(11)? as u64,
            status: JobStatus::parse(&status),
            error: r.get(13)?,
            created_at: r.get(14)?,
            updated_at: r.get(15)?,
            completed_at: r.get(16)?,
            stats: JobStats {
                direct_bytes: r.get::<_, i64>(17)? as u64,
                relay_bytes: r.get::<_, i64>(18)? as u64,
                active_ms: r.get::<_, i64>(19)? as u64,
                peak_bps: r.get(20)?,
            },
        })
    }

    const JOB_COLS: &'static str = "id,peer_id,share_id,remote_path,display_name,size,mtime_ms,chunk_size,total_chunks,
        dest_path,temp_path,verified_bytes,status,error,created_at,updated_at,completed_at,
        direct_bytes,relay_bytes,active_ms,peak_bps";

    pub fn get_job(&self, id: &str) -> Result<Option<JobRow>> {
        let c = self.conn.lock();
        Ok(c.query_row(
            &format!("SELECT {} FROM jobs WHERE id=?1", Self::JOB_COLS),
            params![id],
            Self::map_job,
        )
        .optional()?)
    }

    pub fn list_jobs(&self) -> Result<Vec<JobRow>> {
        let c = self.conn.lock();
        let mut st = c.prepare(&format!(
            "SELECT {} FROM jobs ORDER BY created_at DESC",
            Self::JOB_COLS
        ))?;
        let rows = st
            .query_map([], Self::map_job)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn set_job_status(&self, id: &str, status: JobStatus, error: Option<&str>) -> Result<()> {
        self.conn.lock().execute(
            "UPDATE jobs SET status=?2, error=?3, updated_at=?4 WHERE id=?1",
            params![id, status.as_str(), error, now_ms()],
        )?;
        Ok(())
    }

    pub fn set_job_completed(&self, id: &str, dest_path: &str) -> Result<()> {
        let now = now_ms();
        self.conn.lock().execute(
            "UPDATE jobs SET status='completed', error=NULL, dest_path=?2, updated_at=?3, completed_at=?3 WHERE id=?1",
            params![id, dest_path, now],
        )?;
        Ok(())
    }

    /// Points a job at a new version of its source file and drops all progress.
    pub fn update_job_source(&self, id: &str, size: u64, mtime_ms: i64, total_chunks: u64) -> Result<()> {
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        tx.execute(
            "UPDATE jobs SET size=?2, mtime_ms=?3, total_chunks=?4, verified_bytes=0, status='queued', error=NULL, updated_at=?5,
               direct_bytes=0, relay_bytes=0, active_ms=0, peak_bps=0 WHERE id=?1",
            params![id, size as i64, mtime_ms, total_chunks as i64, now_ms()],
        )?;
        tx.execute("DELETE FROM chunks WHERE job_id=?1", params![id])?;
        tx.execute("DELETE FROM partials WHERE job_id=?1", params![id])?;
        tx.commit()?;
        Ok(())
    }

    pub fn delete_job(&self, id: &str) -> Result<()> {
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        tx.execute("DELETE FROM jobs WHERE id=?1", params![id])?;
        tx.execute("DELETE FROM chunks WHERE job_id=?1", params![id])?;
        tx.execute("DELETE FROM partials WHERE job_id=?1", params![id])?;
        tx.commit()?;
        Ok(())
    }

    /// Finished chunks: (index, hash, scheme).
    pub fn verified_chunks(&self, job_id: &str) -> Result<Vec<(u64, [u8; 32], u8)>> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT idx,hash,scheme FROM chunks WHERE job_id=?1 ORDER BY idx")?;
        let rows = st
            .query_map(params![job_id], |r| {
                let idx: i64 = r.get(0)?;
                let h: Vec<u8> = r.get(1)?;
                let scheme: i64 = r.get(2)?;
                let mut hash = [0u8; 32];
                if h.len() == 32 {
                    hash.copy_from_slice(&h);
                }
                Ok((idx as u64, hash, scheme as u8))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn partials(&self, job_id: &str) -> Result<Vec<Partial>> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT idx,done,hashes FROM partials WHERE job_id=?1 ORDER BY idx")?;
        let rows = st
            .query_map(params![job_id], |r| {
                let idx: i64 = r.get(0)?;
                let done: i64 = r.get(1)?;
                let b: Vec<u8> = r.get(2)?;
                Ok((idx as u64, done as u64, unpack_hashes(&b)))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Atomically records finished chunks, part-finished chunks and the new
    /// verified byte count. Call only after the file data has been flushed.
    pub fn commit_progress(
        &self,
        job_id: &str,
        done: &[(u64, [u8; 32])],
        partials: &[Partial],
        verified_bytes: u64,
        stats: &JobStats,
    ) -> Result<()> {
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        {
            let mut ins = tx.prepare(
                "INSERT INTO chunks(job_id,idx,hash,scheme) VALUES(?1,?2,?3,?4)
                 ON CONFLICT(job_id,idx) DO UPDATE SET hash=excluded.hash, scheme=excluded.scheme",
            )?;
            let mut del = tx.prepare("DELETE FROM partials WHERE job_id=?1 AND idx=?2")?;
            for (idx, hash) in done {
                ins.execute(params![job_id, *idx as i64, &hash[..], SCHEME_BLOCKS as i64])?;
                del.execute(params![job_id, *idx as i64])?;
            }
            let mut up = tx.prepare(
                "INSERT INTO partials(job_id,idx,done,hashes) VALUES(?1,?2,?3,?4)
                 ON CONFLICT(job_id,idx) DO UPDATE SET done=excluded.done, hashes=excluded.hashes",
            )?;
            for (idx, d, hashes) in partials {
                up.execute(params![job_id, *idx as i64, *d as i64, pack_hashes(hashes)])?;
            }
        }
        tx.execute(
            "UPDATE jobs SET verified_bytes=?2, updated_at=?3, direct_bytes=?4, relay_bytes=?5, active_ms=?6, peak_bps=?7 WHERE id=?1",
            params![
                job_id,
                verified_bytes as i64,
                now_ms(),
                stats.direct_bytes as i64,
                stats.relay_bytes as i64,
                stats.active_ms as i64,
                stats.peak_bps
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn save_job_stats(&self, job_id: &str, stats: &JobStats) -> Result<()> {
        self.conn.lock().execute(
            "UPDATE jobs SET direct_bytes=?2, relay_bytes=?3, active_ms=?4, peak_bps=?5 WHERE id=?1",
            params![
                job_id,
                stats.direct_bytes as i64,
                stats.relay_bytes as i64,
                stats.active_ms as i64,
                stats.peak_bps
            ],
        )?;
        Ok(())
    }

    /// Fingerprint of a finished file: BLAKE3 over its chunk hashes, in order.
    pub fn file_fingerprint(&self, job_id: &str) -> Result<String> {
        let mut h = blake3::Hasher::new();
        h.update(b"relayless-file-v1");
        for (_, hash, _) in self.verified_chunks(job_id)? {
            h.update(&hash);
        }
        Ok(h.finalize().to_hex().to_string())
    }

    // ---------------------------------------------------------------- history

    /// Records a finished transfer. Ignores duplicates.
    pub fn insert_history(&self, h: &HistoryRow) -> Result<()> {
        self.conn.lock().execute(
            "INSERT OR IGNORE INTO history(id,direction,peer_id,peer_name,name,ext,size,started_at,finished_at,
               active_ms,direct_bytes,relay_bytes,peak_bps,blocks,fingerprint)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
            params![
                h.id,
                h.direction,
                h.peer_id,
                h.peer_name,
                h.name,
                h.ext,
                h.size as i64,
                h.started_at,
                h.finished_at,
                h.stats.active_ms as i64,
                h.stats.direct_bytes as i64,
                h.stats.relay_bytes as i64,
                h.stats.peak_bps,
                h.blocks as i64,
                h.fingerprint
            ],
        )?;
        Ok(())
    }

    pub fn list_history(&self, since_ms: i64) -> Result<Vec<HistoryDto>> {
        let c = self.conn.lock();
        let mut st = c.prepare(
            "SELECT id,direction,peer_id,peer_name,name,ext,size,started_at,finished_at,active_ms,
               direct_bytes,relay_bytes,peak_bps,blocks,fingerprint
             FROM history WHERE finished_at >= ?1 ORDER BY finished_at DESC",
        )?;
        let rows = st
            .query_map(params![since_ms], |r| {
                Ok(HistoryDto {
                    id: r.get(0)?,
                    direction: r.get(1)?,
                    peer_id: r.get(2)?,
                    peer_name: r.get(3)?,
                    name: r.get(4)?,
                    ext: r.get(5)?,
                    size: r.get::<_, i64>(6)? as u64,
                    started_at: r.get(7)?,
                    finished_at: r.get(8)?,
                    active_ms: r.get::<_, i64>(9)? as u64,
                    direct_bytes: r.get::<_, i64>(10)? as u64,
                    relay_bytes: r.get::<_, i64>(11)? as u64,
                    peak_bps: r.get(12)?,
                    blocks: r.get::<_, i64>(13)? as u64,
                    fingerprint: r.get(14)?,
                    safety_words: Vec::new(),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Deletes history older than `cutoff_ms` (everything when `cutoff_ms` is `i64::MAX`).
    pub fn prune_history(&self, cutoff_ms: i64) -> Result<usize> {
        Ok(self
            .conn
            .lock()
            .execute("DELETE FROM history WHERE finished_at < ?1", params![cutoff_ms])?)
    }

    pub fn remove_chunks(&self, job_id: &str, idxs: &[u64], verified_bytes: u64) -> Result<()> {
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        for idx in idxs {
            tx.execute("DELETE FROM chunks WHERE job_id=?1 AND idx=?2", params![job_id, *idx as i64])?;
            tx.execute("DELETE FROM partials WHERE job_id=?1 AND idx=?2", params![job_id, *idx as i64])?;
        }
        tx.execute(
            "UPDATE jobs SET verified_bytes=?2 WHERE id=?1",
            params![job_id, verified_bytes as i64],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Forgets all progress for a job.
    pub fn clear_chunks(&self, job_id: &str) -> Result<()> {
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        tx.execute("DELETE FROM chunks WHERE job_id=?1", params![job_id])?;
        tx.execute("DELETE FROM partials WHERE job_id=?1", params![job_id])?;
        tx.execute("UPDATE jobs SET verified_bytes=0 WHERE id=?1", params![job_id])?;
        tx.commit()?;
        Ok(())
    }

    // ---------------------------------------------------------------- activity

    pub fn add_activity(&self, level: &str, message: &str, job_id: Option<&str>) -> Result<ActivityDto> {
        let c = self.conn.lock();
        let ts = now_ms();
        c.execute(
            "INSERT INTO activity(ts,level,message,job_id) VALUES(?1,?2,?3,?4)",
            params![ts, level, message, job_id],
        )?;
        let id = c.last_insert_rowid();
        // Keep the log bounded.
        if id % 200 == 0 {
            c.execute("DELETE FROM activity WHERE id <= ?1", params![id - 2000])?;
        }
        Ok(ActivityDto {
            id,
            ts,
            level: level.into(),
            message: message.into(),
            job_id: job_id.map(|s| s.to_string()),
        })
    }

    pub fn list_activity(&self, limit: u32) -> Result<Vec<ActivityDto>> {
        let c = self.conn.lock();
        let mut st = c.prepare(
            "SELECT id,ts,level,message,job_id FROM activity ORDER BY id DESC LIMIT ?1",
        )?;
        let rows = st
            .query_map(params![limit], |r| {
                Ok(ActivityDto {
                    id: r.get(0)?,
                    ts: r.get(1)?,
                    level: r.get(2)?,
                    message: r.get(3)?,
                    job_id: r.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Upgrading to per-device permission keeps what each folder allowed:
    /// existing devices and invitations take their folder's old permission.
    #[test]
    fn v7_moves_folder_permission_to_devices_and_invitations() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.db");
        {
            let db = Db::open(&path).unwrap();
            db.insert_share(&ShareRow { id: "s1".into(), root_path: "/x".into(), name: "X".into(), active: true, created_at: 1 }).unwrap();
            db.insert_share(&ShareRow { id: "s2".into(), root_path: "/y".into(), name: "Y".into(), active: true, created_at: 2 }).unwrap();
            db.upsert_grant("p1", "s1", "A", "download").unwrap();
            db.upsert_grant("p1", "s2", "A", "download").unwrap();
            db.insert_invitation(&InvitationRow {
                id: "i1".into(),
                share_id: "s1".into(),
                token_hash: "h".into(),
                expires_at: i64::MAX,
                max_uses: None,
                use_count: 0,
                require_approval: true,
                revoked_at: None,
                created_at: 1,
                permission: "download".into(),
            })
            .unwrap();
            // Back to the v6 layout: permission on the folder only.
            let c = db.conn.lock();
            c.execute_batch(
                "UPDATE shares SET permission='both' WHERE id='s1';
                 UPDATE shares SET permission='upload' WHERE id='s2';
                 ALTER TABLE grants DROP COLUMN permission;
                 ALTER TABLE invitations DROP COLUMN permission;
                 PRAGMA user_version=6;",
            )
            .unwrap();
        }
        let db = Db::open(&path).unwrap();
        let grants = db.list_grants().unwrap();
        let perm = |s: &str| grants.iter().find(|g| g.share_id == s).unwrap().permission.clone();
        assert_eq!(perm("s1"), "both");
        assert_eq!(perm("s2"), "upload");
        assert_eq!(db.get_invitation("i1").unwrap().unwrap().permission, "both");
        // And one device can now be changed on its own.
        assert!(db.set_grant_permission("p1", "s1", "download").unwrap());
        assert!(!db.set_grant_permission("nobody", "s1", "download").unwrap());
    }
}
