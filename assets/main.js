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
   * TODO CRM: когда будет backend — укажите здесь URL приёма заявок
   * (например '/api/lead' или URL webhook CRM: Bitrix24/amoCRM/…).
   * Форма шлёт POST c JSON:
   *   { name, phone, email, consent, source, website (honeypot),
   *     turnstileToken, pageUrl, submittedAt }
   *
   * TODO BACKEND-требования (реализуются на сервере, не здесь):
   *   - серверная валидация полей (имя, телефон, email);
   *   - rate limiting по IP (например 3–5 заявок в час);
   *   - проверка honeypot и CAPTCHA на сервере;
   *   - уведомления: Telegram-бот и/или email (SMTP).
   * ---------------------------------------------------------- */
  var FORM_CONFIG = {
    endpoint: '',            // TODO: URL API/CRM. Пусто = демо-режим без отправки.
    turnstileSiteKey: '',    // TODO: sitekey Cloudflare Turnstile (см. разметку модалки)
    demoSuccess: true        // демо-режим: показывать экран «Заявка отправлена» без backend
  };

  /* Точка интеграции CRM. Ничего не делает, пока endpoint не задан. */
  function sendToBackend(payload) {
    // TODO CRM: заменить на реальный вызов API, например:
    //   return fetch(FORM_CONFIG.endpoint, {
    //     method: 'POST',
    //     headers: { 'Content-Type': 'application/json' },
    //     body: JSON.stringify(payload)
    //   }).then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); });
    return Promise.resolve({ demo: true });
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
  var consent = form.querySelector('input[name="consent"]');
  var honeypot = form.querySelector('input[name="website"]');
  var submitBtn = form.querySelector('button[type="submit"]');
  var formWrap = document.querySelector('[data-form-wrap]');
  var successPane = document.querySelector('[data-success]');

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

  /* 4.3. Валидация (клиентская; серверную см. TODO BACKEND выше) */
  function validate() {
    var ok = true;
    if (nameInput.value.trim().length < 2) { setError(nameInput, true); ok = false; }
    var digits = phoneInput.value.replace(/\D/g, '');
    if (digits.length < 11) { setError(phoneInput, true); ok = false; }
    var email = emailInput.value.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { setError(emailInput, true); ok = false; }
    return ok;
  }

  /* 4.4. Отправка */
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
      var errField = form.querySelector('.field--error input');
      if (errField) errField.focus();
      return;
    }

    var payload = {
      name: nameInput.value.trim(),
      phone: phoneInput.value.trim(),
      email: emailInput.value.trim(),
      consent: true,
      source: sourceInput.value || 'organic',
      pageUrl: window.location.href,
      submittedAt: new Date().toISOString(),
      website: honeypot ? honeypot.value : ''
      // TODO Turnstile: добавить turnstileToken из виджета CAPTCHA
    };

    submitBtn.disabled = true;
    submitBtn.textContent = 'Отправляем…';

    sendToBackend(payload)
      .then(function () {
        if (!FORM_CONFIG.endpoint && FORM_CONFIG.demoSuccess) {
          console.info('[Праводом] Демо-режим: endpoint не задан в FORM_CONFIG (main.js). ' +
            'Заявка НЕ отправлена на сервер — подключите CRM/API.');
        }
        showSuccess();
      })
      .catch(function (err) {
        console.error('[Праводом] Ошибка отправки:', err);
        submitBtn.textContent = 'Ошибка. Попробуйте ещё раз';
        setTimeout(function () {
          submitBtn.textContent = 'Отправить заявку';
          syncConsent();
        }, 2200);
      });
  });

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
