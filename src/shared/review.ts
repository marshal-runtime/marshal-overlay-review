import {
  annotationAnchor,
  annotationBounds,
  dipToPhysical,
  displayForPoint,
  globalToDisplayLocal,
  locationHint,
  normalizePoint,
} from "./geometry.ts";
import type {
  Annotation,
  AnnotationKind,
  AnnotationStyle,
  DisplayInfo,
  HostMeta,
  Point,
  Rect,
  ReviewTarget,
  ScreenshotData,
} from "./types.ts";

export interface ReviewAnnotationGeometry {
  kind: AnnotationKind;
  /** Anchor point in global DIP coordinates. */
  anchorGlobalDip: Point;
  /** Anchor normalized 0..1 within its display. */
  anchorNormalized: Point;
  /** Anchor in physical pixels within the display's screenshot. */
  anchorScreenshotPx: Point;
  /** Bounding box in global DIP coordinates. */
  boundsGlobalDip: Rect;
  /** Bounding box in physical pixels within the display's screenshot. */
  boundsScreenshotPx: Rect;
  /** Raw geometry vertices in global DIP (for faithful re-rendering). */
  pointsGlobalDip: Point[];
}

export interface ReviewVoice {
  audioBase64: string;
  mimeType: string;
  durationMs: number;
  transcript?: string;
  transcriptError?: string;
}

export interface ReviewAnnotation {
  id: string;
  kind: AnnotationKind;
  displayId: number;
  frameId?: string;
  frameIndex?: number;
  createdAt: number;
  /** Typed text (text tool) or pin label, if any. */
  text?: string;
  voice?: ReviewVoice;
  geometry: ReviewAnnotationGeometry;
  /** e.g. "top-left of display 0 (Built-in)". */
  locationHint: string;
  style: AnnotationStyle;
}

export interface ReviewSummary {
  annotationCount: number;
  byKind: Record<string, number>;
  withVoice: number;
  withText: number;
  displays: number;
  frames: number;
}

export type { ReviewTarget } from "./types.ts";

export interface ReviewFrame {
  id: string;
  /** Zero-based frame index in the ordered review. */
  index: number;
  createdAt: number;
  displays: DisplayInfo[];
  screenshots: ScreenshotData[];
  annotations: ReviewAnnotation[];
  summary: ReviewSummary;
  /** Human/agent-readable digest for this frame only. */
  markdown: string;
}

export interface ReviewPayload {
  schemaVersion: 2;
  createdAt: number;
  host: HostMeta;
  /** Destination the user chose for this review. */
  target: ReviewTarget;
  /** Ordered static frames captured in this review. */
  frames: ReviewFrame[];
  /** Legacy aggregate view derived from `frames`. */
  displays: DisplayInfo[];
  /** Legacy aggregate view derived from `frames`. */
  screenshots: ScreenshotData[];
  /** Legacy aggregate view derived from `frames`. */
  annotations: ReviewAnnotation[];
  summary: ReviewSummary;
  /** Human/agent-readable digest of the review. */
  markdown: string;
}

/** True for a text annotation that was placed but never typed into. */
export function isEmptyTextAnnotation(a: Annotation): boolean {
  return a.kind === "text" && a.text.trim() === "";
}

/** Annotations worth submitting (drops empty text boxes). Order preserved. */
export function submittableAnnotations(annotations: readonly Annotation[]): Annotation[] {
  return annotations.filter((a) => !isEmptyTextAnnotation(a));
}

export interface AssembleReviewInput {
  annotations?: readonly Annotation[];
  displays?: readonly DisplayInfo[];
  screenshots?: readonly ScreenshotData[];
  frames?: readonly AssembleReviewFrameInput[];
  host?: HostMeta;
  /** Destination for the review; defaults to a new session. */
  target?: ReviewTarget;
  /** Injectable clock for deterministic tests. */
  now?: number;
}

export interface AssembleReviewFrameInput {
  id?: string;
  createdAt?: number;
  annotations: readonly Annotation[];
  displays: readonly DisplayInfo[];
  screenshots: readonly ScreenshotData[];
}

function rawPoints(a: Annotation): Point[] {
  switch (a.kind) {
    case "pen":
      return a.points.map((p) => ({ ...p }));
    case "rectangle":
      return [
        { x: a.rect.x, y: a.rect.y },
        { x: a.rect.x + a.rect.width, y: a.rect.y + a.rect.height },
      ];
    case "arrow":
      return [{ ...a.from }, { ...a.to }];
    case "text":
      return [{ ...a.position }];
    case "voicePin":
      return [{ ...a.position }];
  }
}

