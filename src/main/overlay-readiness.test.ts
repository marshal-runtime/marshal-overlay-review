import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReviewPayload } from "../shared/review.ts";
import type { Annotation, DisplayInfo } from "../shared/types.ts";
import { createOverlay, resolveOverlayRuntimeDirectory } from "./index.ts";
import { CH, type FrameStateMessage, type HydrateMessage } from "./ipc-channels.ts";

describe("resolveOverlayRuntimeDirectory", () => {
  it("maps packaged assets to app.asar.unpacked", () => {
    const root = path.parse(process.cwd()).root;
    const packaged = path.join(
      root,
      "resources",
      "app.asar",
      "packages",
      "overlay-review",
      "dist",
      "main",
    );

    expect(resolveOverlayRuntimeDirectory(packaged)).toBe(
      path.join(
        root,
        "resources",
        "app.asar.unpacked",
        "packages",
        "overlay-review",
        "dist",
        "main",
      ),
    );
  });

  it("keeps development paths unchanged", () => {
    const development = path.join(process.cwd(), "packages", "overlay-review", "dist", "main");
    expect(resolveOverlayRuntimeDirectory(development)).toBe(development);
  });
});

interface FakeWebContents {
  id: number;
  on: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
}

interface FakeWindow {
  webContents: FakeWebContents;
  on: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  showInactive: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  isVisible: ReturnType<typeof vi.fn>;
  isFocused: ReturnType<typeof vi.fn>;
  setAlwaysOnTop: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  blur: ReturnType<typeof vi.fn>;
  emitWebContents: (event: string, ...args: unknown[]) => void;
}

const mocks = vi.hoisted(() => {
  type LocalHandler = (...args: unknown[]) => void;
  interface LocalWebContents {
    id: number;
    on: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
  }
  interface LocalWindow {
    webContents: LocalWebContents;
    on: ReturnType<typeof vi.fn>;
    isDestroyed: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
    showInactive: ReturnType<typeof vi.fn>;
    hide: ReturnType<typeof vi.fn>;
    isVisible: ReturnType<typeof vi.fn>;
    isFocused: ReturnType<typeof vi.fn>;
    setAlwaysOnTop: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    blur: ReturnType<typeof vi.fn>;
    emitWebContents: (event: string, ...args: unknown[]) => void;
  }

  const display: DisplayInfo = {
    id: 1,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    workArea: { x: 0, y: 0, width: 800, height: 560 },
    scaleFactor: 1,
    rotation: 0,
    internal: true,
    label: "Display 1",
  };
  let displays: DisplayInfo[] = [display];
  const ipcHandlers = new Map<string, LocalHandler[]>();
  const displayHandlers = new Map<string, LocalHandler[]>();
  const overlayWindows: LocalWindow[] = [];
  let nextWebContentsId = 100;

  function pushHandler(
    handlers: Map<string, LocalHandler[]>,
    event: string,
    handler: LocalHandler,
  ): void {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
  }

  function removeHandler(
    handlers: Map<string, LocalHandler[]>,
    event: string,
    handler: LocalHandler,
  ): void {
    const list = handlers.get(event) ?? [];
    handlers.set(
      event,
      list.filter((h) => h !== handler),
    );
  }

  function makeWindow(): LocalWindow {
    const webHandlers = new Map<string, LocalHandler[]>();
    const windowHandlers = new Map<string, LocalHandler[]>();
    let destroyed = false;
    let visible = false;
    const webContents: LocalWebContents = {
      id: nextWebContentsId++,
      on: vi.fn((event: string, handler: LocalHandler) => {
        pushHandler(webHandlers, event, handler);
        return webContents;
      }),
      send: vi.fn(),
      focus: vi.fn(),
    };
    const win: LocalWindow = {
      webContents,
      on: vi.fn((event: string, handler: LocalHandler) => {
        pushHandler(windowHandlers, event, handler);
        return win;
      }),
      isDestroyed: vi.fn(() => destroyed),
      destroy: vi.fn(() => {
        destroyed = true;
        visible = false;
        for (const handler of windowHandlers.get("closed") ?? []) handler();
      }),
      show: vi.fn(() => {
        visible = true;
      }),
      showInactive: vi.fn(() => {
        visible = true;
      }),
      hide: vi.fn(() => {
        visible = false;
      }),
      isVisible: vi.fn(() => visible),
      isFocused: vi.fn(() => visible),
      setAlwaysOnTop: vi.fn(),
      focus: vi.fn(),
      blur: vi.fn(),
      emitWebContents: (event: string, ...args: unknown[]) => {
        for (const handler of webHandlers.get(event) ?? []) handler({}, ...args);
      },
    };
    overlayWindows.push(win);
    return win;
  }

  return {
    app: {
      isReady: vi.fn(() => true),
      whenReady: vi.fn(async () => undefined),
    },
    screen: {
      getAllDisplays: vi.fn(() => displays),
      getPrimaryDisplay: vi.fn(() => displays[0] ?? display),
      on: vi.fn((event: string, handler: LocalHandler) => {
        pushHandler(displayHandlers, event, handler);
      }),
      removeListener: vi.fn((event: string, handler: LocalHandler) => {
        removeHandler(displayHandlers, event, handler);
      }),
      setDisplays: (nextDisplays: DisplayInfo[]) => {
        displays = nextDisplays;
      },
      emitDisplayChange: (event = "display-metrics-changed") => {
        for (const handler of displayHandlers.get(event) ?? []) handler();
      },
    },
    ipcMain: {
      on: vi.fn((channel: string, handler: LocalHandler) => {
        pushHandler(ipcHandlers, channel, handler);
      }),
      removeListener: vi.fn((channel: string, handler: LocalHandler) => {
        removeHandler(ipcHandlers, channel, handler);
      }),
      handle: vi.fn(),
      removeHandler: vi.fn(),
      emitTo: (channel: string, event: unknown, ...args: unknown[]) => {
        for (const handler of ipcHandlers.get(channel) ?? []) handler(event, ...args);
      },
    },
    globalShortcut: {
      register: vi.fn(() => true),
      unregister: vi.fn(),
    },
    desktopCapturer: {
      getSources: vi.fn(async () => []),
    },
    systemPreferences: {
      getMediaAccessStatus: vi.fn((): string => "granted"),
    },
    nativeImage: {},
    overlayWindows,
    createOverlayWindow: vi.fn(() => makeWindow()),
    createResumeWindow: vi.fn(() => makeWindow()),
    applyInteractive: vi.fn(),
    reset: () => {
      ipcHandlers.clear();
      displayHandlers.clear();
      overlayWindows.length = 0;
      nextWebContentsId = 100;
      displays = [display];
    },
  };
});

