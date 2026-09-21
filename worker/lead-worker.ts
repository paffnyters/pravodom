/**
 * ============================================================
 *  Праводом.рф — Worker приёма заявок с сайта
 * ============================================================
 *
 * Endpoint: POST /lead (или любой путь — Worker смотрит только метод)
 *
 * Что делает:
 *   - Принимает заявку с сайта (имя, телефон, email, вид услуги, комментарий)
 *   - Проверяет honeypot, валидирует поля
 *   - Проверяет Cloudflare Turnstile (опционально)
 *   - Rate limit: 3 заявки/час с IP (через Cloudflare KV)
 *   - Создаёт запись в Supabase таблице crm_organizations
 *     (раздел «Клиенты» в CRM)
 *   - Воронка: entity_type='organization', первая стадия (sort_order=0)
 *
 * Переменные окружения (Cloudflare Worker → Settings → Variables):
 *   SUPABASE_URL                  — https://ncuthxvxiwghjgduchhc.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY     — sb_service_role_... (Secret!)
 *   TURNSTILE_SECRET_KEY         — Cloudflare Turnstile secret (Secret, опц.)
 *   CRM_OWNER_USER_ID            — UUID пользователя в auth.users (для owner_id)
 *   ORG_PIPELINE_ID              — UUID воронки crm_pipelines с entity_type='organization' (опц.)
 *   ORG_FIRST_STAGE_ID           — UUID первой стадии в воронке (опц., приоритетнее)
 *   LEAD_KV                      — Cloudflare KV namespace для rate limit (опц.)
 *
 * Если ORG_FIRST_STAGE_ID или ORG_PIPELINE_ID не заданы — Worker сам найдёт
 * воронку по entity_type='organization' и её первую стадию с sort_order=0.
 * ============================================================ */

const ALLOWED_ORIGINS = [
  "https://xn--80aeg6aibci.xn--p1ai",
  "https://праводом.рф",
  "https://www.xn--80aeg6aibci.xn--p1ai",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "https://paffnyters.github.io",
];

function getCorsHeaders(origin) {
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json; charset=utf-8",
  };
}

function json(body, status = 200, origin = "") {
  return new Response(JSON.stringify(body), { status, headers: getCorsHeaders(origin) });
}

function errMessage(e) {
  return e instanceof Error ? e.message : String(e);
}

function sbHeaders(sbKey) {
  return {
    "apikey": sbKey,
    "Authorization": `Bearer ${sbKey}`,
    "Content-Type": "application/json",
    "Prefer": "return=representation",
  };
}

async function verifyTurnstile(token, ip, secret) {
  if (!secret) {
    console.warn("[lead-worker] TURNSTILE_SECRET_KEY не задан — пропускаем проверку");
    return { success: true, skipped: true };
  }
  if (!token) {
    console.warn("[lead-worker] turnstileToken пустой — принимаем без проверки");
    return { success: true, skipped: true, reason: "no-token" };
  }
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
  });
  if (!res.ok) return { success: false, error: `Turnstile HTTP ${res.status}` };
  const data = await res.json();
  return { success: !!data.success, error: data["error-codes"]?.join(", ") || null };
}

async function checkRateLimit(ip, env) {
  if (!env.LEAD_KV) return { ok: true, reason: "kv-not-bound" };
  const MAX_PER_HOUR = 3;
  const WINDOW_SEC = 3600;
  const key = `rl:${ip}`;
  const now = Math.floor(Date.now() / 1000);
  const raw = await env.LEAD_KV.get(key, "json");
  let count = 0, firstTs = 0;
  if (raw && typeof raw === "object") {
    count = raw.count || 0;
    firstTs = raw.firstTs || 0;
  }
  if (firstTs && now - firstTs > WINDOW_SEC) {
    count = 0;
    firstTs = now;
  }
  if (!firstTs) firstTs = now;
  count += 1;
  if (count > MAX_PER_HOUR) return { ok: false, reason: "rate-limit", count, firstTs };
  await env.LEAD_KV.put(key, JSON.stringify({ count, firstTs }), { expirationTtl: WINDOW_SEC });
  return { ok: true, count, firstTs };
}

