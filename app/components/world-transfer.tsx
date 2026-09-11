/**
 * v37 H.2：Library 面板的 .realm 导出/导入区（owner）。
 * - 导出：mode 选择（full/template/selection 提示「世界含分支时 template
 *   不可用」）→ 下载；
 * - 导入向导：选文件 + 模式单选（preserve/copy + copyKey）→ dry-run 报告
 *   （kind/archive 只读明示/冲突清单/copyEligible 与 blockingFields）→
 *   「确认导入」（重传同包）/「取消」→ 结果；
 * - 导入历史（jobs 列表）+ job 详情（事件时间线）。
 * 前端零身份字段：principal 只从 session 服务端解析，body 永不携带。
 */
import { useState, type FormEvent } from "react";
import { uiText, type UiLanguage } from "../../modules/i18n/public.ts";

interface DryRunReport {
  kind?: string;
  mode?: string;
  tables?: { name: string; rows: number }[];
  files?: number;
  warnings?: string[];
  targetWorldName?: string;
  worldExists?: boolean;
  idCollisions?: { table: string; id: string }[];
  copyEligible?: boolean;
  blockingFields?: { table: string; column: string; hit: string }[];
}

interface ImportJobRow {
  id: string;
  direction: string;
  status: string;
  mode: string;
  errorCode: string | null;
  updatedAt: string;
}

interface JobEvent {
  kind: string;
  seq: number;
  at: string;
  payload: unknown;
}

type WizardStep =
  | { phase: "idle" }
  | { phase: "report"; file: File; jobId: string; report: DryRunReport; alreadyImported?: boolean; alreadyValidated?: boolean }
  | { phase: "done"; worldId: string | null; alreadyImported: boolean }
  | { phase: "error"; message: string };

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    return typeof body.error?.message === "string" ? body.error.message : fallback;
  } catch {
    return fallback;
  }
}

/** 导出区（owner）：mode 选择 → 下载。 */
export function WorldExportSection({
  worldId,
  hasBranches,
  uiLanguage,
}: {
  worldId: string;
  hasBranches: boolean;
  uiLanguage: UiLanguage;
}) {
  const [mode, setMode] = useState<"full" | "template" | "selection">("full");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/world/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ worldId, mode }),
      });
      if (!response.ok) {
        setError(await readError(response, uiText("ui.transfer.exportFailed", uiLanguage)));
        return;
      }
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const match = /filename="?([^";]+)"?/.exec(disposition);
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = match ? decodeURIComponent(match[1]!) : "world.realm";
      link.click();
      URL.revokeObjectURL(link.href);
    } catch {
      setError(uiText("ui.transfer.exportFailed", uiLanguage));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="library-transfer-export">
      <label>
        {uiText("ui.transfer.exportMode", uiLanguage)}
        <select
          disabled={busy}
          onChange={(event) => setMode(event.target.value as typeof mode)}
          value={mode}
        >
          <option value="full">{uiText("ui.transfer.modeFull", uiLanguage)}</option>
          <option value="template">{uiText("ui.transfer.modeTemplate", uiLanguage)}</option>
          <option value="selection">{uiText("ui.transfer.modeSelection", uiLanguage)}</option>
        </select>
      </label>
      {mode === "template" && hasBranches ? (
        <small className="library-transfer-note" role="note">
          {uiText("ui.transfer.templateBranchNote", uiLanguage)}
        </small>
      ) : null}
      <button disabled={busy} onClick={() => void download()} type="button">
        {busy
          ? uiText("ui.transfer.exporting", uiLanguage)
          : uiText("ui.transfer.export", uiLanguage)}
      </button>
      {error ? <p className="library-import-error" role="alert">{error}</p> : null}
    </div>
  );
}

