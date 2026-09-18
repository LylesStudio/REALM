"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { uiText, type UiLanguage } from "../../modules/i18n/public.ts";
import {
  buildSemanticReviewChange,
  normalizeSemanticReviewContext,
  normalizeSemanticReviewOutcome,
  semanticReviewErrorKey,
  type SemanticReviewChangeKind,
  type SemanticReviewOutcome,
  type WorldCursor,
} from "./semantic-review-types";
import type { GraphClaim } from "./knowledge-graph-types";

/**
 * 批次 T11-D：单条 Claim 的语义复审面板
 * （public documentation §2/§4）。
 * - 打开表单只读 context（服务端 head 游标），不调用模型；
 *   只有点击「请求复审」才 POST；不自动重试、不轮询；
 * - 结果是复审证据，绝不写入正史，不提供合并按钮；
 * - 表单/busy/error/result 状态全部局部管理；卸载后不再 setState。
 */
export function SemanticReviewPanel({
  worldId,
  claim,
  uiLanguage,
  onClose,
}: {
  worldId: string;
  claim: GraphClaim;
  uiLanguage: UiLanguage;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<SemanticReviewChangeKind>("assert");
  const [objectValue, setObjectValue] = useState(claim.objectValue);
  const [cursor, setCursor] = useState<WorldCursor | null>(null);
  const [contextFailed, setContextFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<SemanticReviewOutcome | null>(null);
  const mountedRef = useRef(true);

  // 打开表单时只读一次 context（服务端游标）；卸载后丢弃迟到响应。
  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    async function loadContext() {
      try {
        const response = await fetch(
          `/api/worldline/conflict/semantic/context?worldId=${encodeURIComponent(worldId)}`,
          { cache: "no-store" },
        );
        const context = response.ok
          ? normalizeSemanticReviewContext(await response.json())
          : null;
        if (cancelled || !mountedRef.current) return;
        if (context) {
          setCursor(context.existingFuture);
        } else {
          setContextFailed(true);
        }
      } catch {
        if (!cancelled && mountedRef.current) setContextFailed(true);
      }
    }
    void loadContext();
    return () => {
      cancelled = true;
      mountedRef.current = false;
    };
  }, [worldId]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !cursor) return;
    const change = buildSemanticReviewChange({ kind, claim, objectValue, cursor });
    if (!change) return;
    setBusy(true);
    setErrorKey(null);
    setOutcome(null);
    try {
      const response = await fetch("/api/worldline/conflict/semantic", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          worldId,
          existingFuture: cursor,
          changeSet: { changes: [change] },
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!mountedRef.current) return;
      if (!response.ok) {
        const code = (payload as { error?: { code?: string } } | null)?.error?.code;
        setErrorKey(semanticReviewErrorKey(response.status, code));
        return;
      }
      const next = normalizeSemanticReviewOutcome(payload);
      if (!next) {
        setErrorKey("ui.semanticReview.errGeneric");
        return;
      }
      setOutcome(next);
    } catch {
      if (mountedRef.current) setErrorKey("ui.semanticReview.errGeneric");
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  const kindLabels: Record<SemanticReviewChangeKind, string> = {
    assert: uiText("ui.semanticReview.kindAssert", uiLanguage),
    terminate: uiText("ui.semanticReview.kindTerminate", uiLanguage),
    supersede: uiText("ui.semanticReview.kindSupersede", uiLanguage),
  };

  if (outcome) {
    return (
      <div className="graph-edit-form semantic-review-panel" role="status">
        <p className="eyebrow">{uiText("ui.semanticReview.resultTitle", uiLanguage)}</p>
        <ul className="graph-claim-list">
          <li>
            <strong>{uiText("ui.semanticReview.classification", uiLanguage)}</strong>
            <span>{outcome.classification}</span>
          </li>
          {outcome.recommendation ? (
            <li>
              <strong>{uiText("ui.semanticReview.recommendation", uiLanguage)}</strong>
              <span>{outcome.recommendation}</span>
            </li>
          ) : null}
          {outcome.rationale ? (
            <li>
              <strong>{uiText("ui.semanticReview.rationale", uiLanguage)}</strong>
              <span>{outcome.rationale}</span>
            </li>
          ) : null}
          {outcome.source ? (
            <li>
              <strong>{uiText("ui.semanticReview.source", uiLanguage)}</strong>
              <span>
                {outcome.source === "model"
                  ? uiText("ui.semanticReview.sourceModel", uiLanguage)
                  : uiText("ui.semanticReview.sourceFallback", uiLanguage)}
              </span>
            </li>
          ) : null}
        </ul>
        <p className="graph-empty-line">
          {uiText("ui.semanticReview.evidenceNote", uiLanguage)}
        </p>
        <div className="graph-edit-actions">
          <button onClick={onClose} type="button">
            {uiText("ui.semanticReview.close", uiLanguage)}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className="graph-edit-form semantic-review-panel" onSubmit={submit}>
      <p className="eyebrow">{uiText("ui.semanticReview.title", uiLanguage)}</p>
      <p className="graph-empty-line">
        {uiText("ui.semanticReview.draftNotice", uiLanguage)}
      </p>
      <label>
        {uiText("ui.semanticReview.kindLabel", uiLanguage)}
        <select
          disabled={busy}
          onChange={(event) => setKind(event.target.value as SemanticReviewChangeKind)}
          value={kind}
        >
          {(Object.keys(kindLabels) as SemanticReviewChangeKind[]).map((value) => (
            <option key={value} value={value}>{kindLabels[value]}</option>
          ))}
        </select>
      </label>
      {kind === "assert" || kind === "supersede" ? (
        <label>
          {kind === "assert"
            ? uiText("ui.semanticReview.objectLabel", uiLanguage)
            : uiText("ui.semanticReview.replacementLabel", uiLanguage)}
          <input
            disabled={busy}
            onChange={(event) => setObjectValue(event.target.value)}
            required
            value={objectValue}
          />
        </label>
      ) : null}
      {contextFailed ? (
        <p className="graph-empty-line" role="alert">
          {uiText("ui.semanticReview.errContext", uiLanguage)}
        </p>
      ) : null}
      {errorKey ? (
        <p className="graph-empty-line" role="alert">
          {uiText(errorKey, uiLanguage)}
        </p>
      ) : null}
      <div className="graph-edit-actions">
        <button disabled={busy || !cursor || contextFailed} type="submit">
          {busy
            ? uiText("ui.semanticReview.submitting", uiLanguage)
            : uiText("ui.semanticReview.submit", uiLanguage)}
        </button>
        <button disabled={busy} onClick={onClose} type="button">
          {uiText("ui.semanticReview.cancel", uiLanguage)}
        </button>
      </div>
    </form>
  );
}
