/**
 * 注入/元话语拦截的共享核心词表（Clean-up Iteration Phase 3）。
 *
 * 生成侧（isInternalDiscoveryText，modules/actions/public.ts）与交付侧
 * （isInternalInstructionText，本目录 semantic-segments.ts）共用这份核心，
 * 防止词表漂移导致「生成放行、交付拦截」或反之的不一致；各过滤器只追加
 * 域特异性规则。
 */

/** 高置信度元话语/prompt 注入核心形态（中英；保守，不误伤普通世界词汇）。 */
export const INTERNAL_META_CORE_PATTERNS: readonly RegExp[] = [
  /提示词/,
  /system\s+prompt/i,
  /developer\s+message/i,
  /as an ai\b/i,
  /\blanguage model\b/i,
  /\bsystem prompt\b/i,
];
