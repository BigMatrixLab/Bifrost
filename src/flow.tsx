import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { speed } from "./format";
import { useStore } from "./store";

/**
 * Two-series chart colours: received is green, sent is silver. They differ in
 * lightness as well as hue, so they stay apart for colour-blind readers.
 * Kept in sync with --series-in and --series-out in styles.css.
 */
export const SERIES = { in: "var(--series-in)", out: "var(--series-out)" } as const;

const WINDOW = 120; // seconds of history the live graph keeps

export interface FlowSample {
  t: number;
  down: number;
  up: number;
}

export type MarkKind = "pause" | "reconnect" | "relay" | "direct";

export interface FlowMark {
  t: number;
  kind: MarkKind;
  text: string;
}

interface Flow {
  samples: FlowSample[];
  marks: FlowMark[];
}

const Ctx = createContext<Flow>({ samples: [], marks: [] });

export function useFlow() {
  return useContext(Ctx);
}

/** Demo history so the preview build shows a populated graph. */
function demoFlow(now: number): Flow {
  const samples: FlowSample[] = [];
  for (let i = WINDOW; i > 0; i--) {
    const t = now - i * 1000;
    const dip = i > 88 && i < 98 ? 0.05 : 1;
    const ramp = i > 78 && i <= 88 ? (88 - i) / 10 : 1;
    const down = (10.4 + 1.6 * Math.sin(i / 7) + 0.7 * Math.sin(i / 2.3)) * 1024 * 1024 * dip * ramp;
    const up = i < 64 ? (3.1 + 0.9 * Math.sin(i / 5) + 0.3 * Math.cos(i / 1.7)) * 1024 * 1024 * Math.min(1, (64 - i) / 6) : 0;
    samples.push({ t, down, up });
  }
  return {
    samples,
    marks: [
      { t: now - 97_000, kind: "reconnect", text: "Connection dropped, resumed from the last saved block" },
      { t: now - 64_000, kind: "direct", text: "Lena's laptop started downloading from you" },
      { t: now - 31_000, kind: "pause", text: "You paused vfx-plates-batch-7.7z" },
    ],
  };
}

/**
 * Samples total receive and send speed once a second and notes the moments
 * that explain the shape of the line: pauses, reconnects and route changes.
 */
export function FlowProvider({ children }: { children: ReactNode }) {
  const { jobs, uploads } = useStore();
  const latest = useRef({ jobs, uploads });
  latest.current = { jobs, uploads };
  const [flow, setFlow] = useState<Flow>(() => (import.meta.env.MODE === "mock" ? demoFlow(Date.now()) : { samples: [], marks: [] }));
  const prev = useRef<Record<string, { status: string; route: string }>>({});

  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      const { jobs, uploads } = latest.current;
      const list = Object.values(jobs);
      const down = list.filter((j) => j.status === "downloading").reduce((a, j) => a + j.speedBps, 0);
      const up = uploads.reduce((a, u) => a + u.bps, 0);
      const marks: FlowMark[] = [];
      const seen: Record<string, { status: string; route: string }> = {};
      for (const j of list) {
        seen[j.id] = { status: j.status, route: j.route };
        const p = prev.current[j.id];
        if (!p) continue;
        if (p.status !== j.status) {
          if (j.status === "paused") marks.push({ t: now, kind: "pause", text: `You paused ${j.displayName}` });
          if (j.status === "reconnecting" && p.status === "downloading")
            marks.push({ t: now, kind: "reconnect", text: `Connection to ${j.peerName} dropped. Progress is saved.` });
        }
        if (j.status === "downloading" && p.route !== j.route && p.route !== "none" && j.route !== "none") {
          marks.push(
            j.route === "relay"
              ? { t: now, kind: "relay", text: `${j.peerName} switched to a relayed path` }
              : { t: now, kind: "direct", text: `${j.peerName} is on a direct path again` },
          );
        }
      }
      prev.current = seen;
      setFlow((f) => {
        // A few seconds past the window, so the graph's left edge never runs out of data.
        const cut = now - (WINDOW + 5) * 1000;
        const idle = down === 0 && up === 0 && marks.length === 0;
        const recent = f.samples.filter((s) => s.t >= cut);
        // Nothing moving and nothing to show: skip the re-render.
        if (idle && !recent.some((s) => s.down > 0 || s.up > 0)) return recent.length === f.samples.length ? f : { ...f, samples: recent };
        return {
          samples: [...recent, { t: now, down, up }],
          marks: [...f.marks.filter((m) => m.t >= cut), ...marks],
        };
      });
    };
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);

  return <Ctx.Provider value={flow}>{children}</Ctx.Provider>;
}

