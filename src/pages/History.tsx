import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Copy, History as HistoryIcon, Lock, Waypoints, Zap } from "lucide-react";
import type { HistoryEntry } from "../api";
import { CATEGORIES, categoryInfo, categoryOf, type Category } from "../categories";
import { SERIES } from "../flow";
import { bytes, duration, speed } from "../format";
import { useStore } from "../store";
import { Button, Empty, HudStrip, IconButton, SafetyWords, SectionHeader, Segmented, usePhone } from "../ui";

export type Dir = "both" | "received" | "sent";

const DAY = 86_400_000;

function dayKey(ms: number) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function weekStart(): number {
  try {
    // 1 = Monday ... 7 = Sunday
    const info = (new Intl.Locale(navigator.language) as unknown as { weekInfo?: { firstDay: number }; getWeekInfo?: () => { firstDay: number } });
    const first = info.getWeekInfo?.().firstDay ?? info.weekInfo?.firstDay ?? 1;
    return first % 7;
  } catch {
    return 1;
  }
}

const RETENTION_TEXT: Record<string, string> = {
  forever: "until you clear it",
  "365": "for 1 year",
  "90": "for 90 days",
  "30": "for 30 days",
  off: "",
};

function moved(e: HistoryEntry) {
  return e.size;
}

function sum(list: HistoryEntry[], dir?: "received" | "sent") {
  return list.filter((e) => !dir || e.direction === dir).reduce((a, e) => a + moved(e), 0);
}

function fileLabel(e: HistoryEntry) {
  return e.name || categoryInfo(categoryOf(e.ext)).noun + (e.ext ? ` (.${e.ext})` : "");
}

function fmtDay(ms: number, opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" }) {
  return new Date(ms).toLocaleDateString(undefined, opts);
}

function fmtTime(ms: number) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// ---------------------------------------------------------------- receipt

function receiptText(e: HistoryEntry) {
  const total = e.directBytes + e.relayBytes || e.size;
  const route =
    e.relayBytes === 0
      ? "Direct, device to device (100%)"
      : `${bytes(e.directBytes)} direct, ${bytes(e.relayBytes)} through a relay (end-to-end encrypted)`;
  return [
    `Bifrost privacy receipt`,
    `File: ${fileLabel(e)} (${bytes(e.size)})`,
    `${e.direction === "received" ? "From" : "To"}: ${e.peerName}`,
    `Safety words: ${e.safetyWords.join(" ")}`,
    `Route: ${route}`,
    `Encryption: QUIC with TLS 1.3; keys exist only on the two devices`,
    `Verified: ${e.blocks.toLocaleString()} blocks of 1 MiB with BLAKE3, then the whole file`,
    `Fingerprint: ${e.fingerprint}`,
    `Copies on servers: none`,
    `Finished: ${new Date(e.finishedAt).toLocaleString()}`,
    `Active time: ${duration(e.activeMs / 1000)}, average ${speed(e.activeMs ? total / (e.activeMs / 1000) : 0)}, peak ${speed(e.peakBps)}`,
  ].join("\n");
}

