/**
 * Anima scene workflow manifest 契约（anima-scene-manifest-contract）。
 *
 * 钉住：
 * A. manifest 可解析、顶层/工作流字段白名单稳定（无 graph 以外业务数据）；
 * B. T2I/I2I 语义 binding 集合完整且恰好为约定键；
 * C. 每个 binding/依赖/outputNode 反查 graph 真实存在（node + input），
 *    模型依赖文件名与 graph loader 输入一致；
 * D. 无绝对路径（C:/、/home/、/tmp）、无 token/password/secret/Bearer 等
 *    凭据字样；I2I inputImage 为 runtimeOverride 且 graph 值为相对占位名；
 * E. AnimaLLLite/ControlNet/tinyterraNodes 不得被列为当前依赖。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const readJson = (path) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8"));
const readText = (path) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

const MANIFEST_PATH = "workflows/realm/anima-scene-v0.manifest.json";
const manifest = readJson(MANIFEST_PATH);
const manifestRaw = readText(MANIFEST_PATH);

const EXPECTED_BINDINGS = {
  t2i: ["positivePrompt", "negativePrompt", "seed", "width", "height", "outputPrefix"],
  i2i: ["positivePrompt", "negativePrompt", "seed", "inputImage", "denoise", "outputPrefix"],
};

test("A. manifest 结构白名单与稳定性", () => {
  assert.equal(manifest.manifestVersion, 1);
  assert.equal(manifest.id, "anima-scene-v0");
  assert.equal(manifest.runtime, "local");
  assert.deepEqual(
    Object.keys(manifest).sort(),
    ["deferredEnhancements", "description", "id", "manifestVersion", "runtime", "smokeInput", "title", "workflows"].sort(),
    "顶层字段不得超出白名单（无业务数据）",
  );
  assert.deepEqual(Object.keys(manifest.workflows).sort(), ["i2i", "t2i"]);
  for (const workflow of Object.values(manifest.workflows)) {
    assert.deepEqual(
      Object.keys(workflow).sort(),
      ["bindings", "graphFile", "id", "kind", "modelDependencies", "outputNode", "requiresInputImage", "runtime", "version"].sort(),
      "workflow 字段不得超出白名单",
    );
    assert.equal(workflow.runtime, "local");
  }
});

test("B/C. binding 集合完整且逐项反查 graph 真实 node/input", () => {
  for (const [name, workflow] of Object.entries(manifest.workflows)) {
    const graph = readJson(`workflows/realm/${workflow.graphFile}`);
    assert.deepEqual(
      Object.keys(workflow.bindings).sort(),
      EXPECTED_BINDINGS[name].slice().sort(),
      `${name} binding 键集合必须恰好为约定值`,
    );
    for (const [bindingName, binding] of Object.entries(workflow.bindings)) {
      const node = graph[binding.node];
      assert.ok(node, `${name}.${bindingName}: node ${binding.node} 不在 graph 中`);
      assert.ok(
        Object.hasOwn(node.inputs, binding.input),
        `${name}.${bindingName}: node ${binding.node} 无 input ${binding.input}`,
      );
    }
    // 输出节点真实存在且为 SaveImage。
    const outputNode = graph[workflow.outputNode.node];
    assert.ok(outputNode, `${name} outputNode 不在 graph 中`);
    assert.equal(outputNode.class_type, workflow.outputNode.classType);
    assert.equal(workflow.outputNode.classType, "SaveImage");
    // 模型依赖文件名与 graph loader 输入一致（不允许漂移）。
    for (const dep of workflow.modelDependencies) {
      const node = graph[dep.node];
      assert.ok(node, `${name} dep ${dep.file}: node ${dep.node} 不在 graph 中`);
      assert.equal(
        node.inputs[dep.input],
        dep.file,
        `${name} dep ${dep.kind} 文件名与 graph 不一致`,
      );
    }
    assert.deepEqual(
      workflow.modelDependencies.map((dep) => dep.file).sort(),
      ["anima-turbo-v1.0.safetensors", "qwen_3_06b_base.safetensors", "qwen_image_vae.safetensors"].sort(),
      `${name} 模型依赖必须恰为三个已验证文件`,
    );
  }
  // T2I/I2I 形态标志。
  assert.equal(manifest.workflows.t2i.requiresInputImage, false);
  assert.equal(manifest.workflows.i2i.requiresInputImage, true);
});

test("D. 无绝对路径/凭据；I2I 输入图为运行时覆盖项", () => {
  assert.ok(!/C:\\|\/home\/|\/tmp\//.test(manifestRaw), "manifest 不得含绝对路径");
  assert.ok(
    !/token|password|secret|Bearer|api[_-]?key/i.test(manifestRaw),
    "manifest 不得含凭据字样",
  );
  const inputBinding = manifest.workflows.i2i.bindings.inputImage;
  assert.equal(inputBinding.runtimeOverride, true, "I2I inputImage 必须标记运行时覆盖");
  const graph = readJson(`workflows/realm/${manifest.workflows.i2i.graphFile}`);
  const graphValue = graph[inputBinding.node].inputs[inputBinding.input];
  assert.ok(!/C:\\|\/home\/|\/tmp\/|\//.test(graphValue), "graph 输入图必须是相对占位名");
  assert.equal(graphValue, "realm_anima_scene_v0_input.png");
  // smoke 记录指向同一 binding/node，且不记录远端路径。
  assert.equal(manifest.smokeInput.workflow, "i2i");
  assert.equal(manifest.smokeInput.binding, "inputImage");
  assert.equal(manifest.smokeInput.node, inputBinding.node);
});

test("E. 后续增强节点不得列为当前依赖", () => {
  assert.ok(!/AnimaLLLite|ControlNet|tinyterraNodes/i.test(
    JSON.stringify(manifest.workflows),
  ), "workflows 内不得引用后续增强节点");
  assert.deepEqual(manifest.deferredEnhancements.required, []);
});
