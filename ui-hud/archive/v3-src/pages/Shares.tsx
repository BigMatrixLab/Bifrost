import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Share created via the folder picker that should open its invite dialog next. */
let pendingInvite: string | null = null;
import { pickFolder } from "../platform";
import { ArrowDownUp, Ban, Check, ChevronDown, Copy, Download, FolderUp, Link2, Upload, UserX } from "lucide-react";
import {
  PERMISSION_OPTIONS,
  api,
  canUpload,
  errorText,
  permissionText,
  type Grant,
  type Invitation,
  type Share,
  type SharePermission,
} from "../api";
import { InviteDialog } from "../dialogs";
import { StorageAccessNotice } from "../android";
import { ago, neverExpires, speed, until } from "../format";
import { useStore } from "../store";
import { Button, CodeCells, Empty, IconButton, Modal, Progress, linkOf } from "../ui";
import { PlateMenu, Scroller, StatBoxes, Win, pad } from "../glass";
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
      window.dispatchEvent(new Event("bifrost:invite"));
    } catch (e) {
      toast(errorText(e), "err");
    }
  }, [toast, setPage, refreshShares]);
}

const PERM_ICON: Record<SharePermission, React.ReactNode> = {
  download: <Download size={13} />,
  upload: <Upload size={13} />,
  both: <ArrowDownUp size={13} />,
};
const PERM_MENU: { value: SharePermission; label: string; sub: string }[] = [
  { value: "download", label: "Download only", sub: "Browse and download. Can't add or delete." },
  { value: "upload", label: "Upload only", sub: "Add files; sees and deletes only its own." },
  { value: "both", label: "Download and upload", sub: "Everything, but deletes only its own." },
];

/**
 * What one device may do in one folder: a labelled picker in its own column
 * of the device row, opening a menu right under it. Changing it affects only
 * this device, from its next request.
 */
