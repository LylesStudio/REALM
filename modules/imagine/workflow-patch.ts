/**
 * workflow patcher（server-only）：按 semantic manifest 的 bindings 把
 * 业务输入注入 API graph。node id 只允许来自 manifest——业务/业务测试
 * 代码不得硬编码（scene-image-wiring-contract 静态围栏）。
 * 不 dispatch：本模块只产出可执行 payload（patched graph）。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// server 运行根 = 仓库根（dev-server/launcher/systemd 一致）；不能用
// import.meta.url 相对定位——生产 bundle 后模块路径在 dist/ 下会错位。

export interface WorkflowBinding {
  node: string;
  input: string;
  runtimeOverride?: boolean;
}

export interface WorkflowManifestEntry {
  id: string;
  version: string;
  kind: string;
  graphFile: string;
  runtime: string;
  requiresInputImage: boolean;
  outputNode: { node: string; classType: string };
  modelDependencies: readonly {
    kind: string;
    file: string;
    node: string;
    input: string;
  }[];
  bindings: Record<string, WorkflowBinding>;
}

export interface SceneWorkflowManifest {
  manifestVersion: number;
  id: string;
  runtime: string;
  workflows: Record<string, WorkflowManifestEntry>;
}

export type ApiGraph = Record<
  string,
  { class_type: string; inputs: Record<string, unknown> }
>;

function workflowPath(filename: string): string {
  if (!/^[a-z0-9.-]+\.json$/i.test(filename)) {
    throw new SceneWorkflowError("INVALID_WORKFLOW_FILE", "非法 workflow 文件名。");
  }
  return resolve(process.cwd(), "workflows", "realm", filename);
}

export class SceneWorkflowError extends Error {
  readonly code: "INVALID_WORKFLOW_FILE" | "UNKNOWN_BINDING" | "GRAPH_NODE_MISSING"
    | "COMFYUI_DISABLED";

  constructor(code: SceneWorkflowError["code"], message: string) {
    super(message);
    this.name = "SceneWorkflowError";
    this.code = code;
  }
}

export function loadSceneWorkflowManifest(): SceneWorkflowManifest {
  return JSON.parse(
    readFileSync(workflowPath("anima-scene-v0.manifest.json"), "utf8"),
  ) as SceneWorkflowManifest;
}

export function loadWorkflowGraph(graphFile: string): ApiGraph {
  return JSON.parse(readFileSync(workflowPath(graphFile), "utf8")) as ApiGraph;
}

export interface WorkflowPatchInputs {
  positivePrompt: string;
  negativePrompt?: string;
  seed?: number;
  width?: number;
  height?: number;
  outputPrefix?: string;
}

/**
 * 按 semantic bindings 注入输入并返回 patched graph（不改动传入 graph）。
 * 未提供的字段保持 graph 现值；effective 值以 patched graph 为准。
 */
export function patchWorkflowGraph(options: {
  manifest: SceneWorkflowManifest;
  workflow: "t2i";
  graph: ApiGraph;
  inputs: WorkflowPatchInputs;
}): ApiGraph {
  const entry = options.manifest.workflows[options.workflow];
  if (!entry) {
    throw new SceneWorkflowError("UNKNOWN_BINDING", `未知 workflow：${options.workflow}`);
  }
  const patched = structuredClone(options.graph);
  const apply = (bindingName: keyof WorkflowPatchInputs, value: string | number | undefined) => {
    if (value === undefined) return;
    const binding = entry.bindings[bindingName];
    if (!binding) {
      throw new SceneWorkflowError(
        "UNKNOWN_BINDING",
        `workflow ${options.workflow} 未声明 binding：${bindingName}`,
      );
    }
    const node = patched[binding.node];
    if (!node || !(binding.input in node.inputs)) {
      throw new SceneWorkflowError(
        "GRAPH_NODE_MISSING",
        `graph 缺少 binding 目标：${bindingName}`,
      );
    }
    node.inputs[binding.input] = value;
  };
  apply("positivePrompt", options.inputs.positivePrompt);
  apply("negativePrompt", options.inputs.negativePrompt);
  apply("seed", options.inputs.seed);
  apply("width", options.inputs.width);
  apply("height", options.inputs.height);
  apply("outputPrefix", options.inputs.outputPrefix);
  return patched;
}

/** 从 patched graph 经 manifest 反读 effective 值（单一事实源 = graph）。 */
export function readPatchedValue(
  manifest: SceneWorkflowManifest,
  workflow: "t2i",
  graph: ApiGraph,
  bindingName: string,
): unknown {
  const binding = manifest.workflows[workflow]?.bindings[bindingName];
  if (!binding) {
    throw new SceneWorkflowError("UNKNOWN_BINDING", `未知 binding：${bindingName}`);
  }
  return graph[binding.node]?.inputs[binding.input];
}
