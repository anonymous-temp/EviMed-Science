/**
 * Platform detection helpers. Prefer `navigator.userAgentData.platform`
 * (Chromium, not spoofable via UA string) and fall back to the UA string.
 * Tauri desktop currently ships a Chromium (Windows) or WebKit (macOS)
 * webview; WebKit has no userAgentData, where the UA fallback still works.
 */
export function isMacPlatform(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform;
  if (platform) return /mac/i.test(platform);
  return navigator.userAgent.includes("Mac");
}
