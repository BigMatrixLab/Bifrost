//! Uploads into a shared folder: per-share permission, ownership of uploaded
//! files, and deleting only what this device uploaded.

use std::io::Write;
use std::path::Path;
use std::time::{Duration, Instant};

use relayless_core::*;

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

/// Waits until every upload finished; returns them.
async fn wait_pushes(core: &Core) -> Vec<PushDto> {
    let start = Instant::now();
    loop {
        let list = core.list_pushes();
        if !list.is_empty() && list.iter().all(|p| matches!(p.status.as_str(), "completed" | "failed" | "canceled")) {
            return list;
        }
        assert!(start.elapsed() < Duration::from_secs(60), "uploads didn't finish: {list:#?}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn names(core: &Core, peer: &str, share: &str, path: &[&str]) -> Vec<(String, bool)> {
    let path: Vec<String> = path.iter().map(|s| s.to_string()).collect();
    core.list_remote_dir(peer, share, path, 0, 1000)
        .await
        .unwrap()
        .entries
        .into_iter()
        .map(|e| (e.name, e.mine))
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn upload_permissions_and_owner_only_delete() {
    let tmp = tempfile::tempdir().unwrap();
    let shared = tmp.path().join("shared");
    make_file(&shared.join("owners.txt"), 5000, 1);
    let local = tmp.path().join("local");
    make_file(&local.join("report.bin"), 3 * 1024 * 1024 + 777, 2);
    make_file(&local.join("album/a.jpg"), 200_000, 3);
    make_file(&local.join("album/deep/b.jpg"), 1_500_000, 4);
    std::fs::create_dir_all(local.join("album/empty")).unwrap();

    let owner = Core::start(opts(&tmp.path().join("o"), "Owner PC")).await.unwrap();
    let guest = Core::start(opts(&tmp.path().join("g"), "Guest PC")).await.unwrap();
    auto_approve(&owner);

    // New invitations take the default from Settings: download only.
    let share = owner.create_share(shared.to_str().unwrap(), None).unwrap();
    guest.add_peer_addr(owner.endpoint_addr());
    let inv = owner.create_invitation(&share.id, 3600, Some(1), true, false).await.unwrap();
    assert_eq!(inv.invitation.permission, "download");
    let guest_id = guest.endpoint_id();
    let joined = guest.join(&inv.invite).await.unwrap();
    assert_eq!(joined.shares[0].permission, "download");
    let peer = joined.peer_id.clone();

    let report = local.join("report.bin").to_string_lossy().to_string();
    let err = guest.start_upload(&peer, &share.id, vec![], vec![report.clone()]).await.unwrap_err();
    assert!(err.to_string().contains("doesn't allow uploads"), "{err}");
    assert!(guest.remote_mkdir(&peer, &share.id, vec!["x".into()]).await.is_err(), "mkdir needs upload permission");

    // The owner allows this device both; it learns it from the next listing.
    owner.set_device_permission(&guest_id, &share.id, "both").unwrap();
    let g = owner.list_grants().unwrap().into_iter().find(|g| g.peer_id == guest_id).unwrap();
    assert_eq!(g.permission, "both");
    let listed = guest.list_remote_dir(&peer, &share.id, vec![], 0, 100).await.unwrap();
    assert_eq!(listed.permission, "both");
    assert_eq!(guest.list_remotes().unwrap()[0].shares[0].permission, "both");

    // Upload a file and a folder (with a nested file and an empty folder).
    let album = local.join("album").to_string_lossy().to_string();
    let ids = guest.start_upload(&peer, &share.id, vec![], vec![report.clone(), album]).await.unwrap();
    assert_eq!(ids.len(), 3);
    let done = wait_pushes(&guest).await;
    assert!(done.iter().all(|p| p.status == "completed"), "{done:#?}");
    assert_eq!(hash(&shared.join("report.bin")), hash(&local.join("report.bin")));
    assert_eq!(hash(&shared.join("album/deep/b.jpg")), hash(&local.join("album/deep/b.jpg")));
    assert!(shared.join("album/empty").is_dir());
    // The owner registers each upload: in its transfer list and its history,
    // with the same fingerprint the uploader keeps.
    let arrived = owner.list_incoming();
    assert_eq!(arrived.len(), 3, "{arrived:#?}");
    assert!(arrived.iter().all(|f| f.status == "completed" && f.received_bytes == f.size), "{arrived:#?}");
    let report_in = arrived.iter().find(|f| f.name == "report.bin").unwrap();
    assert_eq!(report_in.device_name, "Guest PC");
    let owner_hist = owner.list_history(0).unwrap();
    let guest_hist = guest.list_history(0).unwrap();
    let got = owner_hist.iter().find(|h| h.direction == "received" && h.name == "report.bin").expect("owner history");
    let sent = guest_hist.iter().find(|h| h.direction == "sent" && h.name == "report.bin").expect("uploader history");
    assert_eq!(got.fingerprint, sent.fingerprint);
    assert_eq!(got.fingerprint.len(), 64);
    assert_eq!(got.size, 3 * 1024 * 1024 + 777);
    assert_eq!(got.direct_bytes + got.relay_bytes, got.size);
    // No partial files left behind, and none shown.
    let leftovers: Vec<_> = std::fs::read_dir(&shared).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".rlpart")).collect();
    assert!(leftovers.is_empty());

    // Uploading the same name again never replaces: it gets a free name.
    guest.clear_pushes();
    guest.start_upload(&peer, &share.id, vec![], vec![report.clone()]).await.unwrap();
    let again = wait_pushes(&guest).await;
    assert_eq!(again[0].saved_as.as_deref(), Some("report (1).bin"));
    // A folder with a taken name is created under a free name too.
    let made = guest.remote_mkdir(&peer, &share.id, vec!["album".into()]).await.unwrap();
    assert_eq!(made, "album (1)");

    // Ownership shows in listings.
    let root = names(&guest, &peer, &share.id, &[]).await;
    let mine = |n: &str| root.iter().find(|(x, _)| x == n).map(|(_, m)| *m);
    assert_eq!(mine("owners.txt"), Some(false));
    assert_eq!(mine("report.bin"), Some(true));
    assert_eq!(mine("album"), Some(true));

    // The guest can't delete the owner's file, or reach outside the share.
    let e = guest.remote_delete(&peer, &share.id, vec!["owners.txt".into()]).await.unwrap_err();
    assert!(e.to_string().contains("only delete"), "{e}");
    assert!(shared.join("owners.txt").exists());
    assert!(guest.remote_delete(&peer, &share.id, vec!["..".into()]).await.is_err());

    // A folder the owner added a file to can't be deleted by the guest...
    make_file(&shared.join("album/owner-note.txt"), 100, 9);
    let e = guest.remote_delete(&peer, &share.id, vec!["album".into()]).await.unwrap_err();
    assert!(e.to_string().contains("didn't upload"), "{e}");
    assert!(shared.join("album/owner-note.txt").exists());
    // ...nor a file the owner changed after it was uploaded.
    std::fs::write(shared.join("report (1).bin"), b"owner edited this").unwrap();
    assert!(guest.remote_delete(&peer, &share.id, vec!["report (1).bin".into()]).await.is_err());
    assert!(shared.join("report (1).bin").exists());

    // Its own untouched uploads go.
    guest.remote_delete(&peer, &share.id, vec!["report.bin".into()]).await.unwrap();
    assert!(!shared.join("report.bin").exists());
    std::fs::remove_file(shared.join("album/owner-note.txt")).unwrap();
    guest.remote_delete(&peer, &share.id, vec!["album".into()]).await.unwrap();
    assert!(!shared.join("album").exists());

    // Upload only: a drop box. The guest sees only its own items and can't download.
    owner.set_device_permission(&guest_id, &share.id, "upload").unwrap();
    let root = names(&guest, &peer, &share.id, &[]).await;
    assert_eq!(root, vec![("album (1)".to_string(), true)], "only the guest's own folder is visible");
    let dl = guest
        .start_download(&peer, &share.id, vec![DownloadItem { path: vec!["owners.txt".into()], is_dir: false }], None)
        .await;
    assert!(dl.is_err(), "downloads are refused with upload-only permission");

    // Download only again: no uploads, no deletes.
    owner.set_device_permission(&guest_id, &share.id, "download").unwrap();
    assert!(guest.remote_delete(&peer, &share.id, vec!["album (1)".into()]).await.is_err());
    assert!(shared.join("album (1)").is_dir());
    let root = names(&guest, &peer, &share.id, &[]).await;
    assert!(root.iter().any(|(n, _)| n == "owners.txt"));

    // Settings default applies to new invitations.

    let mut s = owner.settings();
    s.default_share_permission = "both".into();
    owner.update_settings(s).unwrap();
    let other = tmp.path().join("other");
    std::fs::create_dir_all(&other).unwrap();
    let other_share = owner.create_share(other.to_str().unwrap(), None).unwrap();
    assert_eq!(owner.create_invitation(&other_share.id, 3600, None, true, false).await.unwrap().invitation.permission, "both");
    let mut s = owner.settings();
    s.default_share_permission = "nonsense".into();
    assert_eq!(owner.update_settings(s).unwrap().default_share_permission, "download");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn other_devices_uploads_are_protected() {
    let tmp = tempfile::tempdir().unwrap();
    let shared = tmp.path().join("shared");
    std::fs::create_dir_all(&shared).unwrap();
    let local = tmp.path().join("local");
    make_file(&local.join("one.txt"), 1000, 1);
    make_file(&local.join("two.txt"), 2000, 2);

    let owner = Core::start(opts(&tmp.path().join("o"), "Owner")).await.unwrap();
    let a = Core::start(opts(&tmp.path().join("a"), "A")).await.unwrap();
    let b = Core::start(opts(&tmp.path().join("b"), "B")).await.unwrap();
    auto_approve(&owner);
    let share = owner.create_share(shared.to_str().unwrap(), None).unwrap();
    let mut peer = String::new();
    for c in [&a, &b] {
        c.add_peer_addr(owner.endpoint_addr());
        let inv = owner.create_invitation_with(&share.id, 3600, Some(1), true, false, Some("both".into())).await.unwrap();
        peer = c.join(&inv.invite).await.unwrap().peer_id;
    }

    // A makes a folder; B uploads into it.
    let dir = a.remote_mkdir(&peer, &share.id, vec!["drop".into()]).await.unwrap();
    a.start_upload(&peer, &share.id, vec![dir.clone()], vec![local.join("one.txt").to_string_lossy().to_string()]).await.unwrap();
    wait_pushes(&a).await;
    b.start_upload(&peer, &share.id, vec![dir.clone()], vec![local.join("two.txt").to_string_lossy().to_string()]).await.unwrap();
    wait_pushes(&b).await;

    // Each sees only its own uploads as "mine".
    let seen_a = names(&a, &peer, &share.id, &[&dir]).await;
    assert!(seen_a.contains(&("one.txt".to_string(), true)) && seen_a.contains(&("two.txt".to_string(), false)), "{seen_a:?}");

    // A can't delete B's file, nor its own folder while B's file is in it.
    assert!(a.remote_delete(&peer, &share.id, vec![dir.clone(), "two.txt".into()]).await.is_err());
    assert!(a.remote_delete(&peer, &share.id, vec![dir.clone()]).await.is_err());
    assert!(shared.join("drop/two.txt").exists());
    // B deletes its own file; then A can delete its folder.
    b.remote_delete(&peer, &share.id, vec![dir.clone(), "two.txt".into()]).await.unwrap();
    a.remote_delete(&peer, &share.id, vec![dir.clone()]).await.unwrap();
    assert!(!shared.join("drop").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn interrupted_upload_resumes_from_owner_copy() {
    let tmp = tempfile::tempdir().unwrap();
    let shared = tmp.path().join("shared");
    std::fs::create_dir_all(&shared).unwrap();
    let local = tmp.path().join("local");
    make_file(&local.join("big.bin"), 12 * 1024 * 1024 + 4321, 7);

    let owner = Core::start(opts(&tmp.path().join("o"), "Owner")).await.unwrap();
    let guest = Core::start(opts(&tmp.path().join("g"), "Guest")).await.unwrap();
    auto_approve(&owner);
    let share = owner.create_share(shared.to_str().unwrap(), None).unwrap();
    guest.add_peer_addr(owner.endpoint_addr());
    let inv = owner.create_invitation_with(&share.id, 3600, Some(1), true, false, Some("upload".into())).await.unwrap();
    let peer = guest.join(&inv.invite).await.unwrap().peer_id;

    // Slow the guest down so the upload can be cut off part-way.
    let mut s = guest.settings();
    s.upload_limit_kbps = 3 * 1024;
    guest.update_settings(s).unwrap();
    let id = guest
        .start_upload(&peer, &share.id, vec![], vec![local.join("big.bin").to_string_lossy().to_string()])
        .await
        .unwrap()
        .remove(0);
    let start = Instant::now();
    while guest.list_pushes()[0].sent_bytes < 4 * 1024 * 1024 {
        assert!(start.elapsed() < Duration::from_secs(30), "no progress: {:?}", guest.list_pushes());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // The owner pauses sharing: connections close and the upload stops.
    owner.set_share_active(&share.id, false).unwrap();
    let failed = wait_pushes(&guest).await;
    assert_eq!(failed[0].status, "failed", "{failed:#?}");
    let partial: Vec<u64> = std::fs::read_dir(&shared)
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".rlpart"))
        .map(|e| e.metadata().unwrap().len())
        .collect();
    assert_eq!(partial.len(), 1, "the owner keeps the verified part");
    assert!(partial[0] >= 1024 * 1024, "{partial:?}");

    // Resumed: only the rest is sent, and the result is exact.
    owner.set_share_active(&share.id, true).unwrap();
    let mut s = guest.settings();
    s.upload_limit_kbps = 0;
    guest.update_settings(s).unwrap();
    guest.retry_push(&id).unwrap();
    let done = wait_pushes(&guest).await;
    assert_eq!(done[0].status, "completed", "{done:#?}");
    assert_eq!(hash(&shared.join("big.bin")), hash(&local.join("big.bin")));
    let left: Vec<_> = std::fs::read_dir(&shared).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".rlpart")).collect();
    assert!(left.is_empty());
}

/// Permission belongs to each device's access, set by the invitation it
/// joined with: two devices in the same folder can have different rights.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn each_device_gets_its_invitations_permission() {
    let tmp = tempfile::tempdir().unwrap();
    let shared = tmp.path().join("shared");
    make_file(&shared.join("owners.txt"), 2000, 1);
    let local = tmp.path().join("local");
    make_file(&local.join("drop.txt"), 1500, 2);
    let drop_path = local.join("drop.txt").to_string_lossy().to_string();

    let owner = Core::start(opts(&tmp.path().join("o"), "Owner")).await.unwrap();
    let viewer = Core::start(opts(&tmp.path().join("v"), "Viewer")).await.unwrap();
    let dropper = Core::start(opts(&tmp.path().join("d"), "Dropper")).await.unwrap();
    auto_approve(&owner);
    let share = owner.create_share(shared.to_str().unwrap(), None).unwrap();

    let join = |c: Core, perm: &'static str| {
        let owner = owner.clone();
        let share_id = share.id.clone();
        async move {
            c.add_peer_addr(owner.endpoint_addr());
            let inv = owner.create_invitation_with(&share_id, 3600, Some(1), true, false, Some(perm.into())).await.unwrap();
            assert_eq!(inv.invitation.permission, perm);
            let j = c.join(&inv.invite).await.unwrap();
            assert_eq!(j.shares[0].permission, perm, "the device learns its own permission");
            j.peer_id
        }
    };
    let peer = join(viewer.clone(), "download").await;
    join(dropper.clone(), "upload").await;

    let grants = owner.list_grants().unwrap();
    let of = |id: String| grants.iter().find(|g| g.peer_id == id).unwrap().permission.clone();
    assert_eq!(of(viewer.endpoint_id()), "download");
    assert_eq!(of(dropper.endpoint_id()), "upload");

    // The viewer can download but not upload; the dropper the other way round.
    assert!(viewer.start_upload(&peer, &share.id, vec![], vec![drop_path.clone()]).await.is_err());
    let names_v: Vec<String> = viewer.list_remote_dir(&peer, &share.id, vec![], 0, 100).await.unwrap().entries.into_iter().map(|e| e.name).collect();
    assert_eq!(names_v, vec!["owners.txt".to_string()]);
    dropper.start_upload(&peer, &share.id, vec![], vec![drop_path.clone()]).await.unwrap();
    let done = wait_pushes(&dropper).await;
    assert_eq!(done[0].status, "completed", "{done:#?}");
    let dl = dropper
        .start_download(&peer, &share.id, vec![DownloadItem { path: vec!["owners.txt".into()], is_dir: false }], None)
        .await;
    assert!(dl.is_err(), "upload-only device can't download");
    let names_d: Vec<String> = dropper.list_remote_dir(&peer, &share.id, vec![], 0, 100).await.unwrap().entries.into_iter().map(|e| e.name).collect();
    assert_eq!(names_d, vec!["drop.txt".to_string()], "upload-only sees only its own files");

    // Changing one device leaves the other as it was.
    owner.set_device_permission(&viewer.endpoint_id(), &share.id, "both").unwrap();
    let grants = owner.list_grants().unwrap();
    let of = |id: String| grants.iter().find(|g| g.peer_id == id).unwrap().permission.clone();
    assert_eq!(of(viewer.endpoint_id()), "both");
    assert_eq!(of(dropper.endpoint_id()), "upload");
    assert_eq!(viewer.list_remote_dir(&peer, &share.id, vec![], 0, 100).await.unwrap().permission, "both");
    assert_eq!(dropper.list_remote_dir(&peer, &share.id, vec![], 0, 100).await.unwrap().permission, "upload");
}
