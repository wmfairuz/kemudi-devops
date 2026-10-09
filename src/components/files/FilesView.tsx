import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ArrowLeft, ArrowUp, ClipboardPaste, Eye, EyeOff, File, FilePlus, FileSymlink, Folder, FolderPlus, FolderSymlink, RotateCw, Search, SquareTerminal, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { EnvTag } from "@/components/kit/EnvTag";
import { PopupMenu, type MenuItem } from "@/components/kit/PopupMenu";
import { useFileEditor } from "@/components/manage/FileEditor";

import { ChmodDialog, octalOf } from "./ChmodDialog";
import { ChownDialog } from "./ChownDialog";
import { DeleteDialog, NewItemDialog, RenameDialog } from "./FileOpsDialogs";
import { copyText } from "@/lib/clipboard";
import { downloadDir, shortPath } from "@/lib/downloads";
import { errorMessage, filesChooseFolder, filesDownload, filesFind, filesList, filesPaste, filesReveal, filesUpload, type FileEntry, type FileListing, type FoundFile } from "@/lib/ipc";
import { useFileClip } from "@/stores/fileClip";
import { cn } from "@/lib/utils";
import { findServer, useConfig } from "@/stores/config";
import { askConfirm } from "@/stores/confirm";
import { openLogs, openSsh, useTabs, type Tab } from "@/stores/tabs";
import { toastError, useToasts } from "@/stores/toasts";

const isDir = (e: FileEntry) => e.kind === "dir" || e.toDir;
const isLog = (name: string) => /\.log(\.\d+)?$|\.log-\d{8,}$|^(syslog|messages)(\.\d+)?$/.test(name);
const join = (dir: string, name: string) => `${dir.replace(/\/+$/, "")}/${name}`;
const parentOf = (dir: string) => dir.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/";

