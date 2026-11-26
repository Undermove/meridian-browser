#!/usr/bin/env python3
"""Applies the Meridian Beta glue to a Chromium src tree: python3 -I apply_glue.py <src>.

Every change is behind meridian::IsBeta(), which is true only when the outer
app's Info.plist has MeridianBeta = true (set by make_beta_app.sh). Normal builds
never take these paths."""
import os
import re
import shutil
import sys

SRC = sys.argv[1]
HERE = os.path.dirname(os.path.abspath(__file__))
M = os.path.join(SRC, 'chrome/browser/meridian')


def edit(rel, fn):
    p = os.path.join(SRC, rel)
    with open(p, encoding='utf-8') as f:
        text = f.read()
    new = fn(text)
    assert new != text, f'no change in {rel}'
    with open(p, 'w', encoding='utf-8') as f:
        f.write(new)
    print('edited', rel)


def once(text, old, new):
    assert text.count(old) == 1, f'expected one {old!r}, found {text.count(old)}'
    return text.replace(old, new)


def add_include(text, header):
    line = f'#include "{header}"\n'
    if line in text:
        return text
    first = re.search(r'^#include .*\n', text, re.M)  # the file's own header
    incs = [m for m in re.finditer(r'^#include "chrome/browser/meridian/[^"]+"\n', text, re.M)
            if m.start() != first.start()]
    assert incs, 'no meridian include to anchor on'
    # keep sorted-ish: insert before the first meridian include that sorts after it
    for m in incs:
        if m.group(0) > line:
            return text[:m.start()] + line + text[m.start():]
    last = incs[-1]
    return text[:last.end()] + line + text[last.end():]


def guard_body(text, signature_start, guard):
    """Inserts `guard` right after the opening brace of the function whose
    definition starts with `signature_start` (at the start of a line)."""
    i = text.find('\n' + signature_start)
    assert i >= 0, f'no {signature_start!r}'
    assert text.find('\n' + signature_start, i + 1) < 0, f'two {signature_start!r}'
    brace = text.index(') {\n', i) + len(') {\n')
    return text[:brace] + guard + text[brace:]


for name in ('beta.h', 'beta.cc', 'beta_mac.mm', 'beta_unittest.cc'):
    shutil.copy(os.path.join(HERE, name), os.path.join(M, name))
    print('added chrome/browser/meridian/' + name)

# BUILD.gn: a "beta" source set every Meridian target gets through test_switches.
edit('chrome/browser/meridian/BUILD.gn', lambda t: once(once(t,
    '# Test switches only work for a profile in the temp folder (test_switches.h).\n',
    '# Meridian Beta (beta.h): true only in the owner\'s side-by-side beta app.\n'
    'source_set("beta") {\n'
    '  sources = [\n'
    '    "beta.cc",\n'
    '    "beta.h",\n'
    '  ]\n'
    '  if (is_mac) {\n'
    '    sources += [ "beta_mac.mm" ]\n'
    '    frameworks = [ "Foundation.framework" ]\n'
    '  }\n'
    '  public_deps = [ "//base" ]\n'
    '}\n\n'
    '# Test switches only work for a profile in the temp folder (test_switches.h).\n'),
    'source_set("test_switches") {\n  sources = [\n    "test_switches.cc",\n    "test_switches.h",\n  ]\n  public_deps = [\n    ":platform",\n',
    'source_set("test_switches") {\n  sources = [\n    "test_switches.cc",\n    "test_switches.h",\n  ]\n  public_deps = [\n    ":beta",\n    ":platform",\n'))

# Unit test into meridian_unittests.
def add_unittest(t):
    m = re.search(r'\n(\s+)"agent/agent_cli_unittest.cc",\n', t)
    assert m, 'agent_cli_unittest.cc not in BUILD.gn'
    return t[:m.end()] + f'{m.group(1)}"beta_unittest.cc",\n' + t[m.end():]
edit('chrome/browser/meridian/BUILD.gn', add_unittest)

# agent_cli.cc: no agent config written, no "mcp add/remove" run.
GUARD = '  if (BetaLeaves(output)) {\n    return false;\n  }\n'
def agent_cli(t):
    t = add_include(t, 'chrome/browser/meridian/beta.h')
    t = once(t, 'namespace meridian {\n\nnamespace {\n',
             'namespace meridian {\n\nnamespace {\n\n'
             '// Meridian Beta writes no agent\'s config: they belong to the main\n'
             '// Meridian (beta.h).\n'
             'bool BetaLeaves(std::string* output) {\n'
             '  if (!IsBeta()) {\n    return false;\n  }\n'
             '  *output = kBetaLeavesConfigs;\n  return true;\n}\n')
    for sig in ('bool RunCli(', 'bool ConnectDesktop(', 'bool WriteConfig(',
                'bool ConnectAgentCli(', 'bool ConnectAgentCliAs(',
                'bool DisconnectAgentCli(', 'bool AddCodexServer(',
                'bool RemoveCodexServer(', 'bool AddAgentServer(',
                'bool RemoveJsonEntry('):
        t = guard_body(t, sig, GUARD)
    return t