const MARK_TEXT: Record<MarkKind, string> = { pause: "Paused", reconnect: "Dropped", relay: "Relay", direct: "Direct" };

function niceMax(v: number): number {
  // Work in MiB so axis labels land on round numbers the way speeds are shown.
  const MB = 1024 * 1024;
  const m = Math.max(v / MB, 0.5);
  const exp = Math.pow(10, Math.floor(Math.log10(m)));
  for (const k of [1, 2, 4, 6, 8, 10]) if (k * exp >= m) return k * exp * MB;
  return 10 * exp * MB;
}

function ago(sec: number) {
  if (sec < 2) return "Now";
  return sec < 60 ? `${sec} s ago` : `${Math.floor(sec / 60)} min ${sec % 60 ? `${sec % 60} s ` : ""}ago`;
}

type Pt = { x: number; y: number };

/**
 * Smooth path through the points without overshoot (monotone cubic, Steffen's
 * method, as d3's curveMonotoneX), so a curve never dips below the baseline or
 * above a peak that wasn't measured. Each tangent depends only on a point's two
 * neighbours, so a segment is final once the point after it exists; the live
 * graph relies on that to scroll without the edge changing shape.
 */
function smoothPath(p: Pt[]): string {
  const n = p.length;
  if (n === 0) return "";
  if (n === 1) return `M${p[0].x.toFixed(1)},${p[0].y.toFixed(1)}`;
  const sec = (i: number) => (p[i + 1].y - p[i].y) / (p[i + 1].x - p[i].x || 1);
  const t: number[] = new Array(n);
  t[0] = sec(0);
  t[n - 1] = sec(n - 2);
  for (let i = 1; i < n - 1; i++) {
    const h0 = p[i].x - p[i - 1].x || 1;
    const h1 = p[i + 1].x - p[i].x || 1;
    const s0 = sec(i - 1);
    const s1 = sec(i);
    const q = (s0 * h1 + s1 * h0) / (h0 + h1);
    t[i] = (Math.sign(s0) + Math.sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(q)) || 0;
  }
  let d = `M${p[0].x.toFixed(1)},${p[0].y.toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const dx = (p[i + 1].x - p[i].x) / 3;
    d += `C${(p[i].x + dx).toFixed(1)},${(p[i].y + t[i] * dx).toFixed(1)} ${(p[i + 1].x - dx).toFixed(1)},${(p[i + 1].y - t[i + 1] * dx).toFixed(1)} ${p[i + 1].x.toFixed(1)},${p[i + 1].y.toFixed(1)}`;
  }
  return d;
}

const DOT = 18; // background dot spacing
const XH_W = DOT * 5; // crosshair every 5th dot across…
const XH_H = DOT * 3; // …and every 3rd dot down
const CAP = 5; // cursor triangle caps
const CAP_HALF = CAP / Math.sqrt(3);

/**
 * Live receive and send speed over the last two minutes. Receiving is a
 * glowing area above the baseline, sending hangs below it, both on one scale.
 * The plot scrolls continuously (one sample per second, eased over that
 * second), the newest point pulses, and hovering shows a dashed cursor with a
 * marker on each line and both speeds. On first appearance the plot sweeps in
 * from the left. Motion stops for "reduce motion".
 */
export function LiveFlow() {
  const { samples, marks } = useFlow();
  // The legend reads the same live figures as the rest of the screen.
  const { jobs, uploads } = useStore();
  const nowDown = Object.values(jobs).filter((j) => j.status === "downloading").reduce((a, j) => a + j.speedBps, 0);
  const nowUp = uploads.reduce((a, u) => a + u.bps, 0);
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  // Pointer position over the plot (px), so the cursor follows time as data scrolls under it.
  const [px, setPx] = useState<number | null>(null);
  const ids = useId().replace(/[^\w-]/g, "");

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Positions are relative to the newest sample, not the clock, so renders in
  // between samples don't move anything; CSS scrolls the plot between samples.
  const tEnd = samples.length ? samples[samples.length - 1].t : Date.now();
  const from = tEnd - WINDOW * 1000;
  // A few samples past the left edge, so the curve always covers it while sliding.
  const visible = samples.filter((s) => s.t >= from - 4000);
  const hasDown = visible.some((s) => s.down > 0) || nowDown > 0;
  const hasUp = visible.some((s) => s.up > 0) || nowUp > 0;

  const narrow = w < 520;
  const H = narrow ? 168 : 204;
  const pad = { l: narrow ? 38 : 48, r: 10, t: 28, b: 24 };
  const iw = Math.max(10, w - pad.l - pad.r);
  const ih = H - pad.t - pad.b;
  const peakDown = Math.max(0, nowDown, ...visible.map((s) => s.down));
  const peakUp = Math.max(0, nowUp, ...visible.map((s) => s.up));
  let nd = hasDown ? niceMax(peakDown * 1.08) : 0;
  const nu = hasUp ? niceMax(peakUp * 1.08) : 0;
  if (nd + nu === 0) nd = niceMax(1);
  const k = ih / (nd + nu);
  const y0 = pad.t + nd * k;
  const step = iw / WINDOW;
  const right = pad.l + iw;
  // The newest sample is placed two steps past the right edge (clipped). A
  // smooth curve's segment changes shape until the sample after it exists, so
  // the edge only ever shows segments that are final, and the slide carries
  // them in continuously: nothing jumps when a sample arrives. The display
  // lags live data by about two seconds.
  const LEAD = 2;
  const x = (t: number) => right + LEAD * step - ((tEnd - t) / 1000) * step;

  const downPts = visible.map((s) => ({ x: x(s.t), y: y0 - s.down * k }));
  const upPts = visible.map((s) => ({ x: x(s.t), y: y0 + s.up * k }));
  const area = (pts: Pt[]) => (pts.length > 1 ? `${smoothPath(pts)}L${pts[pts.length - 1].x.toFixed(1)},${y0}L${pts[0].x.toFixed(1)},${y0}Z` : "");
  // The sample that reaches the right edge by the end of this second (the
  // edge dots glide to it); the newest one is still off-screen.
  const last = visible[Math.max(0, visible.length - LEAD)];

  // Background lattice, centred in the plot both ways: (gridX, gridY) is a
  // crosshair, and every crosshair sits on a dot.
  const plotTop = pad.t - 6;
  const plotH = H - pad.t - pad.b + 6;
  const gridX = pad.l + ((iw % XH_W) + XH_W) / 2;
  const gridY = plotTop + ((plotH % XH_H) + XH_H) / 2;

  const hv =
    px == null || visible.length === 0
      ? null
      : (() => {
          const t = tEnd - ((right + LEAD * step - px) / step) * 1000;
          return visible.reduce((b, s) => (Math.abs(s.t - t) < Math.abs(b.t - t) ? s : b));
        })();
  const hoverMarks = hv ? marks.filter((m) => Math.abs(m.t - hv.t) <= 1500) : [];
  const shownMarks = marks.filter((m) => m.t >= from - 2000);

  // Y ticks; the one nearest the hovered value lights up.
  const downTicks = hasDown ? [nd, nd / 2] : [];
  const upTicks = hasUp ? [nu] : [];
  const near = (ticks: number[], v: number) => (v > 0 && ticks.length ? ticks.reduce((b, t) => (Math.abs(t - v) < Math.abs(b - v) ? t : b)) : null);
  const litDown = hv ? near([...downTicks, 0], hv.down) : null;
  const litUp = hv ? near(upTicks, hv.up) : null;
  const tick = (v: number) => (v === 0 ? "0" : speed(v).replace("/s", ""));

  const hx = hv ? x(hv.t) : 0;
  const flip = hx > w - 250;

  const onMove = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const p = clientX - r.left;
    setPx(p < pad.l || p > right + 4 ? null : p);
  };

  return (
    <section className="panel flow" aria-label="Live transfer speed">
      <div className="flow-head">
        <h3>Throughput</h3>
        <span className="flow-live" aria-hidden="true"><i />Live</span>
        <span className="flow-sub">Last 2 min · 1 s resolution</span>
        <div className="flow-legend" role="list">
          <span role="listitem" className={hasDown ? "in" : "in dim"}>
            <i style={{ background: SERIES.in }} />
            Receiving
            <b className="num">{speed(nowDown)}</b>
          </span>
          <span role="listitem" className={hasUp ? "out" : "out dim"}>
            <i style={{ background: SERIES.out }} />
            Sending
            <b className="num">{speed(nowUp)}</b>
          </span>
        </div>
      </div>
      <div
        className="flow-plot"
        ref={box}
        onPointerMove={(e) => onMove(e.clientX)}
        onPointerDown={(e) => onMove(e.clientX)}
        onPointerLeave={() => setPx(null)}
      >
        <svg
          width={w}
          height={H}
          role="img"
          aria-label={`Receiving ${speed(nowDown)}, sending ${speed(nowUp)}; speed for each second of the last two minutes`}
          style={{ ["--step" as string]: `${step}px`, ["--iw" as string]: `${iw}px` }}
        >
          <defs>
            <linearGradient id={`${ids}-in`} gradientUnits="userSpaceOnUse" x1="0" y1={pad.t} x2="0" y2={y0}>
              <stop offset="0" style={{ stopColor: "var(--series-in)", stopOpacity: 0.42 }} />
              <stop offset="1" style={{ stopColor: "var(--series-in)", stopOpacity: 0.02 }} />
            </linearGradient>
            <linearGradient id={`${ids}-out`} gradientUnits="userSpaceOnUse" x1="0" y1={H - pad.b} x2="0" y2={y0}>
              <stop offset="0" style={{ stopColor: "var(--series-out)", stopOpacity: 0.32 }} />
              <stop offset="1" style={{ stopColor: "var(--series-out)", stopOpacity: 0.02 }} />
            </linearGradient>
            <linearGradient id={`${ids}-scan`} x1="0" x2="1" y1="0" y2="0">
              <stop offset="0" style={{ stopColor: "var(--series-in)", stopOpacity: 0 }} />
              <stop offset="0.85" style={{ stopColor: "var(--series-in)", stopOpacity: 0.07 }} />
              <stop offset="1" style={{ stopColor: "var(--series-in)", stopOpacity: 0.22 }} />
            </linearGradient>
            {/* Stationary crosshair lattice centred in the plot. */}
            <pattern id={`${ids}-xhair`} patternUnits="userSpaceOnUse" x={gridX - XH_W / 2} y={gridY - XH_H / 2} width={XH_W} height={XH_H}>
              <path d={`M${XH_W / 2 - 3},${XH_H / 2}h6M${XH_W / 2},${XH_H / 2 - 3}v6`} className="flow-xhair" />
            </pattern>
            <linearGradient id={`${ids}-fade`} x1="0" x2="1" y1="0" y2="0">
              <stop offset="0" stopColor="#fff" stopOpacity={0} />
              <stop offset="0.08" stopColor="#fff" stopOpacity={1} />
              <stop offset="0.92" stopColor="#fff" stopOpacity={1} />
              <stop offset="1" stopColor="#fff" stopOpacity={0} />
            </linearGradient>
            <mask id={`${ids}-fademask`} maskContentUnits="userSpaceOnUse">
              <rect x={pad.l} y={0} width={iw} height={H} fill={`url(#${ids}-fade)`} />
            </mask>
            <clipPath id={`${ids}-clip`}>
              {/* Sweeps open once on first appearance. */}
              <rect className="flow-wipe" x={pad.l} y={0} width={iw + 1} height={H} />
            </clipPath>
          </defs>

          {/* Background: dot matrix, fading out at both ends. */}
          {/* Reference crosshairs only (no dot field), fading out at both ends. */}
          <g mask={`url(#${ids}-fademask)`}>
            <rect x={pad.l} y={plotTop} width={iw} height={plotH} fill={`url(#${ids}-xhair)`} />
          </g>

          {/* Y axis */}
          {downTicks.map((v) => (
            <text key={`td${v}`} x={pad.l - 8} y={y0 - v * k + 3.5} textAnchor="end" className={`flow-tick ${litDown === v ? "lit-in" : ""}`}>{tick(v)}</text>
          ))}
          <text x={pad.l - 8} y={y0 + 3.5} textAnchor="end" className={`flow-tick ${litDown === 0 ? "lit-in" : ""}`}>0</text>
          {upTicks.map((v) => (
            <text key={`tu${v}`} x={pad.l - 8} y={y0 + v * k + 3.5} textAnchor="end" className={`flow-tick ${litUp === v ? "lit-out" : ""}`}>{tick(v)}</text>
          ))}

          <g clipPath={`url(#${ids}-clip)`}>
            {/* Everything here scrolls left by one sample over each second. */}
            <g key={tEnd} className="flow-scroll">
              {shownMarks.map((m, i) => (
                <g key={`${m.t}-${m.kind}-${i}`} className={`flow-mark mark-${m.kind}`}>
                  <line x1={x(m.t)} x2={x(m.t)} y1={pad.t - 10} y2={H - pad.b} />
                  <text x={x(m.t) + 4} y={pad.t - 12}>{MARK_TEXT[m.kind]}</text>
                </g>
              ))}
              {hasUp && (
                <>
                  <path d={area(upPts)} fill={`url(#${ids}-out)`} />
                  <path d={smoothPath(upPts)} className="flow-line out" />
                </>
              )}
              {hasDown && (
                <>
                  <path d={area(downPts)} fill={`url(#${ids}-in)`} />
                  <path d={smoothPath(downPts)} className="flow-line in" />
                </>
              )}
              {hv && (
                <g className="flow-cursor">
                  <line x1={hx} x2={hx} y1={pad.t - 4 + CAP} y2={H - pad.b - CAP} />
                  <polygon points={`${hx - CAP_HALF},${pad.t - 4} ${hx + CAP_HALF},${pad.t - 4} ${hx},${pad.t - 4 + CAP}`} />
                  <polygon points={`${hx - CAP_HALF},${H - pad.b} ${hx + CAP_HALF},${H - pad.b} ${hx},${H - pad.b - CAP}`} />
                  {hasDown && <circle cx={hx} cy={y0 - hv.down * k} r={4.5} className="flow-marker in" />}
                  {hasUp && <circle cx={hx} cy={y0 + hv.up * k} r={4} className="flow-marker out" />}
                </g>
              )}
            </g>
            {/* A faint beam that keeps sweeping toward "now", fading in and out at the ends. */}
            <g mask={`url(#${ids}-fademask)`}>
              <rect className="flow-scan" x={pad.l - 90} y={pad.t - 6} width={90} height={H - pad.t - pad.b + 6} fill={`url(#${ids}-scan)`} />
            </g>
          </g>

          <line x1={pad.l} x2={right} y1={y0} y2={y0} className="flow-base" />

          {/* The newest values: pinned to the right edge (they don't scroll) and
              gliding to each new value; the ring pulses once per sample. */}
          {last && hasDown && (
            <g className="flow-head-dot in" style={{ transform: `translate(${right}px, ${y0 - last.down * k}px)` }}>
              <circle key={tEnd} r={7} className="ping" />
              <circle r={2.8} className="core" />
            </g>
          )}
          {last && hasUp && (
            <g className="flow-head-dot out" style={{ transform: `translate(${right}px, ${y0 + last.up * k}px)` }}>
              <circle r={2.6} className="core" />
            </g>
          )}
          <text x={pad.l} y={H - 5} className="flow-tick">−2:00</text>
          <text x={pad.l + iw / 2} y={H - 5} textAnchor="middle" className="flow-tick">−1:00</text>
          <text x={right} y={H - 5} textAnchor="end" className="flow-tick now">NOW</text>
        </svg>
        {hv && (
          <div className={`flow-tip ${flip ? "flip" : ""}`} style={{ left: flip ? hx - 16 : hx + 16, top: pad.t - 4 }}>
            <span className="lab">{ago(Math.round((Date.now() - hv.t) / 1000))}</span>
            <span className="tip-row"><i style={{ background: SERIES.in }} />Receiving<b className="num">{speed(hv.down)}</b></span>
            <span className="tip-row"><i style={{ background: SERIES.out }} />Sending<b className="num">{speed(hv.up)}</b></span>
            {hoverMarks.map((m, i) => (
              <span key={i} className="tip-note small">{m.text}</span>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/** Whether the live graph has anything to show. */
export function useFlowActive(): boolean {
  const { samples } = useFlow();
  return useMemo(() => samples.some((s) => s.t >= Date.now() - WINDOW * 1000 && (s.down > 0 || s.up > 0)), [samples]);
}
