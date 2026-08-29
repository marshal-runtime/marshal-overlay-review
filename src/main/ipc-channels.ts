import type {
  Annotation,
  DisplayInfo,
  OverlayMode,
  ReviewTarget,
  ToolKind,
  VoiceClip,
} from "../shared/types.ts";

/**
 * IPC channel names and message shapes shared by the main process, the preload
 * bridge, and the renderer. Keeping them in one typed module prevents drift.
 */
export const CH = {
  /** main -> renderer: one-time init with this window's display + config. */
  init: "overlay:init",
  /** main -> renderer: authoritative tool selection (e.g. via host API). */
  setTool: "overlay:set-tool",
  /** main -> renderer: authoritative mode (e.g. submit start/finish). */
  setMode: "overlay:set-mode",
  /** main -> renderer: session state (active review + passthrough flag). */
  session: "overlay:session",
  /** main -> renderer: discard all annotations in this window. */
  clear: "overlay:clear",
  /** main -> renderer: replace this window's annotations (display re-bucket). */
  hydrate: "overlay:hydrate",
  /** main -> renderer: transient status notice (e.g. submit lifecycle). */
  notice: "overlay:notice",
  /** main -> renderer: enter/leave clean capture mode (hide HUD for compositing). */
  captureMode: "overlay:capture-mode",
  /** main -> renderer: ask the renderer to begin a submit (it resolves the target). */
  requestSubmit: "overlay:request-submit",
  /** main -> renderer: apply undo/redo (broadcast). */
  edit: "overlay:edit",
  /** main -> renderer: current ordered frame position/count. */
  frameState: "overlay:frame-state",

  /** renderer -> main: UI script booted and can receive overlay messages. */
  ready: "overlay:ready",
  /** renderer -> main: full annotation list for this window (global DIP). */
  sync: "overlay:sync",
  /** renderer -> main: request passthrough on/off (toolbar button). */
  requestPassthrough: "overlay:request-passthrough",
  /** renderer -> main: report current interaction mode. */
  mode: "overlay:mode",
  /** renderer -> main: user pressed "Send to agent". */
  submit: "overlay:submit",
  /** renderer -> main: user requested a frame navigation/mutation. */
  frameAction: "overlay:frame-action",
  /** renderer -> main: user requested to exit review mode. */
  exit: "overlay:exit",
  /** resume window -> main: leave pass-through and resume drawing. */
  resume: "overlay:resume",
  /** renderer -> main: a non-fatal error to surface to the host. */
  error: "overlay:error",
  /** renderer -> main (invoke): transcribe a voice clip; resolves to text. */
  transcribe: "overlay:transcribe",
} as const;

export interface InitMessage {
  display: DisplayInfo;
  config: OverlayRendererConfig;
}

export interface OverlayRendererConfig {
  /** Palette offered in the toolbar. */
  colors: string[];
  /** Default stroke color. */
  defaultColor: string;
  defaultStrokeWidth: number;
  /** Dim tint applied while in review mode (CSS color, may be transparent). */
  tint: string;
  /** Whether a microphone is expected to be available. */
  voiceEnabled: boolean;
  toggleShortcutLabel: string;
  submitShortcutLabel: string;
  passthroughShortcutLabel: string;
}

/** main -> renderer: current session state. */
export interface SessionMessage {
  /** True while a review session is active (overlay shown). */
  active: boolean;
  /** True while clicks pass through to the app underneath. */
  passthrough: boolean;
  /** Bound target session, if launched from a session (session-scoped). */
  boundSessionId?: string;
  boundSessionTitle?: string;
  /** Candidate destinations for the freestyle picker (when not bound). */
  destinations?: ReviewDestination[];
}

/** A session the review can be routed to (freestyle picker). */
export interface ReviewDestination {
  id: string;
  title: string;
}

export interface SyncMessage {
  frameId: string;
  annotations: Annotation[];
}

export interface ModeMessage {
  mode: OverlayMode;
}

export interface PassthroughRequest {
  on: boolean;
}

export interface EditMessage {
  action: "undo" | "redo";
}

export interface HydrateMessage {
  frameId: string;
  annotations: Annotation[];
}

export interface FrameStateMessage {
  frameId: string;
  /** Zero-based active frame index. */
  index: number;
  count: number;
  /** Raw annotation count for this renderer's display on the active frame. */
  annotationCount: number;
  /** Raw annotation count across every frame/display. */
  totalAnnotationCount: number;
  busy?: boolean;
}

export interface FrameActionRequest {
  action: "add" | "previous" | "next" | "delete" | "move-previous" | "move-next";
}

export type NoticeKind = "info" | "success" | "error";

export interface NoticeMessage {
  text: string;
  kind: NoticeKind;
  /** Auto-clear after this many ms (0 = sticky). */
  timeoutMs?: number;
}

export interface ErrorMessage {
  message: string;
}

export interface TranscribeRequest {
  clip: VoiceClip;
}

export interface SubmitRequest {
  /** Destination chosen by the renderer (bound session or picker choice). */
  target: ReviewTarget;
}

/** The API surface the preload script exposes on `window.overlayBridge`. */
export interface OverlayBridge {
  onInit(cb: (msg: InitMessage) => void): void;
  onSetTool(cb: (tool: ToolKind) => void): void;
  onSetMode(cb: (mode: OverlayMode) => void): void;
  onSession(cb: (msg: SessionMessage) => void): void;
  onClear(cb: () => void): void;
  onHydrate(cb: (msg: HydrateMessage) => void): void;
  onNotice(cb: (msg: NoticeMessage) => void): void;
  onCaptureMode(cb: (on: boolean) => void): void;
  onRequestSubmit(cb: () => void): void;
  onEdit(cb: (msg: EditMessage) => void): void;
  onFrameState(cb: (msg: FrameStateMessage) => void): void;

  ready(): void;
  sync(msg: SyncMessage): void;
  requestPassthrough(msg: PassthroughRequest): void;
  reportMode(msg: ModeMessage): void;
  submit(req: SubmitRequest): void;
  frameAction(req: FrameActionRequest): void;
  exit(): void;
  resume(): void;
  reportError(msg: ErrorMessage): void;
  transcribe(req: TranscribeRequest): Promise<string>;
}
