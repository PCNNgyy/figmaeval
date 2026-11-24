
export const FIXED20_METHOD = "fixed20";
export const FIXED20_NAME = "固定型评测";
export const FIXED20_MAX = 40;

export const GATE_QUESTION = {
  key: "G0",
  dimension: "前置门槛",
  text: "生成结果是否能够正常打开和查看，且包含足够完整的核心页面与内容？"
};

export const FIXED20_QUESTIONS = [
  { key: "Q1", dimension: "信息理解", text: "仅根据标题、内容和标签，目标用户能否理解该页面或区域是做什么的？" },
  { key: "Q2", dimension: "信息理解", text: "用户能否看出自己当前所处的页面、步骤、栏目或选中状态？" },
  { key: "Q3", dimension: "信息理解", text: "用户能否快速找到页面中的核心内容，以及当前最重要的操作或下一步？" },
  { key: "Q4", dimension: "信息理解", text: "按钮文案、字段名称和图标是否容易理解，不需要依赖猜测或外部说明？" },
  { key: "Q5", dimension: "信息组织", text: "属于同一任务、对象或类别的内容是否被组织在一起，不同信息组是否容易区分？" },
  { key: "Q6", dimension: "布局质量", text: "标题、核心信息、辅助信息和主要操作的视觉强弱，是否与其重要性一致？" },
  { key: "Q7", dimension: "布局质量", text: "同层级或重复元素是否形成稳定的边缘、基线或中心轴，不存在无意错位？" },
  { key: "Q8", dimension: "布局质量", text: "组内和组间间距是否能表达信息关系，页面是否既不过度拥挤，也没有异常留白？" },
  { key: "Q9", dimension: "布局质量", text: "页面内容重量是否分布合理，不存在无意形成的局部过重、过空或明显失衡？" },
  { key: "Q10", dimension: "布局质量", text: "是否不存在遮挡关键信息或控件的非意图重叠、裁切、溢出、出框和错层？" },
  { key: "Q11", dimension: "文本质量", text: "正文、标题和辅助文字是否容易阅读，不存在明显过小、过密、行距异常或层级混乱？" },
  { key: "Q12", dimension: "辨识风险", text: "文字、重要图标和关键控件与背景之间是否具有足够的视觉区分，不会明显看不清或被忽略？" },
  { key: "Q13", dimension: "辨识风险", text: "重要状态、类别和操作含义是否同时通过文字、图标、形状或位置表达，而不是只能依靠颜色？" },
  { key: "Q14", dimension: "控件质量", text: "按钮、输入框、开关和标签页等是否容易被识别为可操作对象，且不存在明显过小、过密或容易误触的问题？" },
  { key: "Q15", dimension: "视觉系统", text: "颜色、字体、图标、圆角、边框和阴影是否形成协调统一的视觉风格，而不是不同风格的拼接？" },
  { key: "Q16", dimension: "一致性", text: "跨页面或重复区域中，相同功能和状态是否使用一致的名称、图标、组件形态和视觉表达？" },
  { key: "Q17", dimension: "可编辑性", layer_only: true, text: "关键文本、图形、控件和容器是否保留为可以独立选择和编辑的图层，而不是整页图片或大面积扁平化？" },
  { key: "Q18", dimension: "结构清晰度", layer_only: true, text: "页面、Frame、组件和关键图层的父子关系及命名是否与画面中的功能区域相符，便于理解和定位？" },
  { key: "Q19", dimension: "布局结构", layer_only: true, text: "主要列表、卡片、导航、表单和内容区域的图层关系是否符合实际布局，而非由大量零散、脆弱的手工定位拼接？" },
  { key: "Q20", dimension: "复用结构", layer_only: true, text: "重复出现且功能相同的控件、卡片、导航或样式，是否采用统一组件、实例或共用样式，而不是大量断开的复制层？" }
];

export const LAYER_ONLY_KEYS = FIXED20_QUESTIONS.filter((question) => question.layer_only).map((question) => question.key);

