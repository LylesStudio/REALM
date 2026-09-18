import {
  uiText,
  type UiLanguage,
} from "../../modules/i18n/public.ts";
import type { LibraryStory } from "./library-types";

/**
 * 批次 T12-C：页面级故事视图（验收修正：按选中的 story 渲染）。
 * 标题/状态/前提/记录列表全部来自 Library snapshot 中被选中的 story
 * （服务端已过滤 archived），不得用当前 Record 的 story 冒充其他故事；
 * 空态结构性消隐，不写 Demo 假内容。
 */
export function StoryView({
  story,
  worldName,
  currentRecordId,
  uiLanguage,
  onOpenRecord,
}: {
  /** 被选中的故事；snapshot 尚未到达或 id 失效时为 null（结构性空态）。 */
  story: LibraryStory | null;
  worldName: string;
  currentRecordId: string;
  uiLanguage: UiLanguage;
  onOpenRecord: (recordId: string) => void;
}) {
  if (!story) {
    return (
      <main className="record-main view-panel" data-view="story">
        <p className="eyebrow">{uiText("ui.storyView.eyebrow", uiLanguage)}</p>
        <p className="view-panel-empty" role="status">
          {uiText("ui.storyView.missing", uiLanguage)}
        </p>
      </main>
    );
  }

  return (
    <main className="record-main view-panel" data-view="story" data-story-id={story.id}>
      <header className="record-heading">
        <div>
          <p className="eyebrow">{uiText("ui.storyView.eyebrow", uiLanguage)}</p>
          <h1>{story.title}</h1>
          <p className="record-subtitle">
            {[
              worldName ? `${uiText("ui.storyView.belongsTo", uiLanguage)} · ${worldName}` : "",
              story.status,
            ].filter((part) => part.trim().length > 0).join(" · ")}
          </p>
        </div>
        <div className="record-heading-actions">
          {currentRecordId.trim() ? (
            <button
              className="record-action-button is-primary"
              onClick={() => onOpenRecord(currentRecordId)}
              type="button"
            >
              {uiText("ui.storyView.openRecord", uiLanguage)}
            </button>
          ) : null}
        </div>
      </header>

      <div className="view-panel-scroll">
        {story.premise.trim() ? (
          <section className="view-section" aria-label={uiText("ui.storyView.premise", uiLanguage)}>
            <h2>{uiText("ui.storyView.premise", uiLanguage)}</h2>
            <p>{story.premise}</p>
          </section>
        ) : null}

        <section className="view-section" aria-label={uiText("ui.storyView.records", uiLanguage)}>
          <h2>{uiText("ui.storyView.records", uiLanguage)}</h2>
          {story.records.length === 0 ? (
            <p className="view-panel-empty">
              {uiText("ui.storyView.emptyRecords", uiLanguage)}
            </p>
          ) : (
            <ul className="view-record-list">
              {story.records.map((record) => (
                <li key={record.id}>
                  <button
                    className={`view-link${
                      record.id === currentRecordId ? " is-current" : ""
                    }`}
                    onClick={() => onOpenRecord(record.id)}
                    type="button"
                  >
                    {record.title}
                  </button>
                  {record.id === currentRecordId ? (
                    <span className="view-badge">
                      {uiText("ui.storyView.currentBadge", uiLanguage)}
                    </span>
                  ) : null}
                  {record.timelineKind === "retrospection" ? (
                    <span className="view-badge">
                      {uiText("ui.storyView.retroBadge", uiLanguage)}
                    </span>
                  ) : null}
                  {record.timelineKind === "merged" ? (
                    <span className="view-badge">
                      {uiText("ui.storyView.mergedBadge", uiLanguage)}
                    </span>
                  ) : null}
                  {record.timelineKind === "branch" ? (
                    <span className="view-badge">
                      {uiText("ui.record.branchBadge", uiLanguage)}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
