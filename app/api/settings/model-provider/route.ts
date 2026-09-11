import {
  getModelSettingsService,
  modelSettingsErrorResponse,
  type ModelSettingsDraft,
} from "../../../../modules/application/model-settings-service.ts";
import { ModelConfigurationError } from "../../../../modules/inference/public.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../auth-context.ts";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const principalId = resolveRequestPrincipal(request, "principal_demo_player");
  if (!principalId) return unauthorizedResponse();
  try {
    return Response.json({
      ok: true as const,
      settings: await getModelSettingsService().get(),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return modelSettingsErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  const principalId = resolveRequestPrincipal(request, "principal_demo_player");
  if (!principalId) return unauthorizedResponse();
  try {
    const body = await readBody(request);
    return Response.json({
      ok: true as const,
      settings: await getModelSettingsService().save(body),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return modelSettingsErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const principalId = resolveRequestPrincipal(request, "principal_demo_player");
  if (!principalId) return unauthorizedResponse();
  try {
    const body = await readBody(request);
    const action = body.action;
    if (action === "discover") {
      return Response.json({
        ok: true as const,
        settings: await getModelSettingsService().discover(body),
      }, { headers: { "Cache-Control": "no-store" } });
    }
    if (action === "test") {
      return Response.json({
        ok: true as const,
        result: await getModelSettingsService().test(body),
      }, { headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({
      ok: false as const,
      error: { code: "INVALID_ACTION", message: "未知的模型设置操作。" },
    }, { status: 400 });
  } catch (error) {
    return modelSettingsErrorResponse(error);
  }
}

async function readBody(request: Request): Promise<ModelSettingsDraft & { action?: unknown }> {
  const body: unknown = await request.json();
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ModelConfigurationError(
      "MODEL_SETTINGS_INVALID",
      "模型设置请求必须是对象。",
    );
  }
  return body as ModelSettingsDraft & { action?: unknown };
}
