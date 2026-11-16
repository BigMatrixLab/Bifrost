import { open } from "@tauri-apps/plugin-dialog";

let platform = "windows";

export function setPlatform(p: string) {
  platform = p;
  document.documentElement.dataset.platform = p;
}

export function isAndroid(): boolean {
  return platform === "android";
}

/** `files`: pick any number of files instead of one folder. */
export type PickRequest = { title: string; start?: string; files?: boolean; resolve: (paths: string[] | null) => void };
let host: ((r: PickRequest) => void) | null = null;

/** Registered by <FolderPickerHost/>; used on Android where no native folder dialog returns real paths. */
export function registerPickerHost(fn: ((r: PickRequest) => void) | null) {
  host = fn;
}

/** Asks the user for a folder: system dialog on desktop, in-app browser on Android. */
export async function pickFolder(title: string, start?: string): Promise<string | null> {
  if (!isAndroid()) {
    const p = await open({ directory: true, multiple: false, title, defaultPath: start || undefined });
    return typeof p === "string" ? p : null;
  }
  return new Promise((resolve) => {
    if (!host) return resolve(null);
    host({ title, start, resolve: (p) => resolve(p?.[0] ?? null) });
  });
}

/** Asks the user for one or more files: system dialog on desktop, in-app browser on Android. */
export async function pickFiles(title: string): Promise<string[]> {
  if (!isAndroid()) {
    const p = await open({ directory: false, multiple: true, title });
    if (!p) return [];
    return (Array.isArray(p) ? p : [p]).filter((x): x is string => typeof x === "string" && x.length > 0);
  }
  return new Promise((resolve) => {
    if (!host) return resolve([]);
    host({ title, files: true, resolve: (p) => resolve(p ?? []) });
  });
}
