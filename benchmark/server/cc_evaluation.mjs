
export const MAX_EVAL_IMAGES = 24;
export const EVAL_TIMEOUT_MS = 900000;
export const VERDICT_THRESHOLDS = { good: 75, fair: 55 };
export const REQUIRED_EVAL_BLANKS = ["【Query】", "【截图清单】", "【领域清单】"];
export const CRITERIA_BLANK = "【已有检查点得分】";

export const DEFAULT_EVAL_DOMAINS = [
  { key: "intent", name: "意图匹配", parent: "可理解性", question: "是否理解用户目标和场景", weight: 0.15, max: 10 },
  { key: "task", name: "任务完整", parent: "可理解性", question: "功能和流程是否闭环", weight: 0.10, max: 10 },
  { key: "structure", name: "结构清晰", parent: "可理解性", question: "信息、导航和视觉层级是否合理", weight: 0.20, max: 10 },
  { key: "feedback", name: "反馈明确", parent: "可控性", question: "系统状态和操作结果是否可见", weight: 0.10, max: 10 },
  { key: "control", name: "控制容错", parent: "可恢复性", question: "是否支持预防、撤销和恢复", weight: 0.08, max: 10 },
  { key: "efficiency", name: "一致高效", parent: "流畅性", question: "规范是否统一，操作是否简洁", weight: 0.17, max: 10 },
  { key: "form", name: "形式体验", parent: "流畅性", question: "视觉、品牌和情感表达是否成立", weight: 0.20, max: 10 }
];

const PROMPT_BODY = [
  "你是资深产品设计评审，正在替一位「背景用户」做第一轮观感体检。",
  "背景用户 = 拿到这份设计稿的目标用户本人。他不看需求文档，不知道任务描述里写了什么，",
  "他只看屏幕，凭第一眼和几次点击的想象决定这东西「像不像个正经产品」。",
  "",
  "======================",
  "一、这次评什么，不评什么",
  "======================",
  "不评：功能点齐不齐、需求里写的模块是不是都出现了、某个字段有没有落到页面上。",
  "      这件事已经有另一套 100 条 0/1 检查点在管，你再列一遍没有任何价值。",
  "要评：把这些屏摆到目标用户面前，它作为一个「能看懂、能用下去、值得信」的界面成不成立。",
  "      一份稿子完全可能功能全齐，同时难看、难懂、廉价、像半成品——把这种情况准确地指出来，",
  "      就是你这次唯一的任务。",
  "",
  "自检：如果你写下的一条问题，换成任意一份别的设计稿也照样成立",
  "（例如「缺少空状态设计」「建议增加加载反馈」），那说明你在复述通用检查表，",
  "不是在看这份稿子。删掉重写，改成只有看了这几张图才写得出来的话。",
  "",
  "==================================",
  "二、第一步：必须先看图，不许凭 Query 猜",
  "==================================",
  "下面给了这次生成结果的截图清单，每一项都带绝对路径。",
  "你必须使用 Read 工具，按清单顺序逐张打开每一张图，全部看完之后才开始评分。",
  "",
  "- 一次 Read 一张，不要跳过，不要只读第一张就推断其余。",
  "- 每张看完，先确认这几件事：这一屏是什么、主视觉是什么、最显眼的三个元素是什么、",
  "  有没有一眼就崩的地方（元素挤在一起、留白塌陷或失衡、所有文字一个字号、",
  "  颜色脏或对比不足、控件错位或不对齐、留着占位符文案、图片区域空缺、",
  "  中英混排断行、按钮层级不分主次、同一元素在不同屏样式不一致）。",
  "- 在读完全部截图之前，不准输出任何分数。",
  "- 如果某张图无法读取，在对应领域的 issues 里注明「第 N 屏无法读取」，该屏不参与证据。"
];

