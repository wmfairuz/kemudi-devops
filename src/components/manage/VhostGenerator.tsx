import { RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";

import { Btn } from "@/components/kit/Btn";
import { CodeEditor } from "@/components/kit/CodeEditor";
import { EnvTag } from "@/components/kit/EnvTag";
import { Hint } from "@/components/kit/Kbd";
import { Modal, ModalFooter, ModalHeader } from "@/components/kit/Modal";
import { Field, Segmented, TextInput } from "@/components/manage/fields";
import { triggerAction } from "@/lib/actions";
import { errorMessage, vhostCreate, vhostProbe, type Env, type VhostCreated, type VhostProbe } from "@/lib/ipc";
import { generateVhost, socketFor, vhostProblems, type HttpsMode, type VhostOptions } from "@/lib/nginxVhost";
import { cn } from "@/lib/utils";
import { askConfirm } from "@/stores/confirm";
import { toastError } from "@/stores/toasts";

export interface VhostRequest {
  serverId: string;
  env: Env;
  appId: string | null;
  appName: string;
  /** The app's folder (root = <path>/public). */
  path: string;
  php: string | null;
  onCreated?: () => void;
}

export const useVhostGenerator = create<{ request: VhostRequest | null; open(r: VhostRequest): void; close(): void }>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));

export function VhostGeneratorDialog() {
  const request = useVhostGenerator((s) => s.request);
  if (!request) return null;
  return <VhostGenerator key={`${request.serverId}/${request.path}`} request={request} />;
}

const splitDomains = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);

type Phase =
  | { kind: "probing" }
  | { kind: "error"; message: string }
  | { kind: "form" }
  | { kind: "creating" }
  | { kind: "done"; result: VhostCreated };

/** Inspect ▸ Web server ▸ New vhost…: a Laravel nginx vhost for this app,
 *  generated from a few choices, editable before it's created. */
