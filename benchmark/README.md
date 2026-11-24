# FigmaEval: Native Figma Design Benchmark

Code for **FigmaEval: A Benchmark for Evaluating AI Agents in Professional UI Design**. The release implements the paper's core native Figma inference and rubric-judging workflow under `figmaeval-cvpr2027/v1`, and provides a configurable Arena framework for blinded human comparisons.

**This benchmark directory is framework-only. No benchmark task files, design outputs, screenshots, trajectories, reviewer identities, ballots, scores, credentials, production account settings or internal server paths are distributed.** Examples and tests use placeholders or synthetic fixtures. Demo PNGs are generated locally when requested; no generated demo assets are committed.

## Alignment with the paper

| Paper requirement | Implementation and use |
|---|---|
| Constrained specifications, open design solutions | Read the brief, branding, components and media; independently design native editable Figma screens. Original reference layouts are withheld. |
| 84 tasks, 783 required screens, eleven generation models | `scope: full` validates the complete 924-artifact matrix; `scope: subset` is explicitly partial. Actual task resources are separate private inputs. |
| One Claude Code agent harness | `scripts/claude_code_harness.py` runs every generation model through the same CLI/tool loop; no direct SGLang loop is used by this entry point. |
| Four Figma MCP tools | Only `whoami`, `get_metadata`, `get_screenshot` and `use_figma`; iterative screenshots and repairs remain enabled. |
| 22 criteria, six dimensions, 53 points | Frozen `fixed_v4` definitions; the judge sees every product screen and its matching Figma layer summary. |
| Three judges and three seeded passes | Claude Opus 5.5, GPT-6.1 Sol and DeepSeek V4.1 Flash; independent contexts request seeds 42, 102 and 423. |
| Table 2 score aggregation | Average three passes per judge, then the three judges, normalize by 53, and average tasks equally. Missing blocks remain missing. |
| Blinded human comparisons and Bradley–Terry ranking | Use the Arena **version 3 tournament** with incremental ranking disabled, private admin access and curated anonymous editable-file access. The demo and alternative ranking modes are not the paper's BT path. |

The Table 1 score allocation is:

| Dimension | Criteria | Maximum |
|---|---|---:|
| User Experience | A1–A4 | 8 |
| Information Organization | B1–B5 | 15 |
| Layout Quality | D1–D4 | 12 |
| Consistency | E1–E2 | 4 |
| Visual Presentation | F1–F5 | 10 |
| Deliverable Quality | G1–G2 | 4 |
| Total | 22 | 53 |

B1–B5 and D1–D4 each use 0–3; the remaining thirteen criteria use 0–2. Overall quality is normalized from the summed item scores, **not an equal-weight average of the six dimension percentages**. The eleven generation identities are Claude Sonnet 5.5, Claude Opus 5.5, DeepSeek V4 Flash, GPT-6.1 Sol, GPT-6 Astra, Qwen 3.8 Max, Fable 5.1, GLM-5.3 Flash, SenseNova 6.8 Flash, Gemini 3.5 Flash and Kimi K3.

## Setup

Run the commands below from the `benchmark/` directory of the cloned repository.

Requires Linux, Python 3.11+, Node.js 22.16+, and a Claude Code CLI supporting `--bare`, `--restricted`, `--strict-mcp-config`, `--permission-mode dontAsk`, and streaming JSON output. Every invocation records the actual CLI version.

```bash
npm ci
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
npm install -g @anthropic-ai/claude-code
npm test
npm run test:python
npm run release:check
```

No license is granted by this release; licensing is pending. External dependencies retain their respective licenses. The CLI, Figma MCP, model access, accounts and OAuth credentials are external prerequisites.

## Inference

Copy `examples/inference.example.json` and its query file into `private/`. All example gateways, accounts and Figma file links are placeholders. Put actual credentials only in environment variables and private OAuth files.

```bash
python scripts/claude_code_harness.py inference \
  --config examples/inference.example.json --output outputs/check --validate-only
python scripts/claude_code_harness.py inference \
  --config private/inference.json --output outputs/inference
```

`npm run paper:inference -- ...` is an equivalent entry point using Python 3 on PATH. `--validate-only` checks configuration structure and protocol constraints; it does not check files, credentials, writable seats, quotas or service availability.

Each task/model gets a distinct writable native copy of its read-only source Starter File. The original query contains the source URL once; only that URL is replaced for execution. The four reference pages are `00 · Start Here`, `01 · Foundations`, `02 · Components` and `03 · Media`. A separate, initially empty `03 · Workspace` receives the design. The agent can inspect, create, take screenshots and refine through exactly four Figma MCP tools: `whoami`, `get_metadata`, `get_screenshot` and `use_figma`.

Claude Code owns every model/tool loop. The harness schedules isolated CLI processes, takes account/file locks, records telemetry, and runs deterministic screen-count and blank-screen checks. It does not launch an alternative direct model loop. A failed generation remains failed even if the file happens to contain enough frames.

Configure `paper_model`, `cli_model`, the Anthropic-compatible `base_url`, `api_key_env`, and `returned_model_prefixes` per route. Optional `route_model` starts a loopback routing proxy; it does not translate OpenAI Responses into Anthropic messages. Configured and returned model labels are recorded for each invocation.

