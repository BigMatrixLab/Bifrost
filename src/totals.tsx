/**
 * Multi-file downloads: everything one "Download" queued (a folder, or
 * several selected files) as one batch, and the total across all unfinished
 * batches, with the old charts: the chunk ring for the whole amount, a file
 * map with one cell per file, and a bar meter per batch.
 *
 * The engine queues a batch's files in one go with the same peer, share and
 * creation time, so that is what groups them.
 */
import { useMemo } from "react";
import { ArrowUpRight, FolderOpen, Files } from "lucide-react";
import type { Job } from "./api";
import { bytes, duration, speed, statusTone } from "./format";
import { useStore } from "./store";
import { ChunkRing } from "./hud";
import { Button, Progress } from "./ui";
import { Win, pad } from "./glass";

export interface Batch {
  key: string;
  peerName: string;
  /** Folder name when the files share one, else "12 files". */
  name: string;
  folder: boolean;
  jobs: Job[];
  size: number;
  received: number;
  verified: number;
  speed: number;
  files: number;
  filesDone: number;
  moving: number;
  /** Connecting, reconnecting, paused, waiting for the sender (yellow). */
  waiting: number;
  /** In line for a download slot (grey). */
  queued: number;
  attention: number;
  createdAt: number;
}

const needs = (n: number) => `${n} need${n === 1 ? "s" : ""} attention`;

const received = (j: Job) => (j.status === "completed" ? j.size : Math.min(j.size, j.doneBytes));
const verifiedOf = (j: Job) => (j.status === "completed" ? j.size : Math.min(j.size, j.verifiedBytes));

function nameOf(jobs: Job[]): { name: string; folder: boolean } {
  // Deepest folder all files share.
  const dirs = jobs.map((j) => j.remotePath.slice(0, -1));
  let common = dirs[0] ?? [];
  for (const d of dirs) {
    let i = 0;
    while (i < common.length && i < d.length && common[i] === d[i]) i++;
    common = common.slice(0, i);
  }
  if (common.length) return { name: common[common.length - 1], folder: true };
  return { name: jobs.length === 1 ? jobs[0].displayName : `${jobs.length} files`, folder: false };
}

