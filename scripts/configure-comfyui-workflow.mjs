#!/usr/bin/env node
/**
 * 配置 ComfyUI 工作流缺失模型。
 *
 * 读取 REALM 打包的 Anima 工作流 manifest（或用户自定义 manifest），
 * 检查本地 ComfyUI 模型目录中是否已存在所需模型，并给出缺失项的
 * 下载/放置指引。
 *
 * 用法：
 *   node scripts/configure-comfyui-workflow.mjs
 *   node scripts/configure-comfyui-workflow.mjs --comfy-dir ~/comfy/ComfyUI
 *   node scripts/configure-comfyui-workflow.mjs --manifest ./my-workflow.manifest.json
 */

import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const DEFAULT_COMFY_DIR = join(homedir(), "comfy", "ComfyUI");
const DEFAULT_MANIFEST = join(
  import.meta.dirname,
  "..",
  "workflows",
  "realm",
  "anima-scene-v0.manifest.json",
);

/** kind → 可能存放目录（按优先顺序）。 */
const KIND_FOLDERS = {
  unet: ["diffusion_models", "unet"],
  clip: ["text_encoders", "clip"],
  vae: ["vae"],
};

function parseArgs(argv) {
  const args = argv.slice(2);
  let comfyDir = DEFAULT_COMFY_DIR;
  let manifest = DEFAULT_MANIFEST;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--comfy-dir" || arg === "-c") {
      comfyDir = args[++i] ?? comfyDir;
    } else if (arg === "--manifest" || arg === "-m") {
      manifest = args[++i] ?? manifest;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`usage: node scripts/configure-comfyui-workflow.mjs [options]

options:
  -c, --comfy-dir <path>   ComfyUI root directory (default: ${DEFAULT_COMFY_DIR})
  -m, --manifest <path>    Workflow manifest JSON (default: bundled Anima manifest)
  -h, --help               Show this help
`);
      process.exit(0);
    }
  }
  return { comfyDir: resolve(comfyDir), manifest: resolve(manifest) };
}

async function fileExists(path) {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

async function readJson(path) {
  const text = await readFile(path, "utf8");
  return JSON.parse(text);
}

function collectDependencies(manifest) {
  const workflows = manifest?.workflows ?? {};
  const seen = new Map();
  for (const workflow of Object.values(workflows)) {
    const deps = Array.isArray(workflow?.modelDependencies)
      ? workflow.modelDependencies
      : [];
    for (const dep of deps) {
      const key = `${dep.kind}:${dep.file}`;
      if (!seen.has(key)) {
        seen.set(key, dep);
      }
    }
  }
  return [...seen.values()];
}

async function checkDependency(dep, comfyDir) {
  const folders = KIND_FOLDERS[dep.kind] ?? [dep.kind];
  const candidates = folders.map((folder) =>
    join(comfyDir, "models", folder, dep.file),
  );
  for (const path of candidates) {
    if (await fileExists(path)) {
      return { found: true, path };
    }
  }
  return { found: false, candidates };
}

function printReport({ manifest, comfyDir, missing, found }) {
  console.log(`\nmanifest: ${manifest}`);
  console.log(`ComfyUI : ${comfyDir}`);
  console.log(`\n${found.length} found, ${missing.length} missing\n`);

  if (found.length > 0) {
    console.log("已配置模型:");
    for (const item of found) {
      console.log(`  ✓ ${item.dep.kind}/${item.dep.file}`);
      console.log(`    ${item.path}`);
    }
    console.log("");
  }

  if (missing.length > 0) {
    console.log("缺失模型（请按下方路径放置）:");
    for (const item of missing) {
      const folders = KIND_FOLDERS[item.dep.kind] ?? [item.dep.kind];
      console.log(`  ✗ ${item.dep.kind}/${item.dep.file}`);
      console.log(`    预期路径: ${folders.map((f) => join("models", f, item.dep.file)).join(" 或 ")}`);
    }
    console.log("\n下载指引:");
    console.log("  1. Anima 官方模型（推荐）:");
    console.log("     https://huggingface.co/circlestone-labs/Anima");
    console.log("     或 https://huggingface.co/Abiray/Anima-turbo-v1.0-GGUF 的 split_files 目录");
    console.log("  2. 缺失文件对应关系:");
    console.log("     anima-turbo-v1.0.safetensors → ComfyUI/models/diffusion_models/");
    console.log("     qwen_3_06b_base.safetensors  → ComfyUI/models/text_encoders/");
    console.log("     qwen_image_vae.safetensors   → ComfyUI/models/vae/");
    console.log("  3. 若使用 Civitai 整合包，也可直接下载 ANIMA-V1-Turbo-AIO 等整合模型，");
    console.log("     但需确认文件名与 manifest 中一致。");
    console.log("");
    process.exitCode = 1;
  } else {
    console.log("所有模型已就位，可以直接运行工作流。\n");
  }
}

async function main() {
  const { comfyDir, manifest } = parseArgs(process.argv);

  let manifestData;
  try {
    manifestData = await readJson(manifest);
  } catch (error) {
    console.error(`无法读取 manifest: ${manifest}`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }

  const dependencies = collectDependencies(manifestData);
  if (dependencies.length === 0) {
    console.log("manifest 中没有 modelDependencies，无需配置模型。\n");
    return;
  }

  const found = [];
  const missing = [];
  for (const dep of dependencies) {
    const result = await checkDependency(dep, comfyDir);
    if (result.found) {
      found.push({ dep, path: result.path });
    } else {
      missing.push({ dep, candidates: result.candidates });
    }
  }

  printReport({ manifest, comfyDir, missing, found });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
});
