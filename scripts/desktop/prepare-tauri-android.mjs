#!/usr/bin/env node
/**
 * Generate the Tauri Android project when needed, then apply the small REALM
 * client-only manifest policy that is not expressible in tauri.conf.json:
 * local HTTP/LAN servers are supported with an explicit UI warning, while the
 * APK still contains no server runtime. Never read credentials.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const androidRoot = resolve(root, "src-tauri/gen/android");
const gradle = resolve(androidRoot, "app/build.gradle.kts");

if (!existsSync(gradle)) {
  const result = spawnSync("cargo", ["tauri", "android", "init", "--ci"], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`cargo tauri android init failed with exit ${result.status ?? "null"}`);
  }
}

const source = readFileSync(gradle, "utf8");
const updated = source
  .replace(
    'manifestPlaceholders["usesCleartextTraffic"] = "false"',
    [
      "// REALM client-only APK may connect to a user-selected local HTTP service.",
      "// The boot screen warns that HTTP is not encrypted; HTTPS is preferred.",
      'manifestPlaceholders["usesCleartextTraffic"] = "true"',
    ].join("\n        "),
  );
if (!updated.includes('manifestPlaceholders["usesCleartextTraffic"] = "true"')) {
  throw new Error("Android Gradle template did not expose usesCleartextTraffic policy");
}
if (updated !== source) writeFileSync(gradle, updated, "utf8");
console.log(`prepared Android client-only project at ${androidRoot}`);
