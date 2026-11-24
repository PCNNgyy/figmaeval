import {
  DEFAULT_FIXED20_PROMPT, FIXED20_LAYER_HINTS, FIXED20_MAX, FIXED20_METHOD, FIXED20_NAME,
  FIXED20_QUESTIONS, GATE_QUESTION
} from "../fixed20_scale.mjs";

export default {
  key: FIXED20_METHOD,
  name: FIXED20_NAME,
  short: "v1",
  status: "stable",
  enabled: true,
  description: "20 题 × 0/1/2 = 40 分，G0 前置门槛；2026-08-24 起的模型选型主指标",
  gate: GATE_QUESTION,
  questions: FIXED20_QUESTIONS,
  max: FIXED20_MAX,
  values: [0, 1, 2],
  prompt_template: DEFAULT_FIXED20_PROMPT,
  layer_label: "Q17~Q20",
  layer_hints: FIXED20_LAYER_HINTS
};
