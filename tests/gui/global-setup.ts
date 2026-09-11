import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { request, type FullConfig } from "@playwright/test";

/**
 * GUI 全局登录：门禁启用时用本机 .env.local 的 REALM_ACCESS_TOKEN 换取
 * 会话 cookie 并保存为 storageState，供全部用例（页面与 API request
 * fixture）复用。门禁未启用（无 token）时写入空状态，行为与本地
 * 单用户回落一致。密钥只从本机环境读取，绝不写入仓库文件。
 */

const STATE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../.playwright/auth-state.json",
);

const GUI_DISPLAY_NAME = "GUI 测试员";

function readAccessToken(): string {
  if (process.env.REALM_ACCESS_TOKEN?.trim()) {
    return process.env.REALM_ACCESS_TOKEN.trim();
  }
  try {
    const envFile = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../.env.local"),
      "utf8",
    );
    const line = envFile
      .split("\n")
      .find((entry) => entry.startsWith("REALM_ACCESS_TOKEN="));
    return line
      ? line.slice("REALM_ACCESS_TOKEN=".length).trim().replace(/^["']|["']$/g, "")
      : "";
  } catch {
    return "";
  }
}

export default async function globalSetup(config: FullConfig) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  const token = readAccessToken();
  if (!token) {
    writeFileSync(STATE_PATH, JSON.stringify({ cookies: [], origins: [] }));
    return;
  }
  const baseURL = config.projects[0]?.use.baseURL ?? "http://127.0.0.1:9999";
  const context = await request.newContext({ baseURL });
  const response = await context.post("/api/auth/login", {
    data: { token, displayName: GUI_DISPLAY_NAME },
  });
  if (!response.ok()) {
    await context.dispose();
    throw new Error(
      `GUI 全局登录失败（${response.status()}）：请确认 REALM_ACCESS_TOKEN 与 dev server 一致。`,
    );
  }
  await context.storageState({ path: STATE_PATH });
  await context.dispose();
}
