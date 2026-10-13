import { useState, useEffect } from "react";
import Link from "next/link";
import { uiText, type UiLanguage } from "../../modules/i18n/public.ts";
import type { LibraryRecord, LibrarySnapshot, LibraryWorld } from "./library-types";
import { listPresetWorlds, type PresetWorld } from "../../modules/application/preset-worlds.ts";
import {
  MODEL_PROVIDER_CATALOG,
  type ModelProviderId,
  type PublicModelSettingsSnapshot,
} from "../../modules/inference/types.ts";

export interface WorldOnboardingProps {
  uiLanguage: UiLanguage;
  /** 世界库快照：非空时列出「继续上次 / 进入已有世界」。 */
  library: LibrarySnapshot;
  /** 主入口：AI 助手对话（LLM 引导创世）。 */
  onOpenChat: () => void;
  /** 次入口：分步引导·逐项填写。 */
  onOpenGuided: () => void;
  /** LAN 大厅入口（加入同一主机上别人开放的房间）。 */
  onOpenLobby: () => void;
  /** 打开指定记录（已有世界入口）。 */
  onOpenRecord: (recordId: string) => void;
  /** 批次 U：从预设世界模板一键创建并进入。 */
  onCreatePreset: (presetKey: string) => Promise<boolean>;
}

interface WorldEntry {
  world: LibraryWorld;
  /** 该世界最近创建的记录（库快照按 created_at ASC，取最后一个）。 */
  latestRecord: LibraryRecord | null;
}

