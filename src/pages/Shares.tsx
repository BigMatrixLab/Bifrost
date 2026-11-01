import { useCallback, useEffect, useState } from "react";

/** Share created via the folder picker that should open its invite dialog next. */
let pendingInvite: string | null = null;
import { pickFolder } from "../platform";
import { Ban, Check, Copy, FolderOpen, FolderUp, Link2, Pause, Play, Trash2, UserX } from "lucide-react";
import { api, errorText, type Grant, type Invitation, type Share } from "../api";
import { InviteDialog } from "../dialogs";
import { StorageAccessNotice } from "../android";
import { ago, neverExpires, speed, until } from "../format";
import { useStore } from "../store";
import { Button, CodeCells, Empty, IconButton, Modal, Progress, SectionHeader, linkOf } from "../ui";
import { DeviceTile } from "./Overview";

/** Opens the native folder picker and creates a share; returns the new share. */
export function useShareFolder() {
  const { toast, setPage, refreshShares } = useStore();
  return useCallback(async () => {
    try {
      const picked = await pickFolder("Choose a folder to share");
      if (!picked) return;
      const share = await api.createShare(picked);
      refreshShares();
      setPage("shares");
      toast(`Sharing “${share.name}”. Create an invitation to let someone in.`, "ok");
      pendingInvite = share.id;
      window.dispatchEvent(new Event("relayless:invite"));
    } catch (e) {
      toast(errorText(e), "err");
    }
  }, [toast, setPage, refreshShares]);
}

/** One device that can open a share: the same tile as the Overview's device list. */
function AccessRow({ g, onRevoke }: { g: Grant; onRevoke: () => void }) {
  const { uploads } = useStore();
  const up = uploads.find((u) => u.peerId === g.peerId);
  const busy = !!up && up.bps > 0;
  const detail = busy ? `Downloading ${up!.files.join(", ")} · ${speed(up!.bps)}` : g.connected ? "Connected, idle" : `Last seen ${ago(g.lastSeenAt)}`;
  const words = g.safetyWords?.length ? ` · safety words: ${g.safetyWords.join(" ")}` : "";
  return (
    <DeviceTile
      name={g.deviceName}
      dir="out"
      detail={detail}
      busy={busy}
      title={`${g.peerShort}${words}`}
      link={linkOf(g.connected, g.route?.kind)}
      rtt={g.route?.rttMs ?? null}
      action={
        <IconButton label={`Remove access for ${g.deviceName}`} onClick={onRevoke}>
          <UserX size={15} />
        </IconButton>
      }
    />
  );
}

function CopyCode({ code }: { code: string }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      label={done ? "Copied" : "Copy code"}
      onClick={async () => {
        await navigator.clipboard.writeText(code);
        setDone(true);
        window.setTimeout(() => setDone(false), 1600);
      }}
    >
      {done ? <Check size={14} /> : <Copy size={14} />}
    </IconButton>
  );
}

/**
 * An open invitation, two lines: the code with its copy button, uses,
 * approval and revoke on top; the lifetime meter with the time left below
 * (green, then yellow, then red as it runs out).
 */
