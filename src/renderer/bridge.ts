import type { OverlayBridge } from "../main/ipc-channels.ts";

declare global {
  interface Window {
    overlayBridge?: OverlayBridge;
  }
}

/**
 * A no-op bridge so the renderer can run standalone (e.g. in a plain browser
 * for visual development) without the Electron preload present.
 */
const noopBridge: OverlayBridge = {
  onInit() {},
  onSetTool() {},
  onSetMode() {},
  onSession() {},
  onClear() {},
  onHydrate() {},
  onNotice() {},
  onCaptureMode() {},
  onRequestSubmit() {},
  onEdit() {},
  onFrameState() {},
  ready() {},
  sync() {},
  requestPassthrough() {},
  reportMode() {},
  submit() {},
  frameAction() {},
  exit() {},
  resume() {},
  reportError() {},
  async transcribe() {
    return "";
  },
};

export function getBridge(): OverlayBridge {
  return window.overlayBridge ?? noopBridge;
}

export const hasNativeBridge = (): boolean => Boolean(window.overlayBridge);
