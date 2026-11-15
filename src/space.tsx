/**
 * Download dialog: how much the selection really is (folders are measured
 * on the sender) and whether it fits on the drive of the chosen folder.
 * Traffic light: green = fits with room to spare, amber = fits but leaves
 * the drive nearly full, red = doesn't fit.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, HardDrive, Loader2, XCircle } from "lucide-react";
import { api, errorText, type DiskSpace, type DownloadEstimate, type DownloadItem } from "./api";
import { bytes } from "./format";

/** What the engine keeps free per file (receiver: free < needed + 64 MiB fails). */
const MARGIN = 64 * 1024 * 1024;
const GB = 1024 ** 3;

export type SpaceLevel = "ok" | "warn" | "err" | "unknown";

/** "C:\Users\..." -> "C:", "\\server\share\..." -> "\\server\share", phone storage, else "this drive". */
export function driveName(p: string): string {
  const d = p.match(/^([A-Za-z]):/);
  if (d) return `${d[1].toUpperCase()}:`;
  const unc = p.match(/^\\\\[^\\]+\\[^\\]+/);
  if (unc) return unc[0];
  if (p.startsWith("/storage/emulated/")) return "phone storage";
  return "this drive";
}

export interface SpaceVerdict {
  level: SpaceLevel;
  need: number;
  /** Free space not already promised to downloads in progress. */
  avail: number;
  /** Left on the drive after this download (negative: short by that much). */
  left: number;
}

/**
 * Amber when what is left after the download is under 10% of the drive or
 * under 5 GB, whichever is smaller; red when it doesn't fit at all.
 */
export function verdict(est: DownloadEstimate | null, space: DiskSpace | null): SpaceVerdict | null {
  if (!est || !space) return null;
  const need = est.bytes + MARGIN * Math.max(1, Math.min(est.files, 16));
  const avail = Math.max(0, space.free - space.reserved);
  const left = avail - need;
  const low = Math.min(space.total > 0 ? space.total * 0.1 : 5 * GB, 5 * GB);
  return { level: left < 0 ? "err" : left < low ? "warn" : "ok", need: est.bytes, avail, left };
}

