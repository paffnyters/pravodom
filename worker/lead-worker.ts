/**
 * ============================================================
 *  Праводом.рф — Worker приёма заявок с сайта
 * ============================================================
 *
 * Назначение:
 *   Принимает POST-запросы с формы заявки на сайте,
 *   проверяет Cloudflare Turnstile, honeypot и rate-limit,
 *   создаёт запись в Supabase таблице crm_cases
 *   (воронка «Клиенты», первая стадия).
 *
 * Endpoint:
 *   POST /api/lead
 *   Content-Type: application/json
 *
 * Payload (от браузера):
 *   {
 *     name: string,             // обязателен
 *     phone: string,            // обязателен
 *     email: string,            // опционален
 *     service_type: string,     // 'dolgi' | 'zalyv' | 'dtp' | 'zhilishchnye-spory' | 'other'
 *     comment: string,          // опционален
 *     consent: boolean,         // обязателен
 *     source: string,           // 'site_main' | 'site_zalyv' | ... (метка страницы)
 *     sourcePage: string,       // дублирует source
 *     pageUrl: string,          // URL страницы, с которой пришла заявка
 *     submittedAt: string,      // ISO timestamp
 *     website: string,          // HONEYPOT (если заполнен — заявка молча отбрасывается)
 *     turnstileToken: string,   // токен Cloudflare Turnstile
 *     caseTitle: string         // подсказка для заголовка дела
 *   }
 *
 * Ответ:
 *   200 OK { ok: true, case_id: "..." }        — заявка создана
 *   200 OK { ok: false, error: "..." }         — заявка отклонена (см. error)
 *   400/429/500 — для нетипичных ошибок
 *
 * Защита:
 *   1. CORS — только для доменов праводом.рф (см. ALLOWED_ORIGINS)
 *   2. Honeypot — поле website должно быть пустым
 *   3. Cloudflare Turnstile — токен проверяется через siteverify
 *   4. Rate limit — 3 заявки/час с одного IP (через Cloudflare KV)
 *   5. Валидация полей — имя, телефон, service_type обязательны
 *   6. Service role key Supabase хранится в Worker Secret, не в коде
 *
 * Переменные окружения (создаются в Cloudflare → Worker → Settings → Variables):
 *   - SUPABASE_URL                  — URL проекта Supabase (см. код CRM)
 *   - SUPABASE_SERVICE_ROLE_KEY     — service role key (sb_service_role_...)
 *   - TURNSTILE_SECRET_KEY         — секрет Cloudflare Turnstile
 *   - ALLOWED_ORIGINS               — список разрешённых доменов через запятую
 *   - CRM_OWNER_USER_ID             — ID пользователя CRM, к которому привязать заявку
 *                                     (берётся из Supabase auth.users)
 *
 * KV namespace (опционально, для rate limit):
 *   - Создать в Cloudflare → Workers → KV → Namespaces
 *   - Привязать к этому Worker-у как LEAD_KV
 *
 * Деплой:
 *   1. В Cloudflare dashboard → Workers & Pages → Create → Worker
 *   2. Скопировать этот код в редактор
 *   3. В Settings → Variables добавить секреты и переменные (см. выше)
 *   4. (Опционально) Привязать KV namespace
 *   5. Если Worker на поддомене (например, api.праводом.рф) — настроить Route
 *      или просто использовать URL https://[worker-name].[account].workers.dev
 *   6. В main.js на сайте заменить FORM_CONFIG.endpoint на полный URL Worker
 *
 * Альтернатива: Cloudflare Pages Functions
 *   Можно положить этот файл в /functions/api/lead.js в репозитории GitHub Pages
 *   проекта (если аккаунт подключён к Cloudflare Pages). Тогда endpoint будет
 *   /api/lead на основном домене.
 * ============================================================ */

const ALLOWED_ORIGINS = [
  "https://xn--80aeg6aibci.xn--p1ai",        // punycode праводом.рф
  "https://праводом.рф",                       // кириллица
  "http://localhost:8080",                    // локальная разработка
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
};

function json(body, status = 200, origin = "") {
  const headers = { ...CORS_HEADERS };
  headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return new Response(JSON.stringify(body), { status, headers });
}

function errMessage(e) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Проверка Cloudflare Turnstile токена.
 * Делает POST на https://challenges.cloudflare.com/turnstile/v0/siteverify
 */
async function verifyTurnstile(token, ip, secret) {
  if (!secret) {
    // Если секрет не настроен — пропускаем проверку (только для dev)
    console.warn("[lead-worker] TURNSTILE_SECRET_KEY не задан — пропускаем проверку");
    return { success: true, skipped: true };
  }
  if (!token) {
    return { success: false, error: "Отсутствует токен Turnstile" };
  }
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    return { success: false, error: `Turnstile HTTP ${res.status}` };
  }
  const data = await res.json();
  return { success: !!data.success, error: data["error-codes"]?.join(", ") || null };
}

