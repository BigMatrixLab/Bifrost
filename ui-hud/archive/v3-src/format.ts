import type { Incoming, Job, JobStatus, Push, Upload } from "./api";

/**
 * Total speed this device receives and sends, from every kind of transfer:
 * down = its downloads + others uploading into its folders;
 * up = others downloading from it + its uploads into others' folders.
 */
export function totalRates(
  jobs: Record<string, Job> | Job[],
  uploads: Upload[],
  pushes: Push[],
  incoming: Incoming[],
): { down: number; up: number } {
  const list = Array.isArray(jobs) ? jobs : Object.values(jobs);
  const down =
    list.filter((j) => j.status === "downloading").reduce((a, j) => a + (j.speedBps || 0), 0) +
    incoming.filter((f) => f.status === "receiving").reduce((a, f) => a + (f.bps || 0), 0);
  const up =
    uploads.reduce((a, u) => a + (u.bps || 0), 0) + pushes.filter((p) => p.status === "uploading").reduce((a, p) => a + (p.bps || 0), 0);
  return { down, up };
}

export function bytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "–";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${Math.round(n)} B` : `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}

/** A transfer rate split for display: { value: "11.60", unit: "MB/s" }; value "–" when idle. */
export function speedParts(bps: number): { value: string; unit: string } {
  if (!Number.isFinite(bps) || bps < 1) return { value: "–", unit: "" };
  const u = ["B/s", "KB/s", "MB/s", "GB/s", "TB/s"];
  let i = 0;
  let v = bps;
  // Switch unit before the rounded value would read 1024.00.
  while (v >= 1023.995 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return { value: v.toFixed(2), unit: u[i] };
}

/** A transfer rate with two decimals: "191.02 B/s", "11.60 MB/s". */
export function speed(bps: number): string {
  const p = speedParts(bps);
  return p.unit ? `${p.value} ${p.unit}` : p.value;
}

export function mbit(bps: number): string {
  if (!Number.isFinite(bps) || bps < 0) return "–";
  return `${((bps * 8) / 1_000_000).toFixed(2)} Mbit/s`;
}

export function duration(secs: number | null | undefined): string {
  if (secs == null || !Number.isFinite(secs)) return "–";
  if (secs < 60) return `${Math.max(1, Math.round(secs))}s`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m ${Math.round(secs % 60)}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function ago(ms: number): string {
  const d = (Date.now() - ms) / 1000;
  if (d < 45) return "just now";
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

/** Invitations that never expire carry this date (core: NEVER_EXPIRES_MS, year 9999). */
export const NEVER_EXPIRES_MS = 253_402_300_799_000;
export const neverExpires = (ms: number) => ms >= NEVER_EXPIRES_MS;

export function until(ms: number): string {
  if (neverExpires(ms)) return "never";
  const d = (ms - Date.now()) / 1000;
  if (d <= 0) return "expired";
  return `in ${duration(d)}`;
}

export function dateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export const STATUS_TEXT: Record<JobStatus, string> = {
  queued: "Queued",
  connecting: "Connecting…",
  downloading: "Downloading",
  waiting_peer: "Waiting for sender",
  waiting_direct: "Waiting for direct path",
  reconnecting: "Connection lost, reconnecting",
  paused: "Paused by you",
  verifying: "Verifying data",
  completed: "Complete",
  failed: "Failed",
  canceled: "Canceled",
  needs_attention: "Needs attention",
};

export type Tone = "accent" | "ok" | "warn" | "err" | "muted" | "info" | "out";

/** Traffic light for operations: green = running or done, yellow = waiting
 * or paused, red = needs attention or failed. */
export function statusTone(s: JobStatus): Tone {
  switch (s) {
    case "downloading":
    case "verifying":
    case "completed":
      return "ok";
    case "waiting_peer":
    case "waiting_direct":
    case "reconnecting":
    case "connecting":
    case "paused":
      return "warn";
    case "needs_attention":
    case "failed":
      return "err";
    default:
      return "muted";
  }
}

export const ACTIVE: JobStatus[] = [
  "queued",
  "connecting",
  "downloading",
  "waiting_peer",
  "waiting_direct",
  "reconnecting",
  "verifying",
];

export function isActive(s: JobStatus) {
  return ACTIVE.includes(s);
}