/**
 * Найти воронку с entity_type='organization' и её первую стадию.
 * Приоритеты:
 *   1) Если задан env.ORG_FIRST_STAGE_ID — используем его напрямую
 *      (Worker сам найдёт pipeline_id по этому stage_id).
 *   2) Иначе если задан env.ORG_PIPELINE_ID — берём его + первую активную стадию.
 *   3) Иначе ищем воронку по entity_type='organization' + первую стадию.
 */
async function findOrgPipeline(env) {
  const sbUrl = env.SUPABASE_URL;
  const sbKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) throw new Error("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY не заданы");

  // 1. Если задан явный ID стадии — используем его
  if (env.ORG_FIRST_STAGE_ID) {
    const stageRes = await fetch(
      `${sbUrl}/rest/v1/crm_pipeline_stages?id=eq.${env.ORG_FIRST_STAGE_ID}&limit=1`,
      { headers: sbHeaders(sbKey) }
    );
    if (!stageRes.ok) throw new Error(`Stage fetch error ${stageRes.status}`);
    const stages = await stageRes.json();
    if (!stages.length) {
      // Отладка: показать все стадии
      const allRes = await fetch(
        `${sbUrl}/rest/v1/crm_pipeline_stages?select=id,name,pipeline_id,sort_order,active&order=sort_order&limit=50`,
        { headers: sbHeaders(sbKey) }
      );
      let all = [];
      if (allRes.ok) all = await allRes.json();
      const list = all.map(s => `id=${s.id} | name="${s.name}" | pipeline_id=${s.pipeline_id} | sort=${s.sort_order} | active=${s.active}`).join("\n  ");
      throw new Error(
        `Стадия с id ${env.ORG_FIRST_STAGE_ID} не найдена.\n\n` +
        `Все стадии:\n  ${list || "(пусто)"}\n\n` +
        `Обнови переменную ORG_FIRST_STAGE_ID в Worker.`
      );
    }
    const stage = stages[0];
    if (!stage.pipeline_id) throw new Error("У стадии нет pipeline_id");
    return { pipeline_id: stage.pipeline_id, stage_id: stage.id };
  }

  // 2. Если задан явный ID воронки — используем его + первую стадию
  if (env.ORG_PIPELINE_ID) {
    const stageRes = await fetch(
      `${sbUrl}/rest/v1/crm_pipeline_stages?pipeline_id=eq.${env.ORG_PIPELINE_ID}&active=eq.true&order=sort_order&limit=1`,
      { headers: sbHeaders(sbKey) }
    );
    if (!stageRes.ok) throw new Error(`Stage fetch error ${stageRes.status}`);
    const stages = await stageRes.json();
    if (!stages.length) throw new Error("В воронке ORG_PIPELINE_ID нет активных стадий");
    return { pipeline_id: env.ORG_PIPELINE_ID, stage_id: stages[0].id };
  }

  // 3. Ищем воронку по entity_type='organization' (автоматически)
  const pipeRes = await fetch(
    `${sbUrl}/rest/v1/crm_pipelines?entity_type=eq.organization&active=eq.true&order=sort_order&limit=1`,
    { headers: sbHeaders(sbKey) }
  );
  if (!pipeRes.ok) throw new Error(`Pipeline fetch error ${pipeRes.status}: ${await pipeRes.text()}`);
  const pipes = await pipeRes.json();
  if (!pipes.length) {
    // Отладка: показать все воронки
    const allRes = await fetch(
      `${sbUrl}/rest/v1/crm_pipelines?select=id,name,entity_type,active&order=sort_order&limit=50`,
      { headers: sbHeaders(sbKey) }
    );
    let all = [];
    if (allRes.ok) all = await allRes.json();
    const list = all.map(p => `id=${p.id} | name="${p.name}" | entity_type=${p.entity_type} | active=${p.active}`).join("\n  ");
    throw new Error(
      `Воронка с entity_type='organization' не найдена.\n\n` +
      `Все воронки:\n  ${list || "(пусто)"}\n\n` +
      `Создай воронку организации в CRM (раздел «Клиенты») или задай ORG_PIPELINE_ID.`
    );
  }
  const pipeline = pipes[0];

  // 4. Берём первую стадию этой воронки
  const stageRes = await fetch(
    `${sbUrl}/rest/v1/crm_pipeline_stages?pipeline_id=eq.${pipeline.id}&active=eq.true&order=sort_order&limit=1`,
    { headers: sbHeaders(sbKey) }
  );
  if (!stageRes.ok) throw new Error(`Stage fetch error ${stageRes.status}`);
  const stages = await stageRes.json();
  if (!stages.length) throw new Error(`В воронке «${pipeline.name}» нет активных стадий`);
  return { pipeline_id: pipeline.id, stage_id: stages[0].id };
}

