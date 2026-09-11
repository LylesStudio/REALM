"use client";

import { useState, type FormEvent } from "react";
import type { WorldGenesisDraft } from "../../modules/application/world-genesis.ts";
import { uiText, type UiLanguage } from "../../modules/i18n/public.ts";
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
 * 司卷问答：全屏对话式引导创世。
 * 规范见 docs/development/UI-GUIDED-GENESIS.md。
 */

interface GuidedGenesisProps {
  playerName: string;
  /** 界面语言（缺省 zh-CN）。 */
  uiLanguage?: UiLanguage;
  onSuggest: (input: {
    step: GuidedGenesisStep;
    intent: string;
    context: Partial<WorldGenesisDraft>;
  }) => Promise<GenesisSuggestions | null>;
  onConfirm: (draft: WorldGenesisDraft) => Promise<string | null>;
  onOpenRecord: (recordId: string) => void;
  onExit: () => void;
}

type StepId =
  | "world-name"
  | "era"
  | "style"
  | "summary"
  | "story"
  | "player-role"
  | "stance"
  | "companions"
  | "scene"
  | "review";

interface StepDef {
  id: StepId;
  title: string;
  /** 是否允许留白跳过。 */
  skippable: boolean;
  /** 对应 AI 代笔端点步骤；null 表示本步不支持代笔。 */
  suggestStep: GuidedGenesisStep | null;
}