export const FIXED20_LAYER_HINTS = [
  "- 文本数接近 0 而图片数很大 → 很可能整页被拍成了图片（Q17 该给 0）；",
  "- 图层命名全是 Rectangle / Frame / Group 这类默认名 → 命名与功能区域不符（Q18 扣分）；",
  "- 嵌套极浅而子节点极多 → 多半是把元素平铺着手工摆坐标，没有容器结构（Q19 扣分）；",
  "- 重复出现的卡片/导航却几乎没有组件实例 → 是复制层而非复用（Q20 扣分）。"
];

export const REQUIRED_FIXED20_BLANKS = ["【Query】", "【截图清单】", "【题目清单】"];
export const LAYER_BLANK = "【图层结构】";
export const CRITERIA_BLANK = "【已有检查点得分】";

const clean = (value, limit = 400) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);

const PROMPT_HEAD = [
  "你是资深产品设计评审，正在用一份**所有稿子共用的固定量表**给这份设计稿打分。",
  "量表固定不变，所以你的判断必须可复现：换一个评审、换一天来看，同样的稿子应该得同样的分。",
  "",
  "==========================",
  "一、先看图，再打分",
  "==========================",
  "下面给了这次生成结果的截图清单，每一项都带绝对路径。",
  "你必须用 Read 工具按清单顺序逐张打开，全部看完之后才开始打分。",
  "- 一次 Read 一张，不要跳过，不要只看第一张就推断其余；",
  "- 读完全部截图之前，不准输出任何分数；",
  "- 某张图打不开，就在 G0 里说明，并在受影响的题目证据里注明「第 N 屏无法读取」。",
  "",
  "==========================",
  "二、G0 是前置门槛，不计分",
  "==========================",
  `G0：${GATE_QUESTION.text}`,
  "判「不通过」的情形：稿子根本打不开、几乎全是空白、只有零星色块、",
  "或任务明确要求的核心页面大面积缺失（不是少一两个次要页面，而是主流程都看不到）。",
  "**G0 不通过时总分直接计 0**，后面 20 题再高也没有意义——所以只在确实塌掉时才判不通过，",
  "「有瑕疵」「不好看」「少一个次要页面」都不是 G0 不通过的理由，那些该在 Q1~Q20 里扣分。",
  "",
  "==========================",
  "三、Q1~Q20 三档打分",
  "==========================",
  "每题只能给 0、1、2 三个整数之一：",
  "  2 = 完全成立。目标用户不会在这一项上遇到困难，挑不出实质问题。",
  "  1 = 基本成立，但有确实存在、说得出位置的瑕疵；不影响用，但一眼看得出没打磨。",
  "  0 = 明显不成立。这一项上有硬伤，正式产品不可能这样交付，或用户会被直接误导、卡住。",
  "",
  "打分纪律（不遵守的评估等于没评）：",
  "- **全给 1 是最常见的失效**。凡是挑不出具体位置的瑕疵，就该给 2；凡是有硬伤，就该给 0。",
  "- 每题证据必须写清**第几屏 + 哪个区域 + 什么现象**，30-120 字。",
  "  出现「较好」「合理」「清晰」这类换任何稿子都成立的空泛词，等于没写。",
  "- 只评你真看到的东西，不要根据 Query 推断「应该有」。"
];

const PROMPT_LAYER = [
  "",
  "==========================",
  "四、Q17~Q20 要看图层结构，不是看截图",
  "==========================",
  "这四题问的是 Figma 文件本身的工程质量——图层是否可独立编辑、命名与结构是否合理、",
  "布局是靠容器还是靠手工堆坐标、重复元素是否用了组件实例。**这些在截图上完全看不出来**，",
  "必须依据下面给出的图层结构摘要来判断。",
  "如果摘要缺失或信息不足，就把这四题标成无法判定（score 给 1 并在证据里写明「缺少图层信息」），",
  "不要凭截图猜。",
  "",
  LAYER_BLANK
];

