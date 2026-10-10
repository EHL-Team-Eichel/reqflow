import { Outlet } from "react-router";
import { SideNav } from "./SideNav";

export function AppShell() {
  return (
    <div className="flex h-full antialiased">
      <SideNav />
      <main className="min-w-0 flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