const PROMPT_SCORING = [
  "",
  "==================",
  "三、逐域打分",
  "==================",
  "评分领域如下，每域 0-10 的整数：",
  "【领域清单】",
  "",
  "分数锚点（所有领域共用这把尺子；全给 7 分的评估等于没有评估）：",
  "  0-2  这一维度基本不成立。用户会当场放弃，或者被明确误导。",
  "  3-4  能看出意图，但存在多处硬伤，正式产品不可能这样交付。",
  "  5-6  刚够「能用」的底线。没有任何一处让人觉得做得好，属于随处可见的中庸稿。",
  "  7-8  明显用心，只剩少量可以指名的瑕疵。",
  "  9-10 可以直接当作同类产品里的正面参考。这一档要慎给，",
  "       必须有具体的、超出常规做法的证据支撑，说不出这种证据就不要给 9 分以上。",
  "",
  "================================",
  "四、证据要求（本次最重要的一条）",
  "================================",
  "每个领域的 evidence 必须同时写清三件事：",
  "  (1) 在第几屏；(2) 在这一屏的哪个位置或哪个区域；(3) 看到了什么具体现象。",
  "",
  "合格示例：",
  "  「第 2 屏订单列表，右侧价格列与左侧商品名基线不齐，且价格用了与正文相同的",
  "   14px 常规字重，扫视时完全找不到金额在哪。」",
  "不合格示例（一律视为无效评估）：",
  "  「整体布局较为合理」「视觉风格统一」「信息层级清晰」「用户体验良好」",
  "  —— 只有形容词、没有指向物的句子全部禁止。",
  "",
  "其他硬性要求：",
  "- 严禁在任何字段里写出文件路径、文件名或目录名，一律用「第 N 屏」指代。",
  "- 每个领域至少 1 条证据。",
  "- 扣分的领域必须写出扣分点在哪；不许只写优点然后打 5 分。",
  "- 只写你真的在图上看到的东西。看不到的不要脑补，写「这几屏里看不到 XX」是允许的，",
  "  编造一个不存在的元素不允许。"
];

const PROMPT_OUTPUT_HEAD = [
  "",
  "==============",
  "五、输出",
  "==============",
  "只输出一个 JSON 对象。不要 Markdown 代码块，不要前言后语，不要解释。",
  "格式严格如下：",
  "",
  "{"
];

const PROMPT_OUTPUT_TAIL = [
  '  "domains": [',
  "    {",
  '      "key": "原样使用领域清单里给出的 key",',
  '      "name": "领域名",',
  '      "score": 0 到 10 的整数,',
  '      "max": 10,',
  '      "evidence": "按第四节要求写的具体观察，60-200 字",',
  '      "issues": ["该域内的具体问题，每条 15-60 字，必须指到屏与位置；没有问题写空数组 []"]',
  "    }",
  "  ],",
  '  "top_fixes": [',
  '    { "severity": "高", "where": "第 N 屏 · 具体区域", "problem": "背景用户会实际遇到的现象", "suggestion": "一句话可执行的改法" }',
  "  ],",
  '  "verdict": "好",',
  '  "one_liner": "站在背景用户角度的一句话观感，40 字以内，说人话，不要出现评分术语"',
  "}",
  "",
  "约束：",
  "- domains 必须恰好覆盖领域清单里的全部领域，key 一字不差，顺序与清单一致，不多不少。",
  "- top_fixes 给 3 到 6 条，按 severity 从高到低排；severity 只能是「高」「中」「低」。",
  "- verdict 只能是「好」「一般」「差」，按你的整体判断给，不要机械换算分数。",
  "  如果「结构清晰」或「形式体验」分很低，即使其他域分高，verdict 也不应该给「好」。",
  "- 不要输出加权总分，加权由系统按权重计算。",
  "",
  "============",
  "六、上下文材料",
  "============",
  "【设计任务 Query】",
  "【Query】",
  "",
  "【本次生成的截图】",
  "【截图清单】",
  CRITERIA_BLANK
];

