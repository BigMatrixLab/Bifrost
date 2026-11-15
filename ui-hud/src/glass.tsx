/**
 * HUD window cards, after the reference board: a grey code plate with the
 * title, hatching, a readout (or the red alert band), the body, and a foot
 * line with "WIN xx" and the card's keys. The old panels go inside the body
 * unchanged, so every page keeps its old order, layout and charts.
 * Decorative parts are aria-hidden; everything interactive is a real button.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode, type Ref } from "react";
import { flushSync } from "react-dom";
import { X } from "lucide-react";

export const pad = (n: number, w = 2) => String(Math.max(0, Math.floor(n))).padStart(w, "0");

/** "03 / 07" style counter for a header readout. */
export const of = (n: number, total: number) => `${pad(n)} / ${pad(total)}`;

type WinProps = Omit<HTMLAttributes<HTMLElement>, "title"> & {
  /** Short code on the header plate, e.g. "FN01". */
  code: string;
  title: ReactNode;
  /** Thin line under the header: "SRC / DHAKA-EDIT-BAY". */
  sub?: ReactNode;
  /** Small chips at the right end of the sub line. */
  subKeys?: ReactNode;
  /** Readout at the header's right end, e.g. "02-05". */
  meta?: ReactNode;
  /** red: the header's right end becomes the red alert band; mint: live / ok; amber: waiting or relayed. */
  metaTone?: "red" | "mint" | "amber";
  /** Shows an X at the header's end. */
  onClose?: () => void;
  /** Text after "WIN xx" in the foot line. */
  foot?: ReactNode;
  /** Buttons at the right of the foot line. */
  keys?: ReactNode;
  /** Traffic-light mark on the left edge. */
  tone?: "ok" | "warn" | "err" | "off";
  /** Rotated label beside the right edge, like "UPS 360 DEFAULT". */
  side?: string;
  /** No foot line (for small cards where it would only add height). */
  bare?: boolean;
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
  foot,
  keys,
  tone,
  side,
  bare = false,
  bodyClass = "",
  className = "",
  ref,
  children,
  ...rest
}: WinProps) {
  return (
    <section ref={ref} className={`gw ${tone ? `gw-${tone}` : ""} ${bare ? "bare" : ""} ${className}`} {...rest}>
      {/* Glass and outline share one shape: top-left, bottom-left and bottom-right corners cut. */}
      <span className="gw-shape" aria-hidden="true" />
      <Outline />
      {side && (
        <span className="gw-side" aria-hidden="true">
          {side}
        </span>
      )}
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
            <X size={15} />
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
      <div className={`gw-body ${bodyClass}`}>{children}</div>
      {!bare && (
        <footer className="gw-foot">
          <span className="gw-win">
            Win <b className="num">{code}</b>
          </span>
          <span className="gw-foot-text">{foot}</span>
          {keys && <span className="gw-keys">{keys}</span>}
        </footer>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ outline

/** Corner cut in px; keep equal to --cut in glass.css (the glass is clipped to it). */
const CUT = 12;
/** Moving a 45° cut inward by d moves its ends along the edges by d × (√2 − 1). */
const SLANT = Math.SQRT2 - 1;

/**
 * The window outline, drawn to the window's measured size so the cuts stay
 * exact: a metallic outer hairline and a faint inner one 3px inside (the
 * inner one starts under the header). Both are broken in two places, with a
 * short green segment in each break:
 *  - bottom left, on the bottom edge: border, gap, segment, gap, border;
 *  - right edge, just under the header (beside the sub bar), where a short
 *    horizontal segment ends on the right border.
 */
export function Outline() {
  const box = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState<{ w: number; h: number; head: number } | null>(null);
  const gid = useId();
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    // Resize callbacks run after layout and before paint; flushSync redraws
    // in that same frame, so the outline never lags the window by a frame.
    const ro = new ResizeObserver(([e]) => {
      const { width: w, height: h } = e.contentRect;
      // The breaks follow the window's own header (34px, 26px in the sidebar).
      const head = el.parentElement?.querySelector<HTMLElement>(":scope > .gw-head")?.offsetHeight || 34;
      flushSync(() =>
        setSize((s) => (s && Math.abs(s.w - w) < 0.25 && Math.abs(s.h - h) < 0.25 && s.head === head ? s : { w, h, head })),
      );
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  let paths: { outer: string; inner: string; hot: string } | null = null;
  if (size && size.w > 80 && size.h > 60) {
    const { w, h } = size;
    const o = 0.5; // outer line centre
    const k = CUT + o * SLANT;
    const d = 3.5; // inner line centre
    const ki = CUT + d * SLANT;
    const headH = size.head; // the inner line starts under the header
    // Bottom-left break: border stub, gap, green segment, gap, border.
    const GAP = 5;
    const bx1 = k + 10;
    const gx1 = bx1 + GAP;
    const gx2 = gx1 + 44;
    const bx2 = gx2 + GAP;
    // Right-edge break beside the sub bar: the segment sits in the 8px gap
    // between the header and the sub bar and ends on the right border.
    const tr = h > 120 ? { a: headH - 3, y: headH + 4, b: headH + 12, len: 26 } : null;

    const outer = tr
      ? `M${bx2} ${h - o}L${w - k} ${h - o}L${w - o} ${h - k}L${w - o} ${tr.b}` +
        `M${w - o} ${tr.a}L${w - o} ${o}L${k} ${o}L${o} ${k}L${o} ${h - k}L${k} ${h - o}L${bx1} ${h - o}`
      : `M${bx2} ${h - o}L${w - k} ${h - o}L${w - o} ${h - k}L${w - o} ${o}L${k} ${o}L${o} ${k}L${o} ${h - k}L${k} ${h - o}L${bx1} ${h - o}`;
    const inner =
      `M${d} ${headH}L${d} ${h - ki}L${ki} ${h - d}L${bx1} ${h - d}` +
      `M${bx2} ${h - d}L${w - ki} ${h - d}L${w - d} ${h - ki}L${w - d} ${tr ? tr.b : headH}`;
    const hot = `M${gx1} ${h - 1}L${gx2} ${h - 1}` + (tr ? `M${w - tr.len} ${tr.y}L${w} ${tr.y}` : "");
    paths = { outer, inner, hot };
  }

  return (
    <span className="gw-line" ref={box} aria-hidden="true">
      {paths && size && (
        <svg width={size.w} height={size.h} focusable="false">
          <defs>
            {/* Brushed-metal sheen: bright at the top left, dim, a second highlight, dim. */}
            <linearGradient id={`${gid}-m`} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={size.w} y2={size.h}>
              <stop offset="0" stopColor="#fff" stopOpacity="0.5" />
              <stop offset="0.2" stopColor="#fff" stopOpacity="0.2" />
              <stop offset="0.5" stopColor="#fff" stopOpacity="0.32" />
              <stop offset="0.75" stopColor="#fff" stopOpacity="0.14" />
              <stop offset="1" stopColor="#fff" stopOpacity="0.26" />
            </linearGradient>
          </defs>
          <path className="ol-inner" d={paths.inner} />
          <path className="ol-outer" d={paths.outer} stroke={`url(#${gid}-m)`} />
          <path className="ol-hot" d={paths.hot} />
        </svg>
      )}
    </span>
  );
}

/** A small chip for the sub line ("DIR", "RLY", "RUN"). */
export function Chip({ on, tone, children }: { on?: boolean; tone?: "warn" | "err"; children: ReactNode }) {
  return <span className={`gx-chip ${on ? "on" : ""} ${tone ?? ""}`}>{children}</span>;
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

/** The red time tag: local time, then the session's minutes. */
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
