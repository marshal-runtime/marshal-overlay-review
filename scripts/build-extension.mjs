import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

await build({
  entryPoints: [join(root, "src", "extension", "runtime.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: ["node22"],
  sourcemap: true,
  outfile: join(root, "dist", "extension", "runtime.cjs"),
  logLevel: "info",
});

const dist = join(root, "dist");
await mkdir(dist, { recursive: true });
await writeFile(
  join(dist, "package.json"),
  `${JSON.stringify({ type: "module" }, null, 2)}\n`,
  "utf8",
);