/** 导入向导：选文件 + 模式 → dry-run 报告 → 确认/取消 → 结果。 */
export function WorldImportWizard({
  uiLanguage,
  onImported,
}: {
  uiLanguage: UiLanguage;
  onImported: () => Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<"preserve" | "copy">("preserve");
  const [copyKey, setCopyKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<WizardStep>({ phase: "idle" });

  function buildForm(extra: Record<string, string>): FormData {
    const form = new FormData();
    form.set("file", file!);
    for (const [key, value] of Object.entries(extra)) form.set(key, value);
    return form;
  }

  async function dryRun(event: FormEvent) {
    event.preventDefault();
    if (!file || busy) return;
    setBusy(true);
    setStep({ phase: "idle" });
    try {
      const fields: Record<string, string> = { importMode: mode };
      if (mode === "copy") fields.copyKey = copyKey.trim();
      const response = await fetch("/api/world/import/dry-run", {
        method: "POST",
        body: buildForm(fields),
      });
      const body = (await response.json()) as {
        ok?: boolean;
        jobId?: string;
        report?: DryRunReport;
        alreadyImported?: boolean;
        alreadyValidated?: boolean;
      };
      if (!response.ok || !body.ok || !body.jobId || !body.report) {
        setStep({
          phase: "error",
          message: await readError(response, uiText("ui.transfer.importFailed", uiLanguage)),
        });
        return;
      }
      setStep({
        phase: "report",
        file,
        jobId: body.jobId,
        report: body.report,
        alreadyImported: body.alreadyImported,
        alreadyValidated: body.alreadyValidated,
      });
    } catch {
      setStep({ phase: "error", message: uiText("ui.transfer.importFailed", uiLanguage) });
    } finally {
      setBusy(false);
    }
  }

  async function confirmImport() {
    if (step.phase !== "report" || busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/world/import/execute", {
        method: "POST",
        body: buildForm({ jobId: step.jobId, confirm: "true" }),
      });
      const body = (await response.json()) as {
        ok?: boolean;
        worldId?: string | null;
        alreadyImported?: boolean;
      };
      if (!response.ok || !body.ok) {
        setStep({
          phase: "error",
          message: await readError(response, uiText("ui.transfer.importFailed", uiLanguage)),
        });
        return;
      }
      setStep({
        phase: "done",
        worldId: body.worldId ?? null,
        alreadyImported: body.alreadyImported === true,
      });
      await onImported();
    } catch {
      setStep({ phase: "error", message: uiText("ui.transfer.importFailed", uiLanguage) });
    } finally {
      setBusy(false);
    }
  }

  async function cancelImport() {
    if (step.phase !== "report" || busy) return;
    setBusy(true);
    try {
      await fetch("/api/world/import/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: step.jobId }),
      });
    } finally {
      setBusy(false);
      setStep({ phase: "idle" });
      setFile(null);
    }
  }

  return (
    <div className="library-transfer-import">
      <form onSubmit={(event) => void dryRun(event)}>
        <label className="library-import-trigger">
          <input
            accept=".realm"
            disabled={busy}
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setStep({ phase: "idle" });
            }}
            type="file"
          />
          <span>{uiText("ui.transfer.selectPack", uiLanguage)}</span>
          <small>{file?.name ?? uiText("ui.transfer.noFile", uiLanguage)}</small>
        </label>
        <fieldset className="library-transfer-mode" disabled={busy}>
          <label>
            <input
              checked={mode === "preserve"}
              onChange={() => setMode("preserve")}
              type="radio"
            />
            {uiText("ui.transfer.preserve", uiLanguage)}
          </label>
          <label>
            <input
              checked={mode === "copy"}
              onChange={() => setMode("copy")}
              type="radio"
            />
            {uiText("ui.transfer.copy", uiLanguage)}
          </label>
          {mode === "copy" ? (
            <label>
              {uiText("ui.transfer.copyKey", uiLanguage)}
              <input
                maxLength={32}
                onChange={(event) => setCopyKey(event.target.value)}
                pattern="[a-z0-9][a-z0-9-]*"
                value={copyKey}
              />
            </label>
          ) : null}
        </fieldset>
        <button disabled={busy || !file} type="submit">
          {busy
            ? uiText("ui.transfer.validating", uiLanguage)
            : uiText("ui.transfer.dryRun", uiLanguage)}
        </button>
      </form>

      {step.phase === "report" ? (
        <div className="library-transfer-report" data-kind={step.report.kind ?? ""}>
          <p className="eyebrow">{uiText("ui.transfer.reportTitle", uiLanguage)}</p>
          <small>
            {uiText("ui.transfer.reportSummary", uiLanguage, {
              kind: step.report.kind ?? "",
              world: step.report.targetWorldName ?? "",
              tables: String(step.report.tables?.length ?? 0),
              files: String(step.report.files ?? 0),
            })}
          </small>
          {step.report.kind === "archive" ? (
            <em className="world-archived-badge">
              {uiText("ui.transfer.archiveReadonly", uiLanguage)}
            </em>
          ) : null}
          {step.alreadyImported ? (
            <small>{uiText("ui.transfer.alreadyImported", uiLanguage)}</small>
          ) : null}
          {step.alreadyValidated ? (
            <small>{uiText("ui.transfer.alreadyValidated", uiLanguage)}</small>
          ) : null}
          {step.report.worldExists ? (
            <small className="library-import-error">
              {uiText("ui.transfer.worldExists", uiLanguage)}
            </small>
          ) : null}
          {(step.report.idCollisions?.length ?? 0) > 0 ? (
            <small className="library-import-error">
              {uiText("ui.transfer.idCollisions", uiLanguage)}
              {"："}
              {step.report.idCollisions!.map((c) => `${c.table}:${c.id}`).join("、")}
            </small>
          ) : null}
          {step.report.copyEligible === false ? (
            <small className="library-import-error">
              {uiText("ui.transfer.copyIneligible", uiLanguage)}
              {"："}
              {(step.report.blockingFields ?? [])
                .map((field) => `${field.table}.${field.column}`)
                .join("、")}
            </small>
          ) : null}
          {(step.report.warnings ?? []).map((warning) => (
            <small key={warning}>{warning}</small>
          ))}
          <div className="library-transfer-actions">
            {step.report.kind !== "archive" && !step.alreadyImported && !step.alreadyValidated ? (
              <button disabled={busy} onClick={() => void confirmImport()} type="button">
                {uiText("ui.transfer.confirmImport", uiLanguage)}
              </button>
            ) : null}
            <button disabled={busy} onClick={() => void cancelImport()} type="button">
              {uiText("ui.transfer.cancelImport", uiLanguage)}
            </button>
          </div>
        </div>
      ) : null}
      {step.phase === "done" ? (
        <p className="library-transfer-done">
          {step.alreadyImported
            ? uiText("ui.transfer.doneIdempotent", uiLanguage)
            : uiText("ui.transfer.done", uiLanguage)}
        </p>
      ) : null}
      {step.phase === "error" ? (
        <p className="library-import-error" role="alert">{step.message}</p>
      ) : null}
    </div>
  );
}

