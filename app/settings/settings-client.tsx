"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ThemeToggle } from "../components/theme-toggle.tsx";
import {
  UI_LANGUAGES,
  normalizeUiLanguage,
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

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const me = await fetch("/api/auth/me", {
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        if (me.ok) {
          // 本机 localStorage 为准（保存时已同步），服务端值仅作缺省。
          const stored = normalizeUiLanguage(
            window.localStorage.getItem("realm-ui-language"),
          );
          setUiLanguage(stored);
        }
        const response = await fetch("/api/settings/model-provider", {
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        const body: unknown = await response.json();
        const loaded = parseSettingsEnvelope(body);
        if (!response.ok || !loaded) throw new Error(readError(body, "无法读取模型设置。"));
        if (!active) return;
        setSettings(loaded);
        const activeProfile = loaded.providers.find(
          (profile) => profile.providerId === loaded.activeProviderId,
        );
        if (!activeProfile) throw new Error("活动供应商配置缺失。");
        setDraft(toDraft(activeProfile));
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : "无法读取模型设置。");
      }
    })();
    return () => { active = false; };
  }, []);

  async function saveLanguage(next: UiLanguage) {
    try {
      const response = await fetch("/api/settings/language", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ language: next }),
      });
      if (!response.ok) throw new Error("save failed");
      setUiLanguage(next);
      window.localStorage.setItem("realm-ui-language", next);
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
      if (!response.ok) throw new Error(readError(body, "模型设置操作失败。"));
      if (action === "test") {
        const result = parseTestEnvelope(body);
        if (!result) throw new Error("连接探针返回了无效结果。");
        setNotice(`连接正常 · ${result.model} · ${result.latencyMs} ms`);
      } else {
        const saved = parseSettingsEnvelope(body);
        if (!saved) throw new Error("模型设置响应无效。");
        setSettings(saved);
        const activeProfile = saved.providers.find(
          (profile) => profile.providerId === saved.activeProviderId,
        );
        if (!activeProfile) throw new Error("活动供应商配置缺失。");
        setDraft(toDraft(activeProfile));
        if (action === "discover") setModelPage(0);
        setNotice(action === "discover"
          ? `已发现 ${activeProfile.availableModels.length} 个可用模型，并保存本机配置。`
          : "模型设置已保存；下一回合开始使用新配置。",
        );
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "模型设置操作失败。");
    } finally {
      setOperation(null);
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
        <p className="eyebrow">模型设置 / Model settings</p>
        <h1>{error ? "设置入口暂时不可用" : "正在读取本机模型配置"}</h1>
        {error ? <p>{error}</p> : <div className="loading-rule"><span /></div>}
        <Link href="/">返回记录</Link>
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
        <h1>供应商配置缺失</h1>
        <p>本机模型配置没有可用的供应商 profile。</p>
        <Link href="/">返回记录</Link>
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
          <p className="eyebrow">系统设置 / System settings</p>
          <h1>模型供应商</h1>
        </div>
        <ThemeToggle uiLanguage={uiLanguage} className="settings-back" />
        <Link className="settings-back" href="/">← 返回记录</Link>
      </header>

      <main className="settings-layout">
        <aside className="settings-index" aria-label="设置目录">
          <p className="eyebrow">设置目录</p>
          <ol>
            <li className="is-current"><span>01</span><strong>模型服务</strong></li>
            <li><span>02</span><strong>记忆与召回</strong><small>首批就绪</small></li>
            <li><span>03</span><strong>语音与流式</strong><small>稍后</small></li>
            <li><span>04</span><strong>消息网关</strong><small>延期</small></li>
          </ol>
          <div className="local-boundary-note">
            <span aria-hidden="true">⌂</span>
            <p><strong>本机配置</strong>密钥不会返回浏览器，也不会写入 Git。</p>
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
              <p className="eyebrow">推理后端 / Inference backend</p>
              <h2>真实模型连接</h2>
              <p>模型负责 DM 规划、角色自主工具调用、旁白生成与最终复核。规则结果仍由本地 Core 裁决。</p>
            </div>
            {/* Provider secrets never leave the server-side settings boundary. */}
            <span className="provider-health is-ready">
              <i aria-hidden="true" />
              {providerEntryOf(draft.providerId).requiresApiKey
                ? (activeProfile.apiKeyConfigured
                  ? `${providerName(draft.providerId)} 已配置`
                  : `${providerName(draft.providerId)} 待配置密钥`)
                : (activeProfile.apiKeyConfigured
                  ? `${providerName(draft.providerId)} 已配置`
                  : `${providerName(draft.providerId)} · 无 key 可用`)}
            </span>
          </div>

          {notice ? <div className="settings-notice is-success" role="status">{notice}</div> : null}
          {error ? <div className="settings-notice is-error" role="alert">{error}</div> : null}

          <section className="settings-card">
            <header><span>01</span><div><h3>供应商与端点</h3><p>供应商 profile 会保存在本机；切换后保存，下一回合开始生效。</p></div></header>
            <div className="settings-form-grid">
              <label>
                <span>模型供应商</span>
                <select
                  value={draft.providerId}
                  onChange={(event) => selectProvider(event.target.value as ModelProviderId)}
                >
                  {settings.providers.map((profile) => (
                    <option key={profile.providerId} value={profile.providerId}>
                      {providerName(profile.providerId)}
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
                  ? `已配置 ${activeProfile.apiKeyHint ?? ""}`
                  : "尚未配置"}</small></span>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={draft.apiKey}
                  onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
                  placeholder={activeProfile.apiKeyConfigured
                    ? "留空以沿用本机密钥"
                    : "输入供应商 API key"}
                />
              </label>
            </div>
            <footer>
              <p>{providerDescription(draft.providerId)}</p>
              <button disabled={operation !== null} onClick={() => void run("discover")} type="button">
                {operation === "discover" ? "正在连接…" : "连接端点并发现模型"}
              </button>
            </footer>
          </section>

          <section className="settings-card">
            <header><span>02</span><div><h3>模型与推理方式</h3><p>选择下一回合实际调用的模型；OpenRouter 费率来自最近一次 Models API 响应。</p></div></header>
            <div className="model-list-toolbar">
              <label>
                <span>检索模型</span>
                <input
                  aria-label="检索模型"
                  placeholder="按名称、ID 或作者检索"
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
                {freeOnly ? "显示全部" : "仅看免费"}
              </button>
            </div>
            <div className="model-list" role="radiogroup" aria-label="可用模型">
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
                    <small>{modelRate(model)}</small>
                  </span>
                  <i>{modelBadges(model)}</i>
                </label>
              )) : (
                <div className="model-list-empty">
                  {filteredModels.length === 0
                    ? "没有匹配的模型。"
                    : "连接并发现模型后，这里会显示可用模型、当前费率与工具调用能力。"}
                </div>
              )}
            </div>
            <div className="model-list-pager" aria-label="模型分页">
              <button
                className="button-secondary"
                disabled={visibleModelPage === 0}
                onClick={() => setModelPage((page) => Math.max(0, page - 1))}
                type="button"
              >
                ← 上一页
              </button>
              <span>第 {visibleModelPage + 1} / {modelPageCount} 页 · 共 {filteredModels.length} 个</span>
              <button
                className="button-secondary"
                disabled={visibleModelPage >= modelPageCount - 1}
                onClick={() => setModelPage((page) => Math.min(modelPageCount - 1, page + 1))}
                type="button"
              >
                下一页 →
              </button>
            </div>
            <div className="settings-form-grid model-options">
              <label>
                <span>思考模式</span>
                <select
                  value={draft.thinking}
                  onChange={(event) => setDraft({
                    ...draft,
                    thinking: event.target.value as ModelThinkingMode,
                  })}
                >
                  <option value="disabled">关闭 · 更快、更利于缓存</option>
                  <option value="enabled">开启 · 更充分推理</option>
                </select>
              </label>
              <label>
                <span>请求超时</span>
                <select
                  value={String(draft.timeoutMs)}
                  onChange={(event) => setDraft({ ...draft, timeoutMs: Number(event.target.value) })}
                >
                  <option value="30000">30 秒</option>
                  <option value="60000">60 秒</option>
                  <option value="90000">90 秒</option>
                </select>
              </label>
              <label>
                <span>返回长度预算 <small>max_tokens</small></span>
                <select
                  value={String(draft.maxTokens)}
                  onChange={(event) => setDraft({ ...draft, maxTokens: Number(event.target.value) })}
                >
                  <option value="512">512 tokens · 省成本</option>
                  <option value="1024">1,024 tokens</option>
                  <option value="2048">2,048 tokens · 推荐</option>
                  <option value="4096">4,096 tokens</option>
                  <option value="8192">8,192 tokens</option>
                  <option value="16384">16,384 tokens</option>
                </select>
              </label>
            </div>
            <footer>
              <p>{activeProfile.lastDiscoveredAt
                ? `最近发现：${new Date(activeProfile.lastDiscoveredAt).toLocaleString("zh-CN")}`
                : "尚未进行在线模型发现。"}</p>
              <div className="settings-actions">
                <button className="button-secondary" disabled={operation !== null} onClick={() => void run("test")} type="button">
                  {operation === "test" ? "测试中…" : "测试所选模型"}
                </button>
                <button disabled={operation !== null} onClick={() => void run("save")} type="button">
                  {operation === "save" ? "保存中…" : "保存设置"}
                </button>
              </div>
            </footer>
          </section>

          <section className="settings-card settings-data-card">
            <header><span>03</span><div><h3>供应商数据边界</h3><p>生成需要上下文；系统在发送前先按时间与角色知识过滤。</p></div></header>
            <div className="settings-data-boundary">
              <section>
                <p className="eyebrow">会发送 / Required context</p>
                <ul>
                  <li>最小世界规则与当前场景</li>
                  <li>本轮玩家输入与被激活角色</li>
                  <li>该角色在当前时间点有权知道的记忆</li>
                  <li>本轮公开行动结果与角色私有观察</li>
                </ul>
              </section>
              <section>
                <p className="eyebrow">不会发送 / Protected data</p>
                <ul>
                  <li>API Key、数据库连接与本机路径</li>
                  <li>角色无权知道的密谋和隐藏事件</li>
                  <li>Context Manifest、过滤数量与诊断信息</li>
                  <li>源码、数据库快照与未提交候选事件</li>
                </ul>
              </section>
            </div>
            <footer>
              <p>{providerDataBoundaryNote(draft.providerId)}</p>
            </footer>
          </section>
        </section>
      </main>
    </div>
  );
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

