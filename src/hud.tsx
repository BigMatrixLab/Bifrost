import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import createGlobe, { type COBEOptions } from "cobe";

const SEGMENTS = 96;

/**
 * Progress dial in the style of the bar meter: grey segments for what is
 * left, a solid glowing arc for what is verified on disk, a translucent arc
 * ahead of it for what is arriving, and a marker on the fill's end. The fill
 * sweeps round on first appearance and eases to new values. Amounts, not
 * positions, because chunks arrive in parallel.
 */
export function ChunkRing({
  verified,
  done,
  size = 236,
  state = "active",
  children,
  label,
}: {
  verified: number;
  done: number;
  size?: number;
  state?: "active" | "paused" | "attention" | "idle";
  children?: ReactNode;
  label: string;
}) {
  const c = size / 2;
  const r = size * 0.36;
  const w = Math.max(6, size * 0.05);
  const inner = r - w * 1.55;
  const outer = r + w * 1.65;

  const segs = useMemo(() => {
    const step = (Math.PI * 2) / SEGMENTS;
    const gap = step * 0.27;
    const pt = (a: number) => `${(c + r * Math.sin(a)).toFixed(2)} ${(c - r * Math.cos(a)).toFixed(2)}`;
    return Array.from({ length: SEGMENTS }, (_, i) => `M${pt(i * step + gap / 2)}A${r} ${r} 0 0 1 ${pt((i + 1) * step - gap / 2)}`);
  }, [c, r]);

  const v = clamp01(verified);
  const d = Math.max(v, clamp01(done));
  // Like the bar meter: the fill ends on a whole segment, so none is cut in half.
  const snap = (x: number) => (x >= 1 ? 1 : Math.round(x * SEGMENTS) / SEGMENTS);
  const pv = snap(v);
  const pd = Math.max(pv, snap(d));

  const ticks = 60;
  const tickLen = (2 * Math.PI * inner) / ticks;
  const mark = w * 0.95; // the marker reaches this far past the fill on each side

  return (
    <div
      className={`ring ring-${state}`}
      style={{ width: size, height: size, ["--pv" as string]: pv, ["--pd" as string]: pd, ["--deg" as string]: `${pv * 360}deg` }}
      role="img"
      aria-label={label}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={c} cy={c} r={outer} className="ring-outer" />
        <circle cx={c} cy={c} r={inner} className="ring-ticks" strokeWidth={w * 0.42} strokeDasharray={`0.8 ${(tickLen - 0.8).toFixed(3)}`} />
        {/* What is left: grey segments all the way round. */}
        {segs.map((p, i) => (
          <path key={i} d={p} strokeWidth={w} className="seg-o" />
        ))}
        {/* Arriving (received, not yet verified): a translucent fill ahead of the solid one. */}
        <circle cx={c} cy={c} r={r} pathLength={1} strokeWidth={w} transform={`rotate(-90 ${c} ${c})`} className="ring-fill arriving" />
        {/* Verified: one solid, glowing arc, like the bar's fill. */}
        <circle cx={c} cy={c} r={r} pathLength={1} strokeWidth={w} transform={`rotate(-90 ${c} ${c})`} className="ring-fill verified" />
        {/* The marker on the fill's end; it rides round with the fill. */}
        {pv > 0 && pv < 1 && (
          <g className="ring-mark" style={{ transformOrigin: `${c}px ${c}px` }}>
            <rect x={c - 1.5} y={c - r - w / 2 - mark / 2} width={3} height={w + mark} className="ring-mark-bar" style={{ transformOrigin: `${c}px ${c - r}px` }} />
          </g>
        )}
        <path d={`M${c - 4} ${c - outer - 7}h8l-4 5z`} className="ring-cursor" />
        <path d={`M${c} ${c + outer - 5}v10M${c - outer - 5} ${c}h10M${c + outer - 5} ${c}h10`} className="ring-cross" />
      </svg>
      <div className="ring-center">{children}</div>
    </div>
  );
}

/** Small route glyph: solid line for direct, dashed amber for relay, hollow for none. */
export function RouteGlyph({ kind }: { kind: string }) {
  const cls = kind === "direct" ? "rg-direct" : kind === "relay" ? "rg-relay" : "rg-none";
  return (
    <svg className={`rg ${cls}`} width="22" height="6" viewBox="0 0 22 6" aria-hidden="true">
      <line x1="0" y1="3" x2="22" y2="3" />
    </svg>
  );
}