const PROMPT_FIRST_IMPRESSION = [
  "",
  "=========================================",
  "二点五、先说第一眼印象（读完图后、打分之前完成）",
  "=========================================",
  "在开始逐域打分之前，先只凭刚才看图的直觉回答三个问题，用最直白的话，不要用任何专业术语：",
  "  1. 如果只给你 3 秒扫一眼，这几屏给你的整体感觉是什么？（例如「很挤」「空得像没做完」",
  "     「像模板套出来的」「挺讲究」）",
  "  2. 不看 Query，你猜这是个什么产品、给谁用的？",
  "  3. 如果这是一个真实上线的 App，你会不会信任它、愿不愿意继续用？",
  "",
  "这三条答完之后不许回头修改它们来迎合后面的分数。",
  "如果后面的分数与第一印象明显冲突（比如第一印象是「很挤、像半成品」，",
  "但各域都打了 8 分），说明你在按检查表打分而不是在看图——回去重打。"
];

const FIRST_IMPRESSION_SCHEMA = [
  '  "first_impression": {',
  '    "seconds_3": "3 秒扫一眼的整体感觉，30 字以内",',
  '    "guess_product": "猜这是什么产品、给谁用，25 字以内",',
  '    "would_trust": "会 或 不会",',
  '    "why": "一句话说明理由"',
  "  },"
];

export const DEFAULT_EVAL_PROMPT = [
  ...PROMPT_BODY,
  ...PROMPT_SCORING,
  ...PROMPT_OUTPUT_HEAD,
  ...PROMPT_OUTPUT_TAIL
].join("\n");

export const ALT_EVAL_PROMPT = [
  ...PROMPT_BODY,
  ...PROMPT_FIRST_IMPRESSION,
  ...PROMPT_SCORING,
  ...PROMPT_OUTPUT_HEAD,
  ...FIRST_IMPRESSION_SCHEMA,
  ...PROMPT_OUTPUT_TAIL,
  "",
  "补充：first_impression 必须排在 domains 之前输出。"
].join("\n");

export const EVAL_PROMPT_VARIANTS = [
  { key: "v1", name: "标准版（先分析后结论）", prompt_template: DEFAULT_EVAL_PROMPT },
  { key: "v2", name: "第一印象版（先直觉后分析）", prompt_template: ALT_EVAL_PROMPT }
];

const AGREEMENT_VALUES = new Set(["同意", "部分同意", "不同意"]);
const MARK_VALUES = new Set(["准", "不准"]);
const VERDICT_VALUES = new Set(["好", "一般", "差"]);
const SEVERITY_VALUES = new Set(["高", "中", "低"]);

const clean = (value, limit = 400) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);

export function clampScore(value, max = 10) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return null;
  return Math.min(max, Math.max(0, number));
}

export function scrubPaths(text) {
  return String(text ?? "")
    .replace(/(?<![\w\u4e00-\u9fff])(?:\/[\w.@-]+){2,}\/?/g, "（已隐去路径）")
    .replace(/[0-9a-f]{16,}\.(?:png|jpe?g|pdf)/gi, "（已隐去文件名）")
    .replace(/[\w.-]+\.(?:png|jpe?g|pdf)/gi, "（已隐去文件名）");
}

