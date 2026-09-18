"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  normalizeUiLanguage,
  uiText,
  type UiLanguage,
} from "../../modules/i18n/public.ts";
import { readUiLanguage } from "../ui-language.ts";
import {
  ARTICLE_QUALIFICATION_LABELS,
  ENTITY_KIND_COLORS,
  ENTITY_KIND_LABELS,
  normalizeAudienceAppendResponse,
  normalizeCanonProposals,
  normalizeCanonQualification,
  normalizeGraphSnapshot,
  sortClaimsByImportance,
  type CanonProposalItem,
  type CanonQualification,
  type GraphArticle,
  type GraphEntity,
  type KnowledgeGraphSnapshot,
} from "./knowledge-graph-types";
import { SemanticReviewPanel } from "./semantic-review-panel";

type EditMode = "entity" | "summary" | "relation" | "claim" | null;

const EMPTY_SNAPSHOT: KnowledgeGraphSnapshot = {
  entities: [],
  claims: [],
  relations: [],
  articles: [],
};

export function KnowledgeGraphPanel({
  worldId,
  worldName,
  uiLanguage: uiLanguageProp,
  onClose,
}: {
  /** 批次 T9：目标世界 id——图谱/正史请求显式携带（去 demo 硬编码）。 */
  worldId: string;
  worldName: string;
  /** 批次 T11-D：界面语言；本批已把面板全部硬编码文案接入 ui.knowledge.* 键表。 */
  uiLanguage?: UiLanguage;
  onClose: () => void;
}) {
  const uiLanguage = normalizeUiLanguage(uiLanguageProp);
  const [snapshot, setSnapshot] = useState<KnowledgeGraphSnapshot>(EMPTY_SNAPSHOT);
  const [proposals, setProposals] = useState<readonly CanonProposalItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<"detail" | "canon" | "articles">("detail");
  const [showAllClaims, setShowAllClaims] = useState(false);
  const [expandedArticleId, setExpandedArticleId] = useState<string | null>(null);
  const [mode, setMode] = useState<EditMode>(null);
  // 批次 T11-D：正在复审的 Claim（null=无表单）；切换实体/进入编辑时清空。
  const [reviewClaimId, setReviewClaimId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 批次 T11-H：Canon 资格预检（owner operator surface 数据源；
  // 读取失败/非成员 → null，non-public 控件隐藏）。
  const [qualification, setQualification] = useState<CanonQualification | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const mountedRef = useRef(true);
  const loadSeqRef = useRef(0);

  // 批次 T10-B10-A：初次加载与手动刷新共用同一条读取路径。
  // 双端点整体成败（任一失败保留旧数据）；序号防旧响应覆盖；
  // mountedRef 防卸载后 setState；非 2xx 显式失败进 notice。
  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    try {
      const query = `?worldId=${encodeURIComponent(worldId)}`;
      const [graphResponse, canonResponse] = await Promise.all([
        fetch(`/api/world-knowledge${query}`, { cache: "no-store" }),
        fetch(`/api/canon${query}`, { cache: "no-store" }),
      ]);
      if (!graphResponse.ok || !canonResponse.ok) {
        throw new Error("knowledge refresh failed");
      }
      const [graphPayload, canonPayload] = await Promise.all([
        graphResponse.json(),
        canonResponse.json(),
      ]);
      // 批次 T11-H：资格预检随刷新同行读取；失败/非 ok 降级为 null
      //（隐藏 non-public 控件），不阻断主加载。
      let nextQualification: CanonQualification | null = null;
      try {
        const qualificationResponse = await fetch(
          `/api/canon?view=qualification&worldId=${encodeURIComponent(worldId)}`,
          { cache: "no-store" },
        );
        if (qualificationResponse.ok) {
          nextQualification = normalizeCanonQualification(
            await qualificationResponse.json(),
          );
        }
      } catch {
        nextQualification = null;
      }
      if (!mountedRef.current || seq !== loadSeqRef.current) return;
      const nextSnapshot = normalizeGraphSnapshot(graphPayload);
      setSnapshot(nextSnapshot);
      setProposals(normalizeCanonProposals(canonPayload));
      setQualification(nextQualification);
      // 选中实体仍存在则保留，已消失才清空。
      setSelectedId((current) =>
        current && nextSnapshot.entities.some((entity) => entity.id === current)
          ? current
          : null,
      );
      setLoadedOnce(true);
    } catch {
      if (!mountedRef.current || seq !== loadSeqRef.current) return;
      setLoadedOnce(true);
      setNotice(uiText("ui.knowledge.loadFailed", readUiLanguage()));
    } finally {
      if (mountedRef.current && seq === loadSeqRef.current) setLoading(false);
    }
  }, [worldId]);

  useEffect(() => {
    mountedRef.current = true;
    const timer = window.setTimeout(() => void load(), 0);
    return () => {
      mountedRef.current = false;
      window.clearTimeout(timer);
    };
  }, [load]);

  // 批次 T11-A2：graph-specific SSE 自动刷新（规范 §四）。
  // 事件只作失效信号——到达后触发既有 load() 权威回读（双 GET），
  // 不相信 SSE payload；300ms 防抖合并突发事件；断开由浏览器按
  // retry/Last-Event-ID 自动重连，只显示克制的断开提示，轮询不作 fallback。
  const [sseDisconnected, setSseDisconnected] = useState(false);
  const refreshTimerRef = useRef<number | null>(null);
  useEffect(() => {
    const source = new EventSource(
      `/api/world-knowledge/events?worldId=${encodeURIComponent(worldId)}`,
    );
    source.addEventListener("graph-invalidation", () => {
      setSseDisconnected(false);
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        void load();
      }, 300);
    });
    source.onopen = () => setSseDisconnected(false);
    source.onerror = () => setSseDisconnected(true);
    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      source.close();
    };
  }, [worldId, load]);

  function refresh() {
    setNotice(null);
    void load();
  }

  async function post(url: string, body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    body.worldId = worldId;
    setNotice(null);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as { ok: boolean; error?: { message?: string } };
      if (!response.ok || !payload.ok) {
        setNotice(payload.error?.message ?? uiText("ui.knowledge.actionFailed", uiLanguage));
        return false;
      }
      await load();
      return true;
    } catch {
      setNotice(uiText("ui.knowledge.actionFailed", uiLanguage));
      return false;
    } finally {
      setBusy(false);
    }
  }

  // 批次 SWM-G5：article 公共资格 owner 操作（授权/拒绝/撤销）——固定
  // qualification API；主体由服务端 session 解析，前端不发送身份字段；
  // 成功后走既有 load() 权威回读（与刷新同路径）。
  async function qualifyArticle(
    articleId: string,
    decision: "attest" | "reject" | "revoke",
  ): Promise<void> {
    await post("/api/world-knowledge/articles/qualify", { articleId, decision });
  }

  const selected = snapshot.entities.find((entity) => entity.id === selectedId) ?? null;
  const selectedClaims = selected
    ? sortClaimsByImportance(
        snapshot.claims.filter((claim) => claim.subjectEntityId === selected.id),
      )
    : [];
  const visibleClaims = showAllClaims ? selectedClaims : selectedClaims.slice(0, 5);
  const selectedRelations = selected
    ? snapshot.relations.filter((relation) => relation.subjectEntityId === selected.id)
    : [];
  // 批次 T11-D：复审目标 Claim 必须从当前快照派生——Claim 消失（SSE 刷新后）
  // 表单自动闭合，不保留旧结果污染。
  const reviewClaim = selectedClaims.find((claim) => claim.id === reviewClaimId) ?? null;
  const relatedArticles = selected
    ? snapshot.articles.filter((article) =>
        article.claimIds.some((claimId) =>
          selectedClaims.some((claim) => claim.id === claimId)
        )
      )
    : [];

  return (
    <section className="graph-panel" aria-label={uiText("ui.knowledge.ariaPanel", uiLanguage)}>
      <header className="graph-panel-heading">
        <div>
          <p className="eyebrow">{uiText("ui.knowledge.eyebrow", uiLanguage)}</p>
          <h2>{worldName}</h2>
        </div>
        <span className="graph-worldline-tag">{uiText("ui.knowledge.originalWorldline", uiLanguage)}</span>
        <button aria-label={uiText("ui.knowledge.close", uiLanguage)} onClick={onClose} type="button">×</button>
      </header>

      {notice ? (
        <div className="notice-bar" role="alert">
          <span>{notice}</span>
          <button aria-label={uiText("ui.knowledge.dismissNotice", uiLanguage)} onClick={() => setNotice(null)} type="button">×</button>
        </div>
      ) : null}

      <div className="graph-layout">
        <div className="graph-canvas-wrap">
          <GraphCanvas
            entities={snapshot.entities}
            relations={snapshot.relations}
            selectedId={selectedId}
            uiLanguage={uiLanguage}
            onSelect={(id) => {
              setSelectedId(id);
              setShowAllClaims(false);
              setMode(null);
              setReviewClaimId(null);
            }}
          />
          <div className="graph-legend" aria-label={uiText("ui.knowledge.entityLegend", uiLanguage)}>
            {(Object.keys(ENTITY_KIND_LABELS) as GraphEntity["entityKind"][]).map((kind) => (
              <span key={kind}>
                <i style={{ background: ENTITY_KIND_COLORS[kind] }} aria-hidden="true" />
                {ENTITY_KIND_LABELS[kind]}
              </span>
            ))}
          </div>
          <div className="graph-actions">
            <button disabled={busy} onClick={() => setMode("entity")} type="button">{uiText("ui.knowledge.newEntity", uiLanguage)}</button>
            <button
              disabled={busy || !selected}
              onClick={() => setMode("summary")}
              type="button"
            >
              {uiText("ui.knowledge.editSummary", uiLanguage)}
            </button>
            <button
              disabled={busy || !selected}
              onClick={() => setMode("relation")}
              type="button"
            >
              {uiText("ui.knowledge.addRelation", uiLanguage)}
            </button>
            <button
              disabled={busy || !selected}
              onClick={() => setMode("claim")}
              type="button"
            >
              {uiText("ui.knowledge.submitClaim", uiLanguage)}
            </button>
            <button
              aria-label={uiText("ui.knowledge.refresh", uiLanguage)}
              disabled={busy || loading}
              onClick={refresh}
              type="button"
            >
              {loading && loadedOnce ? uiText("ui.knowledge.refreshing", uiLanguage) : uiText("ui.knowledge.refresh", uiLanguage)}
            </button>
          </div>
          {loading ? (
            <p className="graph-status" role="status">
              {loadedOnce ? uiText("ui.knowledge.statusRefreshing", uiLanguage) : uiText("ui.knowledge.statusLoading", uiLanguage)}
            </p>
          ) : null}
          {sseDisconnected ? (
            <p className="graph-status" role="status">
              {uiText("ui.knowledge.sseDisconnected", uiLanguage)}
            </p>
          ) : null}
        </div>

        <aside className="graph-side">
          <div className="graph-tabs" role="tablist">
            <button
              className={tab === "detail" ? "is-active" : ""}
              onClick={() => setTab("detail")}
              type="button"
            >
              {uiText("ui.knowledge.detailTab", uiLanguage)}
            </button>
            <button
              className={tab === "canon" ? "is-active" : ""}
              onClick={() => setTab("canon")}
              type="button"
            >
              {proposals.length > 0
                ? uiText("ui.knowledge.canonTabCount", uiLanguage, {
                    count: String(proposals.length),
                  })
                : uiText("ui.knowledge.canonTab", uiLanguage)}
            </button>
            <button
              className={tab === "articles" ? "is-active" : ""}
              onClick={() => setTab("articles")}
              type="button"
            >
              {snapshot.articles.length > 0
                ? uiText("ui.knowledge.articlesTabCount", uiLanguage, {
                    count: String(snapshot.articles.length),
                  })
                : uiText("ui.knowledge.articlesTab", uiLanguage)}
            </button>
          </div>

          {mode ? (
            <GraphEditForm
              mode={mode}
              busy={busy}
              uiLanguage={uiLanguage}
              entities={snapshot.entities}
              selected={selected}
              selectedClaims={selectedClaims}
              onCancel={() => setMode(null)}
              onSubmit={async (body) => {
                const url = "/api/world-knowledge";
                const done = await post(url, body);
                if (done) setMode(null);
              }}
            />
          ) : tab === "detail" ? (
            selected ? (
              <div className="graph-detail">
                <div className="inspector-heading">
                  <p className="eyebrow">{uiText("ui.knowledge.entityEyebrow", uiLanguage)}</p>
                  <span className="graph-kind-tag">{ENTITY_KIND_LABELS[selected.entityKind]}</span>
                </div>
                <h3>{selected.name}</h3>
                <p className="graph-summary">{selected.summary || uiText("ui.knowledge.noSummary", uiLanguage)}</p>

                <p className="eyebrow">{uiText("ui.knowledge.claimsEyebrow", uiLanguage)}</p>
                {visibleClaims.length > 0 ? (
                  <ul className="graph-claim-list">
                    {visibleClaims.map((claim) => (
                      <li key={claim.id}>
                        <strong>{claim.predicate}</strong>
                        <span>{claim.objectValue}</span>
                        <small>{claim.truthStatus} · {claim.scope}</small>
                        <button
                          className="graph-article-toggle"
                          onClick={() =>
                            setReviewClaimId(
                              reviewClaimId === claim.id ? null : claim.id,
                            )
                          }
                          type="button"
                        >
                          {uiText("ui.semanticReview.request", uiLanguage)}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="graph-empty-line">{uiText("ui.knowledge.noClaims", uiLanguage)}</p>
                )}
                {selectedClaims.length > 5 && !showAllClaims ? (
                  <button
                    className="graph-more"
                    onClick={() => setShowAllClaims(true)}
                    type="button"
                  >
                    {uiText("ui.knowledge.showAll", uiLanguage, {
                      count: String(selectedClaims.length),
                    })}
                  </button>
                ) : null}
                {reviewClaim ? (
                  <SemanticReviewPanel
                    claim={reviewClaim}
                    key={reviewClaim.id}
                    onClose={() => setReviewClaimId(null)}
                    uiLanguage={uiLanguage}
                    worldId={worldId}
                  />
                ) : null}

                <p className="eyebrow">{uiText("ui.knowledge.relationsEyebrow", uiLanguage)}</p>
                {selectedRelations.length > 0 ? (
                  <ul className="graph-claim-list">
                    {selectedRelations.map((relation) => (
                      <li key={relation.id}>
                        <strong>{relation.predicate}</strong>
                        <span>
                          {snapshot.entities.find(
                            (entity) => entity.id === relation.objectEntityId,
                          )?.name ?? relation.objectEntityId}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="graph-empty-line">{uiText("ui.knowledge.noRelations", uiLanguage)}</p>
                )}

                <p className="eyebrow">{uiText("ui.knowledge.articlesEyebrow", uiLanguage)}</p>
                {relatedArticles.length > 0 ? (
                  <ul className="graph-claim-list">
                    {relatedArticles.map((article) => (
                      <li key={article.id}>
                        <button
                          className="graph-article-toggle"
                          onClick={() =>
                            setExpandedArticleId(
                              expandedArticleId === article.id ? null : article.id,
                            )
                          }
                          type="button"
                        >
                          {article.title}
                        </button>
                        {expandedArticleId === article.id ? (
                          <p className="graph-article-body">{article.body}</p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="graph-empty-line">{uiText("ui.knowledge.noRelatedArticles", uiLanguage)}</p>
                )}
              </div>
            ) : (
              <div className="graph-empty">
                <span aria-hidden="true">◇</span>
                <p>{uiText("ui.knowledge.selectHint", uiLanguage)}</p>
              </div>
            )
          ) : tab === "articles" ? (
            <GraphArticleList
              articles={snapshot.articles}
              busy={busy}
              uiLanguage={uiLanguage}
              expandedArticleId={expandedArticleId}
              isOwner={qualification?.membershipRole === "owner"}
              onQualify={qualifyArticle}
              onToggle={(articleId) =>
                setExpandedArticleId(
                  expandedArticleId === articleId ? null : articleId,
                )
              }
            />
          ) : (
            <CanonReviewList
              worldId={worldId}
              onRefresh={load}
              proposals={proposals}
              claims={snapshot.claims}
              busy={busy}
              qualification={qualification}
              uiLanguage={uiLanguage}
              onDecide={async (proposalId, decision, propagation) => {
                // 批次 T11-H：审计主体由服务端会话解析（不再发送 decidedBy）。
                await post("/api/canon", {
                  action: "decide",
                  proposalId,
                  decision,
                  ...(propagation ?? {}),
                });
              }}
            />
          )}
        </aside>
      </div>
    </section>
  );
}

function GraphCanvas({
  entities,
  relations,
  selectedId,
  uiLanguage,
  onSelect,
}: {
  entities: readonly GraphEntity[];
  uiLanguage: UiLanguage;
  relations: readonly {
    id: string;
    subjectEntityId: string;
    objectEntityId: string;
    predicate: string;
  }[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  if (entities.length === 0) {
    return (
      <div className="graph-empty graph-canvas-empty">
        <span aria-hidden="true">◇</span>
        <p>{uiText("ui.knowledge.emptyGraph", uiLanguage)}</p>
      </div>
    );
  }
  const sorted = [...entities].sort((left, right) => left.id.localeCompare(right.id));
  // 环形周长按节点数扩张（每节点约 112px），避免节点重叠。
  const ringRadius = Math.max(180, (sorted.length * 112) / (2 * Math.PI));
  const width = Math.max(640, ringRadius * 2 + 160);
  const height = Math.max(480, ringRadius * 2 + 160);
  const positions = new Map<string, { x: number; y: number }>();
  if (sorted.length <= 2) {
    sorted.forEach((entity, index) => {
      positions.set(entity.id, {
        x: width / 2 - 160 + index * 320,
        y: height / 2,
      });
    });
  } else {
    const cx = width / 2;
    const cy = height / 2;
    sorted.forEach((entity, index) => {
      const angle = (2 * Math.PI * index) / sorted.length - Math.PI / 2;
      positions.set(entity.id, {
        x: cx + ringRadius * Math.cos(angle),
        y: cy + ringRadius * Math.sin(angle),
      });
    });
  }

  return (
    <svg
      aria-label={uiText("ui.knowledge.graphViewAria", uiLanguage)}
      className="graph-canvas"
      onClick={(event) => {
        if (event.target === event.currentTarget) onSelect(null);
      }}
      role="img"
      viewBox={`0 0 ${width} ${height}`}
    >
      {relations.map((relation) => {
        const from = positions.get(relation.subjectEntityId);
        const to = positions.get(relation.objectEntityId);
        if (!from || !to) return null;
        return (
          <g key={relation.id}>
            <line
              className="graph-edge"
              x1={from.x}
              x2={to.x}
              y1={from.y}
              y2={to.y}
            />
            <text
              className="graph-edge-label"
              x={(from.x + to.x) / 2}
              y={(from.y + to.y) / 2 - 4}
            >
              {relation.predicate}
            </text>
          </g>
        );
      })}
      {sorted.map((entity) => {
        const position = positions.get(entity.id)!;
        const selected = entity.id === selectedId;
        return (
          <g
            aria-label={`实体 ${entity.name}`}
            className={`graph-node${selected ? " is-selected" : ""}`}
            key={entity.id}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(entity.id);
            }}
            role="button"
            tabIndex={0}
          >
            <rect
              data-entity-kind={entity.entityKind}
              fill={ENTITY_KIND_COLORS[entity.entityKind]}
              height={30}
              width={96}
              x={position.x - 48}
              y={position.y - 15}
            />
            <text
              className="graph-node-label"
              x={position.x}
              y={position.y + 4}
            >
              {entity.name.length > 6 ? `${entity.name.slice(0, 6)}…` : entity.name}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function GraphEditForm({
  mode,
  busy,
  uiLanguage,
  entities,
  selected,
  selectedClaims,
  onCancel,
  onSubmit,
}: {
  mode: NonNullable<EditMode>;
  busy: boolean;
  uiLanguage: UiLanguage;
  entities: readonly GraphEntity[];
  selected: GraphEntity | null;
  selectedClaims: readonly { id: string; predicate: string; objectValue: string }[];
  onCancel: () => void;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<GraphEntity["entityKind"]>("other");
  const [summary, setSummary] = useState(selected?.summary ?? "");
  const [predicate, setPredicate] = useState("");
  const [objectValue, setObjectValue] = useState("");
  const [targetId, setTargetId] = useState("");
  const [claimId, setClaimId] = useState("");
  const [scope, setScope] = useState("story");
  const [truthStatus, setTruthStatus] = useState("mentioned");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode === "entity") {
      await onSubmit({
        action: "upsertEntity",
        entityKind: kind,
        name,
        summary,
      });
    } else if (mode === "summary" && selected) {
      await onSubmit({
        action: "upsertEntity",
        id: selected.id,
        entityKind: selected.entityKind,
        name: selected.name,
        summary,
      });
    } else if (mode === "relation" && selected) {
      await onSubmit({
        action: "appendRelation",
        subjectEntityId: selected.id,
        objectEntityId: targetId,
        predicate,
        claimId,
      });
    } else if (mode === "claim" && selected) {
      await onSubmit({
        action: "appendClaim",
        subjectEntityId: selected.id,
        predicate,
        objectValue,
        scope,
        truthStatus,
      });
    }
  }

  const titles: Record<NonNullable<EditMode>, string> = {
    entity: uiText("ui.knowledge.newEntity", uiLanguage),
    summary: uiText("ui.knowledge.editSummary", uiLanguage),
    relation: uiText("ui.knowledge.addRelation", uiLanguage),
    claim: uiText("ui.knowledge.submitClaim", uiLanguage),
  };

  return (
    <form className="graph-edit-form" onSubmit={submit}>
      <p className="eyebrow">{titles[mode]}</p>
      {mode === "entity" ? (
        <>
          <label>
            {uiText("ui.knowledge.fieldName", uiLanguage)}
            <input
              onChange={(event) => setName(event.target.value)}
              required
              value={name}
            />
          </label>
          <label>
            {uiText("ui.knowledge.fieldKind", uiLanguage)}
            <select
              onChange={(event) =>
                setKind(event.target.value as GraphEntity["entityKind"])
              }
              value={kind}
            >
              {Object.entries(ENTITY_KIND_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
        </>
      ) : null}
      {mode === "entity" || mode === "summary" ? (
        <label>
          {uiText("ui.knowledge.fieldSummary", uiLanguage)}
          <textarea
            onChange={(event) => setSummary(event.target.value)}
            rows={3}
            value={summary}
          />
        </label>
      ) : null}
      {mode === "relation" ? (
        <>
          <label>
            {uiText("ui.knowledge.fieldTarget", uiLanguage)}
            <select
              onChange={(event) => setTargetId(event.target.value)}
              required
              value={targetId}
            >
              <option value="">{uiText("ui.knowledge.selectTarget", uiLanguage)}</option>
              {entities
                .filter((entity) => entity.id !== selected?.id)
                .map((entity) => (
                  <option key={entity.id} value={entity.id}>{entity.name}</option>
                ))}
            </select>
          </label>
          <label>
            {uiText("ui.knowledge.fieldPredicate", uiLanguage)}
            <input
              onChange={(event) => setPredicate(event.target.value)}
              placeholder={uiText("ui.knowledge.predicatePlaceholder", uiLanguage)}
              required
              value={predicate}
            />
          </label>
          <label>
            {uiText("ui.knowledge.fieldSourceClaim", uiLanguage)}
            <select
              onChange={(event) => setClaimId(event.target.value)}
              required
              value={claimId}
            >
              <option value="">{uiText("ui.knowledge.selectSourceClaim", uiLanguage)}</option>
              {selectedClaims.map((claim) => (
                <option key={claim.id} value={claim.id}>
                  {claim.predicate}：{claim.objectValue}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : null}
      {mode === "claim" ? (
        <>
          <label>
            {uiText("ui.knowledge.fieldPredicate", uiLanguage)}
            <input
              onChange={(event) => setPredicate(event.target.value)}
              required
              value={predicate}
            />
          </label>
          <label>
            {uiText("ui.knowledge.fieldValue", uiLanguage)}
            <input
              onChange={(event) => setObjectValue(event.target.value)}
              required
              value={objectValue}
            />
          </label>
          <label>
            {uiText("ui.knowledge.fieldScope", uiLanguage)}
            <select onChange={(event) => setScope(event.target.value)} value={scope}>
              <option value="story">{uiText("ui.knowledge.scopeStory", uiLanguage)}</option>
              <option value="world">{uiText("ui.knowledge.scopeWorld", uiLanguage)}</option>
            </select>
          </label>
          <label>
            {uiText("ui.knowledge.fieldTruthStatus", uiLanguage)}
            <select
              onChange={(event) => setTruthStatus(event.target.value)}
              value={truthStatus}
            >
              <option value="mentioned">{uiText("ui.knowledge.truthMentioned", uiLanguage)}</option>
              <option value="record_confirmed">{uiText("ui.knowledge.truthRecordConfirmed", uiLanguage)}</option>
            </select>
          </label>
        </>
      ) : null}
      <div className="graph-edit-actions">
        <button disabled={busy} type="submit">{busy ? uiText("ui.knowledge.busy", uiLanguage) : uiText("ui.knowledge.confirm", uiLanguage)}</button>
        <button onClick={onCancel} type="button">{uiText("ui.knowledge.cancel", uiLanguage)}</button>
      </div>
    </form>
  );
}

function CanonReviewList({
  worldId,
  onRefresh,
  proposals,
  claims,
  busy,
  qualification,
  uiLanguage,
  onDecide,
}: {
  worldId: string;
  onRefresh: () => Promise<void>;
  proposals: readonly CanonProposalItem[];
  claims: readonly { id: string; predicate: string; objectValue: string }[];
  busy: boolean;
  /** 批次 T11-H：资格预检（null=隐藏 non-public 控件）。 */
  qualification: CanonQualification | null;
  uiLanguage: UiLanguage;
  onDecide: (
    proposalId: string,
    decision: "merge" | "reject",
    propagation?: {
      propagate: "public" | "restricted" | "secret";
      audienceContinuityIds?: readonly string[];
    },
  ) => Promise<void>;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const mappingPanel = (
    <AudienceMappingPanel
      busy={busy}
      onRefresh={onRefresh}
      qualification={qualification}
      uiLanguage={uiLanguage}
      worldId={worldId}
    />
  );
  if (proposals.length === 0) {
    return (
      <div className="canon-operator-stack">
        {mappingPanel}
        <div className="graph-empty">
          <span aria-hidden="true">◇</span>
          <p>{uiText("ui.knowledge.noProposals", uiLanguage)}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="canon-operator-stack">
      {mappingPanel}
      <ul className="canon-list">
      {proposals.map((proposal) => (
        <li className="canon-card" key={proposal.id}>
          <div className="inspector-heading">
            <span className="graph-kind-tag">
              {proposal.targetLevel === "worldline" ? uiText("ui.knowledge.levelWorldline", uiLanguage) : uiText("ui.knowledge.levelStory", uiLanguage)}
            </span>
            <small>{proposal.proposedBy}</small>
          </div>
          <p>{proposal.rationale || uiText("ui.knowledge.noRationale", uiLanguage)}</p>
          <button
            className="graph-article-toggle"
            onClick={() =>
              setExpandedId(expandedId === proposal.id ? null : proposal.id)
            }
            type="button"
          >
            {expandedId === proposal.id ? uiText("ui.knowledge.collapse", uiLanguage) : uiText("ui.knowledge.expand", uiLanguage)}
          </button>
          {expandedId === proposal.id ? (
            <>
              <ul className="graph-claim-list">
                {proposal.claimIds.map((claimId) => {
                  const claim = claims.find((item) => item.id === claimId);
                  return (
                    <li key={claimId}>
                      <strong>{claim?.predicate ?? claimId}</strong>
                      <span>{claim?.objectValue ?? ""}</span>
                    </li>
                  );
                })}
                {proposal.articleId ? <li><small>{uiText("ui.knowledge.relatedArticleLabel", uiLanguage)}{proposal.articleId}</small></li> : null}
              </ul>
              <CanonDecisionPanel
                busy={busy}
                onDecide={onDecide}
                proposalId={proposal.id}
                qualification={qualification}
                uiLanguage={uiLanguage}
              />
            </>
          ) : null}
          {expandedId === proposal.id ? null : (
            <div className="graph-edit-actions">
              <button
                disabled={busy}
                onClick={() => void onDecide(proposal.id, "merge")}
                type="button"
              >
                合并
              </button>
              <button
                disabled={busy}
                onClick={() => void onDecide(proposal.id, "reject")}
                type="button"
              >
                拒绝
              </button>
            </div>
          )}
        </li>
      ))}
      </ul>
    </div>
  );
}

function AudienceMappingPanel({
  worldId,
  qualification,
  busy,
  uiLanguage,
  onRefresh,
}: {
  worldId: string;
  qualification: CanonQualification | null;
  busy: boolean;
  uiLanguage: UiLanguage;
  onRefresh: () => Promise<void>;
}) {
  const [nodeKey, setNodeKey] = useState("");
  const [continuityId, setContinuityId] = useState("");
  const [mappingBusy, setMappingBusy] = useState(false);
  const [status, setStatus] = useState<"idle" | "added" | "exists" | "failed">("idle");

  if (!qualification) return null;

  const firstNode = qualification.topology.nodes[0]?.key ?? "";
  const firstContinuity = qualification.continuities[0]?.id ?? "";
  const selectedNodeKey = qualification.topology.nodes.some((node) => node.key === nodeKey)
    ? nodeKey
    : firstNode;
  const selectedContinuityId = qualification.continuities.some(
    (continuity) => continuity.id === continuityId,
  )
    ? continuityId
    : firstContinuity;
  const isOwner = qualification.membershipRole === "owner";
  const disabled = busy || mappingBusy || !isOwner || !selectedNodeKey || !selectedContinuityId;
  const continuityNames = new Map(
    qualification.continuities.map((continuity) => [continuity.id, continuity.displayName]),
  );

  async function addMapping() {
    if (disabled) return;
    setMappingBusy(true);
    setStatus("idle");
    try {
      const response = await fetch("/api/propagation/node-audiences", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          worldId,
          nodeKey: selectedNodeKey,
          continuityId: selectedContinuityId,
        }),
      });
      const result = normalizeAudienceAppendResponse(
        await response.json(),
        selectedNodeKey,
        selectedContinuityId,
      );
      if (!response.ok || !result) {
        setStatus("failed");
        return;
      }
      await onRefresh();
      setStatus(result.added ? "added" : "exists");
    } catch {
      setStatus("failed");
    } finally {
      setMappingBusy(false);
    }
  }

  return (
    <section className="canon-mapping-panel" aria-label={uiText("ui.canon.mapping.title", uiLanguage)}>
      <div className="inspector-heading">
        <p className="eyebrow">{uiText("ui.canon.mapping.title", uiLanguage)}</p>
        <span className="graph-kind-tag">{isOwner ? "owner" : qualification.membershipRole}</span>
      </div>
      <p className="graph-summary">{uiText("ui.canon.mapping.note", uiLanguage)}</p>
      {qualification.topology.nodeAudiences.length > 0 ? (
        <ul className="graph-claim-list canon-mapping-list">
          {qualification.topology.nodeAudiences.map((mapping) => (
            <li key={`${mapping.nodeKey}:${mapping.continuityId}`}>
              <strong>{mapping.nodeKey}</strong>
              <span>{continuityNames.get(mapping.continuityId) ?? mapping.continuityId}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="graph-empty-line">{uiText("ui.canon.mapping.none", uiLanguage)}</p>
      )}
      {isOwner ? (
        <div className="canon-mapping-form">
          <label>
            {uiText("ui.canon.mapping.node", uiLanguage)}
            <select
              disabled={busy || mappingBusy}
              onChange={(event) => setNodeKey(event.target.value)}
              value={selectedNodeKey}
            >
              {qualification.topology.nodes.map((node) => (
                <option key={node.key} value={node.key}>
                  {node.key} · {node.clearance}
                </option>
              ))}
            </select>
          </label>
          <label>
            {uiText("ui.canon.mapping.continuity", uiLanguage)}
            <select
              disabled={busy || mappingBusy}
              onChange={(event) => setContinuityId(event.target.value)}
              value={selectedContinuityId}
            >
              {qualification.continuities.map((continuity) => (
                <option key={continuity.id} value={continuity.id}>
                  {continuity.displayName}
                </option>
              ))}
            </select>
          </label>
          <button disabled={disabled} onClick={() => void addMapping()} type="button">
            {mappingBusy
              ? "…"
              : uiText("ui.canon.mapping.add", uiLanguage)}
          </button>
        </div>
      ) : (
        <p className="graph-status" role="status">
          {uiText("ui.canon.mapping.ownerOnly", uiLanguage)}
        </p>
      )}
      {status === "added" ? (
        <p className="graph-status" role="status">{uiText("ui.canon.mapping.added", uiLanguage)}</p>
      ) : null}
      {status === "exists" ? (
        <p className="graph-status" role="status">{uiText("ui.canon.mapping.exists", uiLanguage)}</p>
      ) : null}
      {status === "failed" ? (
        <p className="graph-status" role="alert">{uiText("ui.canon.mapping.failed", uiLanguage)}</p>
      ) : null}
    </section>
  );
}

/** 批次 T11-H：Canon 传播裁决操作面（owner 展开提案时可见）。 */
function CanonDecisionPanel({
  proposalId,
  busy,
  qualification,
  uiLanguage,
  onDecide,
}: {
  proposalId: string;
  busy: boolean;
  qualification: CanonQualification | null;
  uiLanguage: UiLanguage;
  onDecide: (
    proposalId: string,
    decision: "merge" | "reject",
    propagation?: {
      propagate: "public" | "restricted" | "secret";
      audienceContinuityIds?: readonly string[];
    },
  ) => Promise<void>;
}) {
  const [propagateClass, setPropagateClass] = useState<
    "none" | "public" | "restricted" | "secret"
  >("none");
  const [audience, setAudience] = useState<readonly string[]>([]);
  const isOwner = qualification?.membershipRole === "owner";
  const nonPublic = propagateClass === "restricted" || propagateClass === "secret";
  const secretBlocked = propagateClass === "secret"
    && qualification?.topology.secretReady !== true;
  const mergeDisabled = busy
    || (nonPublic && audience.length === 0)
    || secretBlocked;

  const merge = () => {
    if (propagateClass === "none") {
      return onDecide(proposalId, "merge");
    }
    return onDecide(proposalId, "merge", {
      propagate: propagateClass,
      ...(nonPublic ? { audienceContinuityIds: audience } : {}),
    });
  };

  const classOptions = [
    ["none", "ui.canon.propagateNone"],
    ["public", "ui.canon.propagatePublic"],
    ["restricted", "ui.canon.propagateRestricted"],
    ["secret", "ui.canon.propagateSecret"],
  ] as const;

  return (
    <div className="canon-decision">
      {/* 批次 T11-H：所有成员可选 none/public；restricted/secret 仅 owner。 */}
      <>
          <p className="eyebrow">{uiText("ui.canon.propagateClass", uiLanguage)}</p>
          <div className="graph-tabs canon-class-row" role="group">
            {classOptions
              .filter(([value]) => isOwner || value === "none" || value === "public")
              .map(([value, key]) => (
                <button
                  className={propagateClass === value ? "is-active" : ""}
                  disabled={busy}
                  key={value}
                  onClick={() => setPropagateClass(value)}
                  type="button"
                >
                  {uiText(key, uiLanguage)}
                </button>
              ))}
          </div>
          {isOwner && nonPublic ? (
            <fieldset className="canon-audience">
              <legend>{uiText("ui.canon.audience", uiLanguage)}</legend>
              {qualification?.continuities.map((continuity) => (
                <label key={continuity.id}>
                  <input
                    checked={audience.includes(continuity.id)}
                    disabled={busy}
                    onChange={(event) =>
                      setAudience(
                        event.target.checked
                          ? [...audience, continuity.id]
                          : audience.filter((id) => id !== continuity.id),
                      )
                    }
                    type="checkbox"
                  />
                  {continuity.displayName}
                </label>
              ))}
            </fieldset>
          ) : null}
          {isOwner && propagateClass === "secret" ? (
            <p className="graph-status" role="status">
              {uiText(
                qualification?.topology.secretReady
                  ? "ui.canon.secretReady"
                  : "ui.canon.secretNotReady",
                uiLanguage,
              )}
            </p>
          ) : null}
      </>
      <div className="graph-edit-actions">
        <button
          disabled={isOwner ? mergeDisabled : busy}
          onClick={() => void merge()}
          type="button"
        >
          合并
        </button>
        <button
          disabled={busy}
          onClick={() => void onDecide(proposalId, "reject")}
          type="button"
        >
          拒绝
        </button>
      </div>
    </div>
  );
}

/**
 * 批次 SWM-G5：文章列表页签——资格状态徽标 + owner attestation 操作。
 * 正文可见性完全由服务端矩阵决定（body 空串即不可读，前端不做权限判断）；
 * owner 判定来自 canon 资格预检的 membershipRole（fail-closed：null → 非
 * owner，操作按钮隐藏）。沿用直角图谱按钮风格，不引入新视觉语义。
 */
function GraphArticleList({
  articles,
  busy,
  uiLanguage,
  expandedArticleId,
  isOwner,
  onQualify,
  onToggle,
}: {
  articles: readonly GraphArticle[];
  busy: boolean;
  uiLanguage: UiLanguage;
  expandedArticleId: string | null;
  isOwner: boolean;
  onQualify: (
    articleId: string,
    decision: "attest" | "reject" | "revoke",
  ) => Promise<void>;
  onToggle: (articleId: string) => void;
}) {
  if (articles.length === 0) {
    return (
      <div className="graph-empty">
        <span aria-hidden="true">◇</span>
        <p>{uiText("ui.knowledge.noArticles", uiLanguage)}</p>
      </div>
    );
  }
  return (
    <ul className="graph-claim-list">
      {articles.map((article) => {
        const status = article.qualificationStatus ?? "pending_review";
        const hasCursor = typeof article.availableFromTick === "number"
          && typeof article.availableFromOrdinal === "number";
        return (
          <li key={article.id}>
            <div className="inspector-heading">
              <span className="graph-kind-tag" data-qualification-status={status}>
                {ARTICLE_QUALIFICATION_LABELS[status]}
              </span>
              {hasCursor ? (
                <small>
                  自 {article.availableFromTick}·{article.availableFromOrdinal} 起
                </small>
              ) : null}
            </div>
            <button
              className="graph-article-toggle"
              onClick={() => onToggle(article.id)}
              type="button"
            >
              {article.title}
            </button>
            {expandedArticleId === article.id && article.body ? (
              <p className="graph-article-body">{article.body}</p>
            ) : null}
            {expandedArticleId === article.id && !article.body ? (
              <p className="graph-empty-line">{uiText("ui.knowledge.bodyLocked", uiLanguage)}</p>
            ) : null}
            {isOwner ? (
              <div className="graph-edit-actions">
                {status === "pending_review" || status === "rejected" ? (
                  <button
                    aria-label={`授权文章 ${article.title}`}
                    disabled={busy}
                    onClick={() => void onQualify(article.id, "attest")}
                    type="button"
                  >
                    授权
                  </button>
                ) : null}
                {status === "pending_review" ? (
                  <button
                    aria-label={`拒绝文章 ${article.title}`}
                    disabled={busy}
                    onClick={() => void onQualify(article.id, "reject")}
                    type="button"
                  >
                    拒绝
                  </button>
                ) : null}
                {status === "qualified_public" ? (
                  <button
                    aria-label={`撤销文章 ${article.title} 的授权`}
                    disabled={busy}
                    onClick={() => void onQualify(article.id, "revoke")}
                    type="button"
                  >
                    撤销授权
                  </button>
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
