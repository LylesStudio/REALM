"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  GENESIS_LIMITS,
  MAX_COMPANIONS,
  type WorldGenesisDraft,
} from "../../modules/application/world-genesis-contract.ts";
import { uiText, normalizeUiLanguage, type UiLanguage } from "../../modules/i18n/public.ts";
import {
  WORLD_STYLE_KEYS,
  worldStyleText,
  type WorldStyle,
} from "../../modules/style/world-style.ts";
import type {
  CompanionSuggestion,
  GenesisSuggestions,
  GuidedGenesisStep,
  SceneSuggestions,
} from "../../modules/application/genesis-suggestions.ts";

/**
 * AI 引导创建：全屏分步问答。
 * 规范见 docs/development/UI-GUIDED-GENESIS.md。
 */

import {
  addCompanionRow,
  applyStepConfirm,
  inviteCompanionRow,
  isSuggestionsForStep,
  namedCompanionCount,
  patchCompanionField,
  patchSceneField,
  removeCompanionAt,
  sceneHasContent,
  stepSavedValue,
  type GuidedStepId as StepId,
  type ScenePatchField,
} from "./guided-genesis-steps.ts";
import type { GenesisChatFallback } from "./guided-genesis-chat.tsx";
import { GenesisDraftFields } from "./genesis-draft-fields";
import { goalDraftsValid } from './record-goal-fields.tsx';

interface GuidedGenesisProps {
  playerName: string;
  /** 创建结果无法确认时显示安全提示，不透传服务端原始错误。 */
  creationError?: string | null;
  /** 界面语言（缺省 zh-CN）。 */
  uiLanguage?: UiLanguage;
  /**
   * 对谈失败改用分步引导时移交的上下文：草案从该 draft 初始化（而非
   * EMPTY_DRAFT），对谈历史与未发送文本在侧栏恢复面板中可见、可编辑；
   * 未发送文本独立于表单，绝不伪装成历史 turn，也不随创建提交。
   */
  fallback?: GenesisChatFallback | null;
  /**
   * AI 代写：suggestions 为 null 时 errorMessage 给出安全提示
   * （绝不含 key/URL/prompt/玩家内容）；手动填写随时可继续。
   */
  onSuggest: (input: {
    step: GuidedGenesisStep;
    intent: string;
    context: Partial<WorldGenesisDraft>;
  }) => Promise<{
    suggestions: GenesisSuggestions | null;
    errorMessage: string | null;
  }>;
  onConfirm: (draft: WorldGenesisDraft) => Promise<string | null>;
  onOpenRecord: (recordId: string) => void;
  onExit: () => void;
}

interface StepDef {
  id: StepId;
  /** 是否允许跳过（不填写）。 */
  skippable: boolean;
  /** 对应 AI 代笔端点步骤；null 表示本步不支持代笔。 */
  suggestStep: GuidedGenesisStep | null;
}

const STEP_TITLE_KEYS: Record<StepId, string> = {
  "world-name": "ui.guided.step.worldName",
  era: "ui.guided.step.era",
  style: "ui.guided.step.style",
  summary: "ui.guided.step.summary",
  story: "ui.guided.step.story",
  "player-role": "ui.guided.step.playerRole",
  stance: "ui.guided.step.stance",
  companions: "ui.guided.step.companions",
  scene: "ui.guided.step.scene",
  review: "ui.guided.step.review",
};

const STEPS: readonly StepDef[] = [
  { id: "world-name", skippable: false, suggestStep: "world-name" },
  { id: "era", skippable: true, suggestStep: "era" },
  // 文风步置于时代之后、概述之前：先时空、后笔调。
  { id: "style", skippable: true, suggestStep: null },
  { id: "summary", skippable: true, suggestStep: "summary" },
  { id: "story", skippable: true, suggestStep: "story" },
  { id: "player-role", skippable: true, suggestStep: "player-role" },
  // 批次 S：参与方式（扮演角色 / 观察者）——决定落库席位形态。
  { id: "stance", skippable: true, suggestStep: null },
  { id: "companions", skippable: true, suggestStep: "companions" },
  { id: "scene", skippable: true, suggestStep: "scene" },
  { id: "review", skippable: false, suggestStep: null },
];