export function normalizeEvalConfig(input = {}) {
  const variantKey = EVAL_PROMPT_VARIANTS.some((entry) => entry.key === input.prompt_variant)
    ? input.prompt_variant
    : "v1";
  const fallbackTemplate = EVAL_PROMPT_VARIANTS.find((entry) => entry.key === variantKey).prompt_template;
  const template = String(input.prompt_template || "").trim() || fallbackTemplate;
  const missing = REQUIRED_EVAL_BLANKS.filter((blank) => !template.includes(blank));
  if (missing.length) {
    throw new Error(`提示词模板缺少占位符 ${missing.join("、")}`);
  }

  const overrides = new Map(
    (Array.isArray(input.domains) ? input.domains : [])
      .filter((entry) => entry && entry.key)
      .map((entry) => [String(entry.key), entry])
  );
  const seen = new Set();
  const domains = DEFAULT_EVAL_DOMAINS
    .filter((domain) => {
      if (seen.has(domain.key)) return false;
      seen.add(domain.key);
      return true;
    })
    .map((domain) => {
      const override = overrides.get(domain.key) || {};
      const rawWeight = Number(override.weight);
      return {
        ...domain,
        weight: Number.isFinite(rawWeight) && rawWeight >= 0 ? rawWeight : domain.weight
      };
    });
  const total = domains.reduce((sum, domain) => sum + domain.weight, 0);
  const normalized = total > 0
    ? domains.map((domain) => ({ ...domain, weight: domain.weight / total }))
    : domains.map((domain) => ({ ...domain, weight: 1 / domains.length }));

  return {
    prompt_variant: variantKey,
    prompt_template: template,
    domains: normalized,
    max_images: Math.min(24, Math.max(1, Math.round(Number(input.max_images) || MAX_EVAL_IMAGES)))
  };
}

export function selectEvalImages(previewFiles, { limit = MAX_EVAL_IMAGES } = {}) {
  const byPath = new Map();
  (Array.isArray(previewFiles) ? previewFiles : []).forEach((file) => {
    const filePath = String(file?.path || "");
    if (!filePath) return;
    if (!byPath.has(filePath)) {
      byPath.set(filePath, { path: filePath, file_name: filePath.split("/").pop(), page_names: [] });
    }
    const name = clean(file?.page_name, 40);
    const entry = byPath.get(filePath);
    if (name && !entry.page_names.includes(name)) entry.page_names.push(name);
  });
  const all = [...byPath.values()];
  const images = all.slice(0, Math.max(1, limit)).map((entry, index) => ({ index: index + 1, ...entry }));
  return { images, total: all.length };
}

export function buildImageManifest(images) {
  return (images || []).map((image) => {
    const names = image.page_names || [];
    const label = names.length > 3
      ? `${names[0]} 等 ${names.length} 个画板`
      : (names.join(" / ") || `第 ${image.index} 屏`);
    return { index: image.index, label, file_name: image.file_name };
  });
}

export function renderImageBlock(images, total) {
  const shown = images.length;
  const head = total > shown
    ? `本次生成共 ${total} 屏，下面给你其中前 ${shown} 屏（按模型实际操作顺序）：`
    : `本次生成共 ${shown} 屏，全部给你：`;
  const lines = images.map((image) => {
    const label = image.page_names[0] || `第 ${image.index} 屏`;
    const rows = [`第 ${image.index} 屏 · ${label}`, `    绝对路径：${image.path}`];
    if (image.page_names.length > 1) {
      rows.push(`    注意：这张图是一整块画布，里面并排含 ${image.page_names.length} 个画板：`
        + `${image.page_names.join("、")}，请分别看。`);
    }
    return rows.join("\n");
  });
  return [head, ...lines].join("\n");
}

export function renderDomainBlock(domains) {
  return domains.map((domain, index) => [
    `${index + 1}. key=${domain.key} ｜ ${domain.name}（上位领域：${domain.parent} ｜ 权重 ${Math.round(domain.weight * 100)}%）`,
    `   要判断的是：${domain.question}`
  ].join("\n")).join("\n");
}

export function renderCriteriaBlock(summary) {
  if (!summary || summary.score_100 == null) return "";
  const failed = (summary.failed_by_category || [])
    .map((entry) => `${entry.category}(${entry.count})`)
    .join("、");
  return [
    "",
    "【已有检查点得分（仅供背景参考，不要照抄它的口径，更不要用它替代你自己的观察）】",
    `这份稿子在另一套 100 条功能性检查点下得了 ${summary.score_100} 分。`,
    failed ? `未通过的检查点主要集中在：${failed}。` : ""
  ].filter(Boolean).join("\n");
}

