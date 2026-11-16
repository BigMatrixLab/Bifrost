import { useMemo, useState } from "react";
import { ListChecks } from "lucide-react";
import { useStore } from "../store";
import { Empty, HudStrip } from "../ui";
import { Win, pad } from "../glass";
import { useSlide } from "../slide";

type Level = "success" | "warning" | "error" | "info";
type Filter = "all" | Level;

/** Same tags and traffic-light tones as the Overview's Recent activity. */
const LEVEL: Record<Level, { tone: string; tag: string }> = {
  success: { tone: "ok", tag: "Done" },
  warning: { tone: "warn", tag: "Wait" },
  error: { tone: "err", tag: "Alert" },
  info: { tone: "info", tag: "Info" },
};

const DAY = 86_400_000;

function dayLabel(ts: number): string {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  const diff = Math.round((start.getTime() - d.getTime()) / DAY);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: d.getFullYear() === start.getFullYear() ? undefined : "numeric" });
}

const timeOf = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** Everything that happened, newest first: a timeline per day, filterable by level. */
export default function Activity() {
  const { activity } = useStore();
  const [filter, setFilter] = useState<Filter>("all");
  const tabSlide = useSlide<HTMLDivElement>(".tab", ".tab.on");
  const count = (l: Level) => activity.filter((a) => a.level === l).length;
  const shown = activity.filter((a) => filter === "all" || a.level === filter);
  const days = useMemo(() => {
    const out: { label: string; items: typeof shown }[] = [];
    for (const a of shown) {
      const label = dayLabel(a.ts);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(a);
      else out.push({ label, items: [a] });
    }
    return out;
  }, [shown]);

  return (
    <div className="page">
      <HudStrip
        code="H6"
        meta={`${pad(count("error"))} / ${pad(activity.length)}`}
        alert={count("error") > 0}
        label="Activity summary"
        stats={[
          { label: "Events", value: activity.length },
          { label: "Done", value: count("success") },
          { label: "Waiting", value: count("warning"), tone: count("warning") > 0 ? "warn" : undefined },
          { label: "Alerts", value: count("error"), tone: count("error") > 0 ? "err" : undefined },
        ]}
        note="Sharing, pairing and transfer events from this device. The log never includes file contents or invitation codes."
      />

      <div>
      <div className="tabs slides" role="tablist" aria-label="Show" ref={tabSlide}>
        {(
          [
            ["all", "All", activity.length],
            ["success", "Done", count("success")],
            ["warning", "Waiting", count("warning")],
            ["error", "Alerts", count("error")],
            ["info", "Info", count("info")],
          ] as [Filter, string, number][]
        ).map(([k, label, n]) => (
          <button key={k} role="tab" aria-selected={filter === k} className={`tab ${filter === k ? "on" : ""}`} onClick={() => setFilter(k)}>
            {label} <span className="c">{n}</span>
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <Win code="N0" title="Log" meta="00 / 00" className="tr-section" foot="Nothing at this level">
        <div className="panel">
          <Empty icon={<ListChecks size={20} />} title={activity.length === 0 ? "No activity yet" : "Nothing at this level"}>
            {activity.length === 0 ? "Sharing, pairing and transfer events are recorded here." : "Choose All to see every event."}
          </Empty>
        </div>
        </Win>
      ) : (
        days.map((d, di) => (
          <Win
            key={d.label}
            code={`N${di + 7}`}
            title={d.label}
            meta={`${pad(d.items.length)} event${d.items.length === 1 ? "" : "s"}`}
            metaTone={d.items.some((a) => a.level === "error") ? "red" : "mint"}
            className="tr-section"
            foot="Newest first"
          >
            <div className="panel act-list">
              <ol className="act-rail">
                {d.items.map((a, i) => {
                  const l = LEVEL[a.level as Level] ?? LEVEL.info;
                  return (
                    <li key={a.id} className={`act-item tone-${l.tone} ${i === 0 && d === days[0] ? "latest" : ""}`}>
                      <span className="act-node" aria-hidden="true" />
                      <span className="act-tag">{l.tag}</span>
                      <span className="act-msg act-wrap selectable">{a.message}</span>
                      <span className="act-time num">{timeOf(a.ts)}</span>
                    </li>
                  );
                })}
              </ol>
            </div>
          </Win>
        ))
      )}
      </div>
    </div>
  );
}
