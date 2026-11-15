import { ArrowDownLeft, ArrowUpRight, Download, Monitor, Upload } from "lucide-react";
import { useMemo } from "react";
import { isActive, ago } from "../format";
import { useStore } from "../store";
import { Button, Empty, LinkReadout, linkOf, usePhone, type Link } from "../ui";
import { Win, pad } from "../glass";
import { DotGlobe, relayRegion, type GlobeDevice } from "../hud";
import { placeName, useLocations } from "../geo";
import { FocusTransfer, useFocusJob } from "../focus";
import { JobRow, SendRow } from "./Transfers";
import { useShareFolder } from "./Shares";
import { StorageAccessNotice } from "../android";
import { LiveFlow, useFlowActive } from "../flow";
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

/**
 * This device's network state. The globe marks the public relay regions and
 * which one is home. Devices sit where their public IP is (city level, looked
 * up online while Settings → Privacy → "Show devices on the map" is on); a
 * device whose address isn't known gets a made-up spot. Offline ones are
 * grey, and a live wire runs while data moves.
 */
function NetworkPanel() {
  const { network, remotes, grants, settings, jobs, outgoing, pushes, incoming } = useStore();
  const online = !!network?.online;
  const home = relayRegion(network?.relayUrl);
  const mapOn = settings?.mapLocations !== false;
  // Public IPs: from a direct path, or the one each device reported for itself.
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
    // Devices that share folders with this one, and devices using this one's folders.
    for (const r of remotes) add(r.peerId, r.name, r.status.state === "connected");
    for (const g of grants) add(g.peerId, g.deviceName, g.connected);
    const mark = (id: string, k: "rx" | "tx") => {
      const d = m.get(id);
      if (d) {
        d[k] = true;
        d.online = true;
      }
    };
    // Arriving here: downloads from it, and its uploads into this device's folders.
    for (const j of Object.values(jobs)) if (j.status === "downloading") mark(j.peerId, "rx");
    for (const f of incoming) if (f.status === "receiving") mark(f.peerId, "rx");
    // Leaving here: what it downloads from this device, and uploads into its folders.
    for (const o of outgoing) if (o.status === "sending") mark(o.peerId, "tx");
    for (const p of pushes) if (p.status === "uploading") mark(p.peerId, "tx");
    return [...m.values()];
  }, [remotes, grants, jobs, outgoing, pushes, incoming, ipOf, located]);
  // Named places for the list under the globe: this device, then connected devices.
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
      title="Network"
      meta={online ? "Online" : "Connecting"}
      metaTone={online ? "mint" : "red"}
      tone={online ? "ok" : "warn"}
      sub={`Relay / ${relayHost(network?.relayUrl ?? null)} · direct first`}
      foot={`${pad(linked)} / ${pad(known)} linked`}
      className="netp-win"
    >
    <section className="panel netp" aria-label="Network">
      <div className="netp-globe">
        <DotGlobe
          size={176}
          online={online}
          home={home}
          label={settings?.deviceName}
          devices={devices}
          selfLoc={selfGeo ? [selfGeo.lat, selfGeo.lon] : undefined}
          selfPlace={placeName(selfGeo)}
        />
      </div>
      <dl className="netp-kv">
        {places.map((p) => (
          <div key={p.id} title="Approximate, from the device's public IP address">
            <dt className="lab truncate">{p.name}</dt>
            <dd className="num truncate">{p.place}</dd>
          </div>
        ))}
        <div>
          <dt className="lab">Home relay</dt>
          <dd className="num">{relayHost(network?.relayUrl ?? null)}</dd>
        </div>
        <div>
          <dt className="lab">Devices linked</dt>
          <dd className="num">{linked} of {known}</dd>
        </div>
        <div>
          <dt className="lab">Stored on servers</dt>
          <dd className="num red-text">0 bytes</dd>
        </div>
      </dl>
    </section>
    </Win>
  );
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


function DevicesPanel() {
  const { remotes, grants, openBrowser } = useStore();
  const tiles = [
    ...remotes.slice(0, 4).map((r) => ({
      key: `r-${r.peerId}`,
      name: r.name,
      dir: "in" as const,
      detail: `Shares ${r.shares.length} folder${r.shares.length === 1 ? "" : "s"} with you`,
      link: linkOf(r.status.state === "connected", r.status.route?.kind),
      rtt: r.status.route?.rttMs ?? null,
      action: r.shares[0] ? (
        <Button size="sm" onClick={() => openBrowser({ peerId: r.peerId, shareId: r.shares[0].id, shareName: r.shares[0].name, peerName: r.name })}>
          Browse
        </Button>
      ) : undefined,
    })),
    ...grants.slice(0, 4).map((g) => ({
      key: `g-${g.peerId}-${g.shareId}`,
      name: g.deviceName,
      dir: "out" as const,
      detail: `Can open “${g.shareName}”`,
      link: linkOf(g.connected, g.route?.kind),
      rtt: g.route?.rttMs ?? null,
      action: undefined,
    })),
  ];
  const online = tiles.filter((t) => t.link !== "offline").length;
  return (
    <Win
      code="R4"
      title="Devices"
      meta={`${pad(online)}-${pad(tiles.length)}`}
      metaTone="mint"
      sub="Link / direct first"
      foot={`${online} online`}
    >
      <div className="panel dev-list flat">
        {tiles.length === 0 ? (
          <Empty icon={<Monitor size={20} />} title="No devices yet">Devices you connect to or share with show up here.</Empty>
        ) : (
          tiles.map(({ key, ...t }) => <DeviceTile key={key} {...t} />)
        )}
      </div>
    </Win>
  );
}