edit('chrome/browser/meridian/agent/agent_cli.cc', agent_cli)

# updater.cc: the beta never checks, downloads or swaps itself.
def updater(t):
    t = add_include(t, 'chrome/browser/meridian/beta.h')
    t = guard_body(t, 'void Updater::Start(',
                   '  // Meridian Beta never updates itself (beta.h).\n'
                   '  if (IsBeta()) {\n    started_ = true;\n    return;\n  }\n')
    t = guard_body(t, 'void Updater::CheckNow(',
                   '  if (IsBeta()) {\n'
                   '    Set(mojom::UpdateStatus::kFailed,\n'
                   '        "Meridian Beta doesn’t update itself: it is rebuilt by hand.");\n'
                   '    return;\n  }\n')
    t = guard_body(t, 'void Updater::Check(',
                   '  if (IsBeta()) {\n    return;\n  }\n')
    t = guard_body(t, 'bool Updater::Install(',
                   '  if (IsBeta()) {\n    return false;\n  }\n')
    return t
edit('chrome/browser/meridian/updater.cc', updater)

# install_from_dmg.mm: the beta never moves itself into Applications.
def dmg(t):
    t = add_include(t, 'chrome/browser/meridian/beta.h')
    return once(t, 'bool MaybeInstallFromDiskImage() {\n  @autoreleasepool {\n',
                'bool MaybeInstallFromDiskImage() {\n'
                '  // Meridian Beta lives in ~/Applications next to Meridian: never moved.\n'
                '  if (meridian::IsBeta()) {\n    return false;\n  }\n'
                '  @autoreleasepool {\n')
edit('chrome/browser/mac/install_from_dmg.mm', dmg)

# sidebar_handler_mac.mm: "open in Claude" doesn't put the entry back in the beta.
def sidebar_mac(t):
    t = add_include(t, 'chrome/browser/meridian/beta.h')
    return guard_body(t, 'void ReconnectThenOpen(',
                      '  if (IsBeta()) {\n'
                      '    OpenClaude(url, std::move(open), std::move(done));\n'
                      '    return;\n  }\n')
edit('chrome/browser/meridian/sidebar_handler_mac.mm', sidebar_mac)

# Studio (when it is in the tree): on in the beta; the page learns it is the beta.
studio = os.path.join(M, 'workbench/studio.cc')
if os.path.exists(studio):
    def st(t):
        t = add_include(t, 'chrome/browser/meridian/beta.h')
        t = guard_body(t, 'bool StudioEnabled(',
                       '  if (IsBeta()) {\n    return true;\n  }\n')
        return once(t, '    info.Set("enabled", on);\n',
                    '    info.Set("enabled", on);\n    if (IsBeta()) {\n      info.Set("beta", true);\n    }\n')
    edit('chrome/browser/meridian/workbench/studio.cc', st)

# The browser's WebUI (sidebar, Boost editor…) learns it is the beta: loadTimeData 'meridianBeta'.
def webui(t):
    t = add_include(t, 'chrome/browser/meridian/beta.h')
    return once(t, '  source->AddInteger("tabStripInset",',
                '  source->AddBoolean("meridianBeta", meridian::IsBeta());\n'
                '  source->AddInteger("tabStripInset",')
edit('chrome/browser/ui/webui_browser/webui_browser_ui.cc', webui)

# Remix (when it is in the tree): on in the beta unless turned off.
remix = os.path.join(SRC, 'chrome/browser/resources/webui_browser/meridian/remix.ts')
if os.path.exists(remix):
    def rx(t):
        t = once(t, "const FLAG_KEY = 'meridian.remix';\n",
                 "const FLAG_KEY = 'meridian.remix';\n")
        t = re.sub(r'^(// Copyright[^\n]*\n(?://[^\n]*\n)*)', r"\1\nimport {loadTimeData} from '//resources/js/load_time_data.js';\n", t, count=1)
        return once(t, '  return DEFAULT_ON;\n}',
                    "  // Meridian Beta: on unless turned off.\n"
                    "  return DEFAULT_ON ||\n"
                    "      (loadTimeData.valueExists('meridianBeta') &&\n"
                    "       loadTimeData.getBoolean('meridianBeta'));\n}")
    edit('chrome/browser/resources/webui_browser/meridian/remix.ts', rx)

# Designer toolkit (when it is in the tree): on in the beta.
tk = os.path.join(M, 'toolkit/toolkit_tab_helper.cc')
if os.path.exists(tk):
    def tkf(t):
        t = add_include(t, 'chrome/browser/meridian/beta.h')
        return guard_body(t, 'bool Enabled(Profile* profile', '  if (IsBeta()) {\n    return true;\n  }\n')
    edit('chrome/browser/meridian/toolkit/toolkit_tab_helper.cc', tkf)
print('glue applied')
