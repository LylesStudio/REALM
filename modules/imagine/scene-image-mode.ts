/**
 * 场景图自动生成模式（账号级偏好；docs/development/IMAGE-GENERATION-AUTO-MODE.md）。
 * off（默认，零 GPU）/ scene_change（晶化真正写出新场景后排队）/
 * every_turn（每个成功 committed 玩家回合排队一次）。
 */

export const SCENE_IMAGE_MODES = ["off", "scene_change", "every_turn"] as const;

export type SceneImageMode = (typeof SCENE_IMAGE_MODES)[number];

export const DEFAULT_SCENE_IMAGE_MODE: SceneImageMode = "off";

/** 未知/缺失/非法值一律 fail-closed 到 off。 */
export function normalizeSceneImageMode(value: unknown): SceneImageMode {
  return typeof value === "string"
    && (SCENE_IMAGE_MODES as readonly string[]).includes(value)
    ? (value as SceneImageMode)
    : DEFAULT_SCENE_IMAGE_MODE;
}
