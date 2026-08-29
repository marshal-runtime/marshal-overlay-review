import { describe, expect, it } from "vitest";

import { reviewToAttachments } from "./attachments.ts";
import { assembleReviewPayload } from "./review.ts";
import type { Annotation, DisplayInfo } from "./types.ts";

const display: DisplayInfo = {
  id: 1,
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  scaleFactor: 2,
  label: "Built-in",
};

function rectangle(id: string, x: number): Annotation {
  return {
    id,
    kind: "rectangle",
    displayId: 1,
    createdAt: 10,
    style: { color: "#ff3b30", strokeWidth: 4 },
    rect: { x, y: 20, width: 100, height: 80 },
  };
}

describe("multi-frame review payloads", () => {
  it("assembles ordered frames while keeping aggregate legacy fields derived", () => {
    const payload = assembleReviewPayload({
      now: 1234,
      target: { sessionId: "session-1", sessionTitle: "Design review", isNew: false },
      frames: [
        {
          id: "intro",
          createdAt: 100,
          displays: [display],
          screenshots: [
            {
              displayId: 1,
              width: 1600,
              height: 1200,
              pngBase64: "clean-1",
              compositePngBase64: "marked-1",
            },
          ],
          annotations: [
            rectangle("rect-1", 10),
            {
              id: "pin-1",
              kind: "voicePin",
              displayId: 1,
              createdAt: 12,
              style: { color: "#ff3b30", strokeWidth: 4 },
              position: { x: 40, y: 60 },
              voiceNote: {
                audioBase64: "audio-1",
                mimeType: "audio/webm",
                durationMs: 1200,
                transcript: "This area changed between frames.",
              },
            },
          ],
        },
        {
          id: "details",
          createdAt: 200,
          displays: [display],
          screenshots: [
            {
              displayId: 1,
              width: 1600,
              height: 1200,
              pngBase64: "clean-2",
              compositePngBase64: "marked-2",
            },
          ],
          annotations: [
            {
              id: "note-1",
              kind: "text",
              displayId: 1,
              createdAt: 20,
              style: { color: "#0a84ff", strokeWidth: 4, fontSize: 18 },
              text: "Move this callout before launch.",
              position: { x: 120, y: 140 },
            },
          ],
        },
      ],
    });

    expect(payload.schemaVersion).toBe(2);
    expect(payload.frames).toHaveLength(2);
    expect(payload.summary).toMatchObject({
      annotationCount: 3,
      frames: 2,
      displays: 1,
      withVoice: 1,
      withText: 1,
    });
    expect(payload.annotations.map((a) => [a.id, a.frameId, a.frameIndex])).toEqual([
      ["rect-1", "intro", 0],
      ["pin-1", "intro", 0],
      ["note-1", "details", 1],
    ]);
    expect(payload.screenshots.map((s) => s.pngBase64)).toEqual(["clean-1", "clean-2"]);
    expect(payload.markdown).toContain("## Frame 1");
    expect(payload.markdown).toContain("## Frame 2");
    expect(payload.markdown).toContain("Move this callout before launch.");
  });

  it("creates frame-aware screenshot, composite, and audio attachment names", () => {
    const payload = assembleReviewPayload({
      now: 1234,
      frames: [
        {
          id: "frame-one",
          createdAt: 100,
          displays: [display],
          screenshots: [
            {
              displayId: 1,
              width: 1600,
              height: 1200,
              pngBase64: "clean-1",
              compositePngBase64: "marked-1",
            },
          ],
          annotations: [
            {
              id: "pin/1",
              kind: "voicePin",
              displayId: 1,
              createdAt: 10,
              style: { color: "#ff3b30", strokeWidth: 4 },
              position: { x: 40, y: 60 },
              voiceNote: {
                audioBase64: "audio-1",
                mimeType: "audio/webm",
                durationMs: 1200,
                transcript: "This area changed between frames.",
              },
            },
          ],
        },
        {
          id: "frame-two",
          createdAt: 200,
          displays: [display],
          screenshots: [
            {
              displayId: 1,
              width: 1600,
              height: 1200,
              pngBase64: "clean-2",
              compositePngBase64: "marked-2",
            },
          ],
          annotations: [rectangle("rect-2", 200)],
        },
      ],
    });

    expect(reviewToAttachments(payload).attachments.map((a) => a.name)).toEqual([
      "review-frame-1-display-1.png",
      "review-frame-1-display-1-marked.png",
      "review-frame-1-voice-note-1-pin-1.webm",
      "review-frame-2-display-1.png",
      "review-frame-2-display-1-marked.png",
    ]);
  });

  it("wraps legacy single-frame input in one frame and preserves top-level fields", () => {
    const payload = assembleReviewPayload({
      now: 1234,
      displays: [display],
      screenshots: [{ displayId: 1, width: 1600, height: 1200, pngBase64: "legacy-clean" }],
      annotations: [rectangle("legacy-rect", 10)],
    });

    expect(payload.frames).toHaveLength(1);
    expect(payload.frames[0]?.screenshots[0]?.pngBase64).toBe("legacy-clean");
    expect(payload.screenshots[0]?.pngBase64).toBe("legacy-clean");
    expect(payload.annotations.map((a) => a.id)).toEqual(["legacy-rect"]);
    expect(payload.markdown).toContain("# Screen review");
    expect(payload.markdown).toContain("## 1. Rectangle");
  });
});
