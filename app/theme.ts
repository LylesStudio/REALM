/**
 * 主题状态工具（浅色默认 / 深夜纸墨）。
 * SSR/hydration 安全：模块顶层不触碰 window/localStorage；
 * 纯函数部分可单测，DOM 应用部分显式传入 root。
 */

export const THEME_STORAGE_KEY = "realm.theme";

export type UiTheme = "light" | "night";

/** 非法/缺失值一律回落浅色（默认主题）。 */
export function normalizeTheme(value: unknown): UiTheme {
  return value === "night" ? "night" : "light";
}

/** 从任意 getItem 形存储读主题（纯函数，测试可注入 fake storage）。 */
export function readStoredTheme(
  storage: { getItem: (key: string) => string | null } | null | undefined,
): UiTheme {
  try {
    return normalizeTheme(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return "light";
  }
}

/** 应用主题到根元素：data-theme + color-scheme 同步（客户端调用）。 */
export function applyTheme(theme: UiTheme, root: HTMLElement): void {
  root.dataset.theme = theme;
  root.style.colorScheme = theme === "night" ? "dark" : "light";
}

/** 读取当前根元素主题（客户端调用；SSR 返回 light）。 */
export function currentTheme(root?: HTMLElement): UiTheme {
  if (!root) return "light";
  return normalizeTheme(root.dataset.theme);
}

/**
 * 首帧初始化脚本源码（layout 内联注入，first paint 前执行）。
 * 与 applyTheme 语义保持一致：night 才写 data-theme，light 依赖缺省。
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==="night"){document.documentElement.dataset.theme="night";document.documentElement.style.colorScheme="dark";}}catch(e){}})()`;
