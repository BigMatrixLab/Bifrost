/**
 * HUD build: one palette, the teal glass board from the reference image.
 * `data-theme` stays "dark" so the globe and graphs keep their dark rendering;
 * `data-skin="teal"` drives the globe colours in hud.tsx.
 */
export function applyTheme() {
  document.documentElement.dataset.theme = "dark";
  document.documentElement.dataset.skin = "teal";
}
