import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";

import { ActionDialogs } from "@/components/actions/ActionDialogs";
import { ActionsPanel } from "@/components/actions/ActionsPanel";
import { AddActionDialog } from "@/components/actions/AddActionDialog";
import { SnippetDialog } from "@/components/snippets/SnippetsPanel";
import { FileEditorDialog } from "@/components/manage/FileEditor";
import { VhostGeneratorDialog } from "@/components/manage/VhostGenerator";
import { NewAppDialog } from "@/components/manage/NewAppDialog";
import { ConfirmDialog } from "@/components/kit/ConfirmDialog";
import { ParamsDialog } from "@/components/actions/ParamsDialog";
import { TabConfigDialogs } from "@/components/tabconfigs/TabConfigs";
import { DetailsView } from "@/components/manage/DetailsView";
import { DiscoverHost, EntityMenu } from "@/components/manage/EntityMenu";
import { ActionMenu } from "@/components/actions/ActionMenu";
import { EnvironmentDialog } from "@/components/dialogs/EnvironmentDialog";
import { PasswordsDialog } from "@/components/dialogs/PasswordsDialog";
import { FillPicker } from "@/components/terminal/FillPicker";
import { SettingsDialog } from "@/components/dialogs/SettingsDialog";
import { HistoryView } from "@/components/history/HistoryView";
import { CommandPalette } from "@/components/palette/CommandPalette";
import { SshDialog } from "@/components/dialogs/SshDialog";
import { Toasts } from "@/components/kit/Toasts";
import { HomeView } from "@/components/home/HomeView";
import { TitleBar } from "@/components/shell/TitleBar";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { TabStrip } from "@/components/terminal/TabStrip";
import { TerminalPane } from "@/components/terminal/TerminalPane";
import { installShortcuts, runCommand } from "@/lib/keys";
import { useConfig } from "@/stores/config";
import { initSession } from "@/stores/session";
import { useDiskAlerts } from "@/stores/diskAlerts";
import { useSslAlerts } from "@/stores/sslAlerts";
import { useStatus } from "@/stores/status";
import { activeTab, DETAILS_ID, HISTORY_ID, HOME_ID, useTabs } from "@/stores/tabs";

export default function App() {
  const active = useTabs(activeTab);
  const hasTabs = useTabs((s) => s.tabs.length > 0);
  const showHistory = useTabs((s) => s.activeId === HISTORY_ID);
  const showDetails = useTabs((s) => s.activeId === DETAILS_ID);
  const showHome = useTabs((s) => s.activeId === HOME_ID || s.activeId === null);
  const filterRef = useRef<HTMLInputElement>(null);
  const title = showHistory ? "Kemudi Devops — History" : active ? `Kemudi Devops — ${active.title}` : "Kemudi Devops";

  useEffect(() => useConfig.getState().init(), []);
  useEffect(() => useStatus.getState().init(), []);
  useEffect(() => useDiskAlerts.getState().init(), []);
  useEffect(() => useSslAlerts.getState().init(), []);
  // Restores tabs once and saves them for the app's lifetime.
  useEffect(() => void initSession(), []);
  useEffect(() => installShortcuts(), []);
  // Settings ▸ Terminal applies to open tabs too.
  useEffect(
    () =>
      useConfig.subscribe((s, prev) => {
        const t = s.snapshot?.config?.terminal;
        if (t === prev.snapshot?.config?.terminal) return;
        for (const tab of useTabs.getState().tabs) tab.session?.applySettings(t);
      }),
    [],
  );

  useEffect(() => {
    void getCurrentWindow().setTitle(title).catch(() => {});
  }, [title]);

  useEffect(() => {
    // Native menu items (and their ⌘ shortcuts) run app commands.
    const unlisten = listen<string>("menu", (e) => void runCommand(e.payload));
    return () => void unlisten.then((f) => f());
  }, []);

  // "/" focuses the sidebar filter when no text field or terminal has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        filterRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-[13px] text-foreground">
      <TitleBar title={title} />
      <div className="flex min-h-0 flex-1">
        <Sidebar onHistory={() => useTabs.getState().openHistory()} filterRef={filterRef} />
        <main className="relative flex min-w-0 flex-1 flex-col">
          <TabStrip />
          <div className="relative flex min-h-0 flex-1 flex-col">
            {hasTabs && <TerminalPane />}
            {showHome && <HomeView />}
            {showHistory && <HistoryView />}
            {showDetails && <DetailsView />}
          </div>
        </main>
        <ActionsPanel />
      </div>
      <SshDialog />
      <EnvironmentDialog />
      <PasswordsDialog />
      <FillPicker />
      <SettingsDialog />
      <ActionDialogs />
      <ActionMenu />
      <EntityMenu />
      <DiscoverHost />
      <AddActionDialog />
      <SnippetDialog />
      <FileEditorDialog />
      <VhostGeneratorDialog />
      <NewAppDialog />
      <ConfirmDialog />
      <ParamsDialog />
      <TabConfigDialogs />
      <CommandPalette />
      <Toasts />
    </div>
  );
}
