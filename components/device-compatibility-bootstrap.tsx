"use client";

import { useEffect } from "react";
import {
  applyDeviceCompatibilitySettings,
  DEVICE_COMPATIBILITY_UPDATED_EVENT,
  loadDeviceCompatibilitySettings,
} from "@/lib/device-compatibility";

/** Installs local layout overrides globally, not only while the settings page is open. */
export function DeviceCompatibilityBootstrap() {
  useEffect(() => {
    const apply = () => applyDeviceCompatibilitySettings(loadDeviceCompatibilitySettings());
    apply();
    window.addEventListener(DEVICE_COMPATIBILITY_UPDATED_EVENT, apply);
    window.addEventListener("resize", apply);
    window.addEventListener("orientationchange", apply);
    window.visualViewport?.addEventListener("resize", apply);
    return () => {
      window.removeEventListener(DEVICE_COMPATIBILITY_UPDATED_EVENT, apply);
      window.removeEventListener("resize", apply);
      window.removeEventListener("orientationchange", apply);
      window.visualViewport?.removeEventListener("resize", apply);
    };
  }, []);
  return null;
}
