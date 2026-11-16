import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { bytes } from "./format";
import { DayLevel, EntriesTip, buildDays, dayKey, fmtDay, openHistoryOn, weekStart } from "./pages/History";
import { useStore } from "./store";

const TIP_HALF = 126; // half of .cal-tip's width

/**
 * The History calendar in miniature, for the sidebar: each day fills like a
 * gauge (received, then sent) to the share of the busiest day, with the same
 * hover card as the full calendar. A click opens History on that day.
 */
export function MiniCalendar() {
  const { history, setPage } = useStore();
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [hover, setHover] = useState<{ key: string; x: number; y: number; below: boolean } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const first = weekStart();
  const { days, max } = useMemo(() => buildDays(history), [history]);

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
    () => Array.from({ length: 7 }, (_, i) => new Date(2023, 0, 1 + ((first + i) % 7)).toLocaleDateString(undefined, { weekday: "narrow" })),
    [first],
  );

  const now = new Date();
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const todayKey = dayKey(now.getTime());
  const monthTotal = useMemo(() => {
    let t = 0;
    days.forEach((a) => {
      if (a.date.getFullYear() === month.getFullYear() && a.date.getMonth() === month.getMonth()) t += a.total;
    });
    return t;
  }, [days, month]);

  const shift = (n: number) => {
    setHover(null);
    setMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1));
  };
  // The card floats over the page (the sidebar is too narrow and clips), in
  // viewport coordinates: above the day, or below it near the top.
  const showTip = (key: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const below = r.top < 200;
    const x = Math.min(Math.max(r.left + r.width / 2, TIP_HALF + 8), window.innerWidth - TIP_HALF - 8);
    setHover({ key, x, y: below ? r.bottom : r.top, below });
  };
  const tip = hover ? days.get(hover.key) : null;

  return (
    <div className="mini-cal" ref={box} onPointerLeave={() => setHover(null)}>
      <div className="mc-head">
        <button type="button" className="mc-title" onClick={() => setPage("history")} title="Open History">
          {month.toLocaleDateString(undefined, { month: "short", year: "numeric" })}
        </button>
        <span className="mc-total num">{monthTotal > 0 ? bytes(monthTotal) : ""}</span>
        <button type="button" className="mc-nav" aria-label="Previous month" onClick={() => shift(-1)}>
          <ChevronLeft size={12} />
        </button>
        <button type="button" className="mc-nav" aria-label="Next month" disabled={month.getTime() >= thisMonth} onClick={() => shift(1)}>
          <ChevronRight size={12} />
        </button>
      </div>
      <div className="mc-grid" role="grid" aria-label={`Transfers in ${month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}`}>
        {weekdays.map((w, i) => (
          <span key={`w${i}`} className="mc-wd" role="columnheader">{w}</span>
        ))}
        {cells.map((d, i) => {
          if (!d) return <span key={i} className="mc-day blank" />;
          const k = dayKey(d.getTime());
          const a = days.get(k);
          const total = a?.total ?? 0;
          const future = d.getTime() > now.getTime();
          return (
            <button
              key={i}
              type="button"
              role="gridcell"
              className={`cal-day mc-day ${k === todayKey ? "today" : ""} ${future ? "future" : ""} ${total ? "has" : ""}`}
              disabled={!total}
              aria-label={`${d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}: ${total ? `${bytes(total)} in ${a!.entries.length} transfer${a!.entries.length === 1 ? "" : "s"}` : "nothing moved"}`}
              onClick={() => {
                setHover(null);
                openHistoryOn(d.getTime());
                setPage("history");
              }}
              onPointerEnter={(e) => total && e.pointerType === "mouse" && showTip(k, e.currentTarget)}
              onFocus={(e) => total && showTip(k, e.currentTarget)}
              onBlur={() => setHover(null)}
            >
              {total > 0 && <DayLevel i={i} inB={a!.inBytes} outB={a!.outBytes} max={max} />}
              <span className="cal-num num">{d.getDate()}</span>
            </button>
          );
        })}
      </div>
      {tip &&
        hover &&
        createPortal(
          <div className="mini-tip-layer">
            <EntriesTip
              x={hover.x}
              y={hover.y}
              below={hover.below}
              title={fmtDay(tip.date.getTime(), { weekday: "long", month: "short", day: "numeric" })}
              entries={tip.entries}
              inB={tip.inBytes}
              outB={tip.outBytes}
              split
              foot={`With ${Array.from(new Set(tip.entries.map((e) => e.peerName))).join(", ")}`}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}
