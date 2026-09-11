/**
 * M4 tool-call pause and resume for streamed generation.
 *
 * @runtime-status contract-only-deferred — 批次 T10-B5：全库零生产调用方；
 * 活动 gateway 只有完整文本 chat/stream、无流式 tool-call 事件，接线前置
 * 条件见 docs/development/T10-B5-M4-RUNTIME-STATUS.md §二。函数行为不变。
 *
 * When a model asks for a tool mid-generation, output pauses: no new body
 * text is produced while the tool resolves locally. The continuation phase
 * receives the tool result and resumes. The event log always reads
 * chunks → pause → resolved → chunks; cancellation at any stage leaves the
 * whole generation uncommitted.
 */

export type ToolPauseEvent =
  | { kind: "chunk"; phase: "before" | "after"; content: string }
  | { kind: "tool.pause"; tool: string }
  | { kind: "tool.resolved"; tool: string };

export type ToolPauseResult = {
  committed: boolean;
  content: string;
  events: readonly ToolPauseEvent[];
};

export async function generateWithToolPause<TResult>(options: {
  /** Phase one: streams until a tool request (or no tool needed). */
  first(
    emit: (chunk: string) => void,
  ): Promise<{ toolRequest: { name: string } | null }>;
  /** Local tool adjudication; its result feeds the continuation. */
  runTool(toolName: string): Promise<TResult>;
  /** Phase two: resumes with the tool result. */
  continue_(
    toolResult: TResult,
    emit: (chunk: string) => void,
  ): Promise<void>;
  signal?: AbortSignal;
}): Promise<ToolPauseResult> {
  const events: ToolPauseEvent[] = [];
  let content = "";
  const emitBefore = (chunk: string) => {
    events.push({ kind: "chunk", phase: "before", content: chunk });
    content += chunk;
  };
  const emitAfter = (chunk: string) => {
    events.push({ kind: "chunk", phase: "after", content: chunk });
    content += chunk;
  };

  const first = await options.first(emitBefore);
  if (options.signal?.aborted) return { committed: false, content: "", events };
  if (!first.toolRequest) {
    return { committed: true, content, events };
  }

  events.push({ kind: "tool.pause", tool: first.toolRequest.name });
  const toolResult = await options.runTool(first.toolRequest.name);
  if (options.signal?.aborted) return { committed: false, content: "", events };
  events.push({ kind: "tool.resolved", tool: first.toolRequest.name });

  await options.continue_(toolResult, emitAfter);
  if (options.signal?.aborted) return { committed: false, content: "", events };
  return { committed: true, content, events };
}
