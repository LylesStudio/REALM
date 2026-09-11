import { uiText, type UiLanguage } from "../../modules/i18n/public.ts";
import type { RecordProjection, ViewerContext } from "./record-types";

interface SceneInspectorProps {
  projection: RecordProjection;
  /** 界面语言（缺省 zh-CN）。 */
  uiLanguage?: UiLanguage;
  viewer: ViewerContext;
  /** 批次 T1：初夜钩子正文；空则不渲染钩子卡。 */
  firstNightHook?: string;
  memoryRepresentation?: string;
  memoryDepth?: "simple" | "balanced" | "immersive";
  onMemoryDepthChange?: (depth: "simple" | "balanced" | "immersive") => void;
  memoryRelationships?: string;
  isSummarizingMemory?: boolean;
  onSummarizeMemory?: () => void;
}

export function SceneInspector({
  projection,
  uiLanguage = "zh-CN",
  viewer,
  firstNightHook = "",
  memoryRepresentation = "",
  memoryDepth = "balanced",
  onMemoryDepthChange,
  memoryRelationships = "",
  isSummarizingMemory = false,
  onSummarizeMemory,
}: SceneInspectorProps) {
  const omniscient = viewer.perspective === "omniscient";
  const perspectiveTitle = omniscient
    ? uiText("ui.inspector.omniscient", uiLanguage)
    : uiText("ui.inspector.characterView", uiLanguage);
  const perspectiveDescription = omniscient
    ? uiText("ui.inspector.omniscientHint", uiLanguage)
    : uiText("ui.inspector.characterHint", uiLanguage);
  const scene = projection.scene;
  // 结构性消隐：空字段折叠不占位，由数据生长驱动逐步显现。
  const sceneFacts = [
    { term: uiText("ui.inspector.worldTime", uiLanguage), value: scene.worldTime },
    { term: uiText("ui.inspector.weather", uiLanguage), value: scene.weather },
    { term: uiText("ui.inspector.tension", uiLanguage), value: scene.tension },
  ].filter((fact) => fact.value.trim().length > 0);
  const sceneTitle = scene.location || projection.story.title || "——";
  // 批次 S：CAST_SQL 不过滤 is_active（席位永不删除），展示层只列在席成员；
  // 观察者切换后本人角色席位以 isActive=false 退出阵容显示。
  const visibleCast = projection.cast.filter((member) => member.isActive);

  return (
    <aside className="scene-inspector" aria-label={uiText("ui.inspector.ariaLabel", uiLanguage)}>
      {viewer.dynamicKnowledgeVisible ? (
        <>
          <section className="inspector-card scene-card">
            <div className="inspector-heading">
              <p className="eyebrow">{uiText("ui.inspector.scene", uiLanguage)}</p>
              <span className="live-label">
                <i aria-hidden="true" /> {uiText("ui.inspector.live", uiLanguage)}
              </span>
            </div>
            <h2>{sceneTitle}</h2>
            {sceneFacts.length > 0 ? (
              <dl className="scene-facts">
                {sceneFacts.map((fact) => (
                  <div key={fact.term}>
                    <dt>{fact.term}</dt>
                    <dd>{fact.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {scene.objective.trim() ? (
              <div className="scene-objective">
                <span>{uiText("ui.inspector.objective", uiLanguage)}</span>
                <p>{scene.objective}</p>
              </div>
            ) : null}
          </section>
          {firstNightHook.trim() ? (
            <section className="inspector-card hook-card">
              <p className="eyebrow">{uiText("ui.inspector.hook", uiLanguage)}</p>
              <p className="hook-content">{firstNightHook}</p>
            </section>
          ) : null}

          {visibleCast.length > 0 ? (
            <section className="inspector-card cast-card">
              <div className="inspector-heading">
                <p className="eyebrow">{uiText("ui.inspector.cast", uiLanguage)}</p>
                <span>{uiText("ui.inspector.castCount", uiLanguage, { count: String(visibleCast.length) })}</span>
              </div>
              <ul className="cast-list">
                {visibleCast.map((member) => (
                  <li key={member.id}>
                    <span className="cast-monogram" aria-hidden="true">
                      {member.name.slice(0, 1)}
                    </span>
                    <span className="cast-copy">
                      <strong>{member.name}</strong>
                      {/* 批次 S：本人席位标注「你」（单机本地产品，人类席位唯一）。 */}
                      {member.controlledBy === "human" ? (
                        <em className="cast-you">{uiText("ui.cast.you", uiLanguage)}</em>
                      ) : null}
                      {member.role ? <small>{member.role}</small> : null}
                      {member.summary ? <small className="cast-summary">{member.summary}</small> : null}
                    </span>
                    <span className="cast-presence">
                      <i className={member.isActive ? "is-active" : ""} aria-hidden="true" />
                      {member.status}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : (
        <>
          <section className="inspector-card knowledge-unavailable">
            <p className="eyebrow">{uiText("ui.inspector.scene", uiLanguage)}</p>
            <span aria-hidden="true">◇</span>
            <h2>{uiText("ui.inspector.hidden", uiLanguage)}</h2>
            <p>{uiText("ui.inspector.hiddenSceneHint", uiLanguage)}</p>
          </section>
          <section className="inspector-card knowledge-unavailable">
            <p className="eyebrow">{uiText("ui.inspector.cast", uiLanguage)}</p>
            <span aria-hidden="true">◇</span>
            <h2>{uiText("ui.inspector.hidden", uiLanguage)}</h2>
            <p>{uiText("ui.inspector.hiddenCastHint", uiLanguage)}</p>
          </section>
        </>
      )}

      {viewer.dynamicKnowledgeVisible && memoryRepresentation ? (
        <section className="inspector-card memory-card">
          <div className="inspector-heading">
            <p className="eyebrow">{uiText("ui.inspector.memory", uiLanguage)}</p>
            <div className="memory-depth">
              {(["simple", "balanced", "immersive"] as const).map((depth) => (
                <button
                  className={memoryDepth === depth ? "is-active" : ""}
                  key={depth}
                  onClick={() => onMemoryDepthChange?.(depth)}
                  type="button"
                >
                  {depth === "simple"
                    ? uiText("ui.inspector.memorySimple", uiLanguage)
                    : depth === "balanced"
                      ? uiText("ui.inspector.memoryBalanced", uiLanguage)
                      : uiText("ui.inspector.memoryImmersive", uiLanguage)}
                </button>
              ))}
            </div>
          </div>
          <p className="memory-representation">{memoryRepresentation}</p>
          {memoryRelationships ? (
            <p className="memory-relationships">{memoryRelationships}</p>
          ) : null}
          <button
            className="memory-summarize"
            disabled={isSummarizingMemory}
            onClick={() => onSummarizeMemory?.()}
            type="button"
          >
            {isSummarizingMemory
              ? uiText("ui.inspector.summarizing", uiLanguage)
              : uiText("ui.inspector.summarize", uiLanguage)}
          </button>
        </section>
      ) : null}

      <section
        className={`perspective-note${omniscient ? " is-omniscient" : ""}`}
        aria-label={uiText("ui.inspector.perspectiveAria", uiLanguage)}
      >
        <span className="perspective-glyph" aria-hidden="true">
          {omniscient ? "◎" : "◐"}
        </span>
        <div>
          <strong>{perspectiveTitle}</strong>
          <p>{perspectiveDescription}</p>
        </div>
      </section>
    </aside>
  );
}
