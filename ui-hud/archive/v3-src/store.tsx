import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  api,
  noticeText,
  on,
  type AccessRequest,
  type Activity,
  type Grant,
  type HistoryEntry,
  type Job,
  type NetworkStatus,
  type Outgoing,
  type PeerStatus,
  type Incoming,
  type PeerNotice,
  type SyncInfo,
  type Push,
  type Remote,
  type Settings,
  type Share,
  type Upload,
} from "./api";
import { setPlatform } from "./platform";

export type Page = "overview" | "shares" | "devices" | "browse" | "transfers" | "history" | "activity" | "settings";

export interface BrowseTarget {
  peerId: string;
  shareId: string;
  shareName: string;
  peerName: string;
}

export interface Toast {
  id: number;
  tone: "ok" | "err" | "info";
  text: string;
}

interface Store {
  ready: boolean;
  version: string;
  dataDir: string;
  settings: Settings | null;
  network: NetworkStatus | null;
  shares: Share[];
  grants: Grant[];
  remotes: Remote[];
  jobs: Record<string, Job>;
  uploads: Upload[];
  outgoing: Outgoing[];
  /** Files this device is uploading into others' shares. */
  pushes: Push[];
  /** Files other devices are uploading into this device's shares. */
  incoming: Incoming[];
  /** Remote folders synced automatically. */
  syncs: SyncInfo[];
  /** Recent downloads and uploads by other devices in this device's folders, newest first. */
  notices: PeerNotice[];
  dismissNotice: (id: string | null) => void;
  refreshSyncs: () => void;
  pending: AccessRequest[];
  activity: Activity[];
  history: HistoryEntry[];
  integrity: Record<string, { checked: number; total: number }>;
  page: Page;
  browse: BrowseTarget | null;
  toasts: Toast[];
  connectOpen: boolean;
  setPage: (p: Page) => void;
  openBrowser: (t: BrowseTarget) => void;
  setConnectOpen: (v: boolean) => void;
  toast: (text: string, tone?: Toast["tone"]) => void;
  saveSettings: (s: Settings) => Promise<void>;
  refreshShares: () => void;
  refreshGrants: () => void;
  refreshRemotes: () => void;
  refreshJobs: () => void;
  refreshHistory: () => void;
}

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("store missing");
  return s;
}

