/* Юридический навигатор — логика мини-аппа.
 * Вкладки: Чат, Порог, Документ. Данные документа — doc.json, собранный
 * из legal_handbook_v2.1.md тем же разбором, что питает Code-ноды n8n.
 */
(function () {
  'use strict';

  var tg = window.Telegram && window.Telegram.WebApp;

  // Вызов метода, которого нет в старом клиенте, бросает исключение и роняет
  // весь скрипт — пользователь видит пустой экран. Поэтому всё сверх
  // ready/expand идёт через проверку версии Bot API.
  function tgSafe(version, fn) {
    try { if (tg && tg.isVersionAtLeast && tg.isVersionAtLeast(version)) fn(); } catch (e) {}
  }

  if (tg) {
    try { tg.ready(); tg.expand(); } catch (e) {}
    // Без этого свайп вниз по таблице закрывает приложение вместо прокрутки.
    tgSafe('7.7', function () { tg.disableVerticalSwipes(); });
    tgSafe('6.1', function () { tg.setHeaderColor('bg_color'); });
  }

  // ---------- утилиты ----------
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function el(html) {
    var t = document.createElement('template');
    t.innerHTML = String(html).trim();
    return t.content.firstElementChild;
  }
  function money(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }
  function $(id) { return document.getElementById(id); }

  var doc = null;          // doc.json
  var demoData = null;     // demo-responses.json

  // Единый вход объединённого процесса: и вопросы, и запросы графика.
  var CHAT_URL = 'https://n8n-production-5b17.up.railway.app/webhook/00003039-167e-4800-a800-00007f790800/chat';

  // Письмо и автоответ теперь отправляет сам процесс после каждого ответа,
  // поэтому отдельный вызов с клиента не нужен.
  var NOTIFY_URL = '';
  function notify(p) {
    if (!NOTIFY_URL) return;
    try {
      fetch(NOTIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(p)
      }).catch(function () {});
    } catch (e) {}
  }
  var registry = null;     // MATRIX и таблицы, выведенные из doc.json

  // ================================================================
  // ВКЛАДКИ И НАВИГАЦИЯ
  // ================================================================
  var TABS = ['chat', 'calc', 'doc', 'quiz', 'crm'];
  var current = 'chat';
  var docStack = [];       // стек экранов внутри вкладки «Документ»

  // BackButton появился в Bot API 6.1: на 6.0 обращение к нему сыплет
  // предупреждениями и ничего не делает. Видимая кнопка в экране документа
  // работает везде, поэтому системная — только приятное дополнение.
  var hasBackButton = false;
  try { hasBackButton = !!(tg && tg.isVersionAtLeast && tg.isVersionAtLeast('6.1') && tg.BackButton); } catch (e) {}

  function syncBackButton() {
    if (!hasBackButton) return;
    try {
      if (current === 'doc' && docStack.length) tg.BackButton.show();
      else tg.BackButton.hide();
    } catch (e) {}
  }

  function showTab(name) {
    current = name;
    TABS.forEach(function (t) {
      var pane = $('tab-' + t);
      if (pane) pane.hidden = t !== name;
      var btn = $('nav-' + t);
      if (btn) btn.classList.toggle('on', t === name);
    });
    // Поле ввода нужно только в чате.
    $('composer').hidden = name !== 'chat';
    // Картотеку тянем при первом открытии вкладки, а не при запуске:
    // иначе каждый запуск мини-аппа дёргает n8n впустую.
    if (name === 'crm' && !crmLoaded) crmLoad(null);
    syncBackButton();
  }

  if (hasBackButton) {
    try {
      tg.BackButton.onClick(function () {
        if (current === 'doc' && docStack.length) { docStack.pop(); renderDoc(); }
      });
    } catch (e) {}
  }

  TABS.forEach(function (t) {
    var b = $('nav-' + t);
    if (b) b.addEventListener('click', function () { showTab(t); });
  });

  // ================================================================
  // КАРТОТЕКА ЗАЯВОК
  // ================================================================
  // Заявки хранятся в самом процессе n8n, здесь только показ и смена статуса.
  // Адрес заодно работает ключом доступа, поэтому публиковать его нельзя.
  var CRM_URL = 'https://n8n-production-5b17.up.railway.app/webhook/crm-7f3a91c2';

  var STATUS = [
    { key: 'new', label: 'Новая' },
    { key: 'work', label: 'В работе' },
    { key: 'done', label: 'Закрыта' }
  ];
  var crmLoaded = false;

  // Ключ хранится в браузере того, кто его ввёл, и в коде страницы его нет:
  // в заявках лежат вопросы и почтовые адреса клиентов, а страница публичная.
  function crmKey() {
    try { return localStorage.getItem('crm-key') || ''; } catch (e) { return ''; }
  }
  function setCrmKey(v) {
    try { localStorage.setItem('crm-key', v); } catch (e) {}
  }

  function crmSay(html) { $('crm-root').innerHTML = html; }

  function crmLock(msg) {
    crmSay('<div class="crm-head"><h2>Заявки</h2></div>' +
      '<p class="crm-empty">' + esc(msg || 'Картотека закрыта: в заявках есть адреса клиентов.') + '</p>' +
      '<div class="mailrow"><input type="password" id="crm-key" placeholder="Ключ доступа" autocomplete="off">' +
      '<button type="button" id="crm-unlock">Открыть</button></div>');
  }

  function crmCard(r) {
    var st = STATUS.filter(function (s) { return s.key === r.status; })[0] || STATUS[0];
    var acts = STATUS.map(function (s) {
      return '<button type="button" data-id="' + esc(r.id) + '" data-status="' + s.key + '"' +
        (s.key === r.status ? ' class="on"' : '') + '>' + s.label + '</button>';
    }).join('');

    return '<article class="crm-card">' +
      '<div class="crm-top">' +
        '<span class="pill ' + st.key + '">' + st.label + '</span>' +
        (r.needs_human ? '<span class="pill work">нужен человек</span>' : '') +
        '<span class="crm-id">№ ' + esc(r.id) + '</span>' +
      '</div>' +
      '<p class="crm-q">' + esc(r.question) + '</p>' +
      '<p class="crm-a">' + esc(r.answer) + '</p>' +
      '<p class="crm-src">' + esc(r.branch_label || '') +
        (r.source ? ' · ' + esc(r.source) : '') + '</p>' +
      '<div class="crm-acts">' + acts + '</div>' +
    '</article>';
  }

  // Показывать всё или только то, где нужен человек: в журнале лежат все
  // обращения, а уведомления приходят только по веткам Б и В.
  var crmOnlyHuman = false;
  var crmLast = null;

  function crmRender(d) {
    crmLast = d;
    if (!d.items.length) {
      crmSay('<div class="crm-head"><h2>Заявки</h2></div>' +
        '<p class="crm-empty">Пока пусто. Задайте вопрос на вкладке «Чат» — заявка появится здесь и придёт карточкой в Telegram.</p>');
      return;
    }
    var items = crmOnlyHuman ? d.items.filter(function (r) { return r.needs_human; }) : d.items;
    var attention = d.items.filter(function (r) { return r.needs_human; }).length;
    crmSay(
      '<div class="crm-head">' +
        '<h2>Заявки</h2>' +
        '<span class="crm-count">новых ' + d.counts.new + ' · в работе ' + d.counts.work +
          ' · закрыто ' + d.counts.done + ' · внимания ' + attention + '</span>' +
        '<button type="button" class="crm-refresh" id="crm-filter">' +
          (crmOnlyHuman ? 'Все' : 'Только важные') + '</button>' +
        '<button type="button" class="crm-refresh" id="crm-reload">Обновить</button>' +
      '</div>' +
      (items.length
        ? '<div class="crm-list">' + items.map(crmCard).join('') + '</div>'
        : '<p class="crm-empty">Обращений, требующих человека, нет.</p>')
    );
  }

  function crmLoad(payload) {
    crmLoaded = true;
    if (!CRM_URL) {
      crmSay('<p class="crm-empty">Картотека не подключена: не задан адрес процесса.</p>');
      return;
    }
    if (!$('crm-root').innerHTML) crmSay('<p class="crm-empty">Загружаю картотеку…</p>');

    // Только GET: вебхук объявлен сразу на GET и POST, и в этом режиме n8n
    // отвечает через Respond-ноду лишь на GET — POST возвращает пустое тело.
    // Проверено на боевом процессе, поэтому и список, и смена статуса идут
    // строкой запроса.
    var key = crmKey();
    if (!key) { crmLock(); return; }

    var url = CRM_URL + '?key=' + encodeURIComponent(key);
    if (payload) {
      url += '&action=status&id=' + encodeURIComponent(payload.id) +
        '&status=' + encodeURIComponent(payload.status);
    }

    fetch(url, { method: 'GET' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d) throw new Error('пустой ответ');
        if (d.locked) { crmLock('Ключ не подошёл. Введите его ещё раз.'); return; }
        if (!d.items) throw new Error('пустой ответ');
        crmRender(d);
      })
      .catch(function () {
        crmSay('<div class="crm-head"><h2>Заявки</h2>' +
          '<button type="button" class="crm-refresh" id="crm-reload">Повторить</button></div>' +
          '<p class="crm-empty">Не получилось связаться с процессом. Проверьте, что он включён в n8n.</p>');
      });
  }

  // Слушаем корень: карточки перерисовываются целиком, поэтому вешать
  // обработчики на каждую кнопку пришлось бы после каждой перерисовки.
  $('crm-root').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button') : null;
    if (!b) return;
    if (b.id === 'crm-reload') { crmLoad(null); return; }
    if (b.id === 'crm-filter') { crmOnlyHuman = !crmOnlyHuman; if (crmLast) crmRender(crmLast); return; }
    if (b.id === 'crm-unlock') {
      var f = document.getElementById('crm-key');
      if (f && f.value.trim()) { setCrmKey(f.value.trim()); crmSay(''); crmLoad(null); }
      return;
    }
    if (b.dataset && b.dataset.status) {
      crmLoad({ action: 'status', id: b.dataset.id, status: b.dataset.status });
    }
  });

  // ================================================================
  // ВИЗУАЛИЗАЦИЯ (используется и в чате, и в документе)
  // ================================================================
  function renderThreshold(v) {
    var items = v.items || [];
    return '<div class="vis">' +
      '<p class="vis-title">' + esc(v.title) + '<span>' + esc(v.source_ref) + ' · стр. ' + esc(v.source_page) + '</span></p>' +
      (v.marker ? '<div class="marker">Ваша сумма: ' + esc(v.marker.label) + '</div>' : '') +
      '<div class="ladder">' + items.map(function (i) {
        return '<div class="' + (i.label === v.highlight ? 'on' : 'off') + '"></div>';
      }).join('') + '</div>' +
      '<div class="scale">' + items.map(function (i) {
        return '<span>' + esc(i.max == null ? '∞' : money(i.max)) + '</span>';
      }).join('') + '</div>' +
      items.map(function (i) {
        return '<div class="tier' + (i.label === v.highlight ? ' on' : '') + '">' +
          '<span class="lab">' + esc(i.label) + '</span>' +
          '<span class="who">' + esc(i.signer) + '</span>' +
          '<span class="visa">Виза юротдела: ' + esc(i.visa) + '</span></div>';
      }).join('') + '</div>';
  }

  function renderTable(v) {
    return '<div class="vis">' +
      '<p class="vis-title">' + esc(v.title) + '<span>' + esc(v.source_ref) + ' · стр. ' + esc(v.source_page) + '</span></p>' +
      '<div class="tw"><table><thead><tr>' +
      (v.head || []).map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') +
      '</tr></thead><tbody>' +
      (v.rows || []).map(function (r) {
        return '<tr' + (v.highlight && r[0] === v.highlight ? ' class="on"' : '') + '>' +
          r.map(function (c) { return '<td>' + esc(c) + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table></div></div>';
  }

  function renderChecklist(v, keyPrefix) {
    var pre = keyPrefix || ('c' + Math.random().toString(36).slice(2, 7));
    return '<div class="vis">' +
      '<p class="vis-title">' + esc(v.title) + '<span>' + esc(v.source_ref) + ' · стр. ' + esc(v.source_page) + '</span></p>' +
      '<ul class="check">' + (v.items || []).map(function (t, i) {
        return '<li><label><input type="checkbox" data-ck="' + esc(pre + '-' + i) + '"><span>' + esc(t) + '</span></label></li>';
      }).join('') + '</ul></div>';
  }

  function renderVisual(v) {
    if (!v || !v.type || v.type === 'none') return '';
    try {
      if (v.type === 'threshold_bar') return renderThreshold(v);
      if (v.type === 'table') return renderTable(v);
      if (v.type === 'checklist') return renderChecklist(v);
    } catch (e) { return ''; }   // визуал — надстройка, не должен прятать ответ
    return '';
  }


  // ================================================================
  // ГРАФИКИ ПО ТАБЛИЦАМ
  // ================================================================
  // Числа приходят из charts.json, где каждое подтверждено ячейкой документа.
  // Строки без числового значения не выбрасываются, а перечисляются под
  // графиком: усечённый график выглядит полным и потому опаснее отсутствия.
  var chartPresets = null;

  function chartFor(ref) {
    if (!chartPresets) return null;
    var keys = Object.keys(chartPresets).filter(function (k) { return k.indexOf(ref + '|') === 0; });
    return keys.length ? chartPresets[keys[0]] : null;
  }

  function renderChart(c) {
    if (!c) return '';
    var scale = c.max || 1;
    var bars = c.items.map(function (it) {
      var left = Math.max((it.min - 1) / scale * 100, 0);
      var width = Math.max((it.max - it.min + 1) / scale * 100, 3);
      return '<div class="bar-row">' +
        '<span class="bar-label">' + esc(it.label) + '</span>' +
        '<span class="bar-track"><span class="bar-fill" style="margin-left:' + left.toFixed(2) +
        '%;width:' + width.toFixed(2) + '%"></span></span>' +
        '<span class="bar-val">' + esc(it.raw) + '</span></div>';
    }).join('');

    var omitted = (c.omitted && c.omitted.length)
      ? '<p class="bar-omit"><b>Без числового значения, на график не нанесены:</b> ' +
        c.omitted.map(function (o) { return esc(o.label) + ' (' + esc(o.raw) + ')'; }).join('; ') + '</p>'
      : '';

    return '<div class="chart">' +
      '<p class="vis-title">' + esc(c.column) + ', ' + esc(c.unit) +
      '<span>' + esc(c.ref) + ' · стр. ' + esc(c.page) + '</span></p>' +
      bars + omitted + '</div>';
  }

  // ================================================================
  // ЧАТ
  // ================================================================
  var thread = $('thread');
  var form = $('composer');
  var input = $('input');
  var sendBtn = $('send');
  var intro = $('intro');
  var busy = false;
  var sessionId = 'wa-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);

  var SUGGESTIONS = [
    'До какой суммы договор можно подписать без визы юр. отдела?',
    'Подготовь запрос на согласование договора с поставщиком на 8000 евро',
    'Сколько занимает визирование доверенности?',
    'Что делать при получении претензии?',
    'Построй график сроков визирования документов'
  ];
  var BRANCH = {
    A: { tag: 'a', letter: 'А', label: 'прямой ответ' },
    B: { tag: 'b', letter: 'Б', label: 'требуется подтверждение' },
    V: { tag: 'v', letter: 'В', label: 'передано юристу' }
  };

  function toEnd() {
    requestAnimationFrame(function () { thread.scrollTop = thread.scrollHeight; });
  }

  var lastAsk = '';

  // Письмо содержит ровно тот ответ, который человек прочитал: отправляем его
  // вместе с флагом mail_only. Переспрашивать агента нельзя — он может
  // ответить иначе, и в письме окажется не то.
  function mailRow(d) {
    var row = el('<div class="mailrow">' +
      '<input type="email" inputmode="email" placeholder="Прислать ответ на почту" autocomplete="email">' +
      '<button type="button">Отправить</button>' +
      '<p class="hint">Письмо придёт один раз, на указанный адрес.</p>' +
      '</div>');
    var field = row.querySelector('input');
    var btn = row.querySelector('button');

    btn.addEventListener('click', function () {
      var mail = field.value.trim().toLowerCase();
      if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(mail)) {
        field.focus();
        field.style.borderColor = 'var(--danger, #e05353)';
        return;
      }
      field.style.borderColor = '';
      btn.disabled = true;
      btn.textContent = 'Отправляем…';

      fetch(CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'sendMessage',
          mail_only: true,
          chatInput: lastAsk,
          question: lastAsk,
          answer: d.answer || d.output || '',
          branch: d.branch,
          source: d.source_summary,
          confidence: d.confidence,
          sessionId: sessionId,
          channel: 'мини-апп',
          reply_to: mail
        })
      }).then(function (r) { return r.ok; }).catch(function () { return false; })
        .then(function (ok) {
          row.innerHTML = ok
            ? '<p class="done">Готово — ответ уйдёт на ' + esc(mail) + '.</p>'
            : '<p class="hint">Не удалось передать заявку. Попробуйте ещё раз позже.</p>';
        });
    });
    return row;
  }

  function addAnswer(d) {
    var b = BRANCH[d.branch] || { tag: 'a', letter: '·', label: 'ответ' };
    var html = '<div class="msg"><div class="card">' +
      '<div class="card-head"><span class="tag ' + b.tag + '">' + esc(b.letter) + '</span>' + esc(b.label) +
      (typeof d.confidence === 'number' ? ' · уверенность ' + d.confidence.toFixed(2) : '') + '</div>' +
      '<div class="card-body">' + esc(d.output || d.answer || '') + '</div>';
    if (d.source_summary) html += '<div class="cite">Основание: <b>' + esc(d.source_summary) + '</b></div>';
    html += renderVisual(d.visual);
    if (d.status === 'pending_approval') {
      html += '<div class="notice wait">Черновик письма отправлен на согласование. Решение принимается в чате Telegram — письмо уйдёт только после подтверждения.</div>';
    } else if (d.status === 'escalated' && d.reason_no_answer) {
      html += '<div class="notice esc">' + esc(d.reason_no_answer) + '</div>';
    }
    thread.appendChild(el(html + '</div></div>'));
    // В демо-режиме отправлять нечего: процесс не подключён.
    if (CHAT_URL && !demoData) thread.appendChild(mailRow(d));
    toEnd();
    // Диалог не должен упираться в тупик: после каждого ответа предлагаем,
    // о чём спросить дальше, начиная с соседних пунктов того же раздела.
    var ref = (d.source_summary || '').match(/§\s*\d{1,2}(?:\.\d)?|Приложение\s+[АБ](?:\.\d)?/);
    renderFollowUps(ref ? ref[0].replace(/\s+/g, ' ').replace('§ ', '§') : null);
  }

  function addError(t) {
    thread.appendChild(el('<div class="msg"><div class="notice err">' + esc(t) + '</div></div>'));
    toEnd();
  }

  function loadDemo() {
    if (demoData) return Promise.resolve(demoData);
    return fetch('demo-responses.json').then(function (r) { return r.json(); })
      .then(function (d) { demoData = d; return d; });
  }
  function demoAnswer(q) {
    return loadDemo().then(function (d) {
      // Записанные сценарии для тест-кейсов задания — у них развёрнутый текст.
      for (var i = 0; i < d.items.length; i++) {
        if (new RegExp(d.items[i].match, 'i').test(q)) return d.items[i].response;
      }
      // Затем каталог: точное совпадение вопроса, потом поиск по словам.
      if (catalogue) {
        var norm = normalizeQ(q);
        for (var k = 0; k < catalogue.items.length; k++) {
          if (normalizeQ(catalogue.items[k].q) === norm) return catalogue.items[k].response;
        }
        var found = searchCatalogue(q, 1);
        if (found.length) return found[0].response;
      }
      return d.fallback;
    });
  }
  function enterDemoMode() {
    var b = $('demo-banner');
    if (b) b.classList.add('on');
  }

  function ask(question) {
    if (busy) return;

    // Запрос графика уходит во второй контур: основной путь ответа не меняется.
    if (isChartRequest(question)) {
      busy = true;
      sendBtn.disabled = true;
      asked[question] = 1;
      showTab('chat');
      if (intro) { intro.remove(); intro = null; }
      var sg = $('suggest'); if (sg) { sg.hidden = true; sg.innerHTML = ''; }
      return askChart(question).finally(function () {
        busy = false;
        sendBtn.disabled = false;
      });
    }

    busy = true;
    sendBtn.disabled = true;
    if (intro) { intro.remove(); intro = null; }
    showTab('chat');
    asked[question] = 1;
    var sgBox = $('suggest'); if (sgBox) { sgBox.hidden = true; sgBox.innerHTML = ''; }

    thread.appendChild(el('<div class="msg user"><div class="bubble">' + esc(question) + '</div></div>'));
    var pending = el('<div class="msg"><div class="card"><div class="thinking"><i></i><i></i><i></i></div></div></div>');
    thread.appendChild(pending);
    toEnd();

    var run = demoData ? demoAnswer(question) : fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'sendMessage',
        chatInput: question,
        question: question,
        sessionId: sessionId,
        channel: 'mini-app',
        tg_chat_id: (tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.id) || ''
      })
    }).then(function (res) {
      // GitHub Pages на POST к статическому пути отдаёт 405, а не 404,
      // поэтому признак статики — тип содержимого, а не код ответа.
      var type = res.headers.get('content-type') || '';
      if (type.indexOf('application/json') === -1) { enterDemoMode(); return demoAnswer(question); }
      return res.json().catch(function () { return null; });
    }).catch(function () {
      // n8n недоступен: показываем записанные ответы вместо тупика.
      // Каждый из них прошёл через настоящие Code-ноды guardrail и визуализации.
      enterDemoMode();
      return demoAnswer(question);
    });

    run.then(function (body) {
      pending.remove();
      if (!body) { addError('Не удалось разобрать ответ сервера.'); return; }
      if (body.error) { addError(body.error); return; }
      lastAsk = question;
      addAnswer(body);
    }).catch(function () {
      pending.remove();
      addError('Нет связи с сервером. Попробуйте ещё раз.');
    }).finally(function () {
      busy = false;
      sendBtn.disabled = false;
    });
  }

  var chips = $('chips');
  SUGGESTIONS.forEach(function (t) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = t;
    b.addEventListener('click', function () { ask(t); });
    chips.appendChild(b);
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var t = input.value.trim();
    if (!t) return;
    input.value = '';
    input.style.height = 'auto';
    var sg = $('suggest'); if (sg) { sg.hidden = true; sg.innerHTML = ''; }
    ask(t);
  });
  input.addEventListener('input', function () {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 110) + 'px';
    renderSuggestBox(input.value);
  });
  input.addEventListener('blur', function () {
    // Небольшая задержка, иначе клик по подсказке не успевает сработать.
    setTimeout(function () { var b = $('suggest'); if (b) b.hidden = true; }, 180);
  });
  input.addEventListener('focus', function () { renderSuggestBox(input.value); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
  // На iOS клавиатура не поджимает контент — подтягиваем поле в видимую зону.
  input.addEventListener('focus', function () {
    setTimeout(function () {
      try { input.scrollIntoView({ block: 'center' }); } catch (e) {}
    }, 300);
  });



  // ================================================================
  // КАТАЛОГ ПОДСКАЗОК
  // ================================================================
  // 93 вопроса по всему справочнику, у каждого готовый ответ, построенный
  // из ячеек документа. Каталог решает две задачи: поиск при вводе и
  // подсказки-продолжения, чтобы диалог не упирался в тупик после первого
  // ответа.
  var catalogue = null;
  var asked = {};

  function normalizeQ(q) { return String(q).toLowerCase().replace(/[^а-яёa-z0-9]+/g, ' ').trim(); }

  /** Поиск по каталогу: все слова запроса должны найтись в ключевых словах. */
  function searchCatalogue(query, limit) {
    if (!catalogue) return [];
    var words = normalizeQ(query).split(' ').filter(function (w) { return w.length >= 3; });
    if (!words.length) return [];
    var hits = [];
    for (var i = 0; i < catalogue.items.length; i++) {
      var it = catalogue.items[i];
      if (asked[it.q]) continue;
      var score = 0;
      for (var j = 0; j < words.length; j++) {
        if (it.kw.indexOf(words[j]) !== -1) score++;
      }
      if (score === words.length) hits.push({ it: it, score: score * 10 + (it.q.toLowerCase().indexOf(words[0]) === 0 ? 5 : 0) });
    }
    hits.sort(function (a, b) { return b.score - a.score; });
    return hits.slice(0, limit || 6).map(function (h) { return h.it; });
  }

  /** Подсказки-продолжения: сначала соседи по разделу, потом остальные. */
  function followUps(ref, limit) {
    if (!catalogue) return [];
    var out = [];
    var seen = {};
    var push = function (i) {
      var it = catalogue.items[i];
      if (!it || asked[it.q] || seen[it.q]) return;
      seen[it.q] = 1;
      out.push(it);
    };
    // Не больше двух подряд из одного раздела: третья подсказка из другого
    // места документа показывает, что справочник покрыт целиком, а не одной
    // таблицей.
    (catalogue.byRef[ref] || []).slice(0, 6).forEach(push);
    var near = out.slice(0, 2);

    var far = [];
    var refs = Object.keys(catalogue.byRef).filter(function (r) { return r !== ref; });
    for (var i = refs.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = refs[i]; refs[i] = refs[j]; refs[j] = t;
    }
    for (var r = 0; r < refs.length && far.length < 4; r++) {
      var idxs = catalogue.byRef[refs[r]];
      var cand = catalogue.items[idxs[Math.floor(Math.random() * idxs.length)]];
      if (cand && !asked[cand.q] && !seen[cand.q]) { seen[cand.q] = 1; far.push(cand); }
    }
    out = near.concat(far);
    // Перемешиваем, чтобы при повторных запусках предлагалось разное.
    for (var i = out.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = out[i]; out[i] = out[j]; out[j] = t;
    }
    return out.slice(0, limit || 3);
  }

  function renderFollowUps(ref) {
    var list = followUps(ref, 3);
    if (!list.length) return;
    var box = el('<div class="followups"><p class="fu-title">Спросить дальше · листайте вбок</p><div class="srow"></div></div>');
    var wrap = box.querySelector('.srow');
    list.forEach(function (it) {
      var b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = esc(it.q) + '<i>' + esc(it.ref) + '</i>';
      b.addEventListener('click', function () { ask(it.q); });
      wrap.appendChild(b);
    });
    thread.appendChild(box);
    toEnd();
  }

  /** Выпадающий список подсказок над полем ввода. */
  function renderSuggestBox(query) {
    var box = $('suggest');
    if (!box) return;
    var hits = query.trim().length >= 2 ? searchCatalogue(query, 10) : [];
    if (!hits.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.innerHTML = '<p class="sg-title">Найдено ' + hits.length + ' · листайте вбок</p>';
    var row = document.createElement('div');
    row.className = 'srow';
    hits.forEach(function (it) {
      var b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = esc(it.q) + '<i>' + esc(it.ref) + '</i>';
      b.addEventListener('click', function () {
        input.value = '';
        input.style.height = 'auto';
        box.hidden = true;
        ask(it.q);
      });
      row.appendChild(b);
    });
    box.appendChild(row);
    box.hidden = false;
  }

  // ================================================================
  // ГРАФИК ПО ЗАПРОСУ
  // ================================================================
  // Впишите сюда Production URL вебхука отдельного workflow «график по запросу»,
  // чтобы таблицу выбирала модель. Пусто — работает локальный подбор по
  // ключевым словам: он ничего не выдумывает, а при отсутствии совпадения
  // так же честно отказывается.
  // График приходит из того же входа: процесс сам распознаёт просьбу построить
  // график и уводит запрос в свою ветку.
  var VISUAL_URL = CHAT_URL;

  // \w и \b в JavaScript охватывают только ASCII, поэтому «построй» через
  // \w* не совпадает: кириллическая «й» не считается символом слова.
  var CYR = '[а-яёА-ЯЁ]';
  var CHART_ASK = new RegExp(
    '(?:постро|нарису|покаж|сдела|вывед)' + CYR + '*\\s+(?:график|диаграмм|визуал)' +
    '|^\\s*график' +
    '|график' + CYR + '*\\s+(?:по|для)', 'i');

  function isChartRequest(q) { return CHART_ASK.test(q); }

  /** Локальный подбор таблицы: пересечение значимых слов запроса и описания. */
  function localChartMatch(q) {
    var words = q.toLowerCase().match(/[а-яёa-z]{4,}/g) || [];
    var stop = { график: 1, диаграмм: 1, построй: 1, покажи: 1, нарисуй: 1, сделай: 1 };
    var best = null, bestScore = 0;
    Object.keys(chartPresets || {}).forEach(function (id) {
      var c = chartPresets[id];
      var hay = (c.title + ' ' + c.column + ' ' + c.unit).toLowerCase();
      var score = 0;
      words.forEach(function (w) {
        if (stop[w]) return;
        if (hay.indexOf(w.slice(0, 5)) !== -1) score++;
      });
      if (score > bestScore) { bestScore = score; best = c; }
    });
    return bestScore > 0 ? best : null;
  }

  function addChartAnswer(res) {
    var html = '<div class="msg"><div class="card">' +
      '<div class="card-head"><span class="tag ' + (res.refused ? 'v' : 'a') + '">▤</span>' +
      (res.refused ? 'график не построен' : 'график по документу') + '</div>';

    if (res.refused) {
      html += '<div class="card-body">' + esc(res.message) + '</div>';
    } else {
      html += '<div class="card-body">' + esc(res.chart.title) + ' — ' + esc(res.chart.column) +
        ', значения в «' + esc(res.chart.unit) + '».</div>' +
        '<div class="cite">Основание: <b>' + esc(res.source) + '</b></div>' +
        renderChart(res.chart);
    }
    thread.appendChild(el(html + '</div></div>'));
    toEnd();
  }

  function askChart(question) {
    if (intro) { intro.remove(); intro = null; }
    thread.appendChild(el('<div class="msg user"><div class="bubble">' + esc(question) + '</div></div>'));
    var pending = el('<div class="msg"><div class="card"><div class="thinking"><i></i><i></i><i></i></div></div></div>');
    thread.appendChild(pending);
    toEnd();

    var run = VISUAL_URL
      ? fetch(VISUAL_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'sendMessage', chatInput: question, question: question, sessionId: sessionId, channel: 'mini-app' })
        }).then(function (r) { return r.json(); })
      : Promise.resolve().then(function () {
          var c = localChartMatch(question);
          return c
            ? { refused: false, chart: c, source: c.ref + ' «' + c.title + '», стр. ' + c.page }
            : {
                refused: true,
                chart: null,
                message: 'Подходящей таблицы в документе нет, поэтому график не строится. ' +
                  'Числовые данные, пригодные для графика, есть в разделах ' +
                  Object.keys(chartPresets || {}).map(function (k) { return chartPresets[k].ref; }).join(', ') + '.'
              };
        });

    return run
      .then(function (res) {
        pending.remove();
        addChartAnswer(res);
        renderFollowUps(res.chart ? res.chart.ref : null);
      })
      .catch(function () {
        pending.remove();
        addError('Не удалось построить график.');
      });
  }

  // ================================================================
  // КАЛЬКУЛЯТОР ПОРОГА
  // ================================================================
  // §4.1 — неценовые основания для обязательного согласования.
  var TRIGGERS = [
    { id: 'nonstandard', text: 'Нестандартные условия: ограничение ответственности, штрафные санкции, эксклюзивность' },
    { id: 'foreign', text: 'Контрагент — иностранное юридическое лицо' },
    { id: 'ip', text: 'Передача интеллектуальной собственности или лицензирование' },
    { id: 'gov', text: 'Контрагент — государственный орган или госпредприятие' },
    { id: 'longterm', text: 'Срок договора больше 1 года без права досрочного расторжения' },
    { id: 'nda', text: 'Есть обязательства о неразглашении (NDA) или конкурентные ограничения' },
    { id: 'jurisdiction', text: 'Применимое право или юрисдикция отличается от стандартных' }
  ];

  var VISA_FROM = 5001;      // §5.2: виза требуется начиная с этой суммы
  var APPROVAL_OVER = 10000; // §4.1: обязательное согласование свыше этой суммы

  function parseAmountInput(raw) {
    var s = String(raw).replace(/[\s  ]/g, '');
    if (!s) return null;
    var sep = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
    if (sep !== -1) {
      var tail = s.length - sep - 1;
      s = (tail === 1 || tail === 2)
        ? s.slice(0, sep).replace(/[.,]/g, '') + '.' + s.slice(sep + 1)
        : s.replace(/[.,]/g, '');
    }
    var n = Number(s);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  function tierFor(amount) {
    // Пороги в документе целые, между ступенями есть зазоры (5 000 и 5 001).
    // Берём первую ступень, чей потолок покрывает сумму: при попадании в зазор
    // применяется более строгое требование.
    return registry.MATRIX.find(function (t) { return t.max === null || amount <= t.max; }) || null;
  }

  function calcResult(amount, standard, checked) {
    var tier = tierFor(amount);
    var triggers = TRIGGERS.filter(function (t) { return checked[t.id]; });

    // Требование визы берём ИЗ ВЫБРАННОЙ СТУПЕНИ, а не из отдельной константы:
    // иначе вердикт может разойтись с таблицей, которую видит пользователь.
    // На 5 000,50 ступень уже «EUR 5 001 — 25 000», значит виза требуется.
    // \b в JavaScript опирается на ASCII-класс \w, поэтому после кириллического
    // «Нет» границы слова нет и регулярка с \b молча не срабатывает.
    var visaText = String(tier ? tier.visa : '').trim().toLowerCase();
    var visaByMatrix = !!tier && visaText.indexOf('нет') !== 0;
    var approvalByAmount = amount > APPROVAL_OVER;
    var approvalByTrigger = triggers.length > 0;
    var mustApprove = approvalByAmount || approvalByTrigger;

    var collisions = [];
    // Основная коллизия документа: §5.2 требует визу с 5 001, §4.1 говорит об
    // обязательном согласовании только свыше 10 000.
    if (visaByMatrix && !approvalByAmount) {
      collisions.push({
        title: 'Пороги расходятся',
        text: '§5.2 требует визу юридического отдела начиная с EUR 5 001. §4.1 предписывает обязательное согласование при стоимости свыше EUR 10 000. Ваша сумма попадает между ними. Применяется более строгое требование: виза нужна.',
        refs: ['§5.2', '§4.1']
      });
    }
    // Третья коллизия: §4.2 разрешает типовой NDA на любую сумму, §4.1 требует
    // согласования при любых обязательствах о неразглашении.
    if (checked.nda) {
      collisions.push({
        title: 'NDA — правила расходятся',
        text: '§4.2 разрешает типовой NDA без дополнительного согласования при любой стоимости. §4.1 требует обязательного согласования, если договор содержит обязательства о неразглашении. Применяется более строгое требование: согласование нужно.',
        refs: ['§4.2', '§4.1']
      });
    }
    if (standard && mustApprove) {
      collisions.push({
        title: 'Типовой договор не снимает согласование',
        text: 'Типовой договор без изменений освобождает от согласования только в пределах порогов §4.1. Здесь порог превышен либо есть неценовое основание, поэтому освобождение не действует.',
        refs: ['§4.2', '§4.1']
      });
    }

    return {
      tier: tier,
      visaByMatrix: visaByMatrix,
      mustApprove: mustApprove,
      approvalByAmount: approvalByAmount,
      triggers: triggers,
      collisions: collisions,
      standard: standard
    };
  }

  function renderCalc() {
    var raw = $('calc-amount').value;
    var amount = parseAmountInput(raw);
    var out = $('calc-out');

    if (amount === null) {
      out.innerHTML = '<p class="calc-hint">Введите сумму договора в евро — покажу подписанта, требование визы и все правила документа, которые к ней применяются.</p>';
      return;
    }

    var standard = $('calc-standard').checked;
    var checked = {};
    TRIGGERS.forEach(function (t) {
      var box = document.querySelector('[data-trigger="' + t.id + '"]');
      checked[t.id] = !!(box && box.checked);
    });

    var r = calcResult(amount, standard, checked);
    var html = '';

    html += '<div class="calc-verdict ' + (r.mustApprove || r.visaByMatrix ? 'need' : 'free') + '">' +
      '<b>' + (r.mustApprove || r.visaByMatrix
        ? 'Согласование с юридическим отделом требуется'
        : 'Согласование не требуется') + '</b>' +
      '<span>' + esc(money(amount) + ' EUR') + '</span></div>';

    if (r.tier) {
      html += '<div class="calc-row"><span class="k">Подписант</span><span class="v">' + esc(r.tier.signer) + '</span>' +
        '<span class="src">§5.2, строка «' + esc(r.tier.label) + '»</span></div>';
      html += '<div class="calc-row"><span class="k">Виза юротдела</span><span class="v">' + esc(r.tier.visa) + '</span>' +
        '<span class="src">§5.2</span></div>';
    }

    html += '<div class="calc-row"><span class="k">Порог §4.1</span><span class="v">' +
      (r.approvalByAmount
        ? 'Превышен: стоимость больше EUR 10 000 за весь срок'
        : 'Не превышен: стоимость не больше EUR 10 000') + '</span><span class="src">§4.1</span></div>';

    if (r.triggers.length) {
      html += '<div class="calc-row"><span class="k">Неценовые основания</span><span class="v">' +
        r.triggers.map(function (t) { return esc(t.text); }).join('<br>') +
        '</span><span class="src">§4.1</span></div>';
    }

    r.collisions.forEach(function (c) {
      html += '<div class="calc-collide"><b>' + esc(c.title) + '</b>' + esc(c.text) +
        '<span class="src">' + esc(c.refs.join(' и ')) + '</span></div>';
    });

    html += renderThreshold({
      title: registry.MATRIX_TITLE,
      source_ref: '§5.2',
      source_page: registry.MATRIX_PAGE,
      marker: { label: money(amount) + ' EUR' },
      highlight: r.tier ? r.tier.label : null,
      items: registry.MATRIX
    });

    html += '<button type="button" class="calc-ask" id="calc-ask">Спросить то же самое у ассистента</button>';

    out.innerHTML = html;
    var askBtn = $('calc-ask');
    if (askBtn) {
      askBtn.addEventListener('click', function () {
        ask('Договор на ' + money(amount) + ' евро — кто подписывает и нужна ли виза юридического отдела?');
      });
    }
  }

  function buildCalc() {
    var box = $('calc-triggers');
    TRIGGERS.forEach(function (t) {
      box.appendChild(el('<li><label><input type="checkbox" data-trigger="' + esc(t.id) + '"><span>' + esc(t.text) + '</span></label></li>'));
    });
    $('calc-amount').addEventListener('input', renderCalc);
    $('calc-standard').addEventListener('change', renderCalc);
    box.addEventListener('change', renderCalc);
    renderCalc();
  }

  // ================================================================
  // ДОКУМЕНТ
  // ================================================================
  function docBlocks(blocks) {
    return (blocks || []).map(function (b) {
      if (b.kind === 'p') return '<p>' + esc(b.text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>') + '</p>';
      if (b.kind === 'note') return '<div class="doc-note">' + esc(b.text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>') + '</div>';
      if (b.kind === 'ul') return '<ul class="doc-ul">' + b.items.map(function (i) { return '<li>' + esc(i) + '</li>'; }).join('') + '</ul>';
      if (b.kind === 'table') {
        var tbl = renderTable({ title: '', source_ref: '', source_page: '', head: b.head, rows: b.rows });
        if (b.chartRef && chartFor(b.chartRef)) {
          tbl += '<button type="button" class="chart-toggle" data-chart="' + esc(b.chartRef) + '">Показать графиком</button>' +
            '<div class="chart-slot" data-slot="' + esc(b.chartRef) + '" hidden></div>';
        }
        return tbl;
      }
      return '';
    }).join('');
  }

  function renderDoc() {
    var root = $('doc-root');
    var top = docStack[docStack.length - 1];
    syncBackButton();

    var backRow = '<button type="button" class="doc-back" id="doc-back">← К разделам</button>';

    if (!top) {
      var html = '<p class="doc-lead">' + esc(doc.meta.title) + ' · ' + esc(doc.meta.org) +
        '<br>Редакция ' + esc(doc.meta.version) + ' от ' + esc(doc.meta.date) + '</p><ul class="doc-list">';
      doc.sections.forEach(function (s) {
        html += '<li><button type="button" data-open="section:' + esc(s.id) + '">' +
          '<b>' + esc(s.appendix ? 'Приложение ' + s.num : s.num + '. ' + s.title) + '</b>' +
          (s.appendix ? '<i>' + esc(s.title) + '</i>' : '<i>стр. ' + esc(s.page) + (s.subs.length ? ' · ' + s.subs.length + ' подраздела' : '') + '</i>') +
          '</button></li>';
      });
      html += '</ul><ul class="doc-list extra">' +
        '<li><button type="button" data-open="glossary"><b>Глоссарий</b><i>' + doc.glossary.length + ' терминов</i></button></li>' +
        '<li><button type="button" data-open="contacts"><b>Контакты юристов</b><i>' + doc.contacts.length + ' групп</i></button></li>' +
        '<li><button type="button" data-open="checklists"><b>Чеклисты</b><i>' + doc.checklists.length + ' списка</i></button></li>' +
        '</ul>';
      root.innerHTML = html;
    } else if (top.indexOf('section:') === 0) {
      var s = doc.sections.find(function (x) { return x.id === top.slice(8); });
      var h = '<h2 class="doc-h">' + esc(s.appendix ? 'Приложение ' + s.num + '. ' + s.title : s.num + '. ' + s.title) +
        '<span>стр. ' + esc(s.page) + '</span></h2>' + docBlocks(s.blocks);
      s.subs.forEach(function (sub) {
        h += '<h3 class="doc-sub">' + esc(sub.num) + ' ' + esc(sub.title) + '<span>стр. ' + esc(sub.page) + '</span></h3>' + docBlocks(sub.blocks);
      });
      root.innerHTML = backRow + h;
    } else if (top === 'glossary') {
      root.innerHTML = backRow + '<h2 class="doc-h">Глоссарий<span>Приложение А</span></h2>' +
        '<input class="doc-search" id="gl-search" placeholder="Поиск по термину">' +
        '<div id="gl-list">' + doc.glossary.map(function (g) {
          return '<div class="gl"><b>' + esc(g.term) + '</b><p>' + esc(g.definition) + '</p></div>';
        }).join('') + '</div>';
      $('gl-search').addEventListener('input', function (e) {
        var q = e.target.value.trim().toLowerCase();
        [].forEach.call($('gl-list').children, function (n) {
          n.hidden = q && n.textContent.toLowerCase().indexOf(q) === -1;
        });
      });
    } else if (top === 'contacts') {
      root.innerHTML = backRow + '<h2 class="doc-h">Контакты юридического отдела<span>§2.1, стр. 5</span></h2>' +
        doc.contacts.map(function (c) {
          return '<div class="gl"><b>' + esc(c.group) + '</b><p>' + esc(c.area) + '</p>' +
            '<a class="mail" href="mailto:' + esc(c.email) + '">' + esc(c.email) + '</a></div>';
        }).join('');
    } else if (top === 'checklists') {
      root.innerHTML = backRow + '<h2 class="doc-h">Контрольные списки<span>Приложение Б</span></h2>' +
        doc.checklists.map(function (c) {
          return renderChecklist({ title: c.title, source_ref: c.ref, source_page: c.page, items: c.items }, 'ck-' + c.id);
        }).join('');
      restoreChecks();
    }

    var backBtn = $('doc-back');
    if (backBtn) {
      backBtn.addEventListener('click', function () { docStack.pop(); renderDoc(); root.scrollTop = 0; });
    }

    [].forEach.call(root.querySelectorAll('[data-chart]'), function (b) {
      b.addEventListener('click', function () {
        var ref = b.getAttribute('data-chart');
        var slot = root.querySelector('[data-slot="' + ref + '"]');
        if (!slot) return;
        if (slot.hidden) {
          if (!slot.innerHTML) slot.innerHTML = renderChart(chartFor(ref));
          slot.hidden = false;
          b.textContent = 'Скрыть график';
        } else {
          slot.hidden = true;
          b.textContent = 'Показать графиком';
        }
      });
    });

    [].forEach.call(root.querySelectorAll('[data-open]'), function (b) {
      b.addEventListener('click', function () {
        docStack.push(b.getAttribute('data-open'));
        renderDoc();
        root.scrollTop = 0;
      });
    });
    root.addEventListener('change', onCheckChange);
  }

  // Отметки в чеклистах переживают закрытие приложения.
  function storeGet() {
    try { return JSON.parse(localStorage.getItem('ln-checks') || '{}'); } catch (e) { return {}; }
  }
  function onCheckChange(e) {
    var box = e.target;
    if (!box || box.type !== 'checkbox' || !box.dataset.ck) return;
    var s = storeGet();
    if (box.checked) s[box.dataset.ck] = 1; else delete s[box.dataset.ck];
    try { localStorage.setItem('ln-checks', JSON.stringify(s)); } catch (err) {}
  }
  function restoreChecks() {
    var s = storeGet();
    [].forEach.call(document.querySelectorAll('[data-ck]'), function (b) {
      if (s[b.dataset.ck]) b.checked = true;
    });
  }


  // ================================================================
  // КВИЗ
  // ================================================================
  // Банк вопросов сгенерирован механически из таблиц документа: правильный
  // ответ — дословная ячейка источника. Модель в этом не участвует.
  var quizBank = null;
  var quizRun = null;
  var QUIZ_LEN = 10;

  function quizBest() {
    try { return Number(localStorage.getItem('ln-quiz-best') || 0); } catch (e) { return 0; }
  }
  function quizSaveBest(n) {
    try { if (n > quizBest()) localStorage.setItem('ln-quiz-best', String(n)); } catch (e) {}
  }

  function quizStart() {
    var pool = quizBank.items.slice();
    for (var i = pool.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    quizRun = { items: pool.slice(0, QUIZ_LEN), idx: 0, right: 0, answered: false };
    renderQuiz();
  }

  function renderQuiz() {
    var root = $('quiz-root');
    if (!root) return;
    if (!quizBank) { root.innerHTML = '<p class="calc-hint">Банк вопросов не загрузился.</p>'; return; }

    if (!quizRun) {
      root.innerHTML = '<p class="calc-lead">Проверьте, насколько хорошо вы знаете руководство. ' +
        QUIZ_LEN + ' вопросов из ' + quizBank.total + '. Ответы взяты дословно из документа, у каждого показана ссылка на пункт.</p>' +
        (quizBest() ? '<p class="quiz-best">Лучший результат: ' + quizBest() + ' из ' + QUIZ_LEN + '</p>' : '') +
        '<button type="button" class="quiz-go" id="quiz-start">Начать</button>';
      $('quiz-start').addEventListener('click', quizStart);
      return;
    }

    if (quizRun.idx >= quizRun.items.length) {
      quizSaveBest(quizRun.right);
      root.innerHTML = '<div class="quiz-done"><b>' + quizRun.right + ' из ' + quizRun.items.length + '</b>' +
        '<span>' + (quizRun.right === quizRun.items.length ? 'Безошибочно.'
          : quizRun.right >= quizRun.items.length * 0.7 ? 'Хороший результат.'
          : 'Стоит заглянуть во вкладку «Документ».') + '</span></div>' +
        '<button type="button" class="quiz-go" id="quiz-again">Пройти ещё раз</button>';
      $('quiz-again').addEventListener('click', quizStart);
      return;
    }

    var q = quizRun.items[quizRun.idx];
    root.innerHTML =
      '<div class="quiz-top"><span>Вопрос ' + (quizRun.idx + 1) + ' из ' + quizRun.items.length + '</span>' +
      '<span>Верно: ' + quizRun.right + '</span></div>' +
      '<div class="quiz-bar"><span style="width:' + (quizRun.idx / quizRun.items.length * 100) + '%"></span></div>' +
      '<p class="quiz-q">' + esc(q.q) + '</p>' +
      '<ul class="quiz-opts">' + q.options.map(function (o, i) {
        return '<li><button type="button" data-opt="' + i + '">' + esc(o) + '</button></li>';
      }).join('') + '</ul>' +
      '<div id="quiz-after"></div>';

    [].forEach.call(root.querySelectorAll('[data-opt]'), function (b) {
      b.addEventListener('click', function () {
        if (quizRun.answered) return;
        quizRun.answered = true;
        var chosen = q.options[Number(b.getAttribute('data-opt'))];
        var ok = chosen === q.answer;
        if (ok) quizRun.right++;

        [].forEach.call(root.querySelectorAll('[data-opt]'), function (x) {
          var v = q.options[Number(x.getAttribute('data-opt'))];
          x.disabled = true;
          if (v === q.answer) x.classList.add('right');
          else if (v === chosen) x.classList.add('wrong');
        });

        $('quiz-after').innerHTML =
          '<div class="quiz-src">' + (ok ? 'Верно. ' : 'Правильный ответ выделен. ') + esc(q.source) + '</div>' +
          '<button type="button" class="quiz-go" id="quiz-next">' +
          (quizRun.idx + 1 >= quizRun.items.length ? 'Показать результат' : 'Дальше') + '</button>';
        $('quiz-next').addEventListener('click', function () {
          quizRun.idx++; quizRun.answered = false; renderQuiz();
          var pane = $('tab-quiz'); if (pane) pane.scrollTop = 0;
        });
      });
    });
  }

  // ================================================================
  // СТАРТ
  // ================================================================
  Promise.all([
    fetch('doc.json').then(function (r) { return r.json(); }),
    fetch('charts.json').then(function (r) { return r.json(); }).catch(function () { return { charts: {} }; }),
    fetch('quiz.json').then(function (r) { return r.json(); }).catch(function () { return null; }),
    fetch('catalogue.json').then(function (r) { return r.json(); }).catch(function () { return null; })
  ])
    .then(function (all) {
      var d = all[0];
      chartPresets = all[1].charts || {};
      quizBank = all[2];
      catalogue = all[3];
      doc = d;

      // Помечаем блоки-таблицы номером раздела, чтобы найти для них пресет.
      d.sections.forEach(function (sec) {
        sec.blocks.forEach(function (b) { if (b.kind === 'table') b.chartRef = sec.ref; });
        sec.subs.forEach(function (sub) {
          sub.blocks.forEach(function (b) { if (b.kind === 'table') b.chartRef = sub.ref; });
        });
      });
      var m = d.tables.find(function (t) { return t.ref === '§5.2'; });
      registry = {
        MATRIX_TITLE: m.title,
        MATRIX_PAGE: m.page,
        MATRIX: m.rows.filter(function (r) { return /EUR/.test(r[0]); }).map(function (r) {
          var nums = (r[0].match(/\d[\d\s ]*/g) || []).map(function (n) { return Number(n.replace(/[\s ]/g, '')); });
          var min = 0, max = null;
          if (/^До\s/i.test(r[0])) { min = 0; max = nums[0]; }
          else if (/^Свыше\s/i.test(r[0])) { min = nums[0] + 1; max = null; }
          else { min = nums[0]; max = nums[1]; }
          return { label: r[0], min: min, max: max, signer: r[1], visa: r[2] };
        })
      };
      buildCalc();
      renderDoc();
      renderQuiz();
      showTab('chat');
    })
    .catch(function () {
      $('tab-calc').innerHTML = '<p class="calc-hint">Не удалось загрузить документ.</p>';
      $('tab-doc').innerHTML = '<p class="calc-hint">Не удалось загрузить документ.</p>';
      showTab('chat');
    });
})();
