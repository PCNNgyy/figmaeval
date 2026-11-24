import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";

import {
  DEFAULT_FIXED20_PROMPT, FIXED20_QUESTIONS, LAYER_ONLY_KEYS, REQUIRED_FIXED20_BLANKS,
  buildDefaultScalePrompt, buildFixed20Prompt, fixed20Total, mergeHumanValues,
  normalizeFixed20Config, parseFixed20Result, renderLayerBlock, renderQuestionBlock, summarizeLayerTree
} from "../server/fixed20_scale.mjs";
import {
  DEFAULT_SCALE_METHOD, getScaleMethod, listScaleMethods, publicScaleMethod
} from "../server/fixed_scales/index.mjs";

test("注册表：键唯一、满分 = 各题满分之和、默认模板占位符齐全、门槛题不混进计分题", () => {
  const all = listScaleMethods({ all: true });
  assert.ok(all.length >= 2);
  assert.equal(new Set(all.map((def) => def.key)).size, all.length);
  for (const def of all) {
    const keys = def.questions.map((question) => question.key);
    assert.equal(new Set(keys).size, keys.length, `${def.key} 题号重复`);
    assert.ok(!keys.includes(def.gate.key), `${def.key} 把 G0 混进了计分题`);
    assert.equal(def.max, def.questions.reduce((sum, question) => sum + (question.max ?? 2), 0));
    for (const blank of REQUIRED_FIXED20_BLANKS) assert.ok(def.prompt_template.includes(blank), `${def.key} 缺 ${blank}`);
    assert.ok(Object.isFrozen(def));
  }
  assert.equal(DEFAULT_SCALE_METHOD, "fixed_v4");
});

test("fixed20 条目原样引用 v1 常量：题目同一引用、模板恒等、Q17~Q20 是 layer_only", () => {
  const def = getScaleMethod("fixed20");
  assert.equal(def.questions, FIXED20_QUESTIONS);
  assert.equal(def.prompt_template, DEFAULT_FIXED20_PROMPT);
  assert.equal(def.max, 40);
  assert.deepEqual(LAYER_ONLY_KEYS, ["Q17", "Q18", "Q19", "Q20"]);
  assert.ok(!/\n\s+2 = /.test(renderQuestionBlock(FIXED20_QUESTIONS)));
  const shape = publicScaleMethod(def);
  assert.deepEqual(Object.keys(shape).sort(), ["description", "has_layer", "key", "max", "name", "question_count", "short", "status"].sort());
  assert.equal(shape.question_count, 20);
});

test("题池：每题带标准并印进提示词，只有 G 组带「看图层」后缀，题数约束写对", () => {
  const def = getScaleMethod("fixed_v3pool");
  assert.equal(def.status, "experimental");
  assert.ok(def.questions.length >= 40);
  assert.ok(def.questions.every((question) => question.standards && question.standards[2] && question.standards[0]),
    "题池每题都要有 2/1/0 标准，空着的题会退回「没毛病就 2」");
  assert.ok(def.questions.every((question) => question.layer), "题池每题都要标层级，雷达按层聚合靠它");
  const block = renderQuestionBlock(def.questions);
  assert.match(block, /A5 ｜ 用户体验：.*\n\s+2 = 所有关键控件具有明确可操作形态/);
  const layerTagged = block.split("\n").filter((line) => line.includes("依据图层结构判断"));
  assert.equal(layerTagged.length, def.questions.filter((question) => question.layer_only).length);
  assert.ok(layerTagged.every((line) => /^G\d/.test(line)), "只有 G 组该带图层后缀");

  const prompt = buildFixed20Prompt(def.prompt_template, {
    query: "做一个 CRM", imageBlock: "第 1 屏", questions: def.questions,
    layerSummary: null, layerLabel: def.layer_label, layerHints: def.layer_hints
  });
  assert.match(prompt, new RegExp(`恰好覆盖 A1 到 G6 全部 ${def.questions.length} 题`));
  assert.match(prompt, /G1~G6 请标为无法判定/, "缺图层树时的提示要用题池自己的题号");
  assert.match(prompt, /成熟产品水准/, "题池把 2 分门槛抬高了");
  assert.match(prompt, /先盘点，再打分/);
  assert.ok(!prompt.includes("Q17"), "题池提示词里不该残留 v1 题号");
  for (const question of def.questions) assert.ok(prompt.includes(`${question.key} ｜`), `${question.key} 没进提示词`);
});

