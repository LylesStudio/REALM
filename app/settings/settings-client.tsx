"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { LanguageMenu } from "../components/language-menu.tsx";
import { ThemeToggle } from "../components/theme-toggle.tsx";
import {
  UI_LANGUAGES,
  uiText,
  type UiLanguage,
} from "../../modules/i18n/public.ts";
import {
  MODEL_PROVIDER_CATALOG,
  type DiscoveredModel,
  type ModelProviderId,
  type ModelThinkingMode,
  type PublicModelProviderSettings,
  type PublicModelSettingsSnapshot,
} from "../../modules/inference/types.ts";
import {
  readUiLanguage,
  subscribeUiLanguage,
  writeUiLanguage,
} from "../ui-language.ts";

type SettingsState = {
  providerId: ModelProviderId;
  baseUrl: string;
  apiKey: string;
  selectedModel: string;
  thinking: ModelThinkingMode;
  timeoutMs: number;
  maxTokens: number;
};

type Operation = "save" | "discover" | "test" | null;
const MODEL_PAGE_SIZE = 20;

type ComfyDraft = {
  enabled: boolean;
  baseUrl: string;
  requestTimeoutMs: number;
  workflowId: string;
  apiKey: string;
};

type ComfySnapshot = Omit<ComfyDraft, "apiKey"> & { apiKeyConfigured: boolean };