/**
 * Создать запись в crm_organizations (НЕ crm_cases!).
 * Это раздел «Клиенты» в CRM.
 */
async function createOrg(env, payload, pipeline, ip) {
  const sbUrl = env.SUPABASE_URL;
  const sbKey = env.SUPABASE_SERVICE_ROLE_KEY;

  // Source на сайте: site_main, site_zalyv, site_dtp, site_zhilishchnye_spory,
  // site_dolgi, site_privacy. CRM разрешает: mailing, dmitry_base, not_set.
  const sourcePage = payload.source || payload.sourcePage || "site_unknown";
  const crmSource = "not_set";   // проходит CHECK constraint

  // Метка вида услуги для заметки
  const serviceLabels = {
    'dolgi': 'Взыскание задолженности (для УК)',
    'zalyv': 'Залив квартиры',
    'dtp': 'Юрист после ДТП',
    'zhilishchnye-spory': 'Жилищные споры',
    'other': 'Другое / не указано',
  };
  const serviceLabel = serviceLabels[payload.service_type] || payload.service_type || '—';

  // Собираем notes: источник + вид услуги + комментарий + URL + IP + время
  const notesParts = [
    `Источник: ${sourcePage}`,
    `Вид услуги: ${serviceLabel}`,
    payload.comment ? `Комментарий клиента: ${payload.comment}` : "",
    `Страница: ${payload.pageUrl || "—"}`,
    `IP: ${ip || "—"}`,
    `Время: ${payload.submittedAt || new Date().toISOString()}`,
  ].filter(Boolean);
  const notes = notesParts.join("\n");

  // Название организации — из имени клиента + вид услуги
  const orgName = `${payload.name} — ${serviceLabel}`;

  const body = {
    name: orgName,                              // название карточки в CRM
    contact_name: payload.name || null,         // контактное лицо
    phone: payload.phone || null,
    email: payload.email || null,
    inn: null,                                  // ИНН — клиент не заполняет на сайте
    notes,
    source: crmSource,                           // 'not_set' — проходит CHECK constraint
    owner_id: env.CRM_OWNER_USER_ID || null,
    sales_pipeline_id: pipeline.pipeline_id,   // воронка организации (НЕ legal_pipeline_id!)
    sales_stage_id: pipeline.stage_id,          // первая стадия (НЕ legal_stage_id!)
    service_cost: null,                          // стоимость не указана
    service_cost_unknown: true,                 // покажет «?» в карточке
  };

  const res = await fetch(`${sbUrl}/rest/v1/crm_organizations`, {
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
      return new Response(null, { status: 204, headers: getCorsHeaders(origin) });
    }

    if (request.method !== "POST") {
      return json({ ok: false, error: "Только POST." }, 405, origin);
    }

    try {
      const payload = await request.json();

      // 1. Honeypot
      if (payload.website && String(payload.website).trim() !== "") {
        console.warn("[lead-worker] Honeypot заполнен — заявка отклонена");
        return json({ ok: true, case_id: null, silent_drop: true }, 200, origin);
      }

      // 2. Валидация
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

      // 3. Turnstile
      const tsResult = await verifyTurnstile(payload.turnstileToken, ip, env.TURNSTILE_SECRET_KEY);
      if (!tsResult.success) {
        return json({ ok: false, error: `Проверка Turnstile не пройдена: ${tsResult.error || ""}` }, 200, origin);
      }

      // 4. Rate limit
      const rl = await checkRateLimit(ip, env);
      if (!rl.ok) {
        return json({ ok: false, error: "Слишком много заявок. Попробуйте позже." }, 200, origin);
      }

      // 5. Найти воронку организации и первую стадию
      const pipeline = await findOrgPipeline(env);

      // 6. Создать запись в crm_organizations
      const newOrg = await createOrg(env, payload, pipeline, ip);

      return json({ ok: true, org_id: newOrg.id || null }, 200, origin);

    } catch (e) {
      console.error("[lead-worker] Error:", e);
      return json({ ok: false, error: errMessage(e) }, 200, origin);
    }
  },
};
