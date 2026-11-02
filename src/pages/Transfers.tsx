import { useMemo, useState } from "react";
import {
  ChevronDown,
  CirclePause,
  Download,
  ExternalLink,
  FolderOpen,
  Pause,
  Play,
  RotateCcw,
  Trash2,
  Upload as UploadIcon,
  Waypoints,
  ShieldCheck,
  Clock,
  X,
  XCircle,
} from "lucide-react";
import { android, api, errorText, type Incoming, type Job, type Outgoing, type Push } from "../api";
import { isAndroid } from "../platform";
import { bytes, dateTime, duration, isActive, mbit, speed, statusTone } from "../format";
import { useStore } from "../store";
import { LiveFlow, useFlowActive } from "../flow";
import { Button, Empty, HudStrip, IconButton, Modal, Progress, RouteBadge, SectionHeader, StatusIcon, StatusPill } from "../ui";
import { useSlide } from "../slide";

function explain(job: Job): string | null {
  switch (job.status) {
    case "waiting_peer":
      return "The sender's computer isn't reachable right now. Bifrost keeps trying automatically and continues from the verified progress when it's back.";
    case "reconnecting":
      return "The connection dropped. Every verified piece is saved on disk, so only the missing pieces will be fetched again.";
    case "waiting_direct":
      return "The routers between you block a direct path and direct-only mode is on, so no file data is sent. Bifrost keeps trying. To continue now, choose Direct first in Settings on both devices; data then goes through an end-to-end encrypted relay.";
    case "downloading":
      return job.route === "relay"
        ? "The routers between the two devices didn't allow a direct path, so this goes through an encrypted relay. The free public relays are rate-limited; for full speed, set your own relay server in Settings on both devices, or enable UPnP on your router."
        : null;
    case "paused":
      return job.verifiedBytes > 0 ? "Resume continues from the verified progress below; nothing already downloaded is fetched again." : null;
    case "needs_attention":
      return job.error;
    default:
      return null;
  }
}

