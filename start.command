#!/bin/bash
# Двойной клик в Finder запускает Voicenotes (macOS).
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

pause() {
  read -n 1 -s -r -p "Нажми любую клавишу, чтобы закрыть окно…"
  echo
}

if ! command -v npm >/dev/null 2>&1; then
  echo "Не найден Node.js. Установи его с https://nodejs.org (кнопка LTS) и запусти снова."
  open "https://nodejs.org"
  pause
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Первый запуск: устанавливаю зависимости, это минута-две…"
  if ! npm install; then
    echo "Не получилось установить зависимости (ошибка выше)."
    pause
    exit 1
  fi
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo
  echo "Создан файл настроек .env и открыт в TextEdit."
  echo "Впиши ключи после MISTRAL_API_KEY= и ANTHROPIC_API_KEY= (без пробелов и кавычек),"
  echo "сохрани (Cmd+S) и снова дважды кликни start.command."
  open -e .env
  pause
  exit 0
fi

# Open the browser as soon as the server answers.
(for _ in $(seq 1 30); do
  if curl -s -o /dev/null http://localhost:3000; then
    open "http://localhost:3000"
    break
  fi
  sleep 1
done) &

echo "Voicenotes запущен: http://localhost:3000"
echo "Чтобы остановить — закрой это окно."
echo
npm start
