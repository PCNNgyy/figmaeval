import { repairJsonQuotes } from "./cc_evaluation.mjs";
const parseJson = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };

export function extractClaudeResult(output) {
  const envelope = parseJson(String(output || "").trim(), null);
  if (typeof envelope === "string") return envelope;
  if (typeof envelope?.result === "string") return envelope.result;
  if (typeof envelope?.content === "string") return envelope.content;
  if (Array.isArray(envelope?.content)) {
    return envelope.content
      .map((entry) => typeof entry === "string" ? entry : entry?.text || "")
      .join("\n");
  }
  return String(output || "");
}

export function parseClaudeJson(output) {
  const text = extractClaudeResult(output)
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  let parsed = parseJson(text, null);
  if (!parsed) {
    const objectStart = text.indexOf("{");
    const objectEnd = text.lastIndexOf("}");
    if (objectStart >= 0 && objectEnd > objectStart) {
      parsed = parseJson(text.slice(objectStart, objectEnd + 1), null);
    }
  }
  if (!parsed) {
    const arrayStart = text.indexOf("[");
    const arrayEnd = text.lastIndexOf("]");
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      parsed = parseJson(text.slice(arrayStart, arrayEnd + 1), null);
    }
  }
  if (!parsed) {
    const repaired = repairJsonQuotes(text);
    parsed = parseJson(repaired, null);
    if (!parsed) {
      const start = repaired.indexOf("{");
      const end = repaired.lastIndexOf("}");
      if (start >= 0 && end > start) parsed = parseJson(repaired.slice(start, end + 1), null);
    }
  }
  return parsed;
}
