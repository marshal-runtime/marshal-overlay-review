import type { ReviewPayload } from "./review.ts";

/** A composer-ready attachment derived from a review. */
export interface ReviewAttachment {
  /** Suggested file name. */
  name: string;
  /** MIME type, e.g. "image/png" or "audio/webm". */
  mimeType: string;
  /** `data:` URL with the base64 payload inlined. */
  dataUrl: string;
  /** What this attachment represents. */
  kind: "screenshot" | "composite" | "audio";
  /** Owning display (images) or annotation id (audio). */
  ref?: string | number;
}

export interface ReviewAttachmentBundle {
  /** Files to attach to the composer (screenshots, composites, voice memos). */
  attachments: ReviewAttachment[];
  /** A ready-to-insert markdown summary (annotations + transcripts + location). */
  summaryMarkdown: string;
}

function fileSafe(s: string): string {
  return s.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "review";
}

function extFor(mimeType: string): string {
  const m = mimeType.toLowerCase();
  if (m.includes("webm")) return "webm";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("mp4") || m.includes("m4a")) return "m4a";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("wav")) return "wav";
  if (m.includes("png")) return "png";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  return "bin";
}

/**
 * Convert a {@link ReviewPayload} into composer-ready attachments plus a
 * markdown summary. Host-agnostic and pure (no DOM / Electron), so a host like
 * Microsoft Scout can map the result onto its own attachment model and unit
 * test the mapping.
 *
 * Includes: clean screenshot(s), the composite "marks baked in" preview when
 * present, and every voice memo as an audio attachment. Empty screenshots are
 * skipped.
 */
export function reviewToAttachments(
  payload: ReviewPayload,
  options: { includeComposite?: boolean; includeCleanScreenshot?: boolean } = {},
): ReviewAttachmentBundle {
  const includeComposite = options.includeComposite ?? true;
  const includeClean = options.includeCleanScreenshot ?? true;
  const attachments: ReviewAttachment[] = [];
  const frames =
    payload.frames && payload.frames.length > 0
      ? payload.frames
      : [
          {
            id: "frame-1",
            index: 0,
            screenshots: payload.screenshots,
            annotations: payload.annotations,
          },
        ];

  for (const frame of frames) {
    const frameLabel = `frame-${frame.index + 1}`;
    const frameRef = fileSafe(frame.id);
    for (const shot of frame.screenshots) {
      if (includeClean && shot.pngBase64) {
        attachments.push({
          name: `review-${frameLabel}-display-${shot.displayId}.png`,
          mimeType: "image/png",
          dataUrl: `data:image/png;base64,${shot.pngBase64}`,
          kind: "screenshot",
          ref: `${frameRef}:display-${shot.displayId}`,
        });
      }
      if (includeComposite && shot.compositePngBase64) {
        attachments.push({
          name: `review-${frameLabel}-display-${shot.displayId}-marked.png`,
          mimeType: "image/png",
          dataUrl: `data:image/png;base64,${shot.compositePngBase64}`,
          kind: "composite",
          ref: `${frameRef}:display-${shot.displayId}`,
        });
      }
    }

    let voiceIndex = 0;
    for (const a of frame.annotations) {
      if (!a.voice) continue;
      voiceIndex += 1;
      const ext = extFor(a.voice.mimeType);
      attachments.push({
        name: `review-${frameLabel}-voice-note-${voiceIndex}-${fileSafe(a.id)}.${ext}`,
        mimeType: a.voice.mimeType,
        dataUrl: `data:${a.voice.mimeType};base64,${a.voice.audioBase64}`,
        kind: "audio",
        ref: `${frameRef}:annotation-${fileSafe(a.id)}`,
      });
    }
  }

  return { attachments, summaryMarkdown: payload.markdown };
}
