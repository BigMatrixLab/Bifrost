import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pickFolder } from "../platform";
import { StorageAccessNotice } from "../android";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronRight,
  Download,
  File,
  FileArchive,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  FolderOpen,
  HardDrive,
  FolderPlus,
  FolderUp,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import { api, canDownload, canUpload, errorText, type RemoteEntry, type SharePermission } from "../api";
import { bytes, dateTime } from "../format";
import { useStore } from "../store";
import { Button, Empty, IconButton, Modal, usePhone } from "../ui";
import { isAndroid, pickFiles } from "../platform";
import { useSlide } from "../slide";

const ROW_DESK = 38;
const ROW_PHONE = 66;

/** "/storage/emulated/0/Download/Bifrost" -> "Phone storage › Download › Bifrost" */
function friendlyPath(p: string): string {
  const m = p.match(/^\/storage\/emulated\/0\/?(.*)$/);
  if (!m) return p;
  return ["Phone storage", ...m[1].split("/").filter(Boolean)].join(" › ");
}

function shortDate(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
}
const PAGE = 500;

function fileIcon(e: RemoteEntry) {
  if (e.isDir) return <Folder size={16} className="dir" />;
  const ext = e.name.split(".").pop()?.toLowerCase() ?? "";
  if (["zip", "7z", "rar", "tar", "gz", "xz", "iso", "img", "vhd", "vhdx"].includes(ext)) return <FileArchive size={16} />;
  if (["mp4", "mkv", "mov", "avi", "webm", "m4v"].includes(ext)) return <FileVideo size={16} />;
  if (["jpg", "jpeg", "png", "gif", "webp", "heic", "tif", "tiff", "raw", "dng"].includes(ext)) return <FileImage size={16} />;
  if (["txt", "md", "pdf", "doc", "docx", "csv", "json", "log"].includes(ext)) return <FileText size={16} />;
  return <File size={16} />;
}

type SortKey = "name" | "size" | "modified";

