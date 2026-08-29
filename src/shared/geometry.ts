import type {
  Annotation,
  DisplayInfo,
  Point,
  Rect,
} from './types.ts';

/** Build a normalized rectangle from two arbitrary corner points. */
export function rectFromPoints(a: Point, b: Point): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

export function pointInRect(p: Point, r: Rect): boolean {
  return (
    p.x >= r.x &&
    p.x <= r.x + r.width &&
    p.y >= r.y &&
    p.y <= r.y + r.height
  );
}

/** Convert a global DIP point to display-local DIP coordinates. */
export function globalToDisplayLocal(p: Point, display: DisplayInfo): Point {
  return { x: p.x - display.bounds.x, y: p.y - display.bounds.y };
}

/** Convert a display-local DIP point back to global DIP coordinates. */
export function displayLocalToGlobal(p: Point, display: DisplayInfo): Point {
  return { x: p.x + display.bounds.x, y: p.y + display.bounds.y };
}

/** Normalize a global DIP point to 0..1 within the display's bounds. */
export function normalizePoint(p: Point, display: DisplayInfo): Point {
  const local = globalToDisplayLocal(p, display);
  const w = display.bounds.width || 1;
  const h = display.bounds.height || 1;
  return { x: clamp01(local.x / w), y: clamp01(local.y / h) };
}

/** Inverse of {@link normalizePoint}. */
export function denormalizePoint(n: Point, display: DisplayInfo): Point {
  return displayLocalToGlobal(
    { x: n.x * display.bounds.width, y: n.y * display.bounds.height },
    display,
  );
}

/**
 * Convert a display-local DIP point to physical pixel coordinates within that
 * display's screenshot. Rounds to the nearest pixel.
 */
export function dipToPhysical(localDip: Point, scaleFactor: number): Point {
  return {
    x: Math.round(localDip.x * scaleFactor),
    y: Math.round(localDip.y * scaleFactor),
  };
}

/** Find the display whose bounds contain the point; falls back to nearest. */
export function displayForPoint(
  p: Point,
  displays: readonly DisplayInfo[],
): DisplayInfo | undefined {
  if (displays.length === 0) return undefined;
  for (const d of displays) {
    if (pointInRect(p, d.bounds)) return d;
  }
  // Nearest by center distance.
  let best: DisplayInfo | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const d of displays) {
    const cx = d.bounds.x + d.bounds.width / 2;
    const cy = d.bounds.y + d.bounds.height / 2;
    const dist = (cx - p.x) ** 2 + (cy - p.y) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  return best;
}

/** Axis-aligned bounding box of any annotation, in global DIP coordinates. */
export function annotationBounds(a: Annotation): Rect {
  switch (a.kind) {
    case 'pen':
      return boundsOfPoints(a.points);
    case 'rectangle':
      return { ...a.rect };
    case 'arrow':
      return boundsOfPoints([a.from, a.to]);
    case 'text':
      return { x: a.position.x, y: a.position.y, width: 0, height: 0 };
    case 'voicePin':
      return { x: a.position.x, y: a.position.y, width: 0, height: 0 };
  }
}

/** Representative anchor point used for markers / "where on screen" hints. */
export function annotationAnchor(a: Annotation): Point {
  switch (a.kind) {
    case 'pen': {
      const b = boundsOfPoints(a.points);
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }
    case 'rectangle':
      return { x: a.rect.x + a.rect.width / 2, y: a.rect.y + a.rect.height / 2 };
    case 'arrow':
      return { ...a.to };
    case 'text':
      return { ...a.position };
    case 'voicePin':
      return { ...a.position };
  }
}

const ROWS = ['top', 'middle', 'bottom'] as const;
const COLS = ['left', 'center', 'right'] as const;

/**
 * Human-readable location of a point within a display, on a 3x3 grid, e.g.
 * "top-left", "middle-center". Helps an agent understand where a voice note
 * refers to.
 */
export function locationHint(p: Point, display: DisplayInfo): string {
  const n = normalizePoint(p, display);
  const col = COLS[Math.min(2, Math.floor(n.x * 3))] ?? 'center';
  const row = ROWS[Math.min(2, Math.floor(n.y * 3))] ?? 'middle';
  return `${row}-${col}`;
}

export function boundsOfPoints(points: readonly Point[]): Rect {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const pt of points) {
    if (pt.x < minX) minX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y > maxY) maxY = pt.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/** Return a copy of the annotation translated by (dx, dy) in global DIP. */
