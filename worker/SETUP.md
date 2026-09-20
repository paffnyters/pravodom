# Подключение формы заявки к CRM + защита от DDoS

Этот документ описывает, как подключить форму заявки на сайте к Supabase CRM Праводом.рф и защитить сайт от спама и DDoS.

## Содержание

1. [Архитектура решения](#архитектура)
2. [Что нужно настроить — обзор](#обзор)
3. [Шаг 1: Создать Cloudflare Turnstile](#шаг-1-turnstile)
4. [Шаг 2: Получить Supabase service role key](#шаг-2-supabase)
5. [Шаг 3: Узнать ID воронки «Клиенты»](#шаг-3-pipeline)
6. [Шаг 4: Узнать ID пользователя-владельца](#шаг-4-owner)
7. [Шаг 5: Задеплоить Cloudflare Worker](#шаг-5-worker)
8. [Шаг 6: Подключить Worker к домену](#шаг-6-route)
9. [Шаг 7: Вставить sitekey Turnstile в HTML](#шаг-7-sitekey)
10. [Шаг 8: Защита всего сайта от DDoS](#шаг-8-ddos)
11. [Шаг 9: Проверка работы](#шаг-9-test)
12. [Что делать, если что-то не работает](#troubleshooting)

---

<a name="архитектура"></a>
## Архитектура решения

```
Браузер пользователя
   │
   ├── HTML форма (на всех страницах сайта)
   │   - Поля: имя, телефон, email, вид услуги, комментарий
   │   - Скрытое поле source_page (определяется автоматически по URL)
   │   - Honeypot поле website (скрытое от людей)
   │   - Cloudflare Turnstile (CAPTCHA без боли)
   │
   ↓ POST /api/lead
   │
Cloudflare Worker (lead-worker.ts)
   ├── Проверка CORS (только домены праводом.рф)
   ├── Проверка honeypot (если заполнен — тихий сброс)
   ├── Валидация полей (имя, телефон, service_type, consent)
   ├── Проверка Turnstile (через siteverify API)
   ├── Rate limit: 3 заявки/час с одного IP (через KV)
   │
   ↓ Insert в crm_cases
   │
Supabase (таблица crm_cases)
   ├── legal_pipeline_id = ID воронки «Клиенты»
   ├── legal_stage_id = ID первой стадии
   ├── source = 'site_zalyv' / 'site_dtp' / ... (метка страницы)
   ├── notes = комментарий + URL + IP + время
   ├── owner_id = ID пользователя CRM
   └── organization_id = null (новый лид)
```

---

<a name="обзор"></a>
## Что нужно настроить — обзор

| Компонент | Где | Что получить |
|-----------|-----|--------------|
| Cloudflare Turnstile | Cloudflare → Turnstile | sitekey (для HTML) + secret key (для Worker) |
| Supabase service role key | Supabase → Project Settings → API | service role key (sb_service_role_...) |
| Воронка «Клиенты» | CRM Праводом.рф → Настройки | pipeline_id |
| ID пользователя-владельца | Supabase → Auth → Users | user UUID |
| Cloudflare Worker | Cloudflare → Workers & Pages | URL Worker (например, lead.pravodom-rf.workers.dev) |
| KV namespace (опционально) | Cloudflare → Workers → KV | namespace для rate limit |

---

<a name="шаг-1-turnstile"></a>
## Шаг 1: Создать Cloudflare Turnstile

1. Зайди на https://dash.cloudflare.com → в левом меню выбери **Turnstile**
2. Нажми **Add widget**
3. Заполни:
   - **Widget name**: `Праводом.рф — форма заявки`
   - **Hostnames**: добавь `xn--80aeg6aibci.xn--p1ai` (или `праводом.рф` — Cloudflare примет оба)
   - **Widget mode**: **Managed** (рекомендуется — Cloudflare сам решает, показывать капчу или нет)
4. Нажми **Create**
5. Скопируй:
   - **Site Key** — public, вставим в HTML
   - **Secret Key** — private, вставим в Worker

---

<a name="шаг-2-supabase"></a>
## Шаг 2: Получить Supabase service role key

1. Зайди на https://supabase.com/dashboard
2. Открой проект `pravodom` (или как он называется у вас в Supabase; URL проекта — `https://ncuthxvxiwghjgduchhc.supabase.co`)
3. В левом меню: **Project Settings** (⚙️) → **API**
4. Скопируй:
   - **Project URL**: `https://ncuthxvxiwghjgduchhc.supabase.co`
   - **service_role secret** — длинный ключ, начинается с `eyJ...` (НЕ anon public, а именно service_role!)
5. **ВАЖНО**: service_role key имеет полный доступ к БД — НЕ показывай его в браузере, НЕ клади в репозиторий GitHub. Только в Worker Secrets.

---

<a name="шаг-3-pipeline"></a>
## Шаг 3: Узнать ID воронки «Клиенты»

**Вариант А — если воронка «Клиенты» уже есть в CRM:**

1. Открой CRM по адресу `https://crm.праводом.рф` (или где она у тебя размещена)
2. Зайди в раздел «Юридическая работа» (или «Настройки»)
3. Найди воронку с именем «Клиенты»
4. Worker сам найдёт её по имени — ничего вручную указывать не надо. Worker ищет воронку по `name LIKE '%Клиент%'`.

**Вариант Б — если хочешь указать ID явно:**

1. Открой Supabase Dashboard → Table Editor
2. Открой таблицу `crm_pipelines`
3. Найди воронку с именем «Клиенты» (если её нет — создай через CRM в Настройках)
4. Скопируй `id` (UUID) — будет использоваться как `CLIENTS_PIPELINE_ID`

---

<a name="шаг-4-owner"></a>
## Шаг 4: Узнать ID пользователя-владельца

Заявки должны быть привязаны к какому-то пользователю CRM (поле `owner_id` в таблице `crm_cases`). Это обычно Дмитрий Кисельман.

1. Открой Supabase Dashboard → **Authentication** → **Users**
2. Найди пользователя (по email)
3. Скопируй его **UID** (длинный UUID вида `a1b2c3d4-...`)
4. Это будет `CRM_OWNER_USER_ID` в Worker

---

<a name="шаг-5-worker"></a>
## Шаг 5: Задеплоить Cloudflare Worker

**Вариант А — через Dashboard (проще):**

1. Зайди на https://dash.cloudflare.com → **Workers & Pages**
2. Нажми **Create application** → **Create Worker**
3. Имя: `pravodom-lead` (или любое)
4. Нажми **Deploy**
5. После создания — нажми **Edit code**
6. Скопируй содержимое файла `worker/lead-worker.ts` из этого ZIP
7. Вставь в редактор (замени стандартный код)
8. Нажми **Save and deploy**

**Вариант Б — через wrangler CLI:**

```bash
# Установи wrangler
npm install -g wrangler

# Войди в Cloudflare
wrangler login

# Создай Worker
mkdir pravodom-lead && cd pravodom-lead
wrangler init

# Скопируй lead-worker.ts в src/index.ts
# Отредактируй wrangler.toml:
#   name = "pravodom-lead"
#   main = "src/index.ts"
#   compatibility_date = "2024-09-01"

# Задеплоить
wrangler deploy
```

URL Worker будет: `https://pravodom-lead.<account>.workers.dev`

---

<a name="шаг-6-route"></a>
## Шаг 6: Настроить секреты и переменные Worker

1. В Cloudflare → **Workers & Pages** → открой свой Worker `pravodom-lead`
2. Вкладка **Settings** → раздел **Variables**
3. Добавь переменные (нажми **Add**, выбери **Secret** для ключей, **Plain text** для остальных):

| Имя | Тип | Значение |
|-----|------|---------|
| `SUPABASE_URL` | Plain text | `https://ncuthxvxiwghjgduchhc.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | **Secret** | (из Шага 2) |
| `TURNSTILE_SECRET_KEY` | **Secret** | (из Шага 1) |
| `CRM_OWNER_USER_ID` | Plain text | (из Шага 4) |
| `CLIENTS_PIPELINE_ID` | Plain text | (опционально, из Шага 3) |

4. (Опционально) Привязать KV для rate limit:
   - Зайди в **Workers & Pages** → **KV** → создай namespace `pravodom-rl`
   - Вернись в Worker → **Settings** → **Bindings** → **Add binding** → выбери KV → назови `LEAD_KV` → выбери namespace `pravodom-rl`
5. Нажми **Save and deploy** ещё раз, чтобы применить переменные

---

<a name="шаг-6-route-2"></a>
## Шаг 6.1: Подключить Worker к основному домену (опционально)

Чтобы форма отправляла на `/api/lead` (а не на `https://pravodom-lead.workers.dev`), нужно либо:

**Вариант А — Cloudflare Pages (если сайт на CF Pages):**
- Положить `lead-worker.ts` в `/functions/api/lead.js` в репозитории
- Cloudflare Pages автоматически сделает endpoint доступным

**Вариант Б — Worker Route (если домен в Cloudflare):**
1. Cloudflare → **Workers & Pages** → открой Worker `pravodom-lead`
2. Вкладка **Triggers** → **Add custom domain** → `api.праводом.рф`
3. Или в Cloudflare → **DNS** → добавь CNAME:
   - Name: `api`
   - Target: `pravodom-lead.<account>.workers.dev`
   - Proxy: ON (оранжевое облако)
4. В `main.js` (на сайте) замени:
   ```js
   endpoint: '/api/lead',
   ```
   на:
   ```js
   endpoint: 'https://api.праводом.рф/lead',
   ```

---

<a name="шаг-7-sitekey"></a>
## Шаг 7: Вставить sitekey Turnstile в HTML

В HTML-файлах сайта (все 6 страниц) есть строка:

```html
<div class="cf-turnstile" data-sitekey="REPLACE_WITH_TURNSTILE_SITEKEY" data-theme="light"></div>
```

Замени `REPLACE_WITH_TURNSTILE_SITEKEY` на свой Site Key из Шага 1.

Также подключи скрипт Turnstile — добавь перед `</head>` во всех HTML:

```html
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
```

(Я могу обновить HTML автоматически, если скажешь sitekey.)

---

<a name="шаг-8-ddos"></a>
## Шаг 8: Защита всего сайта от DDoS

### 8.1. Включить Cloudflare Proxy (оранжевое облако на A-записи)

Сейчас A-записи у тебя «DNS only» (серое облако) — трафик идёт напрямую на GitHub Pages. Чтобы Cloudflare фильтровал трафик:

1. Cloudflare → **DNS** → **Records**
2. У 4 A-записей `праводом.рф` (185.199.108.153, .109, .110, .111) переключи **Proxy status** на **Proxied** (оранжевое облако)
3. У CNAME `www` → `paffnyters.github.io` тоже включи **Proxied**

⚠️ **После этого может потребоваться настройка SSL mode:**
- Cloudflare → **SSL/TLS** → **Overview**
- Установи **Full** (не Flexible!) — иначе будут циклические редиректы

### 8.2. Включить Bot Fight Mode (бесплатно)

1. Cloudflare → **Security** → **Bots**
2. Включи **Bot Fight Mode** — Cloudflare автоматически блокирует известных ботов

### 8.3. Настроить WAF (Web Application Firewall)

1. Cloudflare → **Security** → **WAF**
2. Включи **Managed rules** (бесплатно в базовом плане — Managed Ruleset)
3. Создай custom rule:
   - **Rule name**: «Block common attacks»
   - **Expression**: `(http.request.uri.path contains "/.git") or (http.request.uri.path contains "/wp-admin") or (http.request.uri.path contains "phpmyadmin")`
   - **Action**: Block

### 8.4. Rate Limiting (опционально, бесплатно до 1 правила)

1. Cloudflare → **Security** → **WAF** → **Rate limiting rules**
2. Создай правило:
   - **Rule name**: «Limit form submissions»
   - **When**: `(http.request.uri.path eq "/api/lead") and (http.request.method eq "POST")`
   - **Count**: 5 requests per 60 seconds per IP
   - **Action**: Block for 60 seconds

### 8.5. Настроить Page Rules / Cache

1. Cloudflare → **Cache** → **Configuration**
2. Установи **Browser Cache TTL**: минимум 4 часа
3. Включи **Always Use HTTPS** (Cloudflare → **SSL/TLS** → **Edge Certificates**)
4. Включи **Automatic HTTPS Rewrites**

### 8.6. Security Level (бесплатно)

1. Cloudflare → **Security** → **Settings**
2. **Security Level**: Medium (или High для нового сайта)
3. **Challenge Passage**: 30 minutes
4. **Browser Integrity Check**: ON

---

<a name="шаг-9-test"></a>
## Шаг 9: Проверка работы

1. Открой сайт `https://праводом.рф/dolgi/`
2. Нажми «Передать список должников»
3. Заполни форму (имя, телефон, выбери вид услуги, добавь комментарий)
4. Пройди Turnstile (если появится виджет)
5. Нажми «Отправить заявку»
6. Должно появиться сообщение «Заявка отправлена»
7. Зайди в CRM → раздел «Юридическая работа» → воронка «Клиенты» → первая стадия
8. Там должна появиться новая карточка с твоими данными

Если что-то не работает — смотри ниже.

---

<a name="troubleshooting"></a>
## Что делать, если что-то не работает

### Ошибка «Воронка «Клиенты» не найдена»
- Зайди в CRM → Настройки → Воронки
- Создай воронку с именем «Клиенты» (entity_type = 'case')
- Создай в ней хотя бы одну стадию (например, «Новая заявка»)
- Worker сам найдёт воронку по имени

### Ошибка «PGRST204» от Supabase (неизвестное поле)
- В таблице `crm_cases` могут отсутствовать какие-то поля (например, `legal_pipeline_id`)
- Проверь структуру таблицы в Supabase Dashboard → Table Editor → crm_cases
- Если поля отсутствуют — добавь их или скорректируй Worker

### Ошибка CORS в браузере
- Проверь, что `ALLOWED_ORIGINS` в Worker содержит `https://праводом.рф` и `https://xn--80aeg6aibci.xn--p1ai`
- Если домен другой — добавь в массив

### Заявка отправляется, но не доходит до CRM
- Открой Cloudflare → Workers & Pages → твой Worker → вкладка **Logs**
- Нажми **Begin log stream** — отправь ещё одну заявку с сайта
- Посмотри лог — там будет видно, где упало

### Turnstile не появляется
- Убедись, что в HTML подключён скрипт `https://challenges.cloudflare.com/turnstile/v0/api.js`
- Проверь, что в `data-sitekey` вставлен правильный Site Key (не Secret!)

### После включения Proxied (оранжевое облако) сайт не открывается
- Это из-за циклических редиректов
- Cloudflare → **SSL/TLS** → **Overview** → установи **Full** (не Flexible!)
- Подожди 5 минут

### Ошибка 1020 («Access denied»)
- Cloudflare блокирует твой собственный трафик
- **Security** → **WAF** → **Tools** → **IP Access Rules** → добавь свой IP с действием Allow

---

## Контакты

Если что-то не получается — присылай скриншот ошибки, помогу разобраться.
