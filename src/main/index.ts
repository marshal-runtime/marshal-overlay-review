import { EventEmitter } from "node:events";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  screen,
  systemPreferences,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";

import { cloneAnnotation } from "../shared/annotation-store.ts";
import { annotationAnchor, displayForPoint } from "../shared/geometry.ts";
import {
  assembleReviewPayload,
  submittableAnnotations,
  type AssembleReviewFrameInput,
  type ReviewPayload,
} from "../shared/review.ts";
import type {
  Annotation,
  DisplayInfo,
  OverlayMode,
  ReviewTarget,
  ScreenshotData,
  ToolKind,
  VoiceClip,
} from "../shared/types.ts";
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
  type OverlayRendererConfig,
  type PassthroughRequest,
  type SessionMessage,
  type SubmitRequest,
  type SyncMessage,
  type TranscribeRequest,
} from "./ipc-channels.ts";
import { applyInteractive, createOverlayWindow, createResumeWindow } from "./overlay-window.ts";
import { captureDisplays, hasAnyImage, toDisplayInfo } from "./screenshot.ts";

export type { ReviewPayload } from "../shared/review.ts";
export * from "../shared/index.ts";

/** A session the review can be routed to (shown in the freestyle picker). */
export interface ReviewDestination {
  id: string;
  title: string;
}

/** Context passed to show()/toggle() to bind the overlay to a session. */
export interface OverlayLaunchContext {
  /** Existing session this review belongs to (session-scoped launch). */
  sessionId?: string;
  sessionTitle?: string;
}

export interface OverlayHooks {
  /** Required. Deliver the assembled review to the host/agent. */
  onSubmitReview: (payload: ReviewPayload) => void | Promise<void>;
  /** Transcribe a voice clip to text. If omitted, audio is sent without text. */
  transcribe?: (clip: VoiceClip) => string | Promise<string>;
  /**
   * List candidate destinations for a FREESTYLE review (overlay opened via the
   * global hotkey, not bound to a session). The renderer shows these as a
   * "New session" + recent-session picker. Omit to always start a new session.
   */
  listDestinations?: () => ReviewDestination[] | Promise<ReviewDestination[]>;
  /** Override screenshot capture (e.g. host has its own capturer). */
  captureScreenshot?: (
    displays: readonly DisplayInfo[],
  ) => ScreenshotData[] | Promise<ScreenshotData[]>;
  /** Notified whenever the interaction mode changes. */
  onModeChange?: (mode: OverlayMode) => void;
  /** Notified of non-fatal errors. */
  onError?: (err: { message: string; cause?: unknown }) => void;
}

export interface OverlayOptions {
  hooks: OverlayHooks;
  /** Global shortcut to toggle review mode. Default Ctrl/Cmd+Shift+Space. */
  toggleShortcut?: string | false;
  /** Global shortcut to submit. Default Ctrl/Cmd+Enter. */
  submitShortcut?: string;
  /** Global shortcut to toggle pass-through (click underlying app). Default Ctrl/Cmd+Shift+S. */
  passthroughShortcut?: string;
  /** Discard annotations after a successful submit. Default true. */
  clearOnSubmit?: boolean;
  /** Delay (ms) after hiding overlays before capturing, to avoid self-capture. */
  screenshotDelayMs?: number;
  /** Also capture a composite preview (marks over the screenshot). Default true. */
  includeComposite?: boolean;
  /** Dim tint shown while reviewing (CSS color). Default subtle dark. */
  tint?: string;
  /** Color palette for the toolbar. */
  colors?: string[];
  defaultColor?: string;
  defaultStrokeWidth?: number;
  /** Host metadata attached to every review payload. */
  host?: { appName?: string; appVersion?: string; context?: Record<string, unknown> };
}

const DEFAULTS = {
  toggleShortcut: "CommandOrControl+Shift+Space",
  submitShortcut: "CommandOrControl+Enter",
  passthroughShortcut: "CommandOrControl+Shift+S",
  clearOnSubmit: true,
  screenshotDelayMs: 120,
  includeComposite: true,
  tint: "rgba(10,12,20,0.06)",
  colors: ["#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#0a84ff", "#bf5af2", "#ffffff", "#000000"],
  defaultColor: "#ff3b30",
  defaultStrokeWidth: 4,
};

const RENDERER_READY_TIMEOUT_MS = 10_000;

/**
 * Upper bound on a single screen capture. `desktopCapturer.getSources()` can
 * block indefinitely (most visibly on macOS while the Screen Recording TCC
 * prompt is pending). Without a bound, "+ Frame" and "Send all" would leave
 * `#frameBusy` / `#submitting` latched forever, disabling both buttons for the
 * rest of the session with no message — so every capture is raced against this.
 */
const CAPTURE_TIMEOUT_MS = 8_000;

/** Reject with `message` if `work` has not settled within `ms`. */
async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A human-actionable reason capture is failing, or "" when the OS reports the
 * permission as granted (or cannot report on it at all).
 */
function screenCapturePermissionHint(): string {
  try {
    const status = systemPreferences.getMediaAccessStatus("screen");
    if (status === "granted") return "";
    return (
      `Screen Recording permission is "${status}". ` +
      "Grant it in System Settings → Privacy & Security → Screen & System Audio Recording, " +
      "enable Marshal, then quit and reopen Marshal."
    );
  } catch {
    // Not supported on this platform; nothing actionable to report.
    return "";
  }
}

interface RendererReadyEntry {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  settled: boolean;
}

interface OverlayFrameSnapshot {
  id: string;
  createdAt: number;
  displays: DisplayInfo[];
  screenshots: ScreenshotData[];
  annotationsByDisplayId: Map<number, Annotation[]>;
  dirty: boolean;
}

