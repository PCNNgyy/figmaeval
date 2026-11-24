import assert from "node:assert/strict";
import test from "node:test";

import {
  FIXED20_MAX,
  FIXED20_QUESTIONS,
  DEFAULT_FIXED20_PROMPT,
  buildFixed20Prompt,
  fixed20Total,
  mergeHumanValues,
  normalizeChangeNotes,
  normalizeFixed20Config,
  parseFixed20Result,
  renderLayerBlock,
  renderQuestionBlock,
  summarizeLayerTree
} from "../server/fixed20_scale.mjs";

const allTwo = Object.fromEntries(FIXED20_QUESTIONS.map((question) => [question.key, 2]));

test("题目就是那 20 道，满分 40，G0 不在计分题里", () => {
  assert.equal(FIXED20_QUESTIONS.length, 20);
  assert.equal(FIXED20_MAX, 40);
  assert.deepEqual(FIXED20_QUESTIONS.map((q) => q.key).slice(0, 3), ["Q1", "Q2", "Q3"]);
  assert.ok(!FIXED20_QUESTIONS.some((q) => q.key === "G0"), "G0 是前置门槛，不能混进计分题");
  assert.equal(fixed20Total(allTwo, true), 40);
});

test("G0 不通过 → 总分直接 0，哪怕 20 题全给满分", () => {
  assert.equal(fixed20Total(allTwo, false), 0);
  const half = Object.fromEntries(FIXED20_QUESTIONS.map((q) => [q.key, 1]));
  assert.equal(fixed20Total(half, true), 20);
  assert.equal(fixed20Total({ Q1: 5, Q2: -1, Q3: "二" }, true), 2);
});

test("解析：夹紧到 0/1/2、漏题补 0 并标出来、坏 JSON 不抛", () => {
  const good = parseFixed20Result({
    g0: { pass: true, reason: "十一屏都能打开，核心流程齐全" },
    scores: FIXED20_QUESTIONS.map((q) => ({ key: q.key, score: 2, evidence: "第 1 屏顶部…" }))
  });
  assert.equal(good.g0_pass, true);
  assert.equal(good.missing.length, 0);
  assert.equal(good.parse_error, "");
  assert.equal(fixed20Total(good.values, good.g0_pass), 40);

  const partial = parseFixed20Result({
    g0: { pass: false, reason: "整页空白" },
    scores: [{ key: "q1", score: 9 }, { key: "Q2", score: -3 }]
  });
  assert.equal(partial.g0_pass, false);
  assert.equal(partial.values.Q1, 2, "小写 key 也要认，并夹到上限");
  assert.equal(partial.values.Q2, 0);
  assert.equal(partial.missing.length, 18);
  assert.match(partial.parse_error, /漏了 18 题/);

  const broken = parseFixed20Result(null);
  assert.equal(broken.g0_pass, false);
  assert.match(broken.parse_error, /没有返回可解析的 JSON/);
  assert.equal(parseFixed20Result({ scores: [] }).g0_pass, true);
});

test("图层树摘要：压掉正文只留结构，Q17~Q20 靠它判断", () => {
  const xml = `<canvas id="0:1" name="Page 1">
  <frame id="1:2" name="P1 客户列表" width="1440" height="900">
    <frame id="1:3" name="侧边栏">
      <text id="1:5" name="销售云 CRM" />
      <instance id="1:6" name="nav-item" />
      <instance id="1:7" name="nav-item" />
    </frame>
    <text id="1:9" name="客户列表" />
  </frame>
  <frame id="2:2" name="P2 客户详情" width="1440" height="900">
    <image id="2:3" name="整页截图" />
  </frame>
</canvas>`;
  const summary = summarizeLayerTree(xml);
  assert.equal(summary.board_count, 2);
  const [first, second] = summary.boards;
  assert.equal(first.name, "P1 客户列表");
  assert.equal(first.size, "1440×900");
  assert.equal(first.instances, 2, "组件实例要单独计数——Q20 靠它判复用");
  assert.equal(first.texts, 2);
  assert.ok(first.max_depth >= 1);
  assert.equal(second.images, 1);
  assert.equal(second.texts, 0, "整页图片的画板文本数为 0——Q17 的判据");

  const block = renderLayerBlock(summary);
  assert.match(block, /P1 客户列表/);
  assert.match(block, /组件实例/);
  assert.match(block, /Q17/);
  assert.match(renderLayerBlock(null), /无法判定/);
  assert.equal(summarizeLayerTree(""), null);
});

