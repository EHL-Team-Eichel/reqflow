import { useMemo } from "react";
import { useDataflow, dataflowStore, breadcrumbOf } from "./store";

export function Breadcrumb() {
  const root = useDataflow((s) => s.root);
  const path = useDataflow((s) => s.path);

  const crumbs = useMemo(() => breadcrumbOf(root, path), [root, path]);

  return (
    <div data-testid="breadcrumb" className="flex items-center gap-1.5 text-sm">
      {crumbs.map((crumb, i) => {
        const isLast = i === crumbs.length - 1;
        return (
          <div key={crumb.depth} className="flex items-center gap-1.5">
            {i > 0 && <span className="text-muted">›</span>}
            {isLast ? (
              <span className="font-medium text-ink">{crumb.label}</span>
            ) : (
              <button
                type="button"
                data-testid={`crumb-${crumb.depth}`}
                className="text-muted hover:text-ink transition-colors"
                onClick={() => dataflowStore.getState().goTo(crumb.depth)}
              >
                {crumb.label}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