/**
 * Node, line, node: this device and the peer, joined the way data actually
 * flows. Packets move toward the receiver.
 */
export function LinkLine({
  local,
  peer,
  kind,
  caption,
  incoming = true,
  moving = false,
}: {
  local: string;
  peer: string;
  kind: string;
  /** Optional text above the line; the line itself already shows the route. */
  caption?: string;
  incoming?: boolean;
  moving?: boolean;
}) {
  const k = kind === "direct" ? "direct" : kind === "relay" ? "relay" : "none";
  const live = moving && k !== "none";
  return (
    <div className={`link-line link-${k} ${incoming ? "in" : "out"} ${live ? "moving" : ""}`}>
      {caption && (
        <span className="ll-cap">
          <i className="ll-cap-dot" aria-hidden="true" />
          {caption}
        </span>
      )}
      <span className="ll-track" aria-hidden="true">
        <i className="ll-node local">
          <i className="ll-halo" />
        </i>
        <span className="ll-wire">
          {/* Tick rail under the wire. */}
          <span className="ll-rail" />
          {/* A light beam that keeps flowing toward the receiver. */}
          <span className="ll-beam" />
          <b />
          <b />
          <b />
          {k === "relay" && (
            <i className="ll-relay">
              <i className="ll-halo" />
            </i>
          )}
        </span>
        <i className="ll-node peer">
          <i className="ll-halo" />
        </i>
      </span>
      <span className="ll-ends">
        <span className="ll-end">
          <span className="ll-role">{incoming ? "RX" : "TX"}</span>
          <span className="truncate">{local}</span>
        </span>
        <span className="ll-end right">
          <span className="truncate">{peer}</span>
          <span className="ll-role">{incoming ? "TX" : "RX"}</span>
        </span>
      </span>
    </div>
  );
}

/**
 * Wireframe globe for the network panel. Decorative: it stands for "online"
 * and never shows where any device is.
 */
