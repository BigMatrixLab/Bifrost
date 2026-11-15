import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type JobStatus =
  | "queued"
  | "connecting"
  | "downloading"
  | "waiting_peer"
  | "waiting_direct"
  | "reconnecting"
  | "paused"
  | "verifying"
  | "completed"
  | "failed"
  | "canceled"
  | "needs_attention";

export interface RouteInfo {
  kind: "direct" | "relay" | "none" | string;
  rttMs: number | null;
  remote: string | null;
}

export interface Job {
  id: string;
  peerId: string;
  peerName: string;
  shareId: string;
  remotePath: string[];
  displayName: string;
  destPath: string;
  size: number;
  verifiedBytes: number;
  doneBytes: number;
  status: JobStatus;
  error: string | null;
  speedBps: number;
  etaSecs: number | null;
  totalChunks: number;
  verifiedChunks: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  route: string;
}

export interface Invitation {
  id: string;
  shareId: string;
  expiresAt: number;
  maxUses: number | null;
  useCount: number;
  requireApproval: boolean;
  createdAt: number;
  state: "active" | "expired" | "used_up" | "revoked";
  hasShortCode: boolean;
  /** The 16-character code while it is published (sender only). */
  shortCode: string | null;
  /** What a device that joins with it may do. */
  permission: SharePermission;
}

export interface CreatedInvitation {
  invitation: Invitation;
  invite: string;
  shortCode: string | null;
  shortCodeExpiresAt: number | null;
  qrSvg: string;
}

export interface Share {
  id: string;
  name: string;
  rootPath: string;
  active: boolean;
  createdAt: number;
  invitations: Invitation[];
  deviceCount: number;
}

/** What one device may do in a shared folder (set by its invitation, changeable per device). */
export type SharePermission = "download" | "upload" | "both";

export const PERMISSION_OPTIONS: { value: SharePermission; label: string }[] = [
  { value: "download", label: "Download" },
  { value: "upload", label: "Upload" },
  { value: "both", label: "Both" },
];

export function permissionText(p: SharePermission | undefined): string {
  return p === "upload" ? "Upload only" : p === "both" ? "Download and upload" : "Download only";
}

/** One sentence for the owner: what a device with this permission can do. */
export function permissionHint(p: SharePermission | undefined): string {
  switch (p) {
    case "upload":
      return "They can add files and delete what they added, but can't see or download anything else.";
    case "both":
      return "They can download everything, add files, and delete only what they added themselves.";
    default:
      return "They can browse and download. They can't add, change or delete anything.";
  }
}

export const canDownload = (p: SharePermission | undefined) => p !== "upload";
export const canUpload = (p: SharePermission | undefined) => p === "upload" || p === "both";

export interface RemoteShare {
  id: string;
  name: string;
  permission: SharePermission;
}

/** A remote shared folder this device downloads new files from automatically. */
export interface SyncInfo {
  peerId: string;
  shareId: string;
  destDir: string;
  enabledAt: number;
  lastSyncAt: number | null;
  lastError: string | null;
  syncing: boolean;
}

/** Another device downloaded from or uploaded to one of this device's folders. */
export interface PeerNotice {
  id: string;
  kind: "downloaded" | "uploaded";
  peerId: string;
  deviceName: string;
  shareName: string;
  files: number;
  firstName: string;
  bytes: number;
  at: number;
}

/** "Lena's laptop downloaded report.pdf from “Client deliveries”" */
export function noticeText(n: PeerNotice): string {
  const what = n.files === 1 ? n.firstName : `${n.files} files`;
  return n.kind === "uploaded" ? `${n.deviceName} uploaded ${what} to “${n.shareName}”` : `${n.deviceName} downloaded ${what} from “${n.shareName}”`;
}

/** A file another device is uploading into one of this device's shared folders. */
export interface Incoming {
  id: string;
  peerId: string;
  deviceName: string;
  shareId: string;
  shareName: string;
  name: string;
  path: string[];
  savedAs: string | null;
  size: number;
  receivedBytes: number;
  bps: number;
  /** interrupted: the uploader may still continue it. */
  status: "receiving" | "interrupted" | "failed" | "completed";
  error: string | null;
  startedAt: number;
  updatedAt: number;
  route: string;
}

