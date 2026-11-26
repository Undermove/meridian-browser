# Regenerates webui_browser/meridian/remix.ts from remix/remix.js (run with python3 -I).
import json, sys
src = open(sys.argv[1], encoding='utf-8').read()
out = sys.argv[2]
head = '''// Copyright 2026 The Meridian Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// Remix (a preview, behind a flag): a site turned into a mobile-app
// prototype built from the site's own live data, shown in a phone frame.
// A Remix is a Boost with a script: it runs in the Boosts' isolated world on
// every page of the site, and Undo deletes it, so the site is back as it was.
// Its script only reads (GET); it blocks the page's own non-GET calls to the
// site where it can see them and keeps its cart in the page. Generated from
// the spike's remix.js by gen_remix_ts.py: change that, not the string here.

// localStorage: '1' on, '0' off; unset: DEFAULT_ON.
const FLAG_KEY = 'meridian.remix';
// The beta integrator flips this once the Remix test is green.
const DEFAULT_ON = false;

export function remixEnabled(): boolean {
  try {
    const value = localStorage.getItem(FLAG_KEY);
    if (value === '1' || value === '0') {
      return value === '1';
    }
  } catch {
    // No storage: the default.
  }
  return DEFAULT_ON;
}

// The Remix's boost is found by this name.
export const REMIX_NAME = 'Remix: mobile app';

interface RemixRecipe {
  // Without "www."; subdomains too.
  hosts: string[];
  js: string;
}

// dodopizza.ru's menu as an app: feed, categories, product sheet, local cart.
const DODO_JS: string = '''
tail = ''';

const RECIPES: RemixRecipe[] = [{hosts: ['dodopizza.ru'], js: DODO_JS}];

// The Remix script for a site ("" when there is none).
export function remixFor(host: string): string {
  const recipe = RECIPES.find(
      r => r.hosts.some(h => host === h || host.endsWith('.' + h)));
  return recipe ? recipe.js : '';
}
'''
open(out, 'w', encoding='utf-8').write(head + json.dumps(src, ensure_ascii=False) + tail)
