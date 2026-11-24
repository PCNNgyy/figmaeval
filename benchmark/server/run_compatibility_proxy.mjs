import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import process from "node:process";
import path from "node:path";
import { createHash } from "node:crypto";
import { normalizeLocalAnthropicBody, normalizeTextOnlyAnthropicBody, liftToolResultImages, stripThinkingBlocks, synthesizeAnthropicSse } from "./anthropic_compat.mjs";
import { fingerprint } from "./benchmark_protocol.mjs";
import { prepareRunInferenceProfile, annotateRunInferenceProfile, applyRunInferenceProfile } from "./benchmark_inference_profile.mjs";
import { captureWireRequest } from "./benchmark_wire_capture.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

const configPath = argument("--config");
const statePath = argument("--state");
if (!configPath || !statePath) {
  throw new Error("缺少 --config 或 --state");
}

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
if (config.request_seed !== undefined && (!Number.isInteger(config.request_seed) || config.request_seed < 0)) {
  throw new Error("request_seed must be a nonnegative integer");
}
const runDir = path.dirname(path.resolve(configPath));
const inferenceProfile = prepareRunInferenceProfile(runDir);
const liveThinkingPath = new URL("live-thinking.txt", `file://${configPath.replace(/[^/]*$/, "")}`).pathname;
let liveCarry = "";
let liveSize = 0;
function tapThinking(chunk) {
  try {
    const text = liveCarry + chunk.toString("utf8");
    const lines = text.split("\n");
    liveCarry = lines.pop() || "";
    if (liveCarry.length > 65536) liveCarry = "";
    let out = "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      let event;
      try { event = JSON.parse(line.slice(5)); } catch { continue; }
      if (event.type === "message_start") {
        fs.writeFileSync(liveThinkingPath, "");
        liveSize = 0;
      } else if (event.type === "content_block_delta" && event.delta?.type === "thinking_delta") {
        out += event.delta.thinking || "";
      }
    }
    if (out) {
      if (liveSize > 524288) { fs.writeFileSync(liveThinkingPath, ""); liveSize = 0; }
      fs.appendFileSync(liveThinkingPath, out);
      liveSize += out.length;
    }
  } catch {   }
}
const upstream = new URL(config.upstream_base_url);
const transport = upstream.protocol === "https:" ? https : http;

function writeState(value) {
  const temporary = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, statePath);
}