const PROMPT_TAIL = [
  "",
  "==========================",
  "五、输出格式",
  "==========================",
  "只输出 JSON，不要 Markdown，不要解释。所有字符串里**不要使用英文双引号**",
  "（需要引用界面上的文案时用中文引号「」），也不要写出任何文件路径或文件名，一律用「第 N 屏」。",
  "",
  "{",
  '  "g0": { "pass": true, "reason": "一句话说明为什么通过或不通过，40 字以内" },',
  '  "scores": [',
  '    { "key": "Q1", "score": 2, "evidence": "第 2 屏顶部…（30-120 字，指到屏与位置）" }',
  "  ]",
  "}",
  "",
  "约束：",
  "- scores 必须恰好覆盖 Q1 到 Q20 全部 20 题，key 一字不差，顺序与题目清单一致，不多不少。",
  "- score 只能是 0、1、2 三个整数之一。",
  "- 不要输出总分，总分由系统按规则计算。",
  "",
  "==========================",
  "六、上下文材料",
  "==========================",
  "【设计任务 Query】",
  "【Query】",
  "",
  "【本次生成的截图】",
  "【截图清单】",
  "",
  "【题目清单】",
  CRITERIA_BLANK
];

export const DEFAULT_FIXED20_PROMPT = [
  ...PROMPT_HEAD,
  ...PROMPT_LAYER,
  ...PROMPT_TAIL
].join("\n");

export function questionMax(question) {
  const value = Number(question?.max);
  return Number.isInteger(value) && value > 0 ? value : 2;
}

export function renderQuestionBlock(questions = FIXED20_QUESTIONS) {
  return questions
    .map((question) => {
      const tail = question.layer_only ? "（依据图层结构判断，不要只看截图）" : "";
      const scope = question.scope ? `［重点看：${question.scope}］` : "";
      const range = questionMax(question) !== 2 ? `（0-${questionMax(question)} 分）` : "";
      const lines = [`${question.key} ｜ ${question.dimension}：${question.text}${range}${scope}${tail}`];
      const standards = question.standards || null;
      if (standards) {
        [3, 2, 1, 0].forEach((level) => {
          if (standards[level]) lines.push(`    ${level} = ${standards[level]}`);
        });
      }
      if (question.example) lines.push(`    反例：${question.example}`);
      return lines.join("\n");
    })
    .join("\n");
}

export function normalizeFixed20Config(input = {}, method = null) {
  const template = String(input.prompt_template || "").trim()
    || String(method?.prompt_template || "").trim()
    || DEFAULT_FIXED20_PROMPT;
  const missing = REQUIRED_FIXED20_BLANKS.filter((blank) => !template.includes(blank));
  if (missing.length) {
    throw new Error(`提示词模板缺少占位符 ${missing.join("、")}`);
  }
  return {
    method: method?.key || FIXED20_METHOD,
    prompt_template: template,
    max_images: Math.min(24, Math.max(1, Math.round(Number(input.max_images) || 24)))
  };
}

