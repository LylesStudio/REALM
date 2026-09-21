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

export const runtime = "nodejs";

/** 每次请求构造（store 路径读 REALM_DATA_HOME，测试/桌面环境隔离）。 */
function service() {
  return createComfyUiSettingsService({ store: createComfyUiSettingsStore() });
}

export async function GET(request: Request) {
  const principalId = resolveRequestPrincipal(request, "principal_demo_player");
  if (!principalId) return unauthorizedResponse();
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
  const principalId = resolveRequestPrincipal(request, "principal_demo_player");
  if (!principalId) return unauthorizedResponse();
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
  const principalId = resolveRequestPrincipal(request, "principal_demo_player");
  if (!principalId) return unauthorizedResponse();
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
