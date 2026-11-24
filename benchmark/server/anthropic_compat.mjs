export function needsToolImageNormalization(model) {
  if (model?.connection_mode === "local-sglang") return true;
  try { return new URL(model.base_url).hostname === "gateway.example.invalid" && /^(kimi-|gemini-)/i.test(model.model_id || ""); }
  catch { return false; }
}

export function liftToolResultImages(parsed, onMove = () => {}) {
  if (!Array.isArray(parsed?.messages)) return parsed;
  for (const [messageIndex, message] of parsed.messages.entries()) {
    if (message?.role !== "user" || !Array.isArray(message.content)) continue;
    const images = [];
    const content = message.content.map((block) => {
      if (block?.type !== "tool_result" || !Array.isArray(block.content)) return block;
      const attached = block.content.filter((item) => item?.type === "image");
      if (!attached.length) return block;
      const retained = block.content.filter((item) => item?.type !== "image");
      attached.forEach((image, index) => images.push(
        { type: "text", text: `[Image ${index + 1} from tool result ${block.tool_use_id}]` }, image));
      onMove({ message_index: messageIndex, tool_use_id: block.tool_use_id, image_count: attached.length });
      return { ...block, content: retained.length ? retained : [{ type: "text", text: "Image attached below." }] };
    });
    if (images.length) message.content = [...content, ...images];
  }
  return parsed;
}

export function normalizeLocalAnthropicBody(parsed) {
  if (!Array.isArray(parsed?.messages)) return parsed;
  const lifted = [];
  parsed.messages = parsed.messages.filter((message) => {
    if (message?.role !== "system") return true;
    lifted.push(message.content);
    return false;
  });
  if (!lifted.length) return parsed;
  const existing = parsed.system == null
    ? []
    : (Array.isArray(parsed.system) ? parsed.system : [parsed.system]);
  parsed.system = [...existing, ...lifted].flatMap((content) => {
    if (Array.isArray(content)) return content;
    if (typeof content === "string") return [{ type: "text", text: content }];
    return content ? [content] : [];
  });
  return parsed;
}

function textOnlyContent(content) {
  if (!Array.isArray(content) || !content.length) return null;
  const texts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") return null;
    if (block.type && block.type !== "text") return null;
    if (typeof block.text !== "string") return null;
    texts.push(block.text);
  }
  return texts.join("\n");
}

export function normalizeTextOnlyAnthropicBody(parsed) {
  if (!parsed || typeof parsed !== "object") return parsed;
  if (Array.isArray(parsed.messages)) {
    for (const message of parsed.messages) {
      const flattened = textOnlyContent(message?.content);
      if (flattened !== null) message.content = flattened;
    }
  }
  const flattenedSystem = textOnlyContent(parsed.system);
  if (flattenedSystem !== null) parsed.system = flattenedSystem;
  return parsed;
}

export function stripThinkingBlocks(parsed) {
  if (!parsed || !Array.isArray(parsed.messages)) return parsed;
  for (const message of parsed.messages) {
    if (!Array.isArray(message?.content)) continue;
    const kept = message.content.filter(
      (block) => block?.type !== "thinking" && block?.type !== "redacted_thinking"
    );
    if (kept.length !== message.content.length) {
      message.content = kept.length ? kept : [{ type: "text", text: "…" }];
    }
  }
  return parsed;
}

export function synthesizeAnthropicSse(message) {
  const events = [];
  const push = (type, payload) => events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
  const usage = message.usage || {};
  push("message_start", {
    message: {
      id: message.id || `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      model: message.model || "",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: usage.input_tokens || 0, output_tokens: 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
        cache_read_input_tokens: usage.cache_read_input_tokens || 0 },
    },
  });
  (message.content || []).forEach((block, index) => {
    if (block.type === "text") {
      push("content_block_start", { index, content_block: { type: "text", text: "" } });
      if (block.text) push("content_block_delta", { index, delta: { type: "text_delta", text: block.text } });
    } else if (block.type === "tool_use") {
      push("content_block_start", { index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      push("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) } });
    } else if (block.type === "thinking") {
      push("content_block_start", { index, content_block: { type: "thinking", thinking: "" } });
      if (block.thinking) push("content_block_delta", { index, delta: { type: "thinking_delta", thinking: block.thinking } });
      if (block.signature) push("content_block_delta", { index, delta: { type: "signature_delta", signature: block.signature } });
    } else {
      push("content_block_start", { index, content_block: block });
    }
    push("content_block_stop", { index });
  });
  push("message_delta", {
    delta: { stop_reason: message.stop_reason || "end_turn", stop_sequence: message.stop_sequence ?? null },
    usage: { output_tokens: usage.output_tokens || 0 },
  });
  push("message_stop", {});
  return events.join("");
}
