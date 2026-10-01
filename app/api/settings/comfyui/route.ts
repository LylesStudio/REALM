import {
  comfyUiSettingsErrorResponse,
  createComfyUiSettingsService,
  type ComfyUiSettingsDraft,
} from "../../../../modules/application/comfyui-settings-service.ts";
import { createComfyUiSettingsStore } from "../../../../modules/imagine/public.ts";
import { ComfyUiSettingsError } from "../../../../modules/imagine/public.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../auth-context.ts";
import { isOperatorPrincipal } from "../../../../modules/identity/operator.ts";

export const runtime = "nodejs";

/** 每次请求构造（store 路径读 REALM_DATA_HOME，测试/桌面环境隔离）。 */
function service() {
  return createComfyUiSettingsService({ store: createComfyUiSettingsStore() });
}

/**
 * 全局 operator 门禁（M7 收口）：ComfyUI 设置是服务级配置（endpoint +
 * shared key），只允许 REALM_OPERATOR_PRINCIPALS 精确列出的 principal；
 * 空缺/空白 = 无 operator = 全部 403 fail-closed。403 在任何设置读取/
 * 网络请求之前返回，响应不回显设置、URL 或 key。
 */
function requireOperator(request: Request): string | Response {
  const principalId = resolveRequestPrincipal(request, "principal_demo_player");
  if (!principalId) return unauthorizedResponse();
  if (!isOperatorPrincipal(principalId)) {
    return Response.json(
      { ok: false as const, error: { code: "OPERATOR_REQUIRED", message: "图像生成设置仅本机 operator 可管理。" } },
      { status: 403 },
    );
  }
  return principalId;
}

export async function GET(request: Request) {
  const gated = requireOperator(request);
  if (gated instanceof Response) return gated;
  try {
    return Response.json(
      { ok: true as const, settings: await service().get() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return comfyUiSettingsErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  const gated = requireOperator(request);
  if (gated instanceof Response) return gated;
  try {
    return Response.json(
      { ok: true as const, settings: await service().save(await readBody(request)) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return comfyUiSettingsErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const gated = requireOperator(request);
  if (gated instanceof Response) return gated;
  try {
    const body = await readBody(request);
    if ((body as { action?: unknown }).action !== "test") {
      return Response.json(
        { ok: false as const, error: { code: "INVALID_ACTION", message: "未知的图像生成设置操作。" } },
        { status: 400 },
      );
    }
    return Response.json(
      { ok: true as const, result: await service().test(body) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return comfyUiSettingsErrorResponse(error);
  }
}

async function readBody(request: Request): Promise<ComfyUiSettingsDraft> {
  const body: unknown = await request.json();
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ComfyUiSettingsError("The ComfyUI settings request must be an object.");
  }
  return body as ComfyUiSettingsDraft;
}