`scope: subset` is for local smoke tests or explicitly scoped comparisons. `scope: full` requires 84 tasks, 783 required screens and all eleven generation models, yielding 924 task/model jobs. The dataset itself is not included.

## Three-judge scoring

Copy `examples/judges.example.json` to a private directory and configure three independent routes: Claude Opus 5.5, GPT-6.1 Sol and DeepSeek V4.1 Flash. The generating DeepSeek model is V4 Flash; it is a separate identity from the V4.1 Flash judge.

```bash
python scripts/claude_code_harness.py judge \
  --config examples/judges.example.json --output outputs/check --validate-only
python scripts/claude_code_harness.py judge \
  --config private/judges.json \
  --from-inference outputs/inference/BATCH_DIRECTORY \
  --output outputs/judges
```

`npm run paper:judge -- ...` is equivalent. `--from-inference` imports every artifact from a complete, accepted new-protocol batch and rejects missing/failed jobs. Alternatively, configure explicit artifacts with the original query, final inventory, matching layer summary, expected screen count, and every product-frame PNG with its node ID. All repetitions use frozen copies of the same evidence.

The protocol requires three independent CLI contexts per judge, with seeds **42, 102 and 423**, and explicit `gate_policy: required`. Each context has only `Read` and no MCP server; every PNG must produce a successful image tool result. The 22 scored criteria sum to 53; G0 is a separate viability gate. Missing images, malformed/missing items, invalid evidence, timeouts and API failures remain missing, not zero scores. A valid G0 failure can produce a genuine zero.

The loopback proxy forwards the configured seed in upstream message requests and records the request hash and HTTP response status. Configure a gateway that accepts the message format and seed parameter.

Results include per-judge three-pass means and sample standard deviations, artifact means and dimension percentages in `scores.json`, and equal-task-weight model summaries in `model-scores.json`. A missing repetition prevents that judge's mean; an incomplete judge block prevents the artifact mean. Missing tasks also prevent the configured model aggregate. Full judging needs 8,316 independent invocations.

## Human Arena framework

**Select the ranking mode explicitly.** `npm run demo` generates a synthetic version 1 round using the legacy TrueSkill path; it tests the UI and is not the paper's Bradley–Terry evaluation. Version 2 uses balanced-pairwise win rates. Version 3 without incremental ranking uses Bradley–Terry. The optional incremental mode reports within-task orders and does not compute a global BT rating.

For paper-style human evaluation, prepare a private **version 3** snapshot using `tournamentProtocol()` from `server/arena_tournament.mjs`, recruit professional designers, and freeze the candidate cohort before collecting votes. Supply the standardized brief, aligned screenshots and anonymous editable Figma files; validate the private anonymous-link mapping with `server/arena_figma_links.mjs` and inspect file titles/content for identifying information. Then start:

```bash
npm run arena -- --directory private/paper-arena --host 127.0.0.1 --port 18186 \
  --incremental-ranking false --public-admin false --show-figma-links true
```

The explicit flags override any saved service settings. Inspect the admin dashboard's `ranking.method`: the paper-compatible BT path reports `design-arena-bradley-terry-mm/v3`. Reviewer payloads conceal model identities and automated scores; left/right assignment is randomized deterministically per pair. The anonymous-link mapping and all editable files remain private runtime inputs, not repository contents.

The BT implementation counts observed decisive ballots and excludes `unable`. Disconnected or separated comparison graphs are reported without finite global rankings. The displayed rating is `400 × log10(strength)` with geometric-mean strength one.

For a UI-only local smoke test:

```bash
npm run demo
cat outputs/arena-demo/access.json
```

Use a fresh directory on a later start: `npm run demo -- outputs/demo-2`. To run your own private round:

```bash
npm run arena -- --directory private/arena-round --host 127.0.0.1 --port 18186
```

The framework includes blinded pairwise comparison, per-screen review, progress persistence, annotations, incremental ranking, score display and administration. Offline candidate revision/model expansion helpers preserve unaffected votes and progress on private database clones. Cohort task counts and model identities are supplied by the local manifest, not embedded production data.

A real round needs a private frozen snapshot and its local media. These runtime inputs and the generated SQLite/access files are excluded from Git. No live round, production task list, candidate images or actual ballots are bundled. Admin endpoints require access by default; live Figma links remain off for blinded review. For remote deployment, configure HTTPS and `--secure-cookies true` explicitly.

Bind a new judge batch to your own frozen Arena revision:

```bash
node scripts/export-harness-arena-scores.mjs \
  --arena private/arena-round --batch outputs/judges/BATCH_DIRECTORY \
  --output private/arena-scores
npm run arena -- --directory private/arena-round \
  --judge-scores-directory private/arena-scores
```

The bridge verifies the batch's frozen configuration, rubric, seeded repetitions, successful image reads and exact screenshot hashes. Incomplete judge blocks remain absent. It writes only to the specified local private directory and does not publish data.

## Framework-only publication

```bash
npm run release:check:working
npm run release:check
python scripts/check-release.py --tree HEAD --history
```

The release check allows framework text, documented placeholder examples and the rubric; it rejects runtime manifests, binary media, datasets, archives, credentials and detected private identifiers. The active GitHub Actions workflow runs this check plus offline Node/Python tests. It does not upload runtime artifacts.
