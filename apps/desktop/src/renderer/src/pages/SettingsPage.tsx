import { useState } from "react";
import { Panel } from "@/components/ui/Panel";
import { SettingsNav, type NavItem } from "@/components/settings/SettingsNav";
import { PersistenceBanner } from "@/components/settings/PersistenceBanner";
import { AppSection } from "@/components/settings/sections/AppSection";
import { ParametersSection } from "@/components/settings/sections/ParametersSection";
import { AiSection } from "@/components/settings/sections/AiSection";
import { ResearchApisSection } from "@/components/settings/sections/ResearchApisSection";
import { CollaborationSection } from "@/components/settings/sections/CollaborationSection";
import { AboutSection } from "@/components/settings/sections/AboutSection";
import { AppIcon, SparklesIcon, UsersIcon, InfoIcon } from "@/components/settings/icons";
import { SlidersIcon } from "@/components/ui/icons";

const NAV_ITEMS: readonly NavItem[] = [
  {
    id: "app",
    label: "App",
    hint: "Theme, behaviour",
    icon: <AppIcon className="size-5" />,
  },
  {
    id: "parameters",
    label: "Global parameters",
    hint: "Vehicle, scoring",
    icon: <SlidersIcon className="size-5" />,
  },
  {
    id: "ai",
    label: "AI & research",
    hint: "Models, domains",
    icon: <SparklesIcon className="size-5" />,
  },
  {
    id: "research-apis",
    label: "Research APIs & Zugänge",
    hint: "Credentials, approvals, tests",
    icon: <SlidersIcon className="size-5" />,
  },
  {
    id: "collaboration",
    label: "Collaboration",
    hint: "Team, sharing",
    icon: <UsersIcon className="size-5" />,
  },
  {
    id: "about",
    label: "About",
    hint: "Version, info",
    icon: <InfoIcon className="size-5" />,
  },
];

export function SettingsPage() {
  const [activeSection, setActiveSection] = useState("app");

  let content;
  switch (activeSection) {
    case "app":
      content = <AppSection />;
      break;
    case "parameters":
      content = <ParametersSection />;
      break;
    case "ai":
      content = <AiSection />;
      break;
    case "research-apis":
      content = <ResearchApisSection />;
      break;
    case "collaboration":
      content = <CollaborationSection />;
      break;
    case "about":
      content = <AboutSection />;
      break;
    default:
      content = null;
  }

  return (
    <Panel title="Settings" className="h-full" testId="settings-page">
      <h1 className="sr-only">Settings</h1>
      <div className="flex h-full min-h-0">
        <SettingsNav items={NAV_ITEMS} activeId={activeSection} onChange={setActiveSection} />
        <div data-testid="settings-content" className="flex-1 overflow-y-auto bg-panel p-6">
          <div className="mx-auto max-w-[720px]">
            <PersistenceBanner />
            {content}
          </div>
        </div>
      </div>
    </Panel>
  );
}
