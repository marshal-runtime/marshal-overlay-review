import { BrowserWindow } from 'electron';
import type { DisplayInfo } from '../shared/types.ts';

export interface OverlayWindowPaths {
  rendererHtml: string;
  preload: string;
}

/**
 * Create a transparent, frameless, always-on-top overlay window that exactly
 * covers one display. It starts hidden and click-through; the controller shows
 * it and the renderer drives interactivity via the `capture` IPC message.
 */
export function createOverlayWindow(
  display: DisplayInfo,
  paths: OverlayWindowPaths,
): BrowserWindow {
  const { bounds } = display;
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    // Focusable so the text tool and microphone capture can work when active.
    focusable: true,
    // Allow the window to span exactly the (possibly scaled) display.
    enableLargerThanScreen: true,
    // Keep the overlay out of screenshots taken by *other* tools where the OS
    // supports it; we still hide it for our own capture.
    webPreferences: {
      preload: paths.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Default: pass every mouse event through to the app underneath.
  win.setIgnoreMouseEvents(true, { forward: true });
  // Avoid the window appearing in alt-tab / mission control.
  win.setMenuBarVisibility(false);

  void win.loadFile(paths.rendererHtml);
  return win;
}

/** Re-assert always-on-top + click-through after visibility changes. */
export function reassertOverlayState(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
}

export interface ResumeWindowPaths {
  resumeHtml: string;
  preload: string;
}

/**
 * Small always-interactive "Resume drawing" pill shown during pass-through so
 * the user has a mouse-first way back (in addition to Esc / the shortcut). It
 * is a separate window because the main overlay is click-through in pass-through.
 */
export function createResumeWindow(
  display: DisplayInfo,
  paths: ResumeWindowPaths,
): BrowserWindow {
  const { bounds } = display;
  const width = 420;
  const height = 44;
  const win = new BrowserWindow({
    x: Math.round(bounds.x + (bounds.width - width) / 2),
    y: Math.round(bounds.y + 70),
    width,
    height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    webPreferences: {
      preload: paths.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  void win.loadFile(paths.resumeHtml);
  return win;
}

/**
 * Toggle whether the overlay captures the mouse.
 * - interactive=true  → window receives all clicks (drawing / toolbar).
 * - interactive=false → clicks pass through to the app underneath, but the
 *   window still receives forwarded mousemove (so the renderer can show hints).
 */
export function applyInteractive(win: BrowserWindow, interactive: boolean): void {
  if (win.isDestroyed()) return;
  win.setIgnoreMouseEvents(!interactive, { forward: true });
}
