import assert from "node:assert/strict";
import test from "node:test";
import {
  tolerantParseJsonObject,
} from "../modules/inference/structured-output.ts";

test("tolerant parser accepts a plain JSON object", () => {
  assert.deepEqual(tolerantParseJsonObject('{"a":1,"b":"x"}'), { a: 1, b: "x" });
});

test("tolerant parser strips UTF-8 BOM and surrounding whitespace", () => {
  assert.deepEqual(tolerantParseJsonObject('﻿  \n {"a":1} \n'), { a: 1 });
});

test("tolerant parser accepts a standard markdown fenced json block", () => {
  assert.deepEqual(
    tolerantParseJsonObject('```json\n{"a":1}\n```'),
    { a: 1 },
  );
  assert.deepEqual(
    tolerantParseJsonObject('```\n{"a":1}\n```'),
    { a: 1 },
  );
});

test("tolerant parser tolerates a short prose preamble and trailing note", () => {
  assert.deepEqual(
    tolerantParseJsonObject('Sure, here is the result:\n{"a":1}\nHope this helps.'),
    { a: 1 },
  );
});

test("tolerant parser strips trailing commas safely", () => {
  assert.deepEqual(
    tolerantParseJsonObject('{"a":1, "b":[1,2,],}'),
    { a: 1, b: [1, 2] },
  );
  // 字符串内的逗号/括号不受影响。
  assert.deepEqual(
    tolerantParseJsonObject('{"a":"x,}",}'),
    { a: "x,}" },
  );
});

test("tolerant parser rejects arrays, scalars, multiple objects and eval-able junk", () => {
  assert.equal(tolerantParseJsonObject('[{"a":1}]'), null);
  assert.equal(tolerantParseJsonObject('"just a string"'), null);
  assert.equal(tolerantParseJsonObject('{"a":1} {"b":2}'), null);
  assert.equal(tolerantParseJsonObject('{"a": process.exit(1)}'), null);
  assert.equal(tolerantParseJsonObject('not json at all'), null);
  assert.equal(tolerantParseJsonObject(''), null);
  // 截断的不完整 object 不得 salvage。
  assert.equal(tolerantParseJsonObject('{"a":1, "b":"unterminated'), null);
});

test("tolerant parser keeps nested objects intact", () => {
  assert.deepEqual(
    tolerantParseJsonObject('prefix\n{"a":{"b":{"c":[1,{"d":2}]}}}\nsuffix'),
    { a: { b: { c: [1, { d: 2 }] } } },
  );
});
