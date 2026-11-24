# FigmaEval

[Project page](https://pcnngyy.github.io/figmaeval/) · [Benchmark code and setup](benchmark/) · [Paper PDF](https://pcnngyy.github.io/figmaeval/paper/figmaeval.pdf)

Benchmark implementation and interactive project page for **FigmaEval: A Benchmark for Evaluating AI Agents in Professional UI Design**.

The [benchmark](benchmark/README.md) includes native Figma inference, three-judge rubric scoring, and the blinded human Arena framework. To run it, start in the `benchmark/` directory and follow its setup instructions. The Arena ships with synthetic examples. Live rounds, ballots, and reviewer data are private runtime inputs.

## Project website

The homepage opens with a gallery of full-resolution Figma frames for five tasks and four Foodgo starter pages, with pause, task navigation, and click-to-enlarge controls and links to the benchmark, examples, process, evaluation, results, and resources. Readers can view examples side by side or drag a divider across the two model outputs. The site includes five task comparisons from the paper, a recorded Foodgo screenshot sequence, an eleven-model results table with search and sorting, a six-dimension comparison chart, the paper PDF, and a copyable citation. The site builds to static files for GitHub Pages.

## Website development

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

Edit `src/data/paper.ts` for project links, author names, model results, task examples, and replay steps. Set `project.arxiv` to the official arXiv abstract URL when available; the paper buttons otherwise open `public/paper/figmaeval.pdf`.

Model scores reproduce the eleven-model main results table in the supplied paper. Overall rubric percentages use the 53-point total; six dimension percentages use their respective maximum scores. The gallery uses standalone PNG exports of the frames featured in the paper. Each preview preserves the entire frame and links to the original image. The process viewer shows five selected observations from a recorded Foodgo run, with playback controls for browsing the sequence.

The site contains selected presentation images and paper-level aggregate results. It has no Arena service, database, ballots, reviewer records, run logs, credentials, private Figma links, or runtime snapshots.

## GitHub Pages

The Pages workflow builds the website at the repository root and deploys its static output. Enable **Settings → Pages → Source → GitHub Actions** in the destination repository. Configure `SITE_URL` and `BASE_PATH` for manual builds:

```sh
SITE_URL=https://pcnngyy.github.io BASE_PATH=/figmaeval/ npm run build
```

The project page is published at `https://pcnngyy.github.io/figmaeval/`. The generated `dist/` directory can also be served by any static host. Local development uses `http://localhost:4321/figmaeval/`. This repository contains no Sites hosting identity or account configuration.
