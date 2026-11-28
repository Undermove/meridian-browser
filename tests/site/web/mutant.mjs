// MUTANT='{"file":"docs/index.html","from":"a < b","to":"a <= b"}' runs every browser test against
// a copy of that page with the change: fixtures.mjs serves it in place of the file. Mutation sweeps
// use it to check that a test fails when the code changes, without writing to site/ or docs/.
import fs from 'node:fs';
import path from 'node:path';

export function mutantFrom(env) {
  if (!env.MUTANT) return null;
  const { file, from, to } = JSON.parse(env.MUTANT);
  if (!file || !from || typeof to !== 'string') throw new Error('MUTANT needs file, from and to');
  return { file, from, to };
}

// `from` must occur once: a second copy would make the mutant ambiguous.
export function mutantBody({ file, from, to }, root) {
  const body = fs.readFileSync(path.resolve(root, file), 'utf8');
  const n = body.split(from).length - 1;
  if (n !== 1) throw new Error(`MUTANT: ${JSON.stringify(from)} occurs ${n} times in ${file}`);
  const at = body.indexOf(from);
  return body.slice(0, at) + to + body.slice(at + from.length);
}
