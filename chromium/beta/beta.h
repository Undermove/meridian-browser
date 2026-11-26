// Copyright 2026 The Meridian Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef CHROME_BROWSER_MERIDIAN_BETA_H_
#define CHROME_BROWSER_MERIDIAN_BETA_H_

#include <string>

namespace meridian {

// Meridian Beta: the owner's own build, installed next to Meridian
// ("~/Applications/Meridian Beta.app", its own bundle id and its own profile
// folder). Only the beta's Info.plist has `MeridianBeta` = true (written when
// the beta is packaged), so a normal build never takes these paths. A beta
// never updates itself, never moves itself into Applications, and never
// writes another app's settings (agent configs: Claude Code, Codex, OpenCode,
// Claude Desktop, VS Code…): those belong to the main Meridian.
bool IsBeta();

// What Connect says in the beta instead of writing an agent's config.
inline constexpr char kBetaLeavesConfigs[] =
    "в бете подключение не меняет конфиги основного Meridian";

// Tests only.
void SetBetaForTesting(bool beta);

}  // namespace meridian

#endif  // CHROME_BROWSER_MERIDIAN_BETA_H_
