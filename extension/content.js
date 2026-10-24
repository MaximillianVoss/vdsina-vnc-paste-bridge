(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory(require("./core.js"));
  else {
    const ui = factory(root.VncPasteCore);
    root.VncPasteUi = ui;
    if (root.top === root && root.VncPasteCore.isTargetUrl(root.location.href)) ui.mount(root);
  }
}(typeof globalThis === "object" ? globalThis : this, function (core) {
  "use strict";
  const PROTOCOL = "vnc-paste-bridge/v1";

  function createPanel(documentObject) {
    const panel = documentObject.createElement("section");
    panel.id = "vpb-widget";
    panel.setAttribute("aria-label", "Вставка в VNC");
    panel.innerHTML = [
      '<header class="vpb-header"><div class="vpb-brand"><span class="vpb-brand-icon" aria-hidden="true">&gt;_</span><div><h2>Вставка в VNC</h2><p>Команды под вашим контролем</p></div></div><div class="vpb-header-actions"><span class="vpb-version">1.1.1</span><button type="button" data-vpb="collapse" aria-label="Свернуть панель" aria-expanded="true" aria-controls="vpb-body">−</button></div></header>',
      '<div id="vpb-body" data-vpb="body">',
      '<div class="vpb-target-card"><div class="vpb-card-heading"><span>Текущее соединение</span><span data-vpb="target-state" class="vpb-target-state">Не проверено</span></div><p data-vpb="target" class="vpb-target">Нажмите «Проверить», чтобы определить сервер.</p></div>',
      '<details class="vpb-help" data-vpb="help"><summary>Как пользоваться</summary><ol><li>Вставьте в поле одну команду без переносов строк. Убедитесь, что в консоли открыта нужная VPS и строка ввода пуста.</li><li>Нажмите «Проверить» и сверьте сервер. Проверка не вводит текст в консоль.</li><li>Нажмите «Отправить текст» один раз: финальный Enter не добавляется. Дождитесь окончания и сверьте строку в консоли. Повторная отправка вставит текст ещё раз.</li><li>Для выполнения снова нажмите «Проверить», затем «Отдельный Enter». Проверьте ответ сервера.</li></ol><p>ASCII — английские буквы, цифры, обычные пробелы и знаки. Кириллица, типографские кавычки, emoji и Tab не поддерживаются.</p><p>«Отправить текст» доступна после проверки непустого текста и соединения; при LF нужно отдельное разрешение. «Отдельный Enter» тоже требует новой проверки. Во время передачи поля и проверка заблокированы, доступен «Стоп».</p><p>«Стоп» прерывает оставшуюся очередь, но не удаляет уже введённое. «Очистить» очищает только поле расширения.</p><a href="https://github.com/MaximillianVoss/vdsina-vnc-paste-bridge/blob/main/docs/USER_GUIDE.md" target="_blank" rel="noopener noreferrer">Открыть полный мануал</a></details>',
      '<div class="vpb-editor-heading"><label for="vpb-text">Текст ASCII</label><span id="vpb-text-count" data-vpb="text-count">0 символов</span></div>',
      '<textarea id="vpb-text" data-vpb="text" spellcheck="false" autocomplete="off" autocapitalize="off" aria-describedby="vpb-text-hint vpb-text-count" placeholder="Вставьте команду или код…"></textarea>',
      '<div class="vpb-editor-footer"><span id="vpb-text-hint">Латиница, цифры и знаки. Без кириллицы и Tab.</span><button type="button" data-vpb="clear" class="vpb-text-button" aria-describedby="vpb-clear-help">Очистить</button></div>',
      '<label class="vpb-file-label" for="vpb-file"><span>Импортировать файл <small>.txt · .sh · .py · packet.json</small></span><input id="vpb-file" type="file" data-vpb="file" accept=".txt,.sh,.py,.json,text/plain,application/json"></label>',
      '<div data-vpb="metrics" class="vpb-metrics" hidden><div><span>Символов</span><strong data-vpb="metric-characters">—</strong></div><div><span>Пакетов</span><strong data-vpb="metric-batches">—</strong></div><div><span>Паузы очереди ≈</span><strong data-vpb="metric-duration">—</strong></div></div>',
      '<div class="vpb-actions"><button type="button" data-vpb="preview" aria-describedby="vpb-preview-help"><span class="vpb-step" aria-hidden="true">1</span>Проверить</button><button type="button" data-vpb="send" aria-describedby="vpb-send-help" disabled><span class="vpb-step" aria-hidden="true">2</span>Отправить текст</button><button type="button" data-vpb="stop" aria-describedby="vpb-stop-help" disabled>Стоп</button></div>',
      '<div class="vpb-status-card" data-vpb="status-card"><p data-vpb="status" class="vpb-status" role="status" aria-live="polite">Добавьте текст и проверьте соединение.</p><div data-vpb="progress-region" class="vpb-progress" hidden><div><span>Передано браузером</span><span data-vpb="progress-count">0 / 0</span></div><progress data-vpb="progress-bar" max="1" value="0" aria-label="Передано браузером"></progress></div></div>',
      '<p class="vpb-note vpb-receipt-note">Передача браузером не подтверждает получение или выполнение на сервере.</p>',
      '<div class="vpb-enter-card"><div><strong>Выполнить отдельным действием</strong><p>Enter может выполнить команду. Для него нужна новая проверка после передачи текста.</p></div><button type="button" data-vpb="enter" aria-describedby="vpb-enter-help" disabled>Отдельный Enter</button></div>',
      '<div class="vpb-sr-only"><p id="vpb-preview-help" data-vpb="preview-help"></p><p id="vpb-send-help" data-vpb="send-help"></p><p id="vpb-stop-help" data-vpb="stop-help"></p><p id="vpb-clear-help" data-vpb="clear-help"></p><p id="vpb-enter-help" data-vpb="enter-help"></p></div>',
      '<details class="vpb-advanced" data-vpb="advanced"><summary>Параметры и SHA-256</summary><div class="vpb-advanced-body">',
      '<p id="vpb-settings-help" class="vpb-settings-help">По умолчанию: 256 символов в порции, 12 мс между символами и 120 мс между порциями. Обычно оставляйте эти значения. «Паузы очереди» — оценка задержек отправки: фактический ввод может занять больше времени. Это не срок выполнения команды.</p>',
      '<div class="vpb-options">',
      '<label>Пакет<input type="number" data-vpb="batch" min="1" max="256" step="1" value="256" aria-describedby="vpb-settings-help" title="Число символов в порции: от 1 до 256. Обычно оставляйте 256."></label>',
      '<label>Символ, мс<input type="number" data-vpb="char-delay" min="8" max="100" step="1" value="12" aria-describedby="vpb-settings-help" title="Пауза перед следующим символом в миллисекундах. Обычно оставляйте 12."></label>',
      '<label>Пакет, мс<input type="number" data-vpb="batch-delay" min="80" max="2000" step="1" value="120" aria-describedby="vpb-settings-help" title="Пауза между порциями в миллисекундах. Обычно оставляйте 120."></label>',
      '</div>',
      '<label for="vpb-newlines">Переносы строк LF</label>',
      '<select id="vpb-newlines" data-vpb="newline" aria-describedby="vpb-lf-help"><option value="reject">Запретить — по умолчанию</option><option value="enter">Каждый LF отправить как Enter</option></select>',
      '<p id="vpb-lf-help" class="vpb-settings-help">LF — перенос строки. По умолчанию переносы запрещены, чтобы случайно не выполнить команды.</p>',
      '<p class="vpb-warning" data-vpb="lf-warning" hidden>Каждый LF нажмёт Enter и может выполнить строку. CR, Tab и Unicode не поддерживаются.</p>',
      '<label class="vpb-ack" data-vpb="ack-label" hidden><input type="checkbox" data-vpb="ack">Разрешаю Enter для каждого LF в этом тексте</label>',
      '<pre data-vpb="details" aria-describedby="vpb-sha-help">Размер и SHA-256 появятся после проверки.</pre>',
      '<p id="vpb-sha-help" class="vpb-settings-help">SHA-256 — отпечаток текста для сверки пакета. Он не подтверждает, что сервер получил текст.</p>',
      '<div class="vpb-api-import"><label for="vpb-connection">Импорт из локального API <small>connection.json из CLI</small></label><input id="vpb-connection" type="file" data-vpb="connection" accept=".json,application/json"></div>',
      '</div></details>',
      '<p class="vpb-note vpb-footer-note">Финальный Enter не добавляется. Текст не сохраняется расширением.</p>',
      '</div>'
    ].join("");
    return panel;
  }

  function mount(windowObject, options) {
    const settings = options || {};
    const documentObject = windowObject.document;
    const old = documentObject.getElementById("vpb-widget");
    if (old) return old;
    const panel = createPanel(documentObject);
    documentObject.body.appendChild(panel);
    function element(name) { return panel.querySelector('[data-vpb="' + name + '"]'); }
    const c = {
      text: element("text"), file: element("file"), connection: element("connection"),
      batch: element("batch"), charDelay: element("char-delay"),
      batchDelay: element("batch-delay"), newline: element("newline"),
      warning: element("lf-warning"), ackLabel: element("ack-label"), ack: element("ack"),
      preview: element("preview"), send: element("send"), stop: element("stop"),
      enter: element("enter"), clear: element("clear"), status: element("status"),
      previewHelp: element("preview-help"), sendHelp: element("send-help"),
      stopHelp: element("stop-help"), clearHelp: element("clear-help"), enterHelp: element("enter-help"),
      details: element("details"), target: element("target"), targetState: element("target-state"),
      textCount: element("text-count"), metrics: element("metrics"),
      metricCharacters: element("metric-characters"), metricBatches: element("metric-batches"),
      metricDuration: element("metric-duration"), advanced: element("advanced"),
      progressRegion: element("progress-region"), progressBar: element("progress-bar"),
      progressCount: element("progress-count"), statusCard: element("status-card"),
      collapse: element("collapse"), body: element("body")
    };
    const channel = crypto.randomUUID();
    const pending = new Map();
    let revision = 0;
    let packet = null;
    let imported = null;
    let targetId = null;
    let busy = false;
    let activeId = null;
    let activeKind = null;
    let lastProgress = 0;
    let watchdog = null;

    function status(message, state) {
      c.status.textContent = message;
      c.status.dataset.state = state || "idle";
      c.statusCard.dataset.state = state || "idle";
    }
    function textCount() {
      c.textCount.textContent = Array.from(c.text.value).length.toLocaleString("ru-RU") + " символов";
    }
    function showProgress(sent, total) {
      c.progressRegion.hidden = false;
      c.progressBar.max = Math.max(1, total);
      c.progressBar.value = Math.min(sent, total);
      c.progressBar.setAttribute("aria-valuetext", sent + " из " + total + "; получение сервером не подтверждено");
      c.progressCount.textContent = sent.toLocaleString("ru-RU") + " / " + total.toLocaleString("ru-RU");
    }
    function updateButtons() {
      [c.text, c.file, c.connection, c.batch, c.charDelay, c.batchDelay,
        c.newline, c.preview, c.clear, c.ack].forEach(function (control) { control.disabled = busy; });
      const acknowledged = !packet || core.describe(packet).lf === 0 || c.ack.checked;
      c.send.disabled = busy || !packet || !targetId || !acknowledged || packet.code_points === 0;
      c.enter.disabled = busy || !targetId;
      c.stop.disabled = !busy;
      function explain(button, description, message) {
        button.setAttribute("title", message);
        description.textContent = message;
      }
      explain(c.preview, c.previewHelp, busy ?
        "Недоступно во время передачи. Дождитесь окончания или нажмите «Стоп»." :
        "Проверяет текст и текущее соединение. Не вводит текст и не нажимает Enter.");
      explain(c.send, c.sendHelp, busy ?
        "Передача уже идёт. Дождитесь окончания или нажмите «Стоп»." : !packet || !targetId ?
        "Сначала нажмите «Проверить». Передаёт текст без финального Enter; повторная отправка вставит его ещё раз." : !acknowledged ?
        "Для отправки разрешите Enter для каждого LF. Этот режим может выполнить строки." : packet.code_points === 0 ?
        "Поле пустое. Добавьте текст и снова нажмите «Проверить»." :
        core.describe(packet).lf > 0 ?
        "Каждый LF нажмёт Enter и может выполнить строку. Финальный Enter не добавляется. Повторная отправка вставит текст ещё раз." :
        "Передаёт проверенный текст без финального Enter. Повторная отправка вставит его ещё раз.");
      explain(c.enter, c.enterHelp, busy ?
        "Недоступно во время передачи. Дождитесь окончания и сверьте строку в консоли." : !targetId ?
        "Сначала нажмите «Проверить», даже если текст уже передан. Затем Enter может выполнить строку в консоли." :
        "Нажимает Enter один раз и может выполнить строку в консоли. Проверьте ответ сервера.");
      explain(c.stop, c.stopHelp, busy ?
        "Останавливает оставшуюся очередь. Уже введённые в консоль символы не удаляет." :
        "Доступно только во время передачи. Уже введённые в консоль символы не удаляет.");
      explain(c.clear, c.clearHelp, busy ?
        "Недоступно во время передачи. Дождитесь окончания или нажмите «Стоп»." :
        "Очищает только поле расширения. Уже введённый в консоль текст не удаляет.");
    }
    function invalidate(message) {
      revision += 1; packet = null; imported = null; targetId = null;
      c.ack.checked = false;
      c.details.textContent = "Нужна новая проверка размера, SHA-256 и соединения.";
      c.targetState.textContent = "Нужна проверка";
      c.targetState.dataset.state = "unchecked";
      c.metrics.hidden = true;
      c.progressRegion.hidden = true;
      textCount();
      if (message) status(message);
      updateButtons();
    }
    function newlineUi() {
      c.warning.hidden = c.newline.value !== "enter";
      c.ackLabel.hidden = c.newline.value !== "enter";
      if (c.newline.value === "enter") c.advanced.open = true;
    }
    function targetDisplay(target) {
      c.target.textContent = "Сервер: " + target.title +
        "\nIP: " + (target.ip || "не определён");
      c.targetState.textContent = "Проверено";
      c.targetState.dataset.state = "checked";
    }
    function request(kind, extra) {
      const id = crypto.randomUUID();
      const message = Object.assign({
        protocol: PROTOCOL, direction: "request", channel: channel, id: id, kind: kind
      }, extra || {});
      return new Promise(function (resolve, reject) {
        const timer = setTimeout(function () {
          pending.delete(id);
          reject(new core.PasteError("BRIDGE_TIMEOUT", "Bridge не ответил. Отправка закрыта; автоповтора нет."));
        }, 3000);
        pending.set(id, { resolve: resolve, reject: reject, timer: timer });
        windowObject.postMessage(message, windowObject.location.origin);
      });
    }
    function stopWatchdog() { if (watchdog) clearInterval(watchdog); watchdog = null; }
    function finished(progress) {
      const completedKind = activeKind;
      const completedWithLf = completedKind === "start" && packet && core.describe(packet).lf > 0;
      activeKind = null;
      busy = false; activeId = null; packet = null; imported = null; targetId = null;
      revision += 1; stopWatchdog();
      const label = progress.state === "browser-sent" ? "Передано браузером" :
        progress.state === "uncertain" ? "Результат неизвестен" :
        progress.state === "stopped" ? "Остановлено до отправки" : "Отправка закрыта";
      if (progress.state === "browser-sent") {
        status(completedKind === "enter" ?
          "Enter передан браузером. Проверьте ответ в консоли; выполнение на сервере ещё не подтверждено." :
          completedWithLf ?
          "Передано браузером: " + progress.browser_sent + "/" + progress.total +
          ". LF переданы как Enter и могли выполнить строки. Проверьте консоль и ответ сервера. Отдельный Enter нужен только для оставшейся незавершённой строки, после новой проверки. Повторная отправка вставит текст ещё раз." :
          "Передано браузером: " + progress.browser_sent + "/" + progress.total +
          ". Сверьте строку в консоли. Для выполнения: снова «Проверить», затем «Отдельный Enter». Повторная отправка вставит текст ещё раз.", progress.state);
      } else {
        status(label + ": " + progress.browser_sent + "/" + progress.total +
          ". " + (progress.message || "") + " Для следующего действия нужна новая проверка.", progress.state);
      }
      showProgress(progress.browser_sent, progress.total);
      c.targetState.textContent = "Нужна проверка";
      c.targetState.dataset.state = "unchecked";
      updateButtons();
    }
    function receive(event) {
      const m = event.data;
      if (event.source !== windowObject || event.origin !== windowObject.location.origin ||
          !m || m.protocol !== PROTOCOL || m.direction !== "response" || m.channel !== channel) return;
      if (m.kind === "result" && pending.has(m.id)) {
        const item = pending.get(m.id); pending.delete(m.id); clearTimeout(item.timer);
        if (m.ok) item.resolve(m);
        else item.reject(new core.PasteError(m.code || "BRIDGE_ERROR", m.error || "Bridge отказал."));
      } else if (m.id === activeId && m.kind === "progress" && m.status) {
        lastProgress = performance.now();
        status("Отправка браузером: " + m.status.browser_sent + "/" + m.status.total +
          ". Стоп прерывает оставшуюся очередь.", "sending");
        showProgress(m.status.browser_sent, m.status.total);
      } else if (m.id === activeId && m.kind === "finished" && m.status) finished(m.status);
    }
    windowObject.addEventListener("message", receive);

    async function preview() {
      if (busy) return;
      const ownRevision = revision;
      c.preview.disabled = true;
      try {
        const checked = imported ? await core.validatePacket(imported) :
          await core.createPacket(c.text.value, {
            batch_size: Number(c.batch.value), character_delay_ms: Number(c.charDelay.value),
            batch_delay_ms: Number(c.batchDelay.value), newline_mode: c.newline.value
          });
        const d = core.describe(checked);
        if (d.estimated_ms + 5000 > core.SESSION_TIMEOUT_MS) {
          throw new core.PasteError("DURATION_LIMIT", "Очередь превышает 10 минут. Подготовьте меньший текст.");
        }
        const connection = await request("probe");
        if (ownRevision !== revision || busy) return;
        packet = checked; targetId = connection.target_id;
        targetDisplay(connection.target);
        c.progressRegion.hidden = true;
        c.metrics.hidden = false;
        c.metricCharacters.textContent = d.code_points.toLocaleString("ru-RU");
        c.metricBatches.textContent = d.batches.toLocaleString("ru-RU");
        c.metricDuration.textContent = (d.estimated_ms / 1000).toFixed(1) + " с";
        c.details.textContent = [
          "UTF-8: " + d.utf8_bytes + " байт; символов: " + d.code_points,
          "Пакетов: " + d.batches + "; размер: " + checked.batch_size,
          "Паузы: символ " + checked.character_delay_ms + " мс; пакет " + checked.batch_delay_ms + " мс",
          "Паузы очереди ≈ " + (d.estimated_ms / 1000).toFixed(1) + " с; лимит 10 мин",
          "LF → Enter: " + d.lf + "; финальный Enter: не добавляется",
          "SHA-256: " + d.sha256
        ].join("\n");
        if (checked.newline_mode === "enter") c.advanced.open = true;
        status(d.lf ? "Проверка готова. Явно разрешите Enter для каждого LF: он может выполнить строку." :
          "Проверено. «Отправить текст» вставляет без Enter. Для строки, уже введённой в консоль, выберите «Отдельный Enter».");
      } catch (error) {
        if (ownRevision !== revision || busy) return;
        packet = null; targetId = null;
        c.targetState.textContent = "Нужна проверка";
        c.targetState.dataset.state = "unchecked";
        c.metrics.hidden = true;
        status(error.message, "blocked");
      } finally { updateButtons(); }
    }

    async function start(kind) {
      if (busy || !targetId || (kind === "start" && !packet)) return;
      if (kind === "start" && core.describe(packet).lf > 0 && !c.ack.checked) return;
      busy = true; activeKind = kind; lastProgress = performance.now(); updateButtons();
      const id = crypto.randomUUID();
      activeId = id;
      const message = {
        protocol: PROTOCOL, direction: "request", channel: channel,
        id: id, kind: kind, target_id: targetId
      };
      if (kind === "start") message.packet = packet;
      status(kind === "enter" ? "Передаётся отдельный Enter…" : "Очередь запускается…", "sending");
      showProgress(0, kind === "start" ? packet.code_points : 1);
      // No retry: a timeout after Start always remains uncertain.
      watchdog = setInterval(function () {
        if (busy && performance.now() - lastProgress > 6500) {
          request("stop").catch(function () {});
          finished({ state: "uncertain", browser_sent: 0, total: kind === "start" ? packet.code_points : 1,
            message: "Прогресс не подтверждён; остановка запрошена. Проверьте сервер перед новым действием." });
        }
      }, 1000);
      const acceptanceTimer = setTimeout(function () {
        const item = pending.get(id);
        if (item) { pending.delete(id); item.reject(new core.PasteError("BRIDGE_TIMEOUT", "Start не подтверждён.")); }
      }, 3000);
      try {
        await new Promise(function (resolve, reject) {
          pending.set(id, { resolve: resolve, reject: reject, timer: acceptanceTimer });
          windowObject.postMessage(message, windowObject.location.origin);
        });
      } catch (error) {
        request("stop").catch(function () {});
        if (busy) finished({ state: "uncertain", browser_sent: 0, total: kind === "start" ? packet.code_points : 1,
          message: error.message + " Автоповтора нет." });
      }
    }

    async function readFile(file, maxBytes) {
      if (!file) throw new core.PasteError("NO_FILE", "Файл не выбран.");
      if (file.size > maxBytes) throw new core.PasteError("FILE_TOO_LARGE", "Файл превышает допустимый размер.");
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
    }
    function loadPacket(value) {
      invalidate();
      imported = value;
      c.text.value = value.text; c.batch.value = value.batch_size;
      c.charDelay.value = value.character_delay_ms; c.batchDelay.value = value.batch_delay_ms;
      c.newline.value = value.newline_mode;
      textCount();
      newlineUi();
      status("Пакет импортирован и проверен. Нажмите «Проверить» для текущего соединения.");
    }
    c.file.addEventListener("change", async function () {
      if (busy) return;
      const chosen = c.file.files[0];
      const ownRevision = revision;
      try {
        const source = await readFile(chosen, core.MAX_JSON_BYTES);
        if (ownRevision !== revision || busy) return;
        if (/\.json$/i.test(chosen.name)) {
          const checked = await core.validatePacket(JSON.parse(source));
          if (ownRevision !== revision || busy) return;
          loadPacket(checked);
        }
        else { invalidate(); c.text.value = source; textCount(); status("Текст импортирован. Нажмите «Проверить»."); }
      } catch (error) {
        if (ownRevision === revision && !busy) { invalidate(); status(error.message, "blocked"); }
      }
      c.file.value = "";
    });
    c.connection.addEventListener("change", async function () {
      if (busy) return;
      const ownRevision = revision;
      try {
        const connection = core.validateConnection(JSON.parse(await readFile(c.connection.files[0], 4096)));
        if (ownRevision !== revision || busy) return;
        const fetchPacket = settings.fetchPacket || function (value) {
          return chrome.runtime.sendMessage({ kind: "fetch-packet", connection: value });
        };
        const response = await fetchPacket(connection);
        if (ownRevision !== revision || busy) return;
        if (!response || !response.ok) throw new core.PasteError("API_IMPORT_ERROR",
          response && response.error ? response.error : "API import не подтверждён.");
        const checked = await core.validatePacket(response.packet);
        if (ownRevision !== revision || busy) return;
        loadPacket(checked);
      } catch (error) {
        if (ownRevision === revision && !busy) {
          invalidate();
          status(error instanceof core.PasteError ? error.message :
            "Не удалось прочитать и проверить connection.json. Проверьте файл и локальный API.", "blocked");
        }
      }
      c.connection.value = "";
    });
    [c.text, c.batch, c.charDelay, c.batchDelay].forEach(function (control) {
      control.addEventListener("input", function () { invalidate("Текст или параметры изменены. Нужна новая проверка."); });
    });
    c.newline.addEventListener("change", function () {
      invalidate("Режим LF изменён. Нужна новая проверка."); newlineUi();
    });
    c.ack.addEventListener("change", updateButtons);
    c.preview.addEventListener("click", preview);
    c.send.addEventListener("click", function () { start("start"); });
    c.enter.addEventListener("click", function () { start("enter"); });
    c.stop.addEventListener("click", function () {
      if (!busy) return;
      c.stop.disabled = true;
      status("Остановка запрошена. Уже переданные символы нельзя отозвать.", "uncertain");
      request("stop").catch(function () {
        if (busy) finished({ state: "uncertain", browser_sent: 0, total: packet ? packet.code_points : 1,
          message: "Остановка не подтверждена; проверьте сервер. Автоповтора нет." });
      });
    });
    c.clear.addEventListener("click", function () {
      if (busy) return;
      c.text.value = ""; invalidate("Поле расширения очищено. Уже введённый в консоль текст не удалён.");
    });
    c.collapse.addEventListener("click", function () {
      c.body.hidden = !c.body.hidden;
      c.collapse.textContent = c.body.hidden ? "+" : "−";
      c.collapse.setAttribute("aria-label", c.body.hidden ? "Развернуть панель" : "Свернуть панель");
      c.collapse.setAttribute("aria-expanded", String(!c.body.hidden));
    });
    windowObject.addEventListener("pagehide", function () {
      if (busy) windowObject.postMessage({
        protocol: PROTOCOL, direction: "request", channel: channel,
        id: crypto.randomUUID(), kind: "stop"
      }, windowObject.location.origin);
      stopWatchdog(); windowObject.removeEventListener("message", receive);
      pending.forEach(function (item) { clearTimeout(item.timer); }); pending.clear();
    }, { once: true });
    newlineUi(); textCount(); updateButtons();
    return panel;
  }

  return Object.freeze({ mount: mount });
}));
