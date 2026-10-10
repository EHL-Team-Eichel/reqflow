import { createHashRouter, Navigate } from "react-router";
import { AppShell } from "@/components/shell/AppShell";
import { AuditPage } from "@/pages/AuditPage";
import { RequirementDetailPage } from "@/pages/RequirementDetailPage";
import { RequirementsPage } from "@/pages/RequirementsPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { WorkflowPage } from "@/pages/WorkflowPage";

// Hash routing: the packaged app loads index.html from disk (file://), where path routing can't work.
export const router = createHashRouter([
  {
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/workflow" replace /> },
      { path: "workflow", element: <WorkflowPage /> },
      { path: "requirements", element: <RequirementsPage /> },
      { path: "requirements/:id", element: <RequirementDetailPage /> },
      { path: "audit", element: <AuditPage /> },
      { path: "settings", element: <SettingsPage /> },
    ],
  },
]);
