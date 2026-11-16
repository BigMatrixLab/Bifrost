import { useState } from "react";
import { FolderOpen, KeyRound, Monitor, RefreshCw, Waypoints, Zap } from "lucide-react";
import { api, canDownload, canUpload, errorText, permissionText, type Job, type Remote, type RemoteShare } from "../api";
import { ago, isActive, speed } from "../format";
import { pickFolder } from "../platform";
import { useStore } from "../store";
import { Button, Empty, Modal, SafetyWords, SignalBars, Toggle, linkOf } from "../ui";
import { PlateMenu, Scroller, StatBoxes, Win, pad } from "../glass";

/** Auto-sync for one shared folder: on/off, its local folder and last check. */
function SyncButton({ peerId, share }: { peerId: string; share: RemoteShare }) {
  const { syncs, settings, toast, refreshSyncs, jobs } = useStore();
  const sync = syncs.find((x) => x.peerId === peerId && x.shareId === share.id);
  // Busy while a check runs (the first one starts as soon as sync is turned
  // on) or while files from this folder download into the sync folder.
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const syncDir = sync ? norm(sync.destDir) + "/" : "";
  // Not while a job waits for the other device: nothing is moving then.
  const moving = (s: Job["status"]) => isActive(s) && s !== "waiting_peer" && s !== "waiting_direct";
  const downloading =
    !!sync &&
    Object.values(jobs).some((j) => j.peerId === peerId && j.shareId === share.id && moving(j.status) && norm(j.destPath).startsWith(syncDir));
  const active = !!sync && (sync.syncing || (!sync.lastSyncAt && !sync.lastError) || downloading);
  const [open, setOpen] = useState(false);
  const [dest, setDest] = useState("");
  // On by default: turning sync on downloads what's there now, then new files.
  const [existing, setExisting] = useState(true);
  const [busy, setBusy] = useState(false);
  const sep = (settings?.downloadDir ?? "").includes("\\") ? "\\" : "/";
  const openDialog = () => {
    setDest(sync?.destDir ?? `${settings?.downloadDir ?? ""}${sep}${share.name.replace(/[<>:"/\\|?*]/g, "_")}`);
    setExisting(true);
    setOpen(true);
  };
  const run = async (f: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await f();
      refreshSyncs();
      toast(ok, "ok");
      setOpen(false);
    } catch (e) {
      toast(errorText(e), "err");
    } finally {
      setBusy(false);
    }
  };
  const title = sync
    ? sync.lastError
      ? `Auto-sync: ${sync.lastError}`
      : `Auto-sync on${sync.lastSyncAt ? `, checked ${ago(sync.lastSyncAt)}` : ""}. Into ${sync.destDir}`
    : "Download new files from this folder automatically";
  return (
    <>
      <Button
        size="sm"
        variant={sync ? "primary" : "secondary"}
        icon={<RefreshCw size={14} className={active ? "spin" : ""} />}
        title={title}
        onClick={openDialog}
      >
        {sync ? (sync.lastError ? "Sync paused" : "Syncing") : "Auto-sync"}
      </Button>
      {open && (
        <Modal
          title={`Auto-sync “${share.name}”`}
          onClose={() => setOpen(false)}
          footer={
            <>
              {sync && (
                <Button variant="danger" disabled={busy} onClick={() => run(() => api.disableSync(peerId, share.id), `Auto-sync off for “${share.name}”`)}>
                  Turn off
                </Button>
              )}
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button
                variant="primary"
                loading={busy}
                icon={<RefreshCw size={15} />}
                onClick={() => run(() => api.enableSync(peerId, share.id, dest || null, existing), sync ? "Sync folder updated" : `Auto-sync on for “${share.name}”`)}
              >
                {sync ? "Save" : "Turn on"}
              </Button>
            </>
          }
        >
          <span>
            Bifrost checks this folder every minute while both devices are online and downloads every new file. Nothing is ever deleted
            here: files the owner removes or renames stay on this device.
          </span>
          <div className="field">
            <span className="label">Save into</span>
            <div className="hstack">
              <input className="input mono" value={dest} onChange={(e) => setDest(e.target.value)} />
              <Button
                onClick={async () => {
                  const p = await pickFolder("Folder to sync into", dest || undefined);
                  if (p) setDest(p);
                }}
              >
                Change…
              </Button>
            </div>
          </div>
          {!sync && (
            <Toggle
              checked={existing}
              onChange={setExisting}
              label="Also download what's already there"
              hint="Off: only files added from now on. On: everything in the folder now, then new files."
            />
          )}
          {sync && (
            <span className="hint">
              {sync.lastError ? `Last check: ${sync.lastError}` : sync.lastSyncAt ? `Last checked ${ago(sync.lastSyncAt)}.` : "First check is running."}
            </span>
          )}
        </Modal>
      )}
    </>
  );
}

/**
 * The selected device's windows: its link and actions, the folders it shares
 * with you (sync and browse), and its identity words.
 */
