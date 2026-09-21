import { useState } from "react";
import { uiText, type UiLanguage } from "../../modules/i18n/public.ts";
import type { LibraryRecord, LibrarySnapshot, LibraryWorld } from "./library-types";
import { listPresetWorlds, type PresetWorld } from "../../modules/application/preset-worlds.ts";

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

/**
 * 批次 S：世界入口引导屏。
 * 账号没有「最近打开」记忆时的首页：主入口 AI 助手对话、次入口分步引导、
 * 已有世界列表。本屏只是入口，不改动任何既有世界数据。
 */
export function WorldOnboarding(props: WorldOnboardingProps) {
  const { uiLanguage, library, onOpenChat, onOpenGuided, onOpenLobby, onOpenRecord, onCreatePreset } = props;
  const [busyPreset, setBusyPreset] = useState<string | null>(null);
  const entries: WorldEntry[] = library.worlds
    .map((world) => ({ world, latestRecord: latestRecordOf(world) }))
    .filter((entry): entry is WorldEntry => entry.world.id.trim().length > 0);

  async function handlePreset(preset: PresetWorld) {
    if (busyPreset) return;
    setBusyPreset(preset.key);
    try {
      await onCreatePreset(preset.key);
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
        <button
          className="guided-entry onboarding-entry is-primary"
          onClick={onOpenChat}
          type="button"
        >
          <span className="guided-entry-seal" aria-hidden="true">
            谈
          </span>
          <span className="guided-entry-copy">
            <strong>{uiText("ui.onboarding.chatEntry", uiLanguage)}</strong>
            <small>{uiText("ui.onboarding.chatHint", uiLanguage)}</small>
          </span>
        </button>
        <button
          className="guided-entry onboarding-entry"
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