export function renderEvalPrompt(template, { query, images, imageTotal, domains, criteriaSummary } = {}) {
  return String(template || "")
    .replaceAll("【领域清单】", renderDomainBlock(domains || []))
    .replaceAll("【截图清单】", renderImageBlock(images || [], imageTotal ?? (images || []).length))
    .replaceAll(CRITERIA_BLANK, renderCriteriaBlock(criteriaSummary))
    .replaceAll("【Query】", String(query || "").trim());
}

const NOT_READ_RE = /(无法读取|未提供截图|没有截图|根据\s*Query|依据任务描述)/;

export function repairJsonQuotes(text) {
  const source = String(text ?? "");
  let out = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      out += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      out += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      if (!inString) {
        inString = true;
        out += char;
        continue;
      }
      let next = index + 1;
      while (next < source.length && /\s/.test(source[next])) next += 1;
      if (next >= source.length || [",", ":", "}", "]"].includes(source[next])) {
        inString = false;
        out += char;
      } else {
        out += '\\"';
      }
      continue;
    }
    out += char;
  }
  return out;
}

export function parseEvalResult(parsed, domains) {
  const list = domains || DEFAULT_EVAL_DOMAINS;
  if (!parsed || typeof parsed !== "object") {
    return {
      domains: list.map((domain) => ({
        key: domain.key, name: domain.name, score: 0, max: domain.max, evidence: "", issues: [], missing: true
      })),
      top_fixes: [], verdict: "", one_liner: "",
      parse_error: "模型没有返回可解析的 JSON"
    };
  }
  const source = new Map(
    (Array.isArray(parsed.domains) ? parsed.domains : [])
      .filter((entry) => entry && entry.key)
      .map((entry) => [String(entry.key), entry])
  );
  let notRead = 0;
  const result = list.map((domain) => {
    const raw = source.get(domain.key);
    const score = raw ? clampScore(raw.score, domain.max) : null;
    const evidence = scrubPaths(clean(raw?.evidence, 600));
    if (NOT_READ_RE.test(evidence)) notRead += 1;
    const rawIssues = Array.isArray(raw?.issues)
      ? raw.issues
      : (raw?.issues ? [raw.issues] : []);
    return {
      key: domain.key,
      name: domain.name,
      score: score ?? 0,
      max: domain.max,
      evidence,
      issues: rawIssues.map((issue) => scrubPaths(clean(issue, 200))).filter(Boolean),
      ...(raw && score !== null ? {} : { missing: true })
    };
  });
  const topFixes = (Array.isArray(parsed.top_fixes) ? parsed.top_fixes : [])
    .slice(0, 8)
    .map((fix) => ({
      severity: SEVERITY_VALUES.has(String(fix?.severity)) ? String(fix.severity) : "中",
      where: scrubPaths(clean(fix?.where, 80)),
      problem: scrubPaths(clean(fix?.problem, 200)),
      suggestion: scrubPaths(clean(fix?.suggestion, 200))
    }))
    .filter((fix) => fix.problem);
  const missingCount = result.filter((entry) => entry.missing).length;
  const parseError = notRead > list.length / 2
    ? "疑似未真正读图（多数领域的证据在说「无法读取」或「根据 Query」），不要把这条计入分析样本"
    : (missingCount ? `模型漏了 ${missingCount} 个领域，已按 0 分计` : "");
  return {
    domains: result,
    top_fixes: topFixes,
    verdict: VERDICT_VALUES.has(String(parsed.verdict)) ? String(parsed.verdict) : "",
    one_liner: scrubPaths(clean(parsed.one_liner, 120)),
    ...(parsed.first_impression && typeof parsed.first_impression === "object"
      ? {
        first_impression: {
          seconds_3: scrubPaths(clean(parsed.first_impression.seconds_3, 80)),
          guess_product: scrubPaths(clean(parsed.first_impression.guess_product, 60)),
          would_trust: clean(parsed.first_impression.would_trust, 10),
          why: scrubPaths(clean(parsed.first_impression.why, 160))
        }
      }
      : {}),
    parse_error: parseError
  };
}

