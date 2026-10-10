import type {
  LocalRecordService,
  SubmitLocalMessageInput,
} from "../application/local-record-service.ts";
import type { WorldBinding } from "../world-transfer/realm-save.ts";

export interface HeadlessRuntimeScope {
  workspaceId: string;
  principalId: string;
  recordId: string;
  worldId: string;
  worldlineId: string;
  worldBinding: WorldBinding;
}

export interface HeadlessRuntimeScopeResolver {
  resolve(input: {
    workspaceId: string;
    principalId: string;
    recordId: string;
  }): Promise<HeadlessRuntimeScope | null>;
}

export interface HeadlessRuntimeContentResolver<TContent> {
  resolve(binding: WorldBinding): Promise<TContent | null>;
}

type HeadlessService = Pick<
  LocalRecordService,
  "loadRecord" | "listCommittedEvents" | "submitMessage" | "startSelfPlay" | "stopSelfPlay"
>;

type HeadlessSubmitInput = Omit<SubmitLocalMessageInput, "recordId" | "principalId">;

export type HeadlessRuntimeCommand =
  | { kind: "load" }
  | { kind: "events"; afterOrdinal: number }
  | ({ kind: "submit" } & HeadlessSubmitInput)
  | { kind: "startSelfPlay" }
  | { kind: "stopSelfPlay" };

export type HeadlessRuntimeResult =
  | { kind: "record"; value: Awaited<ReturnType<HeadlessService["loadRecord"]>> }
  | { kind: "events"; value: Awaited<ReturnType<HeadlessService["listCommittedEvents"]>> }
  | { kind: "submit"; value: Awaited<ReturnType<HeadlessService["submitMessage"]>> }
  | { kind: "startSelfPlay"; value: Awaited<ReturnType<HeadlessService["startSelfPlay"]>> }
  | { kind: "stopSelfPlay"; value: Awaited<ReturnType<HeadlessService["stopSelfPlay"]>> };

export type HeadlessRuntimeLifecycle = "created" | "running" | "stopped";

export type HeadlessRuntimeErrorCode =
  | "HEADLESS_NOT_STARTED"
  | "HEADLESS_STOPPED"
  | "HEADLESS_SCOPE_UNAVAILABLE"
  | "HEADLESS_CONTENT_UNAVAILABLE"
  | "HEADLESS_INVALID_SCOPE"
  | "HEADLESS_INVALID_COMMAND";

export class HeadlessRuntimeError extends Error {
  readonly code: HeadlessRuntimeErrorCode;

  constructor(code: HeadlessRuntimeErrorCode, message: string) {
    super(message);
    this.name = "HeadlessRuntimeError";
    this.code = code;
  }
}

export interface HeadlessRuntimeDescriptor {
  lifecycle: "running";
  workspaceId: string;
  principalId: string;
  recordId: string;
  worldId: string;
  worldlineId: string;
  worldBinding: WorldBinding;
}

export interface HeadlessRuntime<TContent = unknown> {
  readonly lifecycle: HeadlessRuntimeLifecycle;
  /** The binding pinned when the runtime started; null before start/after stop. */
  readonly worldBinding: WorldBinding | null;
  /** Mounted RealmWorld content pinned with the WorldBinding; base mode has no package content. */
  readonly worldContent: TContent | null;
  start(): Promise<HeadlessRuntimeDescriptor>;
  execute(command: HeadlessRuntimeCommand): Promise<HeadlessRuntimeResult>;
  stop(): Promise<void>;
}

function invalidCommand(message: string): HeadlessRuntimeError {
  return new HeadlessRuntimeError("HEADLESS_INVALID_COMMAND", message);
}

function assertScope(scope: HeadlessRuntimeScope): void {
  for (const [field, value] of Object.entries(scope)) {
    if (field === "worldBinding") continue;
    if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
      throw new HeadlessRuntimeError("HEADLESS_INVALID_SCOPE", `Headless runtime scope field ${field} is invalid.`);
    }
  }
  if (scope.worldBinding.kind === "world") {
    if (
      !scope.worldBinding.worldId
      || !scope.worldBinding.worldVersion
      || scope.worldBinding.worldId !== scope.worldId
    ) {
      throw new HeadlessRuntimeError("HEADLESS_INVALID_SCOPE", "Headless runtime WorldBinding is invalid.");
    }
  }
}

