/**
 * Glass HUD toolkit, after the teal reference board: small translucent
 * windows that float on the striped ground, each one an instrument (a menu
 * column of keys, a list, statistic boxes, a report). Decorative parts are
 * aria-hidden; everything interactive is a real button.
 */
import { useEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode, type Ref } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";

export const pad = (n: number, w = 2) => String(Math.max(0, Math.floor(n))).padStart(w, "0");

// ------------------------------------------------------------------ window

type WinProps = Omit<HTMLAttributes<HTMLElement>, "title"> & {
  /** Short code on the header plate, e.g. "FN03". */
  code: string;
  title: ReactNode;
  /** Thin line under the header: "RES / VIDEO • 1.4.0.0". */
  sub?: ReactNode;
  /** Small keys at the right end of the sub line. */
  subKeys?: ReactNode;
  /** Readout in the header's right end, e.g. "02-05". */
  meta?: ReactNode;
  /** red: the header's right end becomes the red alert band; mint: a live counter. */
  metaTone?: "red" | "mint";
  /** Shows the X at the header's end and closes the window. */
  onClose?: () => void;
  /** Vertical tab strip outside the window's left edge. */
  tabs?: ReactNode;
  /** Text after "WIN xx" at the bottom. */
  foot?: ReactNode;
  /** Key buttons at the bottom right ("SPCT 01  SPCT 02  SPCT 03"). */
  keys?: ReactNode;
  /** Traffic-light mark on the window edge. */
  tone?: "ok" | "warn" | "err" | "off";
  /** Grid placement on the desk: "row / col / row-end / col-end". */
  area?: string;
  /** Rotated label beside the right edge, like "UPS 360 DEFAULT". */
  side?: string;
  /** The body scrolls inside the window (default) or shows everything. */
  scroll?: boolean;
  bodyClass?: string;
  ref?: Ref<HTMLElement>;
  children?: ReactNode;
};

export function Win({
  code,
  title,
  sub,
  subKeys,
  meta,
  metaTone,
  onClose,
  tabs,
  foot,
  keys,
  tone,
  area,
  side,
  scroll = true,
  bodyClass = "",
  className = "",
  style,
  ref,
  children,
  ...rest
}: WinProps) {
  const css: CSSProperties = { ...(area ? { gridArea: area } : {}), ...style };
  return (
    <section ref={ref} className={`gw ${tabs ? "has-tabs" : ""} ${tone ? `gw-${tone}` : ""} ${className}`} style={css} {...rest}>
      <span className="gw-frame" aria-hidden="true" />
      {side && (
        <span className="gw-side" aria-hidden="true">
          {side}
        </span>
      )}
      {tabs}
      <header className={`gw-head ${metaTone === "red" ? "alert" : ""}`}>
        <span className="gw-plate">
          <b className="gw-code">{code}</b>
          <span className="gw-title">{title}</span>
        </span>
        <span className="gw-hatch" aria-hidden="true" />
        {meta != null && (
          <span className={`gw-meta num ${metaTone ?? ""}`}>
            {metaTone === "red" && <i aria-hidden="true" />}
            {meta}
          </span>
        )}
        {onClose ? (
          <button type="button" className="gw-x" aria-label="Close" title="Close" onClick={onClose}>
            <X size={13} />
          </button>
        ) : (
          <span className="gw-x deco" aria-hidden="true" />
        )}
      </header>
      {(sub || subKeys) && (
        <div className="gw-sub">
          <i aria-hidden="true" />
          <span className="gw-sub-text">{sub}</span>
          {subKeys && <span className="gw-sub-keys">{subKeys}</span>}
        </div>
      )}
      <div className={`gw-body ${scroll ? "scroll" : ""} ${bodyClass}`}>{children}</div>
      <footer className="gw-foot">
        <span className="gw-win">
          Win <b className="num">{code}</b>
        </span>
        <span className="gw-foot-text">{foot}</span>
        {keys && <span className="gw-keys">{keys}</span>}
      </footer>
    </section>
  );
}

// ------------------------------------------------------------------ side tabs

export interface WinTab<T extends string> {
  id: T;
  label: string;
  count?: number;
  /** Traffic light for the count. */
  tone?: "ok" | "warn" | "err";
  title?: string;
}