/** Unfinished downloads grouped by batch, newest first. Canceled files don't count. */
export function useBatches(): Batch[] {
  const { jobs } = useStore();
  return useMemo(() => {
    const groups = new Map<string, Job[]>();
    for (const j of Object.values(jobs)) {
      if (j.status === "canceled") continue;
      const k = `${j.peerId}|${j.shareId}|${j.createdAt}`;
      const g = groups.get(k);
      if (g) g.push(j);
      else groups.set(k, [j]);
    }
    const out: Batch[] = [];
    for (const [key, list] of groups) {
      if (list.every((j) => j.status === "completed")) continue;
      list.sort((a, b) => a.remotePath.join("/").localeCompare(b.remotePath.join("/")));
      const tone = (j: Job) => statusTone(j.status);
      out.push({
        key,
        peerName: list[0].peerName,
        ...nameOf(list),
        jobs: list,
        size: list.reduce((a, j) => a + j.size, 0),
        received: list.reduce((a, j) => a + received(j), 0),
        verified: list.reduce((a, j) => a + verifiedOf(j), 0),
        speed: list.reduce((a, j) => a + (j.status === "downloading" ? j.speedBps : 0), 0),
        files: list.length,
        filesDone: list.filter((j) => j.status === "completed").length,
        moving: list.filter((j) => j.status === "downloading" || j.status === "verifying").length,
        waiting: list.filter((j) => tone(j) === "warn").length,
        queued: list.filter((j) => j.status === "queued").length,
        attention: list.filter((j) => tone(j) === "err").length,
        createdAt: list[0].createdAt,
      });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }, [jobs]);
}

/** One cell per file (or per group of files when there are many), filled as it arrives. */
function FileMap({ jobs }: { jobs: Job[] }) {
  const MAX = 180;
  const per = Math.ceil(jobs.length / MAX);
  const cells = useMemo(() => {
    const out: { p: number; tone: string; title: string }[] = [];
    for (let i = 0; i < jobs.length; i += per) {
      const g = jobs.slice(i, i + per);
      const size = g.reduce((a, j) => a + j.size, 0) || 1;
      const p = g.reduce((a, j) => a + received(j), 0) / size;
      const tones = g.map((j) => (j.status === "completed" ? "done" : statusTone(j.status)));
      const tone = tones.includes("err") ? "err" : tones.every((t) => t === "done") ? "done" : tones.includes("ok") ? "ok" : tones.includes("warn") ? "warn" : "muted";
      const title = g.length === 1 ? `${g[0].displayName} · ${Math.floor(p * 100)}%` : `${g.length} files · ${Math.floor(p * 100)}%`;
      out.push({ p, tone, title });
    }
    return out;
  }, [jobs, per]);
  return (
    <div className="fmap" role="img" aria-label={`${jobs.length} files`}>
      {cells.map((c, i) => (
        <i key={i} className={`fm-${c.tone}`} title={c.title} style={{ ["--p" as string]: c.p }} />
      ))}
    </div>
  );
}

function BatchRow({ b }: { b: Batch }) {
  const tone = b.attention ? "err" : b.moving ? "ok" : "warn";
  const left = Math.max(0, b.size - b.received);
  return (
    <div className={`dt-batch tone-${tone}`}>
      <span className="dt-batch-ico" aria-hidden="true">{b.folder ? <FolderOpen size={14} /> : <Files size={14} />}</span>
      <span className="dt-batch-id">
        <span className="dt-batch-name truncate" title={b.name}>{b.name}</span>
        <span className="dt-batch-sub truncate">
          {b.peerName} · {b.filesDone}/{b.files} files{b.attention ? ` · ${needs(b.attention)}` : ""}
        </span>
      </span>
      <span className="dt-batch-bar">
        <Progress value={b.received / Math.max(1, b.size)} tone={tone === "err" ? "err" : tone === "ok" ? "ok" : "warn"} />
      </span>
      <span className="dt-batch-num num">
        {bytes(b.received)} <span className="faint">/ {bytes(b.size)}</span>
      </span>
      <span className="dt-batch-eta num">{b.speed > 0 ? duration(left / b.speed) : "–"}</span>
    </div>
  );
}

/**
 * The total of every unfinished multi-file download: shown when two or more
 * files are on their way. `link` adds a key to the Transfers page.
 */
export function DownloadTotals({ link = false }: { link?: boolean }) {
  const { setPage } = useStore();
  const batches = useBatches();
  const t = useMemo(() => {
    const jobs = batches.flatMap((b) => b.jobs);
    const sum = (f: (b: Batch) => number) => batches.reduce((a, b) => a + f(b), 0);
    return {
      jobs,
      size: sum((b) => b.size),
      received: sum((b) => b.received),
      verified: sum((b) => b.verified),
      speed: sum((b) => b.speed),
      files: sum((b) => b.files),
      filesDone: sum((b) => b.filesDone),
      moving: sum((b) => b.moving),
      waiting: sum((b) => b.waiting),
      queued: sum((b) => b.queued),
      attention: sum((b) => b.attention),
      peers: new Set(batches.map((b) => b.peerName)).size,
    };
  }, [batches]);
  if (t.files < 2) return null;

  const left = Math.max(0, t.size - t.received);
  const eta = t.speed > 0 ? left / t.speed : null;
  const frac = t.received / Math.max(1, t.size);
  const state = t.moving ? "active" : t.attention ? "attention" : "paused";
  const tone = t.attention ? "err" : t.moving ? "ok" : "warn";
  const shown = batches.slice(0, 4);

  return (
    <Win
      code="K3"
      title="Download total"
      meta={`${pad(t.filesDone)} / ${pad(t.files)}`}
      metaTone={t.attention ? "red" : t.moving ? "mint" : "amber"}
      tone={tone}
      sub={`RX / ${batches.length} download${batches.length === 1 ? "" : "s"} from ${t.peers} device${t.peers === 1 ? "" : "s"}`}
      foot={`${t.moving} moving · ${t.waiting} waiting · ${t.queued} queued${t.attention ? ` · ${needs(t.attention)}` : ""}`}
      keys={
        link ? (
          <Button size="sm" variant="ghost" icon={<ArrowUpRight size={14} />} onClick={() => setPage("transfers")}>
            All transfers
          </Button>
        ) : undefined
      }
      className="dt-win"
    >
      <section className="panel dt" aria-label="Download total">
        <div className="dt-top">
          <ChunkRing verified={t.verified / Math.max(1, t.size)} done={frac} size={188} state={state} label={`${Math.floor(frac * 100)} percent of all files received`}>
            <span className="ring-pct">
              {(frac * 100).toFixed(1)}
              <small>%</small>
            </span>
            <span className="lab">Received</span>
            <span className="ring-sub">
              {t.filesDone} / {t.files} files
            </span>
          </ChunkRing>
          <div className="dt-facts">
            <dl className="focus-kv dt-kv">
              <div>
                <dt className="lab">Total</dt>
                <dd className="num">{bytes(t.size)}</dd>
              </div>
              <div>
                <dt className="lab">Received</dt>
                <dd className="num ok-text">{bytes(t.received)}</dd>
              </div>
              <div>
                <dt className="lab">Remaining</dt>
                <dd className="num">{bytes(left)}</dd>
              </div>
              <div>
                <dt className="lab">Speed</dt>
                <dd className="num">{t.speed > 0 ? speed(t.speed) : "–"}</dd>
              </div>
              <div>
                <dt className="lab">Time left</dt>
                <dd className="num">{eta != null ? duration(eta) : "–"}</dd>
              </div>
              <div>
                <dt className="lab">Files left</dt>
                <dd className="num">{(t.files - t.filesDone).toLocaleString()}</dd>
              </div>
            </dl>
            <div className="dt-map">
              <span className="lab">Files</span>
              <FileMap jobs={t.jobs} />
              <span className="dt-legend">
                <span><i className="fm-done" />Done {t.filesDone}</span>
                <span><i className="fm-ok" />Moving {t.moving}</span>
                {t.waiting > 0 && <span><i className="fm-warn" />Waiting {t.waiting}</span>}
                {t.queued > 0 && <span><i className="fm-muted" />Queued {t.queued}</span>}
                {t.attention > 0 && <span><i className="fm-err" />Attention {t.attention}</span>}
              </span>
            </div>
          </div>
        </div>
        <div className="dt-batches">
          {shown.map((b) => (
            <BatchRow key={b.key} b={b} />
          ))}
          {batches.length > shown.length && <span className="hint">+{batches.length - shown.length} more downloads in Transfers</span>}
        </div>
      </section>
    </Win>
  );
}
