import crypto from "node:crypto";
import { benchmarkDesignTarget } from "./benchmark_design.mjs";
import fixedV4 from "./fixed_scales/fixed_v4.mjs";
import { normalizeFixed20Config } from "./fixed20_scale.mjs";

export const BENCHMARK_PROTOCOL = "figma-benchmark/v1";
export const BENCHMARK_RUBRIC_ID = "fixed-v4";
export const BENCHMARK_SCALE_METHOD = fixedV4.key;
export const ACTIVE_RUN_STATUSES = ["运行中", "补图中", "已暂停", "停止中"];
const fail = (message) => { throw new Error(message); };
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export const fingerprint = (value) => crypto.createHash("sha256").update(canonical(value)).digest("hex");
export function figmaKey(url) { return benchmarkDesignTarget(String(url), String(url)).fileKey; }
export function replaceTarget(query, source, target) {
  figmaKey(source); figmaKey(target);
  if (typeof query !== "string" || query.split(source).length !== 2) fail("Query must contain the exact original URL once");
  benchmarkDesignTarget(query, source);
  const result = query.replace(source, target);
  benchmarkDesignTarget(result, target);
  return result;
}
export function seal(payload) { return { ...payload, content_hash: fingerprint(payload) }; }
export function verifySeal(value) {
  const { content_hash, ...payload } = value || {};
  if (content_hash !== fingerprint(payload)) fail("Immutable benchmark manifest checksum mismatch");
  return value;
}
export function createDataset(rows, { id, template }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(id || "")) fail("Use a stable dataset id containing letters, numbers, dot, underscore or dash");
  if (typeof template !== "string" || template.split("{{figma_url}}").length !== 2) fail("Query template requires exactly one {{figma_url}} placeholder");
  if (!rows.length) fail("Dataset is empty");
  const ids = new Set(); const keys = new Set();
  const cases = rows.map((raw, index) => {
    const row = typeof raw === "string" ? { figma_url: raw } : raw;
    const caseId = String(row.case_id || row.id || `case-${String(index + 1).padStart(3, "0")}`);
    const sourceUrl = row.source_figma_url ?? row.figma_url ?? row.url;
    if (typeof sourceUrl !== "string" || sourceUrl !== sourceUrl.trim()) fail(`Invalid original URL at ${caseId}; URLs are never silently rewritten`);
    const key = figmaKey(sourceUrl);
    const sourceQuery = row.source_query ?? row.query ?? template.replace("{{figma_url}}", sourceUrl);
    replaceTarget(sourceQuery, sourceUrl, sourceUrl);
    if (ids.has(caseId) || keys.has(key)) fail(`Duplicate case or original file: ${caseId}`);
    ids.add(caseId); keys.add(key);
    return { case_id: caseId, source_figma_url: sourceUrl, source_file_key: key, source_query: sourceQuery,
      source_query_hash: fingerprint(sourceQuery), title: String(row.title || caseId) };
  });
  return seal({ protocol: BENCHMARK_PROTOCOL, kind: "dataset", id, query_template: template,
    required_pages: ["00", "01", "02"], optional_pages: ["04"], workspace: "03 · Workspace", cases });
}
export function snapshotRubric() {
  const config = normalizeFixed20Config({}, fixedV4);
  return seal({ protocol: BENCHMARK_PROTOCOL, kind: "rubric", id: BENCHMARK_RUBRIC_ID, method: fixedV4.key,
    name: fixedV4.name, gate: fixedV4.gate, questions: fixedV4.questions, max: fixedV4.max,
    values: fixedV4.values, prompt_template: config.prompt_template, max_images: config.max_images,
    layer_hints: fixedV4.layer_hints, layer_label: fixedV4.layer_label });
}
export function assertRubric(rubric) {
  verifySeal(rubric);
  if (rubric.content_hash !== snapshotRubric().content_hash) fail("Rubric implementation changed; create an explicit new rubric version before evaluating");
}
const MODEL_FIELDS = ["id", "name", "provider", "connection_mode", "base_url", "host", "port", "model_id", "auth_mode",
  "api_key_env", "reasoning_mode", "api_format", "can_evaluate", "buffered_stream", "vision", "generation_mode"];
