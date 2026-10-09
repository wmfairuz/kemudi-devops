import { Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { addVar, duplicates, isSecret, parseEnv, removeLine, setLine, VALID_KEY, type EnvLine } from "@/lib/envFile";
import { cn } from "@/lib/utils";

/** Key/value rows over the text: edits change one line each, so comments,
 *  blank lines and order are kept. */
export function EnvTable({ text, onChange }: { text: string; onChange: (t: string) => void }) {
  const vars = useMemo(() => parseEnv(text), [text]);
  const dup = useMemo(() => duplicates(vars), [vars]);
  const [filter, setFilter] = useState("");
  const [shown, setShown] = useState<Set<number>>(new Set());
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const q = filter.trim().toLowerCase();
  const list = q ? vars.filter((v) => v.key.toLowerCase().includes(q)) : vars;
  const newKeyOk = VALID_KEY.test(newKey) && !vars.some((v) => v.key === newKey);

  const add = () => {
    if (!newKeyOk) return;
    onChange(addVar(text, newKey, newValue));
    setNewKey("");
    setNewValue("");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-5 py-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter keys"
          spellCheck={false}
          className="h-7 w-[220px] rounded-md border border-control-border bg-background px-2 font-mono text-[12px] outline-none placeholder:text-faint-foreground focus:border-primary/60"
        />
        <span className="text-[11.5px] text-subtle-foreground">
          {vars.length} variables · comments and blank lines are kept (edit them in Text)
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-2">
        {list.map((v) => (
          <Row
            key={v.index}
            v={v}
            dup={dup.has(v.key)}
            secretShown={shown.has(v.index)}
            onToggleShown={() => setShown((s) => (s.has(v.index) ? new Set([...s].filter((i) => i !== v.index)) : new Set(s).add(v.index)))}
            onSet={(key, value) => onChange(setLine(text, v.index, key, value))}
            onRemove={() => onChange(removeLine(text, v.index))}
            taken={(k) => k !== v.key && vars.some((o) => o.key === k)}
          />
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
        className="flex items-center gap-2 border-t border-divider px-5 py-2.5"
      >
        <input
          value={newKey}
          onChange={(e) => setNewKey(e.target.value.toUpperCase().replace(/\s/g, "_"))}
          placeholder="NEW_KEY"
          spellCheck={false}
          aria-label="New key"
          className={cn(
            "h-7 w-[260px] rounded-md border bg-background px-2 font-mono text-[12px] outline-none placeholder:text-faint-foreground focus:border-primary/60",
            newKey && !newKeyOk ? "border-env-prod/60" : "border-control-border",
          )}
        />
        <input
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          placeholder="value"
          spellCheck={false}
          aria-label="New value"
          className="h-7 min-w-0 flex-1 rounded-md border border-control-border bg-background px-2 font-mono text-[12px] outline-none placeholder:text-faint-foreground focus:border-primary/60"
        />
        <Btn size="sm" variant="outline" type="submit" disabled={!newKeyOk}>
          <Plus className="size-3.5" /> Add
        </Btn>
      </form>
    </div>
  );
}

function Row({
  v,
  dup,
  secretShown,
  onToggleShown,
  onSet,
  onRemove,
  taken,
}: {
  v: EnvLine;
  dup: boolean;
  secretShown: boolean;
  onToggleShown: () => void;
  onSet: (key: string, value: string) => void;
  onRemove: () => void;
  taken: (key: string) => boolean;
}) {
  // A key is committed on blur/↵ (a half-typed key would stop being a
  // variable line); values change the text as you type.
  const [key, setKey] = useState(v.key);
  useEffect(() => setKey(v.key), [v.key]);
  const keyOk = VALID_KEY.test(key) && !taken(key);
  const commitKey = () => {
    if (key === v.key) return;
    if (keyOk) onSet(key, v.value);
    else setKey(v.key);
  };
  const secret = isSecret(v.key, v.value);
  const masked = secret && !secretShown;

  return (
    <div className="group flex h-8 items-center gap-2 border-b border-divider/70">
      <input
        value={key}
        onChange={(e) => setKey(e.target.value)}
        onBlur={commitKey}
        onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
        spellCheck={false}
        aria-label={`Key ${v.key}`}
        className={cn(
          "h-6 w-[260px] rounded border border-transparent bg-transparent px-1.5 font-mono text-[12px] text-foreground outline-none hover:border-control-border focus:border-primary/60 focus:bg-background",
          !keyOk && "border-env-prod/60",
        )}
      />
      <input
        value={v.value}
        type={masked ? "password" : "text"}
        onChange={(e) => onSet(v.key, e.target.value)}
        spellCheck={false}
        autoComplete="off"
        aria-label={`Value of ${v.key}`}
        className="h-6 min-w-0 flex-1 rounded border border-transparent bg-transparent px-1.5 font-mono text-[12px] text-foreground outline-none hover:border-control-border focus:border-primary/60 focus:bg-background"
      />
      {dup && (
        <span className="rounded bg-env-staging/15 px-1.5 text-[10.5px] text-env-staging-fg" title="Defined more than once: dotenv uses the first one">
          duplicate
        </span>
      )}
      {secret ? (
        <button
          type="button"
          onClick={onToggleShown}
          aria-label={masked ? `Show ${v.key}` : `Hide ${v.key}`}
          className="flex size-6 flex-none cursor-pointer items-center justify-center rounded text-subtle-foreground hover:bg-hover-strong hover:text-foreground"
        >
          {masked ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
        </button>
      ) : (
        <span className="size-6 flex-none" />
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${v.key}`}
        title="Remove this line"
        className="flex size-6 flex-none cursor-pointer items-center justify-center rounded text-subtle-foreground opacity-0 group-hover:opacity-100 hover:bg-env-prod/10 hover:text-env-prod-fg focus-visible:opacity-100"
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );
}
