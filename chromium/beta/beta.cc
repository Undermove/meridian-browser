// Copyright 2026 The Meridian Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#include "chrome/browser/meridian/beta.h"

#include <optional>

#include "build/build_config.h"

namespace meridian {

#if BUILDFLAG(IS_MAC)
namespace internal {
bool BetaInBundle();  // beta_mac.mm
}
#endif

namespace {

std::optional<bool>& Override() {
  static std::optional<bool> value;
  return value;
}

bool ReadBeta() {
#if BUILDFLAG(IS_MAC)
  return internal::BetaInBundle();
#else
  return false;
#endif
}

}  // namespace

bool IsBeta() {
  if (Override().has_value()) {
    return *Override();
  }
  static const bool beta = ReadBeta();
  return beta;
}

void SetBetaForTesting(bool beta) {
  Override() = beta;
}

}  // namespace meridian
