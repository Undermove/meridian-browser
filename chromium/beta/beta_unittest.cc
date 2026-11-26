// Copyright 2026 The Meridian Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#include "chrome/browser/meridian/beta.h"

#include <map>
#include <string>

#include "base/files/file_util.h"
#include "base/files/scoped_temp_dir.h"
#include "chrome/browser/meridian/agent/agent_cli.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace meridian {
namespace {

class BetaTest : public testing::Test {
 protected:
  void SetUp() override {
    ASSERT_TRUE(temp_.CreateUniqueTempDir());
    SetBetaForTesting(true);
  }
  void TearDown() override { SetBetaForTesting(false); }

  base::ScopedTempDir temp_;
};

// A test binary is no beta (no MeridianBeta in its Info.plist).
TEST(BetaPlainTest, NotTheBetaUnlessItsInfoPlistSaysSo) {
  EXPECT_FALSE(IsBeta());
}

TEST_F(BetaTest, WritesNoAgentConfig) {
  const base::FilePath dir = temp_.GetPath().AppendASCII("opencode");
  std::string output;
  EXPECT_FALSE(AddOpenCodeServer(dir, "/Applications/Meridian Beta.app/x",
                                 &output));
  EXPECT_EQ(output, kBetaLeavesConfigs);
  EXPECT_FALSE(base::PathExists(dir));

  const base::FilePath codex = temp_.GetPath().AppendASCII("codex");
  ASSERT_TRUE(base::CreateDirectory(codex));
  const std::string toml = "model = \"o3\"\n";
  ASSERT_TRUE(base::WriteFile(codex.AppendASCII("config.toml"), toml));
  output.clear();
  EXPECT_FALSE(AddCodexServer(codex, "/x", &output));
  EXPECT_FALSE(RemoveCodexServer(codex, &output));
  std::string after;
  ASSERT_TRUE(base::ReadFileToString(codex.AppendASCII("config.toml"), &after));
  EXPECT_EQ(after, toml);
  EXPECT_FALSE(base::PathExists(codex.AppendASCII("config.toml.meridian-backup")));
}

TEST_F(BetaTest, ConnectAndDisconnectChangeNothing) {
  for (const char* id : {"claude", "claude-desktop", "codex", "opencode",
                         "cursor", "vscode", "gemini"}) {
    std::string output;
    EXPECT_FALSE(ConnectAgentCli(id, &output)) << id;
    EXPECT_EQ(output, kBetaLeavesConfigs) << id;
    output.clear();
    EXPECT_FALSE(ConnectAgentCliAs(id, {}, &output)) << id;
    EXPECT_EQ(output, kBetaLeavesConfigs) << id;
    output.clear();
    EXPECT_FALSE(DisconnectAgentCli(id, {}, &output)) << id;
    EXPECT_EQ(output, kBetaLeavesConfigs) << id;
  }
}

}  // namespace
}  // namespace meridian