function providerName(providerId: ModelProviderId): string {
  const names: Record<ModelProviderId, string> = {
    lmstudio: "LM Studio · 本地/局域网",
    openrouter: "OpenRouter · 云端路由",
    deepseek: "DeepSeek · 官方 API",
    "kimi-coding": "Kimi Coding · 官方 API",
    "custom-openai": "自定义 OpenAI 兼容端点",
  };
  return names[providerId] ?? providerEntryOf(providerId).name;
}

function providerDescription(providerId: ModelProviderId): string {
  const descriptions: Record<ModelProviderId, string> = {
    lmstudio:
      "LM Studio 默认 loopback 1234；可改为你自己的本机/LAN 地址（仅限私有地址段），本地服务可留空 API key。",
    openrouter:
      "OpenRouter 仅允许官方 HTTPS 端点；费率来自 Models API，免费状态按当前返回的 0 USD/token 标记。",
    deepseek:
      "DeepSeek 仅允许官方 HTTPS 端点（api.deepseek.com）；需要 API key；thinking 按官方兼容字段映射。",
    "kimi-coding":
      "Kimi Coding 仅允许官方 HTTPS 端点（api.kimi.com/coding/v1）；需要 API key；不支持的 tool_choice=required 会自动降级为 auto。",
    "custom-openai":
      "自定义 OpenAI 兼容端点：http 仅限本机/私有地址，远端必须 https 且建议配置 API key；仅承诺标准 chat completions/models 契约（本机受保护模式，未做 DNS 级解析防护）。",
  };
  return descriptions[providerId] ?? providerEntryOf(providerId).description;
}