function Receipt({ e }: { e: HistoryEntry }) {
  const [copied, setCopied] = useState(false);
  const total = e.directBytes + e.relayBytes || e.size;
  const avg = e.activeMs ? total / (e.activeMs / 1000) : 0;
  const directShare = total ? e.directBytes / total : 1;
  const fp = e.fingerprint.slice(0, 32).match(/.{1,4}/g) ?? [];
  return (
    <div className="receipt">
      <dl className="receipt-kv">
        <dt>Route</dt>
        <dd>
          {e.relayBytes === 0 ? (
            <span className="ok-text"><Zap size={13} aria-hidden="true" /> Direct, device to device</span>
          ) : (
            <span>
              <Waypoints size={13} aria-hidden="true" className="warn-text" /> {bytes(e.directBytes)} direct and {bytes(e.relayBytes)} through a relay.
              The relay only forwarded encrypted packets it could not read.
            </span>
          )}
          <span className="route-meter" aria-hidden="true">
            <span style={{ width: `${directShare * 100}%` }} />
          </span>
        </dd>
        <dt>Encryption</dt>
        <dd>QUIC with TLS 1.3. The keys exist only on the two devices.</dd>
        <dt>Verified</dt>
        <dd>
          {e.blocks.toLocaleString()} block{e.blocks === 1 ? "" : "s"} of 1 MiB, each checked with BLAKE3 on arrival, then the whole file again before it was saved.
        </dd>
        <dt>Fingerprint</dt>
        <dd>
          <span className="mono selectable fp" title={e.fingerprint}>{fp.join(" ")}</span>
          <span className="hint">The same on both devices for the same file.</span>
        </dd>
        <dt>{e.direction === "received" ? "Sender" : "Receiver"}</dt>
        <dd className="receipt-peer">
          <span>{e.peerName}</span>
        </dd>
        {e.safetyWords.length > 0 && (
          <>
            <dt>Safety words</dt>
            <dd>
              <SafetyWords words={e.safetyWords} compact />
              <span className="hint">{e.peerName} shows the same five words. Same words on both screens means nobody was in between.</span>
            </dd>
          </>
        )}
        <dt>On servers</dt>
        <dd>Nothing. No account, no upload, no copy anywhere but the two devices.</dd>
        <dt>Timing</dt>
        <dd className="num">
          {duration(e.activeMs / 1000)} of transfer time, averaging {speed(avg)}, peak {speed(e.peakBps)}
        </dd>
      </dl>
      <div className="receipt-foot">
        <span className="hint">This receipt lives only in this device's history.</span>
        <Button
          size="sm"
          icon={copied ? <Check size={14} /> : <Copy size={14} />}
          onClick={async () => {
            await navigator.clipboard.writeText(receiptText(e));
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
          }}
        >
          {copied ? "Copied" : "Copy receipt"}
        </Button>
      </div>
    </div>
  );
}

function ReceiptRow({ e, open, onToggle }: { e: HistoryEntry; open: boolean; onToggle: () => void }) {
  const cat = categoryInfo(categoryOf(e.ext));
  const Icon = cat.icon;
  const relayed = e.relayBytes > 0;
  return (
    <div className={`hrow ${open ? "open" : ""}`}>
      <button className="hrow-main" onClick={onToggle} aria-expanded={open}>
        <span className={`hrow-ico ${e.direction}`} aria-hidden="true"><Icon size={16} /></span>
        <span className="stack grow" style={{ minWidth: 0 }}>
          <span className={`truncate ${e.name ? "" : "muted"}`}>{fileLabel(e)}</span>
          <span className="small faint hrow-meta">
            {e.direction === "received" ? `From ${e.peerName}` : `To ${e.peerName}`}, {fmtDay(e.finishedAt, { month: "short", day: "numeric" })} at {fmtTime(e.finishedAt)}
          </span>
        </span>
        <span className="num hrow-size">{bytes(e.size)}</span>
        <span className={`hrow-route ${relayed ? "relay" : ""}`} aria-label={relayed ? "Partly relayed, encrypted" : "Direct"} title={relayed ? "Partly relayed, encrypted" : "Direct"}>
          {relayed ? <Waypoints size={12} aria-hidden="true" /> : <Zap size={12} aria-hidden="true" />}
          <span className="hrow-route-text">{relayed ? "Partly relayed" : "Direct"}</span>
        </span>
        <ChevronDown size={16} className="hrow-chev" aria-hidden="true" />
      </button>
      {open && <Receipt e={e} />}
    </div>
  );
}

// ---------------------------------------------------------------- calendar

/**
 * One day's mark: the day fills up from the bottom like a gauge, received
 * first and sent on top, to the share of the busiest day. The fill is drawn
 * as fine scan lines with a bright edge on each level, so the cell's number
 * and amount stay readable over it. A day with very little still gets a
 * hairline, so it never looks empty.
 */
export function DayLevel({ inB, outB, max, i = 0, className = "" }: { inB: number; outB: number; max: number; i?: number; className?: string }) {
  const f = (b: number) => (max > 0 && b > 0 ? Math.min(1, b / max) : 0);
  return (
    <span
      className={`day-level ${className}`}
      aria-hidden="true"
      style={{ ["--in" as string]: f(inB), ["--out" as string]: f(outB), ["--i" as string]: i } as React.CSSProperties}
    >
      {inB > 0 && <i className="lv-in" />}
      {outB > 0 && <i className="lv-out" />}
    </span>
  );
}
/** A share as a whole percent, "<1%" for slivers. */
function share(part: number, total: number) {
  const p = total > 0 ? part / total : 0;
  return p > 0 && p < 0.01 ? "<1%" : `${Math.round(p * 100)}%`;
}

