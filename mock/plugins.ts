// Demo folder picker: there is no native dialog in a browser, so ask for a
// path (prefilled), the way the desktop dialog would return one.
let picks = 0;
export async function open(opts?: { title?: string; defaultPath?: string }) {
  picks++;
  const p = window.prompt(opts?.title || "Choose a folder", opts?.defaultPath || `D:\\Projects\\Demo folder ${picks}`);
  return p && p.trim() ? p.trim() : null;
}
export async function isEnabled() { return false; }
export async function enable() {}
export async function disable() {}
