// A fresh coverage run: raw data from earlier runs would hide lines this run misses.
import fs from 'node:fs';
import { RAW_DIR } from './coverage.mjs';

export default function setup() {
  fs.rmSync(RAW_DIR, { recursive: true, force: true });
}