function DevicePermission({ g }: { g: Grant }) {
  const { toast, refreshGrants } = useStore();
  const [menu, setMenu] = useState<{ left: number; top: number; up: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const perm = (g.permission ?? "download") as SharePermission;

  const close = useCallback(() => setMenu(null), []);
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest(".perm-menu") && !btn.current?.contains(t)) close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu, close]);

  const toggle = () => {
    if (menu) return close();
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const width = 260;
    const up = r.bottom + 190 > window.innerHeight;
    setMenu({ left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)), top: up ? r.top - 6 : r.bottom + 6, up });
  };

  const change = async (v: SharePermission) => {
    close();
    if (v === perm) return;
    setBusy(true);
    try {
      await api.setDevicePermission(g.peerId, g.shareId, v);
      refreshGrants();
      toast(`${g.deviceName} can now ${v === "both" ? "download and upload" : v === "upload" ? "only upload" : "only download"} in “${g.shareName}”`, "ok");
    } catch (e) {
      toast(errorText(e), "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <span className="perm-field">
        <button
          ref={btn}
          type="button"
          className={`perm-pick p-${perm} ${menu ? "open" : ""}`}
          aria-haspopup="menu"
          aria-expanded={!!menu}
          aria-label={`${g.deviceName}'s access: ${permissionText(perm)}. Change`}
          disabled={busy}
          onClick={toggle}
        >
          <span className="pp-ico">{PERM_ICON[perm]}</span>
          <span className="pp-text">{PERMISSION_OPTIONS.find((o) => o.value === perm)?.label}</span>
          <ChevronDown size={13} className="pp-chev" />
        </button>
      </span>
      {menu &&
        createPortal(
          <div
            className={`perm-menu ${menu.up ? "up" : ""}`}
            role="menu"
            style={{ left: menu.left, top: menu.top }}
            aria-label={`What ${g.deviceName} can do in ${g.shareName}`}
          >
            <span className="perm-menu-head">{g.deviceName} can</span>
            {PERM_MENU.map((o) => (
              <button
                key={o.value}
                type="button"
                role="menuitemradio"
                aria-checked={o.value === perm}
                className={`perm-opt p-${o.value} ${o.value === perm ? "on" : ""}`}
                onClick={() => change(o.value)}
                autoFocus={o.value === perm}
              >
                <span className="pp-ico">{PERM_ICON[o.value]}</span>
                <span className="stack" style={{ gap: 1, minWidth: 0 }}>
                  <span className="po-label">{o.label}</span>
                  <span className="po-sub">{o.sub}</span>
                </span>
                {o.value === perm && <Check size={14} className="po-check" />}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
/** One device that can open a share: the same tile as the Overview's device list. */
function AccessRow({ g, onRevoke }: { g: Grant; onRevoke: () => void }) {
  const { uploads, incoming } = useStore();
  const up = uploads.find((u) => u.peerId === g.peerId);
  const adding = incoming.filter((f) => f.peerId === g.peerId && f.shareId === g.shareId && f.status === "receiving");
  const addBps = adding.reduce((s, f) => s + f.bps, 0);
  const busy = (!!up && up.bps > 0) || adding.length > 0;
  const parts: string[] = [];
  if (up && up.bps > 0) parts.push(`Downloading ${up.files.join(", ")} · ${speed(up.bps)}`);
  if (adding.length > 0) parts.push(`Uploading ${adding.map((f) => f.name).join(", ")}${addBps > 1 ? ` · ${speed(addBps)}` : ""}`);
  const detail = parts.length ? parts.join(" · ") : g.connected ? "Connected, idle" : `Last seen ${ago(g.lastSeenAt)}`;
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
      access={<DevicePermission g={g} />}
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
            <span className={`inv-tag ${canUpload(i.permission) ? "up" : ""}`} title={`Devices that join with it: ${permissionText(i.permission).toLowerCase()}`}>
              {PERMISSION_OPTIONS.find((o) => o.value === (i.permission ?? "download"))?.label}
            </span>
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

/** The selected share's windows: details with actions, who has access, open invitations. */
function ShareDesk({ share, code, onInvite }: { share: Share; code: string; onInvite: () => void }) {
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
    <>
      <Win
        code={code}
        title={share.name}
        area="1 / 5 / 6 / 13"
        className={`share-tile st-${state}`}
        tone={state === "paused" ? "warn" : state === "sending" ? "ok" : undefined}
        aria-label={share.name}
        sub={<span className="selectable" title={share.rootPath}>Root / {share.rootPath}</span>}
        subKeys={<span className={`gx-chip ${state === "paused" ? "warn" : "on"}`}>{state === "paused" ? "Paused" : state === "sending" ? "Sending" : "Ready"}</span>}
        meta={`${pad(online)}-${pad(devices.length)}`}
        metaTone={state === "paused" ? "red" : "mint"}
        foot={`${online} of ${devices.length} devices online · ${invites.length} open invitation${invites.length === 1 ? "" : "s"}`}
        scroll={false}
      >
        <div className="gd-grid">
          <div className="gd-main">
            <StatBoxes
              label="Folder status"
              items={[
                { label: "Status", value: state === "paused" ? "Paused" : state === "sending" ? "Sending" : "Ready", tone: state === "paused" ? "warn" : state === "sending" ? "live" : undefined },
                { label: "Devices", value: online, of: devices.length, level: devices.length ? online / devices.length : 0 },
                { label: "Invites", value: invites.length },
                { label: "Upload", value: bps > 0 ? speed(bps) : "–", tone: bps > 0 ? "live" : undefined },
              ]}
            />
            <p className="gr-para">
              Invited devices reach this folder only, never anything else on this computer. Each invitation says whether its device can download,
              upload or both, and you can change it per device. They can only delete what they uploaded.
            </p>
          </div>
          <PlateMenu
            label="Folder actions"
            value={null}
            onChange={(id) =>
              id === "invite" ? onInvite() : id === "pause" ? act(() => api.setShareActive(share.id, !share.active)) : setConfirmDelete(true)
            }
            items={[
              { id: "invite", label: "Invite", disabled: !share.active, title: share.active ? "Create an invitation" : "Resume sharing to invite" },
              { id: "pause", label: share.active ? "Pause sharing" : "Resume sharing", tone: share.active ? undefined : "warn" },
              { id: "remove", label: "Stop sharing", tone: "err", title: "Stop sharing and remove" },
            ]}
          />
        </div>
      </Win>

      <Win
        code="A2"
        title="Access"
        area="6 / 5 / 13 / 9"
        aria-label="Access"
        sub="Devices that can open this folder"
        meta={`${pad(online)}-${pad(devices.length)}`}
        metaTone="mint"
        foot="Change permission per device"
        scroll={false}
      >
        <Scroller label="Access">
          {devices.length === 0 ? (
            <div className="share-none">No device can open this folder yet. Send an invitation to let someone in.</div>
          ) : (
            devices.map((g) => <AccessRow key={g.peerId} g={g} onRevoke={() => act(() => api.revokeDevice(g.peerId))} />)
          )}
        </Scroller>
      </Win>

      <Win
        code="I3"
        title="Invitations"
        area="6 / 9 / 13 / 13"
        aria-label="Invitations"
        sub="Open codes and their lifetime"
        meta={pad(invites.length)}
        metaTone="mint"
        foot={share.active ? "Codes work until they expire or are used up" : "Sharing paused"}
        keys={share.active ? <Button size="sm" variant="primary" icon={<Link2 size={11} />} onClick={onInvite}>New</Button> : undefined}
        scroll={false}
      >
        <Scroller label="Invitations">
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
        </Scroller>
      </Win>

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
          <span>All invitations and device access for this folder are removed immediately. Active downloads and uploads stop. Your files, and files others uploaded, stay in the folder.</span>
        </Modal>
      )}
    </>
  );
}

export default function Shares() {
  const { shares, grants, uploads } = useStore();
  const shareFolder = useShareFolder();
  const [inviting, setInviting] = useState<Share | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  // A newly created share opens the invite dialog straight away.
  useEffect(() => {
    const check = () => {
      const id = pendingInvite;
      if (!id) return;
      pendingInvite = null;
      api.listShares().then((list) => {
        const s = list.find((x) => x.id === id);
        if (s) {
          setPicked(s.id);
          setInviting(s);
        }
      });
    };
    check();
    window.addEventListener("bifrost:invite", check);
    return () => window.removeEventListener("bifrost:invite", check);
  }, []);

  const active = shares.filter((s) => s.active).length;
  const peers = new Set(grants.map((g) => g.peerId));
  const online = new Set(grants.filter((g) => g.connected).map((g) => g.peerId));
  const invites = shares.reduce((n, s) => n + s.invitations.filter((i) => i.state === "active").length, 0);
  const bps = uploads.reduce((s, u) => s + u.bps, 0);
  const selIndex = Math.max(0, shares.findIndex((s) => s.id === picked));
  const sel = shares[selIndex] ?? null;

  return (
    <div className="desk desk-shares">
      <StorageAccessNotice />

      <Win
        code="F0"
        title="Folders"
        area="1 / 1 / 9 / 5"
        aria-label="Shared folders"
        side="Outbound shares"
        sub={`Shared / ${active} of ${shares.length} active`}
        meta={`${pad(selIndex + (sel ? 1 : 0))}-${pad(shares.length)}`}
        metaTone="mint"
        foot="Select a folder"
        keys={<Button size="sm" variant="primary" icon={<FolderUp size={11} />} onClick={shareFolder}>Share a folder</Button>}
        scroll={false}
      >
        {shares.length === 0 ? (
          <Empty icon={<FolderUp size={18} />} title="Nothing shared">Choose a specific folder to share. Bifrost never shares a whole drive.</Empty>
        ) : (
          <div className="gt" role="table" aria-label="Shared folders">
            <div className="gt-head gt-fold" role="row">
              <span role="columnheader">No</span>
              <span role="columnheader">Folder</span>
              <span role="columnheader">Status</span>
              <span role="columnheader">Dev</span>
            </div>
            <Scroller label="Shared folders">
              {shares.map((s, i) => {
                const devs = grants.filter((g) => g.shareId === s.id);
                const up = uploads.some((u) => devs.some((g) => g.peerId === u.peerId) && u.bps > 0);
                const st = !s.active ? "paused" : up ? "sending" : "ready";
                return (
                  <button
                    key={s.id}
                    type="button"
                    className={`gt-row gt-fold ${sel?.id === s.id ? "on" : ""}`}
                    role="row"
                    aria-selected={sel?.id === s.id}
                    onClick={() => setPicked(s.id)}
                    title={s.rootPath}
                  >
                    <span className="num gt-no">{pad(i + 1)}</span>
                    <span className="gt-name">
                      <b className="truncate">{s.name}</b>
                      <small className="truncate">{s.rootPath}</small>
                    </span>
                    <span className={`gt-st ${st === "paused" ? "st-warn" : "st-ok"}`}>{st}</span>
                    <span className="num gt-rtt">{devs.filter((g) => g.connected).length}/{devs.length}</span>
                  </button>
                );
              })}
            </Scroller>
          </div>
        )}
      </Win>

      <Win code="H2" title="Statistics" area="9 / 1 / 13 / 5" aria-label="Sharing summary" foot="All folders" scroll={false}>
        <StatBoxes
          label="Sharing summary"
          items={[
            { label: "Folders", value: active, of: shares.length },
            { label: "Online", value: online.size, of: peers.size },
            { label: "Invites", value: invites },
            { label: "Sending", value: bps > 0 ? speed(bps) : "–", tone: bps > 0 ? "live" : undefined },
          ]}
        />
      </Win>

      {sel ? (
        <ShareDesk key={sel.id} share={sel} code={`F${selIndex + 1}`} onInvite={() => setInviting(sel)} />
      ) : (
        <Win code="F1" title="Folder" area="1 / 5 / 8 / 11" aria-label="Folder" foot="Nothing selected">
          <Empty icon={<FolderUp size={18} />} title="No folder">Share a folder to invite devices to it.</Empty>
        </Win>
      )}
      {inviting && <InviteDialog share={inviting} onClose={() => setInviting(null)} />}
    </div>
  );
}
