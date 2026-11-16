import { useMemo, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, FolderOpen, Monitor } from "lucide-react";
import { api, errorText } from "../api";
import { ago, bytes, isActive, speed, statusTone, STATUS_TEXT, totalRates } from "../format";
import { useStore } from "../store";
import { Button, Empty, LinkReadout, SignalBars, linkOf, usePhone, type Link } from "../ui";
import { DotGlobe, relayRegion, type GlobeDevice } from "../hud";
import { placeName, useLocations } from "../geo";
import { useFocusJob } from "../focus";
import { useFlow, useFlowActive } from "../flow";
import { JobRow, SendRow } from "./Transfers";
import { useShareFolder } from "./Shares";
import { StorageAccessNotice } from "../android";
import { MiniCalendar } from "../minical";
import { LevelBars, PlateMenu, Readout, Scroller, SideTabs, StatBoxes, Win, pad } from "../glass";
import PhoneHome from "./PhoneHome";

export default function Overview() {
  return usePhone() ? <PhoneHome /> : <DesktopOverview />;
}

function relayHost(url: string | null): string {
  if (!url) return "–";
  try {
    return new URL(url).hostname.split(".")[0] || "–";
  } catch {
    return "–";
  }
}

/** Seconds as the board's clock readout: 00:51:52. */
function clockOf(secs: number | null | undefined) {
  if (secs == null || !Number.isFinite(secs) || secs < 0) return "00:00:00";
  const s = Math.round(secs);
  return `${pad(s / 3600)}:${pad((s / 60) % 60)}:${pad(s % 60)}`;
}

/** One linked device: a status node, who it is and which way files go, and the live link readout. */
export function DeviceTile({
  name,
  dir,
  detail,
  link,
  rtt,
  action,
  busy = false,
  title,
  access,
}: {
  name: string;
  dir: "in" | "out";
  detail: string;
  link: Link;
  rtt: number | null;
  action?: React.ReactNode;
  /** Data is moving right now: the detail line turns green. */
  busy?: boolean;
  /** Tooltip on the name (e.g. the device's ID and safety words). */
  title?: string;
  /** Optional column before the link readout (the Send page's access picker). */
  access?: React.ReactNode;
}) {
  return (
    <div className={`dev-tile link-${link} ${access ? "has-access" : ""}`}>
      <span className="dev-node" aria-hidden="true">
        <Monitor size={15} />
      </span>
      <span className="dev-id">
        <span className="dev-name truncate" title={title}>{name}</span>
        <span className="dev-meta">
          <span className={`dev-dir ${dir}`}>
            {dir === "in" ? <ArrowDownLeft size={11} /> : <ArrowUpRight size={11} />}
            {dir === "in" ? "Source" : "Guest"}
          </span>
          <span className={`truncate ${busy ? "dev-busy" : ""}`}>{detail}</span>
        </span>
      </span>
      {access && <span className="dev-access">{access}</span>}
      <LinkReadout link={link} rtt={rtt} />
      <span className="dev-act">{action}</span>
    </div>
  );
}

// ------------------------------------------------------------------ FN01 transfer console

/** Last seconds of receive speed as a column of ticks, like the board's left strip. */
function SpeedTicks() {
  const { samples } = useFlow();
  const last = samples.slice(-18);
  const max = Math.max(1, ...last.map((s) => s.down));
  return (
    <div className="gc-ticks" aria-hidden="true">
      {Array.from({ length: 18 }, (_, i) => {
        const s = last[last.length - 18 + i];
        const v = s ? s.down / max : 0;
        return <i key={i} className={v > 0.85 ? "hi" : ""} style={{ width: `${18 + v * 82}%` }} />;
      })}
    </div>
  );
}

