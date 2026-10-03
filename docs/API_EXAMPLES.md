# API Examples - Вокруг света

Примеры использования REST API для различных сценариев.

## 🔐 Аутентификация

### Вход в систему

```http
POST http://localhost:8000/api/auth/login
Content-Type: application/json

{
  "username": "admin",
  "password": "admin"
}
```

**Ответ (200 OK):**
```json
{
  "status": "success",
  "user": {
    "username": "admin",
    "role": "admin"
  }
}
```

**Ошибка (401 Unauthorized):**
```json
{
  "detail": "Invalid credentials"
}
```

## 📊 Настройки

### Получить настройки

```http
GET http://localhost:8000/api/settings
```

**Ответ:**
```json
{
  "siteName": "Вокруг света",
  "siteUrl": "https://vs-travel.ru",
  "defaultCurrency": "RUB",
  "metricaCounterId": "488267",
  "metricaToken": "y0_...",
  "wordstatToken": "y0_...",
  "deepseekApiKey": "sk-...",
  "telegramBotToken": "",
  "telegramChatId": "",
  "telegramNotifications": false
}
```

### Обновить настройки

```http
PUT http://localhost:8000/api/settings
Content-Type: application/json

{
  "siteName": "Новое название",
  "metricaCounterId": "123456"
}
```

## 📁 Источники данных

### Получить все источники

```http
GET http://localhost:8000/api/data-sources
```

**Ответ:**
```json
[
  {
    "id": "src_1763126353.693369",
    "name": "Однодневные автобусные",
    "url": "https://vs-travel.ru/podbor-tura/?TopFilter_vidTura=bus&TopFilter_dlitelnost=1-1",
    "type": "html",
    "enabled": true,
    "autoSync": true,
    "syncInterval": 86400,
    "lastSync": "2025-11-16T09:54:51.029374",
    "isParsing": false,
    "lastSyncStatus": "success",
    "itemsCount": 94
  }
]
```

### Создать источник

```http
POST http://localhost:8000/api/data-sources
Content-Type: application/json

{
  "name": "Экскурсионные туры",
  "url": "https://vs-travel.ru/podbor-tura/?TopFilter_vidTura=walking",
  "type": "html",
  "enabled": true,
  "autoSync": true,
  "syncInterval": 86400
}
```

### Запустить парсинг

```http
POST http://localhost:8000/api/data-sources/src_1763126353.693369/parse
```

**Ответ:**
```json
{
  "message": "Парсинг запущен",
  "sourceId": "src_1763126353.693369"
}
```

### Остановить парсинг

```http
POST http://localhost:8000/api/data-sources/src_1763126353.693369/stop-parse
```

## 🛍️ Товары (Туры)

### Получить все товары

```http
GET http://localhost:8000/api/products
```

**С фильтрацией по источнику:**
```http
GET http://localhost:8000/api/products?source_id=src_1763126353.693369
```

**Ответ:**
```json
[
  {
    "id": "tour_001093",
    "name": "Возрождённые святыни Истринского края",
    "days": "1",
    "route": "Княжье Озеро – Дарна – Павловская слобода",
    "image": "https://vs-travel.ru/tourimages/...",
    "price": "3670",
    "model": "Возрождённые святыни Истринского края",
    "url": "https://vs-travel.ru/tour?id=1093",
    "sourceId": "src_1763126353.693369",
    "active": true,
    "isNew": false,
    "hidden": false
  }
]
```

### Получить один товар

```http
GET http://localhost:8000/api/products/tour_001093
```

### Обновить товар

```http
PUT http://localhost:8000/api/products/tour_001093
Content-Type: application/json

{
  "active": false,
  "price": "4000"
}
```

## 📝 Фиды

### Получить все фиды

```http
GET http://localhost:8000/api/feeds
```

**Ответ:**
```json
[
  {
    "id": "feed_001",
    "name": "Тестовый фид",
    "sourceId": "source_001",
    "format": "xml",
    "settings": {
      "autoUpdate": true,
      "requireAuth": false
    },
    "isProduction": true,
    "lastUpdate": "2025-11-15T23:54:39.922494"
  }
]
```

### Создать фид

```http
POST http://localhost:8000/api/feeds
Content-Type: application/json

{
  "name": "Новый фид",
  "sourceId": "src_1763126353.693369",
  "format": "xml",
  "settings": {
    "autoUpdate": true,
    "requireAuth": false,
    "username": "",
    "password": ""
  }
}
```

### Получить XML фида

```http
GET http://localhost:8000/api/feeds/feed_001/xml
```

**Ответ (XML):**
```xml
<?xml version="1.0" encoding="UTF-8"?>
<yml_catalog date="2025-11-16 12:00">
  <shop>
    <name>Вокруг света</name>
    <company>VS Travel</company>
    <url>https://vs-travel.ru</url>
    <currencies>
      <currency id="RUB" rate="1"/>
    </currencies>
    <categories>
      <category id="1">Туры</category>
    </categories>
    <offers>
      <offer id="tour_001093" available="true">
        <url>https://vs-travel.ru/tour?id=1093</url>
        <price>3670</price>
        <currencyId>RUB</currencyId>
        <categoryId>1</categoryId>
        <picture>https://vs-travel.ru/tourimages/...</picture>
        <name>Возрождённые святыни Истринского края</name>
        <description>Княжье Озеро – Дарна...</description>
      </offer>
    </offers>
  </shop>
</yml_catalog>
```

### Обновить фид

