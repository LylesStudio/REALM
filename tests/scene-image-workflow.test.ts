/**
 * workflow patcher 测试：semantic manifest bindings → patched graph。
 * 测试自身也只经 manifest 反查 node id（不硬编码），并验证原 graph 不被改写。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  loadSceneWorkflowManifest,
  loadWorkflowGraph,
  patchWorkflowGraph,
  readPatchedValue,
  SceneWorkflowError,
} from "../modules/imagine/public.ts";

const manifest = loadSceneWorkflowManifest();
const graph = loadWorkflowGraph(manifest.workflows.t2i.graphFile);

function bindingOf(name: string) {
  const binding = manifest.workflows.t2i.bindings[name];
  assert.ok(binding, `manifest 缺 binding: ${name}`);
  return binding;
}

test("patcher: semantic 输入经 manifest binding 落入正确 node/input", () => {
  const patched = patchWorkflowGraph({
    manifest,
    workflow: "t2i",
    graph,
    inputs: {
      positivePrompt: "POSITIVE_SENTINEL_XQ",
      negativePrompt: "NEGATIVE_SENTINEL_ZR",
      seed: 424242,
      width: 640,
      height: 768,
      outputPrefix: "realm_test_prefix_sentinel",
    },
  });
  const read = (name: string) => {
    const binding = bindingOf(name);
    return patched[binding.node]?.inputs[binding.input];
  };
  assert.equal(read("positivePrompt"), "POSITIVE_SENTINEL_XQ");
  assert.equal(read("negativePrompt"), "NEGATIVE_SENTINEL_ZR");
  assert.equal(read("seed"), 424242);
  assert.equal(read("width"), 640);
  assert.equal(read("height"), 768);
  assert.equal(read("outputPrefix"), "realm_test_prefix_sentinel");
  // readPatchedValue 与直读一致（单一事实源）。
  assert.equal(
    readPatchedValue(manifest, "t2i", patched, "positivePrompt"),
    "POSITIVE_SENTINEL_XQ",
  );
  // 原 graph 不被改写。
  const originalPositive = bindingOf("positivePrompt");
  assert.notEqual(
    graph[originalPositive.node]?.inputs[originalPositive.input],
    "POSITIVE_SENTINEL_XQ",
  );
  // manifest 的 binding 坐标与 graph 结构真实对齐（已验证 smoke 的节点类型）。
  assert.equal(graph[bindingOf("positivePrompt").node]?.class_type, "CLIPTextEncode");
  assert.equal(graph[bindingOf("seed").node]?.class_type, "KSampler");
  assert.equal(graph[bindingOf("width").node]?.class_type, "EmptyLatentImage");
  assert.equal(graph[bindingOf("outputPrefix").node]?.class_type, "SaveImage");
});

test("patcher: 未提供字段保持 graph 现值", () => {
  const patched = patchWorkflowGraph({
    manifest,
    workflow: "t2i",
    graph,
    inputs: { positivePrompt: "ONLY_PROMPT_SENTINEL" },
  });
  const seedBinding = bindingOf("seed");
  assert.equal(
    patched[seedBinding.node]?.inputs[seedBinding.input],
    graph[seedBinding.node]?.inputs[seedBinding.input],
    "未覆盖的 seed 必须保持 graph 现值",
  );
});

test("patcher: graph 缺 binding 目标 fail-closed", () => {
  const broken = structuredClone(graph);
  delete broken[bindingOf("seed").node];
  assert.throws(
    () =>
      patchWorkflowGraph({
        manifest,
        workflow: "t2i",
        graph: broken,
        inputs: { positivePrompt: "x", seed: 1 },
      }),
    (error: unknown) => {
      assert.ok(error instanceof SceneWorkflowError);
      assert.equal(error.code, "GRAPH_NODE_MISSING");
      return true;
    },
  );
  assert.throws(
    () => readPatchedValue(manifest, "t2i", graph, "no-such-binding"),
    (error: unknown) => {
      assert.ok(error instanceof SceneWorkflowError);
      assert.equal(error.code, "UNKNOWN_BINDING");
      return true;
    },
  );
});