function RemoteDesk({ r, code }: { r: Remote; code: string }) {
  const { openBrowser, toast, jobs } = useStore();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const connected = r.status.state === "connected";
  const link = linkOf(connected, r.status.route?.kind);
  const rtt = r.status.route?.rttMs ?? null;
  const mine = Object.values(jobs).filter((j) => j.peerId === r.peerId);
  const bps = mine.filter((j) => j.status === "downloading").reduce((s, j) => s + j.speedBps, 0);
  const active = mine.filter((j) => j.status !== "completed" && j.status !== "canceled").length;
  const sub =
    r.status.state === "connecting"
      ? "Connecting…"
      : r.status.state === "unreachable" || r.status.state === "denied"
        ? r.status.message ?? "Not reachable"
        : `Paired ${ago(r.createdAt)} · last seen ${ago(r.lastSeenAt)}`;
  const connect = async () => {
    setBusy(true);
    try {
      await api.connectRemote(r.peerId);
    } catch (e) {
      toast(errorText(e), "err");
    } finally {
      setBusy(false);
    }
  };
  const linkText = link === "direct" ? "Direct" : link === "relay" ? "Relay" : "Offline";
  return (
    <>
      <Win
        code={code}
        title={r.name}
        area="1 / 5 / 6 / 13"
        className={`share-tile lk-${link}`}
        tone={link === "direct" ? "ok" : link === "relay" ? "warn" : "err"}
        aria-label={r.name}
        sub={sub}
        subKeys={<span className={`gx-chip ${link === "direct" ? "on" : link === "relay" ? "warn" : "err"}`}>{linkText}</span>}
        meta={link !== "offline" && rtt != null ? `${rtt} ms` : linkText}
        metaTone={link === "offline" ? "red" : "mint"}
        foot={`ID ${r.peerShort}`}
        scroll={false}
      >
        <div className="gd-grid">
          <div className="gd-main">
            <StatBoxes
              label="Device status"
              items={[
                { label: "Route", value: linkText, tone: link === "direct" ? "live" : link === "relay" ? "warn" : "err" },
                {
                  label: "Latency",
                  value: (
                    <span className="gd-sig">
                      {link !== "offline" && rtt != null ? `${rtt} ms` : "–"}
                      <SignalBars rtt={rtt} link={link} />
                    </span>
                  ),
                },
                { label: "Folders", value: r.shares.length },
                { label: "Download", value: bps > 0 ? speed(bps) : active > 0 ? `${active} queued` : "–", tone: bps > 0 ? "live" : undefined },
              ]}
            />
            <p className="gr-para">
              Connections are end-to-end encrypted and verified against this device's identity. Downloads resume from their verified progress after
              any interruption.
            </p>
          </div>
          <PlateMenu
            label="Device actions"
            value={null}
            onChange={(id) => (id === "connect" ? connect() : setConfirm(true))}
            items={[
              ...(!connected ? [{ id: "connect", label: busy ? "Connecting…" : "Connect", disabled: busy, tone: "ok" as const }] : []),
              { id: "forget", label: "Forget device", tone: "err" as const },
            ]}
          />
        </div>
      </Win>

      <Win
        code="F2"
        title="Shared with you"
        area="6 / 5 / 13 / 10"
        aria-label="Shared with you"
        sub="Folders this device shares with you"
        meta={pad(r.shares.length)}
        metaTone="mint"
        foot="Browse to download · auto-sync keeps a local copy"
        scroll={false}
      >
        <Scroller label="Shared folders">
          {r.shares.length === 0 ? (
            <div className="share-none">No folders are shared with you right now.</div>
          ) : (
            r.shares.map((s) => (
              <div className="fold-row has-tag" key={s.id}>
                <span className="fold-node" aria-hidden="true">
                  <FolderOpen size={13} />
                </span>
                <span className="fold-name truncate">{s.name}</span>
                <span className={`perm-tag ${canUpload(s.permission) ? "up" : ""}`} title="What the owner lets you do in this folder">
                  {permissionText(s.permission)}
                </span>
                <span className="hstack" style={{ gap: 4 }}>
                  {canDownload(s.permission) && <SyncButton peerId={r.peerId} share={s} />}
                  <Button size="sm" icon={<FolderOpen size={11} />} onClick={() => openBrowser({ peerId: r.peerId, shareId: s.id, shareName: s.name, peerName: r.name })}>
                    {s.permission === "upload" ? "Open" : "Browse"}
                  </Button>
                </span>
              </div>
            ))
          )}
        </Scroller>
      </Win>

      <Win code="ID" title="Identity" area="6 / 10 / 10 / 13" aria-label="Identity" sub={`Key / ${r.peerShort}`} foot="Safety words">
        {r.safetyWords?.length > 0 ? (
          <div className="ident">
            <SafetyWords words={r.safetyWords} compact />
            <span className="hint">The sender sees the same five words. If they ever differ, forget this device and pair again.</span>
          </div>
        ) : (
          <div className="share-none">No safety words for this device.</div>
        )}
      </Win>

      {confirm && (
        <Modal
          title={`Forget ${r.name}?`}
          onClose={() => setConfirm(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirm(false)}>Keep</Button>
              <Button variant="danger" onClick={() => { setConfirm(false); api.removeRemote(r.peerId).catch((e) => toast(errorText(e), "err")); }}>Forget device</Button>
            </>
          }
        >
          <span>You'll need a new invitation to connect again. Unfinished downloads from this device stay in your transfer list.</span>
        </Modal>
      )}
    </>
  );
}