function TransferConsole({ area }: { area: string }) {
  const { settings, integrity, setPage, setConnectOpen, toast } = useStore();
  const focus = useFocusJob();
  const shareFolder = useShareFolder();
  const [busy, setBusy] = useState(false);
  const job = focus.job;

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

  if (!job) {
    return (
      <Win
        code="FN01"
        title="Console"
        area={area}
        className="gc"
        scroll={false}
        aria-label="Start"
        sub="Mode / standby · no transfer running"
        subKeys={<span className="gx-chip">Idle</span>}
        meta="00-00"
        metaTone="mint"
        foot="Select a function"
      >
        <div className="gc-grid">
          <SpeedTicks />
          <div className="gc-main">
            <span className="gc-state">Standby</span>
            <span className="gc-name">Nothing is being received</span>
            <span className="gc-path">Share a folder, or open an invitation someone sent you.</span>
            <Readout prefix="TP" value="00:00:00" tail=":000" label="No transfer" />
          </div>
          <PlateMenu
            label="Start"
            value={null}
            onChange={(id) => (id === "send" ? shareFolder() : id === "recv" ? setConnectOpen(true) : setPage("transfers"))}
            items={[
              { id: "send", label: "Share a folder", title: "Share a folder and invite someone to download from it" },
              { id: "recv", label: "Connect code", title: "Open an invitation or short code someone sent you" },
              { id: "list", label: "Transfers" },
            ]}
          />
        </div>
      </Win>
    );
  }

  const size = Math.max(1, job.size);
  const verified = job.status === "completed" ? 1 : job.verifiedBytes / size;
  const done = job.doneBytes / size;
  const integ = integrity[job.id];
  const checking = job.status === "verifying" && integ ? integ.checked / Math.max(1, integ.total) : null;
  const pctShown = (checking ?? verified) * 100;
  const moving = job.status === "downloading";
  const t = statusTone(job.status);
  const tone = t === "err" ? "err" : t === "ok" || t === "accent" ? "ok" : "warn";
  const peak = Math.max(1, ...focus.list.map((j) => j.speedBps));

  return (
    <Win
      code="FN01"
      title="Transfer"
      area={area}
      className="gc"
      scroll={false}
      tone={tone}
      aria-label="Active transfer"
      onKeyDown={(e) => {
        if (focus.count < 2 || (e.target as HTMLElement).closest("input, textarea")) return;
        if (e.key === "ArrowLeft") focus.prev();
        else if (e.key === "ArrowRight") focus.next();
      }}
      sub={<>Src / {job.peerName} · {settings?.deviceName ?? "this device"}</>}
      subKeys={
        <>
          <span className={`gx-chip ${job.route === "direct" ? "on" : ""}`}>Dir</span>
          <span className={`gx-chip ${job.route === "relay" ? "warn" : ""}`}>Rly</span>
        </>
      }
      meta={`${pad(focus.index)}-${pad(focus.count)}`}
      metaTone={tone === "err" ? "red" : "mint"}
      foot={`${STATUS_TEXT[job.status]} · ${job.peerName}`}
      keys={
        <>
          {isActive(job.status) && (
            <Button size="sm" loading={busy} onClick={() => run(() => api.pauseJob(job.id))}>Pause</Button>
          )}
          {job.status === "paused" && (
            <Button size="sm" variant="primary" loading={busy} onClick={() => run(() => api.resumeJob(job.id))}>Resume</Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setPage("transfers")}>Details</Button>
        </>
      }
    >
      <div className="gc-grid">
        <SpeedTicks />
        <div className="gc-main">
          <span className={`gc-state tone-${tone}`}>{moving ? `Receiving · from ${job.peerName}` : `${STATUS_TEXT[job.status]} · ${job.peerName}`}</span>
          <span className="gc-name selectable" title={job.remotePath.join(" / ")}>{job.displayName}</span>
          {(job.status === "needs_attention" || job.status === "failed") && job.error && <span className="gc-err">{job.error}</span>}
          <LevelBars
            label="Progress"
            rows={[
              { label: checking != null ? "Chk" : "Ver", value: checking ?? verified, tone: "ok", text: `${pctShown.toFixed(1)}%`, title: "Verified" },
              { label: "Rcv", value: done, tone: tone === "err" ? "err" : "off", text: `${bytes(job.doneBytes)}`, title: "Received" },
              { label: "Spd", value: moving ? job.speedBps / peak : 0, tone: moving ? "ok" : "off", text: moving ? speed(job.speedBps) : "–", title: "Speed" },
              { label: "Blk", value: job.totalChunks ? job.verifiedChunks / job.totalChunks : 0, tone: "off", text: `${job.verifiedChunks.toLocaleString()}/${job.totalChunks.toLocaleString()}`, title: "Chunks verified" },
            ]}
          />
          <div className="gc-read">
            <span className="gc-read-lab">Time left <b className="num">({bytes(job.size)})</b></span>
            <Readout prefix="TP" value={clockOf(moving ? job.etaSecs : null)} tail={`:${pad(pctShown * 10, 3)}`} tone={tone} label={`${pctShown.toFixed(1)} percent verified`} />
          </div>
        </div>
        <PlateMenu
          label="Unfinished downloads"
          value={job.id}
          onChange={focus.pick}
          items={focus.list.map((j) => {
            const jt = statusTone(j.status);
            return {
              id: j.id,
              label: <span className="truncate">{j.displayName}</span>,
              title: `${j.displayName} · ${STATUS_TEXT[j.status]}`,
              tone: jt === "err" ? ("err" as const) : jt === "warn" ? ("warn" as const) : undefined,
            };
          })}
          footer={<button type="button" className="gm-plate" onClick={() => setPage("transfers")}>All transfers</button>}
        />
      </div>
    </Win>
  );
}

// ------------------------------------------------------------------ R4 device list

function DeviceList({ area }: { area: string }) {
  const { remotes, grants, openBrowser, settings } = useStore();
  const rows = [
    ...remotes.map((r) => ({
      key: `r-${r.peerId}`,
      name: r.name,
      dir: "in" as const,
      detail: `Shares ${r.shares.length} folder${r.shares.length === 1 ? "" : "s"} with you`,
      link: linkOf(r.status.state === "connected", r.status.route?.kind),
      rtt: r.status.route?.rttMs ?? null,
      browse: r.shares[0] ? () => openBrowser({ peerId: r.peerId, shareId: r.shares[0].id, shareName: r.shares[0].name, peerName: r.name }) : undefined,
    })),
    ...grants.map((g) => ({
      key: `g-${g.peerId}-${g.shareId}`,
      name: g.deviceName,
      dir: "out" as const,
      detail: `Can open “${g.shareName}”`,
      link: linkOf(g.connected, g.route?.kind),
      rtt: g.route?.rttMs ?? null,
      browse: undefined,
    })),
  ];
  const online = rows.filter((t) => t.link !== "offline").length;
  return (
    <Win
      code="R4"
      title="List"
      area={area}
      aria-label="Devices"
      side="Ups 360 default"
      sub={`Link / ${settings?.connectionMode === "direct_only" ? "direct only" : "direct first"}`}
      meta={rows.length ? `${pad(online)}-${pad(rows.length)}` : undefined}
      metaTone="mint"
      foot={`${online} online`}
      scroll={false}
    >
      {rows.length === 0 ? (
        <Empty icon={<Monitor size={18} />} title="No devices">Devices you connect to or share with show up here.</Empty>
      ) : (
        <div className="gt" role="table" aria-label="Devices">
          <div className="gt-head gt-dev" role="row">
            <span role="columnheader">No</span>
            <span role="columnheader">Station</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Rtt</span>
          </div>
          <Scroller label="Devices">
            {rows.map((t, i) => (
              <div key={t.key} className={`gt-row gt-dev link-${t.link}`} role="row" title={t.detail}>
                <span className="num gt-no">{pad(i + 1)}</span>
                <span className="gt-name">
                  <b className="truncate">{t.name}</b>
                  {t.browse ? (
                    <button type="button" className="gt-link" onClick={t.browse}>
                      <FolderOpen size={10} /> Browse
                    </button>
                  ) : (
                    <small>{t.dir === "in" ? "Source" : "Guest"}</small>
                  )}
                </span>
                <span className={`gt-st st-${t.link === "direct" ? "ok" : t.link === "relay" ? "warn" : "err"}`}>
                  {t.link === "direct" ? "Online" : t.link === "relay" ? "Relay" : "Offline"}
                </span>
                <span className="num gt-rtt">
                  {t.link !== "offline" && t.rtt != null ? t.rtt : "–"}
                  <SignalBars rtt={t.rtt} link={t.link} />
                </span>
              </div>
            ))}
          </Scroller>
        </div>
      )}
    </Win>
  );
}

// ------------------------------------------------------------------ H9 statistics

type StatTab = "now" | "month" | "cal";

/** The last minute as bars: receiving up from the line, sending down from it. */
function FlowBars() {
  const { samples } = useFlow();
  const last = samples.slice(-60);
  const max = Math.max(1, ...last.map((s) => Math.max(s.down, s.up)));
  return (
    <div className="gs-bars" aria-hidden="true">
      {Array.from({ length: 60 }, (_, i) => {
        const s = last[last.length - 60 + i];
        return (
          <span key={i}>
            <i className="in" style={{ height: `${s ? (s.down / max) * 100 : 0}%` }} />
            <i className="out" style={{ height: `${s ? (s.up / max) * 100 : 0}%` }} />
          </span>
        );
      })}
    </div>
  );
}

function Statistics({ area }: { area: string }) {
  const { jobs, uploads, pushes, incoming, history, setPage } = useStore();
  const [tab, setTab] = useState<StatTab>("now");
  const flowing = useFlowActive();
  const { down, up } = totalRates(jobs, uploads, pushes, incoming);
  const list = Object.values(jobs);
  const active = list.filter((j) => isActive(j.status));
  const attn = list.filter((j) => j.status === "needs_attention" || j.status === "failed").length;
  const total = active.reduce((s, j) => s + j.size, 0);
  const got = active.reduce((s, j) => s + j.verifiedBytes, 0);
  const lvl = total ? got / total : 0;

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const month = history.filter((e) => e.finishedAt >= monthStart);
  const inB = month.filter((e) => e.direction === "received").reduce((s, e) => s + e.size, 0);
  const outB = month.filter((e) => e.direction === "sent").reduce((s, e) => s + e.size, 0);
  const relay = month.reduce((s, e) => s + e.relayBytes, 0);

  return (
    <Win
      code="H9"
      title="Statistics"
      area={area}
      aria-label="Statistics"
      meta={tab === "now" ? `${pad(active.length)} / ${pad(list.length)}` : tab === "month" ? `${pad(month.length)} / ${pad(history.length)}` : "Cal"}
      metaTone={attn ? "red" : undefined}
      tabs={
        <SideTabs
          label="Statistics"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "now", label: "01", title: "Right now" },
            { id: "month", label: "02", title: "This month" },
            { id: "cal", label: "03", title: "Calendar" },
          ]}
        />
      }
      foot={tab === "now" ? "Right now" : tab === "month" ? "This month" : "Click a day to open History"}
      keys={<Button size="sm" variant="ghost" onClick={() => setPage(tab === "now" ? "transfers" : "history")}>{tab === "now" ? "Transfers" : "History"}</Button>}
    >
      {tab === "cal" ? (
        <MiniCalendar />
      ) : (
        <>
          <StatBoxes
            label={tab === "now" ? "Right now" : "This month"}
            items={
              tab === "now"
                ? [
                    { label: "Receiving", value: down > 0 ? speed(down) : "–", tone: down > 0 ? "live" : undefined },
                    { label: "Sending", value: up > 0 ? speed(up) : "–", tone: up > 0 ? "live" : undefined },
                    { label: "Active", value: active.length, of: list.length },
                    { label: "Attention", value: attn, tone: attn ? "err" : undefined },
                  ]
                : [
                    { label: "Received", value: inB ? bytes(inB) : "–", tone: inB ? "live" : undefined },
                    { label: "Sent", value: outB ? bytes(outB) : "–" },
                    { label: "Files", value: month.length },
                    { label: "Relayed", value: relay ? bytes(relay) : "None", tone: relay ? "warn" : undefined },
                  ]
            }
          />
          <FlowBars />
          <div className="gs-low">
            <div className="gs-lvl">
              <span className="gs-lvl-lab">{tab === "now" ? "Rcv lvl:" : "Rx / tx:"}</span>
              <span className="gs-lvl-track" aria-hidden="true">
                <i style={{ width: `${(tab === "now" ? lvl : inB + outB ? inB / (inB + outB) : 0) * 100}%` }} />
              </span>
            </div>
            <span className="gs-big num">
              {(tab === "now" ? lvl * 100 : inB + outB ? (inB / (inB + outB)) * 100 : 0).toFixed(1)}
              <small>%</small>
            </span>
            <span className={`gs-mode ${flowing ? "on" : ""}`}>
              [ {flowing ? "Live mode" : "Idle mode"} ] <i />
            </span>
          </div>
        </>
      )}
    </Win>
  );
}

