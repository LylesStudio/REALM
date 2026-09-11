"use client";

import { useState, type FormEvent } from "react";
import type { WorldGenesisDraft } from "../../modules/application/world-genesis.ts";
import {
  WORLD_STYLE_KEYS,
  normalizeWorldStyle,
  worldStyleText,
  type WorldStyle,
} from "../../modules/style/world-style.ts";
import {
  WorldExportSection,
  WorldImportHistory,
  WorldImportWizard,
} from "./world-transfer.tsx";
import { uiText, type UiLanguage } from "../../modules/i18n/public.ts";
import type {
  LibraryCreateCommand,
  LibraryRecord,
  LibrarySnapshot,
  LibraryStory,
  LibraryWorld,
} from "./library-types";

interface GenesisDraftResult {
  draft: WorldGenesisDraft;
  source: "model" | "fallback";
}

interface LibraryPanelProps {
  snapshot: LibrarySnapshot;
  /** 界面语言（缺省 zh-CN）。 */
  uiLanguage?: UiLanguage;
  /** 导入完成后刷新世界库数据。 */
  onRefresh: () => Promise<void>;
  onCreate: (command: LibraryCreateCommand) => Promise<boolean>;
  onGenesisDraft: (prompt: string) => Promise<GenesisDraftResult | null>;
  /** 确认手稿，返回新记录 id；失败返回 null。 */
  onGenesisConfirm: (draft: WorldGenesisDraft) => Promise<string | null>;
  /** 进入司卷问答全屏引导。 */
  onOpenGuided: () => void;
  onOpenRecord: (recordId: string) => void;
  /** 批次 T9：打开图谱需带世界 id（canon/图谱 API 显式 worldId）。 */
  onOpenGraph?: (worldId: string, worldName: string) => void;
  /** 批次 S：当前打开记录所属世界 id（自动携带 attachRecordId 与姿态切换后重载依据）。 */
  currentWorldId?: string;
  /** 批次 S：当前打开记录 id（添角色入阵容目标）。 */
  currentRecordId?: string;
  /** 批次 S：当前记录阵容已含的角色定义 id（「在阵容」标注）。 */
  castDefinitionIds?: readonly string[];
  /** 当前 Record 的角色席位状态；非活跃席位保留并提供回归入口。 */
  castActivity?: readonly { definitionId: string; isActive: boolean }[];
  /** 批次 S：添角色/姿态切换成功后重载当前记录。 */
  onRecordReload?: () => Promise<void>;
  /** 当前 Record 被删除后回默认入口。 */
  onRecordDeleted?: () => Promise<void>;
  /** 批次 T8：当前打开世界被删除后回默认入口（onboarding 兜底）。 */
  onWorldDeleted?: () => Promise<void>;
  onClose: () => void;
}

type CreateMode = "world" | "story" | "record" | "character" | "branch";

