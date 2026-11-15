import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownUp,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Download,
  FolderOpen,
  Info,
  LayoutGrid,
  ListChecks,
  Menu,
  Settings as SettingsIcon,
  Upload,
  X,
  XCircle,
} from "lucide-react";
import { AccessRequests, ConnectDialog, Onboarding } from "./dialogs";
import { FolderPickerHost } from "./android";
import { noticeText } from "./api";
import { ago, bytes, isActive } from "./format";
import { SpeedMeter } from "./telemetry";
import { useStore, type Page } from "./store";
import { Button, IconButton, Modal, usePhone } from "./ui";
import { useSlide } from "./slide";
import { ClockTag, Frame } from "./glass";
import Overview from "./pages/Overview";
import Transfers from "./pages/Transfers";

import Shares from "./pages/Shares";
import Devices from "./pages/Devices";
import Browser from "./pages/Browser";
import Activity from "./pages/Activity";
import History from "./pages/History";
import Settings from "./pages/Settings";
import logo from "./assets/bifrost-mark.svg";

const PHONE_TABS: Page[] = ["overview", "devices", "transfers"];

/** Screen code and names for each page (ruler navigation and the brand line). */
const SCENE: Record<Page, { code: string; name: string; short: string }> = {
  overview: { code: "01", name: "Overview", short: "Home" },
  shares: { code: "02", name: "Send", short: "Send" },
  devices: { code: "03", name: "Receive", short: "Recv" },
  browse: { code: "3B", name: "Browse", short: "Brws" },
  transfers: { code: "04", name: "Transfers", short: "Xfer" },
  history: { code: "05", name: "History", short: "Hist" },
  activity: { code: "06", name: "Activity", short: "Log" },
  settings: { code: "07", name: "Settings", short: "Conf" },
};