function latestRecordOf(world: LibraryWorld): LibraryRecord | null {
  const records = world.stories.flatMap((story) => story.records);
  if (records.length === 0) return null;
  const active = records.filter((record) => record.status === "active");
  const pool = active.length > 0 ? active : records;
  return pool[pool.length - 1] ?? null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPublicProviderSettings(value: unknown): value is {
  providerId: ModelProviderId;
  apiKeyConfigured: boolean;
  availableModels: readonly unknown[];
} {
  if (!isObject(value)) return false;
  const providerId = value.providerId;
  if (typeof providerId !== "string") return false;
  if (!MODEL_PROVIDER_CATALOG.some((entry) => entry.id === providerId)) return false;
  return typeof value.apiKeyConfigured === "boolean" && Array.isArray(value.availableModels);
}

function isSettingsSnapshot(value: unknown): value is { settings: PublicModelSettingsSnapshot } {
  if (!isObject(value) || value.ok !== true) return false;
  const settings = value.settings;
  if (!isObject(settings)) return false;
  if (settings.schemaVersion !== 2) return false;
  const activeProviderId = settings.activeProviderId;
  if (typeof activeProviderId !== "string") return false;
  const providers = settings.providers;
  if (!Array.isArray(providers) || providers.length === 0) return false;
  return providers.every(isPublicProviderSettings);
}

/**
 * 批次 S：世界入口引导屏。
 * 账号没有「最近打开」记忆时的首页：主入口 AI 助手对话、次入口分步引导、
 * 已有世界列表。本屏只是入口，不改动任何既有世界数据。
 */
export function WorldOnboarding(props: WorldOnboardingProps) {
  const { uiLanguage, library, onOpenChat, onOpenGuided, onOpenLobby, onOpenRecord, onCreatePreset } = props;
  const [busyPreset, setBusyPreset] = useState<string | null>(null);
  const [presetError, setPresetError] = useState(false);
  const [aiStatus, setAiStatus] = useState<"checking" | "ready" | "needs-key" | "needs-model" | "error">("checking");
  const [aiProviderName, setAiProviderName] = useState<string>("");
  const entries: WorldEntry[] = library.worlds
    .map((world) => ({ world, latestRecord: latestRecordOf(world) }))
    .filter((entry): entry is WorldEntry => entry.world.id.trim().length > 0);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await fetch("/api/settings/model-provider", {
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        const body: unknown = await response.json();
        if (!active) return;
        if (!response.ok || !isSettingsSnapshot(body)) {
          setAiStatus("error");
          return;
        }
        const activeProfile = body.settings.providers.find(
          (profile) => profile.providerId === body.settings.activeProviderId,
        );
        if (!activeProfile) {
          setAiStatus("error");
          return;
        }
        const catalogEntry = MODEL_PROVIDER_CATALOG.find(
          (entry) => entry.id === activeProfile.providerId,
        );
        setAiProviderName(catalogEntry?.name ?? activeProfile.providerId);
        if (catalogEntry?.requiresApiKey && !activeProfile.apiKeyConfigured) {
          setAiStatus("needs-key");
          return;
        }
        if (activeProfile.availableModels.length === 0) {
          setAiStatus("needs-model");
          return;
        }
        setAiStatus("ready");
      } catch {
        if (active) setAiStatus("error");
      }
    })();
    return () => { active = false; };
  }, []);

  async function handlePreset(preset: PresetWorld) {
    if (busyPreset) return;
    setPresetError(false);
    setBusyPreset(preset.key);
    try {
      if (!await onCreatePreset(preset.key)) setPresetError(true);
    } catch {
      setPresetError(true);
    } finally {
      setBusyPreset(null);
    }
  }

  return (
    <main className="state-screen world-onboarding">
      <div className="state-mark" aria-hidden="true">
        {uiText("ui.onboarding.mark", uiLanguage)}
      </div>
      <p className="eyebrow">{uiText("ui.onboarding.eyebrow", uiLanguage)}</p>
      <h1>{uiText("ui.onboarding.title", uiLanguage)}</h1>
      <p>{uiText("ui.onboarding.hint", uiLanguage)}</p>

      <div className="onboarding-entries">
        {aiStatus !== "ready" && aiStatus !== "checking" ? (
          <div className="onboarding-ai-notice" role="status">
            <strong>{uiText("ui.onboarding.aiTitle", uiLanguage)}</strong>
            <p>{uiText("ui.onboarding.aiBody", uiLanguage)}</p>
            <Link
              className="onboarding-entry-config"
              data-creation-focus-return="create-chat"
              href="/settings?return=/"
            >
              <span className="guided-entry-seal" aria-hidden="true">
                配
              </span>
              <span className="guided-entry-copy">
                <strong>{uiText("ui.onboarding.aiAction", uiLanguage)}</strong>
                <small>{aiProviderName}</small>
              </span>
            </Link>
          </div>
        ) : null}
        <button
          className="guided-entry onboarding-entry is-primary"
          data-creation-focus-return="create-chat"
          disabled={aiStatus !== "ready"}
          onClick={onOpenChat}
          type="button"
        >
          <span className="guided-entry-seal" aria-hidden="true">
            谈
          </span>
          <span className="guided-entry-copy">
            <strong>{uiText("ui.onboarding.chatEntry", uiLanguage)}</strong>
            <small>{aiStatus === "ready"
              ? uiText("ui.onboarding.chatHint", uiLanguage)
              : aiStatus === "checking"
                ? uiText("ui.onboarding.aiReady", uiLanguage)
                : uiText("ui.onboarding.aiTitle", uiLanguage)}</small>
          </span>
        </button>
        <button
          className="guided-entry onboarding-entry"
          data-creation-focus-return="create-guided"
          onClick={onOpenGuided}
          type="button"
        >
          <span className="guided-entry-seal" aria-hidden="true">
            问
          </span>
          <span className="guided-entry-copy">
            <strong>{uiText("ui.onboarding.guidedEntry", uiLanguage)}</strong>
            <small>{uiText("ui.onboarding.guidedHint", uiLanguage)}</small>
          </span>
        </button>
        <button
          className="guided-entry onboarding-entry"
          onClick={onOpenLobby}
          type="button"
        >
          <span className="guided-entry-seal" aria-hidden="true">
            厅
          </span>
          <span className="guided-entry-copy">
            <strong>{uiText("ui.onboarding.lobbyEntry", uiLanguage)}</strong>
            <small>{uiText("ui.onboarding.lobbyHint", uiLanguage)}</small>
          </span>
        </button>
      </div>

      <section className="onboarding-presets" aria-label={uiText("ui.presetWorld.title", uiLanguage)}>
        <h2>{uiText("ui.presetWorld.title", uiLanguage)}</h2>
        <p>{uiText("ui.presetWorld.description", uiLanguage)}</p>
        <div className="onboarding-preset-grid">
          {listPresetWorlds().map((preset) => (
            <button
              key={preset.key}
              className="onboarding-preset-card"
              disabled={busyPreset !== null}
              onClick={() => void handlePreset(preset)}
              type="button"
            >
              <span className="onboarding-preset-tag">{uiText(preset.tagKey, uiLanguage)}</span>
              <strong>{uiText(preset.titleKey, uiLanguage)}</strong>
              <small>{uiText(preset.descriptionKey, uiLanguage)}</small>
              <span className="onboarding-preset-action">
                {busyPreset === preset.key
                  ? uiText("ui.library.submitting", uiLanguage)
                  : uiText("ui.onboarding.open", uiLanguage)}
              </span>
            </button>
          ))}
        </div>
        {presetError ? (
          <p className="onboarding-create-error" role="alert">
            {uiText("ui.world.createFailed", uiLanguage)}
          </p>
        ) : null}
      </section>

      {entries.length > 0 ? (
        <section className="onboarding-worlds" aria-label={uiText("ui.onboarding.continueTitle", uiLanguage)}>
          <h2>{uiText("ui.onboarding.continueTitle", uiLanguage)}</h2>
          <ul>
            {entries.map(({ world, latestRecord }) => (
              <li key={world.id}>
                {latestRecord ? (
                  <button
                    onClick={() => onOpenRecord(latestRecord.id)}
                    type="button"
                  >
                    <strong>{world.name}</strong>
                    <small>{latestRecord.title}</small>
                    <span>{uiText("ui.onboarding.open", uiLanguage)}</span>
                  </button>
                ) : (
                  <div className="onboarding-world-empty">
                    <strong>{world.name}</strong>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
