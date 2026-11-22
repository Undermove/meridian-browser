// Pictures for docs/changelog.html, from a test profile (no one's data): the update sheet with a
// release's notes. The Mission Control and Context Insights pictures come from their tests:
//   MERIDIAN_SHOTS=<folder> node --test tests/mission_spaces.test.mjs tests/context_insights.test.mjs
// Usage: node tools/changelog_shots.mjs <folder> <version> <current> <notes.md>
import fs from 'node:fs';
import path from 'node:path';
import { launch, SB } from '../tests/harness.mjs';

const [dir, version, current, notesFile] = process.argv.slice(2);
const notes = fs.readFileSync(notesFile, 'utf8');
const b = await launch(['about:blank']);
try {
  await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`, 15000);
  await b.eval(`app.$.updateSheet.show(${JSON.stringify({ version, current, notes, status: 5, progress: 1, error: '', pageUrl: '' })})`);
  await b.waitFor('app.$.updateSheet.open');
  await new Promise((r) => setTimeout(r, 500));
  await b.screenshot(path.join(dir, 'update-sheet.png'));
} finally {
  await b.close();
}