test("提示词：占位符全替换，锚点与纪律都在，缺占位符要拦下来", () => {
  const config = normalizeFixed20Config({});
  const prompt = buildFixed20Prompt(config.prompt_template, {
    query: "做一个 CRM 桌面端",
    imageBlock: "第 1 屏 · 客户列表\n    绝对路径：/runs/x/a.png",
    layerSummary: summarizeLayerTree('<canvas id="0:1"><frame id="1:2" name="P1" width="1440" height="900"><text id="1:3" name="标题" /></frame></canvas>'),
    criteriaSummary: { score_100: 72 }
  });
  ["【Query】", "【截图清单】", "【题目清单】", "【图层结构】", "【已有检查点得分】"].forEach((blank) => {
    assert.ok(!prompt.includes(blank), `${blank} 未被替换`);
  });
  assert.ok(prompt.includes("做一个 CRM 桌面端"));
  assert.ok(prompt.includes("Q20"), "20 题都要出现在提示词里");
  assert.match(prompt, /全给 1 是最常见的失效/, "没有这条纪律模型会全给 1");
  assert.match(prompt, /G0 不通过时总分直接计 0/);
  assert.match(prompt, /不要使用英文双引号/, "裸双引号打断 JSON 是踩过的坑");
  assert.ok(prompt.includes("得了 72 分"));

  assert.throws(
    () => normalizeFixed20Config({ prompt_template: "没有占位符" }),
    /缺少占位符 【Query】、【截图清单】、【题目清单】/
  );
  assert.ok(DEFAULT_FIXED20_PROMPT.includes("Read 工具"), "必须明令先看图");
  assert.match(renderQuestionBlock(), /Q17 ｜ 可编辑性/);
  assert.match(renderQuestionBlock(), /依据图层结构判断/, "看图判不了的题要点名");
});

test("人工改分：人工值优先，并记下改了哪几题", () => {
  const cc = { ...allTwo, Q3: 0, Q7: 1 };
  const merged = mergeHumanValues(cc, { Q3: 2, Q7: 1, Q9: 0 });
  assert.equal(merged.values.Q3, 2, "人工值覆盖 CC");
  assert.equal(merged.values.Q9, 0);
  assert.deepEqual(merged.changed.sort(), ["Q3", "Q9"], "Q7 人工填了同样的值，不算改动");
  assert.equal(fixed20Total(merged.values, true), 37);

  const untouched = mergeHumanValues(cc, {});
  assert.deepEqual(untouched.changed, []);
  assert.equal(fixed20Total(untouched.values, true), fixed20Total(cc, true));
});

test("改分理由只留给确实改了的题，改回原值就该清掉", () => {
  const notes = normalizeChangeNotes(
    { Q3: "  CC 把空状态当成缺页了  ", Q7: "误点的", Q9: "", Q99: "不存在的题" },
    ["Q3", "Q9"]
  );
  assert.deepEqual(notes, { Q3: "CC 把空状态当成缺页了" });
  assert.deepEqual(normalizeChangeNotes({}, ["Q1"]), {});
  assert.equal(normalizeChangeNotes({ Q1: "x".repeat(500) }, ["Q1"]).Q1.length, 300);
});

test("mergeHumanValues：CC 为空时人打过的每一题都算改动", () => {
  const human = Object.fromEntries(FIXED20_QUESTIONS.map((q) => [q.key, 1]));
  const merged = mergeHumanValues({}, human, FIXED20_QUESTIONS);
  assert.equal(merged.changed.length, FIXED20_QUESTIONS.length);
  assert.equal(mergeHumanValues({}, { Q1: 2 }, FIXED20_QUESTIONS).changed.length, 1);
});
