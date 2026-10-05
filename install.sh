#!/usr/bin/env bash
# Voicenotes: установка на свой сервер (Ubuntu / Debian).
#
#   curl -fsSL https://raw.githubusercontent.com/QuiltyVal/voicenotes/HEAD/install.sh | sudo bash
#
# Ставит приложение в Docker на поддомен (например notes.example.com). Если на сервере уже
# работает сайт через nginx, Apache или Caddy, добавляет к нему только новый поддомен и
# HTTPS-сертификат, существующие сайты не трогает. Повторный запуск обновляет приложение
# и сохраняет настройки.
set -euo pipefail

REPO="https://github.com/QuiltyVal/voicenotes.git"
DIR="/opt/voicenotes"

say()  { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✔ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31m✖ %s\033[0m\n' "$*"; exit 1; }

# The script usually arrives through a pipe, so questions are read from the terminal.
ask() { # ask VAR "question" [default]
  local value
  read -r -p "$2${3:+ [$3]}: " value < /dev/tty || true
  printf -v "$1" '%s' "${value:-${3:-}}"
}

ask_secret() { # ask_secret VAR "question" current_value
  local value hint=""
  [ -n "$3" ] && hint=" (Enter — оставить текущий)"
  read -r -p "$2$hint: " value < /dev/tty || true
  printf -v "$1" '%s' "${value:-$3}"
}

env_get() {
  [ -f "$DIR/.env" ] || return 0
  grep -E "^$1=" "$DIR/.env" | tail -n 1 | cut -d= -f2- || true
}

env_set() {
  local file="$DIR/.env"
  if grep -qE "^$1=" "$file"; then
    K="$1" V="$2" awk -F= '$1 == ENVIRON["K"] { print ENVIRON["K"] "=" ENVIRON["V"]; next } { print }' \
      "$file" > "$file.tmp" && mv "$file.tmp" "$file"
  else
    printf '%s=%s\n' "$1" "$2" >> "$file"
  fi
}

port_owner() {
  ss -ltnpH "sport = :$1" 2>/dev/null | grep -o 'users:(("[^"]*' | head -n 1 | cut -d'"' -f2 || true
}

port_busy() {
  ss -ltnH "sport = :$1" 2>/dev/null | grep -q .
}

[ "$(id -u)" -eq 0 ] || die "Нужны права администратора. Запусти так:  curl -fsSL https://raw.githubusercontent.com/QuiltyVal/voicenotes/HEAD/install.sh | sudo bash"
command -v apt-get >/dev/null || die "Установщик рассчитан на Ubuntu или Debian."
{ : < /dev/tty; } 2>/dev/null || die "Запусти установщик в обычном терминале (по SSH)."

# ------------------------------------------------------------------ questions
say "Настройка"
DOMAIN_DEFAULT=$(env_get DOMAIN)
ask DOMAIN "Адрес приложения — поддомен твоего домена, например notes.example.com" "$DOMAIN_DEFAULT"
DOMAIN=${DOMAIN#http://}; DOMAIN=${DOMAIN#https://}; DOMAIN=${DOMAIN%%/*}; DOMAIN=$(printf '%s' "$DOMAIN" | tr 'A-Z' 'a-z')
[[ "$DOMAIN" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || die "Не похоже на адрес: '$DOMAIN'"

ask_secret ANTHROPIC_API_KEY "Ключ Anthropic (начинается с sk-ant-)" "$(env_get ANTHROPIC_API_KEY)"
[ -n "$ANTHROPIC_API_KEY" ] || die "Без ключа Anthropic конспекты работать не будут."
ask_secret OPENAI_API_KEY "Ключ OpenAI (начинается с sk-)" "$(env_get OPENAI_API_KEY)"
[ -n "$OPENAI_API_KEY$(env_get MISTRAL_API_KEY)$(env_get OPENROUTER_API_KEY)" ] || die "Нужен ключ OpenAI для расшифровки."

APP_PASSWORD_OLD=$(env_get APP_PASSWORD)
if [ -n "$APP_PASSWORD_OLD" ]; then
  ask_secret APP_PASSWORD "Пароль для входа в приложение" "$APP_PASSWORD_OLD"
else
  ask APP_PASSWORD "Придумай пароль для входа в приложение (Enter — придумаю сам)"
  [ -n "$APP_PASSWORD" ] || APP_PASSWORD=$(head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-14)
fi

# ------------------------------------------------------------------ DNS
say "Проверяю, что $DOMAIN указывает на этот сервер"
SERVER_IP=$(curl -fsS4 --max-time 8 https://api.ipify.org 2>/dev/null || true)
while :; do
  DNS_IP=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR == 1 { print $1 }' || true)
  if [ -n "$SERVER_IP" ] && [ "$DNS_IP" = "$SERVER_IP" ]; then
    ok "$DOMAIN → $SERVER_IP"
    break
  fi
  warn "$DOMAIN пока не указывает на этот сервер${DNS_IP:+ (сейчас: $DNS_IP)}."
  echo "   В панели, где куплен домен, открой настройки DNS и добавь запись:"
  echo "     тип: A     имя: ${DOMAIN%%.*}     значение: ${SERVER_IP:-<IP этого сервера>}"
  echo "   Обычно запись начинает работать через 5–30 минут."
  ask ANSWER "Нажми Enter, чтобы проверить ещё раз (или напиши skip, чтобы продолжить без проверки)"
  [ "$ANSWER" = "skip" ] && break
  sleep 2
done

# ------------------------------------------------------------------ packages
say "Ставлю нужные программы (Docker, git)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates >/dev/null
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
if ! docker compose version >/dev/null 2>&1; then
  apt-get install -y -qq docker-compose-plugin >/dev/null 2>&1 \
    || apt-get install -y -qq docker-compose-v2 >/dev/null 2>&1 \
    || die "Не получилось установить docker compose."
fi
systemctl enable --now docker >/dev/null 2>&1 || true
ok "Docker готов"

# ------------------------------------------------------------------ code
say "Скачиваю приложение в $DIR"
export GIT_TERMINAL_PROMPT=0
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only -q || die "Не получилось обновить код в $DIR."
else
  git clone -q "$REPO" "$DIR" || die "Не получилось скачать код. Репозиторий на GitHub должен быть публичным."
fi
ok "Код на месте"

# ------------------------------------------------------------------ settings
WEB=$(port_owner 80)
[ -n "$WEB" ] || WEB=$(port_owner 443)
case "$WEB" in
  "") MODE=standalone ;;
  nginx*) MODE=nginx ;;
  apache2* | httpd*) MODE=apache ;;
  caddy*) MODE=caddy ;;
  *) MODE=other ;;
esac
# A previous standalone install owns 80/443 through its own Caddy container.
if [ "$(env_get INSTALL_MODE)" = "standalone" ] && [ "$WEB" = "docker-proxy" ]; then MODE=standalone; fi

APP_PORT=$(env_get APP_PORT)
if [ -z "$APP_PORT" ]; then
  APP_PORT=3100
  while port_busy "$APP_PORT"; do APP_PORT=$((APP_PORT + 1)); done
fi

[ -f "$DIR/.env" ] || cp "$DIR/.env.example" "$DIR/.env"
env_set DOMAIN "$DOMAIN"
env_set ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY"
env_set OPENAI_API_KEY "$OPENAI_API_KEY"
env_set APP_PASSWORD "$APP_PASSWORD"
env_set APP_PORT "$APP_PORT"
env_set INSTALL_MODE "$MODE"
chmod 600 "$DIR/.env" # keys live here; env_set recreates the file
ok "Настройки сохранены в $DIR/.env"

# ------------------------------------------------------------------ start
say "Собираю и запускаю приложение (первый раз — пара минут)"
cd "$DIR"
if [ "$MODE" = "standalone" ]; then
  docker compose up -d --build --remove-orphans
  if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
    ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  fi
else
  docker compose -f docker-compose.yml -f docker-compose.proxy.yml up -d --build app
fi

for _ in $(seq 1 60); do
  if [ "$MODE" = "standalone" ] || curl -s -o /dev/null "http://127.0.0.1:$APP_PORT/"; then break; fi
  sleep 2
done
ok "Приложение запущено"

# ------------------------------------------------------------------ web server
ensure_certbot() { # ensure_certbot nginx|apache
  if ! command -v certbot >/dev/null; then
    apt-get install -y -qq certbot "python3-certbot-$1" >/dev/null
  elif ! certbot plugins 2>/dev/null | grep -q "^\* $1"; then
    apt-get install -y -qq "python3-certbot-$1" >/dev/null || true
  fi
}

get_certificate() { # get_certificate nginx|apache
  ensure_certbot "$1"
  if certbot "--$1" -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect >/tmp/voicenotes-certbot.log 2>&1; then
    ok "HTTPS-сертификат для $DOMAIN получен"
  else
    warn "Сертификат пока не получился (подробности: /tmp/voicenotes-certbot.log)."
    warn "Чаще всего DNS ещё не обновился — подожди и запусти установщик ещё раз."
  fi
}

case "$MODE" in
  standalone)
    ok "Caddy из комплекта сам получит HTTPS-сертификат для $DOMAIN"
    ;;

  nginx)
    say "Подключаю $DOMAIN к nginx (остальные сайты не трогаю)"
    if [ -d /etc/nginx/sites-available ] && grep -rqs "sites-enabled" /etc/nginx/nginx.conf; then
      CONF=/etc/nginx/sites-available/voicenotes
      LINK=/etc/nginx/sites-enabled/voicenotes
    else
      CONF=/etc/nginx/conf.d/voicenotes.conf
      LINK=""
    fi
    if [ ! -f "$CONF" ]; then
      cat > "$CONF" <<NGINX
