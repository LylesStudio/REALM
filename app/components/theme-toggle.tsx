"use client";

import { useSyncExternalStore } from "react";
import { uiText, type UiLanguage } from "../../modules/i18n/public.ts";
import {
  applyTheme,
  currentTheme,
  THEME_STORAGE_KEY,
  type UiTheme,
} from "../theme.ts";

/** 同页切换后通知 useSyncExternalStore 重新读取（跨页走 storage 事件）。 */
const THEME_CHANGE_EVENT = "realm-theme-changed";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(THEME_CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(THEME_CHANGE_EVENT, onChange);
  };
}

/**
 * 浅色/夜间主题切换按钮（header 主入口；设置页复用同一组件）。
 * 状态唯一事实源：localStorage(realm.theme) + documentElement data-theme；
 * 切换不触发 reload，不影响业务状态/SSE/表单内容。
 */
export function ThemeToggle({
  uiLanguage,
  className = "header-settings-link",
}: {
  uiLanguage: UiLanguage;
  className?: string;
}) {
  // SSR/首帧均按 light 渲染（getServerSnapshot），挂载后由 client snapshot
  // 同步真实主题——hydration 安全且无 set-state-in-effect。
  const theme = useSyncExternalStore(
    subscribe,
    () => currentTheme(document.documentElement),
    () => "light" as UiTheme,
  );

  const night = theme === "night";
  const label = uiText(night ? "ui.theme.toLight" : "ui.theme.toNight", uiLanguage);

  return (
    <button
      aria-label={uiText("ui.theme.toggleAria", uiLanguage)}
      aria-pressed={night}
      className={className}
      data-testid="theme-toggle"
      onClick={() => {
        const next: UiTheme = night ? "light" : "night";
        applyTheme(next, document.documentElement);
        try {
          localStorage.setItem(THEME_STORAGE_KEY, next);
        } catch {
          // 存储不可用时主题仍对当前会话生效。
        }
        window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
      }}
      title={label}
      type="button"
    >
      {label}
    </button>
  );
}