function size(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function when(secs: number): string {
  const d = new Date(secs * 1000);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, {
    year: sameYear ? undefined : "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** A Files tab: browse a server's folders (sudo when they need it), open a
 *  file in the editor, download, upload by dropping files from Finder. */
export function FilesView({ tab, visible }: { tab: Tab; visible: boolean }) {
  const serverId = tab.serverId ?? "";
  const server = findServer(serverId);
  const [listing, setListing] = useState<FileListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [typed, setTyped] = useState(tab.cwd ?? "~");
  const [hidden, setHidden] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [back, setBack] = useState<string[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; entry: FileEntry } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [chown, setChown] = useState<FileEntry | null>(null);
  const [chmod, setChmod] = useState<FileEntry | null>(null);
  const [renaming, setRenaming] = useState<FileEntry | null>(null);
  const [deleting, setDeleting] = useState<FileEntry | null>(null);
  /** New folder (true) / new file (false) dialog. */
  const [creating, setCreating] = useState<boolean | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const clip = useFileClip((s) => s.clip);
  const pasteable = clip && clip.serverId === serverId ? clip : null;
  /** The find bar (open) and its last results. */
  const [find, setFind] = useState<{ query: string; contents: boolean; skipDeps: boolean } | null>(null);
  const [found, setFound] = useState<{ dir: string; list: FoundFile[]; more: boolean; timedOut: boolean; contents: boolean } | null>(null);
  const [finding, setFinding] = useState(false);
  const findRef = useRef<HTMLInputElement>(null);

  const dir = listing?.dir ?? tab.cwd ?? "~";
  // The list uses the terminal's font (Settings ▸ Terminal).
  const term = useConfig((s) => s.snapshot?.config?.terminal);
  const font = { fontFamily: term?.fontFamily ?? 'Menlo, "SF Mono", monospace', fontSize: `${term?.fontSize ?? 14}px` };

  const load = async (to: string, remember = true) => {
    setLoading(true);
    try {
      const l = await filesList(serverId, to);
      if (remember && listing && l.dir !== listing.dir) setBack((b) => [...b.slice(-50), listing.dir]);
      setListing(l);
      setTyped(l.dir);
      setError(null);
      setSelected(null);
      // Find results belong to the folder they were found in.
      setFound((f) => (f && f.dir !== l.dir ? null : f));
      useTabs.getState().update(tab.id, { cwd: l.dir });
    } catch (e) {
      setError(errorMessage(e));
      setTyped(listing?.dir ?? to);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load(tab.cwd ?? "~", false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  /** The app a path belongs to (its environment guards edits there). */
  const appFor = (path: string) =>
    server?.apps.find((a) => path === a.path.replace(/\/+$/, "") || path.startsWith(`${a.path.replace(/\/+$/, "")}/`));
  const envFor = (path: string) => appFor(path)?.env ?? server?.env ?? "dev";

  const openEntry = (e: FileEntry) => {
    const path = join(dir, e.name);
    if (isDir(e)) return void load(path);
    if (e.kind === "other") return toastError(`${e.name} isn't a regular file`);
    if (isLog(e.name)) return viewLog(path);
    editFile(path, e.name);
  };

  /** In the log viewer (follows the newest of laravel-*.log, error.log.1…). */
  const viewLog = (path: string) => {
    if (!server) return;
    const owner = appFor(path);
    openLogs(server, { appId: owner?.id ?? null, path, env: envFor(path), title: `${owner?.id ?? serverId} · logs` });
  };

  const editFile = (path: string, name: string) => {
    const owner = appFor(path);
    useFileEditor.getState().open({
      serverId,
      env: envFor(path),
      appId: owner?.id ?? null,
      title: `Edit ${name}`,
      choices: [{ label: path, target: { kind: "path", path } }],
      onSaved: () => void load(dir, false),
    });
  };

  /** `ask`: pick the folder this time (Download to…). A folder comes down
   *  as .tar.gz (`lean`: without vendor, node_modules, .git). */
  const download = async (e: FileEntry, ask = false, lean = false) => {
    const path = join(dir, e.name);
    const folder = isDir(e);
    let to = downloadDir();
    if (ask) {
      const picked = await filesChooseFolder(to).catch(() => null);
      if (!picked) return;
      to = picked;
    }
    useToasts.getState().push(folder ? `Packing ${e.name} on ${serverId}, then downloading…` : `Downloading ${e.name}…`, "info");
    try {
      const local = await filesDownload(serverId, path, to, folder, lean);
      useToasts.getState().push(`Downloaded ${local.split("/").pop()} to ${shortPath(local)}`, "info", {
        label: "Show in Finder",
        run: () => void filesReveal(local).catch((err) => toastError(errorMessage(err))),
      });
    } catch (err) {
      toastError(errorMessage(err));
    }
  };

  const terminalHere = (at: string) => {
    if (!server) return;
    openSsh(server.host, {
      serverId,
      prod: envFor(at) === "prod",
      title: `${serverId} · ${at.split("/").pop() || "/"}`,
      cwd: at,
      appId: appFor(at)?.id,
    });
  };

  const copyEntry = (e: FileEntry, cut: boolean) => {
    const path = join(dir, e.name);
    useFileClip.getState().set({ serverId, path, name: e.name, dir: isDir(e), cut });
    useToasts.getState().push(`${cut ? "Cut" : "Copied"} ${e.name}: open a folder and paste (⌘V)`, "info");
  };

  /** Paste what was copied / cut into `into` (the folder shown, or one in it). */
  const paste = async (into: string, src = pasteable) => {
    if (!src) return;
    const same = parentOf(src.path) === into.replace(/\/+$/, "");
    if (src.cut && same) return toastError(`${src.name} is already in ${into}`);
    const env = envFor(into) === "prod" || envFor(src.path) === "prod" ? "prod" : "other";
    if (src.cut && !(await askConfirm(`Move ${src.name}?`, `${src.path}\n→ ${into}/${src.name}${env === "prod" ? "\n\nThis is production." : ""}`, "Move"))) return;
    if (!src.cut && env === "prod" && !(await askConfirm(`Copy ${src.name}?`, `${src.path}\n→ ${into} (production)`, "Copy"))) return;
    useToasts.getState().push(`${src.cut ? "Moving" : "Copying"} ${src.name}…`, "info");
    try {
      const to = await filesPaste(serverId, src.path, into, src.cut, appFor(into)?.id ?? appFor(src.path)?.id ?? null);
      useToasts.getState().push(`${src.cut ? "Moved" : "Copied"} to ${to}`, "info");
      if (src.cut) useFileClip.getState().set(null);
      await load(dir, false);
      if (parentOf(to) === dir.replace(/\/+$/, "")) setSelected(to.split("/").pop() ?? null);
    } catch (e) {
      toastError(errorMessage(e));
    }
  };

  const runFind = async () => {
    if (!find || !find.query.trim() || !listing) return;
    setFinding(true);
    try {
      const r = await filesFind(serverId, listing.dir, find.query, find.contents, find.skipDeps);
      setFound({ dir: listing.dir, list: r.found, more: r.more, timedOut: r.timedOut, contents: find.contents });
    } catch (e) {
      toastError(errorMessage(e));
    } finally {
      setFinding(false);
    }
  };

  const openFound = (f: FoundFile) => {
    if (f.kind === "dir") {
      setFound(null);
      setFind(null);
      return void load(f.path);
    }
    const name = f.path.split("/").pop() ?? f.path;
    if (isLog(name)) viewLog(f.path);
    else editFile(f.path, name);
  };

  // ⌘F: the find bar.
  useEffect(() => {
    const onFind = (e: Event) => {
      if ((e as CustomEvent).detail !== tab.id) return;
      setFind((f) => f ?? { query: "", contents: false, skipDeps: true });
      setTimeout(() => findRef.current?.focus(), 0);
    };
    window.addEventListener("kemudi:files-find", onFind);
    return () => window.removeEventListener("kemudi:files-find", onFind);
  }, [tab.id]);

  const upload = async (paths: string[]) => {
    if (!listing || paths.length === 0) return;
    const target = listing.dir;
    const env = envFor(target);
    const names = paths.map((p) => p.split("/").pop() ?? p);
    const ok = await askConfirm(
      `Upload ${paths.length === 1 ? names[0] : `${paths.length} files`} to ${target}?`,
      `${env === "prod" ? "This is a production server. " : ""}On ${serverId}:\n${names.join("\n")}`,
      "Upload",
    );
    if (!ok) return;
    const owner = appFor(target)?.id ?? null;
    let done = 0;
    for (const p of paths) {
      const name = p.split("/").pop() ?? p;
      try {
        await filesUpload(serverId, p, target, false, owner);
        done++;
      } catch (e) {
        const msg = errorMessage(e);
        if (/already exists/.test(msg) && (await askConfirm(`Replace ${name}?`, `${join(target, name)} already exists on ${serverId}.`, "Replace"))) {
          try {
            await filesUpload(serverId, p, target, true, owner);
            done++;
          } catch (e2) {
            toastError(errorMessage(e2));
          }
        } else if (!/already exists/.test(msg)) {
          toastError(`${name}: ${msg}`);
        }
      }
    }
    if (done) useToasts.getState().push(`Uploaded ${done} file${done === 1 ? "" : "s"} to ${target}`, "info");
    void load(target, false);
  };

  // Files dropped from Finder onto this tab while it's in front.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let live = true;
    void getCurrentWebview()
      .onDragDropEvent((ev) => {
        if (!visibleRef.current) return;
        const p = ev.payload;
        if (p.type === "enter" || p.type === "over") setDragging(true);
        else if (p.type === "leave") setDragging(false);
        else if (p.type === "drop") {
          setDragging(false);
          void upload(p.paths);
        }
      })
      .then((u) => {
        if (live) unlisten = u;
        else u();
      });
    return () => {
      live = false;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listing?.dir, serverId]);

  const entries = (listing?.entries ?? []).filter((e) => !hidden || !e.name.startsWith("."));
  const menuItems = (e: FileEntry): MenuItem[][] => {
    const path = join(dir, e.name);
    return [
      isDir(e)
        ? [
            { label: "Open", run: () => void load(path) },
            { label: "Terminal here", run: () => terminalHere(path) },
            { label: "Download as .tar.gz", hint: shortPath(downloadDir()), run: () => void download(e) },
            { label: "Download without vendor, node_modules, .git", run: () => void download(e, false, true) },
          ]
        : [
            ...(isLog(e.name) ? [{ label: "Open in log viewer", run: () => viewLog(path) }] : []),
            { label: "Open in editor", run: () => editFile(path, e.name) },
            { label: "Download", hint: shortPath(downloadDir()), run: () => void download(e) },
            { label: "Download to…", run: () => void download(e, true) },
          ],
      [
        { label: "Copy", hint: "⌘C", run: () => copyEntry(e, false) },
        { label: "Cut", hint: "⌘X", run: () => copyEntry(e, true) },
        { label: "Duplicate", run: () => void paste(dir, { serverId, path, name: e.name, dir: isDir(e), cut: false }) },
        ...(pasteable && isDir(e) ? [{ label: `Paste ${pasteable.name} into ${e.name}`, run: () => void paste(path) }] : []),
      ],
      [
        { label: "Rename…", hint: "F2", run: () => setRenaming(e) },
        { label: "Delete…", hint: "⌘⌫", run: () => setDeleting(e) },
      ],
      [
        { label: "Change owner…", hint: `${e.owner}:${e.group}`, run: () => setChown(e) },
        ...(e.kind === "link" ? [] : [{ label: "Change permissions…", hint: octalOf(e.mode), run: () => setChmod(e) }]),
      ],
      [
        { label: "Copy path", run: () => void copyText(path).then(() => useToasts.getState().push(`Copied ${path}`, "info")) },
        { label: "Copy name", run: () => void copyText(e.name) },
      ],
    ];
  };

  const iconOf = (e: FileEntry) => {
    const cls = "size-[1.1em] flex-none";
    if (e.kind === "dir") return <Folder className={cn(cls, "text-[#6b4fd8]")} strokeWidth={1.75} />;
    if (e.kind === "link") return e.toDir ? <FolderSymlink className={cn(cls, "text-[#6b4fd8]")} strokeWidth={1.75} /> : <FileSymlink className={cn(cls, "text-subtle-foreground")} strokeWidth={1.75} />;
    return <File className={cn(cls, "text-subtle-foreground")} strokeWidth={1.75} />;
  };

  return (
    <div
      className={cn("light-ui absolute inset-0 flex flex-col bg-background text-foreground", dragging && "ring-2 ring-primary ring-inset")}
      onKeyDown={(ev) => {
        if (ev.metaKey && ev.shiftKey && ev.code === "KeyN") {
          ev.preventDefault();
          if (listing) setCreating(true);
          return;
        }
        if (ev.metaKey && !ev.shiftKey && ev.key === "v" && !(ev.target instanceof HTMLInputElement) && pasteable && listing) {
          ev.preventDefault();
          void paste(listing.dir);
          return;
        }
        if (ev.key === "Escape" && found) {
          setFound(null);
          return;
        }
        if ((ev.key === "Backspace" || (ev.metaKey && ev.key === "ArrowUp")) && !(ev.target instanceof HTMLInputElement)) {
          ev.preventDefault();
          void load(parentOf(dir));
        }
      }}
      tabIndex={-1}
    >
      <div className="flex h-11 flex-none items-center gap-1.5 border-b border-divider px-3">
        <Btn size="sm" variant="ghost" disabled={back.length === 0} title="Back" aria-label="Back" onClick={() => {
          const prev = back[back.length - 1];
          if (prev) {
            setBack((b) => b.slice(0, -1));
            void load(prev, false);
          }
        }}>
          <ArrowLeft className="size-4" />
        </Btn>
        <Btn size="sm" variant="ghost" disabled={dir === "/"} title="Up (⌫)" aria-label="Up" onClick={() => void load(parentOf(dir))}>
          <ArrowUp className="size-4" />
        </Btn>
        <form
          className="min-w-0 flex-1"
          onSubmit={(ev) => {
            ev.preventDefault();
            if (typed.trim()) void load(typed.trim());
          }}
        >
          <input
            value={typed}
            onChange={(ev) => setTyped(ev.target.value)}
            spellCheck={false}
            aria-label="Folder"
            className="h-7 w-full rounded-md border border-control-border bg-background px-2 font-mono text-[12px] outline-none focus:border-primary/60"
          />
        </form>
        {server && <EnvTag env={envFor(dir)} />}
        {listing?.sudo && <span className="rounded bg-env-staging/15 px-1.5 text-[10.5px] text-env-staging-fg" title="This folder needs root: listed with sudo">sudo</span>}
        <Btn size="sm" variant="ghost" title={hidden ? "Show hidden files" : "Hide hidden files"} aria-label="Hidden files" onClick={() => setHidden((h) => !h)}>
          {hidden ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
        </Btn>
        <Btn size="sm" variant="ghost" title="Refresh" aria-label="Refresh" onClick={() => void load(dir, false)}>
          <RotateCw className={cn("size-4", loading && "animate-spin")} />
        </Btn>
        <Btn
          size="sm"
          variant="ghost"
          title="Find by name or contents (⌘F)"
          aria-label="Find"
          onClick={() => {
            setFind((f) => (f ? null : { query: "", contents: false, skipDeps: true }));
            if (find) setFound(null);
            setTimeout(() => findRef.current?.focus(), 0);
          }}
        >
          <Search className="size-4" />
        </Btn>
        <Btn size="sm" variant="ghost" title="New folder (⇧⌘N)" onClick={() => setCreating(true)} disabled={!listing}>
          <FolderPlus className="size-4" />
        </Btn>
        <Btn size="sm" variant="ghost" title="New file" onClick={() => setCreating(false)} disabled={!listing}>
          <FilePlus className="size-4" />
        </Btn>
        {pasteable && (
          <span className="flex items-center">
            <Btn size="sm" variant="outline" className="rounded-r-none" disabled={!listing} title={`${pasteable.cut ? "Move" : "Copy"} ${pasteable.path} here (⌘V)`} onClick={() => listing && void paste(listing.dir)}>
              <ClipboardPaste className="size-3.5" /> Paste <span className="max-w-[10em] truncate">{pasteable.name}</span>
              {pasteable.cut && <span className="text-subtle-foreground">(move)</span>}
            </Btn>
            <Btn size="sm" variant="outline" className="rounded-l-none border-l-0 px-1" title="Forget what was copied" aria-label="Forget what was copied" onClick={() => useFileClip.getState().set(null)}>
              <X className="size-3" />
            </Btn>
          </span>
        )}
        <Btn size="sm" variant="outline" title="An ssh tab in this folder" onClick={() => terminalHere(dir)}>
          <SquareTerminal className="size-3.5" /> Terminal here
        </Btn>
      </div>
      {error && <div className="flex-none bg-env-prod/8 px-4 py-2 text-[12px] text-env-prod-fg">{error}</div>}
      {find && (
        <form
          className="flex flex-none items-center gap-2 border-b border-divider bg-panel px-3 py-1.5 text-[12px]"
          onSubmit={(ev) => {
            ev.preventDefault();
            void runFind();
          }}
        >
          <div className="flex h-7 items-center rounded-md border border-control-border p-0.5" role="group" aria-label="Find by">
            {([false, true] as const).map((c) => (
              <button
                key={String(c)}
                type="button"
                onClick={() => setFind({ ...find, contents: c })}
                className={cn("h-full cursor-pointer rounded px-2", find.contents === c ? "bg-selected text-foreground" : "text-subtle-foreground hover:text-foreground")}
              >
                {c ? "Contents" : "Name"}
              </button>
            ))}
          </div>
          <input
            ref={findRef}
            value={find.query}
            onChange={(ev) => setFind({ ...find, query: ev.target.value })}
            onKeyDown={(ev) => {
              if (ev.key === "Escape") {
                ev.stopPropagation();
                if (found) setFound(null);
                else setFind(null);
              }
            }}
            placeholder={find.contents ? "Text in files (any case)" : "Part of a name (any case; * and ? work)"}
            spellCheck={false}
            className="h-7 min-w-0 flex-1 rounded-md border border-control-border bg-background px-2 font-mono text-[12px] outline-none focus:border-primary/60"
          />
          <label className="flex cursor-pointer items-center gap-1.5 text-subtle-foreground">
            <input type="checkbox" checked={find.skipDeps} onChange={(ev) => setFind({ ...find, skipDeps: ev.target.checked })} />
            skip vendor, node_modules, .git
          </label>
          <Btn size="sm" variant="primary" type="submit" disabled={!find.query.trim() || finding || !listing}>
            {finding ? "Finding…" : `Find in ${(listing?.dir ?? dir).split("/").pop() || "/"}`}
          </Btn>
          <Btn size="sm" variant="ghost" aria-label="Close find" onClick={() => {
            setFind(null);
            setFound(null);
          }}>
            <X className="size-3.5" />
          </Btn>
        </form>
      )}
      <div
        className={cn("grid flex-none grid-cols-[minmax(0,1fr)_6.5em_11em_8em_13em] gap-3 border-b border-divider px-4 py-1.5 text-[0.8em] font-medium text-subtle-foreground", found && "hidden")}
        style={font}
      >
        <span>Name</span>
        <span className="text-right">Size</span>
        <span>Modified</span>
        <span>Permissions</span>
        <span>Owner</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" style={font}>
        {found && (
          <div className="flex flex-col">
            <div className="flex items-center gap-2 px-4 py-1.5 text-[0.8em] text-subtle-foreground">
              {found.list.length === 0
                ? `Nothing ${found.contents ? "contains that" : "is named like that"} in ${found.dir}${found.timedOut ? " (stopped after 25 s)" : ""}.`
                : `${found.list.length}${found.more ? "+" : ""} ${found.contents ? "matching lines" : "found"} in ${found.dir}${found.more ? " (the first 500)" : ""}${found.timedOut ? " (stopped after 25 s)" : ""}`}
              <span className="flex-1" />
              <button className="cursor-pointer text-primary hover:underline" onClick={() => setFound(null)}>
                Back to the folder
              </button>
            </div>
            {found.list.map((f, i) => {
              const rel = f.path.startsWith(`${found.dir.replace(/\/+$/, "")}/`) ? f.path.slice(found.dir.replace(/\/+$/, "").length + 1) : f.path;
              const key = `${f.path}:${f.line ?? ""}:${i}`;
              return (
                <div
                  key={key}
                  role="row"
                  tabIndex={0}
                  onClick={() => setSelected(key)}
                  onDoubleClick={() => openFound(f)}
                  onKeyDown={(ev) => ev.key === "Enter" && openFound(f)}
                  title={f.kind === "dir" ? `Open ${f.path}` : `Open ${f.path}${f.line ? ` (line ${f.line})` : ""}`}
                  className={cn("flex min-w-0 cursor-default items-baseline gap-2 px-4 py-[0.32em] outline-none", selected === key ? "bg-selected" : "hover:bg-hover")}
                >
                  {f.kind === "dir" ? <Folder className="size-[1.1em] flex-none self-center text-[#6b4fd8]" strokeWidth={1.75} /> : <File className="size-[1.1em] flex-none self-center text-subtle-foreground" strokeWidth={1.75} />}
                  <span className={cn("truncate", found.contents && "max-w-[45%] flex-none")}>{rel}</span>
                  {f.line != null && <span className="flex-none text-[0.85em] text-subtle-foreground">:{f.line}</span>}
                  {f.text != null && <span className="min-w-0 truncate text-[0.9em] text-muted-foreground">{f.text}</span>}
                </div>
              );
            })}
          </div>
        )}
        {!found && listing && entries.length === 0 && (
          <div className="px-4 py-6 text-[0.9em] text-subtle-foreground">{listing.entries.length ? "Only hidden files here." : "Empty folder."}</div>
        )}
        {!found && entries.map((e) => (
          <div
            key={e.name}
            role="row"
            onClick={() => setSelected(e.name)}
            onDoubleClick={() => openEntry(e)}
            onContextMenu={(ev) => {
              ev.preventDefault();
              setSelected(e.name);
              setMenu({ x: ev.clientX, y: ev.clientY, entry: e });
            }}
            onKeyDown={(ev) => {
              if (ev.key === "Enter") openEntry(e);
              else if (ev.key === "F2") setRenaming(e);
              else if (ev.metaKey && (ev.key === "c" || ev.key === "x") && !window.getSelection()?.toString()) {
                ev.preventDefault();
                ev.stopPropagation();
                copyEntry(e, ev.key === "x");
              }
              else if (ev.key === "Backspace" && ev.metaKey) {
                ev.preventDefault();
                ev.stopPropagation();
                setDeleting(e);
              }
            }}
            tabIndex={0}
            title={e.target ? `${e.name} → ${e.target}` : e.name}
            className={cn(
              "grid cursor-default grid-cols-[minmax(0,1fr)_6.5em_11em_8em_13em] items-center gap-3 px-4 py-[0.32em] outline-none",
              selected === e.name ? "bg-selected" : "hover:bg-hover",
            )}
          >
            <span className="flex min-w-0 items-center gap-2">
              {iconOf(e)}
              <span className="truncate">{e.name}</span>
              {e.target && <span className="truncate text-[0.85em] text-subtle-foreground">→ {e.target}</span>}
            </span>
            <span className="text-right text-[0.9em] text-muted-foreground">{isDir(e) ? "—" : size(e.size)}</span>
            <span className="text-[0.9em] text-muted-foreground">{when(e.mtime)}</span>
            <span className="text-[0.9em] text-muted-foreground">{e.mode}</span>
            <span className="truncate text-[0.9em] text-muted-foreground" title={`owner ${e.owner}, group ${e.group}`}>
              {e.owner}:{e.group}
            </span>
          </div>
        ))}
        {listing?.truncated && <div className="px-4 py-2 text-[11.5px] text-subtle-foreground">Only the first 5000 entries are shown.</div>}
      </div>
      <div className="flex h-8 flex-none items-center gap-2 border-t border-divider px-4 text-[11.5px] text-subtle-foreground">
        <Upload className="size-3.5" />
        Drop files from Finder here to upload them to this folder · double-click to open · right-click for more
        <span className="flex-1" />
        {listing && `${entries.length} item${entries.length === 1 ? "" : "s"}`}
      </div>
      {menu && (
        <PopupMenu x={menu.x} y={menu.y} title={menu.entry.name} groups={menuItems(menu.entry)} onClose={() => setMenu(null)} />
      )}
      {creating !== null && listing && (
        <NewItemDialog
          serverId={serverId}
          env={envFor(listing.dir)}
          appId={appFor(listing.dir)?.id ?? null}
          dir={listing.dir}
          folder={creating}
          onClose={() => setCreating(null)}
          onCreated={(path) => {
            const name = path.split("/").pop() ?? path;
            useToasts.getState().push(`Created ${name}`, "info");
            void load(listing.dir, false);
            if (!creating) editFile(path, name);
          }}
        />
      )}
      {renaming && (
        <RenameDialog
          serverId={serverId}
          env={envFor(join(dir, renaming.name))}
          appId={appFor(join(dir, renaming.name))?.id ?? null}
          path={join(dir, renaming.name)}
          entry={renaming}
          onClose={() => setRenaming(null)}
          onDone={() => void load(dir, false)}
        />
      )}
      {deleting && (
        <DeleteDialog
          serverId={serverId}
          env={envFor(join(dir, deleting.name))}
          appId={appFor(join(dir, deleting.name))?.id ?? null}
          path={join(dir, deleting.name)}
          entry={deleting}
          onClose={() => setDeleting(null)}
          onDone={() => void load(dir, false)}
        />
      )}
      {chmod && (
        <ChmodDialog
          serverId={serverId}
          env={envFor(join(dir, chmod.name))}
          appId={appFor(join(dir, chmod.name))?.id ?? null}
          path={join(dir, chmod.name)}
          entry={chmod}
          onClose={() => setChmod(null)}
          onDone={() => void load(dir, false)}
        />
      )}
      {chown && (
        <ChownDialog
          serverId={serverId}
          env={envFor(join(dir, chown.name))}
          appId={appFor(join(dir, chown.name))?.id ?? null}
          path={join(dir, chown.name)}
          entry={chown}
          onClose={() => setChown(null)}
          onDone={() => void load(dir, false)}
        />
      )}
    </div>
  );
}