/**
 * Rate limit по IP: максимум N заявок в час.
 * Использует Cloudflare KV (если LEAD_KV привязан к Worker).
 * Если KV нет — пропускает (no-op).
 */
async function checkRateLimit(ip, env) {
  if (!env.LEAD_KV) return { ok: true, reason: "kv-not-bound" };
  const MAX_PER_HOUR = 3;
  const WINDOW_SEC = 3600;
  const key = `rl:${ip}`;
  const now = Math.floor(Date.now() / 1000);
  const raw = await env.LEAD_KV.get(key, "json");
  let count = 0;
  let firstTs = 0;
  if (raw && typeof raw === "object") {
    count = raw.count || 0;
    firstTs = raw.firstTs || 0;
  }
  // Если окно истекло — сбрасываем
  if (firstTs && now - firstTs > WINDOW_SEC) {
    count = 0;
    firstTs = now;
  }
  if (!firstTs) firstTs = now;
  count += 1;
  if (count > MAX_PER_HOUR) {
    return { ok: false, reason: "rate-limit", count, firstTs };
  }
  await env.LEAD_KV.put(key, JSON.stringify({ count, firstTs }), { expirationTtl: WINDOW_SEC });
  return { ok: true, count, firstTs };
}

/**
 * Найти воронку «Клиенты» и её первую стадию.
 * Приоритеты:
 *   1) Если задан env.CLIENTS_FIRST_STAGE_ID — используем его напрямую
 *      (нужно ещё узнать pipeline_id по этому stage_id).
 *   2) Иначе если задан env.CLIENTS_PIPELINE_ID — берём его + первую активную стадию.
 *   3) Иначе ищем воронку по имени «Клиенты» (ilike '%Клиент%') + первую стадию.
 *
 * Возвращает { pipeline_id, stage_id }.
 */
async function findClientsPipeline(env) {
  const sbUrl = env.SUPABASE_URL;
  const sbKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) throw new Error("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY не заданы");

  // 1. Если задан явный ID стадии — используем его напрямую
  if (env.CLIENTS_FIRST_STAGE_ID) {
    // Получим pipeline_id по stage_id
    const stageRes = await fetch(
      `${sbUrl}/rest/v1/crm_pipeline_stages?id=eq.${env.CLIENTS_FIRST_STAGE_ID}&limit=1`,
      { headers: sbHeaders(sbKey) }
    );
    if (!stageRes.ok) throw new Error(`Stage fetch error ${stageRes.status}`);
    const stages = await stageRes.json();
    if (!stages.length) {
      throw new Error(`Стадия с id ${env.CLIENTS_FIRST_STAGE_ID} не найдена в crm_pipeline_stages`);
    }
    const stage = stages[0];
    if (!stage.pipeline_id) throw new Error("У стадии нет pipeline_id");
    return { pipeline_id: stage.pipeline_id, stage_id: stage.id };
  }

  // 2. Если задан явный ID воронки — используем его + первую активную стадию
  if (env.CLIENTS_PIPELINE_ID) {
    const stageRes = await fetch(
      `${sbUrl}/rest/v1/crm_pipeline_stages?pipeline_id=eq.${env.CLIENTS_PIPELINE_ID}&active=eq.true&order=sort_order&limit=1`,
      { headers: sbHeaders(sbKey) }
    );
    if (!stageRes.ok) throw new Error(`Stage fetch error ${stageRes.status}`);
    const stages = await stageRes.json();
    if (!stages.length) throw new Error("В воронке CLIENTS_PIPELINE_ID нет активных стадий");
    return { pipeline_id: env.CLIENTS_PIPELINE_ID, stage_id: stages[0].id };
  }

  // 3. Иначе ищем воронку по имени «Клиенты» (case-insensitive, содержит «Клиент»)
  const pipeRes = await fetch(
    `${sbUrl}/rest/v1/crm_pipelines?name=ilike.%25%D0%9A%D0%BB%D0%B8%D0%B5%D0%BD%D1%82%25&active=eq.true&limit=1`,
    { headers: sbHeaders(sbKey) }
  );
  if (!pipeRes.ok) throw new Error(`Pipeline fetch error ${pipeRes.status}: ${await pipeRes.text()}`);
  const pipes = await pipeRes.json();
  if (!pipes.length) {
    throw new Error("Воронка «Клиенты» не найдена. Создайте её в CRM или задайте CLIENTS_PIPELINE_ID/CLIENTS_FIRST_STAGE_ID.");
  }
  const pipeline = pipes[0];

  // 4. Найти первую стадию этой воронки
  const stageRes = await fetch(
    `${sbUrl}/rest/v1/crm_pipeline_stages?pipeline_id=eq.${pipeline.id}&active=eq.true&order=sort_order&limit=1`,
    { headers: sbHeaders(sbKey) }
  );
  if (!stageRes.ok) throw new Error(`Stage fetch error ${stageRes.status}`);
  const stages = await stageRes.json();
  if (!stages.length) throw new Error(`В воронке «${pipeline.name}» нет активных стадий. Создайте хотя бы одну.`);
  return { pipeline_id: pipeline.id, stage_id: stages[0].id };
}

