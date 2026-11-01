//! Wire protocol. Every request opens a fresh bidirectional QUIC stream:
//! the client writes one length-prefixed JSON request and finishes its side,
//! the server answers with one or more length-prefixed JSON frames. A chunk
//! response is followed by the chunk's bytes in 1 MiB blocks, each block
//! followed by its 32-byte BLAKE3 hash, so the receiver can verify and save
//! progress block by block and resume a chunk part-way through.

use anyhow::{bail, Context, Result};
use iroh::endpoint::{RecvStream, SendStream};
use serde::{de::DeserializeOwned, Deserialize, Serialize};

pub const ALPN: &[u8] = b"relayless/1";
pub const PROTOCOL_VERSION: u32 = 2;
/// Unit of verification and resumable progress inside a chunk.
pub const BLOCK: u64 = 1024 * 1024;
/// Largest JSON frame we accept (directory listings are paginated well below this).
pub const MAX_FRAME: usize = 4 * 1024 * 1024;
/// Largest chunk a peer may request.
pub const MAX_CHUNK: u64 = 64 * 1024 * 1024;
/// Largest page of a directory listing.
pub const MAX_LIST_PAGE: u32 = 1000;
/// Largest recursive walk (number of files) for a folder download.
pub const MAX_WALK_FILES: usize = 50_000;

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Request {
    Hello {
        v: u32,
        token: Option<String>,
        device_name: String,
    },
    List {
        share: String,
        path: Vec<String>,
        offset: u32,
        limit: u32,
    },
    Walk {
        share: String,
        path: Vec<String>,
    },
    Stat {
        share: String,
        path: Vec<String>,
    },
    Chunk {
        share: String,
        path: Vec<String>,
        size: u64,
        mtime_ms: i64,
        chunk_size: u64,
        index: u64,
        /// Byte offset inside the chunk to start from (a multiple of BLOCK).
        #[serde(default)]
        from: u64,
        /// Bytes of this file the receiver already has, so the sender can
        /// show real progress. Older receivers leave it out.
        #[serde(default)]
        have: Option<u64>,
    },
    /// Sent by the receiver after a file is complete and verified, so the
    /// sender can keep its own history entry. Older senders reject it,
    /// which is harmless.
    Receipt {
        share: String,
        path: Vec<String>,
        size: u64,
        job: String,
        fingerprint: String,
        started_at: i64,
        finished_at: i64,
        active_ms: u64,
        direct_bytes: u64,
        relay_bytes: u64,
        peak_bps: f64,
        blocks: u64,
    },
    /// Upload a file into a share (needs upload permission). `path` is the
    /// destination including the file name; missing folders are created.
    /// The owner answers `PutReady { have }` with the bytes it already holds
    /// from an earlier attempt (a multiple of BLOCK). The client then sends
    /// the rest as `[block][BLAKE3(block)]` per BLOCK and finishes its side;
    /// the owner answers `Created { name }` with the final name (renamed
    /// " (n)" if taken; an upload never replaces an existing file).
    /// Older owners don't know it and drop the stream.
    Put {
        share: String,
        path: Vec<String>,
        size: u64,
        mtime_ms: i64,
    },
    /// Forget the partial data of an upload that won't be continued.
    PutAbort {
        share: String,
        path: Vec<String>,
        size: u64,
        mtime_ms: i64,
    },
    /// Create a folder (needs upload permission). With `unique`, a taken
    /// name gets " (n)" and the answer names the folder actually created.
    Mkdir {
        share: String,
        path: Vec<String>,
        #[serde(default)]
        unique: bool,
    },
    /// Delete a file or folder this device uploaded (needs upload
    /// permission). Folders only if everything inside was uploaded by it.
    Delete {
        share: String,
        path: Vec<String>,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HelloStatus {
    Approved,
    Pending,
    Denied,
    InvalidInvite,
    Expired,
    Revoked,
    UsedUp,
    Unsupported,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct WireShare {
    pub id: String,
    pub name: String,
    /// "download", "upload" or "both". Older owners leave it out, which
    /// means download only.
    #[serde(default)]
    pub perm: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct HelloResp {
    pub status: HelloStatus,
    pub sender_name: String,
    pub shares: Vec<WireShare>,
    pub message: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct WireEntry {
    pub name: String,
    pub dir: bool,
    pub size: u64,
    pub mtime_ms: i64,
    /// Uploaded by the device asking, so it may delete it.
    #[serde(default)]
    pub mine: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct WalkFile {
    pub path: Vec<String>,
    pub size: u64,
    pub mtime_ms: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrCode {
    Denied,
    NotFound,
    SourceChanged,
    RelayBlocked,
    BadRequest,
    Io,
    InUse,
    /// The sender paused this file for this receiver; ask again later.
    /// Older receivers can't parse it and treat it as a network error, which
    /// also makes them retry.
    Paused,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "r", rename_all = "snake_case")]
pub enum Response {
    Hello(HelloResp),
    List {
        entries: Vec<WireEntry>,
        total: u64,
        /// The asking device's current permission for the share, so it
        /// notices changes without reconnecting. Absent from older owners.
        #[serde(default)]
        perm: Option<String>,
    },
    Walk { files: Vec<WalkFile>, truncated: bool },
    Stat { size: u64, mtime_ms: i64, dir: bool },
    Chunk { len: u64 },
    PutReady { have: u64 },
    Created {
        name: String,
        /// For a finished upload: BLAKE3 of the whole saved file, so both
        /// devices keep the same fingerprint in their history.
        #[serde(default)]
        fingerprint: Option<String>,
    },
    Ack,
    Error { code: ErrCode, message: String },
}

impl Response {
    pub fn err(code: ErrCode, message: impl Into<String>) -> Self {
        Response::Error { code, message: message.into() }
    }
}

/// Error surfaced to the receiver when the sender rejects a request.
#[derive(Debug, thiserror::Error)]
#[error("{code:?}: {message}")]
pub struct RemoteError {
    pub code: ErrCode,
    pub message: String,
}

pub async fn write_frame<T: Serialize>(send: &mut SendStream, value: &T) -> Result<()> {
    let buf = serde_json::to_vec(value)?;
    if buf.len() > MAX_FRAME {
        bail!("frame too large");
    }
    send.write_all(&(buf.len() as u32).to_be_bytes()).await?;
    send.write_all(&buf).await?;
    Ok(())
}

pub async fn read_frame<T: DeserializeOwned>(recv: &mut RecvStream) -> Result<T> {
    let mut len = [0u8; 4];
    recv.read_exact(&mut len).await.context("reading frame length")?;
    let len = u32::from_be_bytes(len) as usize;
    if len > MAX_FRAME {
        bail!("peer sent oversized frame ({len} bytes)");
    }
    let mut buf = vec![0u8; len];
    recv.read_exact(&mut buf).await.context("reading frame body")?;
    Ok(serde_json::from_slice(&buf).context("decoding frame")?)
}

/// Hash recorded for a finished chunk: BLAKE3 over its block hashes.
pub fn chunk_hash_from_blocks(blocks: &[[u8; 32]]) -> [u8; 32] {
    let mut h = blake3::Hasher::new();
    h.update(b"relayless-chunk-v2");
    for b in blocks {
        h.update(b);
    }
    *h.finalize().as_bytes()
}

/// Validates path components received from the network: no traversal,
/// no separators, no drive prefixes, no NUL, bounded length.
pub fn validate_components(path: &[String]) -> Result<()> {
    if path.len() > 128 {
        bail!("path too deep");
    }
    for c in path {
        if c.is_empty()
            || c == "."
            || c == ".."
            || c.len() > 255
            || c.contains(['/', '\\', ':', '\0'])
        {
            bail!("invalid path component");
        }
    }
    Ok(())
}
