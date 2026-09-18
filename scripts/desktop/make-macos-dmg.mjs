#!/usr/bin/env node
/** Create a simple drag-to-Applications DMG with macOS built-ins. */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export function createDmg({ appPath, outputPath, volumeName = "REALM" }) {
  const sourceApp = resolve(appPath);
  const destination = resolve(outputPath);
  if (!existsSync(join(sourceApp, "Contents", "Info.plist"))) {
    throw new Error(`macOS app bundle is missing Info.plist: ${sourceApp}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  const staging = mkdtempSync(join(tmpdir(), "realm-dmg-"));
  try {
    cpSync(sourceApp, join(staging, basename(sourceApp)), { recursive: true });
    symlinkSync("/Applications", join(staging, "Applications"), "dir");
    const result = spawnSync(
      "hdiutil",
      [
        "create",
        "-volname",
        volumeName,
        "-srcfolder",
        staging,
        "-ov",
        "-format",
        "UDZO",
        destination,
      ],
      { stdio: "inherit" },
    );
    if (result.status !== 0) throw new Error(`hdiutil create failed with exit ${result.status}`);
    const verification = spawnSync("hdiutil", ["verify", destination], {
      stdio: "inherit",
    });
    if (verification.status !== 0) {
      throw new Error(`hdiutil verify failed with exit ${verification.status}`);
    }
    return destination;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const appPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!appPath || !outputPath) {
    console.error("usage: node scripts/desktop/make-macos-dmg.mjs <REALM.app> <output.dmg>");
    process.exitCode = 2;
  } else {
    try {
      console.log(`created ${createDmg({ appPath, outputPath })}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