/** A file this device is uploading into someone else's shared folder. */
export interface Push {
  id: string;
  peerId: string;
  peerName: string;
  shareId: string;
  shareName: string;
  localPath: string;
  remotePath: string[];
  name: string;
  savedAs: string | null;
  size: number;
  sentBytes: number;
  bps: number;
  status: "queued" | "uploading" | "retrying" | "completed" | "failed" | "canceled";
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Grant {
  peerId: string;
  peerShort: string;
  deviceName: string;
  shareId: string;
  shareName: string;
  createdAt: number;
  lastSeenAt: number;
  connected: boolean;
  route: RouteInfo;
  safetyWords: string[];
  /** What this device may do in this folder. */
  permission: SharePermission;
  /** Its public IP for the map, while connected and map locations are on. */
  publicIp?: string | null;
}

export interface PeerStatus {
  peerId: string;
  state: "disconnected" | "connecting" | "connected" | "unreachable" | "denied" | string;
  route: RouteInfo;
  message: string | null;
  /** Its public IP for the map, while connected and map locations are on. */
  publicIp?: string | null;
}

/** Where an IP address is, at city level (from an online lookup). */
export interface GeoLoc {
  lat: number;
  lon: number;
  city: string;
  region: string;
  country: string;
}

export interface Remote {
  peerId: string;
  peerShort: string;
  name: string;
  shares: RemoteShare[];
  createdAt: number;
  lastSeenAt: number;
  status: PeerStatus;
  safetyWords: string[];
}

export interface RemoteEntry {
  name: string;
  isDir: boolean;
  size: number;
  modifiedMs: number;
  /** Uploaded by this device, so it may delete it. */
  mine: boolean;
}

export interface ListResult {
  entries: RemoteEntry[];
  total: number;
  offset: number;
  /** This device's current permission for the share. */
  permission: SharePermission;
}

export interface AccessRequest {
  id: string;
  peerId: string;
  peerShort: string;
  deviceName: string;
  shareId: string;
  shareName: string;
  createdAt: number;
  safetyWords: string[];
  /** What the device gets if approved. */
  permission: SharePermission;
}

export interface Activity {
  id: number;
  ts: number;
  level: "info" | "success" | "warning" | "error";
  message: string;
  jobId: string | null;
}

export interface NetworkStatus {
  endpointId: string;
  endpointShort: string;
  online: boolean;
  relayUrl: string | null;
  directAddrs: number;
  /** UDP port actually listened on for direct connections. */
  udpPort: number | null;
  /** This device's public IP, for the map (null if unknown or map locations are off). */
  publicIp: string | null;
}

export interface Upload {
  peerId: string;
  deviceName: string;
  bps: number;
  totalSent: number;
  files: string[];
}

/** A file this device is sending, with the receiver's progress. */
export interface Outgoing {
  id: string;
  peerId: string;
  deviceName: string;
  shareName: string;
  name: string;
  path: string[];
  size: number;
  sentBytes: number;
  bps: number;
  /** paused and canceled: by the user on this device. */
  status: "sending" | "waiting" | "paused" | "canceled" | "delivered" | "verified";
  startedAt: number;
  updatedAt: number;
  route: string;
}

export interface Settings {
  deviceName: string;
  downloadDir: string;
  parallelStreams: number;
  maxConcurrentJobs: number;
  /** Most connections per sender (1 = off). */
  maxConnections: number;
  downloadLimitKbps: number;
  uploadLimitKbps: number;
  connectionMode: "direct_only" | "allow_relay";
  congestion: "bbr" | "cubic";
  chunkSizeMib: number;
  lowPriority: boolean;
  notifications: boolean;
  closeToTray: boolean;
  onboarded: boolean;
  historyRetention: "forever" | "365" | "90" | "30" | "off";
  historyNames: boolean;
  relayUrls: string;
  /** UDP port for direct connections; applies after a restart. */
  udpPort: number;
  /** Place devices on the globe by public IP (looked up at ipinfo.io). */
  mapLocations: boolean;
  /** Permission new invitations start with. */
  defaultSharePermission: SharePermission;
}

/** A finished transfer kept on this device, with its privacy receipt. */
export interface HistoryEntry {
  id: string;
  direction: "received" | "sent";
  peerId: string;
  peerName: string;
  /** Empty when the user chose not to keep file names. */
  name: string;
  ext: string;
  size: number;
  startedAt: number;
  finishedAt: number;
  activeMs: number;
  directBytes: number;
  relayBytes: number;
  peakBps: number;
  blocks: number;
  fingerprint: string;
  safetyWords: string[];
}

export interface Bootstrap {
  platform: string;
  settings: Settings;
  network: NetworkStatus;
  version: string;
  dataDir: string;
}

export interface JoinResult {
  peerId: string;
  senderName: string;
  shares: RemoteShare[];
  safetyWords: string[];
}

export interface LocalDir {
  path: string;
  parent: string | null;
  dirs: string[];
  files: { name: string; size: number }[];
  root: string;
}

export interface DownloadItem {
  path: string[];
  isDir: boolean;
}

/** What a download would bring in, measured before it starts (folders walked on the sender). */
export interface DownloadEstimate {
  bytes: number;
  files: number;
  /** A folder had more files than one download takes; only the first ones count. */
  truncated: boolean;
}

/** Windows Firewall and Bifrost's direct connections (Settings → Connection). */
export interface FirewallStatus {
  /** Windows only. */
  supported: boolean;
  /** An inbound UDP allow rule covers every network type, and nothing blocks Bifrost. */
  allowed: boolean;
  /** Rules that block Bifrost (they win over allow rules). */
  blocked: number;
  program: string;
}

/** Space on the drive a download folder is on. */
export interface DiskSpace {
  /** The folder the numbers were read at (nearest existing one). */
  path: string;
  free: number;
  total: number;
  /** Still to be written by unfinished downloads to this drive. */
  reserved: number;
}

export const api = {
  bootstrap: () => invoke<Bootstrap>("bootstrap"),
  networkStatus: () => invoke<NetworkStatus>("network_status"),
  locateIp: (ip: string) => invoke<GeoLoc | null>("locate_ip", { ip }),
  updateSettings: (settings: Settings) => invoke<Settings>("update_settings", { settings }),
  listShares: () => invoke<Share[]>("list_shares"),
  createShare: (path: string, name?: string) => invoke<Share>("create_share", { path, name: name ?? null }),
  setDevicePermission: (peerId: string, shareId: string, permission: SharePermission) =>
    invoke<void>("set_device_permission", { peerId, shareId, permission }),
  startUpload: (peerId: string, shareId: string, dir: string[], paths: string[]) =>
    invoke<string[]>("start_upload", { peerId, shareId, dir, paths }),
  listPushes: () => invoke<Push[]>("list_pushes"),
  cancelPush: (id: string) => invoke<void>("cancel_push", { id }),
  retryPush: (id: string) => invoke<void>("retry_push", { id }),
  removePush: (id: string) => invoke<void>("remove_push", { id }),
  clearPushes: () => invoke<void>("clear_pushes"),
  listSyncs: () => invoke<SyncInfo[]>("list_syncs"),
  enableSync: (peerId: string, shareId: string, destDir: string | null, includeExisting: boolean) =>
    invoke<SyncInfo>("enable_sync", { peerId, shareId, destDir, includeExisting }),
  disableSync: (peerId: string, shareId: string) => invoke<void>("disable_sync", { peerId, shareId }),
  syncNow: () => invoke<void>("sync_now"),
  listIncoming: () => invoke<Incoming[]>("list_incoming"),
  removeIncoming: (id: string) => invoke<void>("remove_incoming", { id }),
  clearIncoming: () => invoke<void>("clear_incoming"),
  remoteMkdir: (peerId: string, shareId: string, path: string[]) => invoke<string>("remote_mkdir", { peerId, shareId, path }),
  remoteDelete: (peerId: string, shareId: string, path: string[]) => invoke<void>("remote_delete", { peerId, shareId, path }),
  setShareActive: (id: string, active: boolean) => invoke<void>("set_share_active", { id, active }),
  deleteShare: (id: string) => invoke<void>("delete_share", { id }),
  createInvitation: (
    shareId: string,
    expiresInSecs: number,
    maxUses: number | null,
    requireApproval: boolean,
    withCode: boolean,
    permission: SharePermission,
  ) => invoke<CreatedInvitation>("create_invitation", { shareId, expiresInSecs, maxUses, requireApproval, withCode, permission }),
  revokeInvitation: (id: string) => invoke<void>("revoke_invitation", { id }),
  listGrants: () => invoke<Grant[]>("list_grants"),
  revokeDevice: (peerId: string) => invoke<void>("revoke_device", { peerId }),
  pendingRequests: () => invoke<AccessRequest[]>("pending_requests"),
  respondAccess: (id: string, approve: boolean) => invoke<void>("respond_access", { id, approve }),
  join: (input: string) => invoke<JoinResult>("join", { input }),
  listRemotes: () => invoke<Remote[]>("list_remotes"),
  removeRemote: (peerId: string) => invoke<void>("remove_remote", { peerId }),
  connectRemote: (peerId: string) => invoke<PeerStatus>("connect_remote", { peerId }),
  listRemoteDir: (peerId: string, shareId: string, path: string[], offset: number, limit: number) =>
    invoke<ListResult>("list_remote_dir", { peerId, shareId, path, offset, limit }),
  startDownload: (peerId: string, shareId: string, items: DownloadItem[], destDir: string | null) =>
    invoke<string[]>("start_download", { peerId, shareId, items, destDir }),
  measureDownload: (peerId: string, shareId: string, items: DownloadItem[]) =>
    invoke<DownloadEstimate>("measure_download", { peerId, shareId, items }),
  diskSpace: (path: string) => invoke<DiskSpace>("disk_space", { path }),
  firewallStatus: () => invoke<FirewallStatus>("firewall_status"),
  allowDirectConnections: () => invoke<FirewallStatus>("allow_direct_connections"),
  listJobs: () => invoke<Job[]>("list_jobs"),
  pauseJob: (id: string) => invoke<void>("pause_job", { id }),
  resumeJob: (id: string) => invoke<void>("resume_job", { id }),
  restartJob: (id: string) => invoke<void>("restart_job", { id }),
  cancelJob: (id: string, deletePartial: boolean) => invoke<void>("cancel_job", { id, deletePartial }),
  removeJob: (id: string) => invoke<void>("remove_job", { id }),
  listActivity: (limit: number) => invoke<Activity[]>("list_activity", { limit }),
  listHistory: (sinceMs: number) => invoke<HistoryEntry[]>("list_history", { sinceMs }),
  clearHistory: () => invoke<void>("clear_history"),
  listOutgoing: () => invoke<Outgoing[]>("list_outgoing"),
  clearOutgoing: () => invoke<void>("clear_outgoing"),
  pauseOutgoing: (id: string) => invoke<void>("pause_outgoing", { id }),
  resumeOutgoing: (id: string) => invoke<void>("resume_outgoing", { id }),
  cancelOutgoing: (id: string) => invoke<void>("cancel_outgoing", { id }),
  removeOutgoing: (id: string) => invoke<void>("remove_outgoing", { id }),
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),
  listLocalDir: (path: string | null) => invoke<LocalDir>("list_local_dir", { path }),
  makeDir: (parent: string, name: string) => invoke<string>("make_dir", { parent, name }),
};

/** Android integration (no-ops on desktop). */
export const android = {
  hasAllFilesAccess: () => invoke<{ granted: boolean }>("plugin:bifrost-android|has_all_files_access"),
  requestAllFilesAccess: () => invoke<{ granted: boolean }>("plugin:bifrost-android|request_all_files_access"),
  requestNotificationPermission: () => invoke<{ granted: boolean }>("plugin:bifrost-android|request_notification_permission"),
  batteryStatus: () => invoke<{ unrestricted: boolean }>("plugin:bifrost-android|battery_status"),
  requestIgnoreBatteryOptimizations: () => invoke<{ unrestricted: boolean }>("plugin:bifrost-android|request_ignore_battery_optimizations"),
  openFile: (path: string) => invoke<void>("plugin:bifrost-android|open_file", { path }),
};

export function on<T>(event: string, cb: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(event, (e) => cb(e.payload));
}

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
