import { bindEmit, data } from "./core";

// Demo backend events: a download and an upload whose speeds wander, so the
// live graph moves in the preview build.
export type UnlistenFn = () => void;
type Cb = (e: { payload: any }) => void;
const subs: Record<string, Set<Cb>> = {};
let started = false;

function emit(name: string, payload: unknown) {
  subs[name]?.forEach((cb) => cb({ payload }));
}
bindEmit(emit);

function start() {
  if (started) return;
  started = true;
  let i = 0;
  window.setInterval(() => {
    i++;
    const tickJob = (id: string, bps: number) => {
      const j = data.list_jobs.find((x: any) => x.id === id);
      if (!j || j.status !== "downloading") return;
      j.speedBps = bps;
      j.doneBytes = Math.min(j.size, j.doneBytes + bps);
      j.verifiedBytes = j.doneBytes;
      j.verifiedChunks = Math.floor(j.doneBytes / (16 * 1024 * 1024));
      j.etaSecs = bps > 0 ? Math.round((j.size - j.doneBytes) / bps) : null;
      emit("job-updated", { ...j });
    };
    tickJob("j1", (10.4 + 1.6 * Math.sin(i / 7) + 0.7 * Math.sin(i / 2.3)) * 1024 * 1024);
    tickJob("j2", (0.9 + 0.12 * Math.sin(i / 3)) * 1024 * 1024);
    const up = (3.1 + 0.9 * Math.sin(i / 5) + 0.3 * Math.cos(i / 1.7)) * 1024 * 1024;
    const relayUp = (0.8 + 0.1 * Math.sin(i / 4)) * 1024 * 1024;
    const step = (id: string, bps: number) => {
      const o = data.list_outgoing.find((x: any) => x.id === id);
      if (!o || o.status !== "sending") return;
      o.sentBytes = Math.min(o.size, o.sentBytes + bps);
      o.bps = bps;
      o.updatedAt = Date.now();
    };
    step("o1", up);
    step("o4", relayUp);
    emit("outgoing", data.list_outgoing.map((x: any) => ({ ...x })));
    emit("uploads", [
      { peerId: "77aa88bb99", deviceName: "Lena's laptop", bps: up, totalSent: 4.2 * 1024 ** 3 + i * up, files: ["scene-014-take-2.mov"] },
      { peerId: "55cc66dd77", deviceName: "Studio-iMac", bps: relayUp, totalSent: 0.7 * 1024 ** 3 + i * relayUp, files: ["proxy-edit-v3.mp4"] },
    ]);
  }, 1000);
}

export async function listen<T>(e: string, cb: (e: { payload: T }) => void): Promise<UnlistenFn> {
  (subs[e] ??= new Set()).add(cb as Cb);
  start();
  return () => subs[e]?.delete(cb as Cb);
}
