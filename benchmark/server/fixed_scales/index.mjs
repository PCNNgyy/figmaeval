import { REQUIRED_FIXED20_BLANKS, questionMax } from "../fixed20_scale.mjs";
import fixed20 from "./fixed20.mjs";
import fixedV3Pool from "./fixed_v3pool.mjs";
import fixedV2 from "./fixed_v2.mjs";
import fixedV30908 from "./fixed_v3_0908.mjs";
import fixedV4 from "./fixed_v4.mjs";

export const DEFAULT_SCALE_METHOD = fixedV4.key;

function validate(def) {
  if (!def.key || !/^[a-z0-9_]+$/.test(def.key)) throw new Error(`量表 key 非法：${def.key}`);
  const keys = new Set();
  for (const question of def.questions) {
    if (!question.key || keys.has(question.key)) throw new Error(`量表 ${def.key} 题号重复或为空：${question.key}`);
    if (question.key === def.gate?.key) throw new Error(`量表 ${def.key} 的 ${question.key} 与门槛题重名`);
    keys.add(question.key);
  }
  for (const question of def.questions) {
    if (question.max !== undefined && !(Number.isInteger(question.max) && question.max >= 1 && question.max <= 5)) {
      throw new Error(`量表 ${def.key} 的 ${question.key} 满分 ${question.max} 非法（应为 1~5 的整数）`);
    }
  }
  const expectedMax = def.questions.reduce((sum, question) => sum + questionMax(question), 0);
  if (def.max !== expectedMax) {
    throw new Error(`量表 ${def.key} 满分 ${def.max} ≠ 各题满分之和 ${expectedMax}`);
  }
  const missing = REQUIRED_FIXED20_BLANKS.filter((blank) => !String(def.prompt_template || "").includes(blank));
  if (missing.length) throw new Error(`量表 ${def.key} 默认提示词缺少占位符 ${missing.join("、")}`);
  return Object.freeze(def);
}

const METHODS = [fixed20, fixedV4, fixedV3Pool, fixedV2, fixedV30908]
  .filter((def) => def.enabled)
  .map(validate);

{
  const seen = new Set();
  for (const def of METHODS) {
    if (seen.has(def.key)) throw new Error(`量表 key 重复：${def.key}`);
    seen.add(def.key);
  }
}

export function getScaleMethod(key) {
  return METHODS.find((def) => def.key === key) || null;
}

export function listScaleMethods({ all = false } = {}) {
  return all ? METHODS : METHODS.filter((def) => def.status === "stable");
}

export function publicScaleMethod(def) {
  return {
    key: def.key,
    name: def.name,
    short: def.short || def.key,
    status: def.status,
    description: def.description || "",
    max: def.max,
    question_count: def.questions.length,
    has_layer: def.questions.some((question) => question.layer)
  };
}