// ------------------------------------------------------------------ H4 network report

function NetworkReport({ area }: { area: string }) {
  const { network, remotes, grants, settings, jobs, outgoing, pushes, incoming, setPage, setConnectOpen } = useStore();
  const shareFolder = useShareFolder();
  const online = !!network?.online;
  const home = relayRegion(network?.relayUrl);
  const mapOn = settings?.mapLocations !== false;
  const ipOf = useMemo(() => {
    const m = new Map<string, string>();
    if (!mapOn) return m;
    for (const r of remotes) if (r.status.state === "connected" && r.status.publicIp) m.set(r.peerId, r.status.publicIp);
    for (const g of grants) if (g.connected && g.publicIp && !m.has(g.peerId)) m.set(g.peerId, g.publicIp);
    return m;
  }, [remotes, grants, mapOn]);
  const selfIp = mapOn ? network?.publicIp : null;
  const located = useLocations([selfIp, ...ipOf.values()]);
  const selfGeo = selfIp ? located[selfIp] : undefined;
  const devices = useMemo<GlobeDevice[]>(() => {
    const m = new Map<string, GlobeDevice>();
    const add = (id: string, name: string, on: boolean) => {
      const d = m.get(id);
      if (d) d.online ||= on;
      else m.set(id, { id, name, online: on, rx: false, tx: false });
      const ip = ipOf.get(id);
      const g = ip ? located[ip] : undefined;
      if (g) Object.assign(m.get(id)!, { loc: [g.lat, g.lon] as [number, number], place: placeName(g) });
    };
    for (const r of remotes) add(r.peerId, r.name, r.status.state === "connected");
    for (const g of grants) add(g.peerId, g.deviceName, g.connected);
    const mark = (id: string, k: "rx" | "tx") => {
      const d = m.get(id);
      if (d) {
        d[k] = true;
        d.online = true;
      }
    };
    for (const j of Object.values(jobs)) if (j.status === "downloading") mark(j.peerId, "rx");
    for (const f of incoming) if (f.status === "receiving") mark(f.peerId, "rx");
    for (const o of outgoing) if (o.status === "sending") mark(o.peerId, "tx");
    for (const p of pushes) if (p.status === "uploading") mark(p.peerId, "tx");
    return [...m.values()];
  }, [remotes, grants, jobs, outgoing, pushes, incoming, ipOf, located]);
  const places = [
    ...(selfGeo ? [{ id: "self", name: settings?.deviceName || "This device", place: placeName(selfGeo) }] : []),
    ...devices.filter((d) => d.online && d.place).map((d) => ({ id: d.id, name: d.name, place: d.place! })),
  ].slice(0, 4);
  const linked = new Set([
    ...remotes.filter((r) => r.status.state === "connected").map((r) => r.peerId),
    ...grants.filter((g) => g.connected).map((g) => g.peerId),
  ]).size;
  const known = new Set([...remotes.map((r) => r.peerId), ...grants.map((g) => g.peerId)]).size;

  return (
    <Win
      code="H4"
      title="Report"
      area={area}
      className="gr"
      scroll={false}
      aria-label="Network"
      meta={online ? `${pad(linked)} / ${pad(known)}` : "Offline"}
      metaTone={online ? undefined : "red"}
      foot={`Relay ${relayHost(network?.relayUrl ?? null)}`}
      keys={<span className={`gx-chip ${online ? "on" : "err"}`}>{online ? "Online" : "Connecting"}</span>}
    >
      <div className="gr-grid">
        <PlateMenu
          label="Actions"
          value={null}
          onChange={(id) => (id === "share" ? shareFolder() : id === "code" ? setConnectOpen(true) : setPage(id === "dev" ? "devices" : "history"))}
          items={[
            { id: "share", label: "Share" },
            { id: "code", label: "Code" },
            { id: "dev", label: "Devices" },
            { id: "hist", label: "Records" },
          ]}
        />
        <div className="gr-pic">
          <span className="gr-pic-lab">Pnr</span>
          <div className="gr-globe">
            <DotGlobe
              size={132}
              online={online}
              home={home}
              label={settings?.deviceName}
              devices={devices}
              selfLoc={selfGeo ? [selfGeo.lat, selfGeo.lon] : undefined}
              selfPlace={placeName(selfGeo)}
            />
          </div>
          <span className="gr-pager num">
            <i aria-hidden="true">‹</i> {pad(linked)}/{pad(known)} <i aria-hidden="true">›</i>
          </span>
        </div>
        <div className="gr-text">
          <dl className="gr-kv">
            {places.map((p) => (
              <div key={p.id} title="Approximate, from the device's public IP address">
                <dt className="truncate">{p.name}</dt>
                <dd className="truncate">{p.place}</dd>
              </div>
            ))}
            <div>
              <dt>Home relay</dt>
              <dd>{relayHost(network?.relayUrl ?? null)}</dd>
            </div>
            <div>
              <dt>Linked</dt>
              <dd>{linked} of {known}</dd>
            </div>
            <div>
              <dt>Stored on servers</dt>
              <dd className="ok-text">0 bytes</dd>
            </div>
          </dl>
          <p className="gr-para">
            Files move directly between devices, end-to-end encrypted. Relays only forward sealed packets when routers block a direct path, and keep
            nothing.
          </p>
        </div>
      </div>
    </Win>
  );
}