export interface OverlayController {
  /** Register shortcuts and prepare (idempotent). */
  enable(): Promise<void>;
  /** Tear down shortcuts/windows/IPC. */
  destroy(): void;
  /** Enter review mode (build + show overlays). Pass a context to bind the
   * review to a specific session; omit for a freestyle review. */
  show(context?: OverlayLaunchContext): Promise<void>;
  /** Exit review mode (hide overlays; annotations are retained). */
  hide(): void;
  /** Toggle review mode. */
  toggle(context?: OverlayLaunchContext): Promise<void>;
  isVisible(): boolean;
  /** Whether clicks currently pass through to the app underneath. */
  isPassthrough(): boolean;
  /** Toggle (or set) pass-through so the user can click the underlying app. */
  setPassthrough(on: boolean): void;
  togglePassthrough(): void;
  /** Capture + assemble + deliver a review. Returns the payload (or null). */
  submit(target?: ReviewTarget): Promise<ReviewPayload | null>;
  /** Discard all annotations across displays. */
  clear(): void;
  /** Undo / redo the most recent annotation change. */
  undo(): void;
  redo(): void;
  /** Programmatically select a tool in every overlay. */
  setTool(tool: ToolKind): void;
  /** Current annotation count across all displays. */
  annotationCount(): number;
  on(event: "mode", cb: (mode: OverlayMode) => void): void;
  on(event: "visibility", cb: (visible: boolean) => void): void;
  on(event: "passthrough", cb: (on: boolean) => void): void;
  on(event: "submit", cb: (payload: ReviewPayload) => void): void;
  on(event: "error", cb: (err: { message: string; cause?: unknown }) => void): void;
}

export function resolveOverlayRuntimeDirectory(moduleDirectory: string): string {
  const segments = moduleDirectory.split(path.sep);
  const asarIndex = segments.lastIndexOf("app.asar");
  if (asarIndex < 0) return moduleDirectory;
  segments[asarIndex] = "app.asar.unpacked";
  return segments.join(path.sep);
}

function resolvePaths(): { rendererHtml: string; resumeHtml: string; preload: string } {
  const here = resolveOverlayRuntimeDirectory(path.dirname(fileURLToPath(import.meta.url)));
  return {
    rendererHtml: path.join(here, "..", "renderer", "index.html"),
    resumeHtml: path.join(here, "..", "renderer", "resume.html"),
    preload: path.join(here, "preload.cjs"),
  };
}

class OverlayControllerImpl extends EventEmitter implements OverlayController {
  #opts: Required<Omit<OverlayOptions, "host">> & Pick<OverlayOptions, "host">;
  #hooks: OverlayHooks;
  #windows = new Map<number, BrowserWindow>(); // webContents.id -> window
  #displayByWc = new Map<number, DisplayInfo>(); // webContents.id -> display
  #annotations = new Map<number, Annotation[]>(); // webContents.id -> annotations
  #rendererReady = new Map<number, RendererReadyEntry>(); // webContents.id -> renderer readiness
  #pendingHydrate = new Map<number, Annotation[]>(); // displayId -> annotations to restore
  #frames: OverlayFrameSnapshot[] = [];
  #currentFrameIndex = 0;
  #nextFrameNumber = 1;
  #resumeWindow: BrowserWindow | undefined;
  #paths = resolvePaths();
  #enabled = false;
  #visible = false;
  #passthrough = false;
  #submitting = false;
  #frameBusy = false;
  /** Last capture failure (timeout / permission), surfaced once to the user. */
  #captureFailure: string | null = null;
  #launch: OverlayLaunchContext | null = null;
  #destinations: ReviewDestination[] = [];
  #tool: ToolKind = "pen";