export function cleanModel(model) {
  if (typeof model === "string") return { id: model };
  if (!model?.id) fail("Every model needs a stable id");
  if (["api_key", "token", "access_token", "password"].some((key) => model[key])) fail("Use credential environment names or the private model key store; manifests cannot contain credentials");
  return Object.fromEntries(MODEL_FIELDS.filter((key) => model[key] !== undefined).map((key) => [key, model[key]]));
}
export function assertModelConfiguration(expected, actual) {
  for (const [key, value] of Object.entries(cleanModel(expected))) {
    if (key !== "generation_mode" && value !== actual?.[key]) fail(`Model configuration changed: ${expected.id}/${key}`);
  }
}
export function createPlan(dataset, rawModels, rubric, { id, judge, generationConcurrency = 1, judgeConcurrency = 1 }) {
  verifySeal(dataset); assertRubric(rubric);
  const models = rawModels.map(cleanModel);
  const judgeModel = cleanModel(judge);
  if (!Number.isInteger(generationConcurrency) || generationConcurrency < 1 || generationConcurrency > 14
      || !Number.isInteger(judgeConcurrency) || judgeConcurrency < 1 || judgeConcurrency > 8) fail("Invalid benchmark concurrency limits");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(id || "") || !models.length || new Set(models.map((m) => m.id)).size !== models.length) fail("Stable run id and unique models are required");
  const matchingJudge = models.find((m) => m.id === judgeModel.id);
  if (matchingJudge && canonical({ ...matchingJudge, generation_mode: null }) !== canonical({ ...judgeModel, generation_mode: null })) fail("The same model id cannot have different candidate and judge configurations");
  const assignments = models.flatMap((model) => dataset.cases.map((item) => ({
    assignment_id: `assignment_${fingerprint([id, dataset.content_hash, model.id, item.case_id]).slice(0, 20)}`,
    case_id: item.case_id, model_id: model.id,
  })));
  return seal({ protocol: BENCHMARK_PROTOCOL, kind: "plan", id, dataset_hash: dataset.content_hash,
    rubric_hash: rubric.content_hash, judge: judgeModel, models, case_count: dataset.cases.length,
    assignment_count: assignments.length, isolation: "copy-per-case-model", generation_concurrency: generationConcurrency,
    judge_concurrency: judgeConcurrency, assignments });
}
export function bindCopies(dataset, plan, bindings) {
  verifySeal(dataset); verifySeal(plan);
  if (dataset.content_hash !== plan.dataset_hash) fail("Plan does not match the immutable dataset");
  const map = new Map(bindings.map((b) => [b.assignment_id || `${b.model_id}/${b.case_id}`, b]));
  if (map.size !== bindings.length || bindings.length !== plan.assignment_count) fail("Copy mappings must cover the matrix exactly once");
  const sources = new Set(dataset.cases.map((item) => item.source_file_key));
  const targets = new Set();
  const groups = plan.models.map((model, index) => ({ task: `model-${index + 1}`, model_id: model.id,
    model_name: model.name || model.id, tests: plan.assignments.filter((a) => a.model_id === model.id).map((assignment) => {
      const item = dataset.cases.find((c) => c.case_id === assignment.case_id);
      const copy = map.get(assignment.assignment_id) || map.get(`${model.id}/${item.case_id}`);
      if (copy && ((copy.model_id && copy.model_id !== model.id) || (copy.case_id && copy.case_id !== item.case_id))) fail("Copy labels do not match their immutable assignment");
      const target = copy?.target_figma_url || copy?.figma_url;
      if (!target) fail(`Missing copy: ${model.id}/${item.case_id}`);
      const key = figmaKey(target);
      if (sources.has(key) || targets.has(key)) fail(`Every assignment requires a unique copy; original files are read-only: ${model.id}/${item.case_id}`);
      targets.add(key);
      const query = replaceTarget(item.source_query, item.source_figma_url, target);
      return { ...assignment, question: item.case_id, source_figma_url: item.source_figma_url,
        source_query: item.source_query, source_query_hash: item.source_query_hash, figma_url: target,
        query, original_query: query, query_transform: "replace-url-only" };
    }) }));
  return seal({ protocol: BENCHMARK_PROTOCOL, kind: "execution", mode: "benchmark-design", schema_version: 2,
    fresh_targets: true, query_modified: false, id: plan.id, dataset_hash: dataset.content_hash,
    plan_hash: plan.content_hash, rubric_hash: plan.rubric_hash, required_pages: dataset.required_pages,
    optional_pages: dataset.optional_pages, workspace: dataset.workspace, excluded_file_keys: [...sources], groups });
}
export function verifyExecution(manifest) {
  verifySeal(manifest);
  const sources = new Set(manifest.excluded_file_keys || []); const targets = new Set();
  if (manifest.kind !== "execution" || manifest.schema_version !== 2 || !manifest.groups?.length) fail("Invalid execution manifest");
  if (canonical(manifest.required_pages) !== canonical(["00", "01", "02"]) || manifest.workspace !== "03 · Workspace"
      || canonical(manifest.optional_pages) !== canonical(["04"])) fail("Unexpected benchmark page contract");
  const modelIds = new Set(); const assignmentIds = new Set(); let caseIds = null;
  for (const group of manifest.groups) {
    if (modelIds.has(group.model_id) || !group.tests?.length) fail("Duplicate model or empty case group");
    modelIds.add(group.model_id);
    const cases = group.tests.map((item) => item.case_id).sort();
    if (new Set(cases).size !== cases.length || (caseIds && canonical(cases) !== canonical(caseIds))) fail("All models must evaluate the same case ids once");
    caseIds = cases;
    for (const item of group.tests) {
      const key = figmaKey(item.figma_url);
      if (sources.has(key) || targets.has(key) || assignmentIds.has(item.assignment_id)) fail("Original, reused or duplicate target in execution matrix");
      if (!sources.has(figmaKey(item.source_figma_url)) || item.source_query_hash !== fingerprint(item.source_query)
          || item.query !== replaceTarget(item.source_query, item.source_figma_url, item.figma_url)) fail("Original query changed beyond replacing its URL");
      targets.add(key); assignmentIds.add(item.assignment_id);
    }
  }
  return manifest;
}
export function runAssignmentItem(item, modelId, run, retries = [], retained = []) {
  if (!run) return item;
  const target = run.base_figma_url || run.figma_url || item.figma_url;
  const query = run.query || item.query;
  if (query === item.query && figmaKey(target) === figmaKey(item.figma_url)) return item;
  const kept = retained.find((e) => e.assignment_id === item.assignment_id && e.model_id === modelId
    && e.run_id === run.id && e.query === query && e.query_hash === fingerprint(query) && e.file_key === figmaKey(target));
  if (kept) return { ...item, query, figma_url: target, source_figma_url: kept.source_url,
    retained_run_id: kept.run_id };
  const retry = retries.find((e) => e.assignment_id === item.assignment_id && e.model_id === modelId
    && e.target_figma_url && figmaKey(e.target_figma_url) === figmaKey(target) && e.query === query);
  if (!retry || query !== replaceTarget(item.source_query, item.source_figma_url, retry.target_figma_url)) {
    fail("Run query or target is outside the initial assignment and verified retry journal");
  }
  return { ...item, query, figma_url: retry.target_figma_url, retry_id: retry.retry_id };
}
export function makeResultRows(dataset, plan, execution, state, scores, rubric) {
  verifySeal(dataset); verifySeal(plan); verifyExecution(execution); assertRubric(rubric);
  if (execution.dataset_hash !== dataset.content_hash || execution.plan_hash !== plan.content_hash
      || plan.rubric_hash !== rubric.content_hash) fail("Export provenance does not match the locked dataset, plan and rubric");
  const baselines = scores.filter((s) => s.method === rubric.method && s.is_baseline !== 0);
  return execution.groups.flatMap((group) => group.tests.map((item) => {
    const title = `${plan.id}/${item.assignment_id}`;
    const test = state.tests.find((row) => row.title === title);
    if (test && (test.query !== item.query || test.base_figma_url !== item.figma_url || test.model_id !== group.model_id)) fail(`Stored query/URL/model changed for ${item.assignment_id}`);
    const attempts = state.runs.filter((row) => row.test_id === test?.id).sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
    const kept = state.benchmark_retained?.find((e) => e.assignment_id === item.assignment_id);
    const run = kept ? attempts.find((r) => r.id === kept.run_id) : attempts[0];
    if (kept && !run) fail("Retained output is missing its imported run");
    const actual = runAssignmentItem(item, group.model_id, run, state.benchmark_retries || [], state.benchmark_retained || []);
    const savedScore = baselines.find((s) => s.run_id === run?.id);
    const score = savedScore?.status === "已完成" && savedScore.total !== null && !savedScore.parse_error ? savedScore : null;
    if (score && score.prompt_template !== rubric.prompt_template) fail("Stored score used a different rubric prompt");
    if (score && score.eval_model_id !== plan.judge.id) fail("Stored score used a different judge model");
    return { run_set_id: plan.id, case_id: item.case_id, model_id: group.model_id, model_name: group.model_name,
      source_figma_url: kept?.source_url || item.source_figma_url, source_query: item.source_query,
      target_figma_url: actual.figma_url, inference_query: actual.query, assignment_id: item.assignment_id,
      retry_id: actual.retry_id || "",
      test_id: test?.id || "", run_id: run?.id || "", attempt_count: attempts.length,
      generation_status: run?.status || "尚未启动", generation_error: run?.error || "",
      score_status: savedScore?.parse_error ? "评分格式错误" : score ? "已完成" : savedScore?.status || "尚未评分",
      score_total: score?.total ?? null, score_max: rubric.max, g0_pass: score?.g0_pass ?? null,
      score_error: savedScore?.parse_error || savedScore?.error || "",
      score_cc_total: score?.cc_total ?? null,
      score_image_count: score?.image_count ?? null,
      scoring_method: rubric.method, rubric_id: rubric.id,
      rubric_hash: rubric.content_hash, dataset_hash: dataset.content_hash,
      ...Object.fromEntries(rubric.questions.map((q) => [q.key, score?.cc_values?.[q.key] ?? null])),
      evidence_json: score ? JSON.stringify(score.evidence || {}) : "", layer_source: score?.layer_source || "",
      started_at: run?.started_at || "", finished_at: run?.finished_at || "" };
  }));
}