export default function Devices() {
  const { remotes, jobs, setConnectOpen, settings } = useStore();
  const [picked, setPicked] = useState<string | null>(null);
  const online = remotes.filter((r) => r.status.state === "connected").length;
  const folders = remotes.reduce((n, r) => n + r.shares.length, 0);
  const list = Object.values(jobs);
  const bps = list.filter((j) => j.status === "downloading").reduce((s, j) => s + j.speedBps, 0);
  const active = list.filter((j) => !["completed", "canceled"].includes(j.status)).length;
  const selIndex = Math.max(0, remotes.findIndex((r) => r.peerId === picked));
  const sel = remotes[selIndex] ?? null;
  const connectKey = (
    <Button size="sm" variant="primary" icon={<KeyRound size={11} />} onClick={() => setConnectOpen(true)}>
      Connect with code
    </Button>
  );

  return (
    <div className="desk desk-devices">
      <Win
        code="D0"
        title="Sources"
        area="1 / 1 / 9 / 5"
        aria-label="Devices"
        side="Inbound sources"
        sub={`Online / ${online} of ${remotes.length}`}
        meta={`${pad(selIndex + (sel ? 1 : 0))}-${pad(remotes.length)}`}
        metaTone="mint"
        foot="Select a device"
        keys={connectKey}
        scroll={false}
      >
        {remotes.length === 0 ? (
          <Empty icon={<Monitor size={18} />} title="No devices">Ask the sender to share a folder in Bifrost and send you a 16-character code.</Empty>
        ) : (
          <div className="gt" role="table" aria-label="Devices">
            <div className="gt-head gt-dev" role="row">
              <span role="columnheader">No</span>
              <span role="columnheader">Station</span>
              <span role="columnheader">Status</span>
              <span role="columnheader">Rtt</span>
            </div>
            <Scroller label="Devices">
              {remotes.map((r, i) => {
                const lk = linkOf(r.status.state === "connected", r.status.route?.kind);
                const ms = r.status.route?.rttMs ?? null;
                return (
                  <button
                    key={r.peerId}
                    type="button"
                    role="row"
                    aria-selected={sel?.peerId === r.peerId}
                    className={`gt-row gt-dev link-${lk} ${sel?.peerId === r.peerId ? "on" : ""}`}
                    onClick={() => setPicked(r.peerId)}
                  >
                    <span className="num gt-no">{pad(i + 1)}</span>
                    <span className="gt-name">
                      <b className="truncate">{r.name}</b>
                      <small>{r.shares.length} folder{r.shares.length === 1 ? "" : "s"}</small>
                    </span>
                    <span className={`gt-st st-${lk === "direct" ? "ok" : lk === "relay" ? "warn" : "err"}`}>
                      {lk === "direct" ? "Online" : lk === "relay" ? "Relay" : "Offline"}
                    </span>
                    <span className="num gt-rtt">
                      {lk !== "offline" && ms != null ? ms : "–"}
                      <SignalBars rtt={ms} link={lk} />
                    </span>
                  </button>
                );
              })}
            </Scroller>
          </div>
        )}
      </Win>

      <Win code="H3" title="Statistics" area="9 / 1 / 13 / 5" aria-label="Receiving summary" foot="All sources" scroll={false}>
        <StatBoxes
          label="Receiving summary"
          items={[
            { label: "Online", value: online, of: remotes.length },
            { label: "Folders", value: folders },
            { label: "Downloads", value: active },
            { label: "Receiving", value: bps > 0 ? speed(bps) : "–", tone: bps > 0 ? "live" : undefined },
          ]}
        />
      </Win>

      {sel ? (
        <RemoteDesk key={sel.peerId} r={sel} code={`D${selIndex + 1}`} />
      ) : (
        <Win code="D1" title="Device" area="1 / 5 / 8 / 11" aria-label="Device" foot="Nothing selected" keys={connectKey}>
          <Empty icon={<Monitor size={18} />} title="No device">Connect with a code to add a device that shares with you.</Empty>
        </Win>
      )}

      <Win code="RT" title="Routes" area="10 / 10 / 13 / 13" aria-label="Routes" foot={settings?.connectionMode === "direct_only" ? "Direct only" : "Direct first"}>
        <p className="gr-para">
          <b className="st-ok"><Zap size={10} /> Direct</b>: data flows straight between the two computers, the fastest path, always tried first.{" "}
          <b className="st-warn"><Waypoints size={10} /> Relayed</b>: a public relay forwards encrypted packets because routers blocked a direct path.{" "}
          {settings?.connectionMode === "direct_only"
            ? "Direct-only mode is on, so file data waits for a direct path."
            : "Used only when no direct path opens within a few seconds; switches to direct as soon as one does."}
        </p>
      </Win>
    </div>
  );
}
