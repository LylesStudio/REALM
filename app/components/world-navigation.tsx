import { uiText, type UiLanguage } from "../../modules/i18n/public.ts";
import type { RecordProjection } from "./record-types";

interface WorldNavigationProps {
  projection: RecordProjection;
  uiLanguage: UiLanguage;
  /** 批次 T12 验收修正：左侧导航 story/record 项为真实可操作入口。 */
  onOpenStory: (storyId: string) => void;
  onOpenRecord: (recordId: string) => void;
}

export function WorldNavigation({
  projection,
  uiLanguage,
  onOpenStory,
  onOpenRecord,
}: WorldNavigationProps) {
  return (
    <aside className="world-nav" aria-label="世界、故事与记录导航">
      <div className="nav-context">
        <p className="eyebrow">{uiText("ui.nav.world", uiLanguage)}</p>
        <div className="context-heading">
          <span className="world-mark" aria-hidden="true">
            界
          </span>
          <div>
            <h2>{projection.world.name || "——"}</h2>
            {projection.world.era ? <p>{projection.world.era}</p> : null}
          </div>
        </div>
      </div>

      <div className="nav-section">
        <div className="nav-section-heading">
          <p className="eyebrow">{uiText("ui.nav.story", uiLanguage)}</p>
          {projection.story.status ? <span>{projection.story.status}</span> : null}
        </div>
        <ul className="nav-list">
          {projection.stories.map((story) => {
            const isCurrent = story.id === projection.story.id;
            return (
              <li className={isCurrent ? "nav-item is-current" : "nav-item"} key={story.id}>
                <span className="nav-rail" aria-hidden="true" />
                <button
                  className="nav-entry"
                  onClick={() => onOpenStory(story.id)}
                  type="button"
                >
                  <span className="nav-copy">
                    <strong>{story.title}</strong>
                    {story.status ? <small>{story.status}</small> : null}
                  </span>
                </button>
                {isCurrent ? <span className="current-label">{uiText("ui.nav.current", uiLanguage)}</span> : null}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="nav-section record-section">
        <p className="eyebrow">{uiText("ui.nav.record", uiLanguage)}</p>
        <ul className="nav-list record-list">
          {projection.records.map((record) => {
            const isCurrent = record.id === projection.record.id;
            return (
              <li className={isCurrent ? "nav-item is-current" : "nav-item"} key={record.id}>
                <span className="record-index" aria-hidden="true">
                  {String(projection.records.indexOf(record) + 1).padStart(2, "0")}
                </span>
                <button
                  className="nav-entry"
                  onClick={() => onOpenRecord(record.id)}
                  type="button"
                >
                  <span className="nav-copy">
                    <strong>{record.title}</strong>
                    {record.worldTime ? <small>{record.worldTime}</small> : null}
                  </span>
                </button>
                {isCurrent ? <span className="current-label">{uiText("ui.nav.reading", uiLanguage)}</span> : null}
              </li>
            );
          })}
        </ul>
      </div>

      <footer className="nav-footer">
        <span className="status-dot" aria-hidden="true" />
        {uiText("ui.nav.running", uiLanguage)}
      </footer>
    </aside>
  );
}