export function plainTotal(domainScores, domains) {
  const list = domains || DEFAULT_EVAL_DOMAINS;
  const byKey = new Map((domainScores || []).map((entry) => [entry.key, entry]));
  if (!list.length) return 0;
  const total = list.reduce((sum, domain) => {
    const entry = byKey.get(domain.key);
    const score = Number(entry?.score) || 0;
    const max = Number(entry?.max) || domain.max || 10;
    return sum + (score / max) * 100;
  }, 0);
  return Math.round((total / list.length) * 10) / 10;
}

export function weightedTotal(domainScores, domains) {
  const byKey = new Map((domainScores || []).map((entry) => [entry.key, entry]));
  const total = (domains || DEFAULT_EVAL_DOMAINS).reduce((sum, domain) => {
    const entry = byKey.get(domain.key);
    const score = Number(entry?.score) || 0;
    const max = Number(entry?.max) || domain.max || 10;
    return sum + (score / max) * 100 * domain.weight;
  }, 0);
  return Math.round(total * 10) / 10;
}

export function decideVerdict(total, domainScores, domains) {
  const byKey = new Map((domainScores || []).map((entry) => [entry.key, Number(entry.score) || 0]));
  const structure = byKey.get("structure") ?? 10;
  const form = byKey.get("form") ?? 10;
  if (structure <= 3 && form <= 3) return "差";
  let verdict = total >= VERDICT_THRESHOLDS.good ? "好" : (total >= VERDICT_THRESHOLDS.fair ? "一般" : "差");
  if ((structure <= 4 || form <= 4) && verdict === "好") verdict = "一般";
  return verdict;
}

export function normalizeHumanConfirmation(input = {}, domains) {
  const list = domains || DEFAULT_EVAL_DOMAINS;
  const known = new Set(list.map((domain) => domain.key));
  const agreement = String(input.human_agreement || "").trim();
  if (agreement && !AGREEMENT_VALUES.has(agreement)) {
    throw new Error("总体认可度只能是「同意」「部分同意」「不同意」");
  }
  const marks = {};
  Object.entries(input.domain_marks || {}).forEach(([key, value]) => {
    const mark = String(value || "").trim();
    if (known.has(key) && MARK_VALUES.has(mark)) marks[key] = mark;
  });
  const notes = {};
  Object.entries(input.domain_notes || {}).forEach(([key, value]) => {
    const text = clean(value, 500);
    if (known.has(key) && text) notes[key] = text;
  });
  return {
    human_agreement: agreement,
    human_note: clean(input.human_note, 2000),
    domain_marks: marks,
    domain_notes: notes
  };
}

export function summarizeCriteriaScore(rating, criteria) {
  if (!rating || rating.score_100 == null) return null;
  const answers = rating.checklist_values || {};
  const failedByCategory = new Map();
  (criteria || [])
    .filter((entry) => entry.test_id === rating.test_id && answers[entry.id] === 0)
    .forEach((entry) => {
      const category = entry.category || (entry.kind === "template" ? "通用" : "未分类");
      failedByCategory.set(category, (failedByCategory.get(category) || 0) + 1);
    });
  return {
    score_100: rating.score_100,
    failed_by_category: [...failedByCategory.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((left, right) => right.count - left.count)
      .slice(0, 4)
  };
}

export function publicEvaluation(row, { includePrompt = false } = {}) {
  const parseJson = (value, fallback) => {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  };
  const {
    image_paths, raw_output, prompt_rendered, prompt_template, ...rest
  } = row;
  return {
    ...rest,
    rubric: parseJson(row.rubric, []),
    image_manifest: parseJson(row.image_manifest, []),
    domain_marks: parseJson(row.domain_marks, {}),
    domain_notes: parseJson(row.domain_notes, {}),
    result: parseJson(row.result_json, null),
    ...(includePrompt ? { prompt_rendered, prompt_template } : {})
  };
}
