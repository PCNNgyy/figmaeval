export const BENCHMARK_WORKSPACE = "03 · Workspace";
export const BENCHMARK_TOOLS = ["whoami", "get_metadata", "use_figma", "get_screenshot"];

function parseTarget(value) {
  const url = new URL(value);
  const match = url.pathname.match(/^\/(?:design|file)\/([A-Za-z0-9]+)(?:\/|$)/);
  if (url.protocol !== "https:" || !["figma.com", "www.figma.com"].includes(url.hostname)
      || url.username || url.password || url.port || !match) throw new Error("Expected a Figma design/file URL");
  return { url: url.href, fileKey: match[1] };
}

export function benchmarkDesignTarget(query, baseFigmaUrl = "") {
  const urls = String(query || "").match(/https:\/\/(?:www\.)?figma\.com\/(?:design|file)\/[^\s<>"，。；）)]+/g) || [];
  const targets = urls.map(parseTarget);
  if (baseFigmaUrl) targets.push(parseTarget(baseFigmaUrl));
  if (!targets.length) throw new Error("benchmark-design requires the assigned Figma file URL");
  if (new Set(targets.map((target) => target.fileKey)).size !== 1) {
    throw new Error("The query and target must identify exactly one Figma file");
  }
  return targets[0];
}

export function benchmarkDesignSystemPrompt(binding, target, { visibleSummary = false, mediaOptional = false, paperProtocol = false } = {}) {
  const checked = parseTarget(target?.url);
  if (checked.fileKey !== target.fileKey) throw new Error("Figma URL and fileKey disagree");
  return [
    "You are completing an initial Figma product design benchmark.",
    `Assigned file: ${checked.url} (fileKey ${checked.fileKey}).`,
    "Use only this assigned file for the task. The user has provided a dedicated writable benchmark copy.",
    `Call whoami before writing${binding?.identity ? ` and confirm the assigned account is ${binding.identity}` : ""}. Use the configured account and follow the live tool schemas; pass only arguments those schemas accept.`,
    "Read 00 · Start Here for the product, exact screens, states, data, copy and prototype requirements. If an app name in the external query disagrees with this brief, use the product specified in 00 · Start Here.",
    paperProtocol
      ? "Read 01 · Foundations for primary colors and typography, 02 · Components for basic interface elements, and 03 · Media for images, logos, illustrations and icons. Preserve all four starter reference pages and their existing nodes. The separate 03 · Workspace page is the delivery location, never the 03 · Media page. Reference layouts are withheld: independently choose layout, hierarchy, composition and visual presentation; do not reconstruct a reference interface."
      : mediaOptional
      ? "Read 01 · Foundations for the design rules, including the required fonts and colors. Reuse the components in 02 · Components. If 04 · Media is present, read and reuse its assets too. Preserve all reference pages and their existing nodes."
      : "Read 01 · Foundations for the design rules, including the required fonts and colors. Reuse the components in 02 · Components and the assets in 04 · Media. Preserve these reference pages and their existing nodes.",
    `Create the complete design inside ${BENCHMARK_WORKSPACE} in the assigned file. If this page is missing, create it. New frames, reusable components and prototype connections are allowed in this workspace, including when it starts empty.`,
    "For this benchmark, starter instructions about keeping the source read-only or delivering in another new file apply to preserving the reference pages, not to the workspace. The user's delivery location is the workspace in this assigned copy.",
    "Keep existing unrelated content intact. Do not replace the reference pages, create a different Figma file or switch accounts or teams to complete the task.",
    "Use whoami -> get_metadata and read-only use_figma to inspect the reference pages -> use_figma to build the workspace -> get_screenshot to verify the designs. Use the supplied Figma tools directly, without delegating the design to other agents.",
    "Follow the visual requirements in the file. Fonts, gradients, shadows and blurs are allowed when supported by the Figma API and appropriate to those requirements; do not substitute an unrelated universal font or style restriction.",
    "Use valid Figma Plugin API calls and load the required fonts before editing text. Build in manageable sections and check tool results before continuing. Add the prototype interactions required by the brief after the relevant screens exist.",
    "Inspect screenshots of all required screens. You may take multiple screenshots, fix visible problems and check again. A successful screenshot alone is not task completion: finish the required screens, states and prototype flows before the final answer.",
    "This is an unattended session. Resolve routine implementation choices using the brief and continue without waiting for a human answer. If permissions or quota prevent progress, report the actual limitation and the unfinished work.",
    `Finish with the assigned file URL, the ${BENCHMARK_WORKSPACE} page ID, the screen IDs, the prototype work completed and any remaining limitations. Do not claim completion for work you did not finish.`,
    ...(visibleSummary ? [
      "Before every tool call include a concise visible decision summary in the same assistant message, prefixed exactly 'Reasoning summary:'. After each tool result, do the same before the next tool call. For the final response, write 'Reasoning summary: ...' on the first line, then 'Final answer:' and the answer. Never issue a tool call or final answer without the required summary.",
    ] : []),
  ].join("\n") + "\n";
}
