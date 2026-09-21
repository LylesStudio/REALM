import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { request, type FullConfig } from "@playwright/test";

/**
 * GUI 全局登录：以演示账户名登录（账户名 + 可选密码的新语义；
 * 无密码账户留空即可）。凭据绝不从 .env.local 读取——REALM_ACCESS_TOKEN
 * 已退役，任何环境残留都被忽略。
 */

const STATE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../.playwright/auth-state.json",
);

const GUI_DISPLAY_NAME = "GUI 测试员";

export default async function globalSetup(config: FullConfig) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  const baseURL = config.projects[0]?.use.baseURL ?? "http://127.0.0.1:9999";
  const context = await request.newContext({ baseURL });
  const response = await context.post("/api/auth/login", {
    data: { displayName: GUI_DISPLAY_NAME, password: "" },
  });
  if (!response.ok()) {
    await context.dispose();
    throw new Error(
      `GUI 全局登录失败（${response.status()}）：请确认隔离 server 的账户登录可用。`,
    );
  }
  await context.storageState({ path: STATE_PATH });
  await context.dispose();
}
