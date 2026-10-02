#!/bin/bash
# Собирает и ставит Voicenotes для Мака прямо на этом компьютере:
#   curl -fsSL https://raw.githubusercontent.com/QuiltyVal/voicenotes/HEAD/mac/install.sh | bash
# Собранная у себя программа не помечается как «скачанная из интернета», так что
# macOS не ругается на неизвестного разработчика. Заодно кладёт расширение для Chrome
# в папку «Документы».
set -euo pipefail

say() { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✖ %s\033[0m\n' "$*"; exit 1; }

[ "$(uname)" = "Darwin" ] || die "Этот установщик — для Мака."

if ! xcrun --find swiftc >/dev/null 2>&1; then
  say "Нужны инструменты разработчика Apple (бесплатно, один раз)"
  echo "Сейчас откроется окно установки — нажми «Установить» и дождись конца (5–15 минут)."
  echo "Потом снова вставь ту же команду."
  xcode-select --install >/dev/null 2>&1 || true
  exit 0
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

say "Скачиваю код"
curl -fsSL https://github.com/QuiltyVal/voicenotes/archive/HEAD.tar.gz | tar -xz -C "$WORK" --strip-components=1

say "Собираю программу (около минуты)"
"$WORK/mac/build.sh" > "$WORK/build.log" 2>&1 || {
  tail -40 "$WORK/build.log"
  die "Сборка не удалась. Скопируй текст выше и пришли его."
}

say "Ставлю в «Программы»"
pkill -x Voicenotes 2>/dev/null || true
rm -rf /Applications/Voicenotes.app
cp -R "$WORK/mac/build/Voicenotes.app" /Applications/

EXT="$HOME/Documents/Voicenotes расширение Chrome"
rm -rf "$EXT"
cp -R "$WORK/extension" "$EXT"

open /Applications/Voicenotes.app
printf '\n\033[1;32m✔ Готово!\033[0m\n'
cat <<DONE
   Значок Voicenotes появился в строке меню (справа сверху, рядом с часами).
   1. Разреши микрофон и «Запись экрана и системного звука», когда macOS спросит.
      Если не спросила: Системные настройки → Конфиденциальность и безопасность →
      «Запись экрана и системного звука» → включи Voicenotes и перезапусти программу.
   2. В меню значка → «Настройки…» → адрес приложения и пароль.

   Расширение для Chrome лежит в «Документах»: «Voicenotes расширение Chrome».
   Обновить программу — запусти эту же команду ещё раз.
DONE
