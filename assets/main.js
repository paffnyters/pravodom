/* ============================================================
   ПРАВОДОМ.РФ — main.js
   Ванильный JS без зависимостей.

   СОСТАВ:
   1. Конфиг формы (endpoint / CRM / CAPTCHA) — TODO-заглушки
   2. Шапка (тень при скролле) и мобильное меню
   3. Модальное окно заявки (единая форма для всех кнопок)
   4. Форма: маска телефона, валидация, honeypot,
      кнопка «Отправить заявку» активна ТОЛЬКО после галочки
   5. Отправка: демо-режим (backend не подключён) + TODO для CRM
   6. Плавное появление секций (IntersectionObserver)
   ============================================================ */
(function () {
  'use strict';

  /* ------------------------------------------------------------
   * 1. КОНФИГ ФОРМЫ
   * ------------------------------------------------------------
   * Endpoint Cloudflare Worker, который принимает заявки и пишет
   * их в Supabase (таблица crm_cases, воронка «Клиенты»).
   *
   * Worker URL: тот же домен + /api/lead (через Cloudflare Pages
   * Functions или Cloudflare Worker на отдельном поддомене).
   *
   * Защита от спама/DDoS:
   *   - Cloudflare Turnstile (CAPTCHA без боли для пользователя)
   *   - Honeypot поле website (скрытое)
   *   - Server-side rate limit (см. Worker)
   *   - Cloudflare Bot Fight Mode + WAF на уровне всего сайта
   *
   * Чтобы включить:
   *   1. Задеплоить Worker (см. /worker/lead-worker.ts в ZIP)
   *   2. В Cloudflare создать Turnstile widget — sitekey вставить
   *      в HTML (data-sitekey) и в Worker secrets (TURNSTILE_SECRET)
   *   3. В Supabase создать service role key и сохранить в Worker
   *      secrets как SUPABASE_SERVICE_ROLE_KEY
   * ---------------------------------------------------------- */
  var FORM_CONFIG = {
    endpoint: 'https://pravodom-lead.paffnyters.workers.dev/lead',  // Cloudflare Worker
    turnstileSiteKey: '',           // подставится автоматически из DOM
    demoSuccess: false             // не показывать фейковый успех
  };

  /* Точка интеграции CRM: POST на Cloudflare Worker. */
  function sendToBackend(payload) {
    return fetch(FORM_CONFIG.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  /* ------------------------------------------------------------
   * 2. ШАПКА И МОБИЛЬНОЕ МЕНЮ
   * ---------------------------------------------------------- */
  var header = document.querySelector('.header');
  var navToggle = document.querySelector('.nav-toggle');

  function onScroll() {
    if (!header) return;
    header.classList.toggle('is-scrolled', window.scrollY > 8);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  if (navToggle) {
    navToggle.addEventListener('click', function () {
      var open = document.body.classList.toggle('nav-open');
      navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      navToggle.setAttribute('aria-label', open ? 'Закрыть меню' : 'Открыть меню');
    });
    // Клик по ссылке в мобильном меню закрывает его
    document.querySelectorAll('.mobile-menu a').forEach(function (a) {
      a.addEventListener('click', function () {
        document.body.classList.remove('nav-open');
        navToggle.setAttribute('aria-expanded', 'false');
      });
    });
  }

  /* ------------------------------------------------------------
   * 2.1. TURNSTILE: скрыть виджет, если sitekey не вставлен
   * ----------------------------------------------------------
   * Если в HTML осталась заглушка REPLACE_WITH_TURNSTILE_SITEKEY
   * или data-sitekey пустой — Cloudflare Turnstile выдаёт ошибку
   * 400020 и спамит в консоль. Скрываем div, чтобы не мешал.
   * Когда sitekey будет вставлен — виджет автоматически появится. */
  document.querySelectorAll('.cf-turnstile').forEach(function (w) {
    var sk = w.getAttribute('data-sitekey') || '';
    if (!sk || sk === 'REPLACE_WITH_TURNSTILE_SITEKEY') {
      w.style.display = 'none';
    }
  });

  /* ------------------------------------------------------------
   * 3. МОДАЛЬНОЕ ОКНО ЗАЯВКИ
   * ---------------------------------------------------------- */
  var modal = document.getElementById('zayavka');
  var lastFocused = null;

  function openModal(trigger) {
    if (!modal) return;
    lastFocused = trigger || document.activeElement;
    modal.hidden = false;
    // Двойной rAF, чтобы transition отработал после снятия hidden
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { modal.classList.add('open'); });
    });
    document.body.style.overflow = 'hidden';
    var first = modal.querySelector('input[name="name"]');
    if (first) setTimeout(function () { first.focus(); }, 220);

    // Источник заявки (метка для будущей CRM)
    if (trigger && trigger.getAttribute('data-modal-source')) {
      var src = modal.querySelector('input[name="source"]');
      if (src) src.value = trigger.getAttribute('data-modal-source');
    }
  }

  function closeModal() {
    if (!modal) return;
    modal.classList.remove('open');
    document.body.style.overflow = '';
    setTimeout(function () { modal.hidden = true; }, 260);
    if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
  }

  document.querySelectorAll('[data-modal-open]').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      document.body.classList.remove('nav-open');
      openModal(btn);
    });
  });
  if (modal) {
    modal.addEventListener('click', function (e) {
      if (e.target === modal) closeModal(); // клик по затемнению
    });
    modal.querySelectorAll('[data-modal-close]').forEach(function (b) {
      b.addEventListener('click', closeModal);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !modal.hidden) closeModal();
    });
  }

  /* ------------------------------------------------------------
   * 4. ФОРМА ЗАЯВКИ
   * ---------------------------------------------------------- */
  var form = document.getElementById('lead-form');
  if (!form) return;

  var nameInput = form.querySelector('input[name="name"]');
  var phoneInput = form.querySelector('input[name="phone"]');
  var emailInput = form.querySelector('input[name="email"]');
  var serviceSelect = form.querySelector('select[name="service_type"]');
  var commentInput = form.querySelector('textarea[name="comment"]');
  var consent = form.querySelector('input[name="consent"]');
  var honeypot = form.querySelector('input[name="website"]');
  var submitBtn = form.querySelector('button[type="submit"]');
  var formWrap = document.querySelector('[data-form-wrap]');
  var successPane = document.querySelector('[data-success]');
  var turnstileWidget = form.querySelector('.cf-turnstile');

  // Скрытое поле-метка источника (для CRM)
  var sourceInput = document.createElement('input');
  sourceInput.type = 'hidden';
  sourceInput.name = 'source';
  sourceInput.value = '';
  form.appendChild(sourceInput);

  /* 4.1. ГЛАВНОЕ ТРЕБОВАНИЕ:
     кнопка «Отправить заявку» неактивна и серая, пока НЕ стоит галочка
     согласия. Атрибут disabled уже стоит в HTML — включаем только по чекбоксу. */
  function syncConsent() {
    submitBtn.disabled = !consent.checked;
  }
  consent.addEventListener('change', syncConsent);
  syncConsent();

  /* 4.2. Лёгкая маска телефона +7 (XXX) XXX-XX-XX */
  function formatPhone(raw) {
    var d = raw.replace(/\D/g, '');
    if (d.startsWith('8')) d = '7' + d.slice(1);
    if (d.startsWith('9') || (d.length && d[0] !== '7' && d.length <= 10)) d = '7' + d;
    if (!d.startsWith('7')) d = '7' + d;
    d = d.slice(0, 11);
    var out = '+7';
    if (d.length > 1) out += ' (' + d.slice(1, 4);
    if (d.length >= 4) out += ') ' + d.slice(4, 7);
    if (d.length >= 7) out += '-' + d.slice(7, 9);
    if (d.length >= 9) out += '-' + d.slice(9, 11);
    return out;
  }
  phoneInput.addEventListener('input', function () {
    var before = phoneInput.value;
    var digits = before.replace(/\D/g, '');
    if (!digits.length) { phoneInput.value = ''; setError(phoneInput, false); return; }
    phoneInput.value = formatPhone(before);
    setError(phoneInput, false);
  });

  function setError(input, hasError) {
    var field = input.closest('.field');
    if (field) field.classList.toggle('field--error', hasError);
  }
  [nameInput, phoneInput, emailInput].forEach(function (inp) {
    inp.addEventListener('input', function () { setError(inp, false); });
  });
  if (serviceSelect) {
    serviceSelect.addEventListener('change', function () { setError(serviceSelect, false); });
  }

  /* 4.3. Валидация (клиентская; серверную см. в Worker) */
  function validate() {
    var ok = true;
    if (nameInput.value.trim().length < 2) { setError(nameInput, true); ok = false; }
    var digits = phoneInput.value.replace(/\D/g, '');
    if (digits.length < 11) { setError(phoneInput, true); ok = false; }
    var email = emailInput.value.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { setError(emailInput, true); ok = false; }
    if (serviceSelect && !serviceSelect.value) { setError(serviceSelect, true); ok = false; }
    return ok;
  }

  /* 4.4. Получение токена Turnstile (если виджет активен) */
  function isTurnstileActive() {
    if (!turnstileWidget) return false;
    var sk = turnstileWidget.getAttribute('data-sitekey') || '';
    // Если sitekey не вставлен (заглушка) — виджет не активен, пропускаем
    if (!sk || sk === 'REPLACE_WITH_TURNSTILE_SITEKEY') return false;
    return true;
  }
  function getTurnstileToken() {
    if (!isTurnstileActive() || typeof window.turnstile === 'undefined') return '';
    var wId = turnstileWidget.querySelector('[name="cf-turnstile-response"]') ||
              turnstileWidget.querySelector('input[type="hidden"]');
    if (wId) return wId.value || '';
    // Запасной вариант: глобальный API Turnstile
    try {
      var widgetId = turnstileWidget.dataset.widgetId;
      if (widgetId && window.turnstile.getResponse) return window.turnstile.getResponse(widgetId) || '';
    } catch (e) {}
    return '';
  }

  /* 4.5. Отправка */
  form.addEventListener('submit', function (e) {
    e.preventDefault();

    // Антиспам: honeypot. Боты заполняют скрытое поле — молча «принимаем».
    if (honeypot && honeypot.value.trim() !== '') {
      console.warn('[Праводом] Honeypot заполнен — заявка отклонена (бот).');
      closeModal();
      return;
    }
    // Страховка: без согласия отправка невозможна
    if (!consent.checked || submitBtn.disabled) return;
    if (!validate()) {
      var errField = form.querySelector('.field--error input, .field--error select');
      if (errField) errField.focus();
      return;
    }

    var turnstileToken = getTurnstileToken();
    // Если виджет активен (sitekey вставлен) и токена нет — ждём
    if (isTurnstileActive() && !turnstileToken) {
      submitBtn.textContent = 'Подождите проверку…';
      setTimeout(function () {
        var t = getTurnstileToken();
        if (t) { submitBtn.textContent = 'Отправляем…'; submitForm(t); }
        else {
          submitBtn.textContent = 'Подтвердите проверку';
          setTimeout(function () {
            submitBtn.textContent = 'Отправить заявку';
            syncConsent();
          }, 2000);
        }
      }, 800);
      return;
    }
    // Виджет не активен (sitekey заглушка) — отправляем без токена
    submitForm(turnstileToken);
  });

  function submitForm(turnstileToken) {
    // Определяем source_page по URL: /zalyv/ → 'site_zalyv' и т.д.
    var pageUrl = window.location.pathname;
    var sourcePage = 'site_main';
    if (pageUrl.indexOf('/zalyv') === 0) sourcePage = 'site_zalyv';
    else if (pageUrl.indexOf('/dtp') === 0) sourcePage = 'site_dtp';
    else if (pageUrl.indexOf('/zhilishchnye-spory') === 0) sourcePage = 'site_zhilishchnye_spory';
    else if (pageUrl.indexOf('/dolgi') === 0) sourcePage = 'site_dolgi';
    else if (pageUrl.indexOf('/privacy') === 0) sourcePage = 'site_privacy';

    var serviceValue = serviceSelect ? serviceSelect.value : 'other';
    var title = nameInput.value.trim() + ' — ' + (
      { 'dolgi':'Взыскание для УК','zalyv':'Залив','dtp':'ДТП',
        'zhilishchnye-spory':'Жилищные споры','other':'Общее' }[serviceValue] || 'Общее'
    );

    var payload = {
      name: nameInput.value.trim(),
      phone: phoneInput.value.trim(),
      email: emailInput.value.trim(),
      service_type: serviceValue,
      comment: commentInput ? commentInput.value.trim() : '',
      consent: true,
      source: sourcePage,                 // метка источника для CRM
      sourcePage: sourcePage,             // дублирующее поле для бэка
      pageUrl: window.location.href,
      submittedAt: new Date().toISOString(),
      website: honeypot ? honeypot.value : '',       // honeypot
      turnstileToken: turnstileToken,                // Cloudflare Turnstile
      // title для crm_cases — соберём на бэке, но продублируем:
      caseTitle: title
    };

    submitBtn.disabled = true;
    submitBtn.textContent = 'Отправляем…';

    sendToBackend(payload)
      .then(function (data) {
        if (data && data.ok === false) {
          throw new Error(data.error || 'Сервер отклонил заявку');
        }
        showSuccess();
      })
      .catch(function (err) {
        console.error('[Праводом] Ошибка отправки:', err);
        submitBtn.textContent = 'Ошибка. Попробуйте ещё раз';
        // Сброс Turnstile для повторной попытки
        if (turnstileWidget && window.turnstile && turnstileWidget.dataset.widgetId) {
          try { window.turnstile.reset(turnstileWidget.dataset.widgetId); } catch (e) {}
        }
        setTimeout(function () {
          submitBtn.textContent = 'Отправить заявку';
          syncConsent();
        }, 2200);
      });
  }

  function showSuccess() {
    if (formWrap && successPane) {
      formWrap.hidden = true;
      successPane.hidden = false;
      successPane.classList.add('show');
    }
    form.reset();
    submitBtn.textContent = 'Отправить заявку';
    syncConsent();
  }

  // При повторном открытии модалки — снова показать форму
  document.querySelectorAll('[data-modal-open]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (formWrap && successPane && successPane.classList.contains('show')) {
        successPane.classList.remove('show');
        successPane.hidden = true;
        formWrap.hidden = false;
      }
    });
  });

  /* ------------------------------------------------------------
   * 5. ПЛАВНОЕ ПОЯВЛЕНИЕ СЕКЦИЙ
   * ---------------------------------------------------------- */
  var reveals = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          en.target.classList.add('in-view');
          io.unobserve(en.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add('in-view'); });
  }
})();
