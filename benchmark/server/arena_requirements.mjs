import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifySeal } from './benchmark_protocol.mjs';

export const requirementsHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const requirementLiterals = text => [...new Set(text.match(/\b\d{2}_[A-Za-z0-9_]+\b|#[A-Fa-f0-9]{6}\b|[A-Za-z0-9.+_-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\b[A-Za-z]+_[A-Za-z0-9_]+\b|(?<!\d)\d{1,3}(?:,\d{3})+(?:\.\d+)?(?!\d)|\d+(?:[.:]\d+)*/g) || [])];
export function requirementTexts(value) {
  if (Array.isArray(value)) return value.flatMap(requirementTexts);
  if (!value || typeof value !== 'object') return [];
  if (value.kind === 'text') return [value];
  return Object.values(value).flatMap(requirementTexts);
}
export function chineseRequirementIds(pages) {
  return new Set(pages.flatMap(page => page.sections.filter(section => /^01/.test(page.name)
    || /ASSIGNMENT|CHECKLIST|STRUCTURE|HANDOFF/.test(section.name || '')).flatMap(requirementTexts))
    .filter(t => t.text.length > 60 && /[A-Za-z]/.test(t.text)).map(t => t.id));
}

export function readArenaRequirements(directory, snapshot, snapshotHash) {
  const file = path.join(directory, 'requirements-zh.json');
  if (!fs.existsSync(file)) return null;
  const bundle = verifySeal(JSON.parse(fs.readFileSync(file, 'utf8')));
  const cases = new Map(snapshot.candidates.map(c => [c.case_id, c]));
  if (bundle.kind !== 'figma-arena-requirements/v1' || bundle.snapshot_hash !== snapshotHash
      || bundle.language !== 'zh-CN' || bundle.cases?.length !== cases.size) throw Error('Requirements do not match the frozen arena');
  const seen = new Set();
  for (const item of bundle.cases) {
    const task = cases.get(item.case_id), texts = requirementTexts(item.pages), ids = new Set(texts.map(t => t.id));
    if (!task || seen.has(item.case_id) || item.source_url !== task.source_url || item.title !== task.title
        || item.pages?.length !== 2 || !item.pages.some(p => /^00\s*[·.\-—]/.test(p.name))
        || !item.pages.some(p => /^01\s*[·.\-—]/.test(p.name))
        || item.source_sha256 !== requirementsHash(item.pages) || !texts.length || ids.size !== texts.length
        || Object.keys(item.translations || {}).length !== texts.length
        || texts.some(t => typeof t.text !== 'string' || typeof item.translations[t.id] !== 'string' || !item.translations[t.id].trim())
        || item.pages.some(p => p.coverage_complete !== true || requirementTexts(p.sections).length !== p.text_count)
        || !Array.isArray(item.required_frames) || !item.required_frames.length
        || item.required_frames.some(f => typeof f !== 'string' || !texts.some(t => t.text.includes(f)))) throw Error('Incomplete or mismatched original requirements');
    if ([...chineseRequirementIds(item.pages)].some(id => !/[\u3400-\u9fff]/.test(item.translations[id]))) throw Error('Task instructions require a Chinese translation');
    seen.add(item.case_id);
  }
  return bundle;
}

export function reviewerRequirements(bundle, caseId) {
  if (!bundle) return null;
  const item = bundle.cases.find(c => c.case_id === caseId);
  const translated = value => {
    if (Array.isArray(value)) return value.map(translated);
    if (!value || typeof value !== 'object') return value;
    if (value.kind === 'text') return { ...value, zh: item.translations[value.id] };
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, translated(child)]));
  };
  return { version: bundle.content_hash, source_url: item.source_url, required_frames: item.required_frames,
    language: bundle.language, pages: translated(item.pages) };
}
