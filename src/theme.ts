import { useCallback, useState } from "react";

export type Theme = "dark" | "light";

const KEY = "bifrost-theme";
/** The key used before the rename; read once so the choice carries over. */
const OLD_KEY = "relayless-theme";

export function storedTheme(): Theme {
  try {
    return (localStorage.getItem(KEY) ?? localStorage.getItem(OLD_KEY)) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
}

/** Current theme and a toggle that applies and remembers it. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const toggle = useCallback(() => {
    setTheme((cur) => {
      const next: Theme = cur === "dark" ? "light" : "dark";
      applyTheme(next);
      try {
        localStorage.setItem(KEY, next);
      } catch {
        /* storage unavailable: the choice lasts for this session */
      }
      return next;
    });
  }, []);
  return [theme, toggle];
}
