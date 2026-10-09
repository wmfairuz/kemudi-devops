import { Btn } from "@/components/kit/Btn";
import { configOpen, configReload, errorMessage, type ConfigSnapshot } from "@/lib/ipc";
import { toastError } from "@/stores/toasts";

/** Render `backtick` spans as highlighted tokens (design frame 1c). */
function Highlighted({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]*`)/).map((part, i) =>
        part.startsWith("`") && part.endsWith("`") && part.length > 1 ? (
          <span key={i} className="rounded-[3px] bg-env-prod/15 px-[3px] text-env-prod-fg">
            {part.slice(1, -1)}
          </span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

const run = (p: Promise<unknown>) => void p.catch((e) => toastError(errorMessage(e)));

export function ConfigBanner({ snapshot }: { snapshot: ConfigSnapshot }) {
  const first = snapshot.errors[0];
  if (!first) return null;
  // Only when the file was broken by hand: then opening it is the fix.
  const where = first.line ? `Settings file, line ${first.line}: ` : "Settings file: ";
  const more = snapshot.errors.length - 1;

  return (
    <div className="mx-2.5 mt-1 mb-1.5 flex flex-col gap-[7px] rounded-[7px] border border-env-prod-line bg-env-prod/8 p-2.5">
      <div className="flex items-start gap-2">
        <span className="mt-px size-3.5 flex-none rounded-full bg-env-prod text-center text-[10px] leading-[14px] font-bold text-background">
          !
        </span>
        <div className="selectable font-mono text-[11.5px] leading-4 text-env-prod-btn-fg">
          {where}
          <Highlighted text={first.message} />
          {first.path && <span className="text-dim-foreground"> ({first.path})</span>}
        </div>
      </div>
      <div className="pl-[22px] text-[11.5px] leading-4 text-muted-foreground">
        {snapshot.stale && snapshot.loadedAt
          ? `Showing last good config from ${snapshot.loadedAt.slice(0, 5)}.`
          : "Fix the file and save; Kemudi reloads it automatically."}
        {first.suggestion && (
          <>
            {" "}
            Did you mean <span className="font-mono text-foreground">{first.suggestion}</span>?
          </>
        )}
        {more > 0 && ` (+${more} more)`}
      </div>
      <div className="flex gap-1.5 pl-[22px]">
        <Btn size="sm" onClick={() => run(configOpen(first.line))}>
          {first.line ? `Open at line ${first.line}` : "Open file"}
        </Btn>
        <Btn size="sm" variant="ghost" onClick={() => run(configReload())}>
          Reload
        </Btn>
      </div>
    </div>
  );
}

export function ConfigWarnings({ snapshot }: { snapshot: ConfigSnapshot }) {
  if (snapshot.warnings.length === 0) return null;
  return (
    <details className="mx-2.5 mb-1.5 rounded-[7px] border border-env-staging-line bg-env-staging-tint px-2.5 py-1.5 text-[11.5px] text-env-staging-btn-fg">
      <summary className="cursor-default">
        {snapshot.warnings.length} template warning{snapshot.warnings.length > 1 ? "s" : ""}
      </summary>
      <ul className="selectable mt-1.5 flex flex-col gap-1 font-mono text-[10.5px] leading-[15px] text-muted-foreground">
        {snapshot.warnings.map((w, i) => (
          <li key={i}>
            {w.line ? `line ${w.line}: ` : ""}
            {w.message}
          </li>
        ))}
      </ul>
    </details>
  );
}
