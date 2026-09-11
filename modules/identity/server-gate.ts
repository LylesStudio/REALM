/**
 * 页面级门禁（仅服务端组件使用）：门禁启用且无有效会话时重定向登录页。
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  SESSION_COOKIE,
  isAccessGateEnabled,
  verifySessionValue,
} from "./auth.ts";

export async function requirePageSession(returnTo = "/"): Promise<void> {
  if (!isAccessGateEnabled()) return;
  const cookieHeader = (await headers()).get("cookie") ?? "";
  let value: string | undefined;
  for (const entry of cookieHeader.split(";")) {
    const [name, ...rest] = entry.trim().split("=");
    if (name === SESSION_COOKIE) value = rest.join("=");
  }
  if (!verifySessionValue(value)) {
    redirect(`/login?return_to=${encodeURIComponent(returnTo)}`);
  }
}
