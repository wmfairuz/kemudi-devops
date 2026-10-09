import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { nginx } from "@codemirror/legacy-modes/mode/nginx";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { unifiedMergeView } from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

/** File kinds Kemudi edits on servers. `ini` covers Supervisor confs. */
export type CodeLanguage = "env" | "nginx" | "ini" | "shell" | "plain";

function language(lang: CodeLanguage): Extension {
  switch (lang) {
    case "env":
    case "ini":
      return StreamLanguage.define(properties);
    case "nginx":
      return StreamLanguage.define(nginx);
    case "shell":
      return StreamLanguage.define(shell);
    case "plain":
      return [];
  }
}

// Light, matching the app chrome (only the terminal is Dracula).
const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "12.5px", backgroundColor: "var(--background)", color: "var(--foreground)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "19px" },
  ".cm-content": { caretColor: "var(--primary)", padding: "6px 0" },
  ".cm-cursor": { borderLeftColor: "var(--primary)", borderLeftWidth: "2px" },
  ".cm-gutters": { backgroundColor: "var(--background)", color: "var(--faint-foreground)", border: "none", borderRight: "1px solid var(--divider)" },
  ".cm-activeLine": { backgroundColor: "rgb(107 79 216 / 0.05)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--muted-foreground)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--selected) !important" },
  // Diff (review): green added, red removed, like the git colours.
  ".cm-changedLine": { backgroundColor: "rgb(31 157 58 / 0.09) !important" },
  ".cm-changedText": { background: "rgb(31 157 58 / 0.25) !important" },
  ".cm-deletedChunk": { backgroundColor: "rgb(209 36 47 / 0.08)" },
  ".cm-deletedChunk .cm-deletedText, .cm-deletedChunk del": { background: "rgb(209 36 47 / 0.22)", textDecoration: "none" },
  ".cm-changeGutter": { width: "3px", paddingLeft: "0" },
  ".cm-changedLineGutter": { background: "var(--term-green)" },
  ".cm-deletedLineGutter": { background: "var(--term-red)" },
  ".cm-collapsedLines": { color: "var(--subtle-foreground)", background: "var(--hover)", fontSize: "11.5px" },
});

const highlight = HighlightStyle.define([
  { tag: t.comment, color: "#7a7f8e", fontStyle: "italic" },
  { tag: [t.propertyName, t.definition(t.propertyName), t.attributeName], color: "#6b4fd8" },
  { tag: [t.string, t.special(t.string)], color: "#1a7f37" },
  { tag: [t.keyword, t.operator], color: "#b42318" },
  { tag: [t.number, t.bool, t.atom], color: "#9a6700" },
  { tag: [t.variableName, t.definition(t.variableName)], color: "#0969da" },
]);

const base = (lang: CodeLanguage): Extension[] => [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  drawSelection(),
  highlightActiveLine(),
  language(lang),
  syntaxHighlighting(highlight),
  theme,
  EditorView.lineWrapping,
];

/** CodeMirror for a config file. `onSave` runs on ⌘S / ⌘↵. */
export function CodeEditor({
  value,
  onChange,
  lang,
  onSave,
  className,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  lang: CodeLanguage;
  onSave?: () => void;
  className?: string;
  autoFocus?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef({ onChange, onSave });
  latest.current = { onChange, onSave };

  useEffect(() => {
    if (!host.current) return;
    const save = () => {
      latest.current.onSave?.();
      return true;
    };
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          ...base(lang),
          history(),
          keymap.of([{ key: "Mod-s", run: save }, { key: "Mod-Enter", run: save }, indentWithTab, ...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) latest.current.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    if (autoFocus) v.focus();
    return () => {
      v.destroy();
      view.current = null;
    };
    // The editor owns the text while mounted; outside changes come in below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  // Text changed from outside (the table view): replace the document.
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div ref={host} className={cn("min-h-0 overflow-hidden", className)} />;
}

/** Read-only diff of `original` → `value`, unchanged stretches folded. */
export function DiffView({ original, value, lang, className }: { original: string; value: string; lang: CodeLanguage; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          ...base(lang),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          unifiedMergeView({
            original,
            mergeControls: false,
            gutter: true,
            highlightChanges: true,
            syntaxHighlightDeletions: false,
            collapseUnchanged: { margin: 2, minSize: 4 },
          }),
        ],
      }),
    });
    return () => v.destroy();
  }, [original, value, lang]);
  return <div ref={host} className={cn("min-h-0 overflow-auto", className)} />;
}