const STEPS: readonly StepDef[] = [
  { id: "world-name", title: "世界之名", skippable: false, suggestStep: "world-name" },
  { id: "era", title: "纪元基调", skippable: true, suggestStep: "era" },
  // 文风步置于纪元之后、底色之前：先时空、后笔调，
  // 其后所有代笔候选与提问语立即按所选文风产出。
  { id: "style", title: "文风", skippable: true, suggestStep: null },
  { id: "summary", title: "世界底色", skippable: true, suggestStep: "summary" },
  { id: "story", title: "故事开篇", skippable: true, suggestStep: "story" },
  { id: "player-role", title: "你的身份", skippable: true, suggestStep: "player-role" },
  // 批次 S：你的姿态（入局 / 观察者）——决定落库席位形态。
  { id: "stance", title: "你的姿态", skippable: true, suggestStep: null },
  { id: "companions", title: "同行之人", skippable: true, suggestStep: "companions" },
  { id: "scene", title: "初始场景", skippable: true, suggestStep: "scene" },
  { id: "review", title: "合卷总览", skippable: false, suggestStep: null },
];

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
  if (draft.world.name) entries.push({ key: "world-name", label: "世界之名", value: draft.world.name });
  if (draft.world.era) entries.push({ key: "era", label: "纪元基调", value: draft.world.era });
  if (draft.style !== "modern") {
   entries.push({
     key: "style",
     label: "文风",
     value: worldStyleText(`guided.style.${draft.style}`, draft.style, undefined, uiLanguage),
   });
 }
  if (draft.world.summary) entries.push({ key: "summary", label: "世界底色", value: draft.world.summary });
  if (draft.story.title) {
    entries.push({
      key: "story",
      label: "故事开篇",
      value: draft.story.premise
        ? `${draft.story.title}——${draft.story.premise}`
        : draft.story.title,
    });
  }
  if (draft.playerRole) entries.push({ key: "player-role", label: "你的身份", value: draft.playerRole });
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
        label: "同行之人",
        value: companion.role ? `${companion.name} · ${companion.role}` : companion.name,
      });
    }
  }
  const scene = [
    draft.scene.location,
    draft.scene.weather,
    draft.scene.tension,
    draft.scene.objective,
  ].filter((part) => part.length > 0);
  if (scene.length > 0) entries.push({ key: "scene", label: "初始场景", value: scene.join(" · ") });
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
  uiLanguage = "zh-CN",
  onSuggest,
  onConfirm,
  onOpenRecord,
  onExit,
}: GuidedGenesisProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [draft, setDraft] = useState<WorldGenesisDraft>(EMPTY_DRAFT);
  const [text, setText] = useState("");
  const [storyTitle, setStoryTitle] = useState("");
  const [storyPremise, setStoryPremise] = useState("");
  const [suggestions, setSuggestions] = useState<GenesisSuggestions | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const step = STEPS[stepIndex]!;
  const entries = scrollEntries(draft, uiLanguage);

  function resetStepState() {
    setText("");
    setStoryTitle("");
    setStoryPremise("");
    setSuggestions(null);
  }

  function advance(nextDraft: WorldGenesisDraft) {
    setDraft(nextDraft);
    resetStepState();
    setStepIndex((index) => Math.min(index + 1, STEPS.length - 1));
  }

  function currentValue(): string {
    if (step.id === "story") return storyTitle.trim();
    return text.trim();
  }

  function confirmStep(event?: FormEvent) {
    event?.preventDefault();
    const value = currentValue();
    if (step.id === "world-name" && !value) return;
    if (step.id === "world-name") {
      advance({ ...draft, world: { ...draft.world, name: value } });
    } else if (step.id === "era") {
      advance({ ...draft, world: { ...draft.world, era: value } });
    } else if (step.id === "summary") {
      advance({ ...draft, world: { ...draft.world, summary: value } });
    } else if (step.id === "story") {
      advance({
        ...draft,
        story: { title: value || "序章", premise: storyPremise.trim() },
        record: { title: "第一笔" },
      });
    } else if (step.id === "player-role") {
      advance({ ...draft, playerRole: value });
    }
  }

  function skipStep() {
    if (step.id === "story") {
      advance({ ...draft, story: { title: "序章", premise: "" }, record: { title: "第一笔" } });
      return;
    }
    advance(draft);
  }

  async function requestSuggestions() {
    if (!step.suggestStep || busy) return;
    setBusy(true);
    try {
      const result = await onSuggest({
        step: step.suggestStep,
        intent: currentValue() || text.trim(),
        context: draft,
      });
      // fail-closed：null 即静默退回手动输入，不清空已输入内容。
      if (result) setSuggestions(result);
    } finally {
      setBusy(false);
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

  function inviteCompanion(companion: CompanionSuggestion) {
    // 邀请后停留本步：可再邀一位（至多两位），或点「就这些 ▸」继续。
    setDraft({
      ...draft,
      companions: [...draft.companions, companion].slice(0, 2),
    });
    setSuggestions(null);
  }

  function pickSceneSuggestion(scene: SceneSuggestions, field: keyof SceneSuggestions, value: string) {
    advance({ ...draft, scene: { ...draft.scene, [field]: value } });
    void scene;
  }

  async function sealWorld() {
    if (confirming) return;
    setConfirming(true);
    try {
      const recordId = await onConfirm(draft);
      if (recordId) onOpenRecord(recordId);
    } finally {
      setConfirming(false);
    }
  }

  return (
    <div className="guided-genesis" role="dialog" aria-label="司卷问答">
      <header className="guided-heading">
        <div>
          <p className="eyebrow">{uiText("ui.guided.eyebrow", uiLanguage)}</p>
          <h2>{step.title}</h2>
        </div>
        <button aria-label={uiText("ui.guided.exit", uiLanguage)} onClick={onExit} type="button">×</button>
      </header>

      <div className="guided-layout">
        <main className="guided-dialogue">
          <div className="guided-question">
            <span className="guided-seal" aria-hidden="true">卷</span>
            <p>{worldStyleText(`guided.step.${step.id}.question`, draft.style, undefined, uiLanguage)}</p>
          </div>

          {step.id === "style" ? (
            <div className="guided-input-area">
              <p className="guided-note">{uiText("ui.guided.styleNote", uiLanguage)}</p>
              <div className="guided-style-options" role="group" aria-label="文风选项">
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
                aria-label={`${step.title}输入`}
                className="guided-input"
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
                  aria-label="故事缘起输入"
                  className="guided-input"
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
              <textarea
                aria-label="同行者意向输入"
                className="guided-input"
                onChange={(event) => setText(event.target.value)}
                placeholder={uiText("ui.guided.companionPlaceholder", uiLanguage)}
                rows={2}
                value={text}
              />
              <GuidedActions
                busy={busy}
                canConfirm={false}
                hideConfirm
                onSuggest={requestSuggestions}
                onSkip={draft.companions.length > 0
                  ? () => advance(draft)
                  : skipStep}
                skipLabelKey={draft.companions.length > 0
                  ? "ui.guided.companionsDone"
                  : "ui.guided.companionsSolo"}
                uiLanguage={uiLanguage}
              />
            </div>
          ) : null}

          {step.id === "scene" ? (
            <div className="guided-input-area">
              <p className="guided-note">{uiText("ui.guided.sceneNote", uiLanguage)}</p>
              <GuidedActions
                busy={busy}
                canConfirm={false}
                hideConfirm
                onSuggest={requestSuggestions}
                onSkip={() => advance(draft)}
                skipLabelKey={scrollEntries(draft, uiLanguage).some((entry) => entry.key === "scene")
                  ? "ui.guided.sceneDone"
                  : "ui.guided.sceneBlank"}
                uiLanguage={uiLanguage}
              />
            </div>
          ) : null}

          {suggestions && step.id !== "companions" && step.id !== "scene" ? (
            <ul className="guided-suggestions" aria-label="代笔候选">
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
            <ul className="guided-suggestions" aria-label="同行者候选">
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
            <div className="guided-suggestions guided-scene-suggestions" aria-label="场景候选">
              {(["location", "weather", "tension", "objective"] as const).map((field) => {
                const sceneSuggestions = (suggestions as SceneSuggestions)[field];
                if (!sceneSuggestions || sceneSuggestions.length === 0) return null;
                const label = field === "location" ? "地点"
                  : field === "weather" ? "天气"
                  : field === "tension" ? "局势"
                  : "当前目标";
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
                disabled={confirming}
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

        <aside className="guided-scroll" aria-label="已定之卷">
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