function providerDataBoundaryNote(providerId: ModelProviderId): string {
  const entry = providerEntryOf(providerId);
  if (entry.endpointPolicy === "local") {
    return "当前模型服务运行在本机/局域网（LM Studio），上述最小必要内容不会离开你的本地网络。";
  }
  if (entry.endpointPolicy === "custom") {
    return "当前端点为自定义 OpenAI 兼容服务：请确认你信任该端点——上述最小必要上下文会发送到该地址。";
  }
  return `当前回合会把最小必要上下文发送到 ${entry.name}；模型与费率由上方 profile 决定。`;
}

function modelName(model: DiscoveredModel): string {
  return model.name || model.id;
}

function modelRate(model: DiscoveredModel): string {
  if (model.costClass === "free") return "当前免费 · 输入 $0 / 输出 $0 · 每 1M token";
  if (!model.pricing) return "费率未知";
  return `输入 ${formatUsdPerMillion(model.pricing.promptUsdPerToken)} / 输出 ${formatUsdPerMillion(model.pricing.completionUsdPerToken)} · 每 1M token`;
}

function formatUsdPerMillion(pricePerToken: number): string {
  const perMillion = pricePerToken * 1_000_000;
  if (perMillion === 0) return "$0";
  if (perMillion < 0.01) return `$${perMillion.toFixed(4)}`;
  if (perMillion < 1) return `$${perMillion.toFixed(2)}`;
  return `$${perMillion.toFixed(2)}`;
}

function modelBadges(model: DiscoveredModel): string {
  const badges: string[] = [];
  if (model.costClass === "free") badges.push("FREE");
  if (model.supportsTools === true) badges.push("TOOLS");
  if (model.supportsTools === false) badges.push("无 TOOLS");
  if (model.supportsStructuredOutputs === true) badges.push("JSON");
  if (model.supportsStructuredOutputs === false) badges.push("无 JSON");
  if (badges.length === 0 && model.id.includes("flash")) badges.push("低延迟");
  return badges.join(" · ") || "能力未标注";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