/** 导入历史 + job 详情（事件时间线）。 */
export function WorldImportHistory({ uiLanguage }: { uiLanguage: UiLanguage }) {
  const [jobs, setJobs] = useState<ImportJobRow[] | null>(null);
  const [detail, setDetail] = useState<{ id: string; events: JobEvent[] } | null>(null);

  async function load() {
    const response = await fetch("/api/world/import/jobs?limit=20&offset=0");
    if (!response.ok) return;
    const body = (await response.json()) as { ok?: boolean; jobs?: ImportJobRow[] };
    setJobs(body.jobs ?? []);
  }

  async function openDetail(jobId: string) {
    const response = await fetch(`/api/world/import/status?jobId=${encodeURIComponent(jobId)}`);
    if (!response.ok) return;
    const body = (await response.json()) as {
      ok?: boolean;
      job?: { id: string; events?: JobEvent[] };
    };
    if (body.job) {
      setDetail({ id: body.job.id, events: body.job.events ?? [] });
    }
  }

  return (
    <details className="library-transfer-history">
      <summary onClick={() => void (jobs === null && load())}>
        {uiText("ui.transfer.history", uiLanguage)}
      </summary>
      {jobs === null ? null : jobs.length === 0 ? (
        <small>{uiText("ui.transfer.historyEmpty", uiLanguage)}</small>
      ) : (
        <ul>
          {jobs.map((job) => (
            <li key={job.id}>
              <button onClick={() => void openDetail(job.id)} type="button">
                {`${job.direction}/${job.mode} · ${job.status}`}
              </button>
              <small>{job.updatedAt.slice(0, 19).replace("T", " ")}</small>
            </li>
          ))}
        </ul>
      )}
      {detail ? (
        <ol className="library-transfer-timeline">
          {detail.events.map((event) => (
            <li key={event.seq}>
              <code>{event.kind}</code>
              <small>{event.at.slice(0, 19).replace("T", " ")}</small>
            </li>
          ))}
        </ol>
      ) : null}
    </details>
  );
}