test("buildDefaultScalePrompt：没有 layer_only 题时省掉图层段落，章节编号跟着变", () => {
  const prompt = buildDefaultScalePrompt({
    name: "试验量表", questions: [{ key: "X1", dimension: "d", text: "t" }, { key: "X2", dimension: "d", text: "t" }]
  });
  assert.ok(!prompt.includes("【图层结构】"));
  assert.match(prompt, /四、输出格式/);
  assert.match(prompt, /五、上下文材料/);
  assert.match(prompt, /X1~X2 三档打分/);
  assert.match(prompt, /恰好覆盖 X1 到 X2 全部 2 题/);
});

test("非 Q 题号：total / parse / merge / config 对 A1、D7、G5 同样成立", () => {
  const questions = [
    { key: "A1", dimension: "a", text: "x" },
    { key: "D7", dimension: "d", text: "y" },
    { key: "G5", dimension: "g", text: "z", layer_only: true }
  ];
  assert.equal(fixed20Total({ A1: 2, D7: 1, G5: 2 }, true, questions), 5);
  assert.equal(fixed20Total({ A1: 2, D7: 1, G5: 2 }, false, questions), 0);
  const parsed = parseFixed20Result({ scores: [{ key: "d7", score: 9, evidence: "第 1 屏" }] }, questions);
  assert.equal(parsed.values.D7, 2, "小写题号要认、界外值要夹");
  assert.deepEqual(parsed.missing, ["A1", "G5"]);
  const merged = mergeHumanValues({ A1: 2, D7: 2, G5: 2 }, { A1: 0, G5: 1 }, questions);
  assert.deepEqual(merged.changed, ["A1", "G5"]);
  assert.equal(merged.values.D7, 2);
  const pool = getScaleMethod("fixed_v3pool");
  const config = normalizeFixed20Config({}, pool);
  assert.equal(config.method, "fixed_v3pool");
  assert.equal(config.prompt_template, pool.prompt_template);
  assert.equal(normalizeFixed20Config({}).method, "fixed20");
});

test("renderLayerBlock 的题号与提示可换：题池不该在图层段落里看到 Q17", () => {
  assert.match(renderLayerBlock(null, { label: "G1~G6" }), /G1~G6 请标为无法判定/);
  const summary = summarizeLayerTree('<canvas id="0:1"><frame id="1:2" name="P1" width="10" height="10"><text id="1:3" name="t" /></frame></canvas>');
  const block = renderLayerBlock(summary, { hints: ["- 自定义提示 G5"] });
  assert.match(block, /自定义提示 G5/);
  assert.ok(!block.includes("Q17"));
  assert.match(renderLayerBlock(summary), /Q17 该给 0/);
});

test("experimental 的默认列表里看不到；未知量表为 null", () => {
  assert.equal(getScaleMethod("no_such_method"), null);
  const stable = listScaleMethods().map((def) => def.key);
  assert.ok(stable.includes("fixed20"));
  assert.ok(!stable.includes("fixed_v3pool"), "题池只给批量页做实验，工作台默认不列");
  assert.ok(listScaleMethods({ all: true }).map((def) => def.key).includes("fixed_v3pool"));
});

test("fixed_v2：20 题 40 分、stable、每题带标准与层级、题池键可对照、天花板题不回流", () => {
  const def = getScaleMethod("fixed_v2");
  assert.ok(def, "v2 已定稿，必须注册");
  assert.equal(def.status, "stable");
  assert.equal(def.questions.length, 20);
  assert.equal(def.max, 40);
  const pool = getScaleMethod("fixed_v3pool");
  const poolKeys = new Set(pool.questions.map((question) => question.key));
  for (const question of def.questions) {
    assert.ok(poolKeys.has(question.key), `${question.key} 不是题池里的键`);
    assert.ok(question.standards?.[2] && question.standards?.[1] && question.standards?.[0]);
    assert.ok(question.layer && question.dimension);
  }
  const keys = def.questions.map((question) => question.key);
  for (const banned of ["G1", "G2", "G5", "G6", "A3", "A4", "A6", "B2", "B3", "C1", "D2", "D3", "D6", "D9", "E1", "E2", "F1", "F5"]) {
    assert.ok(!keys.includes(banned), `${banned} 在题池里是天花板/地板题，不该进 v2`);
  }
  for (const kept of ["F2", "N1", "N3", "F6", "E4", "B1", "D5", "G3", "G4"]) {
    assert.ok(keys.includes(kept), `${kept} 是题池里拉得开的题，v2 必须保留`);
  }
  assert.match(def.prompt_template, /G3~G4 要看图层结构/);
  assert.ok(listScaleMethods().map((entry) => entry.key).includes("fixed_v2"), "v2 是 stable，工作台默认可选");
});

