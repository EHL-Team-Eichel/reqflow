import { useEffect, useState } from "react";
import { useSettings } from "./settings";

export type ResolvedTheme = "light" | "dark";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** The theme in effect: the Settings choice, or the OS appearance when set to "system". */
export function useResolvedTheme(): ResolvedTheme {
  const preference = useSettings((s) => s.settings.app.theme);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia(DARK_QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia(DARK_QUERY);
    const onChange = () => setSystemDark(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  if (preference === "system") return systemDark ? "dark" : "light";
  return preference;
}

/** Call once (AppShell): mirrors the resolved theme onto <html data-theme>, which the CSS tokens follow. */
export function useApplyTheme(): ResolvedTheme {
  const theme = useResolvedTheme();
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return theme;
}
