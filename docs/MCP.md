# MCP «Офиса»

ИИ-агент (Claude, Cursor и другие клиенты MCP) работает с заметками, документами, таблицами и папками Шара от имени
человека и с его правами: видит то же, что он, правит то, что ему можно править. Правки агента — обычные правки:
коллеги видят их сразу, прежние версии остаются в истории версий.

## Подключение

1. В Шаре: **Настройки → MCP → Выпустить ключ**. Ключ показывается один раз, на сервере хранится только его SHA-256.
2. В агенте добавить сервер `https://vokrug-sveta.shar-os.ru/api/mcp` с заголовком `Authorization: Bearer <ключ>`.

Claude Code:

```bash
claude mcp add --transport http shar https://vokrug-sveta.shar-os.ru/api/mcp --header "Authorization: Bearer shar_mcp_..."
```

Cursor и `.mcp.json`:

```json
{ "mcpServers": { "shar": { "type": "http", "url": "https://vokrug-sveta.shar-os.ru/api/mcp", "headers": { "Authorization": "Bearer shar_mcp_..." } } } }
```

Отозвать ключ можно там же, в настройках. Он перестаёт работать сразу. У отключённого сотрудника ключи не работают.

## Инструменты

| Инструмент | Что делает |
| --- | --- |
| `list_items` | материалы (вид, поиск по названию и тексту, папка) |
| `list_folders` | папки с путём и числом материалов |
| `read_item` | содержимое: заметка и документ — Markdown, таблица — листы со строками ячеек, презентация — текст |
| `create_note`, `update_note` | заметка из Markdown; замена или дописывание |
| `create_document`, `update_document` | документ A4 из Markdown; дописывание с сохранением оформления или пересборка |
| `create_table` | таблица из строк ячеек (один или несколько листов) |
| `rename_item`, `move_item`, `create_folder` | название, раскладка по папкам |

Удаления и выдачи доступа у агента нет намеренно.

## Устройство

- `server/app/modules/mcp/keys.py` — ключи (`/api/mcp/keys`, по сессии) и проверка ключа;
- `server/app/modules/mcp/router.py` — `POST /api/mcp`: JSON-RPC 2.0 по Streamable HTTP (MCP 2025-06-18), ответ
  обычным JSON, без сессий (`GET` — 405). Маршрут открыт в `core/security.PUBLIC_METHODS`, личность — по ключу;
- `server/app/modules/mcp/tools.py` — инструменты. Они зовут обработчики `workspace/router.py` и `workspace/folders.py`, так что
  права, версии и живые события те же, что у интерфейса;
- `server/app/modules/mcp/docformat.py` — Markdown ↔ снимок Univer (перенос клиентского `lib/docSnapshot.ts`);
- `src/features/settings/sections/McpSection.tsx` — раздел настроек;
- ограничение: 120 вызовов в минуту на человека; таблица читается до 500 строк и 50 столбцов.

Таблица `mcp_keys` появляется на проде шагом выпуска (`deploy-server.ps1 -Schema`). До этого раздел настроек отвечает
«MCP ещё не включён на сервере».
