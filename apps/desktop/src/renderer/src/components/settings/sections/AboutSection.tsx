import type { AppInfo } from "@reqflow/core";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { SettingRow } from "../SettingRow";

const PLATFORM_NAMES: Record<string, string> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

export function AboutSection() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.app
      .info()
      .then(setInfo)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold text-ink">About</h2>
        <p className="mt-1 text-sm text-muted">
          ReqFlow — prototype for the BMW challenge “AI for Product Decision Making” (European
          Hackathon League).
        </p>
      </div>

      <div className="flex flex-col">
        {error ? (
          <div className="rounded-lg bg-danger-soft p-3 text-sm text-danger border border-line">
            {error}
          </div>
        ) : !info ? (
          <div className="rounded-lg bg-panel-2 p-3 text-sm text-muted border border-line">
            Loading info…
          </div>
        ) : (
          <>
            <SettingRow label="Version">
              <span className="text-sm text-ink">
                {info.version}
                {info.isPackaged ? "" : " (development build)"}
              </span>
            </SettingRow>
            <SettingRow label="Platform">
              <span className="text-sm text-ink">
                {PLATFORM_NAMES[info.platform] ?? info.platform}
              </span>
            </SettingRow>
            <SettingRow
              label="Data folder"
              description="Where the database and imported files live on this computer."
            >
              <span className="text-sm break-all text-ink select-text">{info.dataDir}</span>
            </SettingRow>
          </>
        )}
      </div>
    </div>
  );
}
