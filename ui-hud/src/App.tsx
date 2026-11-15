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
import { ClockTag, Win, pad } from "./glass";
import { AccessRequests, ConnectDialog, Onboarding } from "./dialogs";
import { FolderPickerHost } from "./android";
import { noticeText } from "./api";
import { ago, bytes, isActive } from "./format";
import { SpeedMeter } from "./telemetry";
import { MiniCalendar } from "./minical";
import { useStore, type Page } from "./store";
import { Button, IconButton, Modal, usePhone } from "./ui";
import { useSlide } from "./slide";
import Overview from "./pages/Overview";
import Transfers from "./pages/Transfers";

import Shares from "./pages/Shares";
import Devices from "./pages/Devices";
import Browser from "./pages/Browser";
import Activity from "./pages/Activity";
import History from "./pages/History";
import Settings from "./pages/Settings";
import logo from "./assets/bifrost-mark.svg";

/** Bifrost mark: a copy of src-tauri/icons/bifrost-mark-green.svg. */
function Logo() {
  return <img src={logo} width={18} height={18} alt="" draggable={false} />;
}

const PHONE_TABS: Page[] = ["overview", "devices", "transfers"];

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

export default function App() {
  const s = useStore();
  const phone = usePhone();
  const [moreOpen, setMoreOpen] = useState(false);
  const navSlide = useSlide<HTMLElement>(".nav-item", ".nav-item.active");
  const jobs = useMemo(() => Object.values(s.jobs), [s.jobs]);
  const activeCount = jobs.filter((j) => isActive(j.status)).length + s.outgoing.filter((o) => o.status === "sending" || o.status === "waiting").length;
  const attention = jobs.filter((j) => j.status === "needs_attention").length;
  const latest = s.notices[0];

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
    { id: "overview", label: "Overview", short: "Home", icon: <LayoutGrid size={17} /> },
    { id: "shares", label: "Send", short: "Send", icon: <Upload size={17} />, count: s.shares.length || undefined },
    { id: "devices", label: "Receive", short: "Receive", icon: <Download size={17} />, count: s.remotes.length || undefined },
    { id: "transfers", label: "Transfers", short: "Transfers", icon: <ArrowDownUp size={17} />, count: attention || activeCount || undefined, hot: activeCount > 0, alert: attention > 0 },
    { id: "history", label: "History", short: "History", icon: <CalendarDays size={17} /> },
    { id: "activity", label: "Activity", short: "Activity", icon: <ListChecks size={17} /> },
    { id: "settings", label: "Settings", short: "Settings", icon: <SettingsIcon size={17} /> },
  ];
  if (s.browse && !phone) nav.splice(3, 0, { id: "browse", label: s.browse.shareName, short: "Browse", icon: <FolderOpen size={17} /> });
  const shownNav = phone ? nav.filter((n) => PHONE_TABS.includes(n.id)) : nav;
  const currentAt = nav.findIndex((n) => n.id === s.page);
  const current = currentAt >= 0 ? { idx: currentAt + 1, label: nav[currentAt].label } : null;
  const isOn = (id: Page) => s.page === id || (phone && id === "devices" && s.page === "browse");
  const moreOn = phone && !PHONE_TABS.includes(s.page) && s.page !== "browse";

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

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark"><Logo /></span>
          Bifrost
        </div>
        <nav className="nav slides" aria-label="Main" ref={navSlide}>
          {shownNav.map((n, i) => (
            <button key={n.id} className={`nav-item nav-${n.id} ${isOn(n.id) ? "active" : ""} ${n.alert ? "alert" : ""}`} onClick={() => s.setPage(n.id)} aria-current={isOn(n.id) ? "page" : undefined}>
              {!phone && <b className="nav-code num" aria-hidden="true">{pad(i + 1)}</b>}
              {n.icon}
              <span className="truncate nav-long">{n.label}</span>
              <span className="nav-short">{n.short}</span>
              {n.count != null && <span className={`nav-count ${n.alert ? "alert" : n.hot ? "hot" : ""}`} title={n.alert ? "Needs attention" : undefined}>{n.count}</span>}
            </button>
          ))}
          {phone && (
            <button className={`nav-item nav-more ${moreOn ? "active" : ""}`} onClick={() => setMoreOpen(true)} aria-haspopup="dialog">
              <Menu size={17} />
              <span className="nav-short">More</span>
            </button>
          )}
        </nav>
        {!phone && latest && (
          <div key={latest.id} className="side-notice" role="status" title={noticeText(latest)}>
            <div className="sn-top">
              <span className="sn-ico" aria-hidden="true">{latest.kind === "uploaded" ? <Upload size={13} /> : <Download size={13} />}</span>
              <span className="sn-who truncate">{latest.deviceName}</span>
              <span className="sn-when">{ago(latest.at)}</span>
              <IconButton label="Dismiss" className="sn-x" onClick={() => s.dismissNotice(null)}>
                <X size={12} />
              </IconButton>
            </div>
            <span className="sn-what truncate">
              {latest.kind === "uploaded" ? "Uploaded " : "Downloaded "}
              {latest.files === 1 ? latest.firstName : `${latest.files} files`}
            </span>
            <span className="sn-where truncate">
              {latest.kind === "uploaded" ? "to " : "from "}
              {latest.shareName} · {bytes(latest.bytes)}
            </span>
            {s.notices.length > 1 && (
              <button type="button" className="sn-more" onClick={() => { s.dismissNotice(null); s.setPage("activity"); }}>
                +{s.notices.length - 1} more in Activity
              </button>
            )}
          </div>
        )}
        {!phone && (
          <Win code="C0" title="Month" bare className="side-win">
            <MiniCalendar />
          </Win>
        )}
        <div className="sidebar-foot">
          <div className="foot-row">
            <span className="me">
              <span className="me-name" title={s.settings?.deviceName}>{s.settings?.deviceName}</span>
              <span className="me-sub">
                <span className={`dot ${s.network?.online ? "ok" : "warn"}`} />
                {s.network?.online ? "Online" : "Connecting to network…"}
              </span>
            </span>
            {!phone && <SpeedMeter />}
          </div>
        </div>
      </aside>
      <main className={`main page-${s.page}`}>
        <header className="topbar">
          {!phone && current && (
            <div className="gx-title" aria-hidden="true">
              <b className="num">{pad(current.idx)}</b>
              <span className="truncate">{current.label}</span>
            </div>
          )}
          <div className="topbar-actions">
            {/* The phone home screen has its own big Send and Receive buttons. */}
            {!(phone && s.page === "overview") && (
              <>
                <Button
                  variant="secondary"
                  className={s.page === "shares" ? "topbar-on" : ""}
                  icon={<Upload size={15} />}
                  onClick={() => s.setPage("shares")}
                  aria-current={s.page === "shares" ? "page" : undefined}
                  title="Your shared folders"
                >
                  Send
                </Button>
                <Button
                  variant="secondary"
                  className={s.page === "devices" || s.page === "browse" ? "topbar-on" : ""}
                  icon={<Download size={15} />}
                  onClick={() => s.setPage("devices")}
                  aria-current={s.page === "devices" ? "page" : undefined}
                  title="Devices that share with you"
                >
                  Receive
                </Button>
              </>
            )}
            {!phone && <ClockTag />}
          </div>
        </header>
        <div className="content">
          {s.ready ? page : null}
        </div>
      </main>

      {s.connectOpen && <ConnectDialog onClose={() => s.setConnectOpen(false)} />}
      {moreOpen && <MoreSheet onClose={() => setMoreOpen(false)} />}
      <AccessRequests />
      <FolderPickerHost />
      {s.ready && <Onboarding />}

      <div className="toasts" aria-live="polite">
        {s.toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            {t.tone === "ok" ? <CheckCircle2 size={16} /> : t.tone === "err" ? <XCircle size={16} /> : <Info size={16} />}
            <span className="toast-text" title={t.text}>{t.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
