#!/usr/bin/env bash
# Резервная копия сайта: архив с данными игр и настройками сервера,
# который хранится здесь и копируется на другой сервер.
#
#   ./backup.sh           — сделать архив и отправить на другой сервер
#   ./backup.sh --local   — только архив на этом сервере, без отправки
#
# В архиве: data/ (игры, карточки, усложнения), конфиг nginx, задания cron,
# список процессов pm2 (с настройками входа администратора), номер версии и коммит.
# Код сайта не архивируется — он лежит на GitHub.
#
# Настройки — в /etc/game-backup.conf (строки вида NAME=значение) или в переменных окружения:
#   REMOTE=gamebackup@1.2.3.4       куда копировать (пусто — только локальный архив)
#   REMOTE_DIR=.                    папка на том сервере; «.» — папка, которую разрешает rrsync (см. README)
#   SSH_KEY=/root/.ssh/game_backup  ключ для входа на тот сервер
#   SSH_PORT=22
#   BACKUP_DIR=/var/backups/game    где хранить архивы на этом сервере
#   KEEP_DAYS=30                    сколько дней хранить архивы на этом сервере
set -uo pipefail

export PATH="/usr/local/bin:/usr/bin:/bin:${PATH:-}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="${BACKUP_CONF:-/etc/game-backup.conf}"
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"
REMOTE="${REMOTE:-}"
REMOTE_DIR="${REMOTE_DIR:-.}"
SSH_KEY="${SSH_KEY:-/root/.ssh/game_backup}"
SSH_PORT="${SSH_PORT:-22}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/game}"
KEEP_DAYS="${KEEP_DAYS:-30}"
LOG_FILE="${LOG_FILE:-/var/log/game-backup.log}"
PM2_DUMP="${PM2_HOME:-$HOME/.pm2}/dump.pm2"
LOCAL_ONLY=0
[ "${1:-}" = "--local" ] && LOCAL_ONLY=1

log() {
  local line
  line="$(date '+%Y-%m-%d %H:%M:%S') $*"
  echo "$line"
  echo "$line" >> "$LOG_FILE" 2>/dev/null || true
}

version() {
  sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$APP_DIR/package.json" | head -n 1
}

# Копирует файл в архив, сохраняя путь (например, /etc/nginx/... → system/etc/nginx/...).
add_system_file() {
  [ -r "$1" ] || return 0
  mkdir -p "$STAGE/game/system$(dirname "$1")"
  cp -a "$1" "$STAGE/game/system$1"
}

send_remote() {
  local ssh_cmd="ssh -i $SSH_KEY -p $SSH_PORT -o BatchMode=yes -o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new"
  # Отправляются все архивы, которых ещё нет на том сервере: если прошлая отправка не удалась,
  # пропущенные копии догонят. Старые архивы там не удаляются — за это отвечает тот сервер.
  rsync -a --ignore-existing --include='game-*.tar.gz' --exclude='*' \
    -e "$ssh_cmd" "$BACKUP_DIR/" "$REMOTE:$REMOTE_DIR/" >> "$LOG_FILE" 2>&1
}

main() {
  umask 077
  mkdir -p "$BACKUP_DIR" || { log "ОШИБКА: не удалось создать папку $BACKUP_DIR"; exit 1; }

  exec 9>"$BACKUP_DIR/.lock"
  if ! flock -n 9; then
    log "Резервное копирование уже выполняется, выходим"
    exit 0
  fi

  local ver name archive
  ver="$(version)"
  name="game-$(date '+%Y-%m-%d_%H%M%S')-v${ver:-unknown}.tar.gz"
  archive="$BACKUP_DIR/$name"

  STAGE="$(mktemp -d)"
  trap 'rm -rf "$STAGE"' EXIT
  mkdir -p "$STAGE/game"

  if [ -d "$APP_DIR/data" ]; then
    cp -a "$APP_DIR/data" "$STAGE/game/data"
  else
    log "Внимание: папки data нет — в архиве будут только настройки"
  fi
  for f in /etc/nginx/sites-available/game* /etc/cron.d/game-* /etc/game-backup.conf "$PM2_DUMP"; do
    add_system_file "$f"
  done
  {
    echo "Сайт: $APP_DIR"
    echo "Версия: ${ver:-?}"
    echo "Коммит: $(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || echo '?')"
    echo "Ветка: $(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
    echo "Сервер: $(hostname)"
    echo "Создан: $(date '+%Y-%m-%d %H:%M:%S %z')"
  } > "$STAGE/game/BACKUP-INFO.txt"

  if ! tar -czf "$archive.part" -C "$STAGE" game || ! tar -tzf "$archive.part" > /dev/null; then
    rm -f "$archive.part"
    log "ОШИБКА: не удалось создать архив"
    exit 1
  fi
  mv "$archive.part" "$archive"
  log "Архив создан: $archive ($(du -h "$archive" | cut -f1))"

  find "$BACKUP_DIR" -maxdepth 1 -name 'game-*.tar.gz' -mtime "+$KEEP_DAYS" -print -delete \
    | sed 's/^/  удалён старый архив: /' | tee -a "$LOG_FILE"

  if [ "$LOCAL_ONLY" = 1 ]; then
    return 0
  fi
  if [ -z "$REMOTE" ]; then
    log "Другой сервер не настроен (REMOTE в $CONF) — архив только на этом сервере"
    return 0
  fi
  if ! command -v rsync > /dev/null; then
    log "ОШИБКА: не установлен rsync (apt install rsync) — архив не отправлен"
    exit 1
  fi
  if send_remote; then
    log "Архив отправлен на $REMOTE"
  else
    log "ОШИБКА: не удалось отправить архив на $REMOTE (подробности в $LOG_FILE). Архив сохранён здесь и уйдёт со следующей копией."
    exit 1
  fi
}

main "$@"
