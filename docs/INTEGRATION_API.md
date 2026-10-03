# Shar — интеграционный API уведомлений

Документ для разработчика внешней системы (менеджерской программы). Описыварка связи","userIds":["ТВОЙ_ЛОГИН"],"documentId":"0001","actionUrl":"httет,
как отправить уведомление сотрудникам Shar в раздел «Колокольчик» и как
получить справочники сотрудников и отделов.

- **Базовый адрес:** `https://vokrug-sveta.shar-os.ru`
- **Формат:** JSON, `Content-Type: application/json`, кодировка UTF-8
- **Авторизация:** заголовок `X-Shar-Api-Key: <ключ>` в каждом запросе

Ключ выдаёт администратор Shar. Он относится к системе целиком, а не к
конкретному сотруднику, поэтому его нельзя класть в клиентское приложение,
которое попадает к пользователю, — только в серверную часть менеджерки.

Ответы на ошибки авторизации: `401` — ключ неверный или не передан, `503` —
ключ не настроен на стороне Shar (нужно обратиться к администратору).

---

## 1. Отправка уведомления

```
POST /api/integrations/notifications
```

Кладёт уведомление в «Колокольчик» каждому получателю. Сотрудник видит его
мгновенно — и в вебе, и в десктопном приложении.

### Параметры тела

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `text` | string | да | Текст уведомления. HTML вырезается. |
| `userIds` | string[] | да\* | Кому отправить. Принимает **id, логин или e-mail** — что удобнее. |
| `departmentIds` | string[] | да\* | Отделы целиком. Разворачивается в сотрудников отдела **вместе с его подразделами**. |
| `title` | string | нет | Короткий заголовок. |
| `documentId` | string | нет | Номер/идентификатор ведомости или заказа. |
| `documentType` | string | нет | Тип документа, например `vedomost` или `order`. |
| `actionUrl` | string | нет | Ссылка для кнопки перехода. Допустимы и `https://…`, и своя схема вида `manager://order/123`. |
| `actionLabel` | string | нет | Надпись на кнопке. По умолчанию «Открыть в менеджерке». |
| `fromName` | string | нет | От кого уведомление. По умолчанию «Менеджерка». |
| `sentAt` | string | нет | Время события в ISO 8601. По умолчанию — момент запроса. Передавайте своё, если документ создан раньше, чем ушёл запрос. |
| `notificationType` | string | нет | Метка типа, по умолчанию `info`. |

\* Нужно указать `userIds`, `departmentIds` или оба сразу. Получатели
объединяются и дедуплицируются; отключённые сотрудники отбрасываются.

### Пример запроса

```bash
curl -X POST https://vokrug-sveta.shar-os.ru/api/integrations/notifications \
  -H "X-Shar-Api-Key: $SHAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Ведомость №4471 готова к проверке. Срок — до 18:00.",
    "title": "Ведомость готова",
    "userIds": ["iakovleva", "user_1770029214.185058"],
    "departmentIds": ["бухгалтерия"],
    "documentId": "4471",
    "documentType": "vedomost",
    "actionUrl": "manager://vedomost/4471",
    "actionLabel": "Открыть ведомость",
    "fromName": "Иванова А.",
    "sentAt": "2026-08-04T12:30:00+03:00"
  }'
```

### Ответ

```json
{
  "status": "ok",
  "deliveredCount": 3,
  "delivered": [
    { "userId": "user_001", "messageId": "6f1c…" },
    { "userId": "user_014", "messageId": "b204…" },
    { "userId": "user_022", "messageId": "9ae7…" }
  ],
  "failed": [],
  "unknownRecipients": [],
  "sentAt": "2026-08-04T12:30:00+03:00"
}
```

- `status` — `ok`, если доставлено всем, `partial`, если часть не прошла.
- `unknownRecipients` — ссылки из `userIds`, которым не нашлось сотрудника.
  Это **не** ошибка запроса: остальным уведомление уйдёт. Стоит логировать.
- `failed` — получатели, которым доставка сорвалась, с причиной.

### Коды ошибок

| Код | Причина |
|---|---|
| `400` | Пустой `text`, либо не переданы ни `userIds`, ни `departmentIds`. |
| `401` | Неверный или отсутствующий `X-Shar-Api-Key`. |
| `404` | Ни один получатель не разрешился в активного сотрудника. |
| `503` | На стороне Shar не настроен ключ интеграции. |

---

## 2. Справочник сотрудников

```
GET /api/integrations/users
```

Необязательный параметр `?includeDisabled=true` — вернуть и отключённых.

```json
{
  "count": 42,
  "users": [
    {
      "id": "user_1769519484.436588",
      "username": "iakovleva",
      "name": "Ольга Яковлева",
      "email": "iakovleva@vs-travel.ru",
      "position": "Контент менеджер",
      "departmentId": "отдел_маркетинга",
      "departmentIds": ["отдел_маркетинга"],
      "isDisabled": false
    }
  ]
}
```

`departmentIds` — все отделы и подразделы сотрудника: в Shar человек может
состоять сразу в нескольких. `departmentId` — устаревшее поле для одного
отдела, оставлено для совместимости; ориентируйтесь на `departmentIds`.

---

## 3. Отделы и подразделы

```
GET /api/integrations/departments
```