# Voicenotes (создано install.sh)
server {
    listen 80;
    server_name $DOMAIN;

    client_max_body_size 2g;
    proxy_request_buffering off;
    proxy_read_timeout 900s;
    proxy_send_timeout 900s;

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX
      [ -n "$LINK" ] && ln -sf "$CONF" "$LINK"
    fi
    if ! nginx -t >/tmp/voicenotes-nginx.log 2>&1; then
      rm -f "$CONF" ${LINK:+"$LINK"}
      die "nginx не принял настройку — я её убрал, сайт работает как раньше. Подробности: /tmp/voicenotes-nginx.log"
    fi
    systemctl reload nginx
    ok "nginx настроен"
    get_certificate nginx
    ;;

  apache)
    say "Подключаю $DOMAIN к Apache (остальные сайты не трогаю)"
    a2enmod -q proxy proxy_http headers >/dev/null
    CONF=/etc/apache2/sites-available/voicenotes.conf
    if [ ! -f "$CONF" ]; then
      cat > "$CONF" <<APACHE
# Voicenotes (создано install.sh)
<VirtualHost *:80>
    ServerName $DOMAIN
    ProxyPreserveHost On
    ProxyTimeout 900
    ProxyPass / http://127.0.0.1:$APP_PORT/
    ProxyPassReverse / http://127.0.0.1:$APP_PORT/