test("混合分值改造不动已有量表：v1/v2/题池/v3-9.8 的提示词与改前指纹一致", () => {
  const fingerprint = (text) => crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
  const expected = {
    fixed20: { template: "38c3359fb6ec1d03", questions: "980debbe2ccd1c8e", rendered: "dd9fda7a42550a5a" },
    fixed_v3pool: { template: "2e212e761260bbbc", questions: "3ddb4a2ea450032d", rendered: "970f9cb7b9c92c3a" },
    fixed_v2: { template: "efe4bfd706271886", questions: "330b1c20c2617dc0", rendered: "c079663b618c4ede" },
    fixed_v3_0908: { template: "09c9be560c6583ee", questions: "c7841d6cd9ec47a0", rendered: "ebaff1412ac360ef" }
  };
  for (const [key, want] of Object.entries(expected)) {
    const def = getScaleMethod(key);
    const rendered = buildFixed20Prompt(def.prompt_template, {
      query: "Q", imageBlock: "IMG", layerSummary: null, questions: def.questions,
      layerLabel: def.layer_label, layerHints: def.layer_hints
    });
    assert.deepEqual({
      template: fingerprint(def.prompt_template),
      questions: fingerprint(renderQuestionBlock(def.questions)),
      rendered: fingerprint(rendered)
    }, want, `${key} 的提示词变了`);
  }
});

test("混合分值：0-3 题夹到 3、0-2 题夹到 2；total / parse / merge 按每题满分算", () => {
  const questions = [{ key: "A1", dimension: "a", text: "x" }, { key: "B1", dimension: "b", text: "y", max: 3 }];
  assert.equal(fixed20Total({ A1: 9, B1: 9 }, true, questions), 5);
  const parsed = parseFixed20Result({ scores: [{ key: "a1", score: 3 }, { key: "B1", score: 3 }] }, questions);
  assert.deepEqual(parsed.values, { A1: 2, B1: 3 }, "0-2 题给 3 要夹到 2，0-3 题给 3 保留");
  const merged = mergeHumanValues({ A1: 2, B1: 1 }, { B1: 3 }, questions);
  assert.deepEqual(merged.values, { A1: 2, B1: 3 });
  assert.deepEqual(merged.changed, ["B1"]);
});

test("fixed_v4：22 题 53 分、稳定版、B/D 为 0-3、两大维度各 11 题、自有 G0、提示词带分值标注与评审规则", () => {
  const def = getScaleMethod("fixed_v4");
  assert.ok(def, "v4 必须注册");
  assert.equal(def.status, "stable");
  assert.equal(def.questions.length, 22);
  assert.equal(def.max, 53);
  const maxOf = Object.fromEntries(def.questions.map((question) => [question.key, question.max ?? 2]));
  for (const key of ["B1", "B2", "B3", "B4", "B5", "D1", "D2", "D3", "D4"]) assert.equal(maxOf[key], 3, `${key} 应为 0-3`);
  for (const key of ["A1", "A2", "A3", "A4", "G1", "G2", "E1", "E2", "F1", "F2", "F3", "F4", "F5"]) assert.equal(maxOf[key], 2, `${key} 应为 0-2`);
  assert.equal(def.questions.filter((question) => question.perspective === "可用易用").length, 11);
  assert.equal(def.questions.filter((question) => question.perspective === "美学").length, 11);
  for (const question of def.questions) {
    const levels = Object.keys(question.standards).map(Number).sort((a, b) => a - b);
    assert.deepEqual(levels, question.max === 3 ? [0, 1, 2, 3] : [0, 1, 2], `${question.key} 的档位标准不全`);
  }
  assert.deepEqual(def.questions.filter((question) => question.layer_only).map((question) => question.key), ["G1", "G2"]);
  const full = Object.fromEntries(def.questions.map((question) => [question.key, 3]));
  assert.equal(fixed20Total(full, true, def.questions), 53, "全给 3 也只能拿 53（0-2 题被夹到 2）");

  assert.match(def.gate.text, /大面积重叠/);
  assert.match(def.prompt_template, /大面积重叠/, "v4 的 G0 门槛原文要进提示词");
  assert.match(def.prompt_template, /分档打分/);
  assert.match(def.prompt_template, /标了「（0-3 分）」的题可给 0、1、2、3/);
  assert.match(def.prompt_template, /按影响评分，不机械数缺陷/);
  assert.match(def.prompt_template, /C1、C2 是旧版题号/);
  const block = renderQuestionBlock(def.questions);
  assert.match(block, /B1 ｜ 信息组织：[^\n]*（0-3 分）/);
  assert.match(block, /\n {4}3 = 分组符合内容关系/);
  assert.ok(!/A1 ｜[^\n]*（0-3 分）/.test(block), "0-2 题不标分值范围");
  assert.ok(listScaleMethods().map((entry) => entry.key).includes("fixed_v4"), "稳定版，工作台默认可选");
});