export function LibraryPanel({
  snapshot,
  uiLanguage = "zh-CN",
  onRefresh,
  onCreate,
  onGenesisDraft,
  onGenesisConfirm,
  onOpenGuided,
  onOpenRecord,
  onOpenGraph,
  currentWorldId = "",
  currentRecordId = "",
  castDefinitionIds = [],
  castActivity = [],
  onRecordReload,
  onRecordDeleted,
  onWorldDeleted,
  onClose,
}: LibraryPanelProps) {
  const [genesisPrompt, setGenesisPrompt] = useState("");
  const [manuscript, setManuscript] = useState<WorldGenesisDraft | null>(null);
  const [manuscriptSource, setManuscriptSource] = useState<"model" | "fallback">("model");
  const [genesisBusy, setGenesisBusy] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);

  async function submitGenesis(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (genesisBusy) return;
    setGenesisBusy(true);
    try {
      const result = await onGenesisDraft(genesisPrompt);
      if (result) {
        setManuscript(result.draft);
        setManuscriptSource(result.source);
      }
    } finally {
      setGenesisBusy(false);
    }
  }

  async function confirmGenesis() {
    if (!manuscript || genesisBusy) return;
    setGenesisBusy(true);
    try {
      const recordId = await onGenesisConfirm(manuscript);
      if (recordId) {
        setManuscript(null);
        setGenesisPrompt("");
        onOpenRecord(recordId);
      }
    } finally {
      setGenesisBusy(false);
    }
  }

  function updateManuscript(
    updater: (current: WorldGenesisDraft) => WorldGenesisDraft,
  ) {
    setManuscript((current) => (current ? updater(current) : current));
  }

  return (
    <section className="library-panel" aria-label="世界库">
      <header className="library-panel-heading">
        <div>
          <p className="eyebrow">{uiText("ui.library.eyebrow", uiLanguage)}</p>
          <h2>{uiText("ui.library.heading", uiLanguage)}</h2>
        </div>
        <button aria-label={uiText("ui.library.close", uiLanguage)} onClick={onClose} type="button">×</button>
      </header>

      <div className="library-layout">
        <aside className="library-list">
          {snapshot.worlds.map((world) => (
            <section
              className="library-world"
              data-archived={world.status === "archived" ? "true" : "false"}
              key={world.id}
            >
              <div className="library-world-heading">
                <strong>{world.name}</strong>
                <span>{world.era}</span>
                <small>{world.status}</small>
                {world.status === "archived" ? (
                  <em className="world-archived-badge">
                    {uiText("ui.library.archived", uiLanguage)}
                  </em>
                ) : null}
                {onOpenGraph ? (
                  <button
                    className="library-graph-link"
                    onClick={() => onOpenGraph(world.id, world.name)}
                    type="button"
                  >
                    {uiText("ui.library.graph", uiLanguage)}
                  </button>
                ) : null}
              </div>
              <div className="library-style-picker" aria-label={`${world.name}${uiText("ui.library.stylePicker", uiLanguage)}`}>
                {WORLD_STYLE_KEYS.map((key) => {
                  const active = normalizeWorldStyle(world.style) === key;
                  return (
                    <button
                      aria-pressed={active}
                      className={active ? "is-active" : ""}
                      key={key}
                      onClick={() =>
                        void onCreate({
                          kind: "world-style",
                          worldId: world.id,
                          style: key,
                        })}
                      type="button"
                    >
                      {worldStyleText(`guided.style.${key}`, key as WorldStyle)}
                    </button>
                  );
                })}
              </div>
              {world.summary ? <p>{world.summary}</p> : null}
              {/* 批次 T8：信息密度行（计数 + 最近活动）与 owner 管理区。 */}
              <p className="library-world-stats">
                {uiText("ui.library.stats", uiLanguage, {
                  characters: String(world.characterCount),
                  stories: String(world.storyCount),
                  records: String(world.recordCount),
                })}
                {world.lastActiveAt
                  ? ` · ${uiText("ui.library.lastActive", uiLanguage, { time: world.lastActiveAt.slice(0, 10) })}`
                  : ""}
              </p>
              {world.membershipRole === "owner" ? (
                <>
                  <WorldAdmin
                    onCreate={onCreate}
                    onDeleted={world.id === currentWorldId ? onWorldDeleted : undefined}
                    uiLanguage={uiLanguage}
                    world={world}
                  />
                  <WorldExportSection
                    hasBranches={world.branchCount > 0}
                    uiLanguage={uiLanguage}
                    worldId={world.id}
                  />
                </>
              ) : null}
              <StanceToggle
                isObserver={world.membershipRole === "observer"}
                onCreate={onCreate}
                onSwitched={world.id === currentWorldId ? onRecordReload : undefined}
                uiLanguage={uiLanguage}
                worldId={world.id}
              />
              <AddCharacterForm
                attachRecordId={world.id === currentWorldId ? currentRecordId : ""}
                onCreate={onCreate}
                onAttached={world.id === currentWorldId ? onRecordReload : undefined}
                uiLanguage={uiLanguage}
                worldId={world.id}
              />
              {world.characters.map((character) => {
                const isTavernCharacter = character.sourceFormat === "tavern"
                  || character.sourceFormat.startsWith("tavern-")
                  || character.sourceFormat === "sillytavern_character_card";
                const inCast = world.id === currentWorldId
                  && castDefinitionIds.includes(character.id);
                const activity = castActivity.find((item) => item.definitionId === character.id);
                const isActive = activity?.isActive === true;
                return (
                  <div className="library-character" key={character.id}>
                    {character.avatarFileId ? (
                      // eslint-disable-next-line @next/next/no-img-element -- 动态 /api/files 源不经 next/image
                      <img
                        alt=""
                        className="library-avatar"
                        src={`/api/files/${character.avatarFileId}`}
                      />
                    ) : null}
                    <span>{character.name}</span>
                    <small>{character.role}</small>
                    <span className="library-character-badges">
                      <em className={isTavernCharacter
                        ? "char-source is-tavern"
                        : "char-source"}
                      >
                        {isTavernCharacter
                          ? uiText("ui.library.sourceTavern", uiLanguage)
                          : uiText("ui.library.sourceNative", uiLanguage)}
                      </em>
                      {inCast ? (
                        <em className="char-in-cast">
                          {isActive
                            ? uiText("ui.library.inCast", uiLanguage)
                            : uiText("ui.library.castInactive", uiLanguage)}
                        </em>
                      ) : null}
                      {world.id === currentWorldId && inCast && currentRecordId ? (
                        <button
                          className="library-attach"
                          onClick={() => {
                            void (async () => {
                              const updated = await onCreate({
                                kind: "character-activity",
                                worldId: world.id,
                                recordId: currentRecordId,
                                definitionId: character.id,
                                active: !isActive,
                              });
                              if (updated) await onRecordReload?.();
                            })();
                          }}
                          type="button"
                        >
                          {isActive
                            ? uiText("ui.library.castLeave", uiLanguage)
                            : uiText("ui.library.castReturn", uiLanguage)}
                        </button>
                      ) : null}
                      {world.id === currentWorldId && !inCast && currentRecordId ? (
                        <button
                          className="library-attach"
                          onClick={() => {
                            void (async () => {
                              const attached = await onCreate({
                                kind: "attach-character",
                                worldId: world.id,
                                recordId: currentRecordId,
                                definitionId: character.id,
                              });
                              if (attached) await onRecordReload?.();
                            })();
                          }}
                          type="button"
                        >
                          {uiText("ui.library.attachToCast", uiLanguage)}
                        </button>
                      ) : null}
                    </span>
                  </div>
                );
              })}
              {world.worldlines.map((worldline) => (
                <div className="library-worldline" key={worldline.id}>
                  <span>{worldline.label}</span>
                  <small>{worldline.parentWorldlineId
                    ? uiText("ui.library.branchWorldline", uiLanguage)
                    : uiText("ui.library.originalWorldline", uiLanguage)}</small>
                </div>
              ))}
              <ImportZone onImported={onRefresh} uiLanguage={uiLanguage} worldId={world.id} />
              {world.stories.map((story) => (
                <div className="library-story" key={story.id}>
                  <div className="library-story-heading">
                    <span>{story.title}</span>
                    <small>{uiText("ui.library.recordCount", uiLanguage, { count: String(story.records.length) })}</small>
                  </div>
                  {story.records.map((record) => (
                    <div className="library-record-row" key={record.id}>
                      <button
                        className="library-record"
                        onClick={() => onOpenRecord(record.id)}
                        type="button"
                      >
                        <i aria-hidden="true" />
                        <span>{record.title}</span>
                        <small>
                          {record.status}
                          {record.timelineKind === "retrospection" ? " · Retrospection" : ""}
                          {record.timelineKind === "merged" ? " · Merged" : ""}
                        </small>
                      </button>
                      {world.membershipRole === "owner" ? (
                        <RecordDeleteButton
                          onCreate={onCreate}
                          onDeleted={world.id === currentWorldId && record.id === currentRecordId
                            ? onRecordDeleted
                            : undefined}
                          record={record}
                          uiLanguage={uiLanguage}
                          worldId={world.id}
                        />
                      ) : null}
                    </div>
                  ))}
                </div>
              ))}
            </section>
          ))}
        </aside>

        <div className="library-create">
          <button
            className="guided-entry"
            onClick={onOpenGuided}
            type="button"
          >
            <span className="guided-entry-seal" aria-hidden="true">卷</span>
            <span className="guided-entry-copy">
              <strong>{uiText("ui.library.guidedEntry", uiLanguage)}</strong>
              <small>{uiText("ui.library.guidedHint", uiLanguage)}</small>
            </span>
            <span aria-hidden="true">▸</span>
          </button>

          <section className="genesis-section" aria-label="启笔铸界">
            <div className="genesis-heading">
              <p className="eyebrow">{uiText("ui.library.genesisEyebrow", uiLanguage)}</p>
              <p className="genesis-hint">
                {uiText("ui.library.genesisHint", uiLanguage)}
              </p>
            </div>
            <form className="genesis-form" onSubmit={submitGenesis}>
              <textarea
                aria-label="创世灵感"
                className="genesis-prompt"
                disabled={genesisBusy}
                onChange={(event) => setGenesisPrompt(event.target.value)}
                placeholder={uiText("ui.library.genesisPlaceholder", uiLanguage)}
                rows={6}
                value={genesisPrompt}
              />
              <button
                className="genesis-submit"
                disabled={genesisBusy || genesisPrompt.trim().length < 4}
                type="submit"
              >
                {genesisBusy && !manuscript
                ? uiText("ui.library.genesisDrafting", uiLanguage)
                : uiText("ui.library.genesisDraft", uiLanguage)}
              </button>
            </form>

            {manuscript ? (
              <div className="genesis-manuscript" aria-label="纸墨手稿">
                <div className="genesis-manuscript-heading">
                  <p className="eyebrow">{uiText("ui.library.manuscript", uiLanguage)}</p>
                  <span className="genesis-source">
                    {manuscriptSource === "model"
                    ? uiText("ui.library.sourceModel", uiLanguage)
                    : uiText("ui.library.sourceFallback", uiLanguage)}
                  </span>
                </div>

                <div className="genesis-fields">
                  <label>
                    世界名
                    <input
                      onChange={(event) =>
                        updateManuscript((current) => ({
                          ...current,
                          world: { ...current.world, name: event.target.value },
                        }))}
                      value={manuscript.world.name}
                    />
                  </label>
                  <label>
                    纪元
                    <input
                      onChange={(event) =>
                        updateManuscript((current) => ({
                          ...current,
                          world: { ...current.world, era: event.target.value },
                        }))}
                      value={manuscript.world.era}
                    />
                  </label>
                  <label>
                    背景摘要
                    <textarea
                      onChange={(event) =>
                        updateManuscript((current) => ({
                          ...current,
                          world: { ...current.world, summary: event.target.value },
                        }))}
                      rows={3}
                      value={manuscript.world.summary}
                    />
                  </label>
                  <label>
                    开幕故事
                    <input
                      onChange={(event) =>
                        updateManuscript((current) => ({
                          ...current,
                          story: { ...current.story, title: event.target.value },
                        }))}
                      value={manuscript.story.title}
                    />
                  </label>
                  <label>
                    故事前提
                    <textarea
                      onChange={(event) =>
                        updateManuscript((current) => ({
                          ...current,
                          story: { ...current.story, premise: event.target.value },
                        }))}
                      rows={2}
                      value={manuscript.story.premise}
                    />
                  </label>
                  <label>
                    开篇记录
                    <input
                      onChange={(event) =>
                        updateManuscript((current) => ({
                          ...current,
                          record: { title: event.target.value },
                        }))}
                      value={manuscript.record.title}
                    />
                  </label>
                  <label>
                    我的角色定位
                    <input
                      onChange={(event) =>
                        updateManuscript((current) => ({
                          ...current,
                          playerRole: event.target.value,
                        }))}
                      value={manuscript.playerRole}
                    />
                  </label>
                </div>

                <div className="genesis-stance" role="group" aria-label={uiText("ui.stance.label", uiLanguage)}>
                  <span>{uiText("ui.stance.label", uiLanguage)}</span>
                  <div className="stance-options">
                    <button
                      className={manuscript.playerStance !== "observer"
                        ? "stance-option is-active"
                        : "stance-option"}
                      onClick={() =>
                        updateManuscript((current) => ({
                          ...current,
                          playerStance: "player",
                        }))}
                      type="button"
                    >
                      <strong>{uiText("ui.stance.player", uiLanguage)}</strong>
                      <small>{uiText("ui.stance.playerHint", uiLanguage)}</small>
                    </button>
                    <button
                      className={manuscript.playerStance === "observer"
                        ? "stance-option is-active"
                        : "stance-option"}
                      onClick={() =>
                        updateManuscript((current) => ({
                          ...current,
                          playerStance: "observer",
                        }))}
                      type="button"
                    >
                      <strong>{uiText("ui.stance.observer", uiLanguage)}</strong>
                      <small>{uiText("ui.stance.observerHint", uiLanguage)}</small>
                    </button>
                  </div>
                </div>

                <div className="genesis-companions">
                  <p className="eyebrow">同行者 / Companions</p>
                  {manuscript.companions.map((companion, index) => (
                    <div className="genesis-companion" key={index}>
                      <input
                        aria-label={`同伴 ${index + 1} 名称`}
                        onChange={(event) =>
                          updateManuscript((current) => ({
                            ...current,
                            companions: current.companions.map((item, at) =>
                              at === index
                                ? { ...item, name: event.target.value }
                                : item),
                          }))}
                        value={companion.name}
                      />
                      <input
                        aria-label={`同伴 ${index + 1} 身份`}
                        onChange={(event) =>
                          updateManuscript((current) => ({
                            ...current,
                            companions: current.companions.map((item, at) =>
                              at === index
                                ? { ...item, role: event.target.value }
                                : item),
                          }))}
                        value={companion.role}
                      />
                      <button
                        aria-label={`移除同伴 ${companion.name}`}
                        onClick={() =>
                          updateManuscript((current) => ({
                            ...current,
                            companions: current.companions.filter(
                              (_, at) => at !== index,
                            ),
                          }))}
                        type="button"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  {manuscript.companions.length < 2 ? (
                    <button
                      className="genesis-companion-add"
                      onClick={() =>
                        updateManuscript((current) => ({
                          ...current,
                          companions: [
                            ...current.companions,
                            { name: "", role: "", summary: "" },
                          ],
                        }))}
                      type="button"
                    >
                      添一名同行者
                    </button>
                  ) : null}
                </div>

                <div className="genesis-fields genesis-scene">
                  <label>
                    开场地点
                    <input
                      onChange={(event) =>
                        updateManuscript((current) => ({
                          ...current,
                          scene: { ...current.scene, location: event.target.value },
                        }))}
                      value={manuscript.scene.location}
                    />
                  </label>
                  <label>
                    天气
                    <input
                      onChange={(event) =>
                        updateManuscript((current) => ({
                          ...current,
                          scene: { ...current.scene, weather: event.target.value },
                        }))}
                      value={manuscript.scene.weather}
                    />
                  </label>
                  <label>
                    局势
                    <input
                      onChange={(event) =>
                        updateManuscript((current) => ({
                          ...current,
                          scene: { ...current.scene, tension: event.target.value },
                        }))}
                      value={manuscript.scene.tension}
                    />
                  </label>
                  <label>
                    当前目标
                    <input
                      onChange={(event) =>
                        updateManuscript((current) => ({
                          ...current,
                          scene: { ...current.scene, objective: event.target.value },
                        }))}
                      value={manuscript.scene.objective}
                    />
                  </label>
                </div>

                <div className="genesis-actions">
                  <button
                    className="genesis-confirm"
                    disabled={genesisBusy || !manuscript.world.name.trim()}
                    onClick={() => void confirmGenesis()}
                    type="button"
                  >
                    {genesisBusy
                    ? uiText("ui.library.confirming", uiLanguage)
                    : uiText("ui.library.confirm", uiLanguage)}
                  </button>
                  <button
                    className="genesis-redraft"
                    disabled={genesisBusy}
                    onClick={() => setManuscript(null)}
                    type="button"
                  >
                    {uiText("ui.library.redraft", uiLanguage)}
                  </button>
                </div>
              </div>
            ) : null}
          </section>

          <section className="library-manual">
            <button
              aria-expanded={manualOpen}
              className="library-manual-toggle"
              onClick={() => setManualOpen((open) => !open)}
              type="button"
            >
              <span aria-hidden="true">{manualOpen ? "▾" : "▸"}</span>
              {uiText("ui.library.manual", uiLanguage)}
            </button>
            {manualOpen ? <ManualCreateForm onCreate={onCreate} snapshot={snapshot} /> : null}
          </section>

          {/* v37 H.2：.realm 导入向导 + 导入历史（前端零身份字段）。 */}
          <section className="library-realm-transfer" aria-label="世界传输">
            <WorldImportWizard onImported={onRefresh} uiLanguage={uiLanguage} />
            <WorldImportHistory uiLanguage={uiLanguage} />
          </section>
        </div>
      </div>
    </section>
  );
}

function RecordDeleteButton({
  worldId,
  record,
  uiLanguage = "zh-CN",
  onCreate,
  onDeleted,
}: {
  worldId: string;
  record: LibraryRecord;
  uiLanguage?: UiLanguage;
  onCreate: (command: LibraryCreateCommand) => Promise<boolean>;
  onDeleted?: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function remove() {
    if (busy) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    try {
      const done = await onCreate({
        kind: "delete-record",
        worldId,
        recordId: record.id,
      });
      if (done) await onDeleted?.();
      else setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      aria-label={`${uiText("ui.library.deleteRecord", uiLanguage)} ${record.title}`}
      className={confirming ? "library-record-delete is-danger" : "library-record-delete"}
      disabled={busy}
      onClick={() => void remove()}
      type="button"
    >
      {busy
        ? uiText("ui.library.deleteRecordBusy", uiLanguage)
        : uiText(confirming ? "ui.library.deleteRecordConfirm" : "ui.library.deleteRecord", uiLanguage)}
    </button>
  );
}

/**
 * 批次 T8：世界管理区（owner 可见）——归档/恢复 + 两段式删除确认。
 * 权限最终由服务端裁决（WORLD_NOT_OWNED）；删除仅零记录世界（服务端
 * WORLD_NOT_EMPTY 引导归档）。失败文案经 /api/library 错误码映射为全局提示。
 */
function WorldAdmin({
  world,
  uiLanguage = "zh-CN",
  onCreate,
  onDeleted,
}: {
  world: LibraryWorld;
  uiLanguage?: UiLanguage;
  onCreate: (command: LibraryCreateCommand) => Promise<boolean>;
  onDeleted?: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const archived = world.status === "archived";

  async function run(command: LibraryCreateCommand) {
    if (busy) return;
    setBusy(true);
    try {
      const done = await onCreate(command);
      if (done && command.kind === "delete-world") {
        await onDeleted?.();
      }
      if (!done) setConfirmingDelete(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="library-world-admin">
      <button
        disabled={busy}
        onClick={() => void run({
          kind: "world-archive",
          worldId: world.id,
          archived: !archived,
        })}
        type="button"
      >
        {busy
          ? uiText("ui.library.adminBusy", uiLanguage)
          : uiText(
              archived ? "ui.library.unarchive" : "ui.library.archive",
              uiLanguage,
            )}
      </button>
      <button
        className={confirmingDelete ? "is-danger" : undefined}
        disabled={busy}
        onClick={() => {
          if (!confirmingDelete) {
            setConfirmingDelete(true);
            return;
          }
          void run({ kind: "delete-world", worldId: world.id });
        }}
        type="button"
      >
        {confirmingDelete
          ? uiText("ui.library.deleteWorldConfirm", uiLanguage)
          : uiText("ui.library.deleteWorld", uiLanguage)}
      </button>
    </div>
  );
}

/**
 * 批次 S：世界卡「我的姿态」开关——入局 ⟷ 观察者。
 * 状态源为 membership.role（快照随 library 重载刷新）；切换成功后
 * 若该世界即当前记录所属世界，重载当前记录以同步阵容与徽标。
 */
function StanceToggle({
  worldId,
  isObserver,
  uiLanguage,
  onCreate,
  onSwitched,
}: {
  worldId: string;
  isObserver: boolean;
  uiLanguage: UiLanguage;
  onCreate: (command: LibraryCreateCommand) => Promise<boolean>;
  onSwitched?: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function switchTo(stance: "player" | "observer") {
    if (busy) return;
    if ((stance === "observer") === isObserver) return;
    setBusy(true);
    setFailed(false);
    try {
      const switched = await onCreate({ kind: "player-stance", worldId, stance });
      if (switched) {
        await onSwitched?.();
      } else {
        setFailed(true);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="library-stance" aria-label={uiText("ui.stance.label", uiLanguage)}>
      <span className="library-stance-label">
        {uiText("ui.stance.label", uiLanguage)}
      </span>
      <div className="library-stance-toggle" role="group">
        <button
          aria-pressed={!isObserver}
          className={isObserver ? "" : "is-active"}
          disabled={busy}
          onClick={() => void switchTo("player")}
          type="button"
        >
          {uiText("ui.stance.player", uiLanguage)}
        </button>
        <button
          aria-pressed={isObserver}
          className={isObserver ? "is-active" : ""}
          disabled={busy}
          onClick={() => void switchTo("observer")}
          type="button"
        >
          {uiText("ui.stance.observer", uiLanguage)}
        </button>
      </div>
      {busy ? (
        <small className="library-stance-note">
          {uiText("ui.library.stanceBusy", uiLanguage)}
        </small>
      ) : null}
      {!busy && failed ? (
        <small className="library-stance-note is-failed">
          {uiText("ui.library.stanceFailed", uiLanguage)}
        </small>
      ) : null}
    </div>
  );
}

/**
 * 批次 S：世界卡「添角色」快捷表单（名字/定位/一句话侧写）。
 * 当前打开记录属于该世界时自动携带 attachRecordId：创建成功后
 * 角色即入当前阵容，显示提示并重载记录。
 */
function AddCharacterForm({
  worldId,
  attachRecordId,
  uiLanguage,
  onCreate,
  onAttached,
}: {
  worldId: string;
  attachRecordId: string;
  uiLanguage: UiLanguage;
  onCreate: (command: LibraryCreateCommand) => Promise<boolean>;
  onAttached?: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const [attached, setAttached] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    try {
      const created = await onCreate({
        kind: "character",
        worldId,
        name: name.trim(),
        role: role.trim(),
        summary: summary.trim(),
        attachRecordId: attachRecordId || undefined,
      });
      if (created) {
        setName("");
        setRole("");
        setSummary("");
        if (attachRecordId) {
          setAttached(true);
          await onAttached?.();
        }
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="library-add-character" onSubmit={submit}>
      <p className="eyebrow">{uiText("ui.library.addCharacter", uiLanguage)}</p>
      <div className="library-add-character-row">
        <input
          aria-label={uiText("ui.library.addCharacterName", uiLanguage)}
          disabled={busy}
          maxLength={80}
          onChange={(event) => {
            setName(event.target.value);
            setAttached(false);
          }}
          placeholder={uiText("ui.library.addCharacterName", uiLanguage)}
          value={name}
        />
        <input
          aria-label={uiText("ui.library.addCharacterRole", uiLanguage)}
          disabled={busy}
          maxLength={120}
          onChange={(event) => {
            setRole(event.target.value);
            setAttached(false);
          }}
          placeholder={uiText("ui.library.addCharacterRole", uiLanguage)}
          value={role}
        />
      </div>
      <input
        aria-label={uiText("ui.library.addCharacterSummary", uiLanguage)}
        disabled={busy}
        maxLength={300}
        onChange={(event) => {
          setSummary(event.target.value);
          setAttached(false);
        }}
        placeholder={uiText("ui.library.addCharacterSummary", uiLanguage)}
        value={summary}
      />
      <div className="library-add-character-actions">
        <button disabled={busy || !name.trim()} type="submit">
          {busy
            ? uiText("ui.library.addCharacterBusy", uiLanguage)
            : uiText("ui.library.addCharacterSubmit", uiLanguage)}
        </button>
        {attached ? (
          <small className="library-add-character-note">
            {uiText("ui.library.addCharacterAttach", uiLanguage)}
          </small>
        ) : null}
      </div>
    </form>
  );
}

function ManualCreateForm({
  snapshot,
  onCreate,
}: {
  snapshot: LibrarySnapshot;
  onCreate: (command: LibraryCreateCommand) => Promise<boolean>;
}) {
  const [mode, setMode] = useState<CreateMode>("world");
  const [name, setName] = useState("");
  const [era, setEra] = useState("");
  const [summary, setSummary] = useState("");
  const [role, setRole] = useState("");
  const [label, setLabel] = useState("");
  const [retrospection, setRetrospection] = useState(false);
  const [worldId, setWorldId] = useState(snapshot.worlds[0]?.id ?? "");
  const [storyId, setStoryId] = useState(
    snapshot.worlds[0]?.stories[0]?.id ?? "",
  );
  const [title, setTitle] = useState("");
  const [premise, setPremise] = useState("");
  const [busy, setBusy] = useState(false);

  const stories: LibraryStory[] = snapshot.worlds.flatMap(
    (world) => world.stories,
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      const command: LibraryCreateCommand = mode === "world"
        ? { kind: "world", name, era, summary }
        : mode === "story"
          ? { kind: "story", worldId, title, premise }
          : mode === "record"
              ? { kind: "record", storyId, title, retrospection }
            : mode === "character"
              ? { kind: "character", worldId, name, role, summary }
              : { kind: "branch", worldId, label };
      const created = await onCreate(command);
      if (created) {
        setName("");
        setEra("");
        setSummary("");
        setTitle("");
        setPremise("");
        setRole("");
        setLabel("");
        setRetrospection(false);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="library-form" onSubmit={submit}>
      <div className="library-tabs" role="tablist">
        <button className={mode === "world" ? "is-active" : ""} onClick={() => setMode("world")} type="button">世界</button>
        <button className={mode === "story" ? "is-active" : ""} onClick={() => setMode("story")} type="button">故事</button>
        <button className={mode === "record" ? "is-active" : ""} onClick={() => setMode("record")} type="button">记录</button>
        <button className={mode === "character" ? "is-active" : ""} onClick={() => setMode("character")} type="button">角色</button>
        <button className={mode === "branch" ? "is-active" : ""} onClick={() => setMode("branch")} type="button">分支</button>
      </div>

      {mode === "world" ? (
        <div className="library-fields">
          <label>世界名<input value={name} onChange={(event) => setName(event.target.value)} required /></label>
          <label>时代<input value={era} onChange={(event) => setEra(event.target.value)} /></label>
          <label>摘要<textarea rows={3} value={summary} onChange={(event) => setSummary(event.target.value)} /></label>
        </div>
      ) : null}

      {mode === "story" ? (
        <div className="library-fields">
          <label>所属世界<select value={worldId} onChange={(event) => setWorldId(event.target.value)} required>{snapshot.worlds.map((world) => <option key={world.id} value={world.id}>{world.name}</option>)}</select></label>
          <label>故事标题<input value={title} onChange={(event) => setTitle(event.target.value)} required /></label>
          <label>前提<textarea rows={3} value={premise} onChange={(event) => setPremise(event.target.value)} /></label>
        </div>
      ) : null}

      {mode === "record" ? (
        <div className="library-fields">
          <label>所属故事<select value={storyId} onChange={(event) => setStoryId(event.target.value)} required>{stories.map((story) => <option key={story.id} value={story.id}>{story.title}</option>)}</select></label>
          <label>记录标题<input value={title} onChange={(event) => setTitle(event.target.value)} required /></label>
          <label className="library-checkbox">
            <input
              checked={retrospection}
              onChange={(event) => setRetrospection(event.target.checked)}
              type="checkbox"
            />
            回溯记录
          </label>
        </div>
      ) : null}

      {mode === "character" ? (
        <div className="library-fields">
          <label>所属世界<select value={worldId} onChange={(event) => setWorldId(event.target.value)} required>{snapshot.worlds.map((world) => <option key={world.id} value={world.id}>{world.name}</option>)}</select></label>
          <label>角色名<input value={name} onChange={(event) => setName(event.target.value)} required /></label>
          <label>身份<textarea rows={2} value={role} onChange={(event) => setRole(event.target.value)} /></label>
          <label>摘要<textarea rows={3} value={summary} onChange={(event) => setSummary(event.target.value)} /></label>
        </div>
      ) : null}

      {mode === "branch" ? (
        <div className="library-fields">
          <label>所属世界<select value={worldId} onChange={(event) => setWorldId(event.target.value)} required>{snapshot.worlds.map((world) => <option key={world.id} value={world.id}>{world.name}</option>)}</select></label>
          <label>分支名称<input value={label} onChange={(event) => setLabel(event.target.value)} required /></label>
        </div>
      ) : null}

      <button className="library-submit" disabled={busy} type="submit">{busy ? "…" : "+"}</button>
    </form>
  );
}

interface ImportReportState {
  characterName: string;
  avatarFileId: string | null;
  articlesCreated: string[];
  skippedDisabled: string[];
  warnings: string[];
}

/** 酒馆导入区：文件选择 → 上传 → 导入报告（角色/条目/跳过名单/警告）。 */
function ImportZone({
  worldId,
  uiLanguage,
  onImported,
}: {
  worldId: string;
  uiLanguage: UiLanguage;
  onImported: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ImportReportState | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("worldId", worldId);
      const response = await fetch("/api/library/import", {
        method: "POST",
        body: form,
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const message = typeof body === "object" && body !== null
          && typeof (body as Record<string, { message?: unknown }>).error?.message === "string"
          ? (body as { error: { message: string } }).error.message
          : uiText("ui.library.importFailed", uiLanguage);
        setError(message);
        return;
      }
      const payload = body as {
        character?: { name?: unknown; avatarFileId?: unknown } | null;
        articlesCreated?: string[];
        skippedDisabled?: string[];
        warnings?: string[];
      };
      await onImported();
      setReport({
        characterName: typeof payload.character?.name === "string"
          ? payload.character.name
          : "",
        avatarFileId: typeof payload.character?.avatarFileId === "string"
          && payload.character.avatarFileId.length > 0
          ? payload.character.avatarFileId
          : null,
        articlesCreated: payload.articlesCreated ?? [],
        skippedDisabled: payload.skippedDisabled ?? [],
        warnings: payload.warnings ?? [],
      });
    } catch {
      setError(uiText("ui.library.importFailed", uiLanguage));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="library-import">
      <label className="library-import-trigger">
        <input
          accept=".png,.json"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
            event.target.value = "";
          }}
          type="file"
        />
        <span>{busy
          ? uiText("ui.library.importing", uiLanguage)
          : uiText("ui.library.import", uiLanguage)}</span>
        <small>{uiText("ui.library.importHint", uiLanguage)}</small>
      </label>
      {error ? (
        <p className="library-import-error" role="alert">{error}</p>
      ) : null}
      {report ? (
        <div className="library-import-report">
          <p className="eyebrow">{uiText("ui.library.importDone", uiLanguage)}</p>
          {report.characterName ? (
            <div className="library-import-character">
              {report.avatarFileId ? (
                // eslint-disable-next-line @next/next/no-img-element -- 动态 /api/files 源不经 next/image
                <img
                  alt=""
                  className="library-avatar"
                  src={`/api/files/${report.avatarFileId}`}
                />
              ) : null}
              <strong>{report.characterName}</strong>
            </div>
          ) : null}
          {report.articlesCreated.length > 0 ? (
            <small>
              {uiText("ui.library.articlesCreated", uiLanguage, {
                count: String(report.articlesCreated.length),
              })}
            </small>
          ) : null}
          {report.skippedDisabled.length > 0 ? (
            <small>
              {uiText("ui.library.skippedDisabled", uiLanguage)}
              {"："}
              {report.skippedDisabled.join("、")}
            </small>
          ) : null}
          {report.warnings.length > 0 ? (
            <small>
              {uiText("ui.library.warnings", uiLanguage)}
              {"："}
              {report.warnings.join("；")}
            </small>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