function InviteRow({ i, onRevoke }: { i: Invitation; onRevoke: () => void }) {
  const never = neverExpires(i.expiresAt);
  const total = Math.max(1, i.expiresAt - i.createdAt);
  const left = never ? 1 : Math.max(0, Math.min(1, (i.expiresAt - Date.now()) / total));
  const tone = never || left > 0.5 ? "ok" : left > 0.2 ? "warn" : "err";
  const uses = i.maxUses != null ? `${i.useCount}/${i.maxUses}` : `${i.useCount}/∞`;
  return (
    <div className={`inv-row tone-${tone}`}>
      <div className="inv-top">
        {i.shortCode ? (
          <span className="inv-code-line">
            <CodeCells code={i.shortCode} small />
            <CopyCode code={i.shortCode} />
          </span>
        ) : (
          <span className="inv-nocode" title="Created before invitation codes; share it again with a new invitation">
            No code
          </span>
        )}
        {/* Tags and revoke wrap together, never apart. */}
        <span className="inv-side">
          <span className="inv-tags">
            <span className="inv-tag" title="Devices that joined / allowed">Uses {uses}</span>
            <span className={`inv-tag ${i.requireApproval ? "warn" : ""}`}>{i.requireApproval ? "Approval" : "Open"}</span>
          </span>
          <IconButton label="Revoke invitation" onClick={onRevoke}>
            <Ban size={15} />
          </IconButton>
        </span>
      </div>
      <div className="inv-bottom">
        <Progress value={left} tone={tone} />
        <span className="inv-left num">{never ? "No expiry" : `${until(i.expiresAt).replace(/^in /, "")} left`}</span>
      </div>
    </div>
  );
}

function ShareCard({ share, onInvite }: { share: Share; onInvite: () => void }) {
  const { grants, uploads, toast } = useStore();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const devices = grants.filter((g) => g.shareId === share.id);
  const invites = share.invitations.filter((i) => i.state === "active");
  const online = devices.filter((g) => g.connected).length;
  const bps = uploads.filter((u) => devices.some((g) => g.peerId === u.peerId)).reduce((s, u) => s + u.bps, 0);
  const state = !share.active ? "paused" : bps > 0 ? "sending" : "ready";
  const act = async (f: () => Promise<void>) => {
    try {
      await f();
    } catch (e) {
      toast(errorText(e), "err");
    }
  };

  return (
    <section className={`panel share-tile st-${state}`} aria-label={share.name}>
      <header className="share-top">
        <span className="share-node" aria-hidden="true">
          <FolderOpen size={18} />
        </span>
        <span className="share-id">
          <span className="share-name truncate">{share.name}</span>
          <span className="share-path mono truncate selectable" title={share.rootPath}>{share.rootPath}</span>
        </span>
        <span className="share-stats" aria-label="Folder status">
          <span className="share-stat">
            <span className="k">Status</span>
            <span className={`v st-${state}`}>{state === "paused" ? "Paused" : state === "sending" ? "Sending" : "Ready"}</span>
          </span>
          <span className="share-stat">
            <span className="k">Devices</span>
            <span className="v num">{online}<span className="faint"> / {devices.length}</span></span>
          </span>
          <span className="share-stat">
            <span className="k">Invites</span>
            <span className="v num">{invites.length}</span>
          </span>
          <span className="share-stat">
            <span className="k">Upload</span>
            <span className="v num">{bps > 0 ? speed(bps) : "–"}</span>
          </span>
        </span>
        <span className="share-actions">
          <Button size="sm" variant="primary" icon={<Link2 size={14} />} onClick={onInvite} disabled={!share.active}>Invite</Button>
          <IconButton label={share.active ? "Pause sharing" : "Resume sharing"} onClick={() => act(() => api.setShareActive(share.id, !share.active))}>
            {share.active ? <Pause size={16} /> : <Play size={16} />}
          </IconButton>
          <IconButton label="Stop sharing and remove" onClick={() => setConfirmDelete(true)}>
            <Trash2 size={16} />
          </IconButton>
        </span>
      </header>

      <div className="share-body">
        <div className="share-col">
          <div className="share-col-head">
            <span className="lab">Access</span>
            <span className="num faint">{devices.length}</span>
          </div>
          {devices.length === 0 ? (
            <div className="share-none">No device can open this folder yet. Send an invitation to let someone in.</div>
          ) : (
            devices.map((g) => <AccessRow key={g.peerId} g={g} onRevoke={() => act(() => api.revokeDevice(g.peerId))} />)
          )}
        </div>
        <div className="share-col">
          <div className="share-col-head">
            <span className="lab">Invitations</span>
            <span className="num faint">{invites.length}</span>
          </div>
          {invites.length === 0 ? (
            <div className="share-none">
              No open invitations.{" "}
              {share.active && (
                <button type="button" className="link" onClick={onInvite}>Create one</button>
              )}
            </div>
          ) : (
            invites.map((i) => <InviteRow key={i.id} i={i} onRevoke={() => act(() => api.revokeInvitation(i.id))} />)
          )}
        </div>
      </div>

      {confirmDelete && (
        <Modal
          title={`Stop sharing “${share.name}”?`}
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Keep sharing</Button>
              <Button variant="danger" onClick={() => { setConfirmDelete(false); act(() => api.deleteShare(share.id)); }}>Stop and remove</Button>
            </>
          }
        >
          <span>All invitations and device access for this folder are removed immediately. Active downloads from it stop. Your files are not touched.</span>
        </Modal>
      )}
    </section>
  );
}

