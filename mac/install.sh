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

# ------------------------------------------------------------------ signing
# A personal self-signed certificate gives every build the same signature, so macOS keeps
# the microphone / screen & system audio permissions after updates.
CERT_NAME="Voicenotes Local Signing"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
cert_hash() { security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null | awk -v n="\"$CERT_NAME\"" 'index($0, n) { print $2; exit }'; }

if [ -z "$(cert_hash)" ]; then
  say "Создаю личный сертификат для подписи программы (один раз)"
  C="$WORK/cert"; mkdir -p "$C"
  cat > "$C/cfg" <<CFG
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $CERT_NAME
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CFG
  /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$C/cfg" \
    -keyout "$C/key.pem" -out "$C/cert.pem" >/dev/null 2>&1
  /usr/bin/openssl pkcs12 -export -inkey "$C/key.pem" -in "$C/cert.pem" -name "$CERT_NAME" \
    -passout pass:voicenotes -out "$C/id.p12" >/dev/null 2>&1
  security import "$C/id.p12" -k "$KEYCHAIN" -P voicenotes -T /usr/bin/codesign >/dev/null || true
  if [ -z "$(cert_hash)" ]; then
    echo "macOS попросит пароль от Мака, чтобы доверять сертификату для подписи программ."
    security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$C/cert.pem" || true
  fi
fi
SIGN_IDENTITY=$(cert_hash || true)
if [ -n "$SIGN_IDENTITY" ]; then
  export SIGN_IDENTITY
  echo "Если macOS спросит, можно ли codesign использовать ключ «${CERT_NAME}», введи пароль от Мака и нажми «Разрешать всегда»."
else
  echo "Сертификат создать не вышло — подпишу временной подписью (разрешения придётся выдавать после каждого обновления)."
fi

say "Собираю программу (около минуты)"
"$WORK/mac/build.sh" > "$WORK/build.log" 2>&1 || {
  tail -40 "$WORK/build.log"
  die "Сборка не удалась. Скопируй текст выше и пришли его."
}

say "Ставлю в «Программы»"
pkill -x Voicenotes 2>/dev/null || true
# The first build with the permanent signature: forget permissions granted to old builds,
# so macOS asks once more and then remembers.
MARKER="$HOME/Library/Application Support/Voicenotes/signed-with"
if [ -n "${SIGN_IDENTITY:-}" ] && [ "$(cat "$MARKER" 2>/dev/null)" != "$SIGN_IDENTITY" ]; then
  tccutil reset ScreenCapture io.voicenotes.menubar >/dev/null 2>&1 || true
  tccutil reset Microphone io.voicenotes.menubar >/dev/null 2>&1 || true
  mkdir -p "$(dirname "$MARKER")" && echo "$SIGN_IDENTITY" > "$MARKER"
fi
rm -rf /Applications/Voicenotes.app
cp -R "$WORK/mac/build/Voicenotes.app" /Applications/

EXT="$HOME/Documents/Voicenotes расширение Chrome"
rm -rf "$EXT"
cp -R "$WORK/extension" "$EXT"

open /Applications/Voicenotes.app
sleep 4
if ! pgrep -x Voicenotes >/dev/null; then
  say "Программа не запустилась — вот что она пишет:"
  /Applications/Voicenotes.app/Contents/MacOS/Voicenotes > "$WORK/run.log" 2>&1 &
  sleep 5
  cat "$WORK/run.log"
  REPORT=$(ls -t "$HOME/Library/Logs/DiagnosticReports" 2>/dev/null | grep -i voicenotes | head -1 || true)
  [ -n "$REPORT" ] && head -60 "$HOME/Library/Logs/DiagnosticReports/$REPORT"
  die "Сделай скриншот этого окна и пришли."
fi
printf '\n\033[1;32m✔ Готово!\033[0m\n'
cat <<DONE
   Значок Voicenotes появился в строке меню (справа сверху, рядом с часами).
   1. Нажми значок → «Начать запись». macOS спросит про микрофон и «Запись экрана и
      системного звука» — разреши. Если попросит перезапустить программу — согласись.
      Это последний раз: после обновлений разрешения теперь сохраняются.
   2. В меню значка → «Настройки…» → адрес приложения и пароль.

   Расширение для Chrome лежит в «Документах»: «Voicenotes расширение Chrome».
   Обновить программу — запусти эту же команду ещё раз.
DONE