const server = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    let body = Buffer.concat(chunks);
    let bufferStream = false;
    let imageTransport = null;
    let systemTransport = null;
    let seedTransport = null;
    if (body.length && String(request.headers["content-type"] || "").includes("application/json")) {
      try {
        const parsed = JSON.parse(body.toString("utf8"));
        if (config.request_seed !== undefined && new URL(request.url, "http://localhost").pathname.endsWith("/v1/messages")) {
          if (parsed.seed !== undefined && parsed.seed !== config.request_seed) throw new Error("Conflicting judge request seed");
          parsed.seed = config.request_seed;
          seedTransport = { seed_requested: config.request_seed, provider_enforcement: "unverified" };
        }
        const sourceBody = inferenceProfile ? structuredClone(parsed) : null;
        const sourceHash = config.lift_tool_result_images || inferenceProfile ? fingerprint(parsed) : null;
        const imageMoves = [];
        delete parsed.context_management;
        if (config.normalize_system_messages) normalizeLocalAnthropicBody(parsed);
        if (config.normalize_text_blocks) normalizeTextOnlyAnthropicBody(parsed);
        if (config.strip_thinking) stripThinkingBlocks(parsed);
        if (config.lift_tool_result_images) liftToolResultImages(parsed, (move) => imageMoves.push(move));
        if (config.model_override && typeof parsed === "object" && parsed) {
          parsed.model = config.model_override;
        }
        if (config.buffered_stream && parsed && parsed.stream === true) {
          parsed.stream = false;
          bufferStream = true;
        }
        if (inferenceProfile && Array.isArray(parsed.messages) && new URL(request.url, "http://localhost").pathname.endsWith("/v1/messages")) {
          applyRunInferenceProfile(parsed, runDir, inferenceProfile);
          annotateRunInferenceProfile(runDir, inferenceProfile);
          systemTransport = { kind: inferenceProfile.profile, profile_hash: inferenceProfile.content_hash,
            at: new Date().toISOString(), path: request.url, source_json_sha256: sourceHash, forwarded_json_sha256: fingerprint(parsed) };
          systemTransport.wire_request = captureWireRequest(runDir, sourceBody, parsed, request.url, inferenceProfile.content_hash);
        }
        body = Buffer.from(JSON.stringify(parsed));
        if (seedTransport) seedTransport.forwarded_body_sha256 = createHash("sha256").update(body).digest("hex");
        if (imageMoves.length) imageTransport = { kind: "tool-images-to-user/v1", at: new Date().toISOString(),
          path: request.url, model: parsed.model, source_json_sha256: sourceHash,
          forwarded_json_sha256: fingerprint(parsed), moves: imageMoves };
      } catch (error) {
        if (inferenceProfile || config.request_seed !== undefined) {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { type: "inference_profile_error", message: error.message } }));
          return;
        }
      }
    }
    if (systemTransport) {
      try { fs.appendFileSync(path.join(runDir, "system-profile-transport.jsonl"), JSON.stringify(systemTransport) + "\n", { mode: 0o600 }); }
      catch {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { type: "transport_audit_error", message: "Cannot persist inference profile receipt; request was not forwarded" } }));
        return;
      }
    }
    if (imageTransport) {
      try { fs.appendFileSync(new URL("tool-image-transport.jsonl", `file://${configPath.replace(/[^/]*$/, "")}`),
        JSON.stringify(imageTransport) + "\n", { mode: 0o600 }); }
      catch {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { type: "transport_audit_error", message: "Cannot persist the image transport receipt; request was not forwarded" } }));
        return;
      }
    }
    const headers = { ...request.headers, host: upstream.host, "content-length": body.length };
    delete headers["anthropic-beta"];
    const upstreamRequest = transport.request({
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || undefined,
      method: request.method,
      path: `${upstream.pathname.replace(/\/$/, "")}${request.url}`,
      headers,
    }, (upstreamResponse) => {
      if (seedTransport) {
        try {
          fs.appendFileSync(path.join(runDir, "seed-transport.jsonl"), JSON.stringify({ ...seedTransport,
            response_status: upstreamResponse.statusCode, at: new Date().toISOString() }) + "\n", { mode: 0o600 });
        } catch {
          upstreamResponse.resume();
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "Cannot persist judge seed receipt" } }));
          return;
        }
      }
      if (!bufferStream) {
        response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
        if (String(upstreamResponse.headers["content-type"] || "").includes("event-stream")) {
          upstreamResponse.on("data", tapThinking);
        }
        upstreamResponse.pipe(response);
        return;
      }
      const parts = [];
      upstreamResponse.on("data", (chunk) => parts.push(chunk));
      upstreamResponse.on("end", () => {
        const raw = Buffer.concat(parts);
        let message = null;
        if ((upstreamResponse.statusCode || 0) === 200) {
          try { message = JSON.parse(raw.toString("utf8")); } catch { message = null; }
        }
        if (!message || message.type !== "message") {
          const headers = { ...upstreamResponse.headers, "content-length": raw.length };
          delete headers["transfer-encoding"];
          response.writeHead(upstreamResponse.statusCode || 502, headers);
          response.end(raw);
          return;
        }
        const sse = synthesizeAnthropicSse(message);
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          "x-compat-proxy": "buffered-stream",
        });
        response.end(sse);
      });
    });
    upstreamRequest.on("error", (error) => {
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: `上游连接失败：${error.message}` } }));
    });
    if (body.length) upstreamRequest.write(body);
    upstreamRequest.end();
  });
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  writeState({ pid: process.pid, status: "stopping", signal, stopped_at: new Date().toISOString() });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
server.once("error", (error) => {
  writeState({ pid: process.pid, status: "failed", error: error.message, failed_at: new Date().toISOString() });
  process.exit(1);
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  writeState({
    pid: process.pid,
    status: "ready",
    url: `http://127.0.0.1:${address.port}`,
    started_at: new Date().toISOString(),
    tool_image_transport: config.lift_tool_result_images ? "tool-images-to-user/v1" : "native",
  });
});
