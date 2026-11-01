import { useState } from "react";
import { FolderOpen, KeyRound, Monitor, PlugZap, Trash2, Waypoints, Zap } from "lucide-react";
import { api, errorText, type Remote } from "../api";
import { ago, speed } from "../format";
import { useStore } from "../store";
import { Button, Empty, HudStrip, IconButton, Modal, SafetyWords, SectionHeader, SignalBars, linkOf } from "../ui";

/**
 * One device that shares with you, in the Send page's folder-tile layout:
 * header with its readouts and actions, then its folders and its identity
 * side by side.
 */
function RemoteCard({ r }: { r: Remote }) {
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
  return (
    <section className={`panel share-tile lk-${link}`} aria-label={r.name}>
      <header className="share-top">
        <span className="share-node" aria-hidden="true">
          <Monitor size={18} />
        </span>
        <span className="share-id">
          <span className="share-name truncate">{r.name}</span>
          <span className="share-path truncate">{sub}</span>
        </span>
        <span className="share-stats" aria-label="Device status">
          <span className="share-stat">
            <span className="k">Route</span>
            <span className={`v lk-text`}>{link === "direct" ? "Direct" : link === "relay" ? "Relay" : "Offline"}</span>
          </span>
          <span className="share-stat">
            <span className="k">Latency</span>
            <span className="v num sig-v">
              {link !== "offline" && rtt != null ? `${rtt} ms` : "–"}
              <SignalBars rtt={rtt} link={link} />
            </span>
          </span>
          <span className="share-stat">
            <span className="k">Folders</span>
            <span className="v num">{r.shares.length}</span>
          </span>
          <span className="share-stat">
            <span className="k">Download</span>
            <span className="v num">{bps > 0 ? speed(bps) : active > 0 ? `${active} queued` : "–"}</span>
          </span>
        </span>
        <span className="share-actions">
          {!connected && (
            <Button size="sm" icon={<PlugZap size={14} />} loading={busy} onClick={connect}>Connect</Button>
          )}
          <IconButton label="Forget this device" onClick={() => setConfirm(true)}>
            <Trash2 size={16} />
          </IconButton>
        </span>
      </header>

      <div className="share-body">
        <div className="share-col">
          <div className="share-col-head">
            <span className="lab">Shared with you</span>
            <span className="num faint">{r.shares.length}</span>
          </div>
          {r.shares.length === 0 ? (
            <div className="share-none">No folders are shared with you right now.</div>
          ) : (
            r.shares.map((s) => (
              <div className="fold-row" key={s.id}>
                <span className="fold-node" aria-hidden="true">
                  <FolderOpen size={14} />
                </span>
                <span className="fold-name truncate">{s.name}</span>
                <Button size="sm" icon={<FolderOpen size={14} />} onClick={() => openBrowser({ peerId: r.peerId, shareId: s.id, shareName: s.name, peerName: r.name })}>
                  Browse
                </Button>
              </div>
            ))
          )}
        </div>
        <div className="share-col">
          <div className="share-col-head">
            <span className="lab">Identity</span>
            <span className="num faint mono">{r.peerShort}</span>
          </div>
          {r.safetyWords?.length > 0 ? (
            <div className="ident">
              <SafetyWords words={r.safetyWords} compact />
              <span className="hint">The sender sees the same five words. If they ever differ, forget this device and pair again.</span>
            </div>
          ) : (
            <div className="share-none">No safety words for this device.</div>
          )}
        </div>
      </div>

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
    </section>
  );
}

export default function Devices() {
  const { remotes, jobs, setConnectOpen, settings } = useStore();
  const online = remotes.filter((r) => r.status.state === "connected").length;
  const folders = remotes.reduce((n, r) => n + r.shares.length, 0);
  const list = Object.values(jobs);
  const bps = list.filter((j) => j.status === "downloading").reduce((s, j) => s + j.speedBps, 0);
  const active = list.filter((j) => !["completed", "canceled"].includes(j.status)).length;
  return (
    <div className="page">
      <HudStrip
        label="Receiving summary"
        stats={[
          { label: "Devices online", value: online, of: remotes.length },
          { label: "Folders shared with you", value: folders },
          { label: "Downloads", value: active },
          { label: "Receiving now", value: bps > 0 ? speed(bps) : "–", tone: bps > 0 ? "live" : undefined },
        ]}
        note="Computers that have shared folders with you. Connections are end-to-end encrypted and verified against each device's identity."
        action={<Button variant="primary" icon={<KeyRound size={15} />} onClick={() => setConnectOpen(true)}>Connect with code</Button>}
      />

      <div>
        <SectionHeader title="Devices">
          {remotes.length > 0 && (
            <span className="sec-stat num">
              <i className={online ? "on" : ""} />
              {online} / {remotes.length} online
            </span>
          )}
        </SectionHeader>
        {remotes.length === 0 ? (
          <div className="panel">
            <Empty icon={<Monitor size={20} />} title="No devices yet">
              Ask the sender to share a folder in Bifrost and send you a 16-character code.
            </Empty>
          </div>
        ) : (
          <div className="share-list">
            {remotes.map((r) => <RemoteCard key={r.peerId} r={r} />)}
          </div>
        )}
      </div>

      <div className="two-col">
        <div className="notice">
          <Zap size={16} style={{ color: "var(--ok)" }} />
          <span><b>Direct</b> means data flows straight between the two computers. This is the fastest path and always tried first.</span>
        </div>
        <div className="notice">
          <Waypoints size={16} style={{ color: "var(--warn)" }} />
          <span>
            <b>Relayed</b> means a public relay forwards encrypted packets because routers blocked a direct path.{" "}
            {settings?.connectionMode === "direct_only" ? "Direct-only mode is on, so file data waits for a direct path." : "Bifrost uses it only when no direct path opens within a few seconds, and switches to direct as soon as one does."}
          </span>
        </div>
      </div>
    </div>
  );
}
