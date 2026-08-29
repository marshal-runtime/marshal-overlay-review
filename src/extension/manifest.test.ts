import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, name), "utf8")) as Record<string, unknown>;
}

describe("extension manifests", () => {
  it("declares the host service dependency", () => {
    const runtime = readJson("runtime-extension.json");
    const packageMetadata = readJson("package.json");

    expect(runtime).toMatchObject({
      schemaVersion: 1,
      identity: "@marshal/overlay-review",
      version: "0.1.0",
      entrypoint: "dist/extension/runtime.cjs",
      moduleFormat: "commonjs-bundle-v1",
      dependencies: {
        services: [{ id: "@marshal/marshal:ui.review", version: "1.0.0" }],
      },
    });
    expect(runtime).not.toHaveProperty("contributes");
    expect(packageMetadata).toMatchObject({
      type: "commonjs",
      main: "dist/extension/runtime.cjs",
      marshal: {
        runtimeExtension: "./runtime-extension.json",
        bundledByDefault: false,
      },
    });
    expect(packageMetadata).not.toHaveProperty("marshal.uiRegistration");
    expect(packageMetadata).not.toHaveProperty("exports./registration");
  });
});
