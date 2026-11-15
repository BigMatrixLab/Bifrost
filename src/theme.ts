export type Theme = "dark" | "light";

/** The app has one palette (dark); `data-theme` still drives a few dark/light branches in the CSS and the globe. */
export function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
}
