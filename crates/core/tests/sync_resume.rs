//! Auto-sync of a remote folder, owner notices for others' transfers, and
//! uploads that continue after the app restarts.

use std::io::Write;
use std::path::Path;
use std::time::{Duration, Instant};

use bifrost_core::*;

fn opts(dir: &Path, name: &str) -> CoreOptions {
    CoreOptions {
        data_dir: dir.join("data"),
        default_device_name: name.into(),
        default_download_dir: dir.join("downloads"),
        local_only: true,
        diagnostics: false,
        endpoint_hook: None,
    }
}

fn make_file(path: &Path, size: usize, seed: u8) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut f = std::fs::File::create(path).unwrap();
    let mut x: u32 = (seed as u32).wrapping_mul(2654435761).wrapping_add(1);
    let mut block = vec![0u8; 1 << 20];
    let mut left = size;
    while left > 0 {
        for b in block.iter_mut() {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            *b = x as u8;
        }
        let n = left.min(block.len());
        f.write_all(&block[..n]).unwrap();
        left -= n;
    }
}

fn hash(path: &Path) -> String {
    blake3::hash(&std::fs::read(path).unwrap()).to_hex().to_string()
}

fn auto_approve(sender: &Core) {
    let s = sender.clone();
    let mut rx = s.subscribe();
    tokio::spawn(async move {
        while let Ok(ev) = rx.recv().await {
            if let CoreEvent::AccessRequested(r) = ev {
                s.respond_access(&r.id, true).unwrap();
            }
        }
    });
}

async fn until<T>(secs: u64, what: &str, mut f: impl FnMut() -> Option<T>) -> T {
    let start = Instant::now();
    loop {
        if let Some(v) = f() {
            return v;
        }
        assert!(start.elapsed() < Duration::from_secs(secs), "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn auto_sync_downloads_new_files_and_never_deletes() {
    let tmp = tempfile::tempdir().unwrap();
    let shared = tmp.path().join("shared");
    make_file(&shared.join("before.txt"), 3000, 1);

    let owner = Core::start(opts(&tmp.path().join("o"), "Owner")).await.unwrap();
    let guest = Core::start(opts(&tmp.path().join("g"), "Guest")).await.unwrap();
    auto_approve(&owner);
    let mut owner_events = owner.subscribe();
    let share = owner.create_share(shared.to_str().unwrap(), None).unwrap();
    guest.add_peer_addr(owner.endpoint_addr());
    let inv = owner.create_invitation_with(&share.id, 3600, Some(1), true, false, Some("both".into())).await.unwrap();
    let peer = guest.join(&inv.invite).await.unwrap().peer_id;

    // New files only: what is there when sync is turned on stays there.
    let dest = tmp.path().join("synced");
    // Called from a plain thread, outside the runtime, the way the app calls
    // non-async commands. This used to panic ("no reactor running").
    {
        let (g, p, s, d) = (guest.clone(), peer.clone(), share.id.clone(), dest.to_string_lossy().to_string());
        std::thread::spawn(move || g.enable_sync(&p, &s, Some(d), false).map(|_| ()))
            .join()
            .expect("enable_sync must not panic outside the runtime")
            .unwrap();
    }
    until(20, "first sync pass", || guest.list_syncs().into_iter().find(|s| s.last_sync_at.is_some() && !s.syncing)).await;
    assert!(!dest.join("before.txt").exists());

    // A file (in a new folder) appears on the owner's side: it is downloaded.
    make_file(&shared.join("new/added.bin"), 2 * 1024 * 1024 + 5, 2);
    guest.sync_now();
    let local = dest.join("new").join("added.bin");
    until(30, "synced download", || {
        guest
            .list_jobs()
            .unwrap()
            .into_iter()
            .find(|j| j.display_name == "added.bin" && j.status == JobStatus::Completed)
    })
    .await;
    assert_eq!(hash(&local), hash(&shared.join("new/added.bin")));

    // The owner gets one notice that the guest downloaded it.
    let notice = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            if let Ok(CoreEvent::PeerActivity(n)) = owner_events.recv().await {
                return n;
            }
        }
    })
    .await
    .expect("owner notice");
    assert_eq!(notice.kind, "downloaded");
    assert_eq!(notice.device_name, "Guest");
    assert_eq!(notice.files, 1);
    assert_eq!(notice.first_name, "added.bin");

    // The owner deletes the folder: the synced copy stays.
    std::fs::remove_dir_all(shared.join("new")).unwrap();
    guest.sync_now();
    tokio::time::sleep(Duration::from_secs(2)).await;
    until(20, "sync pass after delete", || guest.list_syncs().into_iter().find(|s| !s.syncing)).await;
    assert!(local.exists(), "never deleted on this device");

    // Turning sync off keeps the files and stops further downloads.
    guest.disable_sync(&peer, &share.id).unwrap();
    assert!(guest.list_syncs().is_empty());
    make_file(&shared.join("later.txt"), 100, 3);
    guest.sync_now();
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(!dest.join("later.txt").exists());
    assert!(local.exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn upload_continues_after_restart_and_owner_is_notified() {
    let tmp = tempfile::tempdir().unwrap();
    let shared = tmp.path().join("shared");
    std::fs::create_dir_all(&shared).unwrap();
    let local = tmp.path().join("local");
    make_file(&local.join("big.bin"), 10 * 1024 * 1024 + 99, 4);

    let owner = Core::start(opts(&tmp.path().join("o"), "Owner")).await.unwrap();
    auto_approve(&owner);
    let mut owner_events = owner.subscribe();
    let share = owner.create_share(shared.to_str().unwrap(), None).unwrap();
    let peer;
    {
        let guest = Core::start(opts(&tmp.path().join("g"), "Guest")).await.unwrap();
        guest.add_peer_addr(owner.endpoint_addr());
        let inv = owner.create_invitation_with(&share.id, 3600, Some(1), true, false, Some("upload".into())).await.unwrap();
        peer = guest.join(&inv.invite).await.unwrap().peer_id;
        let mut s = guest.settings();
        s.upload_limit_kbps = 3 * 1024;
        guest.update_settings(s).unwrap();
        guest
            .start_upload(&peer, &share.id, vec![], vec![local.join("big.bin").to_string_lossy().to_string()])
            .await
            .unwrap();
        until(30, "upload progress", || guest.list_pushes().first().filter(|p| p.sent_bytes >= 3 * 1024 * 1024).cloned()).await;
        // The app quits mid-upload.
        guest.shutdown().await;
    }

    // Next launch: the upload is still listed and finishes by itself.
    let guest = Core::start(opts(&tmp.path().join("g"), "Guest")).await.unwrap();
    guest.add_peer_addr(owner.endpoint_addr());
    let mut s = guest.settings();
    s.upload_limit_kbps = 0;
    guest.update_settings(s).unwrap();
    assert_eq!(guest.list_pushes().len(), 1, "the upload survived the restart");
    let done = until(60, "resumed upload", || guest.list_pushes().into_iter().find(|p| p.status == "completed")).await;
    assert_eq!(done.saved_as.as_deref(), Some("big.bin"));
    assert_eq!(hash(&shared.join("big.bin")), hash(&local.join("big.bin")));

    let notice = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            if let Ok(CoreEvent::PeerActivity(n)) = owner_events.recv().await {
                return n;
            }
        }
    })
    .await
    .expect("owner notice");
    assert_eq!(notice.kind, "uploaded");
    assert_eq!(notice.first_name, "big.bin");
    let _ = peer;
}