export function translateAnnotation(a: Annotation, dx: number, dy: number): Annotation {
  switch (a.kind) {
    case 'pen':
      return { ...a, points: a.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
    case 'rectangle':
      return { ...a, rect: { ...a.rect, x: a.rect.x + dx, y: a.rect.y + dy } };
    case 'arrow':
      return {
        ...a,
        from: { x: a.from.x + dx, y: a.from.y + dy },
        to: { x: a.to.x + dx, y: a.to.y + dy },
      };
    case 'text':
      return { ...a, position: { x: a.position.x + dx, y: a.position.y + dy } };
    case 'voicePin':
      return { ...a, position: { x: a.position.x + dx, y: a.position.y + dy } };
  }
}

/** Hit-test: does point p fall within `tolerance` DIP of the annotation? */
export function annotationHitTest(a: Annotation, p: Point, tolerance = 8): boolean {
  switch (a.kind) {
    case 'pen':
      return a.points.some((pt) => Math.hypot(pt.x - p.x, pt.y - p.y) <= tolerance) ||
        segmentsHit(a.points, p, tolerance);
    case 'rectangle': {
      const r = a.rect;
      const onX = p.x >= r.x - tolerance && p.x <= r.x + r.width + tolerance;
      const onY = p.y >= r.y - tolerance && p.y <= r.y + r.height + tolerance;
      const nearLeft = Math.abs(p.x - r.x) <= tolerance;
      const nearRight = Math.abs(p.x - (r.x + r.width)) <= tolerance;
      const nearTop = Math.abs(p.y - r.y) <= tolerance;
      const nearBottom = Math.abs(p.y - (r.y + r.height)) <= tolerance;
      return (onY && (nearLeft || nearRight)) || (onX && (nearTop || nearBottom));
    }
    case 'arrow':
      return pointToSegment(p, a.from, a.to) <= tolerance;
    case 'text':
      return Math.hypot(a.position.x - p.x, a.position.y - p.y) <= tolerance * 3;
    case 'voicePin':
      return Math.hypot(a.position.x - p.x, a.position.y - p.y) <= tolerance * 3;
  }
}

function segmentsHit(points: readonly Point[], p: Point, tol: number): boolean {
  for (let i = 1; i < points.length; i++) {
    if (pointToSegment(p, points[i - 1]!, points[i]!) <= tol) return true;
  }
  return false;
}

function pointToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export type HandleId = 'nw' | 'ne' | 'se' | 'sw' | 'start' | 'end';

export interface AnnotationHandle {
  id: HandleId;
  point: Point;
}

/** Resize handles for an annotation (rectangle corners / arrow endpoints). */
export function annotationHandles(a: Annotation): AnnotationHandle[] {
  if (a.kind === 'rectangle') {
    const { x, y, width, height } = a.rect;
    return [
      { id: 'nw', point: { x, y } },
      { id: 'ne', point: { x: x + width, y } },
      { id: 'se', point: { x: x + width, y: y + height } },
      { id: 'sw', point: { x, y: y + height } },
    ];
  }
  if (a.kind === 'arrow') {
    return [
      { id: 'start', point: { ...a.from } },
      { id: 'end', point: { ...a.to } },
    ];
  }
  return [];
}

/** Return a copy of the annotation with one handle moved by (dx, dy). */
export function resizeAnnotation(
  a: Annotation,
  handle: HandleId,
  dx: number,
  dy: number,
): Annotation {
  if (a.kind === 'rectangle') {
    let { x, y, width, height } = a.rect;
    let left = x;
    let top = y;
    let right = x + width;
    let bottom = y + height;
    if (handle === 'nw') {
      left += dx;
      top += dy;
    } else if (handle === 'ne') {
      right += dx;
      top += dy;
    } else if (handle === 'se') {
      right += dx;
      bottom += dy;
    } else if (handle === 'sw') {
      left += dx;
      bottom += dy;
    }
    x = Math.min(left, right);
    y = Math.min(top, bottom);
    width = Math.abs(right - left);
    height = Math.abs(bottom - top);
    return { ...a, rect: { x, y, width, height } };
  }
  if (a.kind === 'arrow') {
    if (handle === 'start') return { ...a, from: { x: a.from.x + dx, y: a.from.y + dy } };
    if (handle === 'end') return { ...a, to: { x: a.to.x + dx, y: a.to.y + dy } };
  }
  return a;
}