vi.mock("electron", () => ({
  app: mocks.app,
  screen: mocks.screen,
  ipcMain: mocks.ipcMain,
  globalShortcut: mocks.globalShortcut,
  desktopCapturer: mocks.desktopCapturer,
  systemPreferences: mocks.systemPreferences,
  nativeImage: mocks.nativeImage,
  BrowserWindow: class BrowserWindow {},
}));

vi.mock("./overlay-window.ts", () => ({
  createOverlayWindow: mocks.createOverlayWindow,
  createResumeWindow: mocks.createResumeWindow,
  applyInteractive: mocks.applyInteractive,
}));

function rectangle(id: string, x = 20, displayId = 1): Annotation {
  return {
    id,
    kind: "rectangle",
    displayId,
    createdAt: 10,
    style: { color: "#ff3b30", strokeWidth: 4 },
    rect: { x, y: 20, width: 80, height: 60 },
  };
}

function voicePin(id: string, x = 120, displayId = 1): Annotation {
  return {
    id,
    kind: "voicePin",
    displayId,
    createdAt: 20,
    style: { color: "#0a84ff", strokeWidth: 4 },
    position: { x, y: 90 },
    voiceNote: {
      audioBase64: "audio",
      mimeType: "audio/webm",
      durationMs: 1200,
      transcript: `voice for ${id}`,
    },
  };
}

function readyEvent(win: FakeWindow): { sender: FakeWebContents } {
  return { sender: win.webContents };
}

async function showReady(controller: ReturnType<typeof createOverlay>): Promise<FakeWindow> {
  const show = controller.show({ sessionId: "session-1" });
  await Promise.resolve();
  await Promise.resolve();
  const win = mocks.overlayWindows.at(-1) as FakeWindow;
  mocks.ipcMain.emitTo(CH.ready, readyEvent(win));
  await show;
  return win;
}

function frameState(win: FakeWindow): FrameStateMessage {
  const call = vi
    .mocked(win.webContents.send)
    .mock.calls.filter(([channel]) => channel === CH.frameState)
    .at(-1);
  expect(call).toBeDefined();
  return call![1] as FrameStateMessage;
}

