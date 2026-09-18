/**
 * 界面语言运行时：本机存储 + 浏览器/系统自动检测 + 跨组件同步。
 *
 * 优先级：localStorage(realm-ui-language) 已存值 > navigator.languages 检测 > 默认中文。
 * 首次访问时按浏览器/系统语言检测并持久化，之后遵循用户手动选择。
 * 状态变化通过 CustomEvent 同页广播 + storage 事件跨页同步。
 */

import {
  DEFAULT_UI_LANGUAGE,
  normalizeUiLanguage,
  type UiLanguage,
} from "../modules/i18n/public.ts";

export const UI_LANGUAGE_STORAGE_KEY = "realm-ui-language";

const UI_LANGUAGE_CHANGE_EVENT = "realm-ui-language-changed";

/** 按浏览器/系统语言给出最贴近的界面语言。 */
export function detectNavigatorUiLanguage(): UiLanguage {
  if (typeof navigator === "undefined") return DEFAULT_UI_LANGUAGE;
  const raw = (navigator.languages?.[0] ?? navigator.language ?? "").toLowerCase();
  if (raw.startsWith("zh")) return "zh-CN";
  if (raw.startsWith("ja")) return "ja";
  if (raw.startsWith("en")) return "en";
  return DEFAULT_UI_LANGUAGE;
}

/** 读取当前界面语言：已存值直接采用；首次访问检测并持久化。 */
export function readUiLanguage(): UiLanguage {
  if (typeof window === "undefined") return DEFAULT_UI_LANGUAGE;
  try {
    const stored = window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY);
    if (stored) return normalizeUiLanguage(stored);
  } catch {
    // 存储不可用（隐私模式等）：按检测值返回，不落盘。
  }
  return detectNavigatorUiLanguage();
}

/** 首访检测的惰性持久化：只有“用户从未选过”时才写入，避免覆盖手动选择。 */
export function persistDetectedUiLanguage(language: UiLanguage): void {
  if (typeof window === "undefined") return;
  try {
    if (!window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)) {
      window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, language);
    }
  } catch {
    // 存储不可用时跳过；检测值对当前会话仍然生效。
  }
}

/** 手动切换：落盘 + 同页广播（服务端同步由调用方负责）。 */
export function writeUiLanguage(language: UiLanguage): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, language);
  } catch {
    // 存储不可用时切换仍对当前会话生效。
  }
  window.dispatchEvent(new Event(UI_LANGUAGE_CHANGE_EVENT));
}

/** 订阅语言变化：storage（跨页）+ CustomEvent（同页）。 */
export function subscribeUiLanguage(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(UI_LANGUAGE_CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(UI_LANGUAGE_CHANGE_EVENT, onChange);
  };
}