const LEVEL: Record<string, { tone: string; tag: string }> = {
  success: { tone: "ok", tag: "Done" },
  warning: { tone: "warn", tag: "Wait" },
  error: { tone: "err", tag: "Alert" },
  info: { tone: "info", tag: "Info" },
};

/** Recent events as a timeline: a node per event on a rail, newest first. */
function ActivityPanel() {
  const { activity, setPage } = useStore();
  const items = activity.slice(0, 6);
  return (
    <Win
      code="N7"
      title="Recent activity"
      meta={`${pad(items.length)} / ${pad(activity.length)}`}
      metaTone={items.some((a) => a.level === "error") ? "red" : undefined}
      foot="Newest first"
      keys={<Button size="sm" variant="ghost" onClick={() => setPage("activity")}>View all</Button>}
    >
      <div className="panel act-list">
        {items.length === 0 ? (
          <Empty icon={<ArrowUpRight size={20} />} title="No activity yet" />
        ) : (
          <ol className="act-rail">
            {items.map((a, i) => {
              const l = LEVEL[a.level] ?? LEVEL.info;
              return (
                <li key={a.id} className={`act-item tone-${l.tone} ${i === 0 ? "latest" : ""}`}>
                  <span className="act-node" aria-hidden="true" />
                  <span className="act-tag">{l.tag}</span>
                  <span className="act-msg">{a.message}</span>
                  <span className="act-time num">{ago(a.ts)}</span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </Win>
  );
}

function DesktopOverview() {
  const { jobs, uploads, outgoing, setPage, setConnectOpen } = useStore();
  const sendingNow = outgoing.filter((o) => o.status === "sending" || o.status === "waiting" || o.status === "paused");
  const shareFolder = useShareFolder();
  const list = useMemo(() => Object.values(jobs).sort((a, b) => b.updatedAt - a.updatedAt), [jobs]);
  const active = list.filter((j) => isActive(j.status) || j.status === "needs_attention");
  const down = list.filter((j) => j.status === "downloading").reduce((s, j) => s + j.speedBps, 0);
  const up = uploads.reduce((s, u) => s + u.bps, 0);
  const flowActive = useFlowActive();
  const focus = useFocusJob();

  return (
    <div className="page">
      <StorageAccessNotice />
      <div className="hud-top">
        {focus.job ? (
          <FocusTransfer job={focus.job} index={focus.index} count={focus.count} onPrev={focus.prev} onNext={focus.next} />
        ) : (
          <Win code="FN01" title="Console" meta="00-00" metaTone="mint" sub="Mode / standby · no transfer running" foot="Select a function" className="hero-win">
          <div className="hero-actions stacked">
            <button className="hero-tile" onClick={shareFolder}>
              <span className="ico"><Upload size={22} /></span>
              <span className="stack">
                <span className="t">Send</span>
                <span className="d">Share a folder and invite someone to download from it.</span>
              </span>
            </button>
            <button className="hero-tile" onClick={() => setConnectOpen(true)}>
              <span className="ico"><Download size={22} /></span>
              <span className="stack">
                <span className="t">Receive</span>
                <span className="d">Open an invitation or short code someone sent you.</span>
              </span>
            </button>
          </div>
          </Win>
        )}
        <NetworkPanel />
      </div>

      {(flowActive || down > 0 || up > 0) && <LiveFlow />}

      {sendingNow.length > 0 && (
        <Win
          code="K1"
          title="Send"
          meta={`${pad(Math.min(5, sendingNow.length))} / ${pad(sendingNow.length)}`}
          metaTone="mint"
          foot="Uploads to devices"
          keys={
            <Button size="sm" variant="ghost" onClick={() => setPage("transfers")} icon={<ArrowUpRight size={14} />}>
              All transfers
            </Button>
          }
        >
          <div className="panel">
            {sendingNow.slice(0, 5).map((o) => (
              <SendRow key={o.id} o={o} compact />
            ))}
          </div>
        </Win>
      )}

      <Win
        code="K2"
        title="Receive"
        meta={`${pad(Math.min(5, active.length))} / ${pad(active.length)}`}
        metaTone={active.some((j) => j.status === "needs_attention") ? "red" : "mint"}
        foot="Downloads to this device"
        keys={
          <Button size="sm" variant="ghost" onClick={() => setPage("transfers")} icon={<ArrowUpRight size={14} />}>
            All transfers
          </Button>
        }
      >
        {active.length === 0 ? (
          <div className="panel">
            <Empty icon={<ArrowUpRight size={20} />} title="Nothing being received">
              {list.length > 0 ? `${list.filter((j) => j.status === "completed").length} completed transfer(s).` : "Downloads you start appear here with live progress."}
            </Empty>
          </div>
        ) : (
          <div className="panel">
            {active.slice(0, 5).map((j) => (
              <JobRow key={j.id} job={j} compact />
            ))}
          </div>
        )}
      </Win>

      <div className="two-col even">
        <DevicesPanel />
        <ActivityPanel />
      </div>
    </div>
  );
}
