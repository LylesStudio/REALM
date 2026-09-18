"use client";

import { useEffect, useRef, useState } from "react";
import { uiText, UI_LANGUAGES, type UiLanguage } from "../../modules/i18n/public.ts";
import { writeUiLanguage } from "../ui-language.ts";

const LANGUAGE_SELF_NAMES: Record<UiLanguage, string> = {
  "zh-CN": "中文",
  en: "English",
  ja: "日本語",
};

/**
 * 界面语言菜单（header 常驻入口；设置页与登录页复用）。
 * 自定义矩形弹层，不使用浏览器原生 <select>；选项用各语言自称。
 * 切换后写本机存储并同页广播；服务端账户偏好同步为尽力而为。
 */
export function LanguageMenu({
  uiLanguage,
  className = "header-settings-link",
}: {
  uiLanguage: UiLanguage;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function choose(language: UiLanguage) {
    setOpen(false);
    if (language === uiLanguage) return;
    writeUiLanguage(language);
    void fetch("/api/settings/language", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ language }),
    }).catch(() => {
      // 服务端同步失败不阻塞本机切换；下次保存会重试。
    });
  }

  return (
    <div className="language-menu" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={uiText("ui.lang.toggleAria", uiLanguage)}
        className={className}
        data-testid="language-menu"
        onClick={() => setOpen((value) => !value)}
        title={uiText("ui.lang.toggleAria", uiLanguage)}
        type="button"
      >
        {LANGUAGE_SELF_NAMES[uiLanguage]}
      </button>
      {open ? (
        <div className="language-menu-popover" role="listbox" aria-label={uiText("ui.lang.label", uiLanguage)}>
          {UI_LANGUAGES.map((language) => (
            <button
              aria-selected={uiLanguage === language}
              className={`language-menu-option${uiLanguage === language ? " is-active" : ""}`}
              key={language}
              onClick={() => choose(language)}
              role="option"
              type="button"
            >
              {LANGUAGE_SELF_NAMES[language]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