  constructor(options: OverlayOptions) {
    super();
    this.#hooks = options.hooks;
    this.#opts = {
      hooks: options.hooks,
      toggleShortcut: options.toggleShortcut ?? DEFAULTS.toggleShortcut,
      submitShortcut: options.submitShortcut ?? DEFAULTS.submitShortcut,
      passthroughShortcut: options.passthroughShortcut ?? DEFAULTS.passthroughShortcut,
      clearOnSubmit: options.clearOnSubmit ?? DEFAULTS.clearOnSubmit,
      screenshotDelayMs: options.screenshotDelayMs ?? DEFAULTS.screenshotDelayMs,
      includeComposite: options.includeComposite ?? DEFAULTS.includeComposite,
      tint: options.tint ?? DEFAULTS.tint,
      colors: options.colors ?? DEFAULTS.colors,
      defaultColor: options.defaultColor ?? DEFAULTS.defaultColor,
      defaultStrokeWidth: options.defaultStrokeWidth ?? DEFAULTS.defaultStrokeWidth,
      host: options.host,
    };
  }

  async enable(): Promise<void> {
    if (this.#enabled) return;
    if (!app.isReady()) await app.whenReady();
    this.#registerIpc();
    this.#registerShortcuts();
    screen.on("display-added", this.#onDisplaysChanged);
    screen.on("display-removed", this.#onDisplaysChanged);
    screen.on("display-metrics-changed", this.#onDisplaysChanged);
    this.#enabled = true;
  }

  destroy(): void {
    if (this.#opts.toggleShortcut) globalShortcut.unregister(this.#opts.toggleShortcut);
    globalShortcut.unregister(this.#opts.submitShortcut);
    globalShortcut.unregister(this.#opts.passthroughShortcut);
    screen.removeListener("display-added", this.#onDisplaysChanged);
    screen.removeListener("display-removed", this.#onDisplaysChanged);
    screen.removeListener("display-metrics-changed", this.#onDisplaysChanged);
    this.#unregisterIpc();
    this.#destroyResumeWindow();
    this.#destroyWindows();
    this.#annotations.clear();
    this.#frames = [];
    this.#currentFrameIndex = 0;
    this.#nextFrameNumber = 1;
    this.#enabled = false;
    this.#visible = false;
  }

  async show(context?: OverlayLaunchContext): Promise<void> {
    if (this.#submitting) return;
    if (!this.#enabled) await this.enable();
    this.#launch = context ?? null;
    if (this.#windows.size === 0) this.#buildWindows();
    try {
      await this.#waitForRenderersReady();
    } catch (err) {
      this.#destroyWindows();
      this.#annotations.clear();
      this.#frames = [];
      this.#currentFrameIndex = 0;
      throw err;
    }
    this.#passthrough = false;
    // Fetch freestyle destinations up front (only when not bound to a session).
    const destinations = this.#launch?.sessionId ? [] : await this.#fetchDestinations();
    this.#destinations = destinations;
    this.#ensureFrame();
    this.#hydrateCurrentFrame();
    this.#visible = true;
    let primary = true;
    for (const win of this.#windows.values()) {
      if (win.isDestroyed()) continue;
      // The primary window takes real OS focus so the text tool and microphone
      // work; others are shown without stealing focus.
      if (primary) {
        win.show();
        win.setAlwaysOnTop(true, "screen-saver");
        applyInteractive(win, true);
        win.focus();
        win.webContents.focus();
        primary = false;
      } else {
        win.showInactive();
        win.setAlwaysOnTop(true, "screen-saver");
        applyInteractive(win, true);
      }
      this.#sendSession(win);
      this.#sendFrameState(win);
      win.webContents.send(CH.setTool, this.#tool);
    }
    this.emit("visibility", true);
  }

  async #fetchDestinations(): Promise<ReviewDestination[]> {
    if (!this.#hooks.listDestinations) return [];
    try {
      return (await this.#hooks.listDestinations()) ?? [];
    } catch (err) {
      this.#reportError("listDestinations hook failed", err);
      return [];
    }
  }

  /** The target used when submit() is called without an explicit one. */
  #defaultTarget(): ReviewTarget {
    if (this.#launch?.sessionId) {
      const t: ReviewTarget = { sessionId: this.#launch.sessionId, isNew: false };
      if (this.#launch.sessionTitle) t.sessionTitle = this.#launch.sessionTitle;
      return t;
    }
    return { isNew: true };
  }

  #currentDisplays(): DisplayInfo[] {
    return screen.getAllDisplays().map(toDisplayInfo);
  }

  #newFrame(displays: readonly DisplayInfo[] = this.#currentDisplays()): OverlayFrameSnapshot {
    return {
      id: `frame-${this.#nextFrameNumber++}`,
      createdAt: Date.now(),
      displays: displays.map((d) => ({ ...d })),
      screenshots: [],
      annotationsByDisplayId: new Map(),
      dirty: true,
    };
  }

  #ensureFrame(): OverlayFrameSnapshot {
    if (this.#frames.length === 0) {
      this.#frames.push(this.#newFrame());
      this.#currentFrameIndex = 0;
    }
    if (this.#currentFrameIndex < 0) this.#currentFrameIndex = 0;
    if (this.#currentFrameIndex >= this.#frames.length) {
      this.#currentFrameIndex = this.#frames.length - 1;
    }
    return this.#frames[this.#currentFrameIndex]!;
  }

  #saveCurrentFrame(): void {
    if (this.#windows.size === 0) return;
    const frame = this.#ensureFrame();
    for (const [wcId, list] of this.#annotations) {
      const display = this.#displayByWc.get(wcId);
      if (!display) continue;
      frame.annotationsByDisplayId.set(display.id, list.map(cloneAnnotation));
    }
  }

  #frameAnnotationsRaw(frame: OverlayFrameSnapshot): Annotation[] {
    const out: Annotation[] = [];
    for (const list of frame.annotationsByDisplayId.values())
      out.push(...list.map(cloneAnnotation));
    return out;
  }

  #frameAnnotations(frame: OverlayFrameSnapshot): Annotation[] {
    return submittableAnnotations(this.#frameAnnotationsRaw(frame));
  }

  #rebucketFrameForDisplays(frame: OverlayFrameSnapshot, displays: readonly DisplayInfo[]): void {
    const preserved = this.#frameAnnotationsRaw(frame);
    frame.annotationsByDisplayId.clear();
    frame.displays = displays.map((d) => ({ ...d }));
    frame.screenshots = [];
    frame.dirty = true;
    for (const a of preserved) {
      const target = displayForPoint(annotationAnchor(a), displays);
      const displayId = target?.id ?? a.displayId;
      const bucket = frame.annotationsByDisplayId.get(displayId) ?? [];
      bucket.push({ ...a, displayId });
      frame.annotationsByDisplayId.set(displayId, bucket);
    }
  }

  #frameRawCount(frame: OverlayFrameSnapshot): number {
    let n = 0;
    for (const list of frame.annotationsByDisplayId.values()) n += list.length;
    return n;
  }

  #totalRawCount(): number {
    this.#saveCurrentFrame();
    return this.#frames.reduce((sum, frame) => sum + this.#frameRawCount(frame), 0);
  }

  #totalSubmittableCount(): number {
    this.#saveCurrentFrame();
    return this.#frames.reduce((sum, frame) => sum + this.#frameAnnotations(frame).length, 0);
  }

  #hydrateWindow(win: BrowserWindow, display: DisplayInfo, frame = this.#ensureFrame()): void {
    const annotations = frame.annotationsByDisplayId.get(display.id)?.map(cloneAnnotation) ?? [];
    this.#annotations.set(win.webContents.id, annotations);
    win.webContents.send(CH.hydrate, {
      frameId: frame.id,
      annotations,
    } satisfies HydrateMessage);
    this.#sendFrameState(win);
  }

  #hydrateCurrentFrame(): void {
    const frame = this.#ensureFrame();
    for (const [wcId, win] of this.#windows) {
      if (win.isDestroyed()) continue;
      const display = this.#displayByWc.get(wcId);
      if (!display) continue;
      this.#hydrateWindow(win, display, frame);
    }
  }

  #sendFrameState(win: BrowserWindow): void {
    if (win.isDestroyed()) return;
    const frame = this.#ensureFrame();
    const display = this.#displayByWc.get(win.webContents.id);
    const annotationCount = display
      ? (frame.annotationsByDisplayId.get(display.id)?.length ?? 0)
      : 0;
    win.webContents.send(CH.frameState, {
      frameId: frame.id,
      index: this.#currentFrameIndex,
      count: this.#frames.length,
      annotationCount,
      totalAnnotationCount: this.#totalRawCount(),
      busy: this.#frameBusy || this.#submitting,
    } satisfies FrameStateMessage);
  }

  #broadcastFrameState(): void {
    for (const win of this.#windows.values()) this.#sendFrameState(win);
  }

  hide(): void {
    if (this.#submitting) return;
    this.#passthrough = false;
    for (const win of this.#windows.values()) {
      if (win.isDestroyed()) continue;
      this.#sendSession(win, false);
      win.hide();
    }
    this.#destroyResumeWindow();
    this.#visible = false;
    this.#launch = null;
    this.#destinations = [];
    this.emit("visibility", false);
  }

  isPassthrough(): boolean {
    return this.#passthrough;
  }

  setPassthrough(on: boolean): void {
    if (!this.#visible || this.#submitting || on === this.#passthrough) return;
    this.#passthrough = on;
    let focused = false;
    for (const win of this.#windows.values()) {
      if (win.isDestroyed()) continue;
      applyInteractive(win, !on);
      if (on) {
        // Release focus so keyboard input reaches the app underneath, not the
        // (now click-through) overlay.
        win.blur();
      } else if (!focused) {
        win.focus();
        win.webContents.focus();
        focused = true;
      }
      this.#sendSession(win);
    }
    this.#updateResumeWindow();
    this.emit("passthrough", on);
  }

  #updateResumeWindow(): void {
    if (this.#passthrough && this.#visible) {
      if (!this.#resumeWindow || this.#resumeWindow.isDestroyed()) {
        const primary = screen.getPrimaryDisplay();
        this.#resumeWindow = createResumeWindow(toDisplayInfo(primary), this.#paths);
      }
      const rw = this.#resumeWindow;
      rw.showInactive();
      rw.setAlwaysOnTop(true, "screen-saver");
    } else if (this.#resumeWindow && !this.#resumeWindow.isDestroyed()) {
      this.#resumeWindow.hide();
    }
  }

  #destroyResumeWindow(): void {
    if (this.#resumeWindow && !this.#resumeWindow.isDestroyed()) {
      this.#resumeWindow.destroy();
    }
    this.#resumeWindow = undefined;
  }

  togglePassthrough(): void {
    this.setPassthrough(!this.#passthrough);
  }

  undo(): void {
    this.#broadcastEdit("undo");
  }

  redo(): void {
    this.#broadcastEdit("redo");
  }

  async toggle(context?: OverlayLaunchContext): Promise<void> {
    if (this.#submitting) return;
    if (this.#visible) this.hide();
    else await this.show(context);
  }

  isVisible(): boolean {
    return this.#visible;
  }

  setTool(tool: ToolKind): void {
    this.#tool = tool;
    for (const win of this.#windows.values()) {
      if (!win.isDestroyed()) win.webContents.send(CH.setTool, tool);
    }
  }

  clear(): void {
    this.#frames = [this.#newFrame()];
    this.#currentFrameIndex = 0;
    for (const [wcId, win] of this.#windows) {
      this.#annotations.set(wcId, []);
      if (!win.isDestroyed()) {
        win.webContents.send(CH.clear);
        this.#sendFrameState(win);
      }
    }
  }

  annotationCount(): number {
    return this.#totalRawCount();
  }

  #framesForSubmit(): AssembleReviewFrameInput[] {
    this.#saveCurrentFrame();
    const frames: AssembleReviewFrameInput[] = [];
    for (const frame of this.#frames) {
      const annotations = this.#frameAnnotations(frame);
      if (annotations.length === 0 && !hasAnyImage(frame.screenshots)) continue;
      frames.push({
        id: frame.id,
        createdAt: frame.createdAt,
        annotations,
        displays: frame.displays.map((d) => ({ ...d })),
        screenshots: frame.screenshots.map((s) => ({ ...s })),
      });
    }
    return frames;
  }

  async #captureCurrentFrame(): Promise<boolean> {
    this.#saveCurrentFrame();
    const frame = this.#ensureFrame();
    const displays = this.#currentDisplays();
    const annotations = this.#frameAnnotations(frame);
    const needImage = annotations.length > 0;
    const shownWindows = [...this.#windows.values()].filter(
      (w) => !w.isDestroyed() && w.isVisible(),
    );
    let captureMissing = false;
    this.#captureFailure = null;

    try {
      let composites: ScreenshotData[] = [];
      if (shownWindows.length > 0 && this.#opts.includeComposite) {
        try {
          for (const win of shownWindows) {
            if (!win.isDestroyed()) win.webContents.send(CH.captureMode, true);
          }
          await delay(170);
          composites = await this.#captureOrDegrade(displays);
        } catch {
          composites = [];
        } finally {
          for (const win of shownWindows) {
            if (!win.isDestroyed()) win.webContents.send(CH.captureMode, false);
          }
        }
        await delay(30);
      }

      for (const win of shownWindows) win.hide();
      if (shownWindows.length > 0) await delay(this.#opts.screenshotDelayMs);

      // If the composite pass already failed hard (timeout / permission), the
      // clean pass will fail the same way — don't make the user wait twice.
      let screenshots =
        needImage && !this.#captureFailure ? await this.#captureOrDegrade(displays) : [];
      // Retrying a timed-out / permission-denied capture only stalls the user
      // further, so stop as soon as a capture reports a hard failure.
      for (
        let attempt = 0;
        attempt < 5 && needImage && !hasAnyImage(screenshots) && !this.#captureFailure;
        attempt++
      ) {
        await delay(220);
        screenshots = await this.#captureOrDegrade(displays);
      }

      for (const s of screenshots) {
        const comp = composites.find((c) => c.displayId === s.displayId);
        if (comp && comp.pngBase64) s.compositePngBase64 = comp.pngBase64;
      }

      captureMissing = needImage && !hasAnyImage(screenshots);
      if (captureMissing && !this.#captureFailure) {
        const hint = screenCapturePermissionHint();
        this.#captureFailure =
          `Screen capture returned no image data.${hint ? ` ${hint}` : ""}`;
        this.#reportError(this.#captureFailure);
      }

      frame.displays = displays.map((d) => ({ ...d }));
      frame.screenshots = screenshots.map((s) => ({ ...s }));
      frame.dirty = false;
    } finally {
      let primary = true;
      for (const win of shownWindows) {
        if (win.isDestroyed()) continue;
        win.setAlwaysOnTop(true, "screen-saver");
        applyInteractive(win, !this.#passthrough);
        if (primary && !this.#passthrough) {
          win.show();
          win.focus();
          win.webContents.focus();
          primary = false;
        } else {
          win.showInactive();
        }
        this.#sendSession(win);
        this.#sendFrameState(win);
      }
    }

    return captureMissing;
  }

  async #captureCurrentFrameIfNeeded(): Promise<void> {
    this.#saveCurrentFrame();
    const frame = this.#ensureFrame();
    if (!frame.dirty || this.#frameAnnotations(frame).length === 0) return;
    await this.#captureCurrentFrame();
  }

  async #handleFrameAction(req?: FrameActionRequest): Promise<void> {
    if (!req || this.#submitting || this.#frameBusy) return;
    if (!this.#visible) return;
    this.#frameBusy = true;
    const wasVisible = this.#visible;
    try {
      this.#setMode("submitting");
      this.#broadcastFrameState();
      if (req.action === "add") {
        this.#notice("Capturing current frame…", "info", 0);
        await this.#captureCurrentFrameIfNeeded();
        const next = this.#newFrame();
        this.#frames.splice(this.#currentFrameIndex + 1, 0, next);
        this.#currentFrameIndex += 1;
        this.#hydrateCurrentFrame();
        // The frame is added either way; a failed capture is reported without
        // discarding the user's marks.
        if (this.#captureFailure) {
          this.#notice(
            `Frame ${this.#currentFrameIndex + 1} of ${this.#frames.length} added, but the screenshot failed. ${this.#captureFailure}`,
            "error",
            0,
          );
        } else {
          this.#notice(
            `Frame ${this.#currentFrameIndex + 1} of ${this.#frames.length} ready.`,
            "success",
          );
        }
        return;
      }

      if (req.action === "previous" || req.action === "next") {
        const delta = req.action === "previous" ? -1 : 1;
        const nextIndex = this.#currentFrameIndex + delta;
        if (nextIndex < 0 || nextIndex >= this.#frames.length) {
          this.#notice(
            req.action === "previous"
              ? "Already on the first frame."
              : "Already on the last frame.",
            "info",
          );
          return;
        }
        this.#notice("Saving current frame…", "info", 0);
        await this.#captureCurrentFrameIfNeeded();
        this.#currentFrameIndex = nextIndex;
        this.#hydrateCurrentFrame();
        this.#notice(`Frame ${this.#currentFrameIndex + 1} of ${this.#frames.length}.`, "info");
        return;
      }

      if (req.action === "move-previous" || req.action === "move-next") {
        const delta = req.action === "move-previous" ? -1 : 1;
        const nextIndex = this.#currentFrameIndex + delta;
        if (nextIndex < 0 || nextIndex >= this.#frames.length) {
          this.#notice(
            req.action === "move-previous" ? "Already the first frame." : "Already the last frame.",
            "info",
          );
          return;
        }
        this.#saveCurrentFrame();
        const [frame] = this.#frames.splice(this.#currentFrameIndex, 1);
        if (!frame) return;
        this.#frames.splice(nextIndex, 0, frame);
        this.#currentFrameIndex = nextIndex;
        this.#hydrateCurrentFrame();
        this.#notice(
          `Moved frame to ${this.#currentFrameIndex + 1} of ${this.#frames.length}.`,
          "info",
        );
        return;
      }

      if (req.action === "delete") {
        if (this.#frames.length <= 1) {
          const frame = this.#ensureFrame();
          frame.annotationsByDisplayId.clear();
          frame.screenshots = [];
          frame.displays = this.#currentDisplays();
          frame.dirty = true;
          this.#hydrateCurrentFrame();
          this.#notice("Cleared the only frame.", "info");
          return;
        }
        this.#frames.splice(this.#currentFrameIndex, 1);
        if (this.#currentFrameIndex >= this.#frames.length) {
          this.#currentFrameIndex = this.#frames.length - 1;
        }
        this.#hydrateCurrentFrame();
        this.#notice(
          `Deleted frame. Frame ${this.#currentFrameIndex + 1} of ${this.#frames.length}.`,
          "info",
        );
      }
    } catch (err) {
      this.#reportError("Frame action failed", err);
      this.#notice(
        `Frame action failed — your current marks are kept. ${err instanceof Error ? err.message : String(err)}`,
        "error",
        0,
      );
    } finally {
      this.#frameBusy = false;
      this.#broadcastFrameState();
      this.#setMode(!wasVisible ? "idle" : this.#passthrough ? "passthrough" : "drawing");
    }
  }

  async submit(target?: ReviewTarget): Promise<ReviewPayload | null> {
    if (this.#submitting || this.#frameBusy) return null;
    if (this.#totalSubmittableCount() === 0) {
      this.#notice("Nothing to send yet — draw, type, or drop a voice pin first.", "info");
      return null;
    }
    const resolvedTarget: ReviewTarget = target ?? this.#defaultTarget();
    this.#submitting = true;
    const wasVisible = this.#visible;
    let failed = false;

    try {
      this.#setMode("submitting");
      this.#notice("Sending all frames to the agent…", "info", 0);
      this.#broadcastFrameState();
      await this.#captureCurrentFrame();
      const frames = this.#framesForSubmit();
      const captureMissing = frames.some(
        (frame) => frame.annotations.length > 0 && !hasAnyImage(frame.screenshots),
      );

      const payload = assembleReviewPayload({
        frames,
        host: this.#opts.host ?? {},
        target: resolvedTarget,
      });

      await this.#hooks.onSubmitReview(payload);
      this.emit("submit", payload);
      const dest = resolvedTarget.isNew
        ? "a new session"
        : resolvedTarget.sessionTitle
          ? `"${resolvedTarget.sessionTitle}"`
          : "the session";
      this.#notice(
        captureMissing
          ? `Review sent to ${dest} without screenshots. ${this.#captureFailure ?? "Screen capture returned no image data."}`
          : `Review sent to ${dest} — ${payload.summary.annotationCount} item(s) across ${payload.frames.length} frame(s).`,
        captureMissing ? "error" : "success",
        captureMissing ? 0 : undefined,
      );

      if (this.#opts.clearOnSubmit) this.clear();

      return payload;
    } catch (err) {
      failed = true;
      this.#reportError("Submit failed", err);
      this.#notice(
        `Send failed — your frames are kept. Press ${this.#opts.submitShortcut} to retry. ${err instanceof Error ? err.message : String(err)}`,
        "error",
        0,
      );
      return null;
    } finally {
      this.#submitting = false;
      this.#broadcastFrameState();
      // Always emit a terminal mode (covers the hidden-window case too):
      // preserve 'error' on failure; otherwise return to the interactive state.
      const terminal: OverlayMode = failed
        ? "error"
        : !wasVisible
          ? "idle"
          : this.#passthrough
            ? "passthrough"
            : "drawing";
      this.#setMode(terminal);
    }
  }

  // ---- internal ----

  #notice(text: string, kind: NoticeMessage["kind"], timeoutMs = 2600): void {
    for (const win of this.#windows.values()) {
      if (!win.isDestroyed()) {
        win.webContents.send(CH.notice, { text, kind, timeoutMs } satisfies NoticeMessage);
      }
    }
  }

  #sendSession(win: BrowserWindow, active = true): void {
    if (win.isDestroyed()) return;
    const msg: SessionMessage = {
      active,
      passthrough: this.#passthrough,
    };
    if (this.#launch?.sessionId) {
      msg.boundSessionId = this.#launch.sessionId;
      if (this.#launch.sessionTitle) msg.boundSessionTitle = this.#launch.sessionTitle;
    } else if (this.#destinations.length > 0) {
      msg.destinations = this.#destinations;
    }
    win.webContents.send(CH.session, msg);
  }

  #broadcastEdit(action: "undo" | "redo"): void {
    for (const win of this.#windows.values()) {
      if (!win.isDestroyed()) {
        win.webContents.send(CH.edit, { action } satisfies EditMessage);
      }
    }
  }

  async #capture(displays: readonly DisplayInfo[]): Promise<ScreenshotData[]> {
    const work = this.#hooks.captureScreenshot
      ? Promise.resolve(this.#hooks.captureScreenshot(displays))
      : captureDisplays(displays);
    const hint = screenCapturePermissionHint();
    return await withTimeout(
      work,
      CAPTURE_TIMEOUT_MS,
      `Screen capture timed out after ${CAPTURE_TIMEOUT_MS / 1000}s.${hint ? ` ${hint}` : ""}`,
    );
  }

  /**
   * Capture, degrading to "no screenshots" instead of throwing. A failed
   * capture must never abort the surrounding frame action or submit: the user's
   * marks are the irreplaceable part, so we keep going and tell them what broke.
   */
  async #captureOrDegrade(displays: readonly DisplayInfo[]): Promise<ScreenshotData[]> {
    try {
      return await this.#capture(displays);
    } catch (err) {
      const hint = screenCapturePermissionHint();
      this.#captureFailure = `${err instanceof Error ? err.message : String(err)}${
        hint && !String(err).includes(hint) ? ` ${hint}` : ""
      }`;
      this.#reportError(this.#captureFailure, err);
      return [];
    }
  }

  #buildWindows(): void {
    for (const d of screen.getAllDisplays()) {
      const display = toDisplayInfo(d);
      const win = createOverlayWindow(display, this.#paths);
      const wcId = win.webContents.id;
      this.#windows.set(wcId, win);
      this.#displayByWc.set(wcId, display);
      this.#annotations.set(wcId, []);
      this.#trackRendererReadiness(win);
      win.webContents.on(
        "did-fail-load",
        (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
          if (isMainFrame === false) return;
          if (errorCode === -3) return;
          this.#handleRendererFailure(
            wcId,
            new Error(
              `Overlay renderer failed to load ${validatedURL || this.#paths.rendererHtml} (${errorCode}: ${errorDescription})`,
            ),
          );
        },
      );
      win.webContents.on("render-process-gone", (_event, details) => {
        this.#handleRendererFailure(
          wcId,
          new Error(
            `Overlay renderer process exited (${details.reason}, exitCode ${details.exitCode})`,
          ),
        );
      });
      win.webContents.on("unresponsive", () => {
        this.#handleRendererFailure(wcId, new Error("Overlay renderer became unresponsive."));
      });
      win.on("closed", () => {
        this.#windows.delete(wcId);
        this.#displayByWc.delete(wcId);
        this.#annotations.delete(wcId);
        this.#rendererReady.delete(wcId);
      });
    }
  }

  #destroyWindows(): void {
    for (const win of this.#windows.values()) {
      if (!win.isDestroyed()) win.destroy();
    }
    this.#windows.clear();
    this.#displayByWc.clear();
    this.#rendererReady.clear();
  }

  #trackRendererReadiness(win: BrowserWindow): void {
    const wcId = win.webContents.id;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    void promise.catch(() => undefined);
    this.#rendererReady.set(wcId, { promise, resolve, reject, settled: false });
  }

  #rejectRendererReady(wcId: number, error: Error): void {
    const entry = this.#rendererReady.get(wcId);
    if (!entry || entry.settled) return;
    entry.settled = true;
    entry.reject(error);
  }

  async #waitForRenderersReady(): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const [wcId, win] of this.#windows) {
      if (win.isDestroyed()) continue;
      const entry = this.#rendererReady.get(wcId);
      if (!entry) {
        throw new Error(`Overlay renderer ${wcId} has no readiness tracker.`);
      }
      waits.push(this.#withRendererReadyTimeout(wcId, entry.promise));
    }
    await Promise.all(waits);
  }

  async #withRendererReadyTimeout(wcId: number, promise: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = new Error(
              `Screen review overlay did not finish loading within ${RENDERER_READY_TIMEOUT_MS / 1000}s; not showing the overlay.`,
            );
            this.#rejectRendererReady(wcId, error);
            reject(error);
          }, RENDERER_READY_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #initializeRenderer(win: BrowserWindow): void {
    if (win.isDestroyed()) return;
    const wcId = win.webContents.id;
    const display = this.#displayByWc.get(wcId);
    if (!display) return;

    win.webContents.send(CH.init, {
      display,
      config: this.#rendererConfig(),
    } satisfies InitMessage);
    win.webContents.send(CH.setTool, this.#tool);

    const frame = this.#ensureFrame();
    const restore = this.#pendingHydrate.get(display.id);
    if (restore && restore.length > 0) {
      frame.annotationsByDisplayId.set(display.id, restore.map(cloneAnnotation));
      this.#pendingHydrate.delete(display.id);
    }
    this.#hydrateWindow(win, display, frame);

    if (this.#visible) this.#sendSession(win);
  }

  #handleRendererFailure(wcId: number, error: Error): void {
    this.#rejectRendererReady(wcId, error);
    if (this.#visible) this.#failVisibleOverlay(error);
  }

  #failVisibleOverlay(error: Error): void {
    const wasVisible = this.#visible;
    for (const win of this.#windows.values()) {
      if (!win.isDestroyed()) applyInteractive(win, false);
    }
    this.#destroyResumeWindow();
    this.#destroyWindows();
    this.#annotations.clear();
    this.#frames = [];
    this.#currentFrameIndex = 0;
    this.#passthrough = false;
    this.#submitting = false;
    this.#visible = false;
    this.#launch = null;
    this.#destinations = [];
    this.#setMode("error");
    this.#reportError(error.message, error);
    if (wasVisible) this.emit("visibility", false);
  }

  #onDisplaysChanged = (): void => {
    // Rebuilding windows underneath an in-flight capture would strand the
    // frame action on destroyed webContents, so skip while busy too.
    if (this.#submitting || this.#frameBusy) return;
    const wasVisible = this.#visible;
    this.#saveCurrentFrame();
    const newDisplays = screen.getAllDisplays().map(toDisplayInfo);
    for (const frame of this.#frames) this.#rebucketFrameForDisplays(frame, newDisplays);
    const current = this.#ensureFrame();
    this.#pendingHydrate.clear();
    for (const [displayId, annotations] of current.annotationsByDisplayId) {
      this.#pendingHydrate.set(displayId, annotations.map(cloneAnnotation));
    }
    this.#destroyWindows();
    this.#annotations.clear();
    if (wasVisible) {
      // Preserve the session binding across the layout change.
      void this.show(this.#launch ?? undefined);
    } else {
      // Not visible: rebuild lazily on next show(); keep pending for hydration.
      this.#buildWindows();
    }
  };

  #rendererConfig(): OverlayRendererConfig {
    return {
      colors: this.#opts.colors,
      defaultColor: this.#opts.defaultColor,
      defaultStrokeWidth: this.#opts.defaultStrokeWidth,
      tint: this.#opts.tint,
      voiceEnabled: true,
      toggleShortcutLabel: this.#opts.toggleShortcut || "",
      submitShortcutLabel: this.#opts.submitShortcut,
      passthroughShortcutLabel: this.#opts.passthroughShortcut,
    };
  }

  #registerShortcuts(): void {
    const tryRegister = (accel: string | false, label: string, fn: () => void): void => {
      if (!accel) return;
      try {
        const ok = globalShortcut.register(accel, fn);
        if (!ok) {
          this.#reportError(
            `Could not register the ${label} shortcut "${accel}" (already in use by another app). ` +
              `Use the toolbar buttons, or pass a different shortcut in OverlayOptions.`,
          );
        }
      } catch (err) {
        this.#reportError(`Failed to register the ${label} shortcut "${accel}"`, err);
      }
    };
    tryRegister(this.#opts.toggleShortcut, "toggle-review", () => {
      void this.toggle();
    });
    tryRegister(this.#opts.submitShortcut, "submit", () => {
      if (this.#visible) this.#requestSubmitFromRenderer();
    });
    tryRegister(this.#opts.passthroughShortcut, "pass-through", () => {
      if (this.#visible) this.togglePassthrough();
    });
  }

  #onSync = (e: IpcMainEvent, msg: SyncMessage): void => {
    if (!this.#windows.has(e.sender.id)) return;
    const frame = this.#ensureFrame();
    if (msg.frameId !== frame.id) return;
    const annotations = msg.annotations ?? [];
    this.#annotations.set(e.sender.id, annotations);
    const display = this.#displayByWc.get(e.sender.id);
    if (display) {
      frame.annotationsByDisplayId.set(display.id, annotations.map(cloneAnnotation));
      if (this.#frameAnnotations(frame).length === 0) frame.screenshots = [];
      frame.dirty = true;
    }
    const win = this.#windows.get(e.sender.id);
    if (win) this.#sendFrameState(win);
  };

  #onRequestPassthrough = (e: IpcMainEvent, msg: PassthroughRequest): void => {
    if (!this.#windows.has(e.sender.id)) return;
    this.setPassthrough(Boolean(msg?.on));
  };

  #onMode = (e: IpcMainEvent, msg: ModeMessage): void => {
    if (!this.#windows.has(e.sender.id) || this.#submitting || this.#frameBusy) return;
    this.#setMode(msg.mode);
  };

  #onReady = (e: IpcMainEvent): void => {
    const entry = this.#rendererReady.get(e.sender.id);
    if (!entry || entry.settled) return;
    const win = this.#windows.get(e.sender.id);
    if (!win || win.isDestroyed()) return;
    entry.settled = true;
    this.#initializeRenderer(win);
    entry.resolve();
  };

  #onSubmit = (e: IpcMainEvent, req?: SubmitRequest): void => {
    if (this.#windows.has(e.sender.id)) void this.submit(req?.target);
  };

  #onFrameAction = (e: IpcMainEvent, req?: FrameActionRequest): void => {
    if (this.#windows.has(e.sender.id)) void this.#handleFrameAction(req);
  };

  /** Ask the focused overlay to begin a submit; the renderer resolves the
   * target (bound session → direct; freestyle → destination picker). */
  #requestSubmitFromRenderer(): void {
    const win = this.#focusedOverlay() ?? this.#firstOverlay();
    if (win && !win.isDestroyed()) win.webContents.send(CH.requestSubmit);
  }

  #focusedOverlay(): BrowserWindow | undefined {
    for (const win of this.#windows.values()) {
      if (!win.isDestroyed() && win.isFocused()) return win;
    }
    return undefined;
  }

  #firstOverlay(): BrowserWindow | undefined {
    for (const win of this.#windows.values()) {
      if (!win.isDestroyed()) return win;
    }
    return undefined;
  }

  #onExit = (e: IpcMainEvent): void => {
    if (this.#windows.has(e.sender.id)) this.hide();
  };

  #onResume = (e: IpcMainEvent): void => {
    // From the resume pill window (not in #windows) — accept unconditionally.
    if (this.#resumeWindow && e.sender.id === this.#resumeWindow.webContents.id) {
      this.setPassthrough(false);
    }
  };

  #onError = (e: IpcMainEvent, msg: ErrorMessage): void => {
    if (this.#windows.has(e.sender.id)) this.#reportError(msg.message);
  };

  #onTranscribe = async (_e: IpcMainInvokeEvent, req: TranscribeRequest): Promise<string> => {
    if (!this.#hooks.transcribe) return "";
    try {
      return await this.#hooks.transcribe(req.clip);
    } catch (err) {
      this.#reportError("Transcription failed", err);
      throw err instanceof Error ? err : new Error(String(err));
    }
  };

  #registerIpc(): void {
    ipcMain.on(CH.ready, this.#onReady);
    ipcMain.on(CH.sync, this.#onSync);
    ipcMain.on(CH.requestPassthrough, this.#onRequestPassthrough);
    ipcMain.on(CH.mode, this.#onMode);
    ipcMain.on(CH.submit, this.#onSubmit);
    ipcMain.on(CH.frameAction, this.#onFrameAction);
    ipcMain.on(CH.exit, this.#onExit);
    ipcMain.on(CH.resume, this.#onResume);
    ipcMain.on(CH.error, this.#onError);
    ipcMain.handle(CH.transcribe, this.#onTranscribe);
  }

  #unregisterIpc(): void {
    ipcMain.removeListener(CH.ready, this.#onReady);
    ipcMain.removeListener(CH.sync, this.#onSync);
    ipcMain.removeListener(CH.requestPassthrough, this.#onRequestPassthrough);
    ipcMain.removeListener(CH.mode, this.#onMode);
    ipcMain.removeListener(CH.submit, this.#onSubmit);
    ipcMain.removeListener(CH.frameAction, this.#onFrameAction);
    ipcMain.removeListener(CH.exit, this.#onExit);
    ipcMain.removeListener(CH.resume, this.#onResume);
    ipcMain.removeListener(CH.error, this.#onError);
    ipcMain.removeHandler(CH.transcribe);
  }

  #setMode(mode: OverlayMode): void {
    this.#hooks.onModeChange?.(mode);
    this.emit("mode", mode);
  }

  #reportError(message: string, cause?: unknown): void {
    const err = { message, cause };
    this.#hooks.onError?.(err);
    // Avoid Node's unhandled 'error' event crash when the host attached no
    // listener; the hook above already delivered it.
    if (this.listenerCount("error") > 0) this.emit("error", err);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** Create an overlay controller. Call {@link OverlayController.enable} after the
 * Electron app is (or will be) ready, then {@link OverlayController.show}. */
export function createOverlay(options: OverlayOptions): OverlayController {
  return new OverlayControllerImpl(options);
}
