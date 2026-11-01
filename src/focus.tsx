import { useCallback, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { api, errorText, type Job } from "./api";
import { isActive, bytes, duration, speed, statusTone, STATUS_TEXT } from "./format";
import { useStore } from "./store";
import { Button } from "./ui";
import { ChunkRing, LinkLine } from "./hud";

// Which unfinished download gets the big ring: moving data first, then the
// ones about to move, then the ones that wait on the user.
const FOCUS_ORDER: Job["status"][] = [
  "downloading",
  "verifying",
  "reconnecting",
  "connecting",
  "waiting_direct",
  "waiting_peer",
  "queued",
  "needs_attention",
  "paused",
];

export interface Focus {
  job: Job | null;
  /** 1-based position of `job` in the list, 0 when empty. */
  index: number;
  count: number;
  prev: () => void;
  next: () => void;
}

/**
 * The unfinished downloads in focus order, and which one the card shows.
 * The choice is kept by job id, so the card stays on the same file when the
 * order changes (a speed change, a status change); it falls back to the
 * first one when that job finishes.
 */
export function useFocusJob(): Focus {
  const { jobs } = useStore();
  const [picked, setPicked] = useState<string | null>(null);
  const list = useMemo(() => {
    const l = Object.values(jobs).filter((j) => FOCUS_ORDER.includes(j.status));
    // Order by status, then name: speed changes every second and must not reshuffle the pager.
    l.sort((a, b) => FOCUS_ORDER.indexOf(a.status) - FOCUS_ORDER.indexOf(b.status) || a.displayName.localeCompare(b.displayName));
    return l;
  }, [jobs]);
  const at = Math.max(0, list.findIndex((j) => j.id === picked));
  const step = useCallback(
    (d: number) => {
      if (!list.length) return;
      setPicked(list[(at + d + list.length) % list.length].id);
    },
    [list, at],
  );
  const prev = useCallback(() => step(-1), [step]);
  const next = useCallback(() => step(1), [step]);
  return { job: list[at] ?? null, index: list.length ? at + 1 : 0, count: list.length, prev, next };
}

function two(n: number) {
  return String(n).padStart(2, "0");
}

/** The download that matters most right now, as a chunk ring with its facts. */
export function FocusTransfer({
  job,
  index,
  count,
  onPrev,
  onNext,
  compact = false,
}: {
  job: Job;
  index: number;
  count: number;
  onPrev?: () => void;
  onNext?: () => void;
  compact?: boolean;
}) {
  const { settings, integrity, setPage, toast } = useStore();
  const [busy, setBusy] = useState(false);
  const size = Math.max(1, job.size);
  const verified = job.status === "completed" ? 1 : job.verifiedBytes / size;
  const done = job.doneBytes / size;
  const attention = job.status === "needs_attention" || job.status === "failed";
  // One traffic-light tone for the whole card (corner marks, glow, ring,
  // status line): green while data moves, yellow while waiting or paused,
  // red when it needs attention. Queued counts as waiting.
  const t = statusTone(job.status);
  const tone = t === "err" ? "err" : t === "ok" ? "ok" : "warn";
  const state = tone === "err" ? "attention" : tone === "warn" ? "paused" : "active";
  const integ = integrity[job.id];
  const checking = job.status === "verifying" && integ ? integ.checked / Math.max(1, integ.total) : null;
  const pctShown = (checking ?? verified) * 100;
  const moving = job.status === "downloading";
  const paged = count > 1 && !!onPrev && !!onNext;
  const head = moving ? `Receiving · from ${job.peerName}` : `${STATUS_TEXT[job.status]} · ${job.peerName}`;

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
    <div className={`focus-wrap ${compact ? "compact" : ""}`}>
      <section
        className={`panel focus ftone-${tone} ${attention ? "attn" : ""}`}
        aria-label="Active transfer"
        onKeyDown={(e) => {
          if (!paged || (e.target as HTMLElement).closest("input, textarea")) return;
          if (e.key === "ArrowLeft") onPrev!();
          else if (e.key === "ArrowRight") onNext!();
        }}
      >
        <div className="focus-head">
          <span className="lab">Active transfer</span>
          {paged ? (
            <span className="focus-pager">
              <button type="button" className="pager-btn" onClick={onPrev} aria-label="Previous transfer" title="Previous (←)">
                <ChevronLeft size={14} />
              </button>
              <span className="num" aria-live="polite">
                {two(index)} <span className="faint">/ {two(count)}</span>
              </span>
              <button type="button" className="pager-btn" onClick={onNext} aria-label="Next transfer" title="Next (→)">
                <ChevronRight size={14} />
              </button>
            </span>
          ) : (
            <span className="num faint">{two(index)} / {two(count)}</span>
          )}
        </div>
        {paged && (
          <div className="focus-dots" role="presentation">
            {Array.from({ length: count }, (_, i) => (
              <i key={i} className={i === index - 1 ? "on" : ""} />
            ))}
          </div>
        )}
        <div className="focus-body" key={job.id}>
          <ChunkRing
            verified={verified}
            done={done}
            size={compact ? 200 : 228}
            state={state}
            label={`${Math.floor(pctShown)} percent ${checking != null ? "checked" : "verified"}`}
          >
            <span className="ring-pct">
              {pctShown.toFixed(1)}
              <small>%</small>
            </span>
            <span className="lab">{checking != null ? "Checking" : "Verified"}</span>
            <span className="ring-sub">
              {bytes(job.verifiedBytes)} / {bytes(job.size)}
            </span>
          </ChunkRing>
          <div className="focus-facts">
            <span className="lab focus-status">{head}</span>
            <span className="focus-name selectable" title={job.remotePath.join(" / ")}>{job.displayName}</span>
            <span className="focus-path num faint truncate">{job.remotePath.slice(0, -1).join(" / ") || "Shared folder root"}</span>
            {attention && job.error && <span className="focus-err small">{job.error}</span>}
            <dl className="focus-kv">
              <div>
                <dt className="lab">Speed</dt>
                <dd className="num">{moving ? speed(job.speedBps) : "–"}</dd>
              </div>
              <div>
                <dt className="lab">Time left</dt>
                <dd className="num">{moving && job.etaSecs != null ? duration(job.etaSecs) : "–"}</dd>
              </div>
              <div>
                <dt className="lab">Chunks</dt>
                <dd className="num">
                  {job.verifiedChunks.toLocaleString()}
                  <span className="faint">{compact ? "/" : " / "}{job.totalChunks.toLocaleString()}</span>
                </dd>
              </div>
              {!compact && (
                <>
                  <div>
                    <dt className="lab">Blocks verified</dt>
                    <dd className="num">{Math.floor(job.verifiedBytes / 1048576).toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt className="lab">Route</dt>
                    <dd className="num">{job.route === "direct" ? "Direct" : job.route === "relay" ? "Relay" : "–"}</dd>
                  </div>
                  <div>
                    <dt className="lab">Encryption</dt>
                    <dd className="num">QUIC · TLS 1.3</dd>
                  </div>
                </>
              )}
            </dl>
            <div className="focus-foot">
              <LinkLine local={settings?.deviceName || "This device"} peer={job.peerName} kind={job.route} moving={moving} />
              <div className="focus-actions">
                {isActive(job.status) && (
                  <Button size="sm" loading={busy} onClick={() => run(() => api.pauseJob(job.id))}>Pause</Button>
                )}
                {job.status === "paused" && (
                  <Button size="sm" variant="primary" loading={busy} onClick={() => run(() => api.resumeJob(job.id))}>Resume</Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setPage("transfers")}>Details</Button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

