/**
 * 图像视觉 profile（server-only）：与叙事文风 WorldStyle 同键但语义独立——
 * describeWorldStyle 的中文行文约束只服务文本生成，绝不进图片 prompt；
 * 本表是英文视觉约束（medium/rendering/line/lighting/palette/composition）
 * + 风格漂移 negative。未知/缺失 fail-closed 到 modern。
 * 场景建立图优先：profile 不强制角色出镜。
 */
import {
  DEFAULT_WORLD_STYLE,
  WORLD_STYLE_KEYS,
  type WorldStyle,
} from "../style/world-style.ts";

export interface ImageVisualProfile {
  /** positive 侧固定视觉层（英文；≤400 字符预算由契约测试钉住）。 */
  visualPrompt: string;
  /** negative 侧风格漂移约束（追加在固定负面串之后）。 */
  negativeAdditions: string;
}

export const IMAGE_VISUAL_PROFILES: Record<WorldStyle, ImageVisualProfile> = {
  modern: {
    visualPrompt:
      "visual style: modern anime background art, clean digital painting, thin confident lineart, soft cel shading, muted contemporary palette with warm accents, calm naturalistic lighting, quiet everyday atmosphere, balanced wide composition with clear focal depth",
    negativeAdditions:
      "photorealistic, oil painting texture, heavy impasto, gothic ornament, medieval props",
  },
  classical: {
    visualPrompt:
      "visual style: classical East-Asian ink-wash inspired background art, delicate brush linework, translucent layered washes, subdued mineral and ink palette, soft diffused mist lighting, generous negative space, composed like a handscroll plate with measured rhythm",
    negativeAdditions:
      "photorealistic, neon colors, chrome, modern signage, western medieval armor",
  },
  western_fantasy: {
    visualPrompt:
      "visual style: western fantasy background art, storybook illustration with clean lineart, gentle cel shading, earthy palette with heraldic accents, cool ambient light with warm hearth highlights, orderly epic composition, distant silhouettes and layered depth",
    negativeAdditions:
      "photorealistic, ukiyo-e brushwork, modern vehicles, contemporary signage",
  },
  anime: {
    visualPrompt:
      "visual style: bright TV-anime background art, crisp clean lineart, flat cel colors with soft gradients, vivid yet harmonious palette, clear daylight with gentle bloom, lively open composition, polished key visual finish",
    negativeAdditions:
      "photorealistic, muddy colors, heavy grunge texture, dark horror tone",
  },
};

/** 未知/缺失风格 fail-closed 到 modern。 */
export function resolveImageVisualStyle(style: unknown): WorldStyle {
  return typeof style === "string"
    && (WORLD_STYLE_KEYS as readonly string[]).includes(style)
    ? (style as WorldStyle)
    : DEFAULT_WORLD_STYLE;
}

export function imageVisualProfile(style: unknown): ImageVisualProfile {
  return IMAGE_VISUAL_PROFILES[resolveImageVisualStyle(style)];
}