/** A row's received and sent amounts, each with its arrow and colour. */
function SplitVals({ inB, outB }: { inB: number; outB: number }) {
  return (
    <span className="who-vals num">
      {inB > 0 && <span className="who-in" aria-label={`${bytes(inB)} received`}>↓ {bytes(inB)}</span>}
      {outB > 0 && <span className="who-out" aria-label={`${bytes(outB)} sent`}>↑ {bytes(outB)}</span>}
    </span>
  );
}

/**
 * The side lists' meter: the grey ticks are the whole period, the fill is
 * this row's share of it (the same number as the percent beside it), split
 * into received then sent. A sliver still shows as one tick.
 */
function SplitMeter({ inB, outB, max }: { inB: number; outB: number; max: number }) {
  const total = inB + outB;
  const w = max > 0 ? Math.min(1, total / max) : 0;
  const a = total > 0 ? inB / total : 0;
  return (
    <span
      className={`smeter ${outB > 0 && inB > 0 ? "split" : ""}`}
      aria-hidden="true"
      style={{ ["--w" as string]: w, ["--a" as string]: a } as React.CSSProperties}
    >
      <span className="smeter-fill">
        {inB > 0 && <span className="smeter-in" />}
        {outB > 0 && <span className="smeter-out" />}
      </span>
    </span>
  );
}

/**
 * The hover card shared by the calendar and the side lists: a title, the
 * total, the received / sent split, the largest files and a footnote.
 */
function EntriesTip({
  x,
  y,
  below,
  title,
  entries,
  inB,
  outB,
  split,
  foot,
}: {
  x: number;
  y: number;
  below: boolean;
  title: string;
  entries: HistoryEntry[];
  inB: number;
  outB: number;
  split: boolean;
  foot?: string;
}) {
  return (
    <div className={`cal-tip ${below ? "below" : ""}`} style={{ left: x, top: y }} role="tooltip">
      <span className="tip-title">{title}</span>
      <span className="small muted">
        {bytes(inB + outB)} in {entries.length} transfer{entries.length === 1 ? "" : "s"}
      </span>
      {split && (
        <span className="tip-split">
          <span className="tip-row"><i style={{ background: SERIES.in }} />Received<b className="num">{bytes(inB)}</b></span>
          <span className="tip-row"><i style={{ background: SERIES.out }} />Sent<b className="num">{bytes(outB)}</b></span>
        </span>
      )}
      <span className="tip-files">
        {[...entries]
          .sort((a, b) => b.size - a.size)
          .slice(0, 3)
          .map((e) => (
            <span key={e.id} className="tip-file">
              <span className="truncate">{fileLabel(e)}</span>
              <span className="num faint">{bytes(e.size)}</span>
            </span>
          ))}
        {entries.length > 3 && <span className="faint small">and {entries.length - 3} more</span>}
      </span>
      {foot && <span className="small faint truncate">{foot}</span>}
    </div>
  );
}

interface DayAgg {
  key: string;
  date: Date;
  total: number;
  inBytes: number;
  outBytes: number;
  entries: HistoryEntry[];
}