```json
{
  "count": 9,
  "departments": [
    {
      "id": "dept_it",
      "name": "Отдел разработки",
      "parentId": null,
      "childDepartmentIds": ["dept_it_backend", "dept_it_qa"],
      "userIds": ["user_003"],
      "allUserIds": ["user_003", "user_001", "user_017"]
    },
    {
      "id": "dept_it_backend",
      "name": "Бэкенд",
      "parentId": "dept_it",
      "childDepartmentIds": [],
      "userIds": ["user_001"],
      "allUserIds": ["user_001"]
    }
  ]
}
```

- `parentId` = `null` — отдел верхнего уровня; иначе это подраздел.
- `userIds` — назначенные именно в этот отдел/подраздел.
- `allUserIds` — вместе с сотрудниками подразделов. Именно этот состав получит
  уведомление, если передать `departmentIds: ["dept_it"]`.

---

## Как это выглядит у сотрудника

В чате «Уведомления» появляется сообщение с текстом, отправителем (`fromName`)
и — если передан `actionUrl` — кнопкой с надписью из `actionLabel`. Нажатие
открывает ссылку: `https://…` — в браузере, собственную схему
(`manager://…`) — в менеджерке, если она зарегистрирована в системе.

## Быстрая проверка руками

Подставьте ключ и выполните по порядку. Первый запрос должен вернуть `401` —
это подтверждает, что защита работает.

```bash
KEY=<ключ>
BASE=https://vokrug-sveta.shar-os.ru

# 1. Без ключа — ожидаем 401
curl -s -o /dev/null -w "%{http_code}\n" $BASE/api/integrations/users

# 2. Список сотрудников — ожидаем 200 и JSON
curl -s -H "X-Shar-Api-Key: $KEY" $BASE/api/integrations/users

# 3. Отделы с составом
curl -s -H "X-Shar-Api-Key: $KEY" $BASE/api/integrations/departments

# 4. Тестовое уведомление самому себе (подставьте свой логин)
curl -s -X POST $BASE/api/integrations/notifications \
  -H "X-Shar-Api-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Тестовое уведомление из менеджерки",
    "title": "Проверка связи",
    "userIds": ["<ваш логин>"],
    "documentId": "0001",
    "actionUrl": "https://vokrug-sveta.shar-os.ru/",
    "actionLabel": "Открыть в менеджерке",
    "fromName": "Интеграция"
  }'
```

После четвёртого запроса уведомление появится в «Колокольчике» у указанного
сотрудника — с кнопкой перехода.

### Windows / PowerShell

GET-запросы работают как есть, надо лишь писать `curl.exe`, а не `curl` —
последнее в PowerShell является алиасом `Invoke-WebRequest` с другим
синтаксисом.

А вот **POST с телом через `curl.exe -d $body` в Windows PowerShell 5.1
работать не будет**, и дело не в кодировке. Передавая аргументы во внешнюю
программу, PowerShell 5.1 срезает двойные кавычки, поэтому до сервера доезжает
`{text:...}` вместо `{"text":...}` и приходит ответ:

```json
{"detail":[{"type":"json_invalid","ctx":{"error":"Expecting property name enclosed in double quotes"}}]}
```

Экранирование (`$body.Replace('"','\"')`) не спасает: кавычки сохраняются, но
аргумент начинает рассыпаться по пробелам внутри JSON, и ошибка меняется на
`Unterminated string`. Это ограничение оболочки, а не API.

Рабочий способ — отправлять тем же PowerShell, без curl. Строка с JSON при этом
остаётся обычной, менять её не нужно; важно только передать тело **байтами**,
иначе кириллица приедет испорченной:

```powershell
$KEY  = "<ключ>"
$BASE = "https://vokrug-sveta.shar-os.ru"

$body = '{"text":"Тестовое уведомление из менеджерки","title":"Проверка связи","userIds":["<логин>"],"documentId":"0001","actionUrl":"https://vokrug-sveta.shar-os.ru/","actionLabel":"Открыть в менеджерке","fromName":"Интеграция"}'

Invoke-RestMethod -Method Post -Uri "$BASE/api/integrations/notifications" `
  -Headers @{ "X-Shar-Api-Key" = $KEY } `
  -ContentType "application/json; charset=utf-8" `
  -Body ([Text.Encoding]::UTF8.GetBytes($body))
```

Если curl нужен принципиально, передавайте тело файлом — тогда оболочка в него
не вмешивается:

```powershell
[IO.File]::WriteAllText("$env:TEMP\shar.json", $body, (New-Object Text.UTF8Encoding($false)))
curl.exe -s -X POST "$BASE/api/integrations/notifications" `
  -H "X-Shar-Api-Key: $KEY" -H "Content-Type: application/json" `
  --data-binary "@$env:TEMP\shar.json"
```

В PowerShell 7 и в обычном `cmd`/bash проблемы с кавычками нет — там привычный
`curl -d '...'` работает напрямую.

## Рекомендации

- Один запрос может обслужить много получателей — не отправляйте по одному
  запросу на человека.
- `sentAt` передавайте своим временем события, тогда порядок уведомлений
  совпадёт с порядком в менеджерке.
- Повторная отправка создаёт новое уведомление: защиты от дублей на стороне
  Shar нет, дедуплицируйте у себя по `documentId`.
- При `status: "partial"` не повторяйте весь запрос — повторяйте только для
  получателей из `failed`, иначе остальным придёт дубль.