function annotationText(a: Annotation): string | undefined {
  if (a.kind === "text") return a.text;
  if (a.kind === "voicePin") return a.label;
  return undefined;
}

function rectDipToPhysical(rect: Rect, display: DisplayInfo): Rect {
  const local = globalToDisplayLocal({ x: rect.x, y: rect.y }, display);
  const tl = dipToPhysical(local, display.scaleFactor);
  return {
    x: tl.x,
    y: tl.y,
    width: Math.round(rect.width * display.scaleFactor),
    height: Math.round(rect.height * display.scaleFactor),
  };
}

function resolveDisplay(
  a: Annotation,
  anchor: Point,
  displays: readonly DisplayInfo[],
): DisplayInfo | undefined {
  return displays.find((d) => d.id === a.displayId) ?? displayForPoint(anchor, displays);
}

/**
 * Convert the raw annotation model + screenshots into the structured,
 * agent-facing {@link ReviewPayload}. Pure and deterministic given `now`.
 *
 * Screenshots are treated as the clean underlying content; annotation pixels
 * are NOT baked in — the agent receives structured coordinates (global DIP,
 * normalized, and physical screenshot px) so it can faithfully locate every
 * mark and overlay it itself if desired.
 */
export function assembleReviewPayload(input: AssembleReviewInput): ReviewPayload {
  const now = input.now ?? Date.now();
  const target: ReviewTarget = input.target ?? { isNew: true };
  const frameInputs =
    input.frames && input.frames.length > 0
      ? input.frames
      : [
          {
            annotations: input.annotations ?? [],
            displays: input.displays ?? [],
            screenshots: input.screenshots ?? [],
          },
        ];
  const frames = frameInputs.map((frame, i) => assembleFrame(frame, i, now));
  const displays = aggregateDisplays(frames);
  const screenshots = frames.flatMap((f) => f.screenshots.map((s) => ({ ...s })));
  const annotations = frames.flatMap((f) => f.annotations.map((a) => ({ ...a })));
  const summary = summarize(annotations, displays.length, frames.length);

  return {
    schemaVersion: 2,
    createdAt: now,
    host: input.host ?? {},
    target,
    frames,
    displays,
    screenshots,
    annotations,
    summary,
    markdown: renderMarkdown(frames, summary, target),
  };
}

function assembleFrame(input: AssembleReviewFrameInput, index: number, now: number): ReviewFrame {
  const frameId = input.id ?? `frame-${index + 1}`;
  const createdAt = input.createdAt ?? now;
  const displays = input.displays.map((d) => ({ ...d }));

  const annotations: ReviewAnnotation[] = input.annotations.map((a) => {
    const anchor = annotationAnchor(a);
    const bounds = annotationBounds(a);
    const display = resolveDisplay(a, anchor, displays);

    let anchorNormalized: Point = { x: 0, y: 0 };
    let anchorScreenshotPx: Point = { x: 0, y: 0 };
    let boundsScreenshotPx: Rect = { x: 0, y: 0, width: 0, height: 0 };
    let hint = "unknown-location";

    if (display) {
      anchorNormalized = normalizePoint(anchor, display);
      anchorScreenshotPx = dipToPhysical(
        globalToDisplayLocal(anchor, display),
        display.scaleFactor,
      );
      boundsScreenshotPx = rectDipToPhysical(bounds, display);
      hint = `${locationHint(anchor, display)} of display ${display.id}${
        display.label ? ` (${display.label})` : ""
      }`;
    }

    const review: ReviewAnnotation = {
      id: a.id,
      kind: a.kind,
      displayId: display?.id ?? a.displayId,
      frameId,
      frameIndex: index,
      createdAt: a.createdAt,
      geometry: {
        kind: a.kind,
        anchorGlobalDip: anchor,
        anchorNormalized,
        anchorScreenshotPx,
        boundsGlobalDip: bounds,
        boundsScreenshotPx,
        pointsGlobalDip: rawPoints(a),
      },
      locationHint: hint,
      style: a.style,
    };

    const text = annotationText(a);
    if (text !== undefined && text !== "") review.text = text;

    if (a.voiceNote) {
      review.voice = {
        audioBase64: a.voiceNote.audioBase64,
        mimeType: a.voiceNote.mimeType,
        durationMs: a.voiceNote.durationMs,
        transcript: a.voiceNote.transcript,
        transcriptError: a.voiceNote.transcriptError,
      };
    }

    return review;
  });

  return {
    id: frameId,
    index,
    createdAt,
    displays,
    screenshots: input.screenshots.map((s) => ({ ...s })),
    annotations,
    summary: summarize(annotations, displays.length, 1),
    markdown: renderFrameMarkdown(index, annotations, displays.length),
  };
}