function VhostGenerator({ request }: { request: VhostRequest }) {
  const { serverId, env, appId, appName, path, php } = request;
  const prod = env === "prod";
  const [probe, setProbe] = useState<VhostProbe | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "probing" });
  const [domains, setDomains] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [root, setRoot] = useState(`${path.replace(/\/+$/, "")}/public`);
  const [socket, setSocket] = useState("");
  const [https, setHttps] = useState<HttpsMode>("none");
  const [certName, setCertName] = useState("");
  const [maxBody, setMaxBody] = useState("64M");
  const [logs, setLogs] = useState(true);
  const [edited, setEdited] = useState<string | null>(null);
  const [typed, setTyped] = useState("");

  const load = () => {
    setPhase({ kind: "probing" });
    vhostProbe(serverId).then(
      (p) => {
        setProbe(p);
        setSocket(socketFor(p.phpSockets, php));
        setHttps(p.certbot ? "certbot" : "none");
        setPhase(p.nginx ? { kind: "form" } : { kind: "error", message: `No nginx with sites-available / sites-enabled on ${serverId}.` });
      },
      (e: unknown) => setPhase({ kind: "error", message: errorMessage(e) }),
    );
  };
  useEffect(load, [serverId]);

  const list = splitDomains(domains);
  const fileName = nameTouched ? name : (list[0] ?? "");
  // A certificate for the main domain, if the server has one.
  useEffect(() => {
    if (probe && list[0] && probe.certs.includes(list[0])) setCertName(list[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domains, probe]);

  const opts: VhostOptions = {
    domains: list,
    root,
    phpSocket: socket,
    https,
    certName,
    certbotOptions: probe?.certbotOptions ?? false,
    maxBody,
    logs,
    logName: fileName || "site",
  };
  const generated = useMemo(() => generateVhost(opts), [JSON.stringify(opts)]);
  const config = edited ?? generated;
  const problems = probe ? vhostProblems(opts, probe.sites, fileName) : [];
  const canCreate = problems.length === 0 && config.trim() !== "" && (!prod || typed === serverId) && phase.kind === "form";

  const createIt = async () => {
    if (!canCreate) return;
    setPhase({ kind: "creating" });
    try {
      const result = await vhostCreate(serverId, appId, fileName, config);
      setPhase({ kind: "done", result });
      if (result.outcome === "created") {
        request.onCreated?.();
        setProbe((p) => (p ? { ...p, sites: [...p.sites, fileName] } : p));
      }
    } catch (e) {
      toastError(errorMessage(e));
      setPhase({ kind: "form" });
    }
  };

  const close = async () => {
    if (phase.kind === "form" && (domains || edited) && !(await askConfirm("Discard this vhost?", "Nothing has been created on the server.", "Discard"))) return;
    useVhostGenerator.getState().close();
  };

  const select =
    "h-[30px] w-full rounded-lg border border-control-border bg-background px-2 font-mono text-[12px] text-foreground outline-none focus:border-primary/60";

  return (
    <Modal open onOpenChange={(o) => !o && void close()} title={`New vhost · ${appName}`} width={1040}>
      <ModalHeader>
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-semibold">New nginx vhost · {appName}</span>
          <span className="text-[12.5px] text-subtle-foreground">on {serverId}</span>
          <EnvTag env={env} />
        </div>
        <span className="text-[12.5px] text-muted-foreground">
          Laravel's recommended config. It's written to sites-available, linked into sites-enabled and checked with nginx -t; if that fails, it's removed
          again. Nothing reloads until you say so.
        </span>
      </ModalHeader>

      <div className="flex h-[min(64vh,600px)] border-t border-divider">
        {phase.kind === "probing" && <Center>Looking at {serverId}: PHP-FPM sockets, sites and certificates…</Center>}
        {phase.kind === "error" && (
          <Center>
            <span className="max-w-[560px] text-center text-env-prod-fg">{phase.message}</span>
            <Btn size="sm" variant="outline" onClick={load}>
              Try again
            </Btn>
          </Center>
        )}
        {(phase.kind === "form" || phase.kind === "creating") && probe && (
          <>
            <div className="flex w-[380px] flex-none flex-col gap-3 overflow-y-auto border-r border-divider p-4">
              <Field label="Domains" hint="The main one first, e.g. shop.example.com www.shop.example.com">
                {(id) => (
                  <TextInput id={id} autoFocus value={domains} placeholder="app.example.com" onChange={(e) => setDomains(e.target.value)} />
                )}
              </Field>
              <Field label="File name" hint="In /etc/nginx/sites-available">
                {(id) => (
                  <TextInput
                    id={id}
                    value={fileName}
                    placeholder="app.example.com"
                    onChange={(e) => {
                      setName(e.target.value);
                      setNameTouched(true);
                    }}
                  />
                )}
              </Field>
              <Field label="Root">{(id) => <TextInput id={id} value={root} onChange={(e) => setRoot(e.target.value)} />}</Field>
              <Field label="PHP-FPM" hint={probe.phpSockets.length ? undefined : "No PHP-FPM socket found in /run/php"}>
                {(id) => (
                  <select id={id} value={socket} onChange={(e) => setSocket(e.target.value)} className={select}>
                    {probe.phpSockets.length === 0 && <option value="">(none found)</option>}
                    {probe.phpSockets.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field
                label="HTTPS"
                hint={
                  https === "certbot"
                    ? "HTTP now; after it's created, Get certificate runs certbot --nginx, which adds HTTPS. DNS must already point here."
                    : https === "cert"
                      ? "Uses a Let's Encrypt certificate already on the server; HTTP redirects to HTTPS."
                      : "HTTP only."
                }
              >
                {() => (
                  <Segmented
                    label="HTTPS"
                    value={https}
                    onChange={setHttps}
                    options={[
                      { value: "none", label: "HTTP only" },
                      ...(probe.certs.length ? [{ value: "cert" as const, label: "Existing cert" }] : []),
                      ...(probe.certbot ? [{ value: "certbot" as const, label: "certbot after" }] : []),
                    ]}
                  />
                )}
              </Field>
              {https === "cert" && (
                <Field label="Certificate">
                  {(id) => (
                    <select id={id} value={certName} onChange={(e) => setCertName(e.target.value)} className={select}>
                      <option value="">Pick one…</option>
                      {probe.certs.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              )}
              <div className="grid grid-cols-2 gap-3">
                <Field label="Upload limit">{(id) => <TextInput id={id} value={maxBody} placeholder="1M" onChange={(e) => setMaxBody(e.target.value)} />}</Field>
                <label className="flex cursor-pointer items-center gap-2 pt-5 text-[12px] text-muted-foreground">
                  <input type="checkbox" checked={logs} onChange={(e) => setLogs(e.target.checked)} />
                  Own log files
                </label>
              </div>
              {problems.length > 0 && list.length > 0 && (
                <div className="rounded-lg bg-env-prod/8 px-3 py-2 text-[12px] leading-[17px] text-env-prod-fg">
                  {problems.map((p) => (
                    <div key={p}>{p}</div>
                  ))}
                </div>
              )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex h-9 flex-none items-center gap-2 border-b border-divider px-4 text-[12px] text-subtle-foreground">
                <span className="font-mono">/etc/nginx/sites-available/{fileName || "…"}</span>
                <span className="flex-1" />
                {edited !== null && (
                  <>
                    <span className="text-env-staging-fg">edited by hand</span>
                    <Btn size="sm" variant="ghost" onClick={() => setEdited(null)} title="Throw away your edits and generate it from the form again">
                      <RotateCcw className="size-3.5" /> Regenerate
                    </Btn>
                  </>
                )}
              </div>
              <CodeEditor value={config} onChange={(v) => setEdited(v === generated ? null : v)} lang="nginx" className="flex-1" />
            </div>
          </>
        )}
        {phase.kind === "done" && (
          <Center>
            {phase.result.outcome === "rejected" ? (
              <>
                <div className="max-w-[620px] text-center text-[13px] leading-5 text-env-prod-fg">
                  <span className="font-medium">nginx -t failed with it, so Kemudi removed it again.</span> Nothing changed on {serverId}.
                </div>
                <Output text={phase.result.check} />
              </>
            ) : (
              <>
                <div className="text-center text-[13px] leading-5">
                  <div className="font-medium text-status-up">Created and enabled</div>
                  <div className="selectable font-mono text-[11.5px] text-subtle-foreground">{phase.result.path}</div>
                </div>
                <div
                  className={cn(
                    "max-w-[620px] text-center text-[12.5px]",
                    phase.result.wasFailing ? "text-env-staging-fg" : "text-muted-foreground",
                  )}
                >
                  {phase.result.wasFailing
                    ? "nginx -t was already failing before this, so Kemudi kept it. Check the output before reloading."
                    : "nginx -t passes. nginx serves it after a reload."}
                </div>
                <Output text={phase.result.check} />
                <div className="flex gap-2">
                  {!phase.result.wasFailing && (
                    <Btn
                      variant="primary"
                      onClick={() => {
                        useVhostGenerator.getState().close();
                        void triggerAction({ serverId, appId: null, actionId: "web-reload:nginx" });
                      }}
                    >
                      Reload nginx now
                    </Btn>
                  )}
                  {https === "certbot" && (
                    <Btn
                      variant="outline"
                      onClick={() => {
                        useVhostGenerator.getState().close();
                        void triggerAction({ serverId, appId: null, actionId: `certbot:${list.join(",")}` });
                      }}
                      title="sudo certbot --nginx -d … (after nginx has reloaded; DNS must point here)"
                    >
                      Get certificate (certbot)
                    </Btn>
                  )}
                </div>
                {https === "certbot" && (
                  <div className="max-w-[560px] text-center text-[11.5px] text-subtle-foreground">
                    Reload nginx first, then get the certificate: certbot asks Let's Encrypt to reach {list[0]} over HTTP.
                  </div>
                )}
              </>
            )}
          </Center>
        )}
      </div>

      <ModalFooter>
        {(phase.kind === "form" || phase.kind === "creating") && (
          <>
            {prod ? (
              <input
                value={typed}
                spellCheck={false}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void createIt()}
                placeholder={`type ${serverId} to create`}
                aria-label="Type the server name to create"
                className={cn(
                  "h-[30px] w-[240px] rounded-lg border bg-background px-2.5 font-mono text-[12.5px] outline-none placeholder:text-faint-foreground",
                  typed === serverId ? "border-env-prod/70" : "border-control-border",
                )}
              />
            ) : null}
            <span className="flex-1" />
            <Btn variant="outline" className="pr-2.5" onClick={() => void close()}>
              Cancel <Hint>esc</Hint>
            </Btn>
            <Btn variant={prod ? "danger" : "primary"} disabled={!canCreate} onClick={() => void createIt()}>
              {phase.kind === "creating" ? "Creating…" : `Create on ${serverId}`}
            </Btn>
          </>
        )}
        {phase.kind === "done" && phase.result.outcome === "rejected" && (
          <>
            <span className="flex-1" />
            <Btn variant="primary" onClick={() => setPhase({ kind: "form" })}>
              Back to the form
            </Btn>
          </>
        )}
        {(phase.kind === "probing" || phase.kind === "error" || (phase.kind === "done" && phase.result.outcome === "created")) && (
          <>
            <span className="flex-1" />
            <Btn variant="outline" onClick={() => useVhostGenerator.getState().close()}>
              {phase.kind === "done" ? "Done" : "Close"}
            </Btn>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}

function Output({ text }: { text: string }) {
  return (
    <pre className="selectable max-h-[160px] w-[620px] max-w-full overflow-auto rounded-md border border-divider bg-background px-3 py-2 font-mono text-[11.5px] leading-[17px] whitespace-pre-wrap text-foreground">
      {text}
    </pre>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-1 flex-col items-center justify-center gap-3 overflow-y-auto px-6 py-4 text-[13px] text-muted-foreground">{children}</div>;
}
