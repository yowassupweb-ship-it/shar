# Обновления Shar OS

Публикация и устройство сервера обновлений описаны в [docs/RELEASE.md](../docs/RELEASE.md#shar-os-electron),
скрипт — `scripts/publish-electron.ps1`.

Коротко о том, как это работает в приложении (`electron/main.cjs`):

- клиент берёт обновления с `https://vokrug-sveta.shar-os.ru/updates` (`latest.yml`, provider `generic`);
- проверка идёт только в собранной версии (`app.isPackaged`), в dev обновлений нет;
- скачанное обновление ждёт явного действия человека (перезапуск с установкой), само посреди работы не ставится;
- установщик — NSIS web: маленький `Shar setup-<версия>.exe` скачивает пакет `shar-os-client-<версия>-x64.nsis.7z`;
- интерфейс встроен в установщик (`resources/web`): правки фронта доходят до Shar OS только с новой версией.
