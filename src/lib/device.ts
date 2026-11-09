/** rough device checks — used for defaults and honest warnings, never to block anyone */

export function isPhone(): boolean {
  if (typeof navigator === "undefined") return false;
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (uaData?.mobile !== undefined) return uaData.mobile;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

export function checkSupport(): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (typeof window === "undefined") return { ok: true, missing };
  if (!window.isSecureContext) missing.push("HTTPS");
  if (!navigator.mediaDevices?.getUserMedia) missing.push("กล้อง");
  if (typeof MediaRecorder === "undefined") missing.push("การอัดวิดีโอ");
  try {
    if (!document.createElement("canvas").getContext("webgl2")) missing.push("WebGL2");
  } catch {
    missing.push("WebGL2");
  }
  return { ok: missing.length === 0, missing };
}