function lastHydrate(win: FakeWindow): HydrateMessage {
  const call = vi
    .mocked(win.webContents.send)
    .mock.calls.filter(([channel]) => channel === CH.hydrate)
    .at(-1);
  expect(call).toBeDefined();
  return call![1] as HydrateMessage;
}

function sync(win: FakeWindow, frameId: string, annotations: Annotation[]): void {
  mocks.ipcMain.emitTo(CH.sync, readyEvent(win), { frameId, annotations });
}

function notices(win: FakeWindow): Array<{ text: string; kind: string; timeoutMs?: number }> {
  return vi
    .mocked(win.webContents.send)
    .mock.calls.filter(([channel]) => channel === CH.notice)
    .map(([, msg]) => msg as { text: string; kind: string; timeoutMs?: number });
}

async function frameAction(
  win: FakeWindow,
  action: "add" | "previous" | "next" | "delete" | "move-previous" | "move-next",
): Promise<void> {
  mocks.ipcMain.emitTo(CH.frameAction, readyEvent(win), { action });
  await vi.advanceTimersByTimeAsync(1000);
  await Promise.resolve();
}

function captureHook(): ReturnType<typeof vi.fn> {
  let captureIndex = 0;
  return vi.fn(async (displays: readonly DisplayInfo[]) => {
    captureIndex += 1;
    return displays.map((display) => ({
      displayId: display.id,
      pngBase64: `capture-${captureIndex}-display-${display.id}`,
      width: Math.round(display.bounds.width * display.scaleFactor),
      height: Math.round(display.bounds.height * display.scaleFactor),
    }));
  });
}

