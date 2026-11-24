import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { seal, verifySeal } from "./benchmark_protocol.mjs";
import { saveJson } from "./benchmark_copies.mjs";

export const INFERENCE_PROFILE = "benchmark-phase-separated/v2";
const hash = (text) => createHash("sha256").update(text).digest("hex");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const substitutions = [
  ["Use whoami -> get_metadata and read-only use_figma to inspect the reference pages -> use_figma to build the workspace -> get_screenshot to verify the designs. Use the supplied Figma tools directly, without delegating the design to other agents.",
    "Use whoami -> get_metadata and read-only use_figma to inspect the reference pages -> use_figma to build the workspace. Use the supplied Figma tools directly, without delegating the design to other agents."],
  ["Inspect screenshots of all required screens. You may take multiple screenshots, fix visible problems and check again. A successful screenshot alone is not task completion: finish the required screens, states and prototype flows before the final answer.",
    "This is the inference phase. Finish all required screens, states and prototype flows, then report the actual delivery. Do not call get_screenshot or run per-screen screenshot verification loops during inference. After the inference batch finishes, the platform separately checks the complete Workspace inventory and captures every required screen for the judge. Do not claim that the platform checks or scoring have already passed."],
];

export function phaseSeparatedSystem(system) {
  if (!system.startsWith("You are completing an initial Figma product design benchmark.\n")) throw new Error("Not a benchmark inference system");
  for (const [original, replacement] of substitutions) {
    if (system.includes(replacement) && !system.includes(original)) continue;
    if (system.split(original).length !== 2) throw new Error("Unknown benchmark system revision; cannot silently rewrite it");
    system = system.replace(original, replacement);
  }
  return system;
}

export function writeInferenceProfile(suite) {
  const file = path.join(suite.directory, "inference-profile-policy.json");
  if (fs.existsSync(file)) {
    const existing = verifySeal(read(file));
    if (existing.plan_hash !== suite.plan.content_hash || existing.profile !== INFERENCE_PROFILE) throw new Error("Inference profile belongs to another plan");
    return existing;
  }
  const policy = seal({ kind: "benchmark-inference-profile-policy/v1", profile: INFERENCE_PROFILE,
    plan_hash: suite.plan.content_hash, preserve_reference_context: true, max_reference_chars: 260000,
    defer_visual_checks: true, applied_to: "new-run-processes-only", activated_at: new Date().toISOString() });
  saveJson(file, policy); return policy;
}

export function readRunInferenceProfile(runDir) {
  const file = path.join(runDir, "inference-profile.json");
  if (!fs.existsSync(file)) return null;
  const profile = verifySeal(read(file));
  if (profile.kind !== "benchmark-run-inference-profile/v1" || profile.profile !== INFERENCE_PROFILE) throw new Error("Unknown run inference profile");
  const policy = verifySeal(profile.policy);
  if (policy.content_hash !== profile.policy_hash || policy.plan_hash !== profile.plan_hash
    || policy.profile !== profile.profile || profile.max_reference_chars !== policy.max_reference_chars) throw new Error("Run inference profile policy changed");
  for (const [name, expected] of [["benchmark-system.original.txt", profile.original_system_sha256], ["benchmark-system.effective.txt", profile.effective_system_sha256]]) {
    if (hash(fs.readFileSync(path.join(runDir, name))) !== expected) throw new Error("Inference system bytes changed");
  }
  if (phaseSeparatedSystem(fs.readFileSync(path.join(runDir, "benchmark-system.original.txt"), "utf8")) !== fs.readFileSync(path.join(runDir, "benchmark-system.effective.txt"), "utf8")) throw new Error("Inference system transformation changed");
  return profile;
}

