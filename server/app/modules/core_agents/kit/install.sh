#!/usr/bin/env bash
# Нода «Ядра» Шара на Ubuntu/Debian: Node.js, Claude Code, Codex CLI, Gemini CLI и агент ноды как служба systemd.
#
#   curl -fsSL https://<шар>/api/core/node/install.sh | sudo bash -s -- https://<шар> <токен ноды>
#
# Команду с токеном выдаёт Админка → Ядро → Ноды. Повторный запуск безопасен: так же нода обновляется
# (агент ноды служба и так берёт свежий с Шара при каждом старте). Всё ставится под отдельного пользователя sharnode;
# каталоги сотрудников — /var/lib/shar-node/users/<id> (вход в подписки, сессии, рабочие папки).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

SHAR_URL="${1:?Укажите адрес Шара: bash -s -- https://шар токен}"
TOKEN="${2:?Укажите токен ноды (Админка → Ядро → Ноды)}"
SHAR_URL="${SHAR_URL%/}"
USER_NAME=sharnode
DATA=/var/lib/shar-node
APP=/opt/shar-node
ENV_FILE=/etc/shar-node.env

say() { echo "▸ $*"; }
fail() { echo "✗ $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || fail "Нужны права root: запустите через sudo"
. /etc/os-release 2>/dev/null || fail "Не удалось определить систему"
case "${ID:-}" in ubuntu|debian) ;; *) fail "Поддерживаются Ubuntu и Debian, а здесь ${PRETTY_NAME:-неизвестная система}" ;; esac
[ -d /run/systemd/system ] || fail "Нет systemd: службу ноды поставить не получится"
case "$TOKEN" in shar_node_*) ;; *) fail "Это не токен ноды: он начинается с shar_node_" ;; esac

say "Проверяю связь с Шаром"
curl -fsS "$SHAR_URL/api/v2/health" >/dev/null || fail "Шар по адресу $SHAR_URL не отвечает"

say "Системные пакеты"
apt-get update -qq >/dev/null
apt-get install -y -qq curl ca-certificates gnupg util-linux git ripgrep >/dev/null

say "Node.js"
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge 20 ] && need_node=0
fi
if [ "$need_node" = 1 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

say "Claude Code, Codex, Gemini CLI"
# Ставим глобально: один набор на ноду, у каждого сотрудника — свой каталог со входом.
npm install -g --no-audit --no-fund @anthropic-ai/claude-code @openai/codex @google/gemini-cli >/dev/null 2>&1 \
  || fail "Не удалось поставить CLI агентов (npm install -g …)"

say "Браузер для агентов (Obscura)"
# Готовая сборка с GitHub под архитектуру сервера; не скачалась — агенты работают без браузера, установка идёт дальше.
case "$(uname -m)" in x86_64|amd64) OBS_ARCH=x86_64 ;; aarch64|arm64) OBS_ARCH=aarch64 ;; *) OBS_ARCH="" ;; esac
if [ -n "$OBS_ARCH" ]; then
  install -d -m 755 "$APP/bin"
  OBS_TMP="$(mktemp -d)"
  if curl -fsSL "https://github.com/h4ckf0r0day/obscura/releases/latest/download/obscura-$OBS_ARCH-linux.tar.gz" -o "$OBS_TMP/o.tgz" \
     && tar xzf "$OBS_TMP/o.tgz" -C "$OBS_TMP"; then
    OBS_BIN="$(find "$OBS_TMP" -type f -name obscura | head -1)"
    OBS_WORKER="$(find "$OBS_TMP" -type f -name obscura-worker | head -1)"
    [ -n "$OBS_BIN" ] && install -m 755 "$OBS_BIN" "$APP/bin/obscura"
    [ -n "$OBS_WORKER" ] && install -m 755 "$OBS_WORKER" "$APP/bin/obscura-worker"
  else
    echo "  Obscura не скачалась — агенты будут без браузера"
  fi
  rm -rf "$OBS_TMP"
fi

say "Пользователь $USER_NAME"
id "$USER_NAME" >/dev/null 2>&1 || useradd --system --create-home --home-dir "$DATA" --shell /usr/sbin/nologin "$USER_NAME"
install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" "$DATA" "$DATA/users"
install -d -m 755 "$APP"

say "Агент ноды"
curl -fsSL "$SHAR_URL/api/core/node/agent.mjs" -o "$APP/shar-node.mjs" || fail "Не удалось скачать агента ноды"
node --check "$APP/shar-node.mjs" || fail "Скачанный агент ноды не запускается"

umask 077
cat > "$ENV_FILE" <<EOF
SHAR_URL=$SHAR_URL
SHAR_NODE_TOKEN=$TOKEN
SHAR_NODE_HOME=$DATA
DISABLE_AUTOUPDATER=1
EOF
chown root:"$USER_NAME" "$ENV_FILE"
chmod 640 "$ENV_FILE"
umask 022

cat > /etc/systemd/system/shar-node.service <<EOF
[Unit]
Description=Нода «Ядра» Шара ($SHAR_URL)
After=network-online.target
Wants=network-online.target

[Service]
User=$USER_NAME
EnvironmentFile=$ENV_FILE
WorkingDirectory=$DATA
# Свежий агент с Шара при каждом старте: обновить ноду — перезапустить службу.
ExecStartPre=+-/usr/bin/curl -fsSL $SHAR_URL/api/core/node/agent.mjs -o $APP/shar-node.mjs.new
ExecStartPre=+-/bin/sh -c 'node --check $APP/shar-node.mjs.new && mv $APP/shar-node.mjs.new $APP/shar-node.mjs || rm -f $APP/shar-node.mjs.new'
ExecStart=/usr/bin/node $APP/shar-node.mjs
Restart=always
RestartSec=10
TimeoutStopSec=15
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=$DATA /tmp

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable shar-node.service >/dev/null 2>&1
systemctl restart shar-node.service
sleep 3
systemctl is-active --quiet shar-node.service || { journalctl -u shar-node -n 20 --no-pager; fail "Служба не запустилась"; }

echo "✓ Нода запущена. Через несколько секунд она появится «на связи» в Админке → Ядро → Ноды."
echo "  Журнал: journalctl -u shar-node -f"
