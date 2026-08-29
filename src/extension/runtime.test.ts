import type { RuntimeExtensionActivationContext } from "@marshal/agent-runtime-extensions";
import { describe, expect, it, vi } from "vitest";

import {
  MARSHAL_UI_REVIEW_SERVICE,
  OVERLAY_REVIEW_LAUNCH_CAPABILITY,
  type OverlayReviewLaunchService,
} from "./contracts.ts";
import { activate } from "./runtime.ts";

const manifest = {
  schemaVersion: 1 as const,
  identity: "@marshal/overlay-review",
  version: "0.1.0",
  entrypoint: "dist/extension/runtime.cjs",
  moduleFormat: "commonjs-bundle-v1" as const,
};

describe("runtime extension surface", () => {
  it("publishes the launch capability and standard UI placement", async () => {
    const firstLaunch = vi.fn<OverlayReviewLaunchService["launch"]>();
    const replacementLaunch = vi.fn<OverlayReviewLaunchService["launch"]>();
    let review: OverlayReviewLaunchService = { launch: firstLaunch };
    const activation = activate({
      manifest,
      configuration: {},
      services: {
        get: (token) => {
          if (token !== MARSHAL_UI_REVIEW_SERVICE) throw new Error("Unknown service");
          return review;
        },
        tryGet: () => undefined,
        getAll: () => [],
      },
      search: async () => ({}),
      execute: async () => ({}),
    } as RuntimeExtensionActivationContext);

    expect(activation.uiApplications).toMatchObject([
      {
        id: "overlay-review",
        renderId: "marshal.overlay-review.v1",
        application: {
          actions: [
            {
              target: {
                kind: "capability",
                capability: OVERLAY_REVIEW_LAUNCH_CAPABILITY,
              },
            },
          ],
        },
      },
    ]);
    expect(activation.uiPlacements).toEqual([
      {
        placementId: "marshal.chat.composer.add",
        action: "augment",
        applicationId: "overlay-review",
      },
    ]);

    const provider = activation.capabilityProviders?.[0];
    await provider?.invoke(
      OVERLAY_REVIEW_LAUNCH_CAPABILITY,
      { sessionId: "session-1" },
      {
        principal: { id: "marshal-renderer", kind: "user" },
        scope: { sessionId: "session-1" },
      },
    );
    expect(firstLaunch).toHaveBeenCalledWith({ sessionId: "session-1" });

    review = { launch: replacementLaunch };
    await provider?.invoke(
      OVERLAY_REVIEW_LAUNCH_CAPABILITY,
      { sessionId: "session-1", sessionTitle: "Active session" },
      {
        principal: { id: "marshal-renderer", kind: "user" },
        scope: { sessionId: "session-1" },
      },
    );
    expect(replacementLaunch).toHaveBeenCalledWith({
      sessionId: "session-1",
      sessionTitle: "Active session",
    });
    expect(activation).not.toHaveProperty("dispose");
  });
});