// ------------------------------------------------------------------ K2 queue

function Queue({ area }: { area: string }) {
  const { jobs, outgoing, setPage } = useStore();
  const [tab, setTab] = useState<"rx" | "tx">("rx");
  const list = useMemo(() => Object.values(jobs).sort((a, b) => b.updatedAt - a.updatedAt), [jobs]);
  const rx = list.filter((j) => isActive(j.status) || j.status === "needs_attention");
  const tx = outgoing.filter((o) => o.status === "sending" || o.status === "waiting" || o.status === "paused");
  const attn = rx.filter((j) => j.status === "needs_attention").length;
  return (
    <Win
      code="K2"
      title="Queue"
      area={area}
      aria-label="Queue"
      meta={tab === "rx" ? `${pad(rx.length)} rx` : `${pad(tx.length)} tx`}
      metaTone={tab === "rx" && attn ? "red" : "mint"}
      tabs={
        <SideTabs
          label="Direction"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "rx", label: "Rx", count: rx.length, tone: attn ? "err" : undefined, title: "Receiving" },
            { id: "tx", label: "Tx", count: tx.length, title: "Sending" },
          ]}
        />
      }
      foot={tab === "rx" ? "Downloads in progress" : "Files others download from you"}
      keys={<Button size="sm" variant="ghost" onClick={() => setPage("transfers")}>All</Button>}
      scroll={false}
    >
      <Scroller label={tab === "rx" ? "Receiving" : "Sending"}>
        {tab === "rx" ? (
          rx.length === 0 ? (
            <Empty icon={<ArrowDownLeft size={18} />} title="Nothing incoming">
              {list.length > 0 ? `${list.filter((j) => j.status === "completed").length} completed.` : "Downloads you start appear here."}
            </Empty>
          ) : (
            rx.map((j) => <JobRow key={j.id} job={j} compact />)
          )
        ) : tx.length === 0 ? (
          <Empty icon={<ArrowUpRight size={18} />} title="Nothing outgoing">When someone downloads from you, it shows here.</Empty>
        ) : (
          tx.map((o) => <SendRow key={o.id} o={o} compact />)
        )}
      </Scroller>
    </Win>
  );
}

