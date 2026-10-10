import { NavLink } from "react-router";

const NAV = [
  { to: "/workflow", label: "Workflow", hint: "Build & run the pipeline" },
  { to: "/requirements", label: "Requirements", hint: "Review AI proposals" },
  { to: "/audit", label: "Audit trail", hint: "Every change, traceable" },
  { to: "/settings", label: "Settings", hint: "Models, scoring, scope" },
] as const;

export function SideNav() {
  return (
    <nav className="flex w-60 shrink-0 flex-col gap-1 bg-brand-ink p-4 text-white">
      <div className="mb-6 px-2">
        <div className="text-lg font-semibold tracking-tight">ReqFlow</div>
        <div className="text-xs text-white/60">Customer requirements workbench</div>
      </div>
      {NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          className={({ isActive }) =>
            `rounded-md px-3 py-2 transition-colors ${
              isActive ? "bg-brand text-white" : "text-white/80 hover:bg-white/10"
            }`
          }
        >
          {({ isActive }) => (
            <>
              <div className="text-sm font-medium">{item.label}</div>
              <div className={`text-xs ${isActive ? "text-white/80" : "text-white/50"}`}>
                {item.hint}
              </div>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