/** Debounces bursts of change events into one refresh. */
function useDebounced(fn: () => void, ms = 150) {
  const t = useRef<number | undefined>(undefined);
  const f = useRef(fn);
  f.current = fn;
  return useCallback(() => {
    window.clearTimeout(t.current);
    t.current = window.setTimeout(() => f.current(), ms);
  }, [ms]);
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [version, setVersion] = useState("");
  const [dataDir, setDataDir] = useState("");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [network, setNetwork] = useState<NetworkStatus | null>(null);
  const [shares, setShares] = useState<Share[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [remotes, setRemotes] = useState<Remote[]>([]);
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [outgoing, setOutgoing] = useState<Outgoing[]>([]);
  const [pushes, setPushes] = useState<Push[]>([]);
  const [incoming, setIncoming] = useState<Incoming[]>([]);
  const [syncs, setSyncs] = useState<SyncInfo[]>([]);
  const [notices, setNotices] = useState<PeerNotice[]>([]);
  const [pending, setPending] = useState<AccessRequest[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [integrity, setIntegrity] = useState<Record<string, { checked: number; total: number }>>({});
  // Demo build only: `#shares`, `#devices`, … opens that page (for screenshots).
  const [page, setPage] = useState<Page>(() =>
    import.meta.env.MODE === "mock" && location.hash.length > 1 ? (location.hash.slice(1) as Page) : "overview",
  );
  const [browse, setBrowse] = useState<BrowseTarget | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [connectOpen, setConnectOpen] = useState(false);

  const toast = useCallback((text: string, tone: Toast["tone"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, tone, text }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "err" ? 7000 : 4000);
  }, []);

  const refreshShares = useDebounced(() => api.listShares().then(setShares).catch(() => {}));
  const refreshGrants = useDebounced(() => api.listGrants().then(setGrants).catch(() => {}));
  const refreshRemotes = useDebounced(() => api.listRemotes().then(setRemotes).catch(() => {}));
  const refreshSyncs = useDebounced(() => api.listSyncs().then((l) => setSyncs(l ?? [])).catch(() => {}));
  const refreshHistory = useDebounced(() => api.listHistory(0).then(setHistory).catch(() => {}), 400);
  const refreshJobs = useDebounced(() =>
    api
      .listJobs()
      .then((list) => setJobs(Object.fromEntries(list.map((j) => [j.id, j]))))
      .catch(() => {}),
  );

  useEffect(() => {
    let disposed = false;
    const unlisten: Array<() => void> = [];
    const sub = <T,>(name: string, cb: (p: T) => void) => on<T>(name, cb).then((u) => (disposed ? u() : unlisten.push(u)));

    sub<Job>("job-updated", (j) => setJobs((m) => ({ ...m, [j.id]: j })));
    sub<{ id: string }>("job-removed", ({ id }) =>
      setJobs((m) => {
        const n = { ...m };
        delete n[id];
        return n;
      }),
    );
    sub<PeerStatus>("peer-status", (p) =>
      setRemotes((rs) => rs.map((r) => (r.peerId === p.peerId ? { ...r, status: p } : r))),
    );
    sub<AccessRequest>("access-requested", (r) => setPending((p) => [...p.filter((x) => x.id !== r.id), r]));
    sub<{ id: string }>("access-resolved", ({ id }) => setPending((p) => p.filter((x) => x.id !== id)));
    sub("shares-changed", () => refreshShares());
    sub("grants-changed", () => refreshGrants());
    sub("remotes-changed", () => refreshRemotes());
    sub("history-changed", () => refreshHistory());
    sub<Activity>("activity", (a) => setActivity((l) => [a, ...l].slice(0, 300)));
    sub<NetworkStatus>("network-status", setNetwork);
    sub<Upload[]>("uploads", setUploads);
    sub<Outgoing[]>("outgoing", setOutgoing);
    sub<Push[]>("pushes", setPushes);
    sub<Incoming[]>("incoming", setIncoming);
    sub("syncs-changed", () => refreshSyncs());
    sub<PeerNotice>("peer-activity", (n) => {
      setNotices((l) => [n, ...l.filter((x) => x.id !== n.id)].slice(0, 20));
      toast(noticeText(n), "info");
    });
    sub<{ jobId: string; checked: number; total: number }>("integrity-progress", (p) =>
      setIntegrity((m) => ({ ...m, [p.jobId]: { checked: p.checked, total: p.total } })),
    );

    (async () => {
      try {
        const b = await api.bootstrap();
        setPlatform(b.platform);
        setVersion(b.version);
        setDataDir(b.dataDir);
        setSettings(b.settings);
        setNetwork(b.network);
        const [s, g, r, j, p, a] = await Promise.all([
          api.listShares(),
          api.listGrants(),
          api.listRemotes(),
          api.listJobs(),
          api.pendingRequests(),
          api.listActivity(300),
        ]);
        setShares(s);
        setGrants(g);
        setRemotes(r);
        setJobs(Object.fromEntries(j.map((x) => [x.id, x])));
        setPending(p);
        setActivity(a);
        api.listHistory(0).then(setHistory).catch(() => {});
        api.listOutgoing().then((o) => setOutgoing(o ?? [])).catch(() => {});
        api.listPushes().then((p) => setPushes(p ?? [])).catch(() => {});
        api.listIncoming().then((i) => setIncoming(i ?? [])).catch(() => {});
        api.listSyncs().then((l) => setSyncs(l ?? [])).catch(() => {});
      } finally {
        setReady(true);
      }
    })();
    return () => {
      disposed = true;
      unlisten.forEach((u) => u());
    };
  }, [refreshShares, refreshGrants, refreshRemotes, refreshHistory, refreshSyncs, toast]);

  const saveSettings = useCallback(async (s: Settings) => {
    const out = await api.updateSettings(s);
    setSettings(out);
  }, []);

  const dismissNotice = useCallback((id: string | null) => setNotices((l) => (id ? l.filter((n) => n.id !== id) : [])), []);

  const openBrowser = useCallback((t: BrowseTarget) => {
    setBrowse(t);
    setPage("browse");
  }, []);

  const value = useMemo<Store>(
    () => ({
      ready,
      version,
      dataDir,
      settings,
      network,
      shares,
      grants,
      remotes,
      jobs,
      uploads,
      outgoing,
      pushes,
      incoming,
      syncs,
      notices,
      dismissNotice,
      refreshSyncs,
      pending,
      activity,
      history,
      integrity,
      page,
      browse,
      toasts,
      connectOpen,
      setPage,
      openBrowser,
      setConnectOpen,
      toast,
      saveSettings,
      refreshShares,
      refreshGrants,
      refreshRemotes,
      refreshJobs,
      refreshHistory,
    }),
    [ready, version, dataDir, settings, network, shares, grants, remotes, jobs, uploads, outgoing, pushes, incoming, syncs, notices, dismissNotice, refreshSyncs, pending, activity, history, integrity, page, browse, toasts, connectOpen, openBrowser, toast, saveSettings, refreshShares, refreshGrants, refreshRemotes, refreshJobs, refreshHistory],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
