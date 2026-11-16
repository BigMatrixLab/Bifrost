import { useMemo, useState } from "react";
import { ListChecks } from "lucide-react";
import { useStore } from "../store";
import { Empty } from "../ui";
import { Group, LevelBars, Scroller, SideTabs, StatBoxes, Win } from "../glass";

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
    <div className="desk desk-activity">
      <Win code="H6" title="Statistics" area="1 / 9 / 6 / 13" aria-label="Activity summary" foot="All events" scroll={false}>
        <StatBoxes
          label="Activity summary"
          cols={2}
          items={[
            { label: "Events", value: activity.length },
            { label: "Done", value: count("success"), tone: count("success") > 0 ? "live" : undefined },
            { label: "Waiting", value: count("warning"), tone: count("warning") > 0 ? "warn" : undefined },
            { label: "Alerts", value: count("error"), tone: count("error") > 0 ? "err" : undefined },
          ]}
        />
      </Win>

      <Win code="R2" title="Levels" area="6 / 9 / 13 / 13" aria-label="Levels" foot="Share of all events">
        <LevelBars
          label="Levels"
          rows={[
            { label: "Done", value: activity.length ? count("success") / activity.length : 0, tone: "ok", text: String(count("success")).padStart(2, "0") },
            { label: "Wait", value: activity.length ? count("warning") / activity.length : 0, tone: "warn", text: String(count("warning")).padStart(2, "0") },
            { label: "Alrt", value: activity.length ? count("error") / activity.length : 0, tone: "err", text: String(count("error")).padStart(2, "0") },
            { label: "Info", value: activity.length ? count("info") / activity.length : 0, tone: "off", text: String(count("info")).padStart(2, "0") },
          ]}
        />
        <p className="gr-para" style={{ marginTop: 12 }}>
          Sharing, pairing and transfer events from this device. The log never includes file contents or invitation codes.
        </p>
      </Win>

      <Win
        code="N7"
        title="Event stream"
        area="1 / 1 / 13 / 9"
        scroll={false}
        aria-label="Events"
        className="gx-list"
        sub="Newest first"
        meta={`${String(shown.length).padStart(2, "0")}-${String(activity.length).padStart(2, "0")}`}
        metaTone={count("error") > 0 ? "red" : "mint"}
        tabs={
          <SideTabs
            label="Show"
            value={filter}
            onChange={setFilter}
            tabs={(
              [
                ["all", "All", "All", activity.length],
                ["success", "Done", "Done", count("success"), "ok"],
                ["warning", "Waiting", "Wait", count("warning"), "warn"],
                ["error", "Alerts", "Alrt", count("error"), "err"],
                ["info", "Info", "Info", count("info")],
              ] as [Filter, string, string, number, ("ok" | "warn" | "err")?][]
            ).map(([id, label, short, n, tone]) => ({ id, label: short, title: label, count: n, tone }))}
          />
        }
        foot={`${days.length} day${days.length === 1 ? "" : "s"} · ${shown.length} event${shown.length === 1 ? "" : "s"}`}
      >
        <Scroller label="Events">
        {shown.length === 0 ? (
          <Empty icon={<ListChecks size={20} />} title={activity.length === 0 ? "No activity yet" : "Nothing at this level"}>
            {activity.length === 0 ? "Sharing, pairing and transfer events are recorded here." : "Choose All to see every event."}
          </Empty>
        ) : (
          days.map((d) => (
            <Group key={d.label} title={d.label} count={`${d.items.length} event${d.items.length === 1 ? "" : "s"}`} className="tr-section">
              <ol className="act-rail">
                {d.items.map((a, i) => {
                  const l = LEVEL[a.level as Level] ?? LEVEL.info;
                  return (
                    <li key={a.id} className={`act-item tone-${l.tone} ${i === 0 && d === days[0] ? "latest" : ""}`}>
                      <span className="act-node num" aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
                      <span className="act-tag">{l.tag}</span>
                      <span className="act-msg act-wrap selectable">{a.message}</span>
                      <span className="act-time num">{timeOf(a.ts)}</span>
                    </li>
                  );
                })}
              </ol>
            </Group>
          ))
        )}
        </Scroller>
      </Win>
    </div>
  );
}