function MonthCalendar({
  month,
  days,
  max,
  dir,
  selected,
  onSelect,
}: {
  month: Date;
  days: Map<string, DayAgg>;
  max: number;
  dir: Dir;
  selected: string | null;
  onSelect: (k: string | null) => void;
}) {
  const phone = usePhone();
  const first = weekStart();
  const [hover, setHover] = useState<{ key: string; x: number; y: number; below: boolean } | null>(null);
  const grid = useRef<HTMLDivElement>(null);

  const cells = useMemo(() => {
    const y = month.getFullYear();
    const m = month.getMonth();
    const lead = (new Date(y, m, 1).getDay() - first + 7) % 7;
    const count = new Date(y, m + 1, 0).getDate();
    const out: (Date | null)[] = Array.from({ length: lead }, () => null);
    for (let d = 1; d <= count; d++) out.push(new Date(y, m, d));
    while (out.length % 7) out.push(null);
    return out;
  }, [month, first]);

  const weekdays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => new Date(2023, 0, 1 + ((first + i) % 7)).toLocaleDateString(undefined, { weekday: phone ? "narrow" : "short" })),
    [first, phone],
  );
  const todayKey = dayKey(Date.now());
  const showTip = (key: string, el: HTMLElement) => {
    const g = grid.current?.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (!g) return;
    const top = r.top - g.top;
    // Open below the day when there isn't room above it.
    const below = top < 190;
    const x = Math.min(Math.max(r.left - g.left + r.width / 2, 126), g.width - 126);
    setHover({ key, x, y: below ? top + r.height : top, below });
  };
  const tip = hover ? days.get(hover.key) : null;

  return (
    <div className="cal" ref={grid} onPointerLeave={() => setHover(null)}>
      <div className="cal-grid" key={`${month.getTime()}-${dir}`} role="grid" aria-label={month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}>
        <div className="cal-row cal-wd" role="row">
          {weekdays.map((w, i) => (
            <span key={i} role="columnheader" className="cal-wdn">{w}</span>
          ))}
        </div>
        {Array.from({ length: cells.length / 7 }, (_, r) => (
          <div className="cal-row" role="row" key={r}>
            {cells.slice(r * 7, r * 7 + 7).map((d, i) => {
              if (!d) return <span key={i} className="cal-day blank" role="gridcell" />;
              const k = dayKey(d.getTime());
              const a = days.get(k);
              const total = a?.total ?? 0;
              const future = d.getTime() > Date.now();
              const label = `${d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}: ${total ? `${bytes(total)} in ${a!.entries.length} transfer${a!.entries.length === 1 ? "" : "s"}` : "nothing moved"}`;
              return (
                <button
                  key={i}
                  role="gridcell"
                  className={`cal-day ${k === todayKey ? "today" : ""} ${k === selected ? "sel" : ""} ${future ? "future" : ""} ${total ? "has" : ""}`}
                  aria-label={label}
                  aria-pressed={k === selected}
                  disabled={!total && k !== selected}
                  onClick={() => onSelect(k === selected ? null : k)}
                  onPointerEnter={(e) => total && e.pointerType === "mouse" && showTip(k, e.currentTarget)}
                  onFocus={(e) => total && showTip(k, e.currentTarget)}
                  onBlur={() => setHover(null)}
                >
                  {total > 0 && <DayLevel i={r * 7 + i} inB={a!.inBytes} outB={a!.outBytes} max={max} />}
                  <span className="cal-num num">{d.getDate()}</span>
                  {total > 0 && <span className="cal-amt num">{bytes(total)}</span>}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {max > 0 && (
        <div className="cal-scale" aria-hidden="true">
          <span className="cal-keys">
            {dir !== "sent" && <span className="cal-key in"><i />Received</span>}
            {dir !== "received" && <span className="cal-key out"><i />Sent</span>}
          </span>
          <span className="cal-scale-note small">
            <span className="cal-gauge" aria-hidden="true"><i /></span>
            <span>
              A full day is <b className="num">{bytes(max)}</b>, your busiest
            </span>
          </span>
        </div>
      )}
      {tip && hover && (
        <EntriesTip
          x={hover.x}
          y={hover.y}
          below={hover.below}
          title={fmtDay(tip.date.getTime(), { weekday: "long", month: "short", day: "numeric" })}
          entries={tip.entries}
          inB={tip.inBytes}
          outB={tip.outBytes}
          split={dir === "both"}
          foot={`With ${Array.from(new Set(tip.entries.map((e) => e.peerName))).join(", ")}`}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- page

export default function History() {
  const { history, settings, setPage } = useStore();
  const [dir, setDir] = useState<Dir>("both");
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [limit, setLimit] = useState(40);

  useEffect(() => {
    setSelected(null);
    setLimit(40);
  }, [month, dir]);

  const filtered = useMemo(() => (dir === "both" ? history : history.filter((e) => e.direction === dir)), [history, dir]);

  // Per-day totals across all history, so dot sizes compare between months.
  const { days, max } = useMemo(() => {
    const days = new Map<string, DayAgg>();
    for (const e of filtered) {
      const k = dayKey(e.finishedAt);
      let a = days.get(k);
      if (!a) {
        const d = new Date(e.finishedAt);
        a = { key: k, date: new Date(d.getFullYear(), d.getMonth(), d.getDate()), total: 0, inBytes: 0, outBytes: 0, entries: [] };
        days.set(k, a);
      }
      a.total += moved(e);
      if (e.direction === "received") a.inBytes += moved(e);
      else a.outBytes += moved(e);
      a.entries.push(e);
    }
    let max = 0;
    days.forEach((a) => (max = Math.max(max, a.total)));
    return { days, max };
  }, [filtered]);

  const monthStart = month.getTime();
  const monthEnd = new Date(month.getFullYear(), month.getMonth() + 1, 1).getTime();
  const inMonth = useMemo(() => filtered.filter((e) => e.finishedAt >= monthStart && e.finishedAt < monthEnd), [filtered, monthStart, monthEnd]);
  const scope = selected ? days.get(selected)?.entries ?? [] : inMonth;
  const scopeAll = useMemo(
    () => (selected ? history.filter((e) => dayKey(e.finishedAt) === selected) : history.filter((e) => e.finishedAt >= monthStart && e.finishedAt < monthEnd)),
    [history, selected, monthStart, monthEnd],
  );

  // With whom: per device, both directions (the bar shows the split).
  const pairs = useMemo(() => {
    const m = new Map<string, { id: string; name: string; inB: number; outB: number; n: number; words: string[]; entries: HistoryEntry[] }>();
    for (const e of scopeAll) {
      if (dir !== "both" && e.direction !== dir) continue;
      const p = m.get(e.peerId) ?? { id: e.peerId, name: e.peerName, inB: 0, outB: 0, n: 0, words: e.safetyWords, entries: [] as HistoryEntry[] };
      if (e.direction === "received") p.inB += e.size;
      else p.outB += e.size;
      p.n++;
      p.entries.push(e);
      p.name = e.peerName;
      m.set(e.peerId, p);
    }
    return [...m.values()].sort((a, b) => b.inB + b.outB - (a.inB + a.outB));
  }, [scopeAll, dir]);
  const pairTotal = pairs.reduce((a, p) => a + p.inB + p.outB, 0) || 1;

  const cats = useMemo(() => {
    const m = new Map<Category, { b: number; n: number; inB: number; outB: number; entries: HistoryEntry[] }>();
    for (const e of scope) {
      const c = categoryOf(e.ext);
      const v = m.get(c) ?? { b: 0, n: 0, inB: 0, outB: 0, entries: [] as HistoryEntry[] };
      v.b += e.size;
      if (e.direction === "received") v.inB += e.size;
      else v.outB += e.size;
      v.n++;
      v.entries.push(e);
      m.set(c, v);
    }
    return CATEGORIES.filter((c) => m.has(c.id))
      .map((c) => ({ ...c, ...m.get(c.id)! }))
      .sort((a, b) => b.b - a.b);
  }, [scope]);
  const catTotal = cats.reduce((a, c) => a + c.b, 0) || 1;

  // Hover cards on the side lists, placed like the calendar's: centred on
  // the card, above the row, or below it when there isn't room above.
  const whoRef = useRef<HTMLElement>(null);
  const whatRef = useRef<HTMLElement>(null);
  const [sideTip, setSideTip] = useState<{ list: "who" | "what"; id: string; x: number; y: number; below: boolean } | null>(null);
  const showSideTip = (list: "who" | "what", id: string, el: HTMLElement) => {
    const host = (list === "who" ? whoRef : whatRef).current?.getBoundingClientRect();
    if (!host) return;
    const r = el.getBoundingClientRect();
    const below = r.top < 230;
    const x = Math.min(Math.max(r.left - host.left + r.width / 2, 126), host.width - 126);
    setSideTip({ list, id, x, y: below ? r.bottom - host.top : r.top - host.top, below });
  };
  const rowTip = (list: "who" | "what", id: string) => ({
    tabIndex: 0,
    onPointerEnter: (e: React.PointerEvent<HTMLElement>) => e.pointerType === "mouse" && showSideTip(list, id, e.currentTarget),
    onFocus: (e: React.FocusEvent<HTMLElement>) => showSideTip(list, id, e.currentTarget),
    onBlur: () => setSideTip(null),
  });
  useEffect(() => setSideTip(null), [selected, month, dir]);
  const tipPair = sideTip?.list === "who" ? pairs.find((p) => p.id === sideTip.id) : undefined;
  const tipCat = sideTip?.list === "what" ? cats.find((c) => c.id === sideTip.id) : undefined;

  const receipts = useMemo(() => [...scope].sort((a, b) => b.finishedAt - a.finishedAt), [scope]);

  const now = new Date();
  const isCurrent = month.getFullYear() === now.getFullYear() && month.getMonth() === now.getMonth();
  const earliest = history.length ? Math.min(...history.map((e) => e.finishedAt)) : Date.now();
  const canBack = monthStart > earliest - 31 * DAY;
  const monthName = month.toLocaleDateString(undefined, { month: "long", year: month.getFullYear() === now.getFullYear() ? undefined : "numeric" });
  const shift = (n: number) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1));

  const historyOff = settings?.historyRetention === "off";

  // The plain-language summary of the period.
  const inB = sum(scopeAll, "received");
  const outB = sum(scopeAll, "sent");
  const relay = scopeAll.reduce((a, e) => a + e.relayBytes, 0);
  const files = scopeAll.length;
  const when = selected ? `On ${fmtDay(days.get(selected)!.date.getTime(), { weekday: "long", month: "long", day: "numeric" })}` : isCurrent ? "This month" : `In ${monthName}`;

  const summary =
    files === 0 ? (
      <>
        {when}, nothing {dir === "sent" ? "was sent" : dir === "received" ? "was received" : "moved"}.
        {history.length === 0 && " Finished transfers show up here, with a privacy receipt for each one."}
      </>
    ) : relay === 0 ? (
      <>{when}: every byte went directly between devices and was verified block by block.</>
    ) : (
      <>{when}: {bytes(relay)} went through a relay, encrypted end to end so the relay couldn't read it. The rest went directly.</>
    );

  return (
    <div className="page history">
      <HudStrip
        label="History summary"
        stats={[
          { label: "Received", value: inB > 0 ? bytes(inB) : "–", tone: inB > 0 ? "live" : undefined },
          { label: "Sent", value: outB > 0 ? bytes(outB) : "–" },
          { label: "Files", value: files.toLocaleString() },
          { label: "Through a relay", value: relay > 0 ? bytes(relay) : "None", tone: relay > 0 ? "warn" : undefined },
        ]}
        note={summary}
        action={
          selected ? (
            <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>
              Show all of {monthName}
            </Button>
          ) : undefined
        }
      />
      {historyOff && (
        <div className="notice">
          <Lock size={16} />
          <span>
            History is off, so finished transfers aren't recorded on this device.{" "}
            <button className="link" onClick={() => setPage("settings")}>Turn it on in Settings</button>
          </span>
        </div>
      )}
      <div className="history-top">
        <section className="panel cal-panel" aria-label="Calendar">
          <div className="cal-head">
            <IconButton label="Previous month" onClick={() => shift(-1)} disabled={!canBack}>
              <ChevronLeft size={18} />
            </IconButton>
            <h2 className="cal-title">{monthName}</h2>
            <IconButton label="Next month" onClick={() => shift(1)} disabled={isCurrent}>
              <ChevronRight size={18} />
            </IconButton>
            {!isCurrent && (
              <Button size="sm" variant="ghost" onClick={() => setMonth(new Date(now.getFullYear(), now.getMonth(), 1))}>
                Today
              </Button>
            )}
            <span className="spacer" />
            <Segmented
              label="Direction"
              value={dir}
              onChange={setDir}
              options={[
                { value: "both", label: "Both" },
                { value: "received", label: "Received" },
                { value: "sent", label: "Sent" },
              ]}
            />
          </div>
          <MonthCalendar month={month} days={days} max={max} dir={dir} selected={selected} onSelect={setSelected} />
        </section>

        <aside className="history-side">
          <section className="side-block hud-side" aria-label="With whom" ref={whoRef} onPointerLeave={() => setSideTip(null)}>
            <div className="side-head">
              <h3>
                With whom
                {pairs.length > 0 && <span className="side-count num">{String(pairs.length).padStart(2, "0")}</span>}
              </h3>
              {dir === "both" && pairs.length > 0 && (
                <span className="side-legend">
                  <span><i style={{ background: SERIES.in }} />Received</span>
                  <span><i style={{ background: SERIES.out }} />Sent</span>
                </span>
              )}
            </div>
            {pairs.length === 0 ? (
              <span className="small faint">No devices in this period.</span>
            ) : (
              <div className="who-list">
                {pairs.map((p, k) => (
                  <div className="who" key={p.id} {...rowTip("who", p.id)}>
                    <span className="who-idx num" aria-hidden="true">{String(k + 1).padStart(2, "0")}</span>
                    <span className="who-top">
                    <span className="who-name truncate">{p.name}</span>
                    <SplitVals inB={p.inB} outB={p.outB} />
                    </span>
                    <SplitMeter inB={p.inB} outB={p.outB} max={pairTotal} />
                    <span className="who-pct num">{share(p.inB + p.outB, pairTotal)}</span>
                  </div>
                ))}
              </div>
            )}
            {tipPair && sideTip && (
              <EntriesTip
                x={sideTip.x}
                y={sideTip.y}
                below={sideTip.below}
                title={tipPair.name}
                entries={tipPair.entries}
                inB={tipPair.inB}
                outB={tipPair.outB}
                split={tipPair.inB > 0 && tipPair.outB > 0}
                foot={tipPair.words.length ? `Safety words: ${tipPair.words.join(" ")}` : undefined}
              />
            )}
          </section>

          <section className="side-block hud-side" aria-label="What moved" ref={whatRef} onPointerLeave={() => setSideTip(null)}>
            <div className="side-head">
              <h3>
                What
                {cats.length > 0 && <span className="side-count num">{String(cats.length).padStart(2, "0")}</span>}
              </h3>
              {cats.length > 0 && <span className="side-sum num">{bytes(catTotal)} · {scope.length} file{scope.length === 1 ? "" : "s"}</span>}
            </div>
            {cats.length === 0 ? (
              <span className="small faint">No files in this period.</span>
            ) : (
              <div className="what-list">
                {cats.map((c) => {
                  const Icon = c.icon;
                  return (
                    <div className="what" key={c.id} {...rowTip("what", c.id)}>
                      <span className="what-ico" aria-hidden="true"><Icon size={14} /></span>
                      <span className="who-top">
                        <span className="what-name truncate">{c.label}</span>
                        <SplitVals inB={c.inB} outB={c.outB} />
                      </span>
                      <SplitMeter inB={c.inB} outB={c.outB} max={catTotal} />
                      <span className="who-pct num">{share(c.b, catTotal)}</span>
                    </div>
                  );
                })}
              </div>
            )}
            {tipCat && sideTip && (
              <EntriesTip
                x={sideTip.x}
                y={sideTip.y}
                below={sideTip.below}
                title={tipCat.label}
                entries={tipCat.entries}
                inB={tipCat.inB}
                outB={tipCat.outB}
                split={tipCat.inB > 0 && tipCat.outB > 0}
                foot={`With ${Array.from(new Set(tipCat.entries.map((e) => e.peerName))).join(", ")}`}
              />
            )}
          </section>
        </aside>

        <section className="history-receipts" aria-label="Receipts">
          <SectionHeader title="Receipts">
            {receipts.length > 0 && <span className="sec-stat num">{receipts.length} in {selected ? "this day" : "this month"}</span>}
          </SectionHeader>
          <div className="panel">
            {receipts.length === 0 ? (
              <Empty icon={<HistoryIcon size={20} />} title={history.length === 0 ? "No finished transfers yet" : "Nothing in this period"}>
                {history.length === 0
                  ? "Each finished transfer gets a privacy receipt here: the route it took, how it was encrypted and verified, and what servers kept (nothing)."
                  : "Pick another month or day on the calendar."}
              </Empty>
            ) : (
              <>
                {receipts.slice(0, limit).map((e) => (
                  <ReceiptRow key={e.id} e={e} open={open === e.id} onToggle={() => setOpen(open === e.id ? null : e.id)} />
                ))}
                {receipts.length > limit && (
                  <div className="more">
                    <Button size="sm" variant="ghost" onClick={() => setLimit((l) => l + 40)}>
                      Show {Math.min(40, receipts.length - limit)} more
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </section>
      </div>

      {!historyOff && (
        <p className="history-foot small faint">
          <Lock size={13} aria-hidden="true" />
          History stays on this device and is kept {RETENTION_TEXT[settings?.historyRetention ?? "365"]}. Nothing here is ever uploaded.{" "}
          <button className="link" onClick={() => setPage("settings")}>Privacy settings</button>
        </p>
      )}
    </div>
  );
}
