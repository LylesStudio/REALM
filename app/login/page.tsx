"use client";

import { useEffect, useState, type FormEvent } from "react";
import { uiText, type UiLanguage } from "../../modules/i18n/public.ts";
import { LanguageMenu } from "../components/language-menu.tsx";
import { readUiLanguage, subscribeUiLanguage } from "../ui-language.ts";

export default function LoginPage() {
  const [token, setToken] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  // 登录页在会话之外：SSR/首帧恒为默认中文（hydration 安全），
  // 挂载后读取本机语言或按浏览器/系统检测，并订阅切换广播。
  const [language, setLanguage] = useState<UiLanguage>("zh-CN");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydration-safe 首帧后同步本机语言
    setLanguage(readUiLanguage());
    return subscribeUiLanguage(() => setLanguage(readUiLanguage()));
  }, []);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ token, displayName }),
      });
      const payload = (await response.json()) as {
        ok: boolean;
        error?: { message?: string };
      };
      if (!response.ok || !payload.ok) {
        setError(payload.error?.message ?? "登录没有成功，请重试。");
        return;
      }
      const returnTo = new URLSearchParams(window.location.search).get("return_to");
      window.location.href = returnTo && returnTo.startsWith("/") ? returnTo : "/";
    } catch {
      setError(uiText("ui.login.error", language));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-screen">
      <div className="login-language-corner">
        <LanguageMenu uiLanguage={language} />
      </div>
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <span className="brand-seal" aria-hidden="true">界</span>
          <div>
            <p className="eyebrow">{uiText("ui.login.title", language)} / REALM</p>
            <h1>{uiText("ui.login.submit", language)}</h1>
          </div>
        </div>
        <p className="login-note">
          {uiText("ui.login.note", language)}
        </p>
        {error ? (
          <div className="settings-notice is-error" role="alert">{error}</div>
        ) : null}
        <label>
          {uiText("ui.login.token", language)}
          <input
            autoComplete="off"
            onChange={(event) => setToken(event.target.value)}
            required
            type="password"
            value={token}
          />
        </label>
        <label>
          {uiText("ui.login.name", language)}
          <input
            maxLength={40}
            onChange={(event) => setDisplayName(event.target.value)}
            required
            value={displayName}
          />
        </label>
        <button disabled={busy} type="submit">
          {busy ? uiText("ui.login.busy", language) : uiText("ui.login.submit", language)}
        </button>
      </form>
    </main>
  );
}
