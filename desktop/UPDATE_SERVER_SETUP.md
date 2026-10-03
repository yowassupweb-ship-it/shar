# Настройка сервера обновлений для Electron App

## Структура на сервере

На сервере `vokrug-sveta.shar-os.ru` нужно создать директорию для обновлений:

```bash
mkdir -p /var/www/shar/updates
chmod 755 /var/www/shar/updates
```

## Файлы для размещения

После сборки приложения (`npm run build:win`), файлы из папки `release` нужно загрузить на сервер:

### 1. latest.yml
Файл с информацией о последней версии:
```yaml
version: 0.1.0
files:
   - url: Shar setup.exe
    sha512: [хеш файла]
    size: [размер в байтах]
path: Shar setup.exe
sha512: [хеш файла]
releaseDate: '2026-03-10T12:00:00.000Z'
```

### 2. Web installer
- `release/Shar setup.exe` - маленький загрузчик, который скачивает приложение с сервера и запускает после установки

### 3. Пакет приложения
- `release/nsis-web/shar-os-client-<version>-x64.nsis.7z` - payload, который web installer скачивает во время установки

### 4. Файлы для дифференциального обновления
- `release/Shar setup.exe.blockmap` - рекомендуется выкладывать вместе с installer для более эффективного обновления

## Процесс обновления

1. **Сборка приложения локально**:
   ```bash
   cd frontend/native/electron
   npm run build:win
   ```

2. **Загрузка на сервер**:
   ```bash
   scp release/latest.yml root@vokrug-sveta.shar-os.ru:/var/www/shar/updates/
   scp "release/Shar setup.exe" root@vokrug-sveta.shar-os.ru:/var/www/shar/updates/
   scp "release/Shar setup.exe.blockmap" root@vokrug-sveta.shar-os.ru:/var/www/shar/updates/
   scp release/nsis-web/*.7z root@vokrug-sveta.shar-os.ru:/var/www/shar/updates/
   ```

3. **Настройка Nginx** (если еще не настроено):
   ```nginx
   location /updates {
       alias /var/www/shar/updates;
       autoindex off;
       add_header Access-Control-Allow-Origin *;
   }
   ```

4. **Проверка доступности**:
   ```bash
   curl https://vokrug-sveta.shar-os.ru/updates/latest.yml
   ```

## Автоматическая проверка обновлений

Приложение автоматически проверяет обновления:
- Через 3 секунды после запуска
- Только в собранной версии (app.isPackaged = true)
- Загружается автоматически и после скачивания перезапускается в обновленную версию

## Логи

Проверить работу автообновления можно в консоли DevTools:
- "Checking for updates..." - начало проверки
- "Update available: {...}" - доступно обновление
- "Download progress: X%" - прогресс загрузки
- "Update downloaded: {...}" - обновление загружено, приложение завершится и установит новую версию

## Ручная сборка для публикации

```bash
cd frontend/native/electron
npm version patch  # Увеличить версию (0.1.0 -> 0.1.1)
npm run build:win
# Загрузить latest.yml, .exe и .7z на сервер
```

## Важные моменты

1. Версия в `package.json` должна увеличиваться при каждом обновлении
2. Файл `latest.yml` генерируется автоматически при сборке
3. Для первого запуска пользователь должен скачивать именно `Shar setup.exe`, а не распакованную portable-версию
4. Для web installer и автообновления на сервере должны лежать как минимум `latest.yml`, `Shar setup.exe` и `.nsis.7z`
5. `Shar setup.exe.blockmap` лучше тоже выкладывать, чтобы updater мог скачивать изменения эффективнее
6. В dev режиме автообновление не работает