export function JobRow({ job, compact = false }: { job: Job; compact?: boolean }) {
  const { integrity, activity, toast } = useStore();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const tone = statusTone(job.status);
  const frac = job.size > 0 ? job.doneBytes / job.size : job.status === "completed" ? 1 : 0;
  const integ = integrity[job.id];
  const sourceChanged = job.status === "needs_attention" && (job.error ?? "").toLowerCase().includes("changed");

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    try {
      await f();
    } catch (e) {
      toast(errorText(e), "err");
    } finally {
      setBusy(false);
    }
  };

  const canPause = isActive(job.status);
  const canResume = ["paused", "failed", "canceled", "needs_attention"].includes(job.status) && !sourceChanged;
  const timeline = open ? activity.filter((a) => a.jobId === job.id).slice(0, 12) : [];

  return (
    <div className={`job tone-${tone} ${job.status === "needs_attention" || job.status === "failed" ? "attn" : ""}`}>
      <div className={`job-ico tone-${tone}`}>
        <StatusIcon status={job.status} size={17} />
      </div>
      <div className="stack">
        <div className="hstack">
          <span className="job-title truncate selectable" title={job.remotePath.join(" / ")}>{job.displayName}</span>
        </div>
        <div className="job-meta">
          <StatusPill status={job.status} />
          <span className="num">
            {job.status === "completed" ? bytes(job.size) : `${bytes(job.doneBytes)} of ${bytes(job.size)}`}
          </span>
          {job.status !== "completed" && job.size > 0 && <span className="num job-pct">{pct(job.doneBytes, job.size)}</span>}
          {job.status === "downloading" && <span className="num">{speed(job.speedBps)}</span>}
          {job.status === "downloading" && job.etaSecs != null && <span className="num">{duration(job.etaSecs)} left</span>}
          {job.status === "downloading" && job.route === "relay" && <RelayedPill />}
          {job.status === "verifying" && integ && <span className="num">checked {Math.round((integ.checked / Math.max(1, integ.total)) * 100)}%</span>}
          <span className="faint truncate">from {job.peerName}</span>
        </div>
      </div>
      <div className="job-actions">
        {canPause && (
          <IconButton label="Pause" disabled={busy} onClick={() => run(() => api.pauseJob(job.id))}>
            <Pause size={16} />
          </IconButton>
        )}
        {canResume && (
          <IconButton label={job.status === "paused" ? "Resume" : "Retry"} disabled={busy} onClick={() => run(() => api.resumeJob(job.id))}>
            {job.status === "paused" ? <Play size={16} /> : <RotateCcw size={16} />}
          </IconButton>
        )}
        {job.status === "completed" && (
          <IconButton
            label={isAndroid() ? "Open" : "Show in folder"}
            onClick={() => run(() => (isAndroid() ? android.openFile(job.destPath) : api.revealPath(job.destPath)))}
          >
            {isAndroid() ? <ExternalLink size={16} /> : <FolderOpen size={16} />}
          </IconButton>
        )}
        {job.status !== "completed" && job.status !== "canceled" && (
          <IconButton label="Cancel" disabled={busy} onClick={() => setConfirm(true)}>
            <X size={16} />
          </IconButton>
        )}
        {["completed", "canceled", "failed"].includes(job.status) && (
          <IconButton label="Remove from list" disabled={busy} onClick={() => run(() => api.removeJob(job.id))}>
            <Trash2 size={15} />
          </IconButton>
        )}
        {!compact && (
          <IconButton
            label={open ? "Hide details" : "Show details"}
            aria-expanded={open}
            className={`job-chev ${open ? "open" : ""}`}
            onClick={() => setOpen(!open)}
          >
            <ChevronDown size={16} />
          </IconButton>
        )}
      </div>
      {job.status !== "completed" && job.status !== "canceled" && (
        <div className="job-progress">
          <Progress
            value={job.status === "verifying" && integ ? integ.checked / Math.max(1, integ.total) : frac}
            tone={tone}
            indeterminate={job.status === "connecting" || (job.status === "verifying" && !integ)}
          />
        </div>
      )}
      {sourceChanged && (
        <div className="job-details">
          <span className="small">
            The file was modified on the sender's computer after this download started. To avoid mixing two versions, Bifrost stopped. You can start over with the new version.
          </span>
          <div className="hstack">
            <Button size="sm" variant="primary" loading={busy} icon={<Download size={14} />} onClick={() => run(() => api.restartJob(job.id))}>
              Download new version
            </Button>
          </div>
        </div>
      )}
      {open && (
        <div className="job-details">
          {explain(job) && !sourceChanged && <span className="small">{explain(job)}</span>}
          <dl className="kv">
            <dt>Saved to</dt>
            <dd className="selectable">{job.destPath}</dd>
            <dt>On sender</dt>
            <dd className="selectable">{job.remotePath.join(" / ")}</dd>
            <dt>Verified</dt>
            <dd className="num">
              {bytes(job.verifiedBytes)} ({job.status === "completed" ? job.totalChunks : job.verifiedChunks} of {job.totalChunks} pieces)
            </dd>
            {job.status === "downloading" && (
              <>
                <dt>Network speed</dt>
                <dd className="num">{speed(job.speedBps)} · {mbit(job.speedBps)}</dd>
              </>
            )}
            <dt>Connection</dt>
            <dd>
              <RouteBadge route={{ kind: job.route, rttMs: null, remote: null }} connected={job.route !== "none"} />
            </dd>
            <dt>Started</dt>
            <dd>{dateTime(job.createdAt)}</dd>
            {job.completedAt && (
              <>
                <dt>Completed</dt>
                <dd>{dateTime(job.completedAt)}</dd>
              </>
            )}
          </dl>
          {timeline.length > 0 && (
            <div className="timeline">
              {timeline.map((a) => (
                <div key={a.id} className="hstack">
                  <span className="t">{dateTime(a.ts)}</span>
                  <span>{a.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {confirm && (
        <Modal
          title="Cancel this transfer?"
          width={760}
          fit
          onClose={() => setConfirm(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirm(false)}>Keep downloading</Button>
              <Button variant="secondary" onClick={() => { setConfirm(false); run(() => api.cancelJob(job.id, false)); }}>
                Cancel, keep partial data
              </Button>
              <Button variant="danger" onClick={() => { setConfirm(false); run(() => api.cancelJob(job.id, true)); }}>
                Cancel and delete
              </Button>
            </>
          }
        >
          <span>
            <b>{job.displayName}</b> has {bytes(job.verifiedBytes)} of {bytes(job.size)} verified.
            {job.verifiedBytes > 0 && " Keeping the partial data lets you retry later without starting over."}
          </span>
        </Modal>
      )}
    </div>
  );
}

function RelayedPill() {
  return (
    <span
      className="pill pill-warn"
      title="Going through an encrypted relay because the routers blocked a direct path. Public relays are rate-limited; set your own relay in Settings for full speed."
    >
      <Waypoints size={12} /> Relayed
    </span>
  );
}

function pct(done: number, size: number) {
  if (size <= 0) return "100%";
  const p = (done / size) * 100;
  return p > 0 && p < 1 ? "<1%" : `${Math.floor(p)}%`;
}

const SEND_TEXT: Record<Outgoing["status"], string> = {
  sending: "Sending",
  waiting: "Waiting for receiver",
  paused: "Paused",
  canceled: "Stopped",
  delivered: "Sent, receiver is checking",
  verified: "Delivered and verified",
};

function SendIcon({ status, size }: { status: Outgoing["status"]; size: number }) {
  switch (status) {
    case "verified":
      return <ShieldCheck size={size} />;
    case "waiting":
      return <Clock size={size} />;
    case "paused":
      return <CirclePause size={size} />;
    case "canceled":
      return <XCircle size={size} />;
    default:
      return <UploadIcon size={size} />;
  }
}

/** A file this device is sending, shown like a download. */
export function SendRow({ o, compact = false }: { o: Outgoing; compact?: boolean }) {
  const { toast } = useStore();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const done = o.status === "verified" || o.status === "delivered";
  const canceled = o.status === "canceled";
  // Traffic light, as for downloads: waiting and paused yellow, sending and
  // delivered green, stopped grey.
  const tone = canceled ? "muted" : o.status === "waiting" || o.status === "paused" ? "warn" : "ok";
  const left = o.bps > 1 && !done ? (o.size - o.sentBytes) / o.bps : null;

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    try {
      await f();
    } catch (e) {
      toast(errorText(e), "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`job tone-${tone}`}>
      <div className={`job-ico tone-${tone}`}>
        <SendIcon status={o.status} size={17} />
      </div>
      <div className="stack">
        <div className="hstack">
          <span className="job-title truncate selectable" title={o.path.join(" / ")}>{o.name}</span>
        </div>
        <div className="job-meta">
          <span className={`pill pill-${tone}`}>
            <SendIcon status={o.status} size={13} />
            {o.status === "waiting" ? `Waiting for ${o.deviceName}` : SEND_TEXT[o.status]}
          </span>
          <span className="num">{done ? bytes(o.size) : `${bytes(o.sentBytes)} of ${bytes(o.size)}`}</span>
          {!done && <span className="num job-pct">{pct(o.sentBytes, o.size)}</span>}
          {o.status === "sending" && o.bps > 1 && <span className="num">{speed(o.bps)}</span>}
          {o.status === "sending" && o.route === "relay" && <RelayedPill />}
          {!compact && left != null && <span className="num">{duration(left)} left</span>}
          <span className="faint truncate">to {o.deviceName}</span>
        </div>
      </div>
      <div className="job-actions">
        {(o.status === "sending" || o.status === "waiting") && (
          <IconButton label="Pause" disabled={busy} onClick={() => run(() => api.pauseOutgoing(o.id))}>
            <Pause size={16} />
          </IconButton>
        )}
        {o.status === "paused" && (
          <IconButton label="Resume" disabled={busy} onClick={() => run(() => api.resumeOutgoing(o.id))}>
            <Play size={16} />
          </IconButton>
        )}
        {!done && !canceled && (
          <IconButton label="Cancel" disabled={busy} onClick={() => setConfirm(true)}>
            <X size={16} />
          </IconButton>
        )}
        {(done || canceled) && (
          <IconButton label="Remove from list" disabled={busy} onClick={() => run(() => api.removeOutgoing(o.id))}>
            <Trash2 size={15} />
          </IconButton>
        )}
      </div>
      {!done && !canceled && (
        <div className="job-progress">
          <Progress value={o.size ? o.sentBytes / o.size : 0} tone={tone} />
        </div>
      )}
      {confirm && (
        <Modal
          title="Stop sending this file?"
          width={760}
          fit
          onClose={() => setConfirm(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirm(false)}>Keep sending</Button>
              <Button variant="danger" onClick={() => { setConfirm(false); run(() => api.cancelOutgoing(o.id)); }}>
                Stop sending
              </Button>
            </>
          }
        >
          <span>
            <b>{o.deviceName}</b> has {bytes(o.sentBytes)} of {bytes(o.size)} of <b>{o.name}</b>. Their download stops and keeps what
            it has. To let them finish it later, remove it from this list first.
          </span>
        </Modal>
      )}
    </div>
  );
}

const PUSH_TEXT: Record<Push["status"], string> = {
  queued: "Queued",
  uploading: "Uploading",
  retrying: "Waiting to continue",
  completed: "Uploaded",
  failed: "Failed",
  canceled: "Canceled",
};

/** A file this device is uploading into someone else's shared folder. */
export function PushRow({ p }: { p: Push }) {
  const { toast } = useStore();
  const [busy, setBusy] = useState(false);
  const running = p.status === "queued" || p.status === "uploading" || p.status === "retrying";
  const tone = p.status === "failed" ? "err" : p.status === "canceled" ? "muted" : p.status === "retrying" || p.status === "queued" ? "warn" : "ok";
  const left = p.bps > 1 && p.status === "uploading" ? (p.size - p.sentBytes) / p.bps : null;
  const where = [p.shareName, ...p.remotePath.slice(0, -1)].join(" › ");
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    try {
      await f();
    } catch (e) {
      toast(errorText(e), "err");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`job tone-${tone} ${p.status === "failed" ? "attn" : ""}`}>
      <div className={`job-ico tone-${tone}`}>
        {p.status === "completed" ? <ShieldCheck size={17} /> : p.status === "failed" || p.status === "canceled" ? <XCircle size={17} /> : <UploadIcon size={17} />}
      </div>
      <div className="stack">
        <div className="hstack">
          <span className="job-title truncate selectable" title={p.localPath}>{p.savedAs ?? p.name}</span>
        </div>
        <div className="job-meta">
          <span className={`pill pill-${tone}`}>{PUSH_TEXT[p.status]}</span>
          <span className="num">{p.status === "completed" ? bytes(p.size) : `${bytes(p.sentBytes)} of ${bytes(p.size)}`}</span>
          {running && <span className="num job-pct">{pct(p.sentBytes, p.size)}</span>}
          {p.status === "uploading" && p.bps > 1 && <span className="num">{speed(p.bps)}</span>}
          {left != null && <span className="num">{duration(left)} left</span>}
          <span className="faint truncate">to {where} on {p.peerName}</span>
        </div>
        {p.error && p.status !== "completed" && <span className="small muted">{p.error}</span>}
      </div>
      <div className="job-actions">
        {(p.status === "failed" || p.status === "canceled") && (
          <IconButton label="Retry" disabled={busy} onClick={() => run(() => api.retryPush(p.id))}>
            <RotateCcw size={16} />
          </IconButton>
        )}
        {running && (
          <IconButton label="Cancel" disabled={busy} onClick={() => run(() => api.cancelPush(p.id))}>
            <X size={16} />
          </IconButton>
        )}
        {!running && (
          <IconButton label="Remove from list" disabled={busy} onClick={() => run(() => api.removePush(p.id))}>
            <Trash2 size={15} />
          </IconButton>
        )}
      </div>
      {running && (
        <div className="job-progress">
          <Progress value={p.size ? p.sentBytes / p.size : 0} tone={tone} indeterminate={p.status === "queued"} />
        </div>
      )}
    </div>
  );
}

const INCOMING_TEXT: Record<Incoming["status"], string> = {
  receiving: "Receiving upload",
  interrupted: "Interrupted",
  failed: "Failed",
  completed: "Received and verified",
};

/** A file another device is uploading into one of this device's shared folders. */
export function IncomingRow({ f }: { f: Incoming }) {
  const { toast } = useStore();
  const done = f.status === "completed";
  const tone = f.status === "failed" ? "err" : f.status === "interrupted" ? "warn" : "ok";
  const left = f.bps > 1 && f.status === "receiving" ? (f.size - f.receivedBytes) / f.bps : null;
  const where = [f.shareName, ...f.path.slice(0, -1)].join(" › ");
  return (
    <div className={`job tone-${tone} ${f.status === "failed" ? "attn" : ""}`}>
      <div className={`job-ico tone-${tone}`}>
        {done ? <ShieldCheck size={17} /> : f.status === "failed" ? <XCircle size={17} /> : f.status === "interrupted" ? <Clock size={17} /> : <Download size={17} />}
      </div>
      <div className="stack">
        <div className="hstack">
          <span className="job-title truncate selectable" title={[f.shareName, ...f.path].join(" / ")}>{f.savedAs ?? f.name}</span>
        </div>
        <div className="job-meta">
          <span className={`pill pill-${tone}`}>{f.status === "interrupted" ? `Waiting for ${f.deviceName}` : INCOMING_TEXT[f.status]}</span>
          <span className="num">{done ? bytes(f.size) : `${bytes(f.receivedBytes)} of ${bytes(f.size)}`}</span>
          {!done && <span className="num job-pct">{pct(f.receivedBytes, f.size)}</span>}
          {f.status === "receiving" && f.bps > 1 && <span className="num">{speed(f.bps)}</span>}
          {f.status === "receiving" && f.route === "relay" && <RelayedPill />}
          {left != null && <span className="num">{duration(left)} left</span>}
          <span className="faint truncate">from {f.deviceName} into {where}</span>
        </div>
        {f.error && f.status === "failed" && <span className="small muted">{f.error}</span>}
      </div>
      <div className="job-actions">
        {f.status !== "receiving" && (
          <IconButton label="Remove from list" onClick={() => api.removeIncoming(f.id).catch((e) => toast(errorText(e), "err"))}>
            <Trash2 size={15} />
          </IconButton>
        )}
      </div>
      {!done && f.status !== "failed" && (
        <div className="job-progress">
          <Progress value={f.size ? f.receivedBytes / f.size : 0} tone={tone} />
        </div>
      )}
    </div>
  );
}

type Filter = "all" | "receiving" | "sending" | "done" | "attention";

export default function Transfers() {
  const { jobs, outgoing, uploads, pushes, incoming, setPage, toast } = useStore();
  const flowActive = useFlowActive();
  const [filter, setFilter] = useState<Filter>("all");
  const tabSlide = useSlide<HTMLDivElement>(".tab", ".tab.on");
  const list = useMemo(() => Object.values(jobs).sort((a, b) => b.createdAt - a.createdAt), [jobs]);
  const sendingNow = outgoing.filter((o) => o.status === "sending" || o.status === "waiting" || o.status === "paused");
  const sentDone = outgoing.filter((o) => o.status === "verified" || o.status === "delivered");
  const pushRunning = pushes.filter((p) => p.status === "queued" || p.status === "uploading" || p.status === "retrying");
  const pushDone = pushes.filter((p) => p.status === "completed");
  const pushFailed = pushes.filter((p) => p.status === "failed");
  const inRunning = incoming.filter((f) => f.status === "receiving" || f.status === "interrupted");
  const inDone = incoming.filter((f) => f.status === "completed");
  const inFailed = incoming.filter((f) => f.status === "failed");
  const counts = {
    all: list.length + outgoing.length + pushes.length + incoming.length,
    receiving: list.filter((j) => isActive(j.status) || j.status === "paused").length + inRunning.length,
    sending: sendingNow.length + pushRunning.length,
    done: list.filter((j) => j.status === "completed").length + sentDone.length + pushDone.length + inDone.length,
    attention: list.filter((j) => j.status === "needs_attention" || j.status === "failed").length + pushFailed.length + inFailed.length,
  };
  const inShown =
    filter === "all" ? incoming : filter === "receiving" ? inRunning : filter === "done" ? inDone : filter === "attention" ? inFailed : [];
  const inBps = incoming.reduce((s, f) => s + (f.status === "receiving" ? f.bps : 0), 0);
  const inLeft = inRunning.reduce((s, f) => s + Math.max(0, f.size - f.receivedBytes), 0);
  const pushShown =
    filter === "all" ? pushes : filter === "sending" ? pushRunning : filter === "done" ? pushDone : filter === "attention" ? pushFailed : [];
  const pushBps = pushRunning.reduce((s, p) => s + p.bps, 0);
  const pushLeft = pushRunning.reduce((s, p) => s + Math.max(0, p.size - p.sentBytes), 0);
  const shown = list.filter((j) =>
    filter === "all"
      ? true
      : filter === "receiving"
        ? isActive(j.status) || j.status === "paused"
        : filter === "done"
          ? j.status === "completed"
          : filter === "attention"
            ? j.status === "needs_attention" || j.status === "failed"
            : false,
  );
  const sends = filter === "all" || filter === "sending" ? outgoing : filter === "done" ? sentDone : [];
  const sendLeft = sendingNow.reduce((a, o) => a + (o.size - o.sentBytes), 0);
  const total = list.filter((j) => j.status === "downloading").reduce((s, j) => s + j.speedBps, 0) + inBps;
  const remaining = list.filter((j) => isActive(j.status)).reduce((s, j) => s + (j.size - j.doneBytes), 0) + inLeft;

  const upBps = uploads.reduce((s, u) => s + u.bps, 0) + pushBps;

  return (
    <div className="page">
      <HudStrip
        label="Transfer summary"
        stats={[
          { label: "Receiving", value: total > 0 ? speed(total) : counts.receiving || "–", tone: total > 0 ? "live" : undefined },
          { label: "Sending", value: upBps > 0 ? speed(upBps) : counts.sending || "–", tone: upBps > 0 ? "live" : undefined },
          { label: "Left to receive", value: remaining > 0 ? bytes(remaining) : "–", of: total > 0 && remaining > 0 ? duration(remaining / total) : undefined },
          { label: "Left to send", value: sendLeft + pushLeft > 0 ? bytes(sendLeft + pushLeft) : "–" },
          { label: "Needs attention", value: counts.attention, tone: counts.attention > 0 ? "err" : undefined },
        ]}
        note={`${counts.done} completed and verified end to end. Downloads keep their verified progress through disconnects, app restarts and reboots.`}
      />
      {(flowActive || total > 0) && <LiveFlow />}
      <div>
        <div className="tabs slides" role="tablist" ref={tabSlide}>
          {(
            [
              ["all", "All"],
              ["receiving", "Receiving"],
              ["sending", "Sending"],
              ["done", "Completed"],
              ["attention", "Needs attention"],
            ] as [Filter, string][]
          ).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={filter === k} className={`tab ${filter === k ? "on" : ""}`} onClick={() => setFilter(k)}>
              {label} <span className="c">{counts[k]}</span>
            </button>
          ))}
        </div>
        {sends.length > 0 && (
          <div className="tr-section">
            <SectionHeader title="Send">
              {sentDone.length > 0 && (filter === "sending" || filter === "all") && (
                <Button size="sm" variant="ghost" onClick={() => api.clearOutgoing().catch((e) => toast(errorText(e), "err"))}>
                  Clear finished
                </Button>
              )}
            </SectionHeader>
            <div className="panel job-list">
              {sends.map((o) => (
                <SendRow key={o.id} o={o} />
              ))}
            </div>
          </div>
        )}
        {pushShown.length > 0 && (
          <div className="tr-section">
            <SectionHeader title="Upload">
              {pushDone.length > 0 && (filter === "all" || filter === "done") && (
                <Button size="sm" variant="ghost" onClick={() => api.clearPushes().catch((e) => toast(errorText(e), "err"))}>
                  Clear finished
                </Button>
              )}
            </SectionHeader>
            <div className="panel job-list">
              {pushShown.map((p) => (
                <PushRow key={p.id} p={p} />
              ))}
            </div>
          </div>
        )}
        {inShown.length > 0 && (
          <div className="tr-section">
            <SectionHeader title="Uploads to your folders">
              {inDone.length > 0 && (filter === "all" || filter === "done") && (
                <Button size="sm" variant="ghost" onClick={() => api.clearIncoming().catch((e) => toast(errorText(e), "err"))}>
                  Clear finished
                </Button>
              )}
            </SectionHeader>
            <div className="panel job-list">
              {inShown.map((f) => (
                <IncomingRow key={f.id} f={f} />
              ))}
            </div>
          </div>
        )}
        {shown.length === 0 && sends.length === 0 && pushShown.length === 0 && inShown.length === 0 ? (
          <div className="panel">
            <Empty
              icon={filter === "sending" ? <UploadIcon size={20} /> : <Download size={20} />}
              title={filter === "sending" ? "Nothing being sent" : list.length === 0 && outgoing.length === 0 ? "No transfers yet" : `Nothing ${filter === "done" ? "completed" : "here"}`}
            >
              {filter === "sending" && "When someone downloads from your shared folders, each file shows here with its progress."}
              {filter !== "sending" && list.length === 0 && outgoing.length === 0 && (
                <>
                  Connect to someone who shared a folder with you, then pick files to download.{" "}
                  <a href="#" onClick={(e) => { e.preventDefault(); setPage("devices"); }}>Go to Receive</a>
                </>
              )}
            </Empty>
          </div>
        ) : shown.length > 0 ? (
          <div className="tr-section">
            <SectionHeader title="Receive">
              <span className="sec-stat num">{shown.length} file{shown.length === 1 ? "" : "s"}</span>
            </SectionHeader>
            <div className="panel job-list">
              {shown.map((j) => (
                <JobRow key={j.id} job={j} />
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