// ------------------------------------------------------------------ N7 event log

const LEVEL: Record<string, { tone: string; tag: string }> = {
  success: { tone: "ok", tag: "Done" },
  warning: { tone: "warn", tag: "Wait" },
  error: { tone: "err", tag: "Alert" },
  info: { tone: "info", tag: "Info" },
};

function EventLog({ area }: { area: string }) {
  const { activity, setPage } = useStore();
  const items = activity.slice(0, 12);
  const alerts = items.filter((a) => a.level === "error").length;
  return (
    <Win
      code="N7"
      title="Log"
      area={area}
      aria-label="Recent activity"
      meta={`${pad(items.length)}-${pad(activity.length)}`}
      metaTone={alerts ? "red" : undefined}
      foot="Newest first"
      keys={<Button size="sm" variant="ghost" onClick={() => setPage("activity")}>All</Button>}
      scroll={false}
    >
      {items.length === 0 ? (
        <Empty icon={<ArrowUpRight size={18} />} title="No activity yet" />
      ) : (
        <Scroller label="Recent activity">
          <ol className="act-rail">
            {items.map((a, i) => {
              const l = LEVEL[a.level] ?? LEVEL.info;
              return (
                <li key={a.id} className={`act-item tone-${l.tone} ${i === 0 ? "latest" : ""}`} title={a.message}>
                  <span className="act-node num" aria-hidden="true">{pad(i + 1)}</span>
                  <span className="act-tag">{l.tag}</span>
                  <span className="act-msg">{a.message}</span>
                  <span className="act-time num">{ago(a.ts)}</span>
                </li>
              );
            })}
          </ol>
        </Scroller>
      )}
    </Win>
  );
}

// ------------------------------------------------------------------ desk

function DesktopOverview() {
  return (
    <div className="desk desk-overview">
      <StorageAccessNotice />
      <TransferConsole area="1 / 1 / 7 / 6" />
      <DeviceList area="1 / 6 / 8 / 9" />
      <NetworkReport area="2 / 9 / 9 / 13" />
      <Statistics area="7 / 1 / 13 / 6" />
      <Queue area="8 / 6 / 13 / 9" />
      <EventLog area="9 / 9 / 13 / 13" />
    </div>
  );
}