/** Square coded tabs on a window's left edge (H2 / G4 / D5 / N7). */
export function SideTabs<T extends string>({ tabs, value, onChange, label }: { tabs: WinTab<T>[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className="gw-tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === value}
          className={`gw-tab ${t.id === value ? "on" : ""} ${t.tone && t.count ? `tone-${t.tone}` : ""}`}
          title={t.title ?? t.label}
          onClick={() => onChange(t.id)}
        >
          <b>{t.label}</b>
          {t.count != null && <small className="num">{pad(t.count)}</small>}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ menu column

export interface PlateItem<T extends string> {
  id: T;
  label: ReactNode;
  /** red: hatched red plate (needs attention); warn: amber edge; ok: mint edge. */
  tone?: "ok" | "warn" | "err";
  title?: string;
  disabled?: boolean;
}

/**
 * The board's menu column: ▲, a stack of plates (the selected one pale,
 * one needing attention hatched red), ▼, and an optional key under it.
 */
export function PlateMenu<T extends string>({
  items,
  value,
  onChange,
  label,
  footer,
  className = "",
}: {
  items: PlateItem<T>[];
  value: T | null;
  onChange: (v: T) => void;
  label: string;
  footer?: ReactNode;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ top: true, bottom: true });
  const check = () => {
    const el = box.current;
    if (!el) return;
    setEdge({ top: el.scrollTop <= 1, bottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 1 });
  };
  useEffect(() => {
    check();
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [items.length]);
  const step = (d: number) => box.current?.scrollBy({ top: d * 58, behavior: "smooth" });
  return (
    <div className={`gm ${className}`} role="group" aria-label={label}>
      <button type="button" className="gm-arrow" aria-label="Scroll up" disabled={edge.top} onClick={() => step(-1)}>
        <ChevronUp size={13} />
      </button>
      <div className="gm-list" ref={box} onScroll={check}>
        {items.map((it) => (
          <button
            key={it.id}
            type="button"
            className={`gm-item ${it.id === value ? "on" : ""} ${it.tone ? `tone-${it.tone}` : ""}`}
            aria-pressed={value === null ? undefined : it.id === value}
            title={it.title}
            disabled={it.disabled}
            onClick={() => onChange(it.id)}
          >
            {it.label}
          </button>
        ))}
      </div>
      <button type="button" className="gm-arrow" aria-label="Scroll down" disabled={edge.bottom} onClick={() => step(1)}>
        <ChevronDown size={13} />
      </button>
      {footer && <div className="gm-foot">{footer}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ scrolling list

/** A list that scrolls inside its window, with the board's ▲ / ▼ keys under it. */
export function Scroller({ children, className = "", label }: { children: ReactNode; className?: string; label?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ top: true, bottom: true });
  const check = () => {
    const el = box.current;
    if (!el) return;
    setEdge({ top: el.scrollTop <= 1, bottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 1 });
  };
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    const mo = new MutationObserver(check);
    mo.observe(el, { childList: true, subtree: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, []);
  const step = (d: number) => {
    const el = box.current;
    if (el) el.scrollBy({ top: d * el.clientHeight * 0.8, behavior: "smooth" });
  };
  const still = edge.top && edge.bottom;
  return (
    <div className={`gsc ${className}`}>
      <div className="gsc-box" ref={box} onScroll={check} aria-label={label}>
        {children}
      </div>
      <div className={`gsc-keys ${still ? "still" : ""}`}>
        <button type="button" className="gsc-key up" aria-label="Scroll up" disabled={edge.top} onClick={() => step(-1)}>
          <ChevronUp size={13} />
        </button>
        <button type="button" className="gsc-key down" aria-label="Scroll down" disabled={edge.bottom} onClick={() => step(1)}>
          <ChevronDown size={14} />
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ readouts

export interface StatItem {
  label: string;
  value: ReactNode;
  of?: ReactNode;
  /** live = green light, warn = yellow, err = red. */
  tone?: "live" | "warn" | "err";
  /** 0..1 fill of the level bar; defaults by tone. */
  level?: number;
}

/** The board's statistic boxes: a diagonal across each, a number, a level bar, an index. */
export function StatBoxes({ items, label, cols }: { items: StatItem[]; label: string; cols?: number }) {
  return (
    <div className="gsb" role="list" aria-label={label} style={{ gridTemplateColumns: `repeat(${cols ?? items.length}, minmax(0, 1fr))` }}>
      {items.map((s, i) => {
        const lv = s.level ?? (s.tone ? 0.72 : 0.36);
        return (
          <div key={s.label} role="listitem" className={`gsb-box ${s.tone ?? ""}`}>
            <span className="gsb-lab">{s.label}</span>
            <span className="gsb-v num">
              {s.value}
              {s.of != null && <span className="gsb-of"> / {s.of}</span>}
            </span>
            <i className="gsb-bar" aria-hidden="true" style={{ ["--lv" as string]: Math.max(0, Math.min(1, lv)) }} />
            <span className="gsb-idx num" aria-hidden="true">{pad(i + 1, 3)}</span>
          </div>
        );
      })}
    </div>
  );
}

export interface LevelRow {
  label: string;
  /** 0..1 */
  value: number;
  tone?: "ok" | "warn" | "err" | "off";
  text?: ReactNode;
  title?: string;
}

/** Labelled level bars (the board's CNS / TDH / GDR rows). */
export function LevelBars({ rows, label }: { rows: LevelRow[]; label: string }) {
  return (
    <div className="glb" role="list" aria-label={label}>
      {rows.map((r, i) => (
        <div key={`${r.label}-${i}`} role="listitem" className={`glb-row tone-${r.tone ?? "off"}`} title={r.title}>
          <span className="glb-lab">{r.label}</span>
          <span className="glb-track" aria-hidden="true">
            <i style={{ width: `${Math.max(0, Math.min(1, r.value)) * 100}%` }} />
          </span>
          <span className="glb-text num">{r.text}</span>
        </div>
      ))}
    </div>
  );
}

/** The big digital readout ("TP 00:28:17:012"). */
export function Readout({ prefix, value, tail, label, tone }: { prefix: string; value: ReactNode; tail?: ReactNode; label?: string; tone?: "ok" | "warn" | "err" }) {
  return (
    <div className={`gro ${tone ? `tone-${tone}` : ""}`} aria-label={label}>
      <span className="gro-pre">{prefix}</span>
      <span className="gro-v num">
        {value}
        {tail != null && <small>{tail}</small>}
      </span>
    </div>
  );
}

/** A labelled group inside a window body. */
export function Group({ title, count, actions, children, className = "" }: { title: ReactNode; count?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`gg ${className}`}>
      <div className="gg-head">
        <span className="gg-title">{title}</span>
        {count != null && <span className="gg-count num">{count}</span>}
        <span className="gg-line" aria-hidden="true" />
        {actions}
      </div>
      {children}
    </div>
  );
}

// ------------------------------------------------------------------ clock

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}
const STARTED = Date.now();

/** The red time tag: local time, with the session's minutes in mint. */
export function ClockTag() {
  const now = useNow();
  const d = new Date(now);
  const up = Math.max(0, Math.floor((now - STARTED) / 1000));
  return (
    <div className="gx-clock" role="timer" aria-label={`Local time ${d.toLocaleTimeString()}`}>
      <span className="gx-clock-lab">System time</span>
      <span className="gx-clock-v num">
        {pad(d.getHours())}:{pad(d.getMinutes())}:{pad(d.getSeconds())}
        <em aria-hidden="true">:{pad((up / 60) % 1000, 3)}</em>
      </span>
    </div>
  );
}

// ------------------------------------------------------------------ frame

function XBox({ at }: { at: string }) {
  return (
    <svg className={`gx-xbox ${at}`} width="22" height="22" viewBox="0 0 22 22">
      <rect x="0.5" y="0.5" width="21" height="21" />
      <line x1="0.5" y1="0.5" x2="21.5" y2="21.5" />
      <line x1="21.5" y1="0.5" x2="0.5" y2="21.5" />
    </svg>
  );
}

/** Fixed decoration around the screen: X boxes, the lower ruler, side rails, edge marks. */
export function Frame({ alert }: { alert: boolean }) {
  const bottom = ["FN_21", "FN_25", "FN_26", "FN_31", "FN_36", "FN_38", "FN_42", "FN_44"];
  return (
    <div className={`gx-frame ${alert ? "alert" : ""}`} aria-hidden="true">
      <XBox at="tl" />
      <XBox at="tr" />
      <XBox at="bl" />
      <XBox at="br" />
      <XBox at="ml1" />
      <XBox at="ml2" />
      <XBox at="mr1" />
      <XBox at="mr2" />
      <div className="gx-ruler bottom">
        {bottom.map((l, i) => (
          <span key={l} className={`gx-rl ${alert && i === bottom.length - 1 ? "red" : i === 2 ? "hot" : ""}`} style={{ left: `${((i + 0.5) / bottom.length) * 100}%` }}>
            {l}
          </span>
        ))}
      </div>
      <div className="gx-rail left">
        <span>Fn_01</span>
        <i />
        <i className="red" />
        <i />
        <i className="mint" />
        <span>Fn_ver_2</span>
      </div>
      <div className="gx-rail right">
        <span>Comp</span>
        <i />
        <i className="mint" />
        <i />
        <i className="red" />
        <span>Sys 1.1</span>
      </div>
      <span className="gx-glyph g1" />
      <span className="gx-glyph g2" />
      <span className="gx-glyph g3" />
      <span className="gx-edge left" />
      <span className="gx-edge right" />
    </div>
  );
}