/** Phone-only sheet for the destinations that don't fit the bottom bar. */
function MoreSheet({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const slide = useSlide<HTMLDivElement>(".more-item", ".more-item.on");
  const go = (p: Page) => {
    s.setPage(p);
    onClose();
  };
  const items: { id: Page; label: string; sub: string; icon: React.ReactNode; count?: number }[] = [
    { id: "shares", label: "Send", sub: "Folders others can download from you", icon: <Upload size={20} />, count: s.shares.length || undefined },
    { id: "history", label: "History", sub: "Calendar, totals and privacy receipts", icon: <CalendarDays size={20} /> },
    { id: "activity", label: "Activity", sub: "Everything that happened, newest first", icon: <ListChecks size={20} /> },
    { id: "settings", label: "Settings", sub: "Speed, privacy and this device", icon: <SettingsIcon size={20} /> },
  ];
  return (
    <Modal title="More" onClose={onClose}>
      <div className="more-list slides" ref={slide}>
        {items.map((i) => (
          <button key={i.id} className={`more-item ${s.page === i.id ? "on" : ""}`} onClick={() => go(i.id)}>
            <span className="more-ico">{i.icon}</span>
            <span className="stack grow">
              <span className="more-label">{i.label}</span>
              <span className="small faint">{i.sub}</span>
            </span>
            {i.count != null && <span className="num small muted">{i.count}</span>}
            <ChevronRight size={18} className="faint" />
          </button>
        ))}
      </div>
      <div className="more-me">
        <span className={`dot ${s.network?.online ? "ok" : "warn"}`} />
        <span className="grow truncate"><b>{s.settings?.deviceName}</b> {s.network?.online ? "is online" : "is connecting…"}</span>
        <span className="small faint">{s.settings?.connectionMode === "direct_only" ? "Direct only" : "Direct first"}</span>
      </div>
    </Modal>
  );
}

/** The newest "someone downloaded / uploaded" notice, as a small tag. */
function NoticeTag() {
  const s = useStore();
  const latest = s.notices[0];
  if (!latest) return null;
  return (
    <div key={latest.id} className="gx-notice" role="status" title={noticeText(latest)}>
      <span className="gx-notice-lab">
        <i aria-hidden="true">{latest.kind === "uploaded" ? <Upload size={10} /> : <Download size={10} />}</i>
        Notice
        <span className="num">{ago(latest.at)}</span>
      </span>
      <span className="gx-notice-text">
        <b>{latest.deviceName}</b> {latest.kind === "uploaded" ? "uploaded " : "downloaded "}
        {latest.files === 1 ? latest.firstName : `${latest.files} files`} · {bytes(latest.bytes)}
      </span>
      {s.notices.length > 1 && (
        <button type="button" className="gx-notice-more" onClick={() => { s.dismissNotice(null); s.setPage("activity"); }}>
          +{s.notices.length - 1}
        </button>
      )}
      <IconButton label="Dismiss" className="gx-notice-x" onClick={() => s.dismissNotice(null)}>
        <X size={11} />
      </IconButton>
    </div>
  );
}

function Toasts() {
  const s = useStore();
  return (
    <div className="toasts" aria-live="polite">
      {s.toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          {t.tone === "ok" ? <CheckCircle2 size={16} /> : t.tone === "err" ? <XCircle size={16} /> : <Info size={16} />}
          <span className="toast-text" title={t.text}>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

function Dialogs({ moreOpen, closeMore }: { moreOpen: boolean; closeMore: () => void }) {
  const s = useStore();
  return (
    <>
      {s.connectOpen && <ConnectDialog onClose={() => s.setConnectOpen(false)} />}
      {moreOpen && <MoreSheet onClose={closeMore} />}
      <AccessRequests />
      <FolderPickerHost />
      {s.ready && <Onboarding />}
      <Toasts />
    </>
  );
}

/** Local date and time for the status line, refreshed each minute. */
function useClockText() {
  const fmt = () => new Date().toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", year: "numeric" });
  const [t, setT] = useState(fmt);
  useEffect(() => {
    const id = window.setInterval(() => setT(fmt()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return t;
}

export default function App() {
  const s = useStore();
  const phone = usePhone();
  const [moreOpen, setMoreOpen] = useState(false);
  const navSlide = useSlide<HTMLElement>(".nav-item", ".nav-item.active");
  const jobs = useMemo(() => Object.values(s.jobs), [s.jobs]);
  const activeCount = jobs.filter((j) => isActive(j.status)).length + s.outgoing.filter((o) => o.status === "sending" || o.status === "waiting").length;
  const attention = jobs.filter((j) => j.status === "needs_attention").length;
  const online = !!s.network?.online;
  const clock = useClockText();

  // Demo build only (screenshots): ?open=connect | browse opens that view.
  const demoOpened = useRef(false);
  useEffect(() => {
    if (import.meta.env.MODE !== "mock" || demoOpened.current || !s.ready) return;
    const open = new URLSearchParams(location.search).get("open");
    if (!open) return;
    demoOpened.current = true;
    if (open === "connect") s.setConnectOpen(true);
    const r = s.remotes.find((x) => x.shares.length);
    if (open === "browse" && r) s.openBrowser({ peerId: r.peerId, shareId: r.shares[0].id, shareName: r.shares[0].name, peerName: r.name });
  }, [s, s.ready]);

  const nav: { id: Page; label: string; short: string; icon: React.ReactNode; count?: number; hot?: boolean; alert?: boolean }[] = [
    { id: "overview", label: "Overview", short: "Home", icon: <LayoutGrid size={16} /> },
    { id: "shares", label: "Send", short: "Send", icon: <Upload size={16} />, count: s.shares.length || undefined },
    { id: "devices", label: "Receive", short: "Receive", icon: <Download size={16} />, count: s.remotes.length || undefined },
    { id: "transfers", label: "Transfers", short: "Transfers", icon: <ArrowDownUp size={16} />, count: attention || activeCount || undefined, hot: activeCount > 0, alert: attention > 0 },
    { id: "history", label: "History", short: "History", icon: <CalendarDays size={16} /> },
    { id: "activity", label: "Activity", short: "Activity", icon: <ListChecks size={16} /> },
    { id: "settings", label: "Settings", short: "Settings", icon: <SettingsIcon size={16} /> },
  ];
  if (s.browse && !phone) nav.splice(3, 0, { id: "browse", label: s.browse.shareName, short: "Browse", icon: <FolderOpen size={16} /> });

  const page = (() => {
    switch (s.page) {
      case "overview":
        return <Overview />;
      case "shares":
        return <Shares />;
      case "devices":
        return <Devices />;
      case "browse":
        return <Browser />;
      case "transfers":
        return <Transfers />;
      case "history":
        return <History />;
      case "activity":
        return <Activity />;
      case "settings":
        return <Settings />;
    }
  })();

  // ---------------------------------------------------------------- phone
  if (phone) {
    const shownNav = nav.filter((n) => PHONE_TABS.includes(n.id));
    const isOn = (id: Page) => s.page === id || (id === "devices" && s.page === "browse");
    const moreOn = !PHONE_TABS.includes(s.page) && s.page !== "browse";
    return (
      <div className="shell gx-phone">
        <aside className="sidebar">
          <nav className="nav slides" aria-label="Main" ref={navSlide}>
            {shownNav.map((n) => (
              <button key={n.id} className={`nav-item nav-${n.id} ${isOn(n.id) ? "active" : ""}`} onClick={() => s.setPage(n.id)} aria-current={isOn(n.id) ? "page" : undefined}>
                {n.icon}
                <span className="nav-short">{n.short}</span>
                {n.count != null && <span className={`nav-count ${n.alert ? "alert" : n.hot ? "hot" : ""}`}>{n.count}</span>}
              </button>
            ))}
            <button className={`nav-item nav-more ${moreOn ? "active" : ""}`} onClick={() => setMoreOpen(true)} aria-haspopup="dialog">
              <Menu size={17} />
              <span className="nav-short">More</span>
            </button>
          </nav>
        </aside>
        <main className={`main page-${s.page}`}>
          {s.page !== "overview" && (
            <header className="topbar">
              <div className="topbar-actions">
                <Button variant="secondary" icon={<Upload size={15} />} onClick={() => s.setPage("shares")}>Send</Button>
                <Button variant="secondary" icon={<Download size={15} />} onClick={() => s.setPage("devices")}>Receive</Button>
              </div>
            </header>
          )}
          <div className="content">{s.ready ? page : null}</div>
        </main>
        <Dialogs moreOpen={moreOpen} closeMore={() => setMoreOpen(false)} />
      </div>
    );
  }

  // ---------------------------------------------------------------- desktop
  const scene = SCENE[s.page];
  return (
    <div className={`gx ${online ? "" : "gx-offline"}`}>
      <Frame alert={attention > 0 || !online} />

      {/* The top ruler is the navigation: one FN label per screen. */}
      <nav className="gx-nav" aria-label="Main">
        {nav.map((n) => (
          <button
            key={n.id}
            type="button"
            className={`gx-nav-item ${s.page === n.id ? "on" : ""}`}
            onClick={() => s.setPage(n.id)}
            aria-current={s.page === n.id ? "page" : undefined}
            title={n.label}
          >
            <span className="num">FN_{SCENE[n.id].code}</span>
            <b>{SCENE[n.id].short}</b>
            {n.count != null && <span className={`gx-nav-count num ${n.alert ? "err" : n.hot ? "ok" : ""}`}>{n.count}</span>}
          </button>
        ))}
      </nav>

      <header className="gx-top">
        <div className="gx-brand">
          <img src={logo} width={14} height={14} alt="" draggable={false} />
          <span className="gx-brand-line">
            <b>Bifrost</b> 360 transfer tool 1.1
          </span>
          <span className="gx-brand-scene">
            <span className="gx-brand-code num">{scene.code}</span>
            {s.page === "browse" && s.browse ? `Browse // ${s.browse.shareName}` : scene.name}
          </span>
        </div>
        <div className="gx-tags">
          <NoticeTag />
          <div className="gx-speed">
            <SpeedMeter />
          </div>
          <span className={`gx-net ${online ? "on" : "off"}`} title={online ? "Connected to the network" : "Connecting to the network"}>
            <i />
            {online ? "Online" : "Offline"}
          </span>
          <ClockTag />
        </div>
      </header>

      <main className={`gx-desk main page-${s.page}`}>{s.ready ? page : null}</main>

      <div className="gx-status" aria-hidden="true">
        <span className={`dot ${online ? "ok" : "warn"}`} />
        <span className="truncate">{s.settings?.deviceName}</span>
        <span className="num">{clock}</span>
      </div>

      <Dialogs moreOpen={moreOpen} closeMore={() => setMoreOpen(false)} />
    </div>
  );
}
