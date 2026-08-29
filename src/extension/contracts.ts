export const OVERLAY_REVIEW_EXTENSION_ID = "@marshal/overlay-review" as const;
export const MARSHAL_ADD_CONTENT_PLACEMENT_ID = "marshal.chat.composer.add" as const;
export const OVERLAY_REVIEW_APPLICATION_ID = "overlay-review" as const;
export const OVERLAY_REVIEW_RENDER_ID = "marshal.overlay-review.v1" as const;
export const OVERLAY_REVIEW_RESOURCE_URI = "runtime://overlay-review/ui/application/v1" as const;
export const OVERLAY_REVIEW_LAUNCH_CAPABILITY = "overlay.review.launch" as const;
export const MARSHAL_UI_REVIEW_SERVICE_ID = "@marshal/marshal:ui.review" as const;

export interface OverlayReviewLaunchService {
  launch(request: { readonly sessionId: string; readonly sessionTitle?: string }): void | Promise<void>;
}

type RuntimeServiceToken<T> = symbol & {
  readonly __type?: (value: T) => T;
};

export const MARSHAL_UI_REVIEW_SERVICE = Symbol.for(
  MARSHAL_UI_REVIEW_SERVICE_ID,
) as RuntimeServiceToken<OverlayReviewLaunchService>;
