"use client";

import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { uiText, type UiLanguage } from "../../modules/i18n/public.ts";
import type { ActionAffordance, VisibilityProposal } from "./record-types";

interface MessageComposerProps {
  disabled: boolean;
  affordances: readonly ActionAffordance[];
  /** 回合后的下一步对话提案（纸签快捷入口，点击填入输入框确认后送出）。 */
  suggestions?: readonly string[];
  /** 界面语言（缺省 zh-CN）。 */
  uiLanguage?: UiLanguage;
  visibilityProposal: VisibilityProposal | null;
  interrupt?: { active: boolean; onClick: () => void };
  onSubmit: (
    content: string,
    actionSelection?: { affordanceId: string },
    visibilityConfirmation?: {
      proposalId: string;
      decision: "public" | "restricted";
    },
  ) => Promise<boolean>;
  onVisibilityCancel: () => void;
}

export function MessageComposer({
  disabled,
  affordances,
  suggestions = [],
  uiLanguage = "zh-CN",
  visibilityProposal,
  interrupt,
  onSubmit,
  onVisibilityCancel,
}: MessageComposerProps) {
  const [content, setContent] = useState("");
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [selected, setSelected] = useState<ActionAffordance | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  async function submit(visibilityDecision?: "public" | "restricted") {
    const trimmed = content.trim();
    if (!trimmed || disabled) return;
    if (visibilityProposal && !visibilityDecision) return;
    const pendingSelection = selected;
    setContent("");
    setSelected(null);
    setIsPanelOpen(false);
    const didCommit = await onSubmit(
      trimmed,
      pendingSelection ? { affordanceId: pendingSelection.id } : undefined,
      visibilityDecision && visibilityProposal
        ? {
            proposalId: visibilityProposal.proposalId,
            decision: visibilityDecision,
          }
        : undefined,
    );
    if (!didCommit) {
      setContent(trimmed);
      setSelected(pendingSelection);
    }
    inputRef.current?.focus();
  }

  function chooseAffordance(affordance: ActionAffordance) {
    setSelected(affordance);
    setIsPanelOpen(false);
    setContent((current) => current.trim() ? current : affordance.suggestedText);
    inputRef.current?.focus();
  }

  function chooseSuggestion(suggestion: string) {
    // 提案只填入输入框并聚焦，由玩家确认后送出（规范 3.2：
    // 与草稿恢复/幂等共用一条提交通道，送出前可改字）。
    setContent(suggestion);
    inputRef.current?.focus();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  }

  return (
    <form className="message-composer" onSubmit={handleSubmit}>
      <div className="composer-heading">
        <label htmlFor="realm-message">{uiText("ui.composer.label", uiLanguage)}</label>
        <span>{uiText("ui.composer.hint", uiLanguage)}</span>
      </div>
      {selected ? (
        <div className="selected-affordance">
          <span>{kindLabel(selected.kind, uiLanguage)}</span>
          <strong>{selected.title}</strong>
          <small>{selected.actorName}</small>
          <button
            aria-label={`移除${selected.title}`}
            disabled={disabled}
            onClick={() => setSelected(null)}
            type="button"
          >×</button>
        </div>
      ) : null}
      {!disabled && suggestions.length > 0 ? (
        <div className="suggestion-row" aria-label={uiText("ui.suggestion.label", uiLanguage)}>
          {suggestions.map((suggestion) => (
            <button
              className="suggestion-slip"
              key={suggestion}
              onClick={() => chooseSuggestion(suggestion)}
              type="button"
            >
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}
      <div className="composer-row">
        <button
          aria-expanded={isPanelOpen}
          aria-haspopup="dialog"
          className="affordance-trigger"
          disabled={disabled || affordances.length === 0}
          onClick={() => setIsPanelOpen((current) => !current)}
          type="button"
        >
          <span aria-hidden="true">＋</span>
          <span>{uiText("ui.composer.actions", uiLanguage)}</span>
        </button>
        <textarea
          aria-describedby="composer-hint"
          disabled={disabled}
          id="realm-message"
          maxLength={2000}
          onChange={(event) => {
            if (visibilityProposal) onVisibilityCancel();
            setContent(event.target.value);
          }}
          onKeyDown={handleKeyDown}
          placeholder={uiText("ui.composer.placeholder", uiLanguage)}
          ref={inputRef}
          rows={2}
          value={content}
        />
        <button
          disabled={disabled || !content.trim() || visibilityProposal !== null}
          type="submit"
        >
          <span>{disabled ? uiText("ui.composer.busy", uiLanguage) : uiText("ui.composer.submit", uiLanguage)}</span>
          <span aria-hidden="true">↵</span>
        </button>
      </div>
      {visibilityProposal ? (
        <section aria-label={uiText("ui.visibilityCheck.title", uiLanguage)} className="visibility-proposal">
          <div>
            <span>{uiText("ui.visibilityCheck.body", uiLanguage)}</span>
            <strong>{visibilityProposal.audienceNames.join("、")}</strong>
            <small>{visibilityProposal.reason}</small>
          </div>
          <div className="visibility-proposal-actions">
            <button
              disabled={disabled}
              onClick={() => void submit("restricted")}
              type="button"
            >
              {uiText("ui.visibilityCheck.restricted", uiLanguage)}
            </button>
            <button
              disabled={disabled}
              onClick={() => void submit("public")}
              type="button"
            >
              {uiText("ui.visibilityCheck.public", uiLanguage)}
            </button>
            <button
              aria-label={uiText("ui.visibilityCheck.cancel", uiLanguage)}
              disabled={disabled}
              onClick={onVisibilityCancel}
              type="button"
            >
              ×
            </button>
          </div>
        </section>
      ) : null}
      {isPanelOpen ? (
        <section
          aria-label={uiText("ui.affordance.title", uiLanguage)}
          className="affordance-panel"
          role="dialog"
        >
          <header>
            <div><strong>{uiText("ui.affordance.subtitle", uiLanguage)}</strong><small>{uiText("ui.affordance.note", uiLanguage)}</small></div>
            <button aria-label={uiText("ui.affordance.close", uiLanguage)} onClick={() => setIsPanelOpen(false)} type="button">×</button>
          </header>
          <div className="affordance-list">
            {affordances.map((affordance) => (
              <button
                key={affordance.id}
                onClick={() => chooseAffordance(affordance)}
                type="button"
              >
                <span>{kindLabel(affordance.kind, uiLanguage)}</span>
                <strong>{affordance.title}</strong>
                <small>{affordance.description}</small>
                <i>{affordance.actorName}</i>
              </button>
            ))}
          </div>
        </section>
      ) : null}
      <p id="composer-hint">{uiText("ui.composer.shortcut", uiLanguage)}</p>
      {interrupt?.active ? (
        <button
          className="interrupt-button"
          onClick={interrupt.onClick}
          type="button"
        >
          {uiText("ui.composer.interrupt", uiLanguage)}
        </button>
      ) : null}
    </form>
  );
}

function kindLabel(kind: ActionAffordance["kind"], uiLanguage: UiLanguage): string {
  switch (kind) {
    case "skill": return uiText("ui.affordance.skill", uiLanguage);
    case "asset": return uiText("ui.affordance.asset", uiLanguage);
    case "stance": return uiText("ui.affordance.stance", uiLanguage);
    case "scene": return uiText("ui.affordance.scene", uiLanguage);
  }
}
