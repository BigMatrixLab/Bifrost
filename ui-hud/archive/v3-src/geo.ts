import { useEffect, useState } from "react";
import { api, type GeoLoc } from "./api";

/**
 * City-level locations of public IPs, for the Network globe. The engine does
 * the lookup (and caches it for a day); this keeps one answer per address
 * for the session so re-renders don't ask again. Failed lookups are retried
 * after ten minutes.
 */
const cache = new Map<string, { at: number; loc: Promise<GeoLoc | null> }>();
const RETRY_MS = 10 * 60e3;

function locate(ip: string): Promise<GeoLoc | null> {
  const hit = cache.get(ip);
  if (hit) return hit.loc;
  const loc = api.locateIp(ip).catch(() => null);
  const entry = { at: Date.now(), loc };
  cache.set(ip, entry);
  loc.then((l) => {
    if (!l) setTimeout(() => cache.get(ip) === entry && cache.delete(ip), RETRY_MS);
  });
  return loc;
}

/** Locations of the given IPs, keyed by IP. Unknown ones are missing. */
export function useLocations(ips: (string | null | undefined)[]): Record<string, GeoLoc> {
  const wanted = [...new Set(ips.filter((ip): ip is string => !!ip))].sort();
  const key = wanted.join(",");
  const [found, setFound] = useState<Record<string, GeoLoc>>({});
  useEffect(() => {
    let live = true;
    for (const ip of wanted) {
      locate(ip).then((loc) => {
        if (live && loc) setFound((f) => (f[ip] === loc ? f : { ...f, [ip]: loc }));
      });
    }
    return () => {
      live = false;
    };
    // `key` stands for `wanted`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return found;
}

/** "Dhaka, BD" or "Berlin, Germany"; empty when the service gave no names. */
export function placeName(l: GeoLoc | undefined): string {
  if (!l) return "";
  return [l.city || l.region, l.country].filter(Boolean).join(", ");
}
