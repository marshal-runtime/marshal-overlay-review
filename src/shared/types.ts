/**
 * Core data model for the review overlay. All geometry is expressed in
 * **global DIP coordinates** (device-independent pixels, with the multi-display
 * virtual origin) unless explicitly noted as physical pixels. Display
 * `scaleFactor` converts DIP -> physical screenshot pixels.
 *
 * This module is framework-free (no Electron, no DOM) so it can be unit tested
 * without a display.
 */

export type ToolKind =
  | 'select'
  | 'pen'
  | 'rectangle'
  | 'arrow'
  | 'text'
  | 'voicePin';

export const TOOL_KINDS: readonly ToolKind[] = [
  'select',
  'pen',
  'rectangle',
  'arrow',
  'text',
  'voicePin',
] as const;

export interface Point {
  /** Global DIP x. */
  x: number;
  /** Global DIP y. */
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayInfo {
  id: number;
  /** Display bounds in global DIP coordinates (origin may be negative). */
  bounds: Rect;
  /** Usable area excluding taskbars, in global DIP coordinates. */
  workArea?: Rect;
  /** DIP -> physical pixel multiplier (e.g. 1.0, 1.5, 2.0). */
  scaleFactor: number;
  /** Clockwise rotation in degrees (0/90/180/270). */
  rotation?: number;
  internal?: boolean;
  label?: string;
}

export interface VoiceClip {
  /** Base64-encoded audio payload (no data: URI prefix). */
  audioBase64: string;
  /** e.g. "audio/webm;codecs=opus". */
  mimeType: string;
  durationMs: number;
}

export interface VoiceNote extends VoiceClip {
  /** Transcript produced by the host-provided transcribe() hook. */
  transcript?: string;
  /** Populated if transcription failed; audio is still preserved. */
  transcriptError?: string;
}

export interface AnnotationStyle {
  /** CSS color string. */
  color: string;
  strokeWidth: number;
  fontSize?: number;
  /** 0..1 */
  opacity?: number;
}

export interface AnnotationBase {
  id: string;
  /** Display this annotation primarily belongs to. */
  displayId: number;
  /** Epoch ms when created. */
  createdAt: number;
  style: AnnotationStyle;
  /** Optional voice note attached to this annotation. */
  voiceNote?: VoiceNote;
}

export interface PenAnnotation extends AnnotationBase {
  kind: 'pen';
  /** Freehand stroke, global DIP coordinates. */
  points: Point[];
}

export interface RectAnnotation extends AnnotationBase {
  kind: 'rectangle';
  rect: Rect;
}

export interface ArrowAnnotation extends AnnotationBase {
  kind: 'arrow';
  from: Point;
  to: Point;
}

export interface TextAnnotation extends AnnotationBase {
  kind: 'text';
  text: string;
  /** Top-left anchor of the text box, global DIP. */
  position: Point;
}

export interface VoicePinAnnotation extends AnnotationBase {
  kind: 'voicePin';
  /** The point on screen this voice note refers to, global DIP. */
  position: Point;
  label?: string;
}

export type Annotation =
  | PenAnnotation
  | RectAnnotation
  | ArrowAnnotation
  | TextAnnotation
  | VoicePinAnnotation;

export type AnnotationKind = Annotation['kind'];

/** Clean screenshot of one display's underlying content (overlay excluded). */
export interface ScreenshotData {
  displayId: number;
  /** Base64-encoded PNG (no data: URI prefix). */
  pngBase64: string;
  /** Physical pixel dimensions of the captured image. */
  width: number;
  height: number;
  /**
   * Optional base64 PNG of the SAME display with the user's marks composited on
   * top (HUD chrome hidden) — a human-legible "here's what I drew" preview.
   */
  compositePngBase64?: string;
}

export interface HostMeta {
  appName?: string;
  appVersion?: string;
  /** Free-form context the host wants the agent to see. */
  context?: Record<string, unknown>;
}

/**
 * Where the review should be delivered. The overlay is routing-agnostic — it
 * only records the user's intent; the host decides what to do with it.
 */
export interface ReviewTarget {
  /** Existing session to route the review into. Undefined => a new session. */
  sessionId?: string;
  /** Human-readable label for that session (for display/logging). */
  sessionTitle?: string;
  /** True when the review should start a NEW session. */
  isNew: boolean;
}

/** Overlay interaction / input mode (drives click-through and capture). */
export type OverlayMode =
  | 'idle'
  | 'passthrough'
  | 'hudHover'
  | 'drawing'
  | 'textEditing'
  | 'voiceRecording'
  | 'submitting'
  | 'error';
