import type { SemanticSegment } from "../presentation/semantic-segments.ts";

export type SemanticStreamChunk = {
  segmentId: string;
  content: string;
  done: boolean;
};

export async function* streamSemanticSegments(
  segments: readonly SemanticSegment[],
  signal?: AbortSignal,
): AsyncGenerator<SemanticStreamChunk> {
  for (const segment of segments) {
    const sentences = splitReadableSentences(segment.content);
    for (let index = 0; index < sentences.length; index += 1) {
      if (signal?.aborted) return;
      yield {
        segmentId: segment.id,
        content: sentences[index]!,
        done: index === sentences.length - 1,
      };
    }
  }
}

export function splitReadableSentences(content: string): string[] {
  const normalized = content.trim();
  if (!normalized) return [];
  const matches = normalized.match(/[^。！？!?；;]+[。！？!?；;]?/g);
  const parts = matches?.length ? matches.map((part) => part.trim()).filter(Boolean) : [normalized];
  if (parts.length === 1 && !/[。！？!?；;]$/.test(parts[0]!)) {
    return [parts[0]!];
  }
  return parts;
}