const SCENE_EDITOR_FIELDS: readonly {
  field: ScenePatchField;
  labelKey: string;
  maxLength: number;
}[] = [
  { field: "title", labelKey: "ui.guided.scene.title", maxLength: GENESIS_LIMITS.sceneTitle },
  { field: "location", labelKey: "ui.guided.scene.location", maxLength: GENESIS_LIMITS.sceneField },
  { field: "weather", labelKey: "ui.guided.scene.weather", maxLength: GENESIS_LIMITS.sceneField },
  { field: "tension", labelKey: "ui.guided.scene.tension", maxLength: GENESIS_LIMITS.sceneField },
  { field: "displayTime", labelKey: "ui.guided.scene.displayTime", maxLength: GENESIS_LIMITS.displayTime },
  { field: "objective", labelKey: "ui.guided.scene.objective", maxLength: GENESIS_LIMITS.objective },
];

const STEP_QUESTION_TEMPLATE_KEYS: Record<StepId, string> = {
  "world-name": "guided.step.world-name.question",
  era: "guided.step.era.question",
  style: "guided.step.style.question",
  summary: "guided.step.summary.question",
  story: "guided.step.story.question",
  "player-role": "guided.step.player-role.question",
  stance: "guided.step.stance.question",
  companions: "guided.step.companions.question",
  scene: "guided.step.scene.question",
  review: "guided.step.review.question",
};

interface ScrollEntry {
  key: string;
  label: string;
  value: string;
}

function scrollEntries(
  draft: WorldGenesisDraft,
  uiLanguage: UiLanguage = "zh-CN",
): ScrollEntry[] {
  const entries: ScrollEntry[] = [];
  if (draft.world.name) {
    entries.push({
      key: "world-name",
      label: uiText(STEP_TITLE_KEYS["world-name"], uiLanguage),
      value: draft.world.name,
    });
  }
  if (draft.world.era) {
    entries.push({ key: "era", label: uiText(STEP_TITLE_KEYS.era, uiLanguage), value: draft.world.era });
  }
  if (draft.style !== "modern") {
    entries.push({
      key: "style",
      label: uiText(STEP_TITLE_KEYS.style, uiLanguage),
      value: worldStyleText(`guided.style.${draft.style}`, draft.style, undefined, uiLanguage),
    });
  }
  if (draft.world.summary) {
    entries.push({
      key: "summary",
      label: uiText(STEP_TITLE_KEYS.summary, uiLanguage),
      value: draft.world.summary,
    });
  }
  if (draft.story.title) {
    entries.push({
      key: "story",
      label: uiText(STEP_TITLE_KEYS.story, uiLanguage),
      value: draft.story.premise
        ? `${draft.story.title}——${draft.story.premise}`
        : draft.story.title,
    });
  }
  if (draft.playerRole) {
    entries.push({
      key: "player-role",
      label: uiText(STEP_TITLE_KEYS["player-role"], uiLanguage),
      value: draft.playerRole,
    });
  }
  if (draft.playerStance === "observer") {
    entries.push({
      key: "stance",
      label: uiText("ui.stance.label", uiLanguage),
      value: uiText("ui.stance.observer", uiLanguage),
    });
  }
  for (const [index, companion] of draft.companions.entries()) {
    if (companion.name) {
      entries.push({
        key: `companion-${index}`,
        label: uiText(STEP_TITLE_KEYS.companions, uiLanguage),
        value: companion.role ? `${companion.name} · ${companion.role}` : companion.name,
      });
    }
  }
  const scene = [
    draft.scene.title,
    draft.scene.location,
    draft.scene.weather,
    draft.scene.tension,
    draft.scene.displayTime,
    draft.scene.objective,
  ].filter((part): part is string => typeof part === "string" && part.length > 0);
  if (scene.length > 0) {
    entries.push({
      key: "scene",
      label: uiText(STEP_TITLE_KEYS.scene, uiLanguage),
      value: scene.join(" · "),
    });
  }
  return entries;
}

const EMPTY_DRAFT: WorldGenesisDraft = {
  world: { name: "", era: "", summary: "" },
  style: "modern",
  story: { title: "", premise: "" },
  record: { title: "" },
  playerRole: "",
  companions: [],
  scene: { location: "", weather: "", tension: "", objective: "" },
  playerStance: "player",
  opening: "",
};

