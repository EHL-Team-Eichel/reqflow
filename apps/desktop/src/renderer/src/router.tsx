import { createHashRouter, Navigate } from "react-router";
import { AppShell } from "@/components/shell/AppShell";
import { CarPage } from "@/pages/CarPage";
import { DataflowPage } from "@/pages/DataflowPage";
import { SettingsPage } from "@/pages/SettingsPage";

// Hash routing: the packaged app loads index.html from disk (file://), where path routing can't work.
export const router = createHashRouter([
  {
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/dataflow" replace /> },
      { path: "dataflow", element: <DataflowPage /> },
      { path: "car", element: <CarPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "*", element: <Navigate to="/dataflow" replace /> },
    ],
  },
]);