</VirtualHost>
APACHE
    fi
    a2ensite -q voicenotes >/dev/null
    if ! apache2ctl configtest >/tmp/voicenotes-apache.log 2>&1; then
      a2dissite -q voicenotes >/dev/null; rm -f "$CONF"
      die "Apache не принял настройку — я её убрал, сайт работает как раньше. Подробности: /tmp/voicenotes-apache.log"
    fi
    systemctl reload apache2
    ok "Apache настроен"
    get_certificate apache
    ;;

  caddy)
    say "Подключаю $DOMAIN к Caddy (остальные сайты не трогаю)"
    CADDYFILE=/etc/caddy/Caddyfile
    if ! grep -qs "^$DOMAIN" "$CADDYFILE"; then
      cp "$CADDYFILE" "$CADDYFILE.bak-voicenotes"
      printf '\n# Voicenotes (создано install.sh)\n%s {\n\treverse_proxy 127.0.0.1:%s\n}\n' "$DOMAIN" "$APP_PORT" >> "$CADDYFILE"
    fi
    if ! caddy validate --config "$CADDYFILE" --adapter caddyfile >/tmp/voicenotes-caddy.log 2>&1; then
      [ -f "$CADDYFILE.bak-voicenotes" ] && mv "$CADDYFILE.bak-voicenotes" "$CADDYFILE"
      die "Caddy не принял настройку — вернул как было. Подробности: /tmp/voicenotes-caddy.log"
    fi
    systemctl reload caddy
    ok "Caddy настроен, сертификат он получит сам"
    ;;

  other)
    warn "Порты 80/443 занимает «${WEB}» — подключить его автоматически я не умею."
    echo "   Приложение работает на этом сервере по адресу http://127.0.0.1:$APP_PORT"
    echo "   Направь на него $DOMAIN в настройках своего веб-сервера или панели (reverse proxy)."
    ;;
esac

# ------------------------------------------------------------------ done
say "Проверяю https://$DOMAIN"
CODE=""
for _ in $(seq 1 20); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$DOMAIN/" || true)
  [ "$CODE" = "401" ] || [ "$CODE" = "200" ] && break
  sleep 3
done

echo
if [ "$CODE" = "401" ] || [ "$CODE" = "200" ]; then
  printf '\033[1;32m🎉 Готово!\033[0m\n'
else
  warn "Приложение запущено, но https://$DOMAIN пока не открывается (часто это DNS или сертификат — подожди 10–30 минут и запусти установщик ещё раз)."
fi
cat <<DONE

   Адрес:   https://$DOMAIN
   Логин:   любой
   Пароль:  $APP_PASSWORD

   На телефоне открой адрес и выбери «Добавить на главный экран».
   Обновить приложение — запусти эту же команду ещё раз.
   Настройки: $DIR/.env  (после изменения: cd $DIR && docker compose restart app)
DONE
