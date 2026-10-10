import { useEffect } from "react";
import { Outlet, useNavigate } from "react-router";
import { settingsStore } from "@/lib/settings";
import { useApplyTheme } from "@/lib/theme";
import { BottomNav, TABS } from "./BottomNav";
import { OpenAiStartup } from "./OpenAiStartup";

export function AppShell() {
  useApplyTheme();
  const navigate = useNavigate();

  useEffect(() => {
    void settingsStore.getState().load();
  }, []);

  // ⌘1–3 / Ctrl+1–3 switch tabs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const tab = TABS[Number(e.key) - 1];
      if (!tab) return;
      e.preventDefault();
      void navigate(tab.to);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  return (
    <div className="dot-grid flex h-full flex-col gap-2 p-2 text-ink antialiased">
      <main className="min-h-0 flex-1">
        <Outlet />
      </main>
      <BottomNav />
      <OpenAiStartup />
    </div>
  );
}
