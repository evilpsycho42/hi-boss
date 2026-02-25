export type UiLocale = "en" | "zh-CN";

const DEFAULT_UI_LOCALE: UiLocale = "en";

export function normalizeUiLocale(input?: string | null): UiLocale {
  const normalized = (input ?? "").trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "zh" || normalized === "zh-cn") {
    return "zh-CN";
  }
  if (normalized === "en" || normalized === "en-us") {
    return "en";
  }
  return DEFAULT_UI_LOCALE;
}

export function resolveUiLocale(configured?: string | null): UiLocale {
  const env = process.env.HIBOSS_UI_LOCALE;
  if (typeof env === "string" && env.trim()) {
    return normalizeUiLocale(env);
  }
  return normalizeUiLocale(configured);
}
