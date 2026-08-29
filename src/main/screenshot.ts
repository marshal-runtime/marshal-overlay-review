import { desktopCapturer, nativeImage } from 'electron';
import type { Display } from 'electron';
import type { DisplayInfo, ScreenshotData } from '../shared/types.ts';

/** Map an Electron display to the framework-free {@link DisplayInfo}. */
export function toDisplayInfo(d: Display): DisplayInfo {
  return {
    id: d.id,
    bounds: { ...d.bounds },
    workArea: { ...d.workArea },
    scaleFactor: d.scaleFactor,
    rotation: d.rotation,
    internal: d.internal,
    label: d.label || `Display ${d.id}`,
  };
}

function physicalSize(d: DisplayInfo): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(d.bounds.width * d.scaleFactor)),
    height: Math.max(1, Math.round(d.bounds.height * d.scaleFactor)),
  };
}

/**
 * Capture a clean PNG of each display at its native physical resolution.
 *
 * The overlay windows MUST be hidden (or excluded) by the caller before this
 * runs so the overlay's own chrome/annotations are not baked into the image.
 * Each captured image is resized to the display's exact physical size so that
 * annotation coordinates expressed in physical pixels line up with the image.
 */
export async function captureDisplays(
  displays: readonly DisplayInfo[],
): Promise<ScreenshotData[]> {
  let maxW = 1;
  let maxH = 1;
  for (const d of displays) {
    const p = physicalSize(d);
    maxW = Math.max(maxW, p.width);
    maxH = Math.max(maxH, p.height);
  }

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: maxW, height: maxH },
  });

  const usedSourceIds = new Set<string>();

  return displays.map((d, i) => {
    const phys = physicalSize(d);
    // 1) Match by explicit display_id (most reliable).
    let source = sources.find(
      (s) => s.display_id && s.display_id === String(d.id) && !usedSourceIds.has(s.id),
    );
    // 2) Fallback: match an as-yet-unused source whose thumbnail aspect ratio
    //    matches this display's aspect ratio (handles mixed resolutions).
    if (!source) {
      const targetAspect = phys.width / phys.height;
      let best: (typeof sources)[number] | undefined;
      let bestErr = Number.POSITIVE_INFINITY;
      for (const s of sources) {
        if (usedSourceIds.has(s.id)) continue;
        const sz = s.thumbnail.getSize();
        if (sz.height === 0) continue;
        const err = Math.abs(sz.width / sz.height - targetAspect);
        if (err < bestErr) {
          bestErr = err;
          best = s;
        }
      }
      source = best;
      if (source && sources.length > 1) {
        console.warn(
          `[overlay-review] display ${d.id} matched by aspect ratio (no display_id); ` +
            `screenshot/display association may be approximate on this platform.`,
        );
      }
    }
    // 3) Last resort: positional.
    if (!source) source = sources[i];
    if (source) usedSourceIds.add(source.id);

    let pngBase64 = '';
    const thumb = source?.thumbnail;
    if (thumb && !thumb.isEmpty()) {
      const resized =
        thumb.getSize().width === phys.width && thumb.getSize().height === phys.height
          ? thumb
          : thumb.resize({ width: phys.width, height: phys.height, quality: 'best' });
      pngBase64 = resized.toPNG().toString('base64');
    }

    return {
      displayId: d.id,
      pngBase64,
      width: phys.width,
      height: phys.height,
    } satisfies ScreenshotData;
  });
}

/** True if at least one screenshot has image data. */
export function hasAnyImage(shots: readonly ScreenshotData[]): boolean {
  return shots.some((s) => s.pngBase64.length > 0);
}

/** Compose a single PNG data URL for previewing (used by demo/tools). */
export function toDataUrl(shot: ScreenshotData): string {
  return `data:image/png;base64,${shot.pngBase64}`;
}

export { nativeImage };
