/**
 * Record 运行时内容解析源（Slice 2.5）：按 Record 的 WorldBinding 选定
 * 运行时定义读取的 ContentResolver——
 *
 * - base binding（或缺省）→ engine-owned BaseContentResolver（纯内存）；
 * - world-bound binding → 已挂载签名 RealmWorld 包的
 *   RealmWorldContentResolver（createRealmWorldContentResolver +
 *   installRoot + trust-store verifier），按 worldId/worldVersion/locale
 *   缓存挂载结果；
 * - world-bound 但安装根/verifier 未配置、挂载或验签失败 → null
 *   （fail-closed：内容层无贡献，调用方仅以 DB 物化定义继续；绝不退化
 *   为未验签或 base 内容顶替 world-bound 身份）。
 *
 * 服务端模块：world-bound 路径经 realmworld-loader/trust-store 执行
 * 文件 IO 与签名校验，不得被 client bundle 引用。
 */
import {
  BASE_CONTENT_RESOLVER,
} from "../content-resolution/base-resolver.ts";
import {
  createRealmWorldContentResolver,
} from "../content-resolution/realmworld-resolver.ts";
import {
  normalizeContentLanguage,
  type ContentResolver,
} from "../content-resolution/public.ts";
import type {
  RealmWorldSignatureVerifier,
} from "../world-transfer/realmworld-loader.ts";
import type { WorldBinding } from "../world-transfer/realm-save.ts";

/**
 * 从运行时 scope 的松散 worldBinding 值（RecordRuntimeScope 索引签名）
 * 窄化为精确 WorldBinding。非对象/缺省 → base；kind "world" 但身份
 * 不完整 → null（fail-closed，绝不把畸形 world 身份当 base 解析）。
 */
export function narrowWorldBinding(value: unknown): WorldBinding | null {
  if (!value || typeof value !== "object") return { kind: "base" };
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "base") return { kind: "base" };
  if (kind === "world") {
    const candidate = value as { worldId?: unknown; worldVersion?: unknown };
    if (
      typeof candidate.worldId === "string"
      && candidate.worldId.trim().length > 0
      && typeof candidate.worldVersion === "string"
      && candidate.worldVersion.trim().length > 0
    ) {
      return {
        kind: "world",
        worldId: candidate.worldId,
        worldVersion: candidate.worldVersion,
      };
    }
    return null;
  }
  return { kind: "base" };
}

export interface RecordContentResolverSource {
  /**
   * 按 binding + 语言解析 ContentResolver。base → BaseContentResolver；
   * world-bound → 挂载/验签后的 RealmWorldContentResolver（或 null）。
   */
  forBinding(
    binding: WorldBinding,
    language?: string,
  ): Promise<ContentResolver | null>;
}

export function createRecordContentResolverSource(options: {
  installRoot?: string;
  verifySignature?: RealmWorldSignatureVerifier;
  /** base binding 的 resolver（缺省共享 BASE_CONTENT_RESOLVER）。 */
  baseResolver?: ContentResolver;
  /** 测试注入点：替换 world-bound resolver 工厂（绕过包挂载）。 */
  realmWorldResolverFactory?: (
    binding: Extract<WorldBinding, { kind: "world" }>,
    locale: string,
  ) => Promise<ContentResolver | null>;
  logger?: (line: string) => void;
}): RecordContentResolverSource {
  const baseResolver = options.baseResolver ?? BASE_CONTENT_RESOLVER;
  const warn = options.logger
    ?? ((line: string) => console.warn(`[realm] ${line}`));
  const cache = new Map<string, Promise<ContentResolver | null>>();
  return {
    forBinding(binding, language) {
      if (binding.kind === "base") return Promise.resolve(baseResolver);
      const locale = normalizeContentLanguage(language) ?? "zh-CN";
      if (!options.installRoot || !options.verifySignature) {
        // 无安装根/verifier：world-bound 内容不可用（fail-closed null）。
        return Promise.resolve(null);
      }
      const key = `${binding.worldId}\x1f${binding.worldVersion}\x1f${locale}`;
      let cached = cache.get(key);
      if (!cached) {
        const installRoot = options.installRoot;
        const verifySignature = options.verifySignature;
        const factory = options.realmWorldResolverFactory
          ?? ((exactBinding, factoryLocale) =>
            createRealmWorldContentResolver({
              installRoot,
              verifySignature,
              locale: factoryLocale,
            })(exactBinding));
        cached = factory(binding, locale).catch((error: unknown) => {
          // 挂载/验签失败 fail-closed 为 null；告警一次（按身份缓存）。
          warn(
            `world-bound content resolver unavailable for ${binding.worldId}@${binding.worldVersion}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return null;
        });
        cache.set(key, cached);
      }
      return cached;
    },
  };
}
