"use client";

import { uiText, type UiLanguage } from "../../modules/i18n/public.ts";

/**
 * 生成中暂存位：用户原文提交后的独立临时卡片。
 * 与 canonical timeline 明确区分——不是 committed/pending event，
 * 不进事件列表、不占 ordinal；提交成功由正式事件/SSE 接管后消失，
 * 失败路径由 composer 恢复原文（不丢字、不重复卡片）。
 */
export function PendingSubmission({
  content,
  uiLanguage = "zh-CN",
}: {
  content: string;
  uiLanguage?: UiLanguage;
}) {
  return (
    <section
      aria-label={uiText("ui.composer.pendingAria", uiLanguage)}
      className="pending-submission"
      role="status"
    >
      <p className="pending-submission-text">{content}</p>
      <p className="pending-submission-status">
        <span aria-hidden="true" className="pending-ticker">
          <i>▖</i><i>▞</i><i>▖</i>
        </span>
        {uiText("ui.composer.pending", uiLanguage)}
      </p>
    </section>
  );
}
