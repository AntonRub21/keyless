# CaseRush CS2 for Telegram App Center (TON-only)

## Что теперь реализовано
- Telegram Mini App для App Center (frontend в `www/` + backend API).
- Оплата и пополнение только через TON blockchain (TON Connect SDK).
- Интеграция Telegram Mini Apps Analytics SDK на клиенте.
- Серверная логика открытия кейсов и хранения инвентаря.
- Вывод скинов через Steam bot (`steam-user` + `steam-tradeoffer-manager`).
- Полноценная админ-панель `/admin.html`:
  - обзор пользователей/депозитов/выводов,
  - ручное начисление TON-баланса,
  - CRUD кейсов (создание/редактирование/удаление),
  - редактирование пула дропа и цены кейса.

## База данных
Используется SQLite (`backend/caserush.sqlite`) через встроенный модуль Node `node:sqlite`.
Сервер автоматически создаёт таблицы и сидит базовые кейсы при первом запуске.

## Структура
- `www/index.html`, `www/app.js` — клиент Mini App.
- `www/admin.html`, `www/admin.js` — админ-панель.
- `www/tonconnect-manifest.json` — манифест TON Connect.
- `backend/server.js` — API, Steam-интеграция, инициализация БД.

## Быстрый запуск
```bash
cp backend/.env.example backend/.env
npm --prefix backend install
npm --prefix backend start
```
Откройте `http://localhost:3000`.

## Настройка под Telegram App Center
1. Разверните приложение на HTTPS-домене.
2. Укажите публичный URL в настройках Mini App.
3. Обновите `www/tonconnect-manifest.json` (url/icon/terms/privacy).
4. Укажите `APP_TREASURY_WALLET` и `ADMIN_TOKEN` в `.env`.

## Если `npm install` не проходит
В некоторых закрытых окружениях npm registry может быть заблокирован (ошибка `E403`).
В таком случае:
1. Разрешите доступ к `https://registry.npmjs.org` или настройте внутренний npm mirror.
2. Либо выполните установку зависимостей в CI/CD с доступом в интернет и задеплойте артефакт.

## Важно для production
- Подтверждение TON-депозитов (`/api/topup/confirm`) сейчас сделано на доверии к клиентскому tx-результату.
  Для production обязательно добавить независимую on-chain верификацию через TON API/индексер.
- Добавьте резервное копирование БД, миграции и аудит-логи.
- Добавьте rate-limits, device fingerprinting и антифрод.
