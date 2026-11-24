import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeTextOnlyAnthropicBody,
  normalizeLocalAnthropicBody,
  liftToolResultImages,
  needsToolImageNormalization,
} from "../server/anthropic_compat.mjs";

test("tool images remain intact and ordered while tool pairing, prompt, and model parameters are preserved", () => {
  const a = { type: "image", source: { type: "base64", media_type: "image/png", data: "unchanged-A" } };
  const b = { type: "image", source: { type: "url", url: "https://example.com/unchanged-B.png" } };
  const body = { model: "kimi-k3/tencent/sfb", system: "original SP", max_tokens: 512, messages: [
    { role: "user", content: "original workbook query" },
    { role: "assistant", content: [{ type: "tool_use", id: "a", name: "read", input: {} }, { type: "tool_use", id: "b", name: "read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: [{ type: "text", text: "metadata" }, a] },
      { type: "tool_result", tool_use_id: "b", is_error: false, content: [b] }] },
  ] };
  const original = structuredClone(body), moves = [];
  assert.equal(liftToolResultImages(body, (move) => moves.push(move)), body);
  assert.equal(body.model, original.model); assert.equal(body.system, original.system); assert.equal(body.max_tokens, original.max_tokens);
  assert.deepEqual(body.messages.slice(0, 2), original.messages.slice(0, 2));
  const result = body.messages[2].content;
  assert.deepEqual(result.slice(0, 2).map((r) => r.tool_use_id), ["a", "b"]);
  assert.deepEqual(result[0].content, [{ type: "text", text: "metadata" }]);
  assert.equal(result[1].is_error, false);
  assert.deepEqual(result.filter((r) => r.type === "image"), [a, b]);
  assert.deepEqual(moves.map((r) => [r.tool_use_id, r.image_count]), [["a", 1], ["b", 1]]);
  const normalized = structuredClone(body); liftToolResultImages(body);
  assert.deepEqual(body, normalized);
});

test("the image workaround is scoped to local SGLang and the verified gateway Kimi and Gemini routes", () => {
  assert.equal(needsToolImageNormalization({ connection_mode: "local-sglang" }), true);
  assert.equal(needsToolImageNormalization({ base_url: "https://gateway.example.invalid", model_id: "kimi-k3/tencent/sfb" }), true);
  assert.equal(needsToolImageNormalization({ base_url: "https://gateway.example.invalid", model_id: "gemini-3.5-flash" }), true);
  for (const model of [{ base_url: "https://api.anthropic.com", model_id: "kimi-k3" },
    { base_url: "https://gateway.example.invalid", model_id: "claude-opus-5-5" },
    { base_url: "https://gateway.example.invalid", model_id: "glm-5.3-flash/tencent/sfb" }, { base_url: "invalid", model_id: "kimi-k3" }]) {
    assert.equal(needsToolImageNormalization(model), false);
  }
});

test("把 messages 中的 system 提升到 Anthropic 顶层 system", () => {
  const payload = normalizeLocalAnthropicBody({
    system: [{ type: "text", text: "base" }],
    messages: [
      { role: "user", content: "hello" },
      { role: "system", content: [{ type: "text", text: "MCP note" }] },
      { role: "assistant", content: "hi" },
    ],
  });
  assert.deepEqual(payload.messages.map((entry) => entry.role), ["user", "assistant"]);
  assert.deepEqual(payload.system.map((entry) => entry.text), ["base", "MCP note"]);
});

test("没有非法 system 消息时保持原结构", () => {
  const payload = { messages: [{ role: "user", content: "hello" }] };
  assert.equal(normalizeLocalAnthropicBody(payload), payload);
  assert.equal(payload.system, undefined);
});

test("第三方 Anthropic 兼容端点只压平纯文本块，工具调用与工具结果保持原样", () => {
  const toolUse = { type: "tool_use", id: "tool-1", name: "read", input: {} };
  const toolResult = { type: "tool_result", tool_use_id: "tool-1", content: "ok" };
  const payload = normalizeTextOnlyAnthropicBody({
    system: [{ type: "text", text: "system A" }, { type: "text", text: "system B" }],
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }, { text: "reminder" }] },
      { role: "assistant", content: [{ type: "text", text: "calling" }, toolUse] },
      { role: "user", content: [toolResult] },
    ],
  });
  assert.equal(payload.system, "system A\nsystem B");
  assert.equal(payload.messages[0].content, "hello\nreminder");
  assert.deepEqual(payload.messages[1].content, [{ type: "text", text: "calling" }, toolUse]);
  assert.deepEqual(payload.messages[2].content, [toolResult]);
});

test("stripThinkingBlocks 剥思考块并兜底空 content", async () => {
  const { stripThinkingBlocks } = await import("../server/anthropic_compat.mjs");
  const body = { messages: [
    { role: "user", content: "hi" },
    { role: "assistant", content: [
      { type: "thinking", thinking: "想", signature: "s" },
      { type: "text", text: "答" },
      { type: "tool_use", id: "t1", name: "f", input: {} },
    ] },
    { role: "assistant", content: [{ type: "thinking", thinking: "只想不说" }] },
  ] };
  stripThinkingBlocks(body);
  assert.deepEqual(body.messages[1].content.map((b) => b.type), ["text", "tool_use"]);
  assert.deepEqual(body.messages[2].content, [{ type: "text", text: "…" }]);
  assert.equal(body.messages[0].content, "hi");
});
