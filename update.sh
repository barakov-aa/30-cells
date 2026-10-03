#!/usr/bin/env bash
# Обновление сайта с GitHub. Перезапускает сайт, только если есть новые изменения
# и тесты проходят; иначе оставляет всё как есть.
#
#   ./update.sh          — обновить сейчас (запуск вручную)
#   ./update.sh --auto   — для расписания (cron): если игра идёт прямо сейчас
#                          (данные менялись последние 30 минут), обновление откладывается
#
# Настройки через переменные окружения:
#   PM2_NAME=game        — имя процесса в pm2
#   IDLE_MINUTES=30      — сколько минут тишины считать «игры нет» в режиме --auto
set -uo pipefail

export PATH="/usr/local/bin:/usr/bin:/bin:${PATH:-}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PM2_NAME="${PM2_NAME:-game}"
IDLE_MINUTES="${IDLE_MINUTES:-30}"
LOG_FILE="$APP_DIR/update.log"
FAILED_FILE="$APP_DIR/.update-failed"
AUTO=0
[ "${1:-}" = "--auto" ] && AUTO=1

log() {
  local line
  line="$(date '+%Y-%m-%d %H:%M:%S') $*"
  echo "$line"
  echo "$line" >> "$LOG_FILE"
}

# Номер версии игры из package.json в указанном коммите (без запуска node).
version_of() {
  local v
  v="$(git show "$1:package.json" 2>/dev/null | sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  echo "${v:-?}"
}

# «версия 1.1.0 (6acbc1a)» — номер из package.json и короткий код коммита.
label() {
  echo "версия $(version_of "$1") (${1:0:7})"
}

# Всё тело — в функции: bash прочитает скрипт целиком до начала работы.
# Это важно, потому что git pull может заменить этот самый файл во время выполнения.
main() {
  cd "$APP_DIR" || exit 1

  # Не даём двум обновлениям идти одновременно (например, ручному и по расписанию).
  exec 9>"$APP_DIR/.update.lock"
  if ! flock -n 9; then
    log "Обновление уже выполняется, выходим"
    exit 0
  fi

  if ! git fetch --quiet origin; then
    log "ОШИБКА: не удалось связаться с GitHub (git fetch). Сайт не тронут."
    exit 1
  fi

  OLD="$(git rev-parse HEAD)"
  NEW="$(git rev-parse '@{u}' 2>/dev/null)" || {
    log "ОШИБКА: у текущей ветки не настроена ветка на GitHub. Сайт не тронут."
    exit 1
  }

  # Правки файлов прямо на сервере откат бы стёр — в таком случае не обновляем.
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    log "ОШИБКА: на сервере изменены файлы проекта (см. git status) — обновление отменено, сайт не тронут."
    exit 1
  fi

  if [ "$OLD" = "$NEW" ]; then
    [ "$AUTO" = 1 ] || log "Обновлений нет: установлена $(label "$OLD"), сайт не перезапускается"
    exit 0
  fi

  # Эта версия уже не прошла проверку — ждём, пока на GitHub появится исправление.
  if [ "$(cat "$FAILED_FILE" 2>/dev/null)" = "$NEW" ]; then
    [ "$AUTO" = 1 ] || log "Обновление до $(version_of "$NEW") (${NEW:0:7}) уже не прошло проверку ранее — ждём исправления на GitHub. Сейчас установлена $(label "$OLD")"
    exit 1
  fi

  if [ "$AUTO" = 1 ] && [ -n "$(find "$APP_DIR/data/games.json" -mmin "-$IDLE_MINUTES" 2>/dev/null)" ]; then
    log "Есть обновление: $(label "$OLD") → $(label "$NEW"), но сейчас идёт игра — откладываем"
    exit 0
  fi

  local old_version new_version
  old_version="$(version_of "$OLD")"
  new_version="$(version_of "$NEW")"
  if [ "$old_version" = "$new_version" ]; then
    log "Найдено обновление без смены номера версии: $(label "$OLD") → $(label "$NEW")"
  else
    log "Найдено обновление: версия $old_version → $new_version (${OLD:0:7} → ${NEW:0:7})"
  fi
  log "Изменения:"
  git log --format='  • %s' "$OLD..$NEW" | tee -a "$LOG_FILE"

  if [ -x "$APP_DIR/backup.sh" ]; then
    log "Резервная копия данных перед обновлением"
    "$APP_DIR/backup.sh" --local >> "$LOG_FILE" 2>&1 \
      || log "Внимание: резервную копию сделать не удалось (см. /var/log/game-backup.log), продолжаем обновление"
  fi

  if ! git merge --ff-only --quiet '@{u}'; then
    log "ОШИБКА: не удалось применить обновление (git merge). Сайт не тронут."
    exit 1
  fi

  deps_changed() {
    ! git diff --quiet "$1" "$2" -- package.json package-lock.json
  }

  rollback() {
    log "Возвращаем прежнее состояние: $(label "$OLD")"
    git reset --hard --quiet "$OLD"
    if deps_changed "$OLD" "$NEW"; then
      npm ci --omit=dev --no-audit --no-fund >> "$LOG_FILE" 2>&1
    fi
  }

  if deps_changed "$OLD" "$NEW"; then
    # npm ci ставит зависимости строго по package-lock.json и не меняет файлы проекта,
    # иначе следующее обновление увидело бы «локальные изменения».
    log "Изменились зависимости — npm ci"
    if ! npm ci --omit=dev --no-audit --no-fund >> "$LOG_FILE" 2>&1; then
      log "ОШИБКА: установка зависимостей (npm ci) не удалась"
      echo "$NEW" > "$FAILED_FILE"
      rollback
      exit 1
    fi
  fi

  log "Проверяем тесты"
  if ! npm test >> "$LOG_FILE" 2>&1; then
    log "ОШИБКА: тесты не прошли (подробности в update.log), сайт не перезапускается"
    echo "$NEW" > "$FAILED_FILE"
    rollback
    exit 1
  fi

  if ! pm2 restart "$PM2_NAME" >> "$LOG_FILE" 2>&1; then
    log "ОШИБКА: pm2 не смог перезапустить «$PM2_NAME»"
    exit 1
  fi
  rm -f "$FAILED_FILE"
  log "Готово: сайт обновлён и перезапущен, теперь установлена $(label "$NEW")"
}

main "$@"
exit $?
