/**
 * Compile-time mirror of the public runtime-extension activation surface.
 * The published package remains the peer dependency and runtime authority.
 */
declare module "@marshal/agent-runtime-extensions" {
  export interface RuntimeExtensionManifest {
    readonly schemaVersion: 1;
    readonly identity: string;
    readonly version: string;
    readonly entrypoint: string;
    readonly moduleFormat: "commonjs-bundle-v1";
  }

  export interface RuntimeExtensionActivationContext {
    readonly manifest: RuntimeExtensionManifest;
    readonly configuration: Readonly<Record<string, unknown>>;
    readonly services: {
      get<T>(token: symbol & { readonly __type?: (value: T) => T }): T;
      tryGet<T>(token: symbol & { readonly __type?: (value: T) => T }): T | undefined;
      getAll<T>(token: symbol & { readonly __type?: (value: T) => T }): readonly T[];
    };
    readonly signal?: { readonly aborted: boolean; readonly reason?: unknown };
    search(request: unknown, context?: unknown): Promise<unknown>;
    execute<TOutput = unknown>(request: unknown, context?: unknown): Promise<unknown>;
  }

  export interface RuntimeExtensionInvocationContext {
    readonly principal: {
      readonly id: string;
      readonly kind: string;
    };
    readonly scope: {
      readonly sessionId?: string;
      readonly [key: string]: string | undefined;
    };
    readonly metadata?: Readonly<Record<string, unknown>>;
  }

  export interface RuntimeExtensionCapabilityProvider {
    readonly id: string;
    readonly version?: string;
    list(context: RuntimeExtensionInvocationContext): readonly {
      readonly protocolVersion: string;
      readonly name: string;
      readonly version: string;
      readonly title?: string;
      readonly description: string;
      readonly tags?: readonly string[];
      readonly inputSchema?: Readonly<Record<string, unknown>>;
      readonly outputSchema: Readonly<Record<string, unknown>>;
    }[];
    get?(
      name: string,
      context: RuntimeExtensionInvocationContext,
    ): {
      readonly protocolVersion: string;
      readonly name: string;
      readonly version: string;
      readonly title?: string;
      readonly description: string;
      readonly tags?: readonly string[];
      readonly inputSchema?: Readonly<Record<string, unknown>>;
      readonly outputSchema: Readonly<Record<string, unknown>>;
    } | undefined;
    invoke(
      name: string,
      input: unknown,
      context: RuntimeExtensionInvocationContext,
    ): {
      readonly output: unknown;
    } | Promise<{
      readonly output: unknown;
    }>;
  }

  export interface RuntimeExtensionUiApplication {
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly renderId: string;
    readonly resource: unknown;
    readonly application: unknown;
    readonly tags?: readonly string[];
    readonly metadata?: Readonly<Record<string, unknown>>;
  }

  export type RuntimeExtensionUiPlacementAction = "replace" | "augment" | "fallback";

  export interface RuntimeExtensionUiHostPlacementMetadata {
    readonly title: string;
    readonly description?: string;
    readonly hasHostContent?: boolean;
    readonly supportedActions: readonly RuntimeExtensionUiPlacementAction[];
    readonly supportsFullReplacement?: boolean;
    readonly attributes?: Readonly<Record<string, unknown>>;
  }

  export interface RuntimeExtensionUiHostPlacement {
    readonly placementId: string;
    readonly parentPlacementId?: string;
    readonly metadata: RuntimeExtensionUiHostPlacementMetadata;
  }

  export interface RuntimeExtensionUiAugmentPlacementRegistration {
    readonly extensionId: string;
    readonly applicationId: RuntimeExtensionUiApplication["id"];
    readonly placementId: string;
    readonly action: "augment";
  }

  export interface RuntimeExtensionUiPlacementDiagnostic {
    readonly code:
      | "RUNTIME_EXTENSION_UI_PLACEMENT_EXACT_COLLISION"
      | "RUNTIME_EXTENSION_UI_PLACEMENT_ANCESTOR_DESCENDANT_COLLISION";
    readonly severity: "red-display";
    readonly message: string;
    readonly placementId: string;
    readonly extensionId: string;
    readonly relatedIds: readonly string[];
    readonly repairHint: string;
  }

  export interface RuntimeExtensionActivation {
    readonly capabilityProviders?: readonly RuntimeExtensionCapabilityProvider[];
    readonly catalogProviders?: readonly unknown[];
    readonly resourceProviders?: readonly unknown[];
    readonly uiApplications?: readonly RuntimeExtensionUiApplication[];
    readonly uiPlacements?: readonly (
      | {
          readonly placementId: string;
          readonly action: "replace";
          readonly applicationId: string;
          readonly replacement?: "placement" | "full";
        }
      | {
          readonly placementId: string;
          readonly action: "augment" | "fallback";
          readonly applicationId: string;
        }
    )[];
    readonly dispose?: () => void | Promise<void>;
  }

  export interface RuntimeExtensionModule {
    activate(
      context: RuntimeExtensionActivationContext,
    ): RuntimeExtensionActivation | Promise<RuntimeExtensionActivation>;
  }
}