export function DownloadSpace({
  peerId,
  shareId,
  items,
  knownBytes,
  hasFolders,
  dest,
  onVerdict,
}: {
  peerId: string;
  shareId: string;
  items: DownloadItem[];
  /** Sizes of the selected files, known from the listing. */
  knownBytes: number;
  /** Selected folders need measuring on the sender. */
  hasFolders: boolean;
  dest: string;
  onVerdict: (v: SpaceVerdict | null) => void;
}) {
  const [est, setEst] = useState<DownloadEstimate | null>(hasFolders ? null : { bytes: knownBytes, files: items.length, truncated: false });
  const [estErr, setEstErr] = useState<string | null>(null);
  const [space, setSpace] = useState<DiskSpace | null>(null);
  const [spaceErr, setSpaceErr] = useState<string | null>(null);

  // Folders: walk them on the sender once per opening.
  useEffect(() => {
    if (!hasFolders) return;
    let live = true;
    api
      .measureDownload(peerId, shareId, items)
      .then((e) => live && setEst(e))
      .catch((e) => live && setEstErr(errorText(e)));
    return () => {
      live = false;
    };
    // Measured once per opening; the selection can't change while it's open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The drive: re-read when the folder changes (typing waits a moment).
  useEffect(() => {
    let live = true;
    setSpaceErr(null);
    const t = window.setTimeout(() => {
      api
        .diskSpace(dest)
        .then((s) => live && setSpace(s))
        .catch((e) => {
          if (!live) return;
          setSpace(null);
          setSpaceErr(errorText(e));
        });
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [dest]);

  const v = verdict(est, space);
  useEffect(() => onVerdict(v), [v?.level, v?.need, v?.avail]); // eslint-disable-line react-hooks/exhaustive-deps

  const drive = driveName(space?.path || dest);
  const total = space?.total || 0;
  const used = space && total ? Math.max(0, total - space.free) : 0;
  const pct = (n: number) => (total > 0 ? `${Math.max(0, Math.min(100, (n / total) * 100))}%` : "0%");
  const reserved = space ? Math.min(space.reserved, space.free) : 0;
  const thisPart = v ? Math.min(v.need, Math.max(0, (space?.free ?? 0) - reserved)) : 0;

  return (
    <div className={`space-check lv-${v?.level ?? "unknown"}`}>
      <div className="space-sum">
        <div>
          <span className="lab">Download size</span>
          <span className="space-v num">
            {est ? bytes(est.bytes) : estErr ? "–" : <Loader2 size={16} className="spin" />}
          </span>
          <span className="space-sub">
            {est ? `${est.files.toLocaleString()} file${est.files === 1 ? "" : "s"}${est.truncated ? " · first 50,000 only" : ""}` : estErr ? "Couldn't measure" : "Measuring folders…"}
          </span>
        </div>
        <div>
          <span className="lab">Free on {drive}</span>
          <span className="space-v num">{space ? bytes(space.free) : spaceErr ? "–" : <Loader2 size={16} className="spin" />}</span>
          <span className="space-sub">{space && total ? `of ${bytes(total)}` : spaceErr ? "Unknown" : "Reading drive…"}</span>
        </div>
        <div>
          <span className="lab">Left after</span>
          <span className={`space-v num tone-${v?.level ?? "unknown"}`}>{v ? (v.left < 0 ? `−${bytes(-v.left)}` : bytes(v.left)) : "–"}</span>
          <span className="space-sub">{v ? (v.left < 0 ? "short" : total ? `${((v.left / total) * 100).toFixed(1)}% of the drive` : "") : "\u00a0"}</span>
        </div>
      </div>

      {space && total > 0 && (
        <div className="space-bar" role="img" aria-label={`${drive}: ${bytes(used)} used, ${bytes(space.free)} free`}>
          <i className="sb-used" style={{ width: pct(used) }} />
          {reserved > 0 && <i className="sb-res" style={{ width: pct(reserved) }} />}
          {v && <i className={`sb-this tone-${v.level}`} style={{ width: pct(v.level === "err" ? Math.max(0, space.free - reserved) : thisPart) }} />}
        </div>
      )}
      {space && total > 0 && (
        <div className="space-legend">
          <span><i className="sb-used" />Used</span>
          {reserved > 0 && <span><i className="sb-res" />Other downloads {bytes(space.reserved)}</span>}
          {v && <span><i className={`sb-this tone-${v.level}`} />This download</span>}
          <span><i className="sb-free" />Free</span>
        </div>
      )}

      <Message v={v} drive={drive} space={space} estErr={estErr} spaceErr={spaceErr} />
    </div>
  );
}

function Message({
  v,
  drive,
  space,
  estErr,
  spaceErr,
}: {
  v: SpaceVerdict | null;
  drive: string;
  space: DiskSpace | null;
  estErr: string | null;
  spaceErr: string | null;
}) {
  if (estErr || spaceErr) {
    return (
      <div className="space-msg lv-warn" role="status">
        <AlertTriangle size={16} />
        <span>
          {estErr ? `Couldn't measure the folders (${estErr}).` : `Couldn't read free space (${spaceErr}).`} You can still start; Bifrost stops a file and tells
          you if the drive fills up.
        </span>
      </div>
    );
  }
  if (!v || !space) {
    return (
      <div className="space-msg lv-unknown" role="status">
        <HardDrive size={16} />
        <span>Checking space on {drive}…</span>
      </div>
    );
  }
  // "drive C:" reads better in a sentence than a bare "C:".
  const on = /^[A-Z]:$/.test(drive) ? `drive ${drive}` : drive;
  const promised = space.reserved > 0 ? ` Downloads already in progress still need ${bytes(space.reserved)} of the free space.` : "";
  if (v.level === "err") {
    return (
      <div className="space-msg lv-err" role="alert">
        <XCircle size={16} />
        <span>
          <b>Not enough space on {on}.</b>{" "}
          {space.reserved > 0
            ? `It has ${bytes(space.free)} free, but downloads already in progress still need ${bytes(space.reserved)} of it, leaving ${bytes(v.avail)} for this ${bytes(v.need)} download.`
            : `This needs ${bytes(v.need)} but only ${bytes(v.avail)} is free.`}{" "}
          Free up {bytes(-v.left)} or choose a folder on another drive.
        </span>
      </div>
    );
  }
  if (v.level === "warn") {
    return (
      <div className="space-msg lv-warn" role="status">
        <AlertTriangle size={16} />
        <span>
          <b>{on.charAt(0).toUpperCase() + on.slice(1)} will be nearly full.</b> Only {bytes(v.left)} is left after this download.{promised} Other apps may run out of space.
        </span>
      </div>
    );
  }
  return (
    <div className="space-msg lv-ok" role="status">
      <CheckCircle2 size={16} />
      <span>
        Fits on {on} with {bytes(v.left)} to spare.{promised}
      </span>
    </div>
  );
}