export default function Shares() {
  const { shares, grants, uploads } = useStore();
  const shareFolder = useShareFolder();
  const [inviting, setInviting] = useState<Share | null>(null);

  // A newly created share opens the invite dialog straight away.
  useEffect(() => {
    const check = () => {
      const id = pendingInvite;
      if (!id) return;
      pendingInvite = null;
      api.listShares().then((list) => {
        const s = list.find((x) => x.id === id);
        if (s) setInviting(s);
      });
    };
    check();
    window.addEventListener("relayless:invite", check);
    return () => window.removeEventListener("relayless:invite", check);
  }, []);

  const active = shares.filter((s) => s.active).length;
  const peers = new Set(grants.map((g) => g.peerId));
  const online = new Set(grants.filter((g) => g.connected).map((g) => g.peerId));
  const invites = shares.reduce((n, s) => n + s.invitations.filter((i) => i.state === "active").length, 0);
  const bps = uploads.reduce((s, u) => s + u.bps, 0);

  return (
    <div className="page">
      <StorageAccessNotice />

      <section className="panel send-hud" aria-label="Sharing summary">
        <div className="send-hud-stats">
          <div className="send-stat">
            <span className="lab">Folders shared</span>
            <span className="v num">{active}<span className="faint"> / {shares.length}</span></span>
          </div>
          <div className="send-stat">
            <span className="lab">Devices online</span>
            <span className="v num">{online.size}<span className="faint"> / {peers.size}</span></span>
          </div>
          <div className="send-stat">
            <span className="lab">Open invitations</span>
            <span className="v num">{invites}</span>
          </div>
          <div className={`send-stat ${bps > 0 ? "live" : ""}`}>
            <span className="lab">Sending now</span>
            <span className="v num">{bps > 0 ? speed(bps) : "–"}</span>
          </div>
        </div>
        <div className="send-hud-cta">
          <span className="small muted">
            Invited devices can browse and download from these folders only. They can't see anything else on this computer or change your files.
          </span>
          <Button variant="primary" icon={<FolderUp size={15} />} onClick={shareFolder}>Share a folder</Button>
        </div>
      </section>

      {/* Header and list in one block, like the Overview sections, so the
          title sits right above its cards instead of a page gap away. */}
      <div>
        <SectionHeader title="Shared folders">
          <span className="sec-stat num">
            <i className={active ? "on" : ""} />
            {active} active
          </span>
        </SectionHeader>
        {shares.length === 0 ? (
          <div className="panel">
            <Empty icon={<FolderUp size={20} />} title="You're not sharing anything">
              Choose a specific folder to share. Bifrost never shares a whole drive.
            </Empty>
          </div>
        ) : (
          <div className="share-list">
            {shares.map((s) => <ShareCard key={s.id} share={s} onInvite={() => setInviting(s)} />)}
          </div>
        )}
      </div>
      {inviting && <InviteDialog share={inviting} onClose={() => setInviting(null)} />}
    </div>
  );
}