export function createHeadlessRuntime<TContent = unknown>(input: {
  scopeResolver: HeadlessRuntimeScopeResolver;
  service: HeadlessService;
  scope: {
    workspaceId: string;
    principalId: string;
    recordId: string;
  };
  contentResolver?: HeadlessRuntimeContentResolver<TContent>;
}): HeadlessRuntime<TContent> {
  let lifecycle: HeadlessRuntimeLifecycle = "created";
  let pinnedScope: Readonly<HeadlessRuntimeScope> | null = null;
  let pinnedContent: TContent | null = null;

  function requireScope(): Readonly<HeadlessRuntimeScope> {
    if (lifecycle === "created") {
      throw new HeadlessRuntimeError("HEADLESS_NOT_STARTED", "Headless runtime has not started.");
    }
    if (lifecycle === "stopped" || !pinnedScope) {
      throw new HeadlessRuntimeError("HEADLESS_STOPPED", "Headless runtime has stopped.");
    }
    return pinnedScope;
  }

  function descriptor(scope: Readonly<HeadlessRuntimeScope>): HeadlessRuntimeDescriptor {
    return {
      lifecycle: "running",
      workspaceId: scope.workspaceId,
      principalId: scope.principalId,
      recordId: scope.recordId,
      worldId: scope.worldId,
      worldlineId: scope.worldlineId,
      worldBinding: scope.worldBinding,
    };
  }

  return {
    get lifecycle() {
      return lifecycle;
    },
    get worldBinding() {
      return pinnedScope?.worldBinding ?? null;
    },
    get worldContent() {
      return pinnedContent;
    },
    async start() {
      if (lifecycle === "stopped") {
        throw new HeadlessRuntimeError("HEADLESS_STOPPED", "Headless runtime has stopped.");
      }
      if (pinnedScope) return descriptor(pinnedScope);
      let resolved: HeadlessRuntimeScope | null;
      try {
        resolved = await input.scopeResolver.resolve(input.scope);
      } catch {
        throw new HeadlessRuntimeError("HEADLESS_SCOPE_UNAVAILABLE", "Headless runtime scope could not be resolved.");
      }
      if (!resolved) {
        throw new HeadlessRuntimeError("HEADLESS_SCOPE_UNAVAILABLE", "Headless runtime scope is unavailable.");
      }
      assertScope(resolved);
      if (
        resolved.workspaceId !== input.scope.workspaceId
        || resolved.principalId !== input.scope.principalId
        || resolved.recordId !== input.scope.recordId
      ) {
        throw new HeadlessRuntimeError("HEADLESS_INVALID_SCOPE", "Resolved headless scope does not match the requested scope.");
      }
      if (resolved.worldBinding.kind === "world") {
        if (!input.contentResolver) {
          throw new HeadlessRuntimeError("HEADLESS_CONTENT_UNAVAILABLE", "World-bound headless runtime content is unavailable.");
        }
        try {
          pinnedContent = await input.contentResolver.resolve(resolved.worldBinding);
        } catch {
          throw new HeadlessRuntimeError("HEADLESS_CONTENT_UNAVAILABLE", "World-bound headless runtime content could not be mounted.");
        }
        if (pinnedContent === null) {
          throw new HeadlessRuntimeError("HEADLESS_CONTENT_UNAVAILABLE", "World-bound headless runtime content is unavailable.");
        }
      }
      pinnedScope = Object.freeze({ ...resolved });
      lifecycle = "running";
      return descriptor(pinnedScope);
    },
    async execute(command) {
      const scope = requireScope();
      switch (command.kind) {
        case "load":
          return {
            kind: "record",
            value: await input.service.loadRecord(scope.recordId, scope.principalId),
          };
        case "events":
          if (!Number.isSafeInteger(command.afterOrdinal) || command.afterOrdinal < 0) {
            throw invalidCommand("Headless runtime event cursor is invalid.");
          }
          return {
            kind: "events",
            value: await input.service.listCommittedEvents(scope.recordId, command.afterOrdinal, scope.principalId),
          };
        case "submit": {
          if (!command.content.trim() || !command.idempotencyKey.trim() || !command.writeToken.trim()) {
            throw invalidCommand("Headless runtime submit fields are invalid.");
          }
          const { kind, ...submitInput } = command;
          void kind;
          return {
            kind: "submit",
            value: await input.service.submitMessage({
              ...submitInput,
              recordId: scope.recordId,
              principalId: scope.principalId,
            }),
          };
        }
        case "startSelfPlay":
          return {
            kind: "startSelfPlay",
            value: await input.service.startSelfPlay(scope.recordId, scope.principalId),
          };
        case "stopSelfPlay":
          return {
            kind: "stopSelfPlay",
            value: await input.service.stopSelfPlay(scope.recordId, scope.principalId),
          };
        default:
          throw invalidCommand("Headless runtime command is unsupported.");
      }
    },
    async stop() {
      if (lifecycle === "stopped") return;
      lifecycle = "stopped";
      pinnedScope = null;
      pinnedContent = null;
    },
  };
}