function sbHeaders(sbKey) {
  return {
    "apikey": sbKey,
    "Authorization": `Bearer ${sbKey}`,
    "Content-Type": "application/json",
    "Prefer": "return=representation",
  };
}

/**
 * Создать запись в crm_cases.
 */
async function createCase(env, payload, pipeline, ip) {
  const sbUrl = env.SUPABASE_URL;
  const sbKey = env.SUPABASE_SERVICE_ROLE_KEY;

  // source — берем из источника на сайте (site_main, site_zalyv, ...) или 'not_set'
  const source = payload.source || payload.sourcePage || "not_set";

  // Собираем заметку: комментарий клиента + URL + IP + время
  const notes = [
    payload.comment ? `Комментарий клиента: ${payload.comment}` : "",
    `Страница: ${payload.pageUrl || "—"}`,
    `IP: ${ip || "—"}`,
    `Время: ${payload.submittedAt || new Date().toISOString()}`,
    payload.email ? `Email: ${payload.email}` : "",
  ].filter(Boolean).join("\n");

  // title для карточки в CRM
  const title = payload.caseTitle || `${payload.name} — заявка с сайта`;

  const body = {
    title,
    legal_pipeline_id: pipeline.pipeline_id,
    legal_stage_id: pipeline.stage_id,
    organization_id: null,        // новая заявка без организации
    source,                       // 'site_main', 'site_zalyv', ...
    notes,
    owner_id: env.CRM_OWNER_USER_ID || null,
    // Если в таблице есть эти поля — запишем. Если нет — Supabase проигнорирует
    // (но лучше проверить структуру БД)
  };

  const res = await fetch(`${sbUrl}/rest/v1/crm_cases`, {
    method: "POST",
    headers: sbHeaders(sbKey),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase insert error ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data[0] || { id: null };
}

// Главная функция Worker
export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const ip = request.headers.get("CF-Connecting-IP") ||
               request.headers.get("X-Real-IP") ||
               request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
               "";

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response("ok", { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== "POST") {
      return json({ ok: false, error: "Только POST." }, 405, origin);
    }

    try {
      const payload = await request.json();

      // 1. Honeypot: если поле website заполнено — это бот, молча «принимаем»
      if (payload.website && String(payload.website).trim() !== "") {
        console.warn("[lead-worker] Honeypot заполнен — заявка отклонена");
        return json({ ok: true, case_id: null, silent_drop: true }, 200, origin);
      }

      // 2. Валидация обязательных полей
      if (!payload.name || String(payload.name).trim().length < 2) {
        return json({ ok: false, error: "Укажите имя (минимум 2 символа)" }, 200, origin);
      }
      const phoneDigits = String(payload.phone || "").replace(/\D/g, "");
      if (phoneDigits.length < 11) {
        return json({ ok: false, error: "Укажите корректный номер телефона" }, 200, origin);
      }
      if (!payload.service_type) {
        return json({ ok: false, error: "Выберите вид услуги" }, 200, origin);
      }
      if (!payload.consent) {
        return json({ ok: false, error: "Нет согласия на обработку персональных данных" }, 200, origin);
      }

      // 3. Проверка Turnstile
      const tsResult = await verifyTurnstile(payload.turnstileToken, ip, env.TURNSTILE_SECRET_KEY);
      if (!tsResult.success) {
        return json({ ok: false, error: `Проверка Turnstile не пройдена: ${tsResult.error || ""}` }, 200, origin);
      }

      // 4. Rate limit
      const rl = await checkRateLimit(ip, env);
      if (!rl.ok) {
        return json({ ok: false, error: "Слишком много заявок. Попробуйте позже." }, 200, origin);
      }

      // 5. Найти воронку «Клиенты» и первую стадию
      const pipeline = await findClientsPipeline(env);

      // 6. Создать case в Supabase
      const newCase = await createCase(env, payload, pipeline, ip);

      return json({ ok: true, case_id: newCase.id || null }, 200, origin);

    } catch (e) {
      console.error("[lead-worker] Error:", e);
      return json({ ok: false, error: errMessage(e) }, 200, origin);
    }
  },
};
