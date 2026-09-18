/**
 * LAN advertised origin（显式分享来源）——TS 入口。
 * 规则实现在 launcher/advertised-origin.mjs（plain JS，供无 type-stripping
 * 的 launcher/service-host 复用）；本文件只做类型化 re-export，两侧不得
 * 各自维护规则。
 *
 * 信任边界：只接受显式配置的 REALM_ADVERTISED_ORIGIN——http/https、
 * host 非空、禁 userinfo/query/fragment/路径。绝不自动扫描网卡、不猜
 * 私网 IP、不读 Host/X-Forwarded-Host。非法配置值 fail-closed 为 null
 * 并由 meta.advertisedOriginInvalid 让诊断可见（不静默吞错）。
 */
export {
  advertisedOriginFromEnv,
  isLoopbackOrigin,
  normalizeAdvertisedOrigin,
} from "../../launcher/advertised-origin.mjs";

export interface AdvertisedOriginResult {
  origin: string | null;
  /** 配置了但非法（true 时 origin 必为 null）。 */
  invalid: boolean;
}