export function ModelSettingsClient() {
  const [settings, setSettings] = useState<PublicModelSettingsSnapshot | null>(null);
  const [draft, setDraft] = useState<SettingsState | null>(null);
  const [operation, setOperation] = useState<Operation>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uiLanguage, setUiLanguage] = useState<UiLanguage>("zh-CN");
  const [modelQuery, setModelQuery] = useState("");
  const [freeOnly, setFreeOnly] = useState(false);
  const [modelPage, setModelPage] = useState(0);
  const [comfy, setComfy] = useState<ComfyDraft | null>(null);
  const [comfySnapshot, setComfySnapshot] = useState<ComfySnapshot | null>(null);
  const [comfyBusy, setComfyBusy] = useState<"save" | "test" | null>(null);
  const [comfyNotice, setComfyNotice] = useState<string | null>(null);
  const [comfyError, setComfyError] = useState<string | null>(null);
  const [passwordCurrent, setPasswordCurrent] = useState("");
  const [passwordNext, setPasswordNext] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  useEffect(() => subscribeUiLanguage(() => setUiLanguage(readUiLanguage())), []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        // 本机语言为准（保存时已同步服务端）；首访自动检测在 readUiLanguage 内。
        setUiLanguage(readUiLanguage());
        const response = await fetch("/api/settings/model-provider", {
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        const body: unknown = await response.json();
        const loaded = parseSettingsEnvelope(body);
        if (!response.ok || !loaded) throw new Error(readError(body, uiText("ui.settings.errLoad", readUiLanguage())));
        if (!active) return;
        setSettings(loaded);
        const activeProfile = loaded.providers.find(
          (profile) => profile.providerId === loaded.activeProviderId,
        );
        if (!activeProfile) throw new Error(uiText("ui.settings.errMissingProfile", readUiLanguage()));
        setDraft(toDraft(activeProfile));
        // ComfyUI 图像生成卡：独立加载，失败只影响该卡（模型设置照常）。
        void (async () => {
          try {
            const comfyResponse = await fetch("/api/settings/comfyui", {
              cache: "no-store",
              headers: { Accept: "application/json" },
            });
            const comfyBody: unknown = await comfyResponse.json();
            const loaded = parseComfyEnvelope(comfyBody);
            if (!comfyResponse.ok || !loaded) throw new Error("load failed");
            if (!active) return;
            setComfySnapshot(loaded);
            setComfy({ ...loaded, apiKey: "" });
          } catch {
            if (active) setComfyError(uiText("ui.comfyui.errLoad", readUiLanguage()));
          }
        })();
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : uiText("ui.settings.errLoad", readUiLanguage()));
      }
    })();
    return () => { active = false; };
  }, []);

  async function saveLanguage(next: UiLanguage) {
    try {
      writeUiLanguage(next);
      const response = await fetch("/api/settings/language", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ language: next }),
      });
      if (!response.ok) throw new Error("save failed");
      setUiLanguage(next);
      setNotice(uiText("ui.settings.languageSaved", next));
    } catch {
      setError(uiText("ui.settings.languageFailed", uiLanguage));
    }
  }

  async function run(action: Exclude<Operation, null>) {
    if (!draft || operation) return;
    setOperation(action);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/settings/model-provider", {
        method: action === "save" ? "PUT" : "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(action === "save" ? {} : { action }),
          ...draft,
        }),
      });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(readError(body, uiText("ui.settings.errOperation", uiLanguage)));
      if (action === "test") {
        const result = parseTestEnvelope(body);
        if (!result) throw new Error(uiText("ui.settings.errInvalidProbe", uiLanguage));
        setNotice(uiText("ui.settings.testOk", uiLanguage, {
          model: result.model,
          ms: String(result.latencyMs),
        }));
      } else {
        const saved = parseSettingsEnvelope(body);
        if (!saved) throw new Error(uiText("ui.settings.errInvalidResponse", uiLanguage));
        setSettings(saved);
        const activeProfile = saved.providers.find(
          (profile) => profile.providerId === saved.activeProviderId,
        );
        if (!activeProfile) throw new Error(uiText("ui.settings.errMissingProfile", uiLanguage));
        setDraft(toDraft(activeProfile));
        if (action === "discover") setModelPage(0);
        setNotice(action === "discover"
          ? uiText("ui.settings.discoverOk", uiLanguage, {
            count: String(activeProfile.availableModels.length),
          })
          : uiText("ui.settings.saveOk", uiLanguage),
        );
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : uiText("ui.settings.errOperation", uiLanguage));
    } finally {
      setOperation(null);
    }
  }

  async function runComfy(action: "save" | "test") {
    if (!comfy || comfyBusy) return;
    setComfyBusy(action);
    setComfyNotice(null);
    setComfyError(null);
    try {
      const response = await fetch("/api/settings/comfyui", {
        method: action === "save" ? "PUT" : "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(action === "test" ? { action: "test" } : {}),
          enabled: comfy.enabled,
          baseUrl: comfy.baseUrl,
          requestTimeoutMs: comfy.requestTimeoutMs,
          workflowId: comfy.workflowId,
          apiKey: comfy.apiKey,
        }),
      });
      const body: unknown = await response.json();
      if (action === "test") {
        if (!response.ok) throw new Error(readError(body, uiText("ui.comfyui.errTest", uiLanguage)));
        setComfyNotice(uiText("ui.comfyui.testOk", uiLanguage));
      } else {
        if (!response.ok) throw new Error(readError(body, uiText("ui.comfyui.errSave", uiLanguage)));
        const saved = parseComfyEnvelope(body);
        if (!saved) throw new Error(uiText("ui.comfyui.errInvalidResponse", uiLanguage));
        setComfySnapshot(saved);
        setComfy({ ...saved, apiKey: "" });
        setComfyNotice(uiText("ui.comfyui.saveOk", uiLanguage));
      }
    } catch (caught) {
      setComfyError(caught instanceof Error ? caught.message : uiText("ui.comfyui.errSave", uiLanguage));
    } finally {
      setComfyBusy(null);
    }
  }

  /** 账户密码设置/清除（当前会话 principal；清除需明确动作）。 */
  async function savePassword(clear: boolean) {
    if (passwordBusy) return;
    setPasswordBusy(true);
    setPasswordNotice(null);
    setPasswordError(null);
    try {
      const response = await fetch("/api/auth/password", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: passwordCurrent,
          newPassword: clear ? "" : passwordNext,
          confirmClear: clear,
        }),
      });
      if (!response.ok) throw new Error("password failed");
      setPasswordNotice(uiText(clear ? "ui.password.clearOk" : "ui.password.saveOk", uiLanguage));
      setPasswordCurrent("");
      setPasswordNext("");
    } catch {
      setPasswordError(uiText("ui.password.failed", uiLanguage));
    } finally {
      setPasswordBusy(false);
    }
  }

  function selectProvider(providerId: ModelProviderId) {
    if (!settings) return;
    const profile = settings.providers.find((item) => item.providerId === providerId);
    if (!profile) return;
    setDraft(toDraft(profile));
    setNotice(null);
    setError(null);
    setModelQuery("");
    setFreeOnly(false);
    setModelPage(0);
  }

  if (!draft || !settings) {
    return (
      <main className="settings-state" aria-busy={!error}>
        <div className="state-mark" aria-hidden="true">设</div>
        <p className="eyebrow">{uiText("ui.settings.loadingEyebrow", uiLanguage)}</p>
        <h1>{error ? uiText("ui.settings.errorTitle", uiLanguage) : uiText("ui.settings.loadingTitle", uiLanguage)}</h1>
        {error ? <p>{error}</p> : <div className="loading-rule"><span /></div>}
        <Link href="/">{uiText("ui.settings.back", uiLanguage)}</Link>
      </main>
    );
  }

  const activeProfile = settings.providers.find(
    (profile) => profile.providerId === draft.providerId,
  );
  if (!activeProfile) {
    return (
      <main className="settings-state">
        <div className="state-mark" aria-hidden="true">设</div>
        <h1>{uiText("ui.settings.missingProviderTitle", uiLanguage)}</h1>
        <p>{uiText("ui.settings.missingProviderBody", uiLanguage)}</p>
        <Link href="/">{uiText("ui.settings.back", uiLanguage)}</Link>
      </main>
    );
  }

  const query = modelQuery.trim().toLocaleLowerCase();
  const filteredModels = activeProfile.availableModels.filter((model) => {
    if (freeOnly && model.costClass !== "free") return false;
    if (!query) return true;
    return `${model.name} ${model.id} ${model.ownedBy}`.toLocaleLowerCase().includes(query);
  });
  const modelPageCount = Math.max(1, Math.ceil(filteredModels.length / MODEL_PAGE_SIZE));
  const visibleModelPage = Math.min(modelPage, modelPageCount - 1);
  const visibleModels = filteredModels.slice(
    visibleModelPage * MODEL_PAGE_SIZE,
    (visibleModelPage + 1) * MODEL_PAGE_SIZE,
  );

  return (
    <div className="settings-shell">
      <header className="settings-header">
        <Link className="settings-brand" href="/">
          <span aria-hidden="true">界</span>
          <strong>界核</strong>
          <small>REALM</small>
        </Link>
        <div>
          <p className="eyebrow">{uiText("ui.settings.systemEyebrow", uiLanguage)}</p>
          <h1>{uiText("ui.settings.providerHeading", uiLanguage)}</h1>
        </div>
        <ThemeToggle uiLanguage={uiLanguage} className="settings-back" />
        <LanguageMenu uiLanguage={uiLanguage} className="settings-back" />
        <Link className="settings-back" href="/">{uiText("ui.settings.backArrow", uiLanguage)}</Link>
      </header>

      <main className="settings-layout">
        <aside className="settings-index" aria-label={uiText("ui.settings.toc", uiLanguage)}>
          <p className="eyebrow">{uiText("ui.settings.toc", uiLanguage)}</p>
          <ol>
            <li className="is-current"><span>01</span><strong>{uiText("ui.settings.navModel", uiLanguage)}</strong></li>
            <li><span>02</span><strong>{uiText("ui.settings.navMemory", uiLanguage)}</strong><small>{uiText("ui.settings.navMemoryNote", uiLanguage)}</small></li>
            <li><span>03</span><strong>{uiText("ui.settings.navVoice", uiLanguage)}</strong><small>{uiText("ui.settings.navVoiceNote", uiLanguage)}</small></li>
            <li><span>04</span><strong>{uiText("ui.settings.navGateway", uiLanguage)}</strong><small>{uiText("ui.settings.navGatewayNote", uiLanguage)}</small></li>
          </ol>
          <div className="local-boundary-note">
            <span aria-hidden="true">⌂</span>
            <p><strong>{uiText("ui.settings.localNoteTitle", uiLanguage)}</strong>{uiText("ui.settings.localNoteBody", uiLanguage)}</p>
          </div>
        </aside>

        <section className="settings-content">
          <div className="settings-language" aria-label={uiText("ui.settings.language", uiLanguage)}>
            <div>
              <p className="eyebrow">{uiText("ui.settings.language", uiLanguage)}</p>
              <p className="settings-language-hint">
                {uiText("ui.settings.languageHint", uiLanguage)}
              </p>
            </div>
            <div className="library-style-picker">
              {UI_LANGUAGES.map((language) => (
                <button
                  aria-pressed={uiLanguage === language}
                  className={uiLanguage === language ? "is-active" : ""}
                  key={language}
                  onClick={() => void saveLanguage(language)}
                  type="button"
                >
                  {language === "zh-CN" ? "中文" : language === "en" ? "English" : "日本語"}
                </button>
              ))}
            </div>
          </div>
          <div className="settings-intro">
            <div>
              <p className="eyebrow">{uiText("ui.settings.introEyebrow", uiLanguage)}</p>
              <h2>{uiText("ui.settings.introTitle", uiLanguage)}</h2>
              <p>{uiText("ui.settings.introBody", uiLanguage)}</p>
            </div>
            {/* Provider secrets never leave the server-side settings boundary. */}
            <span className="provider-health is-ready">
              <i aria-hidden="true" />
              {providerEntryOf(draft.providerId).requiresApiKey
                ? (activeProfile.apiKeyConfigured
                  ? uiText("ui.settings.healthConfigured", uiLanguage, { provider: providerName(draft.providerId, uiLanguage) })
                  : uiText("ui.settings.healthNeedsKey", uiLanguage, { provider: providerName(draft.providerId, uiLanguage) }))
                : (activeProfile.apiKeyConfigured
                  ? uiText("ui.settings.healthConfigured", uiLanguage, { provider: providerName(draft.providerId, uiLanguage) })
                  : uiText("ui.settings.healthNoKey", uiLanguage, { provider: providerName(draft.providerId, uiLanguage) }))}
            </span>
          </div>

          {notice ? <div className="settings-notice is-success" role="status">{notice}</div> : null}
          {error ? <div className="settings-notice is-error" role="alert">{error}</div> : null}

          <section className="settings-card">
            <header><span>01</span><div><h3>{uiText("ui.settings.cardProviderTitle", uiLanguage)}</h3><p>{uiText("ui.settings.cardProviderBody", uiLanguage)}</p></div></header>
            <div className="settings-form-grid">
              <label>
                <span>{uiText("ui.settings.fieldProvider", uiLanguage)}</span>
                <select
                  value={draft.providerId}
                  onChange={(event) => selectProvider(event.target.value as ModelProviderId)}
                >
                  {settings.providers.map((profile) => (
                    <option key={profile.providerId} value={profile.providerId}>
                      {providerName(profile.providerId, uiLanguage)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>API Base URL</span>
                <input
                  value={draft.baseUrl}
                  onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
                  spellCheck={false}
                />
              </label>
              <label className="settings-field-wide">
                <span>API Key <small>{activeProfile.apiKeyConfigured
                  ? uiText("ui.settings.apiKeyConfigured", uiLanguage, { hint: activeProfile.apiKeyHint ?? "" })
                  : uiText("ui.settings.apiKeyMissing", uiLanguage)}</small></span>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={draft.apiKey}
                  onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
                  placeholder={activeProfile.apiKeyConfigured
                    ? uiText("ui.settings.apiKeyKeepPlaceholder", uiLanguage)
                    : uiText("ui.settings.apiKeyEnterPlaceholder", uiLanguage)}
                />
              </label>
            </div>
            <footer>
              <p>{providerDescription(draft.providerId, uiLanguage)}</p>
              <button disabled={operation !== null} onClick={() => void run("discover")} type="button">
                {operation === "discover" ? uiText("ui.settings.discoverBusy", uiLanguage) : uiText("ui.settings.discoverAction", uiLanguage)}
              </button>
            </footer>
          </section>

          <section className="settings-card">
            <header><span>02</span><div><h3>{uiText("ui.settings.cardModelTitle", uiLanguage)}</h3><p>{uiText("ui.settings.cardModelBody", uiLanguage)}</p></div></header>
            <div className="model-list-toolbar">
              <label>
                <span>{uiText("ui.settings.searchLabel", uiLanguage)}</span>
                <input
                  aria-label={uiText("ui.settings.searchLabel", uiLanguage)}
                  placeholder={uiText("ui.settings.searchPlaceholder", uiLanguage)}
                  value={modelQuery}
                  onChange={(event) => {
                    setModelQuery(event.target.value);
                    setModelPage(0);
                  }}
                  spellCheck={false}
                />
              </label>
              <button
                className={freeOnly ? "is-filter-active" : "button-secondary"}
                onClick={() => {
                  setFreeOnly((value) => !value);
                  setModelPage(0);
                }}
                type="button"
              >
                {freeOnly ? uiText("ui.settings.showAll", uiLanguage) : uiText("ui.settings.freeOnly", uiLanguage)}
              </button>
            </div>
            <div className="model-list" role="radiogroup" aria-label={uiText("ui.settings.modelListAria", uiLanguage)}>
              {visibleModels.length > 0 ? visibleModels.map((model) => (
                <label className={draft.selectedModel === model.id ? "is-selected" : ""} key={model.id}>
                  <input
                    type="radio"
                    name="selected-model"
                    value={model.id}
                    checked={draft.selectedModel === model.id}
                    onChange={() => setDraft({ ...draft, selectedModel: model.id })}
                  />
                  <span>
                    <strong>{modelName(model)}</strong>
                    <small>{model.id}</small>
                    <small>{modelRate(model, uiLanguage)}</small>
                  </span>
                  <i>{modelBadges(model, uiLanguage)}</i>
                </label>
              )) : (
                <div className="model-list-empty">
                  {filteredModels.length === 0
                    ? uiText("ui.settings.noMatch", uiLanguage)
                    : uiText("ui.settings.emptyList", uiLanguage)}
                </div>
              )}
            </div>
            <div className="model-list-pager" aria-label={uiText("ui.settings.pagerAria", uiLanguage)}>
              <button
                className="button-secondary"
                disabled={visibleModelPage === 0}
                onClick={() => setModelPage((page) => Math.max(0, page - 1))}
                type="button"
              >
                {uiText("ui.settings.prevPage", uiLanguage)}
              </button>
              <span>{uiText("ui.settings.pagerInfo", uiLanguage, {
                page: String(visibleModelPage + 1),
                total: String(modelPageCount),
                count: String(filteredModels.length),
              })}</span>
              <button
                className="button-secondary"
                disabled={visibleModelPage >= modelPageCount - 1}
                onClick={() => setModelPage((page) => Math.min(modelPageCount - 1, page + 1))}
                type="button"
              >
                {uiText("ui.settings.nextPage", uiLanguage)}
              </button>
            </div>
            <div className="settings-form-grid model-options">
              <label>
                <span>{uiText("ui.settings.thinkingLabel", uiLanguage)}</span>
                <select
                  value={draft.thinking}
                  onChange={(event) => setDraft({
                    ...draft,
                    thinking: event.target.value as ModelThinkingMode,
                  })}
                >
                  <option value="disabled">{uiText("ui.settings.thinkingOff", uiLanguage)}</option>
                  <option value="enabled">{uiText("ui.settings.thinkingOn", uiLanguage)}</option>
                </select>
              </label>
              <label>
                <span>{uiText("ui.settings.timeoutLabel", uiLanguage)}</span>
                <select
                  value={String(draft.timeoutMs)}
                  onChange={(event) => setDraft({ ...draft, timeoutMs: Number(event.target.value) })}
                >
                  <option value="30000">{uiText("ui.settings.timeoutSeconds", uiLanguage, { seconds: "30" })}</option>
                  <option value="60000">{uiText("ui.settings.timeoutSeconds", uiLanguage, { seconds: "60" })}</option>
                  <option value="90000">{uiText("ui.settings.timeoutSeconds", uiLanguage, { seconds: "90" })}</option>
                </select>
              </label>
              <label>
                <span>{uiText("ui.settings.maxTokensLabel", uiLanguage)} <small>max_tokens</small></span>
                <select
                  value={String(draft.maxTokens)}
                  onChange={(event) => setDraft({ ...draft, maxTokens: Number(event.target.value) })}
                >
                  <option value="512">{uiText("ui.settings.tokensBudget", uiLanguage, { tokens: "512" })}</option>
                  <option value="1024">{uiText("ui.settings.tokensPlain", uiLanguage, { tokens: "1,024" })}</option>
                  <option value="2048">{uiText("ui.settings.tokensRecommended", uiLanguage, { tokens: "2,048" })}</option>
                  <option value="4096">{uiText("ui.settings.tokensPlain", uiLanguage, { tokens: "4,096" })}</option>
                  <option value="8192">{uiText("ui.settings.tokensPlain", uiLanguage, { tokens: "8,192" })}</option>
                  <option value="16384">{uiText("ui.settings.tokensPlain", uiLanguage, { tokens: "16,384" })}</option>
                </select>
              </label>
            </div>
            <footer>
              <p>{activeProfile.lastDiscoveredAt
                ? uiText("ui.settings.lastDiscovered", uiLanguage, {
                  time: new Date(activeProfile.lastDiscoveredAt).toLocaleString("zh-CN"),
                })
                : uiText("ui.settings.neverDiscovered", uiLanguage)}</p>
              <div className="settings-actions">
                <button className="button-secondary" disabled={operation !== null} onClick={() => void run("test")} type="button">
                  {operation === "test" ? uiText("ui.settings.testBusy", uiLanguage) : uiText("ui.settings.testAction", uiLanguage)}
                </button>
                <button disabled={operation !== null} onClick={() => void run("save")} type="button">
                  {operation === "save" ? uiText("ui.settings.saveBusy", uiLanguage) : uiText("ui.settings.saveAction", uiLanguage)}
                </button>
              </div>
            </footer>
          </section>

          <section className="settings-card" data-testid="comfyui-card">
            <header><span>03</span><div><h3>{uiText("ui.comfyui.cardTitle", uiLanguage)}</h3><p>{uiText("ui.comfyui.cardBody", uiLanguage)}</p></div></header>
            {comfy ? (
              <>
                {comfyNotice ? <div className="settings-notice is-success" role="status">{comfyNotice}</div> : null}
                {comfyError ? <div className="settings-notice is-error" role="alert">{comfyError}</div> : null}
                <div className="settings-form-grid">
                  <label>
                    <span>{uiText("ui.comfyui.fieldEnabled", uiLanguage)}</span>
                    <button
                      aria-pressed={comfy.enabled}
                      className={comfy.enabled ? "is-filter-active" : "button-secondary"}
                      onClick={() => setComfy({ ...comfy, enabled: !comfy.enabled })}
                      type="button"
                    >
                      {comfy.enabled
                        ? uiText("ui.comfyui.enabledOn", uiLanguage)
                        : uiText("ui.comfyui.enabledOff", uiLanguage)}
                    </button>
                  </label>
                  <label>
                    <span>ComfyUI Base URL</span>
                    <input
                      value={comfy.baseUrl}
                      onChange={(event) => setComfy({ ...comfy, baseUrl: event.target.value })}
                      spellCheck={false}
                    />
                  </label>
                  <label>
                    <span>{uiText("ui.comfyui.fieldTimeout", uiLanguage)}</span>
                    <select
                      value={String(comfy.requestTimeoutMs)}
                      onChange={(event) => setComfy({ ...comfy, requestTimeoutMs: Number(event.target.value) })}
                    >
                      <option value="10000">10s</option>
                      <option value="30000">30s</option>
                      <option value="60000">60s</option>
                      <option value="120000">120s</option>
                    </select>
                  </label>
                  <label className="settings-field-wide">
                    <span>API Key <small>{comfySnapshot?.apiKeyConfigured
                      ? uiText("ui.comfyui.apiKeyConfigured", uiLanguage)
                      : uiText("ui.comfyui.apiKeyMissing", uiLanguage)}</small></span>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={comfy.apiKey}
                      onChange={(event) => setComfy({ ...comfy, apiKey: event.target.value })}
                      placeholder={comfySnapshot?.apiKeyConfigured
                        ? uiText("ui.comfyui.apiKeyKeepPlaceholder", uiLanguage)
                        : uiText("ui.comfyui.apiKeyEnterPlaceholder", uiLanguage)}
                    />
                  </label>
                </div>
                <footer>
                  <p>{uiText("ui.comfyui.cardNote", uiLanguage)}</p>
                  <div className="settings-actions">
                    <button className="button-secondary" disabled={comfyBusy !== null} onClick={() => void runComfy("test")} type="button">
                      {comfyBusy === "test" ? uiText("ui.comfyui.testBusy", uiLanguage) : uiText("ui.comfyui.testAction", uiLanguage)}
                    </button>
                    <button disabled={comfyBusy !== null} onClick={() => void runComfy("save")} type="button">
                      {comfyBusy === "save" ? uiText("ui.comfyui.saveBusy", uiLanguage) : uiText("ui.comfyui.saveAction", uiLanguage)}
                    </button>
                  </div>
                </footer>
              </>
            ) : (
              <p role="status">{comfyError ?? uiText("ui.comfyui.loading", uiLanguage)}</p>
            )}
          </section>

          <section className="settings-card" data-testid="password-card">
            <header><span>04</span><div><h3>{uiText("ui.password.cardTitle", uiLanguage)}</h3><p>{uiText("ui.password.cardBody", uiLanguage)}</p></div></header>
            <div className="settings-form-grid">
              <label>
                <span>{uiText("ui.password.current", uiLanguage)}</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={passwordCurrent}
                  onChange={(event) => setPasswordCurrent(event.target.value)}
                />
              </label>
              <label>
                <span>{uiText("ui.password.new", uiLanguage)}</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  maxLength={128}
                  value={passwordNext}
                  onChange={(event) => setPasswordNext(event.target.value)}
                />
              </label>
            </div>
            {passwordNotice ? <div className="settings-notice is-success" role="status">{passwordNotice}</div> : null}
            {passwordError ? <div className="settings-notice is-error" role="alert">{passwordError}</div> : null}
            <footer>
              <div className="settings-actions">
                <button
                  className="button-secondary"
                  disabled={passwordBusy}
                  onClick={() => void savePassword(true)}
                  type="button"
                >
                  {uiText("ui.password.clear", uiLanguage)}
                </button>
                <button
                  disabled={passwordBusy}
                  onClick={() => void savePassword(false)}
                  type="button"
                >
                  {passwordBusy ? uiText("ui.password.saveBusy", uiLanguage) : uiText("ui.password.saveAction", uiLanguage)}
                </button>
              </div>
            </footer>
          </section>

          <section className="settings-card settings-data-card">
            <header><span>05</span><div><h3>{uiText("ui.settings.cardBoundaryTitle", uiLanguage)}</h3><p>{uiText("ui.settings.cardBoundaryBody", uiLanguage)}</p></div></header>
            <div className="settings-data-boundary">
              <section>
                <p className="eyebrow">{uiText("ui.settings.boundarySend", uiLanguage)}</p>
                <ul>
                  <li>{uiText("ui.settings.boundarySendItem1", uiLanguage)}</li>
                  <li>{uiText("ui.settings.boundarySendItem2", uiLanguage)}</li>
                  <li>{uiText("ui.settings.boundarySendItem3", uiLanguage)}</li>
                  <li>{uiText("ui.settings.boundarySendItem4", uiLanguage)}</li>
                </ul>
              </section>
              <section>
                <p className="eyebrow">{uiText("ui.settings.boundaryKeep", uiLanguage)}</p>
                <ul>
                  <li>{uiText("ui.settings.boundaryKeepItem1", uiLanguage)}</li>
                  <li>{uiText("ui.settings.boundaryKeepItem2", uiLanguage)}</li>
                  <li>{uiText("ui.settings.boundaryKeepItem3", uiLanguage)}</li>
                  <li>{uiText("ui.settings.boundaryKeepItem4", uiLanguage)}</li>
                </ul>
              </section>
            </div>
            <footer>
              <p>{providerDataBoundaryNote(draft.providerId, uiLanguage)}</p>
            </footer>
          </section>
        </section>
      </main>
    </div>
  );
}

function parseComfyEnvelope(value: unknown): ComfySnapshot | null {
  if (!isObject(value) || value.ok !== true || !isObject(value.settings)) return null;
  const settings = value.settings;
  if (
    typeof settings.enabled !== "boolean"
    || typeof settings.baseUrl !== "string"
    || typeof settings.requestTimeoutMs !== "number"
    || typeof settings.workflowId !== "string"
    || typeof settings.apiKeyConfigured !== "boolean"
  ) return null;
  return {
    enabled: settings.enabled,
    baseUrl: settings.baseUrl,
    requestTimeoutMs: settings.requestTimeoutMs,
    workflowId: settings.workflowId,
    apiKeyConfigured: settings.apiKeyConfigured,
  };
}

function toDraft(settings: PublicModelProviderSettings): SettingsState {
  return {
    providerId: settings.providerId,
    baseUrl: settings.baseUrl,
    apiKey: "",
    selectedModel: settings.selectedModel,
    thinking: settings.thinking,
    timeoutMs: settings.timeoutMs,
    maxTokens: settings.maxTokens,
  };
}

function parseSettingsEnvelope(value: unknown): PublicModelSettingsSnapshot | null {
  if (!isObject(value) || value.ok !== true || !isObject(value.settings)) return null;
  const settings = value.settings;
  if (
    settings.schemaVersion !== 2
    || !isProviderId(settings.activeProviderId)
    || !Array.isArray(settings.providers)
    || typeof settings.updatedAt !== "string"
  ) return null;
  const providers = settings.providers.filter(isPublicProviderSettings);
  return providers.length === settings.providers.length
    ? settings as PublicModelSettingsSnapshot
    : null;
}

function isPublicProviderSettings(value: unknown): value is PublicModelProviderSettings {
  if (!isObject(value) || !isProviderId(value.providerId)) return false;
  return typeof value.baseUrl === "string"
    && typeof value.selectedModel === "string"
    && (value.thinking === "enabled" || value.thinking === "disabled")
    && typeof value.timeoutMs === "number"
    && typeof value.maxTokens === "number"
    && typeof value.apiKeyConfigured === "boolean"
    && (value.apiKeyHint === null || typeof value.apiKeyHint === "string")
    && Array.isArray(value.availableModels);
}

function isProviderId(value: unknown): value is ModelProviderId {
  return MODEL_PROVIDER_CATALOG.some((provider) => provider.id === value);
}

function parseTestEnvelope(value: unknown): { model: string; latencyMs: number } | null {
  if (!isObject(value) || value.ok !== true || !isObject(value.result)) return null;
  return typeof value.result.model === "string" && typeof value.result.latencyMs === "number"
    ? { model: value.result.model, latencyMs: value.result.latencyMs }
    : null;
}

function readError(value: unknown, fallback: string): string {
  return isObject(value) && isObject(value.error) && typeof value.error.message === "string"
    ? value.error.message
    : fallback;
}

function providerEntryOf(providerId: ModelProviderId) {
  return MODEL_PROVIDER_CATALOG.find((provider) => provider.id === providerId)
    ?? MODEL_PROVIDER_CATALOG[0];
}

function providerName(providerId: ModelProviderId, language: UiLanguage): string {
  const names: Record<ModelProviderId, string> = {
    lmstudio: uiText("ui.settings.providerName.lmstudio", language),
    openrouter: uiText("ui.settings.providerName.openrouter", language),
    deepseek: uiText("ui.settings.providerName.deepseek", language),
    "kimi-coding": uiText("ui.settings.providerName.kimiCoding", language),
    "custom-openai": uiText("ui.settings.providerName.customOpenai", language),
  };
  return names[providerId] ?? providerEntryOf(providerId).name;
}

function providerDescription(providerId: ModelProviderId, language: UiLanguage): string {
  const descriptions: Record<ModelProviderId, string> = {
    lmstudio: uiText("ui.settings.providerDesc.lmstudio", language),
    openrouter: uiText("ui.settings.providerDesc.openrouter", language),
    deepseek: uiText("ui.settings.providerDesc.deepseek", language),
    "kimi-coding": uiText("ui.settings.providerDesc.kimiCoding", language),
    "custom-openai": uiText("ui.settings.providerDesc.customOpenai", language),
  };
  return descriptions[providerId] ?? providerEntryOf(providerId).description;
}

function providerDataBoundaryNote(providerId: ModelProviderId, language: UiLanguage): string {
  const entry = providerEntryOf(providerId);
  if (entry.endpointPolicy === "local") {
    return uiText("ui.settings.boundaryNote.local", language);
  }
  if (entry.endpointPolicy === "custom") {
    return uiText("ui.settings.boundaryNote.custom", language);
  }
  return uiText("ui.settings.boundaryNote.remote", language, { name: entry.name });
}

function modelName(model: DiscoveredModel): string {
  return model.name || model.id;
}

function modelRate(model: DiscoveredModel, language: UiLanguage): string {
  if (model.costClass === "free") return uiText("ui.settings.rate.free", language);
  if (!model.pricing) return uiText("ui.settings.rate.unknown", language);
  return uiText("ui.settings.rate.priced", language, {
    input: formatUsdPerMillion(model.pricing.promptUsdPerToken),
    output: formatUsdPerMillion(model.pricing.completionUsdPerToken),
  });
}

function formatUsdPerMillion(pricePerToken: number): string {
  const perMillion = pricePerToken * 1_000_000;
  if (perMillion === 0) return "$0";
  if (perMillion < 0.01) return `$${perMillion.toFixed(4)}`;
  if (perMillion < 1) return `$${perMillion.toFixed(2)}`;
  return `$${perMillion.toFixed(2)}`;
}

function modelBadges(model: DiscoveredModel, language: UiLanguage): string {
  const badges: string[] = [];
  if (model.costClass === "free") badges.push("FREE");
  if (model.supportsTools === true) badges.push("TOOLS");
  if (model.supportsTools === false) badges.push(uiText("ui.settings.badge.noTools", language));
  if (model.supportsStructuredOutputs === true) badges.push("JSON");
  if (model.supportsStructuredOutputs === false) badges.push(uiText("ui.settings.badge.noJson", language));
  if (badges.length === 0 && model.id.includes("flash")) badges.push(uiText("ui.settings.badge.lowLatency", language));
  return badges.join(" · ") || uiText("ui.settings.badge.unlabeled", language);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