export function prepareRunInferenceProfile(runDir) {
  const existing = readRunInferenceProfile(runDir);
  if (existing) return existing;
  const batch = path.dirname(path.dirname(path.resolve(runDir)));
  const file = path.join(batch, "inference-profile-policy.json");
  const systemFile = path.join(runDir, "benchmark-system.txt");
  if (!fs.existsSync(file) || !fs.existsSync(systemFile)) return null;
  const policy = verifySeal(read(file)), plan = verifySeal(read(path.join(batch, "plan.json")));
  if (policy.kind !== "benchmark-inference-profile-policy/v1" || policy.profile !== INFERENCE_PROFILE
    || policy.plan_hash !== plan.content_hash || policy.defer_visual_checks !== true || policy.preserve_reference_context !== true
    || policy.max_reference_chars !== 260000) throw new Error("Invalid inference profile policy");
  const original = fs.readFileSync(systemFile, "utf8"), effective = phaseSeparatedSystem(original);
  const profile = seal({ kind: "benchmark-run-inference-profile/v1", profile: INFERENCE_PROFILE,
    plan_hash: plan.content_hash, policy_hash: policy.content_hash, policy,
    original_system_sha256: hash(original), effective_system_sha256: hash(effective),
    client_system_file: systemFile, effective_system_file: path.join(runDir, "benchmark-system.effective.txt"),
    defer_visual_checks: true, preserve_reference_context: true, max_reference_chars: policy.max_reference_chars,
    applied_at: new Date().toISOString() });
  for (const [name, text] of [["benchmark-system.original.txt", original], ["benchmark-system.effective.txt", effective]]) {
    const output = path.join(runDir, name);
    if (fs.existsSync(output) && fs.readFileSync(output, "utf8") !== text) throw new Error("Run system snapshot is immutable");
    if (!fs.existsSync(output)) fs.writeFileSync(output, text, { flag: "wx", mode: 0o600 });
  }
  saveJson(path.join(runDir, "inference-profile.json"), profile);
  return profile;
}

export function annotateRunInferenceProfile(runDir, profile) {
  if (!profile) return;
  const file = path.join(runDir, "benchmark-input.json");
  if (!fs.existsSync(file)) return;
  const input = read(file);
  if (input.inference_profile?.content_hash === profile.content_hash) return;
  input.inference_profile = { profile: profile.profile, content_hash: profile.content_hash,
    policy_hash: profile.policy_hash, original_system_sha256: profile.original_system_sha256,
    effective_system_sha256: profile.effective_system_sha256 };
  input.client_system_file = input.system_file;
  input.effective_system_file = profile.effective_system_file;
  saveJson(file, input);
}

export function inferenceVersionFields(run) {
  if (!run?.run_dir) return { inference_profile: "" };
  const file = path.join(run.run_dir, "inference-profile.json");
  if (!fs.existsSync(file)) return { inference_profile: "benchmark-initial/v1" };
  const profile = verifySeal(read(file));
  return { inference_profile: profile.profile, inference_profile_hash: profile.content_hash,
    inference_policy_hash: profile.policy_hash, effective_system_sha256: profile.effective_system_sha256 };
}

export function applyRunInferenceProfile(body, runDir, profile) {
  if (!profile) return 0;
  const original = fs.readFileSync(path.join(runDir, "benchmark-system.original.txt"), "utf8");
  const effective = fs.readFileSync(profile.effective_system_file, "utf8");
  let found = 0;
  const replace = (text) => {
    if (text.includes(original)) { found++; return text.replace(original, effective); }
    if (text.includes(effective)) found++;
    return text;
  };
  if (typeof body.system === "string") body.system = replace(body.system);
  else for (const block of Array.isArray(body.system) ? body.system : []) if (block.type === "text") block.text = replace(block.text);
  if (found !== 1) throw new Error("Benchmark inference system is missing or duplicated in the forwarded request");
  return found;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const index = process.argv.indexOf("--run-dir");
    if (index < 0 || !process.argv[index + 1]) throw new Error("Provide --run-dir");
    const runDir = process.argv[index + 1];
    const profile = prepareRunInferenceProfile(runDir);
    annotateRunInferenceProfile(runDir, profile);
    process.stdout.write(JSON.stringify(profile));
  } catch (error) { process.stderr.write(error.message); process.exitCode = 1; }
}
