// Copyright 2026 The Meridian Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#import <Foundation/Foundation.h>

#include "base/apple/bundle_locations.h"
#include "base/apple/foundation_util.h"

namespace meridian::internal {

// The outer app's Info.plist (the helpers ask the same app).
bool BetaInBundle() {
  @autoreleasepool {
    NSBundle* outer = base::apple::OuterBundle();
    if (!outer) {
      return false;
    }
    NSNumber* value = base::apple::ObjCCast<NSNumber>(
        [outer objectForInfoDictionaryKey:@"MeridianBeta"]);
    return value && value.boolValue;
  }
}

}  // namespace meridian::internal