export default function Browser() {
  const { browse, settings, toast, setPage, remotes, pushes } = useStore();
  const known = remotes.find((r) => r.peerId === browse?.peerId)?.shares.find((s) => s.id === browse?.shareId)?.permission;
  const [perm, setPerm] = useState<SharePermission>(known ?? "download");
  const mayDownload = canDownload(perm);
  const mayUpload = canUpload(perm);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<RemoteEntry[] | null>(null);
  const [working, setWorking] = useState(false);
  const [path, setPath] = useState<string[]>([]);
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: "name", asc: true });
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  const [confirm, setConfirm] = useState(false);
  const [dest, setDest] = useState("");
  const [starting, setStarting] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const phone = usePhone();
  const sortSlide = useSlide<HTMLDivElement>("button", "button.on");
  const ROW = phone ? ROW_PHONE : ROW_DESK;
  const reqId = useRef(0);

  const load = useCallback(
    async (p: string[], offset: number) => {
      if (!browse) return;
      const id = ++reqId.current;
      setLoading(true);
      setError(null);
      try {
        const r = await api.listRemoteDir(browse.peerId, browse.shareId, p, offset, PAGE);
        if (id !== reqId.current) return;
        if (r.permission) setPerm(r.permission);
        setTotal(r.total);
        setEntries((prev) => (offset === 0 ? r.entries : [...prev, ...r.entries]));
      } catch (e) {
        if (id === reqId.current) setError(errorText(e));
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    },
    [browse],
  );

  useEffect(() => {
    setPath([]);
    setSelected(new Set());
    setEntries([]);
    if (known) setPerm(known);
    load([], 0);
    // `known` only seeds the permission; the listing reports the current one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browse, load]);

  // Show files as they finish uploading into this folder.
  const finished = pushes.filter((p) => p.peerId === browse?.peerId && p.shareId === browse?.shareId && p.status === "completed").length;
  const seenFinished = useRef(finished);
  const pathRef = useRef(path);
  pathRef.current = path;
  useEffect(() => {
    if (finished > seenFinished.current) {
      const t = window.setTimeout(() => load(pathRef.current, 0), 400);
      seenFinished.current = finished;
      return () => window.clearTimeout(t);
    }
    seenFinished.current = finished;
  }, [finished, load]);

  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const go = (p: string[]) => {
    setPath(p);
    setSelected(new Set());
    setEntries([]);
    setFilter("");
    body.current?.scrollTo({ top: 0 });
    load(p, 0);
  };

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const list = f ? entries.filter((e) => e.name.toLowerCase().includes(f)) : entries.slice();
    const dir = sort.asc ? 1 : -1;
    list.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      if (sort.key === "size") return (a.size - b.size) * dir;
      if (sort.key === "modified") return (a.modifiedMs - b.modifiedMs) * dir;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) * dir;
    });
    return list;
  }, [entries, filter, sort]);

  // Fetch the next page as the user nears the end of what's loaded.
  useEffect(() => {
    if (!loading && entries.length < total && scrollTop + viewH > entries.length * ROW - 20 * ROW) {
      load(path, entries.length);
    }
  }, [scrollTop, viewH, entries.length, total, loading, load, path]);

  if (!browse) {
    return (
      <div className="page">
        <div className="panel">
          <Empty icon={<FolderOpen size={20} />} title="Nothing open">
            Choose a shared folder in <a href="#" onClick={(e) => { e.preventDefault(); setPage("devices"); }}>Receive</a>.
          </Empty>
        </div>
      </div>
    );
  }

  const first = Math.max(0, Math.floor(scrollTop / ROW) - 8);
  const last = Math.min(shown.length, Math.ceil((scrollTop + viewH) / ROW) + 8);
  const sel = shown.filter((e) => selected.has(e.name));
  const selFiles = sel.filter((e) => !e.isDir);
  const selBytes = selFiles.reduce((s, e) => s + e.size, 0);
  const allSel = shown.length > 0 && shown.every((e) => selected.has(e.name));

  const toggle = (name: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });

  const sortBy = (key: SortKey) => setSort((s) => ({ key, asc: s.key === key ? !s.asc : key === "name" }));
  const arrow = (key: SortKey) => (sort.key === key ? sort.asc ? <ArrowUp size={12} /> : <ArrowDown size={12} /> : null);

  const startDownload = async () => {
    setStarting(true);
    try {
      const items = sel.map((e) => ({ path: [...path, e.name], isDir: e.isDir }));
      const ids = await api.startDownload(browse.peerId, browse.shareId, items, dest || null);
      setConfirm(false);
      setSelected(new Set());
      toast(`Queued ${ids.length} file(s). Track them in Transfers.`, "ok");
    } catch (e) {
      toast(errorText(e), "err");
    } finally {
      setStarting(false);
    }
  };

  const startUpload = async (paths: string[]) => {
    if (paths.length === 0) return;
    try {
      const ids = await api.startUpload(browse.peerId, browse.shareId, path, paths);
      toast(ids.length ? `Uploading ${ids.length} file(s) to ${browse.peerName}. Track them in Transfers.` : "Folder created. It had no files to upload.", "ok");
      if (ids.length === 0) load(path, 0);
    } catch (e) {
      toast(errorText(e), "err");
    }
  };
  const uploadFiles = async () => startUpload(await pickFiles(`Upload to “${path.length ? path[path.length - 1] : browse.shareName}”`));
  const uploadFolder = async () => {
    const p = await pickFolder("Choose a folder to upload");
    if (p) startUpload([p]);
  };
  const makeFolder = async () => {
    const name = (newFolder ?? "").trim();
    if (!name) return;
    setWorking(true);
    try {
      const made = await api.remoteMkdir(browse.peerId, browse.shareId, [...path, name]);
      setNewFolder(null);
      toast(`Created “${made}”`, "ok");
      load(path, 0);
    } catch (e) {
      toast(errorText(e), "err");
    } finally {
      setWorking(false);
    }
  };
  const deleteItems = async (items: RemoteEntry[]) => {
    setWorking(true);
    const deleted: string[] = [];
    try {
      for (const e of items) {
        try {
          await api.remoteDelete(browse.peerId, browse.shareId, [...path, e.name]);
          deleted.push(e.name);
        } catch (err) {
          toast(`${e.name}: ${errorText(err)}`, "err");
        }
      }
      if (deleted.length > 0) toast(deleted.length === 1 ? `Deleted “${deleted[0]}”` : `Deleted ${deleted.length} items`, "ok");
    } finally {
      setWorking(false);
      setConfirmDelete(null);
      setSelected(new Set());
      load(path, 0);
    }
  };
  const selMine = sel.length > 0 && sel.every((e) => e.mine);

  return (
    <div className="page" style={{ gap: 14 }}>
      {phone ? (
        <div className="m-browse-head">
          <div className="hstack">
            <IconButton label="Back" onClick={() => (path.length ? go(path.slice(0, -1)) : setPage("devices"))}>
              <ArrowLeft size={18} />
            </IconButton>
            <div className="stack grow" style={{ gap: 0 }}>
              <b className="truncate" style={{ fontSize: 16 }}>{path.length ? path[path.length - 1] : browse.shareName}</b>
              <span className="faint small truncate">
                {browse.peerName}
                {path.length > 0 ? ` · ${[browse.shareName, ...path.slice(0, -1)].join(" › ")}` : ""}
              </span>
            </div>
            {mayUpload && (
              <>
                <IconButton label="New folder" onClick={() => setNewFolder("")}>
                  <FolderPlus size={17} />
                </IconButton>
                <IconButton label="Upload folder" onClick={uploadFolder}>
                  <FolderUp size={17} />
                </IconButton>
                <IconButton label="Upload files" onClick={uploadFiles}>
                  <Upload size={17} />
                </IconButton>
              </>
            )}
            <IconButton label="Refresh" onClick={() => go(path)}>
              <RefreshCw size={17} className={loading ? "spin" : ""} />
            </IconButton>
          </div>
          <div className="search">
            <Search size={15} />
            <input placeholder="Search this folder" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search" enterKeyHint="search" />
          </div>
        </div>
      ) : (
      <div className="toolbar">
        <IconButton label="Up one level" disabled={path.length === 0} onClick={() => go(path.slice(0, -1))}>
          <ArrowLeft size={16} />
        </IconButton>
        <nav className="crumbs" aria-label="Folder path">
          <button className={`crumb ${path.length === 0 ? "last" : ""}`} onClick={() => go([])}>
            <HardDrive size={13} style={{ verticalAlign: -2, marginRight: 6 }} />
            {browse.shareName}
          </button>
          {path.map((p, i) => (
            <span key={i} className="hstack" style={{ gap: 2 }}>
              <ChevronRight size={14} className="faint" />
              <button className={`crumb ${i === path.length - 1 ? "last" : ""}`} onClick={() => go(path.slice(0, i + 1))}>{p}</button>
            </span>
          ))}
        </nav>
        <div className="search">
          <Search size={14} />
          <input placeholder="Filter this folder" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter" />
        </div>
        <IconButton label="Refresh" onClick={() => go(path)}>
          <RefreshCw size={15} className={loading ? "spin" : ""} />
        </IconButton>
        {mayUpload && (
          <>
            <IconButton label="New folder" onClick={() => setNewFolder("")}>
              <FolderPlus size={16} />
            </IconButton>
            <Button size="sm" icon={<FolderUp size={14} />} onClick={uploadFolder}>Upload folder</Button>
            <Button size="sm" variant="primary" icon={<Upload size={14} />} onClick={uploadFiles}>Upload files</Button>
          </>
        )}
      </div>
      )}

      {perm === "upload" && (
        <div className="notice">
          <Upload size={16} />
          <span>
            You can add files to <b>{browse.shareName}</b>. {browse.peerName} keeps the rest of the folder private, so you only see what you
            uploaded, and you can delete it again.
          </span>
        </div>
      )}

      {error ? (
        <div className="notice err">
          <RefreshCw size={16} />
          <span className="grow">{error}</span>
          <Button size="sm" onClick={() => go(path)}>Try again</Button>
        </div>
      ) : (
        <div className={`table ${mayUpload && mayDownload ? "acts2" : ""}`} role="grid" aria-rowcount={shown.length}>
          {phone ? (
            <div className="m-thead">
              <label className="hstack" style={{ gap: 10 }}>
                <input type="checkbox" aria-label="Select all" checked={allSel} onChange={() => setSelected(allSel ? new Set() : new Set(shown.map((e) => e.name)))} />
                <span className="small muted">{total} item{total === 1 ? "" : "s"}</span>
              </label>
              <div className="segmented sm slides" role="radiogroup" aria-label="Sort" ref={sortSlide}>
                {(["name", "size", "modified"] as SortKey[]).map((k) => (
                  <button key={k} type="button" role="radio" aria-checked={sort.key === k} className={sort.key === k ? "on" : ""} onClick={() => sortBy(k)}>
                    {k === "name" ? "Name" : k === "size" ? "Size" : "Date"} {sort.key === k ? arrow(k) : null}
                  </button>
                ))}
              </div>
            </div>
          ) : (
          <div className="thead" role="row">
            <span>
              <input
                type="checkbox"
                aria-label="Select all"
                checked={allSel}
                onChange={() => setSelected(allSel ? new Set() : new Set(shown.map((e) => e.name)))}
              />
            </span>
            <button onClick={() => sortBy("name")}>Name {arrow("name")}</button>
            <button onClick={() => sortBy("size")} style={{ justifySelf: "end" }}>Size {arrow("size")}</button>
            <button onClick={() => sortBy("modified")} style={{ justifySelf: "end" }}>Modified {arrow("modified")}</button>
            <span />
          </div>
          )}
          <div className="tbody" ref={body} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
            <div style={{ height: shown.length * ROW }} />
            {shown.slice(first, last).map((e, k) => {
              const i = first + k;
              const on = selected.has(e.name);
              if (phone) {
                return (
                  <div
                    key={e.name}
                    role="row"
                    className={`mrow ${on ? "sel" : ""}`}
                    style={{ top: i * ROW, height: ROW }}
                    onClick={() => (e.isDir ? go([...path, e.name]) : toggle(e.name))}
                  >
                    <span className={`mrow-ico ${e.isDir ? "dir" : ""}`}>{fileIcon(e)}</span>
                    <span className="stack grow" style={{ gap: 2 }}>
                      <span className="mrow-name">{e.name}</span>
                      <span className="faint small">
                        {e.isDir ? "Folder" : bytes(e.size)}
                        {e.modifiedMs ? ` · ${shortDate(e.modifiedMs)}` : ""}
                        {e.mine ? " · Uploaded by you" : ""}
                      </span>
                    </span>
                    <button
                      className={`mcheck ${on ? "on" : ""}`}
                      role="checkbox"
                      aria-checked={on}
                      aria-label={`Select ${e.name}`}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        toggle(e.name);
                      }}
                    >
                      {on && <Check size={15} strokeWidth={3} />}
                    </button>
                  </div>
                );
              }
              return (
                <div
                  key={e.name}
                  role="row"
                  className={`trow ${on ? "sel" : ""}`}
                  style={{ top: i * ROW }}
                  onDoubleClick={() => (e.isDir ? go([...path, e.name]) : toggle(e.name))}
                >
                  <span>
                    <input type="checkbox" aria-label={`Select ${e.name}`} checked={on} onChange={() => toggle(e.name)} />
                  </span>
                  <span className="name">
                    {fileIcon(e)}
                    {e.isDir ? (
                      <button className="crumb" style={{ padding: 0, color: "var(--text)", maxWidth: "100%" }} onClick={() => go([...path, e.name])}>
                        {e.name}
                      </button>
                    ) : (
                      <span className="truncate selectable" title={e.name}>{e.name}</span>
                    )}
                    {e.mine && <span className="perm-tag up" title="You uploaded this, so you can delete it">Yours</span>}
                  </span>
                  <span className="cell-r">{e.isDir ? "Folder" : bytes(e.size)}</span>
                  <span className="cell-r">{e.modifiedMs ? dateTime(e.modifiedMs) : "–"}</span>
                  <span className="row-acts">
                    {mayUpload && e.mine && (
                      <IconButton label={`Delete ${e.name}`} onClick={() => setConfirmDelete([e])}>
                        <Trash2 size={15} />
                      </IconButton>
                    )}
                    {mayDownload && (
                      <IconButton
                        label={`Download ${e.name}`}
                        onClick={() => {
                          setSelected(new Set([e.name]));
                          setDest(settings?.downloadDir ?? "");
                          setConfirm(true);
                        }}
                      >
                        <Download size={15} />
                      </IconButton>
                    )}
                  </span>
                </div>
              );
            })}
            {!loading && shown.length === 0 && (
              <Empty
                icon={<FolderOpen size={20} />}
                title={filter ? "No matches" : perm === "upload" ? "Nothing you uploaded is here" : "This folder is empty"}
              >
                {!filter && mayUpload && "Use Upload files or Upload folder to add something."}
              </Empty>
            )}
          </div>
        </div>
      )}

      {sel.length > 0 && (
        <div className={`selection-bar ${phone ? "m-selbar" : ""}`}>
          <span className="grow">
            <b>{sel.length}</b> selected{selFiles.length > 0 && <span className="muted"> · {bytes(selBytes)}{sel.length > selFiles.length ? " + folders" : ""}</span>}
          </span>
          <Button variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
          {mayUpload && selMine && (
            <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => setConfirmDelete(sel)}>
              Delete
            </Button>
          )}
          {mayDownload && (
            <Button variant="primary" icon={<Download size={15} />} onClick={() => { setDest(settings?.downloadDir ?? ""); setConfirm(true); }}>
              {phone ? "Download" : "Download selected"}
            </Button>
          )}
        </div>
      )}
      {total > entries.length && <span className="hint">Showing {entries.length} of {total} items. Scroll to load more.</span>}

      {newFolder !== null && (
        <Modal
          title="New folder"
          onClose={() => setNewFolder(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setNewFolder(null)}>Cancel</Button>
              <Button variant="primary" loading={working} disabled={!newFolder.trim()} icon={<FolderPlus size={15} />} onClick={makeFolder}>
                Create
              </Button>
            </>
          }
        >
          <div className="field">
            <span className="label">Name</span>
            <input
              className="input"
              autoFocus
              maxLength={200}
              placeholder="Folder name"
              value={newFolder}
              onChange={(e) => setNewFolder(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && makeFolder()}
            />
            <span className="hint">Created in {[browse.shareName, ...path].join(" › ")} on {browse.peerName}. You can delete it again later.</span>
          </div>
        </Modal>
      )}

      {confirmDelete && (
        <Modal
          title={confirmDelete.length === 1 ? `Delete “${confirmDelete[0].name}”?` : `Delete ${confirmDelete.length} items?`}
          onClose={() => !working && setConfirmDelete(null)}
          footer={
            <>
              <Button variant="ghost" disabled={working} onClick={() => setConfirmDelete(null)}>Keep</Button>
              <Button variant="danger" loading={working} icon={<Trash2 size={15} />} onClick={() => deleteItems(confirmDelete)}>
                Delete from {browse.peerName}
              </Button>
            </>
          }
        >
          <span>
            {confirmDelete.some((e) => e.isDir)
              ? "Folders are deleted with everything in them. "
              : ""}
            This removes {confirmDelete.length === 1 ? "it" : "them"} from {browse.peerName}'s computer and can't be undone. You can only delete what you
            uploaded; a folder that someone else added files to stays.
          </span>
        </Modal>
      )}

      {confirm && (
        <Modal
          title={isAndroid() ? "Download to this phone" : "Download to this computer"}
          onClose={() => setConfirm(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button>
              <Button variant="primary" loading={starting} icon={<Download size={15} />} onClick={startDownload}>Start download</Button>
            </>
          }
        >
          <StorageAccessNotice compact />
          <span>
            {sel.length === 1 ? <b>{sel[0].name}</b> : <b>{sel.length} items</b>}
            {selFiles.length > 0 && <span className="muted"> ({bytes(selBytes)}{sel.length > selFiles.length ? " plus folder contents" : ""})</span>}
          </span>
          <div className="field">
            <span className="label">Save to</span>
            <div className="hstack">
              {phone ? (
                <div className="dest-box grow">
                  <FolderOpen size={16} className="dir" />
                  <span className="grow" style={{ overflowWrap: "anywhere" }}>{friendlyPath(dest)}</span>
                </div>
              ) : (
                <input className="input mono" value={dest} onChange={(e) => setDest(e.target.value)} />
              )}
              <Button
                onClick={async () => {
                  const p = await pickFolder("Choose where to save", dest || undefined);
                  if (p) setDest(p);
                }}
              >
                Change…
              </Button>
            </div>
            <span className="hint">
              {phone
                ? "You can pause any time; it continues where it stopped."
                : "Files are written as “.rlpart” while downloading and renamed only after every byte is verified."}
            </span>
          </div>
        </Modal>
      )}
    </div>
  );
}
