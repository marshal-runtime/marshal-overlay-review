import { contextBridge, ipcRenderer } from "electron";

import type { OverlayMode, ToolKind } from "../shared/types.ts";
import {
  CH,
  type EditMessage,
  type ErrorMessage,
  type FrameActionRequest,
  type FrameStateMessage,
  type HydrateMessage,
  type InitMessage,
  type ModeMessage,
  type NoticeMessage,
  type OverlayBridge,
  type PassthroughRequest,
  type SessionMessage,
  type SubmitRequest,
  type SyncMessage,
  type TranscribeRequest,
} from "./ipc-channels.ts";

/**
 * Preload bridge. Runs with context isolation; exposes a small, typed API to
 * the renderer on `window.overlayBridge` and never leaks ipcRenderer directly.
 */
const bridge: OverlayBridge = {
  onInit(cb: (msg: InitMessage) => void): void {
    ipcRenderer.on(CH.init, (_e, msg: InitMessage) => cb(msg));
  },
  onSetTool(cb: (tool: ToolKind) => void): void {
    ipcRenderer.on(CH.setTool, (_e, tool: ToolKind) => cb(tool));
  },
  onSetMode(cb: (mode: OverlayMode) => void): void {
    ipcRenderer.on(CH.setMode, (_e, mode: OverlayMode) => cb(mode));
  },
  onSession(cb: (msg: SessionMessage) => void): void {
    ipcRenderer.on(CH.session, (_e, msg: SessionMessage) => cb(msg));
  },
  onClear(cb: () => void): void {
    ipcRenderer.on(CH.clear, () => cb());
  },
  onHydrate(cb: (msg: HydrateMessage) => void): void {
    ipcRenderer.on(CH.hydrate, (_e, msg: HydrateMessage) => cb(msg));
  },
  onNotice(cb: (msg: NoticeMessage) => void): void {
    ipcRenderer.on(CH.notice, (_e, msg: NoticeMessage) => cb(msg));
  },
  onCaptureMode(cb: (on: boolean) => void): void {
    ipcRenderer.on(CH.captureMode, (_e, on: boolean) => cb(on));
  },
  onRequestSubmit(cb: () => void): void {
    ipcRenderer.on(CH.requestSubmit, () => cb());
  },
  onEdit(cb: (msg: EditMessage) => void): void {
    ipcRenderer.on(CH.edit, (_e, msg: EditMessage) => cb(msg));
  },
  onFrameState(cb: (msg: FrameStateMessage) => void): void {
    ipcRenderer.on(CH.frameState, (_e, msg: FrameStateMessage) => cb(msg));
  },
  ready(): void {
    ipcRenderer.send(CH.ready);
  },
  sync(msg: SyncMessage): void {
    ipcRenderer.send(CH.sync, msg);
  },
  requestPassthrough(msg: PassthroughRequest): void {
    ipcRenderer.send(CH.requestPassthrough, msg);
  },
  reportMode(msg: ModeMessage): void {
    ipcRenderer.send(CH.mode, msg);
  },
  submit(req: SubmitRequest): void {
    ipcRenderer.send(CH.submit, req);
  },
  frameAction(req: FrameActionRequest): void {
    ipcRenderer.send(CH.frameAction, req);
  },
  exit(): void {
    ipcRenderer.send(CH.exit);
  },
  resume(): void {
    ipcRenderer.send(CH.resume);
  },
  reportError(msg: ErrorMessage): void {
    ipcRenderer.send(CH.error, msg);
  },
  transcribe(req: TranscribeRequest): Promise<string> {
    return ipcRenderer.invoke(CH.transcribe, req) as Promise<string>;
  },
};

contextBridge.exposeInMainWorld("overlayBridge", bridge);
