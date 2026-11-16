import { useId, useMemo } from "react";
import { Download, Upload } from "lucide-react";
import { SERIES, useFlow } from "./flow";
import { speedParts, totalRates } from "./format";
import { useStore } from "./store";

/** Seconds of history in each sparkline. */
const SPAN = 40;
const W = 26;
const H = 14;

/** The last seconds as a small line with a glowing "now" dot, right of the figure. */
function Spark({ values, color, live }: { values: number[]; color: string; live: boolean }) {
  const id = useId().replace(/:/g, "");
  const { line, area, end } = useMemo(() => {
    const n = values.length;
    if (n < 2) return { line: "", area: "", end: null as null | { x: number; y: number } };
    const max = Math.max(1, ...values);
    const pts = values.map((v, i) => ({ x: (i / (n - 1)) * W, y: H - 1.5 - (v / max) * (H - 3) }));
    const line = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("");
    return { line, area: `${line}L${W},${H}L0,${H}Z`, end: pts[n - 1] };
  }, [values]);
  return (
    <svg className="tm-spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: color, stopOpacity: live ? 0.28 : 0.08 }} />
          <stop offset="100%" style={{ stopColor: color, stopOpacity: 0 }} />
        </linearGradient>
      </defs>
      {area && <path d={area} fill={`url(#g${id})`} />}
      {line && (
        <path d={line} fill="none" style={{ stroke: color }} strokeWidth={1} vectorEffect="non-scaling-stroke" opacity={live ? 0.9 : 0.3} />
      )}
      {end && live && <circle cx={end.x} cy={end.y} r={1.6} style={{ fill: color }} className="tm-dot" />}
    </svg>
  );
}

function Row({ down, bps, values, color }: { down: boolean; bps: number; values: number[]; color: string }) {
  const live = bps >= 1;
  const { value, unit } = speedParts(bps);
  return (
    <span className={`tm-row ${live ? "live" : ""}`} style={{ ["--tm" as string]: color }} title={down ? "Receiving" : "Sending"}>
      <span className="tm-ico">{down ? <Download size={11} strokeWidth={2.25} /> : <Upload size={11} strokeWidth={2.25} />}</span>
      <span className="tm-val num">
        {value}
        {unit && <small>{unit}</small>}
      </span>
      <Spark values={values} color={color} live={live} />
    </span>
  );
}

/**
 * Live receive and send speed beside the device name: every kind of
 * transfer counts (downloads, uploads into others' folders, others
 * downloading from or uploading to this device). Hidden when nothing has
 * moved for a while.
 */
export function SpeedMeter() {
  const { jobs, uploads, pushes, incoming } = useStore();
  const { samples } = useFlow();
  const { down, up } = totalRates(jobs, uploads, pushes, incoming);
  const recent = samples.slice(-SPAN);
  // Pad the start so a fresh line grows in from the right.
  const pad = Math.max(0, SPAN - recent.length);
  const downs = [...Array(pad).fill(0), ...recent.map((s) => s.down)];
  const ups = [...Array(pad).fill(0), ...recent.map((s) => s.up)];
  const anyRecent = down >= 1 || up >= 1 || recent.some((s) => s.down > 0 || s.up > 0);
  if (!anyRecent) return null;
  const d = speedParts(down);
  const u = speedParts(up);
  return (
    <span className="tm" role="group" aria-label={`Receiving ${d.value} ${d.unit}, sending ${u.value} ${u.unit}`}>
      <Row down bps={down} values={downs} color={SERIES.in} />
      <Row down={false} bps={up} values={ups} color={SERIES.out} />
    </span>
  );
}