```http
PUT http://localhost:8000/api/feeds/feed_001
Content-Type: application/json

{
  "name": "Обновленное название",
  "isProduction": true
}
```

### Удалить фид

```http
DELETE http://localhost:8000/api/feeds/feed_001
```

## 📋 Шаблоны

### Получить все шаблоны

```http
GET http://localhost:8000/api/templates
```

**С фильтрацией:**
```http
GET http://localhost:8000/api/templates?type=utm
```

**Ответ:**
```json
[
  {
    "id": "tpl_001",
    "name": "UTM метки для Яндекс.Директ",
    "type": "utm",
    "content": "utm_source=yandex&utm_medium=cpc&utm_campaign={campaign_id}"
  }
]
```

### Создать шаблон

```http
POST http://localhost:8000/api/templates
Content-Type: application/json

{
  "name": "Новый шаблон UTM",
  "type": "utm",
  "content": "utm_source=google&utm_medium=cpc"
}
```

## 📦 Коллекции (Каталоги)

### Получить все коллекции

```http
GET http://localhost:8000/api/collections
```

**Ответ:**
```json
[
  {
    "id": "collection_001",
    "name": "Популярные туры",
    "description": "Самые популярные направления",
    "productIds": ["tour_001093", "tour_001100"],
    "createdAt": "2025-11-15T21:47:53.784378"
  }
]
```

### Создать коллекцию

```http
POST http://localhost:8000/api/collections
Content-Type: application/json

{
  "name": "Зимние туры",
  "description": "Туры на зимний сезон",
  "productIds": []
}
```

## 📊 Логи

### Получить логи

```http
GET http://localhost:8000/api/logs
```

**С лимитом:**
```http
GET http://localhost:8000/api/logs?limit=50
```

**Ответ:**
```json
[
  {
    "id": "log_1763279140063",
    "type": "settings",
    "message": "Обновлены глобальные настройки ENV",
    "status": "success",
    "timestamp": "2025-11-16T07:45:40.063Z"
  },
  {
    "id": "log_1763276091078",
    "type": "parser",
    "message": "Парсинг источника 'Однодневные автобусные' завершен",
    "details": "Получено товаров: 94",
    "status": "success",
    "sourceId": "src_1763126353.693369",
    "timestamp": "2025-11-16T09:54:51.078376"
  }
]
```

## 🔍 Продвинутые примеры

### Полный цикл создания фида

```javascript
// 1. Создать источник данных
const sourceResponse = await fetch('http://localhost:8000/api/data-sources', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'Автобусные туры',
    url: 'https://vs-travel.ru/podbor-tura/?TopFilter_vidTura=bus',
    type: 'html',
    enabled: true
  })
});
const source = await sourceResponse.json();

// 2. Запустить парсинг
await fetch(`http://localhost:8000/api/data-sources/${source.id}/parse`, {
  method: 'POST'
});

// 3. Подождать завершения (проверка статуса)
let parsing = true;
while (parsing) {
  const statusResponse = await fetch(`http://localhost:8000/api/data-sources/${source.id}`);
  const status = await statusResponse.json();
  parsing = status.isParsing;
  await new Promise(resolve => setTimeout(resolve, 2000));
}

// 4. Создать фид
const feedResponse = await fetch('http://localhost:8000/api/feeds', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'Фид автобусных туров',
    sourceId: source.id,
    format: 'xml'
  })
});
const feed = await feedResponse.json();

// 5. Получить XML
const xmlResponse = await fetch(`http://localhost:8000/api/feeds/${feed.id}/xml`);
const xml = await xmlResponse.text();
console.log(xml);
```

### Массовое обновление товаров

```javascript
// Получить все товары источника
const productsResponse = await fetch(
  'http://localhost:8000/api/data-sources/src_123/products'
);
const products = await productsResponse.json();

// Деактивировать все товары дороже 5000
for (const product of products) {
  if (parseInt(product.price) > 5000) {
    await fetch(`http://localhost:8000/api/products/${product.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: false })
    });
  }
}
```

## 🧪 Тестирование API через curl

### Windows PowerShell

```powershell
# Логин
$body = @{
    username = "admin"
    password = "admin"
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://localhost:8000/api/auth/login" `
  -Method Post `
  -ContentType "application/json" `
  -Body $body

# Получить настройки
Invoke-RestMethod -Uri "http://localhost:8000/api/settings"

# Создать источник
$source = @{
    name = "Test Source"
    url = "https://example.com"
    type = "html"
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://localhost:8000/api/data-sources" `
  -Method Post `
  -ContentType "application/json" `
  -Body $source
```

### Linux / macOS (curl)

```bash
# Логин
curl -X POST http://localhost:8000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin"}'

# Получить настройки
curl http://localhost:8000/api/settings

# Создать источник
curl -X POST http://localhost:8000/api/data-sources \
  -H "Content-Type: application/json" \
  -d '{"name":"Test","url":"https://example.com","type":"html"}'
```

## 📝 Коды ответов

- `200 OK` - Успешный запрос
- `201 Created` - Ресурс создан
- `400 Bad Request` - Некорректные данные
- `401 Unauthorized` - Требуется аутентификация
- `404 Not Found` - Ресурс не найден
- `500 Internal Server Error` - Ошибка сервера

## 🔗 Полезные ссылки

- API Docs (Swagger): http://localhost:8000/docs
- OpenAPI Schema: http://localhost:8000/openapi.json
- Frontend: http://localhost:3000

---

**Больше примеров?** Откройте Swagger UI: http://localhost:8000/docs