export function summarizeLayerTree(xml, { maxFrames = 24, nameSamples = 6 } = {}) {
  const source = String(xml || "");
  if (!source.includes("<")) return null;
  const boards = [];
  let current = null;
  let depth = 0;
  let inCanvas = false;
  const tag = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
  let match;
  while ((match = tag.exec(source))) {
    const [, closing, name, attributes, selfClosing] = match;
    if (closing) {
      if (name === "canvas") { inCanvas = false; continue; }
      if (!inCanvas) continue;
      depth -= 1;
      if (current && depth <= current.baseDepth) current = null;
      continue;
    }
    if (name === "canvas") { inCanvas = true; depth = 0; continue; }
    if (!inCanvas) continue;

    if (name === "frame" && depth === 0 && boards.length < maxFrames) {
      current = {
        name: (attributes.match(/\bname="([^"]*)"/) || [])[1] || "未命名",
        width: Number((attributes.match(/\bwidth="([^"]*)"/) || [])[1]) || 0,
        height: Number((attributes.match(/\bheight="([^"]*)"/) || [])[1]) || 0,
        baseDepth: 0,
        nodes: 0,
        maxDepth: 0,
        types: new Map(),
        names: [],
        instances: 0,
        texts: 0,
        images: 0
      };
      boards.push(current);
    } else if (current) {
      current.nodes += 1;
      current.maxDepth = Math.max(current.maxDepth, depth);
      current.types.set(name, (current.types.get(name) || 0) + 1);
      if (name === "instance" || name === "component") current.instances += 1;
      if (name === "text") current.texts += 1;
      if (name === "image" || name === "rectangle-image") current.images += 1;
      const label = (attributes.match(/\bname="([^"]*)"/) || [])[1] || "";
      if (label && current.names.length < nameSamples && !current.names.includes(label)) {
        current.names.push(label.slice(0, 24));
      }
    }
    if (!selfClosing) depth += 1;
  }
  if (!boards.length) return null;
  return {
    board_count: boards.length,
    boards: boards.map((board) => ({
      name: board.name,
      size: board.width && board.height ? `${board.width}×${board.height}` : "",
      nodes: board.nodes,
      max_depth: board.maxDepth,
      instances: board.instances,
      texts: board.texts,
      images: board.images,
      types: [...board.types.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 6)
        .map(([type, count]) => `${type}×${count}`),
      names: board.names
    }))
  };
}

export function renderLayerBlock(summary, { label = "Q17~Q20", hints = FIXED20_LAYER_HINTS } = {}) {
  if (!summary || !summary.board_count) {
    return `（没有拿到这份稿子的图层结构，${label} 请标为无法判定）`;
  }
  const lines = [`共 ${summary.board_count} 个顶层画板，逐个列出结构概况：`];
  summary.boards.forEach((board, index) => {
    lines.push(
      `${index + 1}. ${board.name}${board.size ? `（${board.size}）` : ""}：`
      + `子节点 ${board.nodes} 个，最大嵌套 ${board.max_depth} 层，`
      + `文本 ${board.texts} 个，图片 ${board.images} 个，组件实例 ${board.instances} 个`
    );
    if (board.types.length) lines.push(`   节点类型：${board.types.join("、")}`);
    if (board.names.length) lines.push(`   图层命名样例：${board.names.join(" / ")}`);
  });
  if (hints && hints.length) {
    lines.push("");
    lines.push("怎么用这份摘要：");
    hints.forEach((hint) => lines.push(hint));
  }
  return lines.join("\n");
}

export function buildFixed20Prompt(template, {
  query, imageBlock, layerSummary, criteriaSummary, questions = FIXED20_QUESTIONS,
  layerLabel, layerHints
} = {}) {
  const layerOptions = {};
  if (layerLabel) layerOptions.label = layerLabel;
  if (layerHints) layerOptions.hints = layerHints;
  const criteriaBlock = criteriaSummary && criteriaSummary.score_100 != null
    ? [
      "",
      "【已有检查点得分（仅供背景参考，不要照抄它的口径，更不要用它替代你自己的观察）】",
      `这份稿子在另一套功能性检查点下得了 ${criteriaSummary.score_100} 分。`
    ].join("\n")
    : "";
  return String(template || "")
    .replaceAll("【题目清单】", renderQuestionBlock(questions))
    .replaceAll(LAYER_BLANK, renderLayerBlock(layerSummary, layerOptions))
    .replaceAll("【截图清单】", String(imageBlock || ""))
    .replaceAll(CRITERIA_BLANK, criteriaBlock)
    .replaceAll("【Query】", String(query || "").trim());
}

export function buildDefaultScalePrompt({
  name = "固定量表", gate = GATE_QUESTION, questions = [], layerLabel = "", intro = [], scaleNote = null
} = {}) {
  const count = questions.length;
  const first = questions[0]?.key || "Q1";
  const last = questions[count - 1]?.key || first;
  const layerKeys = questions.filter((question) => question.layer_only).map((question) => question.key);
  const layerText = layerLabel || (layerKeys.length ? layerKeys.join("、") : "");
  const mixed = questions.some((question) => questionMax(question) !== 2);
  const note = scaleNote || [
    "  2 = 完全成立。目标用户不会在这一项上遇到困难，挑不出实质问题。",
    "  1 = 基本成立，但有确实存在、说得出位置的瑕疵；不影响用，但一眼看得出没打磨。",
    "  0 = 明显不成立。这一项上有硬伤，正式产品不可能这样交付，或用户会被直接误导、卡住。"
  ];
  const head = [
    `你是资深产品设计评审，正在用一份**所有稿子共用的固定量表**（${name}，共 ${count} 题）给这份设计稿打分。`,
    "量表固定不变，所以你的判断必须可复现：换一个评审、换一天来看，同样的稿子应该得同样的分。",
    "",
    "==========================",
    "一、先看图，再打分",
    "==========================",
    "下面给了这次生成结果的截图清单，每一项都带绝对路径。",
    "你必须用 Read 工具按清单顺序逐张打开，全部看完之后才开始打分。",
    "- 一次 Read 一张，不要跳过，不要只看第一张就推断其余；",
    "- 读完全部截图之前，不准输出任何分数；",
    "- 某张图打不开，就在 G0 里说明，并在受影响的题目证据里注明「第 N 屏无法读取」。",
    "",
    "==========================",
    "二、G0 是前置门槛，不计分",
    "==========================",
    `G0：${gate.text}`,
    "判「不通过」的情形：稿子根本打不开、几乎全是空白、只有零星色块、整页或大面积功能区被拍成图片，",
    "或任务明确要求的核心页面大面积缺失（不是少一两个次要页面，而是主流程都看不到）。",
    `**G0 不通过时总分直接计 0**，后面 ${count} 题再高也没有意义——所以只在确实塌掉时才判不通过，`,
    `「有瑕疵」「不好看」「少一个次要页面」都不是 G0 不通过的理由，那些该在 ${first}~${last} 里扣分。`,
    "",
    "==========================",
    `三、${first}~${last} ${mixed ? "分档" : "三档"}打分`,
    "==========================",
    mixed
      ? "每题只能给该题分值范围内的整数：题目清单里标了「（0-3 分）」的题可给 0、1、2、3，没标的题只能给 0、1、2。每题下面印了各档判定标准，以题下标准为准；通用口径是："
      : "每题只能给 0、1、2 三个整数之一。题目清单里每题都印了自己的 2/1/0 判定标准，以题下标准为准；通用口径是：",
    ...note,
    "",
    "打分纪律（不遵守的评估等于没评）：",
    mixed
      ? "- **全给中间档是最常见的失效**。凡是挑不出具体位置的问题，就该给该题最高档；凡是有硬伤，就该给 0。"
      : "- **全给 1 是最常见的失效**。凡是挑不出具体位置的瑕疵，就该给 2；凡是有硬伤，就该给 0。",
    "- 每题证据必须写清**第几屏 + 哪个区域 + 什么现象**，30-120 字。",
    "  出现「较好」「合理」「清晰」这类换任何稿子都成立的空泛词，等于没写。",
    "- 只评你真看到的东西，不要根据 Query 推断「应该有」。",
    ...(intro.length ? ["", ...intro] : [])
  ];
  const layer = layerKeys.length ? [
    "",
    "==========================",
    `四、${layerText} 要看图层结构，不是看截图`,
    "==========================",
    "这几题问的是 Figma 文件本身的工程质量——图层是否可独立编辑、命名与结构是否合理、",
    "重复元素是否用了组件实例。**这些在截图上完全看不出来**，必须依据下面给出的图层结构摘要来判断。",
    "如果摘要缺失或信息不足，就把这几题标成无法判定（score 给 1 并在证据里写明「缺少图层信息」），",
    "不要凭截图猜。",
    "",
    LAYER_BLANK
  ] : [];
  const tail = [
    "",
    "==========================",
    `${layerKeys.length ? "五" : "四"}、输出格式`,
    "==========================",
    "只输出 JSON，不要 Markdown，不要解释。所有字符串里**不要使用英文双引号**",
    "（需要引用界面上的文案时用中文引号「」），也不要写出任何文件路径或文件名，一律用「第 N 屏」。",
    "",
    "{",
    '  "g0": { "pass": true, "reason": "一句话说明为什么通过或不通过，40 字以内" },',
    '  "scores": [',
    `    { "key": "${first}", "score": 2, "evidence": "第 2 屏顶部…（30-120 字，指到屏与位置）" }`,
    "  ]",
    "}",
    "",
    "约束：",
    `- scores 必须恰好覆盖 ${first} 到 ${last} 全部 ${count} 题，key 一字不差，顺序与题目清单一致，不多不少。`,
    mixed
      ? "- score 只能是该题分值范围内的整数（标「0-3 分」的题 0-3，其余 0-2）。"
      : "- score 只能是 0、1、2 三个整数之一。",
    "- 不要输出总分，总分由系统按规则计算。",
    "",
    "==========================",
    `${layerKeys.length ? "六" : "五"}、上下文材料`,
    "==========================",
    "【设计任务 Query】",
    "【Query】",
    "",
    "【本次生成的截图】",
    "【截图清单】",
    "",
    "【题目清单】",
    CRITERIA_BLANK
  ];
  return [...head, ...layer, ...tail].join("\n");
}

const clampValue = (value, hi = 2) => {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return null;
  return Math.min(hi, Math.max(0, number));
};

export function parseFixed20Result(parsed, questions = FIXED20_QUESTIONS) {
  if (!parsed || typeof parsed !== "object") {
    return {
      g0_pass: false,
      g0_reason: "",
      values: Object.fromEntries(questions.map((question) => [question.key, 0])),
      evidence: {},
      missing: questions.map((question) => question.key),
      parse_error: "模型没有返回可解析的 JSON"
    };
  }
  const source = new Map(
    (Array.isArray(parsed.scores) ? parsed.scores : [])
      .filter((entry) => entry && entry.key)
      .map((entry) => [String(entry.key).trim().toUpperCase(), entry])
  );
  const values = {};
  const evidence = {};
  const missing = [];
  questions.forEach((question) => {
    const raw = source.get(question.key);
    const score = raw ? clampValue(raw.score, questionMax(question)) : null;
    if (score === null) missing.push(question.key);
    values[question.key] = score ?? 0;
    evidence[question.key] = clean(raw?.evidence, 400);
  });
  const gate = parsed.g0 && typeof parsed.g0 === "object" ? parsed.g0 : {};
  const g0Pass = gate.pass === false ? false : true;
  return {
    g0_pass: g0Pass,
    g0_reason: clean(gate.reason, 120),
    values,
    evidence,
    missing,
    parse_error: missing.length ? `模型漏了 ${missing.length} 题，已按 0 分计` : ""
  };
}

export function fixed20Total(values, g0Pass, questions = FIXED20_QUESTIONS) {
  if (!g0Pass) return 0;
  return questions.reduce((sum, question) => {
    const value = clampValue(values?.[question.key], questionMax(question));
    return sum + (value ?? 0);
  }, 0);
}

export function normalizeChangeNotes(notes = {}, changedKeys = []) {
  const allowed = new Set(changedKeys);
  const result = {};
  Object.entries(notes || {}).forEach(([key, value]) => {
    const text = clean(value, 300);
    if (allowed.has(key) && text) result[key] = text;
  });
  return result;
}

export function mergeHumanValues(ccValues = {}, humanValues = {}, questions = FIXED20_QUESTIONS) {
  const values = {};
  const changed = [];
  questions.forEach((question) => {
    const cc = clampValue(ccValues?.[question.key], questionMax(question));
    const human = clampValue(humanValues?.[question.key], questionMax(question));
    if (human !== null && human !== cc) changed.push(question.key);
    values[question.key] = human ?? cc ?? 0;
  });
  return { values, changed };
}