export function GuidedGenesis({
  playerName,
  creationError = null,
  uiLanguage = "zh-CN",
  fallback = null,
  onSuggest,
  onConfirm,
  onOpenRecord,
  onExit,
}: GuidedGenesisProps) {
  // 对谈 fallback：草案与首步字段都从移交的 draft 初始化（可改、可继续）；
  // 无 fallback 时维持 EMPTY_DRAFT 的既有「重开从头」语义。
  const seedDraft = fallback?.draft ?? EMPTY_DRAFT;
  const initialDraft = { ...seedDraft, language: seedDraft.language ?? normalizeUiLanguage(uiLanguage) };
  const initialStepValues = stepSavedValue(STEPS[0]!.id, initialDraft);
  const [stepIndex, setStepIndex] = useState(0);
  const [draft, setDraft] = useState<WorldGenesisDraft>(initialDraft);
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  const [text, setText] = useState(initialStepValues.text);
  const [storyTitle, setStoryTitle] = useState(initialStepValues.storyTitle);
  const [storyPremise, setStoryPremise] = useState(initialStepValues.storyPremise);
  const [suggestions, setSuggestions] = useState<GenesisSuggestions | null>(null);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const suggestionGeneration = useRef(0);
  const suggestionBusy = useRef(false);
  const confirmingRef = useRef(false);
  useEffect(() => () => { suggestionGeneration.current += 1; }, []);

  function invalidateSuggestions() {
    suggestionGeneration.current += 1;
    suggestionBusy.current = false;
    setBusy(false);
  }

  const step = STEPS[stepIndex]!;
  const stepTitle = uiText(STEP_TITLE_KEYS[step.id], uiLanguage);
  const entries = scrollEntries(draft, uiLanguage);

  function resetStepState(stepId: StepId, sourceDraft: WorldGenesisDraft) {
    const saved = stepSavedValue(stepId, sourceDraft);
    setText(saved.text);
    setStoryTitle(saved.storyTitle);
    setStoryPremise(saved.storyPremise);
    setSuggestions(null);
    setSuggestError(null);
  }

  function advance(nextDraft: WorldGenesisDraft) {
    invalidateSuggestions();
    draftRef.current = nextDraft;
    const nextIndex = Math.min(stepIndex + 1, STEPS.length - 1);
    setDraft(nextDraft);
    resetStepState(STEPS[nextIndex]!.id, nextDraft);
    setStepIndex(nextIndex);
  }

  /** 回退：把上一步已保存的值重新填回输入控件，不丢任何后续内容。 */
  function goBack() {
    if (stepIndex === 0 || confirmingRef.current) return;
    invalidateSuggestions();
    const saved = applyStepConfirm(step.id, draftRef.current, { text, storyTitle, storyPremise });
    draftRef.current = saved;
    setDraft(saved);
    const previousIndex = stepIndex - 1;
    resetStepState(STEPS[previousIndex]!.id, saved);
    setStepIndex(previousIndex);
  }

  function currentValue(): string {
    if (step.id === "story") return storyTitle.trim();
    return text.trim();
  }

  function confirmStep(event?: FormEvent) {
    event?.preventDefault();
    if (step.id === "world-name" && !currentValue()) return;
    advance(applyStepConfirm(step.id, draft, { text, storyTitle, storyPremise }));
  }

  function skipStep() {
    if (step.id === "story") {
      advance({
        ...draft,
        story: {
          title: draft.story.title || uiText("ui.guided.defaultStoryTitle", uiLanguage),
          premise: draft.story.premise,
        },
        record: draft.record.title ? draft.record : { title: uiText("ui.guided.defaultRecordTitle", uiLanguage) },
      });
      return;
    }
    advance(draft);
  }

  async function requestSuggestions() {
    if (!step.suggestStep || suggestionBusy.current || confirmingRef.current) return;
    suggestionBusy.current = true;
    const generation = ++suggestionGeneration.current;
    setBusy(true);
    setSuggestError(null);
    setSuggestions(null);
    try {
      const result = await onSuggest({
        step: step.suggestStep,
        intent: currentValue() || text.trim(),
        context: draftRef.current,
      });
      // AI 失败给出可见安全提示（可重试）；手动填写随时可继续。
      if (generation !== suggestionGeneration.current) return;
      if (isSuggestionsForStep(step.id, result.suggestions)) {
        setSuggestions(result.suggestions);
      } else {
        setSuggestError(
          result.errorMessage
            ?? uiText("ui.guided.suggestFailed", uiLanguage),
        );
      }
    } catch {
      if (generation === suggestionGeneration.current) setSuggestError(uiText("ui.guided.suggestFailed", uiLanguage));
    } finally {
      if (generation === suggestionGeneration.current) {
        suggestionBusy.current = false;
        setBusy(false);
      }
    }
  }

  function pickTextSuggestion(value: string) {
    if (step.id === "story") {
      const splitAt = value.indexOf("——");
      if (splitAt > 0) {
        setStoryTitle(value.slice(0, splitAt));
        setStoryPremise(value.slice(splitAt + 2));
      } else {
        setStoryTitle(value);
      }
    } else {
      setText(value);
    }
    setSuggestions(null);
  }

  function finishStep(stepId: "companions" | "scene") {
    const current = draftRef.current;
    advance(applyStepConfirm(stepId, current, stepSavedValue(stepId, current)));
  }

  function inviteCompanion(companion: CompanionSuggestion) {
    // 邀请后停留本步：可再邀一位（至多两位），或点「就这些」继续。
    setDraft((current) => inviteCompanionRow(current, companion));
    setSuggestions(null);
  }

  function pickSceneSuggestion(_scene: SceneSuggestions, field: keyof SceneSuggestions, value: string) {
    // 点选只更新对应字段并停留在本步骤——其余字段可继续填写。
    setDraft((current) => patchSceneField(current, field, value));
  }

  async function sealWorld() {
    if (confirmingRef.current || suggestionBusy.current || !draft.world.name.trim() || !goalDraftsValid(draft.recordGoals)) return;
    confirmingRef.current = true;
    setConfirming(true);
    try {
      const recordId = await onConfirm(draft);
      if (recordId) onOpenRecord(recordId);
    } finally {
      confirmingRef.current = false;
      setConfirming(false);
    }
  }

  return (
    <div className="guided-genesis">
      <header className="guided-heading">
        <div>
          <p className="eyebrow">{uiText("ui.guided.eyebrow", uiLanguage)}</p>
          <h2>{stepTitle}</h2>
        </div>
        <div className="guided-heading-actions">
          {stepIndex > 0 ? (
            <button
              aria-label={uiText("ui.guided.back", uiLanguage)}
              className="guided-back"
              disabled={confirming}
              onClick={goBack}
              type="button"
            >
              {uiText("ui.guided.back", uiLanguage)}
            </button>
          ) : null}
          <button aria-label={uiText("ui.guided.exit", uiLanguage)} onClick={onExit} type="button">×</button>
        </div>
      </header>

      <div className="guided-layout">
        <main className="guided-dialogue">
          <div className="guided-question">
            <span className="guided-seal" aria-hidden="true">AI</span>
            <p>{worldStyleText(STEP_QUESTION_TEMPLATE_KEYS[step.id], draft.style, undefined, uiLanguage)}</p>
          </div>

          {creationError ? (
            <div className="guided-suggest-error guided-create-error" role="alert">
              <p>{creationError}</p>
            </div>
          ) : null}

          {suggestError ? (
            <div className="guided-suggest-error" role="alert">
              <p>{suggestError}</p>
              <button
                disabled={busy}
                onClick={() => void requestSuggestions()}
                type="button"
              >
                {busy
                  ? uiText("ui.guided.suggesting", uiLanguage)
                  : uiText("ui.guided.suggestRetry", uiLanguage)}
              </button>
            </div>
          ) : null}

          {step.id === "style" ? (
            <div className="guided-input-area">
              <p className="guided-note">{uiText("ui.guided.styleNote", uiLanguage)}</p>
              <div className="guided-style-options" role="group" aria-label={uiText(STEP_TITLE_KEYS.style, uiLanguage)}>
                {WORLD_STYLE_KEYS.map((key) => (
                  <button
                    className={draft.style === key ? "guided-style-option is-active" : "guided-style-option"}
                    key={key}
                    onClick={() => {
                      advance({ ...draft, style: key as WorldStyle });
                    }}
                    type="button"
                  >
                    {worldStyleText(`guided.style.${key}`, key as WorldStyle, undefined, uiLanguage)}
                  </button>
                ))}
              </div>
              <GuidedActions
                busy={busy}
                canConfirm={false}
                hideConfirm
                onSuggest={null}
                onSkip={skipStep}
                uiLanguage={uiLanguage}
              />
            </div>
          ) : null}

          {step.id === "stance" ? (
            <div className="guided-input-area">
              <div className="stance-options" role="group" aria-label={uiText("ui.stance.label", uiLanguage)}>
                <button
                  className={draft.playerStance !== "observer"
                    ? "stance-option is-active"
                    : "stance-option"}
                  onClick={() => advance({ ...draft, playerStance: "player" })}
                  type="button"
                >
                  <strong>{uiText("ui.stance.player", uiLanguage)}</strong>
                  <small>{uiText("ui.stance.playerHint", uiLanguage)}</small>
                </button>
                <button
                  className={draft.playerStance === "observer"
                    ? "stance-option is-active"
                    : "stance-option"}
                  onClick={() => advance({ ...draft, playerStance: "observer" })}
                  type="button"
                >
                  <strong>{uiText("ui.stance.observer", uiLanguage)}</strong>
                  <small>{uiText("ui.stance.observerHint", uiLanguage)}</small>
                </button>
              </div>
              <GuidedActions
                busy={busy}
                canConfirm={false}
                hideConfirm
                onSuggest={null}
                onSkip={skipStep}
                uiLanguage={uiLanguage}
              />
            </div>
          ) : null}

          {step.id !== "review" && step.id !== "companions" && step.id !== "scene" && step.id !== "style" && step.id !== "stance" ? (
            <form className="guided-input-area" onSubmit={confirmStep}>
              {step.id === "player-role" ? (
                <p className="guided-note">
                  {uiText("ui.guided.playerNote", uiLanguage, { name: playerName })}
                </p>
              ) : null}
              <textarea
                aria-label={`${stepTitle}${uiText("ui.guided.inputSuffix", uiLanguage)}`}
                className="guided-input"
                maxLength={step.id === "world-name" ? GENESIS_LIMITS.worldName : step.id === "era" ? GENESIS_LIMITS.era : step.id === "summary" ? GENESIS_LIMITS.summary : step.id === "story" ? GENESIS_LIMITS.storyTitle : GENESIS_LIMITS.playerRole}
                onChange={(event) => {
                  if (step.id === "story") setStoryTitle(event.target.value);
                  else setText(event.target.value);
                }}
                placeholder={
                  step.skippable
                    ? uiText("ui.guided.intentPlaceholder", uiLanguage)
                    : uiText("ui.guided.worldNamePlaceholder", uiLanguage)
                }
                rows={step.id === "summary" ? 4 : 2}
                value={step.id === "story" ? storyTitle : text}
              />
              {step.id === "story" ? (
                <textarea
                  aria-label={uiText("ui.guided.storyPremiseLabel", uiLanguage)}
                  className="guided-input"
                  maxLength={GENESIS_LIMITS.premise}
                  onChange={(event) => setStoryPremise(event.target.value)}
                  placeholder={uiText("ui.guided.storyPremisePlaceholder", uiLanguage)}
                  rows={2}
                  value={storyPremise}
                />
              ) : null}
              <GuidedActions
                busy={busy}
                canConfirm={step.id !== "world-name" || text.trim().length > 0}
                onSuggest={step.suggestStep ? requestSuggestions : null}
                onSkip={step.skippable ? skipStep : null}
                uiLanguage={uiLanguage}
              />
            </form>
          ) : null}

          {step.id === "companions" ? (
            <div className="guided-input-area">
              <p className="guided-note">{uiText("ui.guided.companionNote", uiLanguage)}</p>
              <div className="guided-companion-editor">
                {draft.companions.map((companion, index) => (
                  <div className="companion-row" key={`companion-${index}`}>
                    <input
                      aria-label={`${uiText("ui.guided.companionName", uiLanguage)} ${index + 1}`}
                      maxLength={GENESIS_LIMITS.companionName}
                      onChange={(event) => {
                        const value = event.target.value;
                        setDraft((current) => patchCompanionField(current, index, "name", value));
                      }}
                      placeholder={uiText("ui.guided.companionName", uiLanguage)}
                      value={companion.name}
                    />
                    <input
                      aria-label={`${uiText("ui.guided.companionRole", uiLanguage)} ${index + 1}`}
                      maxLength={GENESIS_LIMITS.companionRole}
                      onChange={(event) => {
                        const value = event.target.value;
                        setDraft((current) => patchCompanionField(current, index, "role", value));
                      }}
                      placeholder={uiText("ui.guided.companionRole", uiLanguage)}
                      value={companion.role}
                    />
                    <input
                      aria-label={`${uiText("ui.guided.companionSummary", uiLanguage)} ${index + 1}`}
                      maxLength={GENESIS_LIMITS.companionSummary}
                      onChange={(event) => {
                        const value = event.target.value;
                        setDraft((current) => patchCompanionField(current, index, "summary", value));
                      }}
                      placeholder={uiText("ui.guided.companionSummary", uiLanguage)}
                      value={companion.summary}
                    />
                    <button
                      aria-label={`${uiText("ui.guided.companionRemove", uiLanguage)} ${index + 1}`}
                      onClick={() => setDraft((current) => removeCompanionAt(current, index))}
                      type="button"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              {draft.companions.length < MAX_COMPANIONS ? (
                <button
                  className="companion-add"
                  onClick={() => setDraft((current) => addCompanionRow(current))}
                  type="button"
                >
                  ＋ {uiText("ui.guided.companionAdd", uiLanguage)}
                </button>
              ) : null}
              <GuidedActions
                busy={busy}
                canConfirm={false}
                hideConfirm
                onSuggest={requestSuggestions}
                onSkip={() => finishStep("companions")}
                skipLabelKey={namedCompanionCount(draft) > 0
                  ? "ui.guided.companionsDone"
                  : "ui.guided.companionsSolo"}
                uiLanguage={uiLanguage}
              />
            </div>
          ) : null}

          {step.id === "scene" ? (
            <div className="guided-input-area">
              <p className="guided-note">{uiText("ui.guided.sceneNote", uiLanguage)}</p>
              <div className="guided-structured scene-grid">
                {SCENE_EDITOR_FIELDS.map((entry) => (
                  <label key={entry.field}>
                    <span>{uiText(entry.labelKey, uiLanguage)}</span>
                    <input
                      aria-label={uiText(entry.labelKey, uiLanguage)}
                      className="guided-input"
                      maxLength={entry.maxLength}
                      onChange={(event) => {
                        const value = event.target.value;
                        setDraft((current) => patchSceneField(current, entry.field, value));
                      }}
                      value={draft.scene[entry.field] ?? ""}
                    />
                  </label>
                ))}
              </div>
              <GuidedActions
                busy={busy}
                canConfirm={false}
                hideConfirm
                onSuggest={requestSuggestions}
                onSkip={() => finishStep("scene")}
                skipLabelKey={sceneHasContent(draft)
                  ? "ui.guided.sceneDone"
                  : "ui.guided.sceneBlank"}
                uiLanguage={uiLanguage}
              />
            </div>
          ) : null}

          {suggestions && isSuggestionsForStep(step.id, suggestions) && step.id !== "companions" && step.id !== "scene" ? (
            <ul className="guided-suggestions" aria-label={uiText("ui.guided.textSuggestionsLabel", uiLanguage)}>
              {(suggestions as string[]).map((item) => (
                <li key={item}>
                  <button onClick={() => pickTextSuggestion(item)} type="button">
                    {item}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {suggestions && step.id === "companions" ? (
            <ul className="guided-suggestions" aria-label={uiText("ui.guided.companionSuggestionsLabel", uiLanguage)}>
              {(suggestions as CompanionSuggestion[]).map((companion) => (
                <li key={companion.name}>
                  <button onClick={() => inviteCompanion(companion)} type="button">
                    <strong>{companion.name}</strong>
                    {companion.role ? <small>{companion.role}</small> : null}
                    {companion.summary ? <span>{companion.summary}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {suggestions && step.id === "scene" ? (
            <div className="guided-suggestions guided-scene-suggestions" aria-label={uiText("ui.guided.sceneSuggestionsLabel", uiLanguage)}>
              {(["location", "weather", "tension", "objective"] as const).map((field) => {
                const sceneSuggestions = (suggestions as SceneSuggestions)[field];
                if (!sceneSuggestions || sceneSuggestions.length === 0) return null;
                const label = uiText(`ui.guided.scene.${field}`, uiLanguage);
                return (
                  <div className="guided-scene-field" key={field}>
                    <p className="eyebrow">{label}</p>
                    <ul>
                      {sceneSuggestions.map((item) => (
                        <li key={item}>
                          <button
                            onClick={() => pickSceneSuggestion(suggestions as SceneSuggestions, field, item)}
                            type="button"
                          >
                            {item}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          ) : null}

          {step.id === "review" ? (
            <div className="guided-review">
              <GenesisDraftFields draft={draft} uiLanguage={uiLanguage} disabled={confirming}
                patchDraft={(update) => {
                  const next = update(draftRef.current);
                  draftRef.current = next;
                  setDraft(next);
                }} />
              <div className="guided-review-scroll">
                {entries.map((entry) => (
                  <div className="guided-review-row" key={entry.key}>
                    <span>{entry.label}</span>
                    <p>{entry.value}</p>
                  </div>
                ))}
              </div>
              <button
                className="guided-seal-button"
                disabled={confirming || busy || !draft.world.name.trim() || !goalDraftsValid(draft.recordGoals)}
                onClick={() => void sealWorld()}
                type="button"
              >
                {confirming
                  ? uiText("ui.guided.sealing", uiLanguage)
                  : uiText("ui.guided.seal", uiLanguage)}
              </button>
            </div>
          ) : null}
        </main>

        <aside className="guided-scroll" aria-label={uiText("ui.guided.scroll", uiLanguage)}>
          <p className="eyebrow">{uiText("ui.guided.scroll", uiLanguage)}</p>
          {entries.map((entry) => (
            <div className="scroll-entry" key={entry.key}>
              <span className="scroll-seal" aria-hidden="true">定</span>
              <div>
                <small>{entry.label}</small>
                <p>{entry.value}</p>
              </div>
            </div>
          ))}
          {fallback ? (
            // 对谈恢复面板：置于首步可编辑字段之后（DOM 次序），切换后的
            // 首焦点仍落在创世字段，不被本面板 textarea 抢焦。
            <div
              aria-label={uiText("ui.guided.fallbackRecoveryLabel", uiLanguage)}
              className="guided-fallback-recovery"
            >
              <p className="eyebrow">{uiText("ui.guided.fallbackRecoveryLabel", uiLanguage)}</p>
              {fallback.turns.length > 0 ? (
                <ol className="guided-fallback-turns">
                  {fallback.turns.map((turn, index) => (
                    <li className={turn.role === "user" ? "is-user" : "is-scribe"} key={index}>
                      <small>{turn.role === "user" ? playerName : uiText("ui.genesisChat.scribe", uiLanguage)}</small>
                      <p>{turn.content}</p>
                    </li>
                  ))}
                </ol>
              ) : null}
              {fallback.input.trim() ? (
                <label className="guided-fallback-unsent">
                  <small>{uiText("ui.guided.fallbackUnsentLabel", uiLanguage)}</small>
                  <textarea
                    aria-label={uiText("ui.guided.fallbackUnsentLabel", uiLanguage)}
                    className="guided-input"
                    defaultValue={fallback.input}
                    rows={2}
                  />
                </label>
              ) : null}
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function GuidedActions({
  busy,
  canConfirm,
  hideConfirm = false,
  onSuggest,
  onSkip,
  skipLabelKey,
  uiLanguage,
}: {
  busy: boolean;
  canConfirm: boolean;
  hideConfirm?: boolean;
  onSuggest: (() => void) | null;
  onSkip: (() => void) | null;
  skipLabelKey?: string;
  uiLanguage: UiLanguage;
}) {
  return (
    <div className="guided-actions">
      {onSuggest ? (
        <button
          className="guided-suggest"
          disabled={busy}
          onClick={() => void onSuggest()}
          type="button"
        >
          {busy
            ? uiText("ui.guided.suggesting", uiLanguage)
            : uiText("ui.guided.suggest", uiLanguage)}
        </button>
      ) : null}
      {onSkip ? (
        <button className="guided-skip" onClick={onSkip} type="button">
          {uiText(skipLabelKey ?? "ui.guided.skip", uiLanguage)}
        </button>
      ) : null}
      {!hideConfirm ? (
        <button className="guided-confirm" disabled={!canConfirm} type="submit">
          {uiText("ui.guided.confirm", uiLanguage)}
        </button>
      ) : null}
    </div>
  );
}
