/**
 * Device compatibility preferences.
 * Settings are stored locally per origin/device. They never grant Android permissions or
 * invent unsupported native APIs; they only adjust layout and opt out of optional modules.
 */

export const DEVICE_COMPATIBILITY_KEY = "float.device-compatibility.v1";
export const DEVICE_COMPATIBILITY_UPDATED_EVENT = "float-device-compatibility-updated";

export type CompatibilityFeature =
  | "notifications"
  | "callOverlay"
  | "deviceActions"
  | "perception"
  | "calendar"
  | "screenshot"
  | "widgets";

export type DeviceCompatibilitySettings = {
  layoutMode: "auto" | "manual";
  screenWidth: number;
  screenHeight: number;
  screenUnit: "css" | "physical";
  uiScale: number;
  disabledFeatures: CompatibilityFeature[];
};

export const DEFAULT_DEVICE_COMPATIBILITY_SETTINGS: DeviceCompatibilitySettings = {
  layoutMode: "auto",
  screenWidth: 0,
  screenHeight: 0,
  screenUnit: "css",
  uiScale: 1,
  disabledFeatures: [],
};

const FEATURES: CompatibilityFeature[] = [
  "notifications", "callOverlay", "deviceActions", "perception", "calendar", "screenshot", "widgets",
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function loadDeviceCompatibilitySettings(): DeviceCompatibilitySettings {
  if (typeof window === "undefined") return { ...DEFAULT_DEVICE_COMPATIBILITY_SETTINGS, disabledFeatures: [] };
  try {
    const raw = window.localStorage.getItem(DEVICE_COMPATIBILITY_KEY);
    if (!raw) return { ...DEFAULT_DEVICE_COMPATIBILITY_SETTINGS, disabledFeatures: [] };
    const parsed = JSON.parse(raw) as Partial<DeviceCompatibilitySettings>;
    const disabled = Array.isArray(parsed.disabledFeatures)
      ? parsed.disabledFeatures.filter((item): item is CompatibilityFeature => FEATURES.includes(item as CompatibilityFeature))
      : [];
    return {
      layoutMode: parsed.layoutMode === "manual" ? "manual" : "auto",
      screenWidth: Number.isFinite(Number(parsed.screenWidth)) ? clamp(Number(parsed.screenWidth), 0, 10000) : 0,
      screenHeight: Number.isFinite(Number(parsed.screenHeight)) ? clamp(Number(parsed.screenHeight), 0, 20000) : 0,
      screenUnit: parsed.screenUnit === "physical" ? "physical" : "css",
      uiScale: Number.isFinite(Number(parsed.uiScale)) ? clamp(Number(parsed.uiScale), 0.75, 1.25) : 1,
      disabledFeatures: [...new Set(disabled)],
    };
  } catch {
    return { ...DEFAULT_DEVICE_COMPATIBILITY_SETTINGS, disabledFeatures: [] };
  }
}

export function saveDeviceCompatibilitySettings(settings: DeviceCompatibilitySettings): void {
  if (typeof window === "undefined") return;
  const next: DeviceCompatibilitySettings = {
    layoutMode: settings.layoutMode === "manual" ? "manual" : "auto",
    screenWidth: clamp(Number(settings.screenWidth) || 0, 0, 10000),
    screenHeight: clamp(Number(settings.screenHeight) || 0, 0, 20000),
    screenUnit: settings.screenUnit === "physical" ? "physical" : "css",
    uiScale: clamp(Number(settings.uiScale) || 1, 0.75, 1.25),
    disabledFeatures: [...new Set(settings.disabledFeatures.filter((item) => FEATURES.includes(item)))],
  };
  window.localStorage.setItem(DEVICE_COMPATIBILITY_KEY, JSON.stringify(next));
  applyDeviceCompatibilitySettings(next);
  window.dispatchEvent(new CustomEvent(DEVICE_COMPATIBILITY_UPDATED_EVENT, { detail: next }));
}

export function resetDeviceCompatibilitySettings(): void {
  saveDeviceCompatibilitySettings({ ...DEFAULT_DEVICE_COMPATIBILITY_SETTINGS, disabledFeatures: [] });
}

export function isCompatibilityFeatureEnabled(feature: CompatibilityFeature): boolean {
  return !loadDeviceCompatibilitySettings().disabledFeatures.includes(feature);
}

/** Applies optional reference-screen sizing without changing the real device/viewport metrics. */
export function applyDeviceCompatibilitySettings(
  settings: DeviceCompatibilitySettings = loadDeviceCompatibilitySettings(),
): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const root = document.documentElement;
  const viewportWidth = Math.max(1, window.visualViewport?.width || window.innerWidth || window.screen.width || 1);
  const viewportHeight = Math.max(1, window.visualViewport?.height || window.innerHeight || window.screen.height || 1);
  const screenWidth = Math.max(1, window.screen?.width || window.innerWidth || 1);
  const screenHeight = Math.max(1, window.screen?.height || window.innerHeight || 1);
  const userScale = clamp(settings.uiScale || 1, 0.75, 1.25);

  if (settings.layoutMode === "manual" && settings.screenWidth >= 100 && settings.screenHeight >= 200) {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const referenceWidth = settings.screenUnit === "physical" ? settings.screenWidth / dpr : settings.screenWidth;
    const referenceHeight = settings.screenUnit === "physical" ? settings.screenHeight / dpr : settings.screenHeight;
    // Change the layout coordinate space inversely to the user scale, then fit the whole
    // reference screen into the actual display. This keeps the shell within bounds at 75–125%.
    const layoutWidth = referenceWidth / userScale;
    const layoutHeight = referenceHeight / userScale;
    const fitScale = Math.min(screenWidth / layoutWidth, screenHeight / layoutHeight);
    const scale = clamp(fitScale, 0.5, 1.25);
    root.style.setProperty("--phone-screen-width", Math.round(layoutWidth) + "px");
    root.style.setProperty("--phone-screen-height", Math.round(layoutHeight) + "px");
    root.style.setProperty("--compat-layout-scale", String(scale));
  } else if (Math.abs(userScale - 1) > 0.001) {
    root.style.setProperty("--phone-screen-width", Math.round(viewportWidth / userScale) + "px");
    root.style.setProperty("--phone-screen-height", Math.round(viewportHeight / userScale) + "px");
    root.style.setProperty("--compat-layout-scale", String(userScale));
  } else {
    root.style.removeProperty("--phone-screen-width");
    root.style.removeProperty("--phone-screen-height");
    root.style.removeProperty("--compat-layout-scale");
  }
}

export function readDeviceRuntimeMetrics() {
  if (typeof window === "undefined") {
    return { screenWidth: 0, screenHeight: 0, viewportWidth: 0, viewportHeight: 0, visualWidth: 0, visualHeight: 0, dpr: 1, orientation: "unknown", userAgent: "" };
  }
  return {
    screenWidth: window.screen?.width || 0,
    screenHeight: window.screen?.height || 0,
    viewportWidth: window.innerWidth || 0,
    viewportHeight: window.innerHeight || 0,
    visualWidth: Math.round(window.visualViewport?.width || window.innerWidth || 0),
    visualHeight: Math.round(window.visualViewport?.height || window.innerHeight || 0),
    dpr: window.devicePixelRatio || 1,
    orientation: window.matchMedia?.("(orientation: portrait)").matches ? "portrait" : "landscape",
    userAgent: window.navigator?.userAgent || "",
  };
}
