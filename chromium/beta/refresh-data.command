#!/bin/bash
# Обновить данные из Meridian → Meridian Beta.
# Копирует ваш профиль основного Meridian в отдельную папку беты. Основной Meridian
# только читается: в его папку ничего не пишется. Бету перед этим надо закрыть.
set -euo pipefail

SRC="${MERIDIAN_BETA_SRC:-$HOME/Library/Application Support/Meridian Browser}"
DST="${MERIDIAN_BETA_DST:-$HOME/Library/Application Support/Meridian Beta}"
TMP="$DST.copying"

say() { printf '%s\n' "$*"; }
pause() { [ -t 0 ] && [ "${MERIDIAN_BETA_NO_PAUSE:-}" != 1 ] && read -r -p "Нажмите Enter, чтобы закрыть окно…" _ || true; }

if [ ! -d "$SRC" ]; then
  say "Не нашёл данные основного Meridian: $SRC"; pause; exit 1
fi
if ps -axo args= | grep -F "Meridian Beta.app/Contents/MacOS/Meridian" | grep -vq grep; then
  say "Meridian Beta сейчас открыта. Закройте её (⌘Q) и запустите это ещё раз."; pause; exit 1
fi
if ps -axo args= | grep -F "/Applications/Meridian.app/Contents/MacOS/Meridian" | grep -vq grep; then
  say "Основной Meridian открыт — это нормально, его не трогаю."
  say "Копия будет как после внезапного выключения: обычно всё на месте, в худшем случае пропадёт последняя минута истории."
fi

say "Копирую данные из основного Meridian в бету…"
rm -rf "$TMP"
mkdir -p "$TMP"
# Только чтение из SRC. Не копируем: замки и сокеты запущенного Meridian, кэши,
# отчёты о падениях, файлы обновлятора и адрес MCP-сокета основного браузера.
/usr/bin/rsync -a \
  --exclude='/Singleton*' --exclude='/RunningChromeVersion' --exclude='*.sock' \
  --exclude='/Meridian Agent.json' --exclude='/Meridian Crash Relaunch' \
  --exclude='/Meridian Update/' --exclude='/Crashpad/' --exclude='/BrowserMetrics*' \
  --exclude='/component_crx_cache/' --exclude='/extensions_crx_cache/' \
  --exclude='/GPUPersistentCache/' --exclude='/Local Traces/' \
  --exclude='Cache/' --exclude='Code Cache/' --exclude='GPUCache/' --exclude='DawnGraphiteCache/' \
  --exclude='DawnWebGPUCache/' --exclude='GrShaderCache/' --exclude='ShaderCache/' \
  --exclude='GraphiteDawnCache/' --exclude='LOCK' --exclude='lockfile' \
  "$SRC/" "$TMP/"

# В копии (не в основном!) забываем открытые сессии Workbench: иначе бета при открытии
# Workbench сама продолжила бы (claude --resume) те же сессии, что идут в основном Meridian.
find "$TMP" -maxdepth 2 -name Preferences -type f -print0 | while IFS= read -r -d '' p; do
  /usr/bin/python3 -I - "$p" <<'PY' || true
import json, sys
p = sys.argv[1]
try:
    d = json.load(open(p, encoding="utf-8"))
except Exception:
    sys.exit(0)
wb = d.get("meridian", {}).get("workbench")
if isinstance(wb, dict) and "claude_sessions" in wb:
    del wb["claude_sessions"]
    json.dump(d, open(p, "w", encoding="utf-8"), separators=(",", ":"))
PY
done

if [ -d "$DST" ]; then
  OLD="$DST.old-$(date +%Y%m%d-%H%M%S)"
  mv "$DST" "$OLD"
  rm -rf "$OLD"
fi
mv "$TMP" "$DST"
say "Готово: $(du -sh "$DST" | cut -f1) в «Meridian Beta». Открывайте Meridian Beta."
pause
