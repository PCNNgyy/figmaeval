import fs from 'node:fs';
import path from 'node:path';
import { verifySeal } from './benchmark_protocol.mjs';

export function resolveCurrentResultsDirectory(directory) {
  directory = path.resolve(directory);
  const file = path.join(directory, 'current-results-pointer.json');
  if (!fs.existsSync(file)) return directory;
  const read = name => JSON.parse(fs.readFileSync(name, 'utf8'));
  const pointer = verifySeal(read(file)), original = verifySeal(read(path.join(directory, 'plan.json')));
  const target = fs.realpathSync(pointer.directory);
  if (pointer.kind !== 'benchmark-current-results-pointer/v1' || pointer.source_plan_hash !== original.content_hash
      || target === fs.realpathSync(directory) || fs.existsSync(path.join(target, 'current-results-pointer.json'))) {
    throw new Error('Invalid or recursive current-results pointer');
  }
  const publication = verifySeal(read(path.join(target, 'publication.json')));
  const plan = verifySeal(read(path.join(target, 'plan.json')));
  if (publication.kind !== 'benchmark-complete-results/v1' || publication.content_hash !== pointer.publication_hash
      || publication.plan_hash !== original.content_hash || plan.content_hash !== original.content_hash
      || publication.records !== plan.assignments.length || publication.scored !== publication.records
      || fs.realpathSync(publication.source_directory) !== fs.realpathSync(directory)) {
    throw new Error('Current-results publication does not match the original benchmark');
  }
  return target;
}
