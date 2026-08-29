import type {
  RuntimeExtensionActivation,
  RuntimeExtensionActivationContext,
  RuntimeExtensionCapabilityProvider,
  RuntimeExtensionInvocationContext,
  RuntimeExtensionModule,
} from "@marshal/agent-runtime-extensions";

import {
  MARSHAL_ADD_CONTENT_PLACEMENT_ID,
  MARSHAL_UI_REVIEW_SERVICE,
  OVERLAY_REVIEW_APPLICATION_ID,
  OVERLAY_REVIEW_LAUNCH_CAPABILITY,
  OVERLAY_REVIEW_RENDER_ID,
  OVERLAY_REVIEW_RESOURCE_URI,
  type OverlayReviewLaunchService,
} from "./contracts.ts";

const EMPTY_OBJECT_SCHEMA = Object.freeze({
  type: "object",
  properties: Object.freeze({}),
  additionalProperties: false,
});
const LAUNCH_INPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: Object.freeze({
    sessionId: Object.freeze({ type: "string", minLength: 1 }),
    sessionTitle: Object.freeze({ type: "string", minLength: 1 }),
  }),
  required: Object.freeze(["sessionId"]),
  additionalProperties: false,
});
const LAUNCH_DESCRIPTOR = Object.freeze({
  protocolVersion: "1.0.0",
  name: OVERLAY_REVIEW_LAUNCH_CAPABILITY,
  version: "1.0.0",
  title: "Review on screen",
  description: "Launches Marshal's native screen review overlay for the active session.",
  inputSchema: LAUNCH_INPUT_SCHEMA,
  outputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({}),
    additionalProperties: false,
  }),
});

function createLaunchProvider(
  services: RuntimeExtensionActivationContext["services"],
): RuntimeExtensionCapabilityProvider {
  return Object.freeze({
    id: "@marshal/overlay-review:capabilities",
    version: "1.0.0",
    list: () => Object.freeze([LAUNCH_DESCRIPTOR]),
    get: (name: string) =>
      name === OVERLAY_REVIEW_LAUNCH_CAPABILITY ? LAUNCH_DESCRIPTOR : undefined,
    invoke: async (
      name: string,
      input: unknown,
      context: RuntimeExtensionInvocationContext,
    ) => {
      if (name !== OVERLAY_REVIEW_LAUNCH_CAPABILITY) {
        throw new Error(`Unsupported overlay review capability: ${name}`);
      }
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new Error("Overlay review requires a launch input object.");
      }
      const launchInput = input as Readonly<Record<string, unknown>>;
      const sessionId =
        typeof launchInput.sessionId === "string" ? launchInput.sessionId.trim() : "";
      const scopedSessionId = context.scope?.sessionId?.trim();
      if (!sessionId || sessionId !== scopedSessionId) {
        throw new Error("Overlay review requires the active session ID.");
      }
      const sessionTitle =
        typeof launchInput.sessionTitle === "string" ? launchInput.sessionTitle.trim() : "";
      const review: OverlayReviewLaunchService = services.get(MARSHAL_UI_REVIEW_SERVICE);
      await review.launch({
        sessionId,
        ...(sessionTitle ? { sessionTitle } : {}),
      });
      return { output: {} };
    },
  });
}

export function activate(
  context: RuntimeExtensionActivationContext,
): RuntimeExtensionActivation {
  const launchProvider = createLaunchProvider(context.services);
  return Object.freeze({
    capabilityProviders: Object.freeze([launchProvider]),
    uiApplications: Object.freeze([
      Object.freeze({
        id: OVERLAY_REVIEW_APPLICATION_ID,
        title: "Review on screen",
        description: "Annotate the current screen and attach the review to this session.",
        renderId: OVERLAY_REVIEW_RENDER_ID,
        resource: Object.freeze({
          uri: OVERLAY_REVIEW_RESOURCE_URI,
          mimeType: "text/plain",
          text: "",
        }),
        application: Object.freeze({
          version: "1.0.0",
          presentationModes: Object.freeze(["inline"]),
          actions: Object.freeze([
            Object.freeze({
              id: "launch",
              version: "1.0.0",
              title: "Review on screen",
              target: Object.freeze({
                kind: "capability",
                capability: OVERLAY_REVIEW_LAUNCH_CAPABILITY,
              }),
              inputSchema: LAUNCH_INPUT_SCHEMA,
              outputSchema: LAUNCH_DESCRIPTOR.outputSchema,
              allowedScopes: Object.freeze(["session"]),
              requiredPermissions: Object.freeze([]),
              risk: "external-effect",
              idempotency: "none",
            }),
          ]),
          tools: Object.freeze([]),
        }),
      }),
    ]),
    uiPlacements: Object.freeze([
      Object.freeze({
        placementId: MARSHAL_ADD_CONTENT_PLACEMENT_ID,
        action: "augment",
        applicationId: OVERLAY_REVIEW_APPLICATION_ID,
      }),
    ]),
  });
}

const runtimeExtension: RuntimeExtensionModule = Object.freeze({ activate });

export default runtimeExtension;
