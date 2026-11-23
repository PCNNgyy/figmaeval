# FigmaEval

[Project page](https://pcnngyy.github.io/figmaeval/) · [Benchmark code](https://github.com/PCNNgyy/figma-design-benchmark)

Interactive project page for **FigmaEval: A Benchmark for Evaluating AI Agents in Professional UI Design**.

Includes five task comparisons from the paper, a recorded Foodgo screenshot sequence, an eleven-model results table with search and sorting, a six-dimension comparison chart, the paper PDF, and a copyable citation. The site builds to static files for GitHub Pages.

## Local development

Requires Node.js 22.23.4 or later.

```sh
npm ci
npm run dev
```

```sh
npm run build
npm run preview
```

## Content

Edit `src/data/paper.ts` for project links, author names, model results, task examples, and replay steps. Set `project.arxiv` to the official arXiv abstract URL when available; the paper buttons otherwise open `public/paper/figmaeval.pdf`. Add the official author list to `project.authors` and update the citation in `src/pages/index.astro` when publication metadata is available.

Model scores reproduce the eleven-model main results table in the supplied paper. Overall rubric percentages use the 53-point total; six dimension percentages use their respective maximum scores. Showcase screens are viewport excerpts of the original paper figure. The process viewer shows five selected observations from a recorded Foodgo run, with playback controls for browsing the sequence.

The site contains selected presentation images and paper-level aggregate results. It has no Arena service, database, ballots, reviewer records, run logs, credentials, private Figma links, or runtime snapshots.

## GitHub Pages

The included workflow builds and deploys this directory as a standalone repository. Enable **Settings → Pages → Source → GitHub Actions** in the destination repository. Configure `SITE_URL` and `BASE_PATH` for manual builds:

```sh
SITE_URL=https://pcnngyy.github.io BASE_PATH=/figmaeval/ npm run build
```

The standalone website repository is `PCNNgyy/figmaeval`, with the Pages URL `https://pcnngyy.github.io/figmaeval/`. The generated `dist/` directory can also be served by any static host. Local development uses `http://localhost:4321/figmaeval/`. This repository contains no Sites hosting identity or account configuration.

## Credits

Adapted from [Roman Hauksson's Academic Project Astro Template](https://github.com/RomanHauksson/academic-project-astro-template), derived from the Eliahu Horwitz academic project page and Nerfies. Template-derived material is provided under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), with attribution retained in the page footer. This does not grant a blanket license to the paper, benchmark, or showcased design assets.

DM Sans and Manrope are self-hosted. Their SIL Open Font License notices are included in `public/fonts/`.