describe("OverlayController renderer readiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("destroys an overlay window instead of showing a click trap when load fails before ready", async () => {
    const controller = createOverlay({
      hooks: { onSubmitReview: vi.fn() },
      toggleShortcut: false,
    });

    const show = controller.show({ sessionId: "session-1" });
    await Promise.resolve();
    await Promise.resolve();
    const win = mocks.overlayWindows[0] as FakeWindow;
    win.emitWebContents("did-fail-load", -105, "ERR_FAILED", "file:///renderer.html", true);

    await expect(show).rejects.toThrow("Overlay renderer failed to load");
    expect(win.show).not.toHaveBeenCalled();
    expect(win.destroy).toHaveBeenCalled();
  });

  it("reports renderer failures and disables interactivity when a visible overlay fails", async () => {
    const onError = vi.fn();
    const controller = createOverlay({
      hooks: { onSubmitReview: vi.fn(), onError },
      toggleShortcut: false,
    });

    const show = controller.show({ sessionId: "session-1" });
    await Promise.resolve();
    await Promise.resolve();
    const win = mocks.overlayWindows[0] as FakeWindow;
    mocks.ipcMain.emitTo(CH.ready, { sender: win.webContents });
    await show;

    expect(win.show).toHaveBeenCalled();
    expect(mocks.applyInteractive).toHaveBeenCalledWith(win, true);

    win.emitWebContents("render-process-gone", { reason: "crashed", exitCode: 1 });

    expect(mocks.applyInteractive).toHaveBeenCalledWith(win, false);
    expect(win.destroy).toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Overlay renderer process exited"),
      }),
    );
  });

  it("captures, navigates, rejects stale sync, and submits an ordered two-frame review", async () => {
    vi.useFakeTimers();
    const captureScreenshot = captureHook();
    const onSubmitReview = vi.fn();
    const controller = createOverlay({
      hooks: { onSubmitReview, captureScreenshot },
      toggleShortcut: false,
      screenshotDelayMs: 0,
      includeComposite: true,
    });
    const win = await showReady(controller);

    const frame1 = frameState(win).frameId;
    sync(win, frame1, [rectangle("frame-1-rect")]);
    sync(win, "stale-frame", [rectangle("stale-rect", 300)]);
    await frameAction(win, "add");

    const frame2 = frameState(win);
    expect(frame2).toMatchObject({ index: 1, count: 2, annotationCount: 0 });
    sync(win, frame2.frameId, [voicePin("frame-2-voice")]);

    await frameAction(win, "previous");
    expect(lastHydrate(win).annotations.map((a) => a.id)).toEqual(["frame-1-rect"]);
    sync(win, frame2.frameId, [rectangle("wrong-frame", 400)]);

    await frameAction(win, "next");
    expect(lastHydrate(win).annotations.map((a) => a.id)).toEqual(["frame-2-voice"]);

    const submit = controller.submit({ sessionId: "session-1", isNew: false });
    await vi.advanceTimersByTimeAsync(1000);
    const payload = (await submit) as ReviewPayload;

    expect(onSubmitReview).toHaveBeenCalledWith(payload);
    expect(payload.frames).toHaveLength(2);
    expect(payload.frames.map((frame) => frame.annotations.map((a) => a.id))).toEqual([
      ["frame-1-rect"],
      ["frame-2-voice"],
    ]);
    expect(payload.annotations.map((a) => a.id)).not.toContain("stale-rect");
    expect(payload.annotations.map((a) => a.id)).not.toContain("wrong-frame");
    expect(payload.frames.every((frame) => frame.screenshots.length > 0)).toBe(true);
    expect(payload.frames.every((frame) => frame.screenshots[0]?.compositePngBase64)).toBe(true);
    expect(payload.markdown).toContain("## Frame 1");
    expect(payload.markdown).toContain("## Frame 2");
  });

  it("deletes additional frames and clears the only remaining frame without reaching zero frames", async () => {
    vi.useFakeTimers();
    const controller = createOverlay({
      hooks: { onSubmitReview: vi.fn(), captureScreenshot: captureHook() },
      toggleShortcut: false,
      screenshotDelayMs: 0,
      includeComposite: false,
    });
    const win = await showReady(controller);

    const frame1 = frameState(win).frameId;
    sync(win, frame1, [rectangle("frame-1-rect")]);
    await frameAction(win, "add");
    const frame2 = frameState(win).frameId;
    sync(win, frame2, [rectangle("frame-2-rect", 200)]);

    await frameAction(win, "delete");
    expect(frameState(win)).toMatchObject({ index: 0, count: 1 });
    expect(lastHydrate(win).annotations.map((a) => a.id)).toEqual(["frame-1-rect"]);

    await frameAction(win, "delete");
    expect(frameState(win)).toMatchObject({ index: 0, count: 1, annotationCount: 0 });
    expect(lastHydrate(win).annotations).toEqual([]);
  });

  it("reorders frames without mixing frame-specific annotations", async () => {
    vi.useFakeTimers();
    const controller = createOverlay({
      hooks: { onSubmitReview: vi.fn(), captureScreenshot: captureHook() },
      toggleShortcut: false,
      screenshotDelayMs: 0,
      includeComposite: true,
    });
    const win = await showReady(controller);

    const frame1 = frameState(win).frameId;
    sync(win, frame1, [rectangle("frame-1-rect")]);
    await frameAction(win, "add");
    const frame2 = frameState(win).frameId;
    sync(win, frame2, [voicePin("frame-2-voice")]);

    await frameAction(win, "move-previous");
    expect(frameState(win)).toMatchObject({ index: 0, count: 2 });
    expect(lastHydrate(win).annotations.map((a) => a.id)).toEqual(["frame-2-voice"]);

    const submit = controller.submit({ sessionId: "session-1", isNew: false });
    await vi.advanceTimersByTimeAsync(1000);
    const payload = (await submit) as ReviewPayload;

    expect(payload.frames.map((frame) => frame.annotations.map((a) => a.id))).toEqual([
      ["frame-2-voice"],
      ["frame-1-rect"],
    ]);
    expect(payload.frames.every((frame) => frame.screenshots.length > 0)).toBe(true);
  });

  it("re-buckets every stored frame when the display topology changes", async () => {
    vi.useFakeTimers();
    const onSubmitReview = vi.fn();
    const controller = createOverlay({
      hooks: { onSubmitReview, captureScreenshot: captureHook() },
      toggleShortcut: false,
      screenshotDelayMs: 0,
      includeComposite: false,
    });
    const win = await showReady(controller);

    sync(win, frameState(win).frameId, [rectangle("frame-1-rect")]);
    await frameAction(win, "add");
    sync(win, frameState(win).frameId, [voicePin("frame-2-voice")]);
    controller.hide();

    mocks.screen.setDisplays([
      {
        id: 2,
        bounds: { x: 0, y: 0, width: 1024, height: 768 },
        workArea: { x: 0, y: 0, width: 1024, height: 728 },
        scaleFactor: 1,
        rotation: 0,
        internal: true,
        label: "Replacement display",
      },
    ]);
    mocks.screen.emitDisplayChange();
    const nextShow = controller.show({ sessionId: "session-1" });
    await Promise.resolve();
    await Promise.resolve();
    const nextWin = mocks.overlayWindows.at(-1) as FakeWindow;
    mocks.ipcMain.emitTo(CH.ready, readyEvent(nextWin));
    await nextShow;

    const submit = controller.submit({ sessionId: "session-1", isNew: false });
    await vi.advanceTimersByTimeAsync(1000);
    const payload = (await submit) as ReviewPayload;

    expect(payload.frames).toHaveLength(2);
    expect(payload.frames.flatMap((frame) => frame.annotations.map((a) => a.displayId))).toEqual([
      2, 2,
    ]);
    expect(payload.frames.every((frame) => frame.displays.map((d) => d.id).includes(2))).toBe(true);
    expect(payload.frames[0]?.screenshots).toEqual([]);
    expect(payload.frames[1]?.screenshots[0]?.displayId).toBe(2);
  });

  it("still adds the frame and clears busy when capture never resolves", async () => {
    vi.useFakeTimers();
    mocks.systemPreferences.getMediaAccessStatus.mockReturnValue("denied");
    const captureScreenshot = vi.fn(() => new Promise<never>(() => {}));
    const onError = vi.fn();
    const controller = createOverlay({
      hooks: { onSubmitReview: vi.fn(), captureScreenshot, onError },
      toggleShortcut: false,
      screenshotDelayMs: 0,
    });
    const win = await showReady(controller);
    sync(win, frameState(win).frameId, [rectangle("r1")]);

    mocks.ipcMain.emitTo(CH.frameAction, readyEvent(win), { action: "add" });
    // Past the capture timeout (12s) plus the internal capture delays.
    await vi.advanceTimersByTimeAsync(40_000);

    const state = frameState(win);
    expect(state.busy).toBe(false);
    expect(state.count).toBe(2);
    expect(state.index).toBe(1);

    const text = notices(win).at(-1)!.text;
    expect(text).toContain("timed out");
    expect(text).toContain("Screen & System Audio Recording");
    expect(notices(win).at(-1)!.kind).toBe("error");
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("timed out") }),
    );
    mocks.systemPreferences.getMediaAccessStatus.mockReturnValue("granted");
  });

  it("does not latch submitting when capture never resolves, and still delivers the review", async () => {
    vi.useFakeTimers();
    const captureScreenshot = vi.fn(() => new Promise<never>(() => {}));
    const onSubmitReview = vi.fn();
    const controller = createOverlay({
      hooks: { onSubmitReview, captureScreenshot },
      toggleShortcut: false,
      screenshotDelayMs: 0,
    });
    const win = await showReady(controller);
    sync(win, frameState(win).frameId, [rectangle("r1")]);

    const submit = controller.submit({ sessionId: "session-1", isNew: false });
    await vi.advanceTimersByTimeAsync(40_000);
    const payload = (await submit) as ReviewPayload;

    // The marks still reach the agent; only the screenshot is missing.
    expect(onSubmitReview).toHaveBeenCalledTimes(1);
    expect(payload.frames).toHaveLength(1);
    expect(payload.frames[0]?.annotations).toHaveLength(1);
    expect(frameState(win).busy).toBe(false);

    // A second submit must be accepted (proves #submitting was released).
    sync(win, frameState(win).frameId, [rectangle("r2")]);
    const again = controller.submit({ sessionId: "session-1", isNew: false });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(await again).not.toBeNull();
    expect(onSubmitReview).toHaveBeenCalledTimes(2);
  });

  it("ignores display changes while a frame action is in flight", async () => {
    vi.useFakeTimers();
    const captureScreenshot = captureHook();
    const controller = createOverlay({
      hooks: { onSubmitReview: vi.fn(), captureScreenshot },
      toggleShortcut: false,
      screenshotDelayMs: 0,
    });
    const win = await showReady(controller);
    sync(win, frameState(win).frameId, [rectangle("r1")]);

    const windowsBefore = mocks.overlayWindows.length;
    mocks.ipcMain.emitTo(CH.frameAction, readyEvent(win), { action: "add" });
    // Fire a metrics change mid-capture: it must not tear down the windows.
    mocks.screen.emitDisplayChange();
    expect(mocks.overlayWindows.length).toBe(windowsBefore);
    expect(win.destroy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);
    expect(frameState(win).busy).toBe(false);
    expect(frameState(win).count).toBe(2);
  });
});
