"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/workflow", label: "Workflow", hint: "Build & run the pipeline" },
  { href: "/requirements", label: "Requirements", hint: "Review AI proposals" },
  { href: "/audit", label: "Audit trail", hint: "Every change, traceable" },
  { href: "/settings", label: "Settings", hint: "Models, scoring, scope" },
] as const;

export function SideNav() {
  const pathname = usePathname();
  return (
    <nav className="flex w-60 shrink-0 flex-col gap-1 bg-brand-ink p-4 text-white">
      <div className="mb-6 px-2">
        <div className="text-lg font-semibold tracking-tight">ReqFlow</div>
        <div className="text-xs text-white/60">Customer requirements workbench</div>
      </div>
      {NAV.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`rounded-md px-3 py-2 transition-colors ${
              active ? "bg-brand text-white" : "text-white/80 hover:bg-white/10"
            }`}
          >
            <div className="text-sm font-medium">{item.label}</div>
            <div className={`text-xs ${active ? "text-white/80" : "text-white/50"}`}>
              {item.hint}
            </div>
          </Link>
        );
      })}
    </nav>
  );
}