function aggregateDisplays(frames: readonly ReviewFrame[]): DisplayInfo[] {
  const byId = new Map<number, DisplayInfo>();
  for (const frame of frames) {
    for (const display of frame.displays) {
      if (!byId.has(display.id)) byId.set(display.id, { ...display });
    }
  }
  return [...byId.values()];
}

function summarize(
  annotations: readonly ReviewAnnotation[],
  displayCount: number,
  frameCount: number,
): ReviewSummary {
  const byKind: Record<string, number> = {};
  let withVoice = 0;
  let withText = 0;
  for (const a of annotations) {
    byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
    if (a.voice) withVoice += 1;
    if (a.text) withText += 1;
  }
  return {
    annotationCount: annotations.length,
    byKind,
    withVoice,
    withText,
    displays: displayCount,
    frames: frameCount,
  };
}

function renderMarkdown(
  frames: readonly ReviewFrame[],
  summary: ReviewSummary,
  target: ReviewTarget,
): string {
  const lines: string[] = [];
  lines.push(`# Screen review`);
  lines.push("");
  const dest = target.isNew
    ? "a new session"
    : target.sessionTitle
      ? `session "${target.sessionTitle}"`
      : target.sessionId
        ? `session ${target.sessionId}`
        : "a new session";
  lines.push(`_Destination: ${dest}._`);
  lines.push("");
  lines.push(
    `**${summary.annotationCount}** annotation(s) across **${summary.frames}** frame(s) and ` +
      `**${summary.displays}** display(s) — ${summary.withVoice} with voice, ` +
      `${summary.withText} with text.`,
  );
  lines.push("");

  if (frames.length === 0 || summary.annotationCount === 0) {
    lines.push("_No annotations._");
    return lines.join("\n");
  }

  if (frames.length === 1) {
    appendAnnotationList(lines, frames[0]!.annotations, 2);
    return lines.join("\n").trimEnd();
  }

  frames.forEach((frame) => {
    lines.push(`## Frame ${frame.index + 1}`);
    lines.push(
      `**${frame.summary.annotationCount}** annotation(s) across **${frame.summary.displays}** display(s).`,
    );
    lines.push("");
    if (frame.annotations.length === 0) {
      lines.push("_No annotations._");
      lines.push("");
      return;
    }
    appendAnnotationList(lines, frame.annotations, 3);
  });

  return lines.join("\n").trimEnd();
}

function renderFrameMarkdown(
  frameIndex: number,
  annotations: readonly ReviewAnnotation[],
  displayCount: number,
): string {
  const lines: string[] = [];
  lines.push(`# Frame ${frameIndex + 1}`);
  lines.push("");
  lines.push(`**${annotations.length}** annotation(s) across **${displayCount}** display(s).`);
  lines.push("");
  if (annotations.length === 0) {
    lines.push("_No annotations._");
    return lines.join("\n");
  }
  appendAnnotationList(lines, annotations, 2);
  return lines.join("\n").trimEnd();
}

function appendAnnotationList(
  lines: string[],
  annotations: readonly ReviewAnnotation[],
  headingLevel: 2 | 3,
): void {
  const heading = "#".repeat(headingLevel);
  annotations.forEach((a, i) => {
    lines.push(`${heading} ${i + 1}. ${kindLabel(a.kind)} — ${a.locationHint}`);
    const px = a.geometry.anchorScreenshotPx;
    lines.push(`- Anchor (screenshot px): ${px.x}, ${px.y}`);
    if (a.text) lines.push(`- Text: ${a.text}`);
    if (a.voice) {
      if (a.voice.transcript) {
        lines.push(`- Voice (${msToSec(a.voice.durationMs)}s): "${a.voice.transcript}"`);
      } else if (a.voice.transcriptError) {
        lines.push(
          `- Voice (${msToSec(a.voice.durationMs)}s): [transcription failed: ${a.voice.transcriptError}]`,
        );
      } else {
        lines.push(`- Voice (${msToSec(a.voice.durationMs)}s): [audio attached, no transcript]`);
      }
    }
    lines.push("");
  });
}

const KIND_LABELS: Record<AnnotationKind, string> = {
  pen: "Drawing",
  rectangle: "Rectangle",
  arrow: "Arrow",
  text: "Text note",
  voicePin: "Voice pin",
};

function kindLabel(kind: AnnotationKind): string {
  return KIND_LABELS[kind] ?? kind;
}

function msToSec(ms: number): string {
  return (ms / 1000).toFixed(1);
}
