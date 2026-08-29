// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  EditMessage,
  FrameStateMessage,
  HydrateMessage,
  InitMessage,
  ModeMessage,
  NoticeMessage,
  OverlayBridge,
  PassthroughRequest,
  SessionMessage,
  SubmitRequest,
  SyncMessage,
  TranscribeRequest,
} from "../main/ipc-channels.ts";
import { OverlayApp } from "./overlay-app.ts";

interface Handlers {
  init?: (msg: InitMessage) => void;
  session?: (msg: SessionMessage) => void;
  clear?: () => void;
  hydrate?: (msg: HydrateMessage) => void;
  frameState?: (msg: FrameStateMessage) => void;
}

interface OverlayTestApi {
  addRect: (x: number, y: number, w: number, h: number) => string;
  addText: (x: number, y: number, text: string) => string;
  state: () => { count: number; frame: FrameStateMessage };
}

function installBridge(): { bridge: OverlayBridge; handlers: Handlers } {
  const handlers: Handlers = {};
  const bridge: OverlayBridge = {
    onInit(cb) {
      handlers.init = cb;
    },
    onSetTool() {},
    onSetMode() {},
    onSession(cb) {
      handlers.session = cb;
    },
    onClear(cb) {
      handlers.clear = cb;
    },
    onHydrate(cb) {
      handlers.hydrate = cb;
    },
    onNotice(_cb: (msg: NoticeMessage) => void) {},
    onCaptureMode() {},
    onRequestSubmit() {},
    onEdit(_cb: (msg: EditMessage) => void) {},
    onFrameState(cb) {
      handlers.frameState = cb;
    },
    ready: vi.fn(),
    sync: vi.fn<(msg: SyncMessage) => void>(),
    requestPassthrough: vi.fn<(msg: PassthroughRequest) => void>(),
    reportMode: vi.fn<(msg: ModeMessage) => void>(),
    submit: vi.fn<(req: SubmitRequest) => void>(),
    frameAction: vi.fn(),
    exit: vi.fn(),
    resume: vi.fn(),
    reportError: vi.fn(),
    transcribe: vi.fn<(req: TranscribeRequest) => Promise<string>>().mockResolvedValue(""),
  };
  window.overlayBridge = bridge;
  return { bridge, handlers };
}

const initMessage: InitMessage = {
  display: {
    id: 1,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    scaleFactor: 1,
  },
  config: {
    colors: ["#ff3b30", "#0a84ff"],
    defaultColor: "#ff3b30",
    defaultStrokeWidth: 4,
    tint: "rgba(10,12,20,0.06)",
    voiceEnabled: true,
    toggleShortcutLabel: "Ctrl+Shift+Space",
    submitShortcutLabel: "Ctrl+Enter",
    passthroughShortcutLabel: "Ctrl+Shift+S",
  },
};

function overlayTestApi(): OverlayTestApi {
  return (window as unknown as { __overlayTest: OverlayTestApi }).__overlayTest;
}

describe("OverlayApp multi-frame UI", () => {
  afterEach(() => {
    document.body.replaceChildren();
    delete window.overlayBridge;
    delete (window as unknown as { __overlayTest?: unknown }).__overlayTest;
    vi.restoreAllMocks();
  });

  it("signals overlay readiness only after two animation frames", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    const { bridge } = installBridge();
    const app = new OverlayApp();

    app.start();
    expect(bridge.ready).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);

    frames.shift()?.(0);
    expect(bridge.ready).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);

    frames.shift()?.(16);
    expect(bridge.ready).toHaveBeenCalledTimes(1);
  });

  it("sends frame actions from the toolbar", () => {
    const { bridge, handlers } = installBridge();
    const app = new OverlayApp();
    app.start();
    handlers.init?.(initMessage);
    handlers.session?.({ active: true, passthrough: false, boundSessionId: "session-1" });
    handlers.frameState?.({
      frameId: "frame-1",
      index: 0,
      count: 1,
      annotationCount: 0,
      totalAnnotationCount: 0,
    });

    document
      .querySelector<HTMLButtonElement>(
        '.frame-group .btn[title="Capture this frame and add another"]',
      )
      ?.click();

    expect(bridge.frameAction).toHaveBeenCalledWith({ action: "add" });

    handlers.frameState?.({
      frameId: "frame-2",
      index: 1,
      count: 2,
      annotationCount: 0,
      totalAnnotationCount: 0,
    });
    document
      .querySelector<HTMLButtonElement>('.frame-group .btn[title="Move frame earlier"]')
      ?.click();

    expect(bridge.frameAction).toHaveBeenLastCalledWith({ action: "move-previous" });
  });

  it("syncs annotations with the active frame id and hydrates frames independently", () => {
    const { bridge, handlers } = installBridge();
    const app = new OverlayApp();
    app.start();
    handlers.init?.(initMessage);
    handlers.session?.({ active: true, passthrough: false, boundSessionId: "session-1" });
    handlers.frameState?.({
      frameId: "frame-1",
      index: 0,
      count: 2,
      annotationCount: 0,
      totalAnnotationCount: 0,
    });

    const api = overlayTestApi();
    api.addRect(10, 20, 30, 40);
    expect(bridge.sync).toHaveBeenLastCalledWith(expect.objectContaining({ frameId: "frame-1" }));

    handlers.hydrate?.({ frameId: "frame-2", annotations: [] });
    handlers.frameState?.({
      frameId: "frame-2",
      index: 1,
      count: 2,
      annotationCount: 0,
      totalAnnotationCount: 1,
    });
    expect(api.state().count).toBe(0);

    api.addText(50, 60, "Second frame only");
    expect(bridge.sync).toHaveBeenLastCalledWith(expect.objectContaining({ frameId: "frame-2" }));

    const callsBeforeClear = vi.mocked(bridge.sync).mock.calls.length;
    handlers.clear?.();
    expect(api.state().count).toBe(0);
    expect(bridge.sync).toHaveBeenCalledTimes(callsBeforeClear);
  });
});
