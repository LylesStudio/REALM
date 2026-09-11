/**
 * M4 Preview session state machine.
 *
 * Preview content is never persisted: it lives only in the caller's memory
 * and may be streamed to a browser preview card. Only `complete()` releases
 * the assembled text so the caller can walk the formal commit path; aborted
 * sessions refuse to hand out their partial content.
 */

export type PreviewSessionState = "streaming" | "committed" | "aborted";

export type PreviewSession = {
  readonly id: string;
  readonly state: PreviewSessionState;
  /** Streaming-phase text so far; throws once the session is aborted. */
  readonly partialText: string;
  push(chunk: string): void;
  /** Completes the session and returns the full text for formal commit. */
  complete(): string;
  abort(reason?: string): void;
  /** Returns committed text; throws unless the session completed. */
  readCommitted(): string;
  readonly abortReason: string | null;
};

export class PreviewSessionError extends Error {
  readonly code: "PREVIEW_SESSION_CLOSED" | "PREVIEW_NOT_COMMITTED";

  constructor(code: PreviewSessionError["code"], message: string) {
    super(message);
    this.name = "PreviewSessionError";
    this.code = code;
  }
}

export function createPreviewSession(options: {
  id: string;
  signal?: AbortSignal;
}): PreviewSession {
  let state: PreviewSessionState = "streaming";
  let text = "";
  let abortReason: string | null = null;

  function assertStreaming() {
    if (state !== "streaming") {
      throw new PreviewSessionError(
        "PREVIEW_SESSION_CLOSED",
        `Preview session ${options.id} is already ${state}.`,
      );
    }
  }

  const session: PreviewSession = {
    get id() {
      return options.id;
    },
    get state() {
      return state;
    },
    get partialText() {
      if (state === "aborted") {
        throw new PreviewSessionError(
          "PREVIEW_NOT_COMMITTED",
          "Aborted preview content is discarded and cannot be read.",
        );
      }
      return text;
    },
    get abortReason() {
      return abortReason;
    },
    push(chunk) {
      assertStreaming();
      if (chunk) text += chunk;
    },
    complete() {
      assertStreaming();
      state = "committed";
      return text;
    },
    abort(reason = "user") {
      assertStreaming();
      state = "aborted";
      abortReason = reason;
      text = "";
    },
    readCommitted() {
      if (state !== "committed") {
        throw new PreviewSessionError(
          "PREVIEW_NOT_COMMITTED",
          "Only a completed preview session may be committed.",
        );
      }
      return text;
    },
  };

  options.signal?.addEventListener(
    "abort",
    () => {
      if (state === "streaming") session.abort("external");
    },
    { once: true },
  );
  return session;
}