export function Globe({ size = 164, online }: { size?: number; online: boolean }) {
  const c = size / 2;
  const r = size * 0.34;
  const lat = [-0.66, -0.33, 0.33, 0.66];
  return (
    <svg className={`globe ${online ? "on" : "off"}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={c} cy={c} r={r * 1.22} className="g-ticks" strokeDasharray={`0.8 ${((2 * Math.PI * r * 1.22) / 72 - 0.8).toFixed(3)}`} />
      <circle cx={c} cy={c} r={r} className="g-rim" />
      {[0.78, 0.5, 0.17].map((k) => (
        <ellipse key={k} cx={c} cy={c} rx={r * k} ry={r} className="g-line" />
      ))}
      {lat.map((y) => (
        <ellipse key={y} cx={c} cy={c + y * r} rx={r * Math.sqrt(1 - y * y)} ry={r * 0.08} className="g-line" />
      ))}
      <ellipse cx={c} cy={c} rx={r} ry={r * 0.12} className="g-eq" />
      <g className="g-orbit-g">
        <ellipse cx={c} cy={c} rx={r * 1.42} ry={r * 0.38} transform={`rotate(-18 ${c} ${c})`} className="g-orbit" />
      </g>
    </svg>
  );
}

// ------------------------------------------------------------------ paired devices on the globe

/** A paired device as the globe shows it. */
export interface GlobeDevice {
  id: string;
  name: string;
  online: boolean;
  /** Data is arriving from it right now. */
  rx: boolean;
  /** Data is going to it right now. */
  tx: boolean;
}

/**
 * Spots on land, spread over the continents, that devices are pinned to: one
 * each, picked from a hash of the device's ID so a device keeps its spot.
 * Bifrost doesn't know where a device is, so these are not locations; they
 * only put each device somewhere on the map.
 */
const DEVICE_SPOTS: [number, number][] = [
  [51.5, -0.1], [40.4, -3.7], [59.3, 18.1], [41.9, 12.5], [52.2, 21.0], [30.0, 31.2], [6.5, 3.4],
  [-1.3, 36.8], [-26.2, 28.0], [25.2, 55.3], [24.9, 67.0], [28.6, 77.2], [23.8, 90.4], [13.8, 100.5],
  [1.35, 103.8], [39.9, 116.4], [31.2, 121.5], [35.7, 139.7], [37.6, 127.0], [-6.2, 106.8], [-33.9, 151.2],
  [-37.8, 145.0], [-36.8, 174.8], [55.8, 37.6], [43.7, -79.4], [41.9, -87.6], [29.8, -95.4], [19.4, -99.1],
  [4.7, -74.1], [-12.0, -77.0], [-23.5, -46.6], [-34.6, -58.4], [49.3, -123.1], [61.2, -149.9], [64.1, -21.9],
];

/**
 * One colour per device, for its marker, tag and wire. None is green or amber,
 * which mean "this device" and "relay" on the globe. Darker shades in the
 * light theme so they read on the pale sphere.
 */
const DEVICE_COLORS = [
  { dark: "#22d3ee", light: "#0891b2" },
  { dark: "#a78bfa", light: "#7c3aed" },
  { dark: "#f472b6", light: "#db2777" },
  { dark: "#fb923c", light: "#ea580c" },
  { dark: "#38bdf8", light: "#0284c7" },
  { dark: "#e879f9", light: "#c026d3" },
  { dark: "#2dd4bf", light: "#0d9488" },
  { dark: "#fb7185", light: "#e11d48" },
  { dark: "#818cf8", light: "#4f46e5" },
];
/** Offline devices: a grey marker. */
const OFFLINE: [number, number, number] = [0.42, 0.42, 0.45];
const OFFLINE_LIGHT: [number, number, number] = [0.62, 0.62, 0.64];

const rgb01 = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];

/** FNV-1a: a small, stable hash of a device ID. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

type V3 = [number, number, number];

/** cobe's own conversion from latitude and longitude to a unit vector. */
function toVec([lat, lon]: readonly [number, number]): V3 {
  const r = (lat * Math.PI) / 180;
  const a = (lon * Math.PI) / 180 - Math.PI;
  const o = Math.cos(r);
  return [-o * Math.cos(a), Math.sin(r), o * Math.sin(a)];
}

/** Angle between two places, in degrees. */
function apart(a: readonly [number, number], b: readonly [number, number]) {
  const p = toVec(a);
  const q = toVec(b);
  return (Math.acos(Math.max(-1, Math.min(1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2]))) * 180) / Math.PI;
}

/**
 * Where a point of the scene lands on the canvas (0..1), and whether it can
 * be seen: the same maths cobe uses for its marker anchors (square canvas,
 * scale 1, no offset). Hidden means behind the globe.
 */
function project(p: V3, phi: number, theta: number) {
  const cr = Math.cos(theta);
  const ca = Math.cos(phi);
  const so = Math.sin(theta);
  const si = Math.sin(phi);
  const c = ca * p[0] + si * p[2];
  const s = si * so * p[0] + cr * p[1] - ca * so * p[2];
  const z = -si * cr * p[0] + so * p[1] + ca * cr * p[2];
  return { x: (c + 1) / 2, y: (-s + 1) / 2, vis: z >= 0 || c * c + s * s >= 0.64 };
}

/** cobe's sphere radius, and how far markers and wires sit above it. */
const SPHERE = 0.8;
const ELEVATION = 0.02;
/**
 * Wires are cobe's own arcs, as in its "CDN" showcase (`arcHeight` 0.25).
 * `arcWidth` is in clip-space units, so a small canvas needs a larger value
 * than the showcase's 0.5 to get a line about 2 px wide.
 */
const WIRE_HEIGHT = 0.25;
const WIRE_WIDTH = 2.2;
/** A pulse's tail, as a share of the wire's length. */
const PULSE_TAIL = 0.12;
/** Pulses on a wire at once, and how long each takes to cross it. */
const PULSES = 3;
const PULSE_MS = 1800;

/**
 * A point on a wire, `t` of the way from `from` to `to`, on the canvas
 * (0..1), and whether it can be seen. This is cobe's arc curve: a quadratic
 * Bézier through a point raised above the middle.
 */
function wirePoint(from: readonly [number, number], to: readonly [number, number], t: number, phi: number, theta: number) {
  const a = toVec(from);
  const b = toVec(to);
  const m: V3 = [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const len = Math.hypot(...m) || 1;
  const r = SPHERE + ELEVATION;
  const h = (SPHERE + WIRE_HEIGHT + ELEVATION) / len;
  const u = 1 - t;
  const p: V3 = [0, 1, 2].map((k) => u * u * a[k] * r + 2 * u * t * m[k] * h + t * t * b[k] * r) as V3;
  return project(p, phi, theta);
}

/**
 * One pulse on a wire: its tail as SVG path data and its head, in canvas
 * pixels. Parts behind the globe are left out; a hidden head returns null.
 */
function pulseShape(from: readonly [number, number], to: readonly [number, number], t: number, phi: number, theta: number, size: number) {
  const steps = 6;
  let d = "";
  let open = false;
  let head: { x: number; y: number } | null = null;
  for (let i = 0; i <= steps; i++) {
    const s = Math.max(0, t - PULSE_TAIL * (1 - i / steps));
    const q = wirePoint(from, to, s, phi, theta);
    if (!q.vis) {
      open = false;
      head = null;
      continue;
    }
    d += `${open ? "L" : "M"}${(q.x * size).toFixed(1)} ${(q.y * size).toFixed(1)}`;
    open = true;
    if (i === steps) head = { x: q.x * size, y: q.y * size };
  }
  return { d, head };
}

/** Each device's spot and colour, kept apart from the relays, this device and each other. */
function placeDevices(devices: GlobeDevice[], avoid: (readonly [number, number])[]) {
  const out = new Map<string, { loc: [number, number]; color: number; marker: string }>();
  const taken = new Set<number>();
  const usedColors = new Set<number>();
  for (const d of [...devices].sort((x, y) => (x.id < y.id ? -1 : 1))) {
    const h = hash(d.id);
    let spot = -1;
    for (let k = 0; k < DEVICE_SPOTS.length && spot < 0; k++) {
      const i = (h + k) % DEVICE_SPOTS.length;
      if (taken.has(i)) continue;
      const near = [...avoid, ...[...taken].map((t) => DEVICE_SPOTS[t])].some((p) => apart(p, DEVICE_SPOTS[i]) < 14);
      if (!near) spot = i;
    }
    if (spot < 0) spot = [...Array(DEVICE_SPOTS.length).keys()].find((i) => !taken.has(i)) ?? h % DEVICE_SPOTS.length;
    taken.add(spot);
    let color = (h >>> 8) % DEVICE_COLORS.length;
    for (let k = 0; k < DEVICE_COLORS.length && usedColors.has(color); k++) color = (color + 1) % DEVICE_COLORS.length;
    usedColors.add(color);
    out.set(d.id, { loc: DEVICE_SPOTS[spot], color, marker: `rl-dev-${h.toString(36)}` });
  }
  return out;
}

/** Screen-reader summary of the devices on the globe. */
function devicesText(devices: GlobeDevice[]) {
  if (!devices.length) return "";
  const parts = devices.map((d) =>
    !d.online ? `${d.name} (offline)` : d.rx && d.tx ? `${d.name} (sending and receiving)` : d.rx ? `${d.name} (sending to you)` : d.tx ? `${d.name} (receiving from you)` : `${d.name} (connected)`,
  );
  return ` Paired devices, shown at made-up places on the map: ${parts.join("; ")}.`;
}

// ------------------------------------------------------------------ dotted globe (cobe)

/**
 * Colours for cobe, as 0..1 RGB. Dots are pewter-to-white on a black sphere,
 * with a faint green halo; offline drops the halo to grey. Kept in step
 * with --text, --text-3 and --accent in styles.css.
 */
const GLOBE_LOOK = {
  online: { dark: 1, baseColor: [0.34, 0.34, 0.36], glowColor: [0.08, 0.25, 0.05], mapBrightness: 9, diffuse: 2.4, opacity: 0.95 },
  offline: { dark: 1, baseColor: [0.24, 0.24, 0.25], glowColor: [0.1, 0.1, 0.11], mapBrightness: 5, diffuse: 1.8, opacity: 0.7 },
  // Light theme: a pale sphere with dark land dots and a soft green halo, so
  // it sits on the white panel instead of punching a black hole in it.
  lightOnline: { dark: 0, baseColor: [0.93, 0.94, 0.93], glowColor: [0.8, 0.92, 0.82], mapBrightness: 2.2, diffuse: 1.2, opacity: 0.9 },
  lightOffline: { dark: 0, baseColor: [0.92, 0.92, 0.92], glowColor: [0.88, 0.88, 0.88], mapBrightness: 1.6, diffuse: 1.1, opacity: 0.75 },
} satisfies Record<string, Partial<COBEOptions>>;

let webgl: boolean | null = null;
function hasWebGL(): boolean {
  if (webgl == null) {
    try {
      const c = document.createElement("canvas");
      webgl = !!(c.getContext("webgl2") || c.getContext("webgl"));
    } catch {
      webgl = false;
    }
  }
  return webgl;
}

/**
 * The public relay regions Bifrost can use: iroh's default relay map
 * (`iroh::defaults::prod`, hostnames `<region>-1.relay.n0.iroh.link`).
 * Positions are approximate, at the metro area each region code names, and
 * are only used to place the markers. Update this list together with iroh.
 */
export const RELAY_REGIONS = [
  { code: "use1", name: "US East", location: [38.95, -77.45] },
  { code: "usw1", name: "US West", location: [37.4, -122.0] },
  { code: "euc1", name: "EU Central", location: [50.11, 8.68] },
  { code: "aps1", name: "Asia Pacific", location: [19.08, 72.88] },
] as const satisfies readonly { code: string; name: string; location: [number, number] }[];

/** "https://euc1-1.relay.n0.iroh.link./" -> "euc1". Null for custom relays. */
export function relayRegion(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const code = new URL(url).hostname.split(".")[0].replace(/-\d+$/, "");
    return RELAY_REGIONS.some((r) => r.code === code) ? code : null;
  } catch {
    return null;
  }
}

/** Home relay marker: --accent (#4ade80). */
const HOME: [number, number, number] = [0.29, 0.87, 0.5];
/** Other relays: amber (--warn, #fbbf24), the app's relay colour, so they
 *  stand out from the white land dots instead of blending in. */
const DOT: [number, number, number] = [0.98, 0.75, 0.14];
/** Light theme: --accent (#15803d), and --warn (#c27a06) for the other relays. */
const HOME_LIGHT: [number, number, number] = [0.08, 0.5, 0.24];
const DOT_LIGHT: [number, number, number] = [0.76, 0.48, 0.02];

/** True while the light theme is on; follows the toggle live. */
function useLightTheme(): boolean {
  const read = () => document.documentElement.dataset.theme === "light";
  const [light, setLight] = useState(read);
  useEffect(() => {
    const mo = new MutationObserver(() => setLight(read()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);
  return light;
}

/** Rotation that puts a longitude in the middle of the globe's face. */
const facing = (lon: number) => (3 * Math.PI) / 2 - (lon * Math.PI) / 180;

/** The globe's tilt toward you. */
const THETA = 0.24;
/** This device's spot when it has no home relay to sit on. */
const SELF_SPOT: [number, number] = [38.7, -9.1];

/**
 * The Network panel's globe, after cobe's "CDN" showcase: a slowly turning
 * dotted Earth (WebGL) with a labelled dot at each public relay region,
 * the home relay in green and tagged with this device's name. These are the
 * servers that help devices find each other and, when routers block a direct
 * path, forward encrypted packets.
 *
 * Paired devices are dots on the map too, each in its own colour (grey while
 * offline), and turn with it. Bifrost doesn't know where a device is, so each
 * one gets a made-up spot (see `DEVICE_SPOTS`). An online device has a faint
 * wire to this device; while data moves, light runs along it toward the
 * receiver.
 *
 * It only animates while it's on screen, the device is online and the user
 * hasn't asked for reduced motion, at about 30 frames a second, so it costs
 * almost nothing when nobody is looking at it.
 */
export function DotGlobe({
  size = 170,
  online,
  home,
  label,
  devices = [],
}: {
  size?: number;
  online: boolean;
  home: string | null;
  label?: string;
  /** Paired devices, drawn at made-up spots on the map. */
  devices?: GlobeDevice[];
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [ok] = useState(hasWebGL);
  const light = useLightTheme();
  // Starts with the home relay (or Europe) facing you; keeps the rotation
  // across re-creations.
  const phi = useRef(facing(RELAY_REGIONS.find((r) => r.code === home)?.location[1] ?? 8.68));

  // This device sits on its home relay; without one (custom relays,
  // offline) it gets a spot of its own.
  const homeRelay = RELAY_REGIONS.find((r) => r.code === home);
  const self: readonly [number, number] = homeRelay?.location ?? SELF_SPOT;
  const idsKey = devices.map((d) => d.id).sort().join(",");
  const places = useMemo(
    () => placeDevices(devices, [...RELAY_REGIONS.map((r) => r.location), self]),
    // Spots depend only on which devices there are, not on their state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [idsKey, self[0], self[1]],
  );
  // The animation loop reads the latest devices without restarting the globe.
  const live = useRef({ devices, places, light, self, homeRelay: !!homeRelay });
  live.current = { devices, places, light, self, homeRelay: !!homeRelay };
  const draw = useRef<(() => void) | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    const gl = canvas?.parentElement;
    if (!canvas || !gl || !ok) return;
    const look = light ? (online ? GLOBE_LOOK.lightOnline : GLOBE_LOOK.lightOffline) : online ? GLOBE_LOOK.online : GLOBE_LOOK.offline;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const markers = (t: number) => {
      const { devices, places, light, self, homeRelay } = live.current;
      const relays = RELAY_REGIONS.map((r) => ({
        location: [...r.location] as [number, number],
        size: r.code === home ? 0.06 : 0.05,
        ...(r.code === home && online ? { color: light ? HOME_LIGHT : HOME } : {}),
      }));
      const me = homeRelay ? [] : [{ location: [...self] as [number, number], size: 0.06, color: online ? (light ? HOME_LIGHT : HOME) : light ? OFFLINE_LIGHT : OFFLINE }];
      // Devices with data moving pulse gently.
      const beat = reduce.matches ? 0 : Math.sin(t * 0.006);
      const devs = devices.flatMap((d) => {
        const p = places.get(d.id);
        if (!p) return [];
        const busy = d.online && (d.rx || d.tx);
        const c = DEVICE_COLORS[p.color];
        return [
          {
            location: [...p.loc] as [number, number],
            size: busy ? 0.06 + 0.015 * beat : 0.05,
            color: d.online ? rgb01(light ? c.light : c.dark) : light ? OFFLINE_LIGHT : OFFLINE,
          },
        ];
      });
      return [...relays, ...me, ...devs];
    };
    // cobe arcs from this device to every online device, in the device's
    // colour: full strength while data moves, dimmed while idle.
    const arcs = () => {
      const { devices, places, light, self } = live.current;
      return devices.flatMap((d) => {
        const p = places.get(d.id);
        if (!p || !d.online) return [];
        const c = rgb01(light ? DEVICE_COLORS[p.color].light : DEVICE_COLORS[p.color].dark);
        const busy = d.rx || d.tx;
        // Idle: mixed toward the panel colour, so it stays visible but quiet.
        const bg = light ? 1 : 0.05;
        const k = busy ? 1 : 0.5;
        const color = c.map((v) => bg + (v - bg) * k) as [number, number, number];
        return [{ from: [...self] as [number, number], to: [...p.loc] as [number, number], color }];
      });
    };
    const globe = createGlobe(canvas, {
      width: size,
      height: size,
      devicePixelRatio: Math.min(2, window.devicePixelRatio || 1),
      phi: phi.current,
      theta: THETA,
      // Dense dot grid (cobe's default is 10,000). Keep it below 32,768: cobe's
      // shader decodes a sample's index with bits up to 16,384 only, so higher
      // indices (the southern part of the sphere) land in the wrong place and
      // the map breaks up at the bottom.
      mapSamples: 32000,
      mapBaseBrightness: light ? 0 : 0.02,
      markerColor: light ? DOT_LIGHT : DOT,
      markerElevation: ELEVATION,
      markers: markers(0),
      arcs: arcs(),
      arcColor: light ? DOT_LIGHT : DOT,
      arcWidth: WIRE_WIDTH,
      arcHeight: WIRE_HEIGHT,
      scale: 1,
      ...look,
    });

    // Tags and wires follow the markers, placed with the same maths cobe
    // uses (`project`). A tag fades as its marker nears the rim or goes
    // behind the globe, and gives way to one nearer the middle that it
    // would overlap; this device and busy devices win over the rest.
    const lift = SPHERE + ELEVATION;
    const fadeLabels = () => {
      const el = stage.current;
      if (!el) return;
      const tags = [...el.querySelectorAll<HTMLElement>("[data-loc]")].map((l) => {
        const [lat, lon] = l.dataset.loc!.split(",").map(Number);
        const v = toVec([lat, lon]);
        const q = project([v[0] * lift, v[1] * lift, v[2] * lift], phi.current, THETA);
        return { l, x: q.x, y: q.y, vis: q.vis, w: l.offsetWidth || 40, d: Math.hypot(q.x - 0.5, q.y - 0.5), rank: Number(l.dataset.rank ?? 2) };
      });
      tags.sort((a, b) => a.rank - b.rank || a.d - b.d);
      const kept: { x: number; y: number; w: number }[] = [];
      for (const { l, x, y, vis, w, d } of tags) {
        // The disc's rim is at about 0.4 of the canvas from the centre; fade
        // over the last stretch before it.
        const fromRim = Math.min(1, Math.max(0, (0.41 - d) / 0.05));
        // Tags are about 17 px tall and sit just above their marker; keep them apart.
        const clash = kept.some((k) => Math.abs(k.x - x) * size < (k.w + w) / 2 + 2 && Math.abs(k.y - y) * size < 19);
        const o = vis && !clash ? fromRim : 0;
        if (o > 0.3) kept.push({ x, y, w });
        l.style.left = `${(x * 100).toFixed(2)}%`;
        l.style.top = `${(y * 100).toFixed(2)}%`;
        l.style.opacity = o.toFixed(2);
        l.style.filter = o > 0.98 ? "" : `blur(${((1 - o) * 5).toFixed(1)}px)`;
      }
    };
    // Pulses: bright comets running along a busy wire from sender to
    // receiver, a few at a time, evenly spaced. Not drawn with reduced motion.
    const drawPulses = (t: number) => {
      const el = stage.current;
      if (!el) return;
      for (const g of el.querySelectorAll<SVGGElement>("g[data-from]")) {
        const a = g.dataset.from!.split(",").map(Number) as [number, number];
        const b = g.dataset.to!.split(",").map(Number) as [number, number];
        const k = Number(g.dataset.k ?? 0);
        const tail = g.querySelector("path");
        const head = g.querySelector("circle");
        if (!tail || !head) continue;
        if (reduce.matches) {
          g.style.display = "none";
          continue;
        }
        g.style.display = "";
        const pos = (t / PULSE_MS + k / PULSES) % 1;
        const s = pulseShape(a, b, pos, phi.current, THETA, size);
        tail.setAttribute("d", s.d);
        // Fades in leaving the sender and out arriving, so pulses don't pop.
        const fade = Math.min(1, pos / 0.08, (1 - pos) / 0.08);
        g.style.opacity = fade.toFixed(2);
        if (s.head) {
          head.setAttribute("cx", s.head.x.toFixed(1));
          head.setAttribute("cy", s.head.y.toFixed(1));
          head.style.display = "";
        } else {
          head.style.display = "none";
        }
      }
    };
    const render = (t: number) => {
      globe.update({ phi: phi.current, markers: markers(t), arcs: arcs() });
      fadeLabels();
      drawPulses(t);
    };
    render(performance.now());

    let raf = 0;
    let last = 0;
    let onScreen = true;
    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      if (last && t - last < 32) return; // ~30 fps is plenty for a slow spin
      const dt = last ? Math.min(t - last, 100) : 32;
      last = t;
      phi.current += dt * 0.00016; // one turn in about 40 s
      render(t);
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
      last = 0;
    };
    const sync = () => {
      const run = online && onScreen && !reduce.matches;
      if (run && !raf) raf = requestAnimationFrame(frame);
      else if (!run && raf) stop();
    };
    // While the globe is still, device changes are drawn straight away.
    draw.current = () => {
      if (!raf) render(performance.now());
    };
    const io = new IntersectionObserver(([e]) => {
      onScreen = e.isIntersecting;
      sync();
    });
    io.observe(canvas);
    reduce.addEventListener("change", sync);
    sync();

    return () => {
      draw.current = null;
      stop();
      io.disconnect();
      reduce.removeEventListener("change", sync);
      // Frees the buffers, programs, marker anchors and cobe's <style> tag.
      // The WebGL context stays with the canvas, so a re-run (StrictMode,
      // going on or offline) reuses it.
      globe.destroy();
      // cobe wraps the canvas in a div of its own; undo that so a re-run
      // doesn't nest another one.
      const wrap = canvas.parentElement;
      if (wrap && wrap !== gl) {
        gl.insertBefore(canvas, wrap);
        wrap.remove();
      }
    };
  }, [ok, size, online, home, light]);

  const stateKey = devices.map((d) => `${d.id}:${+d.online}${+d.rx}${+d.tx}`).join("|");
  useEffect(() => draw.current?.(), [stateKey, places]);

  // A HUD frame around the globe: a tick scale, in SVG.
  const box = Math.round(size * 1.12);
  const c = box / 2;
  const tr = size * 0.5;
  if (!ok) {
    return (
      <>
        <Globe size={size} online={online} />
        <span className="sr-only">{devicesText(devices)}</span>
      </>
    );
  }
  const loc = (p: readonly [number, number]) => `${p[0]},${p[1]}`;
  return (
    <div className={`dot-globe ${online ? "on" : "off"}`} style={{ width: box, height: box }}>
      <svg className="dg-frame" width={box} height={box} viewBox={`0 0 ${box} ${box}`} aria-hidden="true">
        <circle cx={c} cy={c} r={tr} className="dg-ticks" strokeDasharray={`0.8 ${((2 * Math.PI * tr) / 90 - 0.8).toFixed(3)}`} />
      </svg>
      <div className="dg-stage" ref={stage} style={{ width: size, height: size }}>
        {/* cobe moves the canvas into a wrapper of its own, so React keeps
            nothing else in this div. */}
        <div className="dg-gl">
          <canvas ref={ref} className="dg-canvas" style={{ width: size, height: size }} aria-hidden="true" />
        </div>
        {/* The wires are cobe arcs on the canvas. While data moves, pulses
            run along them from sender to receiver; their shape and position
            are set per frame. */}
        <svg className="dg-wires" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
          {devices.flatMap((d) => {
            const p = places.get(d.id);
            if (!p || !d.online) return [];
            const col = light ? DEVICE_COLORS[p.color].light : DEVICE_COLORS[p.color].dark;
            const runs: [string, readonly [number, number], readonly [number, number]][] = [];
            if (d.rx) runs.push(["in", p.loc, self]);
            if (d.tx) runs.push(["out", self, p.loc]);
            return runs.flatMap(([dir, from, to]) =>
              Array.from({ length: PULSES }, (_, k) => (
                <g key={`${d.id}-${dir}-${k}`} data-from={loc(from)} data-to={loc(to)} data-k={k} className="dg-pulse" style={{ ["--dc" as string]: col }}>
                  <path />
                  <circle r={2.2} />
                </g>
              )),
            );
          })}
        </svg>
        {/* Tags follow their markers and fade out near the rim and behind
            the globe. Position, opacity and blur are set per frame. */}
        {RELAY_REGIONS.map((r) => (
          <span
            key={r.code}
            data-loc={loc(r.location)}
            data-rank={r.code === home ? 0 : 2}
            className={`dg-relay ${r.code === home ? "home" : ""}`}
            style={{ opacity: 0 }}
            aria-hidden="true"
          >
            <span className="dg-tag">{r.code === home && label ? label : r.code}</span>
          </span>
        ))}
        {!homeRelay && label && (
          <span data-loc={loc(self)} data-rank={0} className="dg-relay home" style={{ opacity: 0 }} aria-hidden="true">
            <span className="dg-tag">{label}</span>
          </span>
        )}
        {devices.map((d) => {
          const p = places.get(d.id);
          if (!p) return null;
          const col = DEVICE_COLORS[p.color];
          const busy = d.online && (d.rx || d.tx);
          return (
            <span
              key={d.id}
              data-loc={loc(p.loc)}
              data-rank={busy ? 1 : d.online ? 2 : 3}
              className={`dg-relay dev ${d.online ? "on" : "off"} ${busy ? "busy" : ""}`}
              style={{ opacity: 0, ["--dc" as string]: light ? col.light : col.dark, ["--dc-ink" as string]: light ? "#fff" : "#0b0b0d" }}
              title={`${d.name}: ${d.online ? (d.rx && d.tx ? "sending and receiving" : d.rx ? "sending to you" : d.tx ? "receiving from you" : "connected") : "offline"}`}
              aria-hidden="true"
            >
              <span className="dg-tag">{d.name}</span>
            </span>
          );
        })}
      </div>
      <span className="sr-only">
        Public relay regions: {RELAY_REGIONS.map((r) => `${r.name} (${r.code})${r.code === home ? `, your home relay${label ? ` (${label})` : ""}` : ""}`).join("; ")}.
        {devicesText(devices)}
      </span>
    </div>
  );
}

function clamp01(x: number) {
  return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
}
