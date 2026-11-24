import fs from 'node:fs';
import path from 'node:path';
import { seal, verifySeal } from './benchmark_protocol.mjs';

export function readArenaReviewers(directory, snapshot, snapshotHash, credentials) {
  const file = path.join(directory, 'reviewers.json');
  const planned = snapshot.version === 3 ? snapshot.protocol.reviewers : 2;
  const policy = fs.existsSync(file) ? verifySeal(JSON.parse(fs.readFileSync(file, 'utf8')))
    : seal({ kind: 'figma-arena-reviewers/v1', snapshot_hash: snapshotHash,
      active_reviewers: credentials.reviewers.slice(0, planned).map(r => r.id) });
  if (policy.kind !== 'figma-arena-reviewers/v1' || policy.snapshot_hash !== snapshotHash
    || !Array.isArray(policy.active_reviewers) || !policy.active_reviewers.length
    || new Set(policy.active_reviewers).size !== policy.active_reviewers.length
    || policy.active_reviewers.some(id => !credentials.reviewers.some(r => r.id === id))) throw Error('Invalid arena reviewer policy');
  return policy;
}
