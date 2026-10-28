/*
 * Oberfläche der Steuer-Belege-App.
 * Hält alle Stammdaten im Speicher (state) und schreibt jede Änderung sofort in IndexedDB.
 * Belege (Bilder/PDFs) werden nur bei Bedarf aus der Datenbank geladen.
 */
(function () {
  'use strict';

  const L = window.Logic;
  const DB = window.DB;

  const state = {
    entities: [],
    positions: [],
    categories: [],
    years: [],
    year: new Date().getFullYear(),
    view: { type: 'overview' },
  };

  let objectUrls = [];

  // ---------------------------------------------------------------------------
  // DOM-Hilfen

  const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'multiple', 'hidden']);

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    appendChildren(el, children);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (PROPS.has(k)) el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    return el;
  }

  function appendChildren(el, children) {
    for (const c of children) {
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) appendChildren(el, c);
      else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
  }

  function button(label, onclick, variant, attrs) {
    return h('button', Object.assign({ type: 'button', class: 'btn' + (variant ? ' btn-' + variant : ''), onclick }, attrs || {}), label);
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1).replace('.', ',') + ' MB';
  }

  // Läuft die App als Artifact in Claude, sind normale Downloads gesperrt;
  // dort wird über die Speichern-Funktion von Claude gespeichert.
  const inClaude = typeof (window.claude && window.claude.use) === 'function';

  async function download(filename, content, type) {
    const blob = content instanceof Blob ? content : new Blob([content], { type });
    if (inClaude) {
      const downloads = await window.claude.use('downloads');
      if (!downloads) {
        await alertDialog('Speichern nicht möglich', 'Dateien können in dieser Ansicht nicht gespeichert werden.');
        return;
      }
      try {
        await downloads.save({ filename, data: blob });
      } catch (e) {
        if (e && e.code !== 'declined') await alertDialog('Speichern nicht möglich', (e && e.message) || 'Unbekannter Fehler');
      }
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------------------------------------------------------------------------
  // Dialoge (ersetzen prompt/confirm)

  function openDialog({ title, content, confirmText, cancelText, danger }) {
    return new Promise((resolve) => {
      const dlg = h('dialog', { class: 'dialog' });
      const form = h('form', { method: 'dialog' },
        h('h3', null, title),
        content,
        h('div', { class: 'dialog-actions' },
          cancelText === null ? null : h('button', { type: 'button', class: 'btn', onclick: () => dlg.close('cancel') }, cancelText || 'Abbrechen'),
          h('button', { type: 'submit', value: 'ok', class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary') }, confirmText || 'OK')));
      dlg.append(form);
      document.body.append(dlg);
      dlg.addEventListener('close', () => {
        resolve(dlg.returnValue === 'ok');
        dlg.remove();
      });
      dlg.showModal();
    });
  }

  async function promptDialog(title, label, value, inputAttrs) {
    const input = h('input', Object.assign({ class: 'input', value: value || '', required: true, autofocus: true }, inputAttrs || {}));
    const ok = await openDialog({ title, content: h('label', { class: 'field' }, h('span', null, label), input), confirmText: 'Speichern' });
    return ok ? input.value.trim() : null;
  }

  function confirmDialog(title, text, confirmText, danger) {
    return openDialog({ title, content: h('p', null, text), confirmText, danger });
  }

  function alertDialog(title, text) {
    return openDialog({ title, content: h('p', null, text), cancelText: null });
  }

  // ---------------------------------------------------------------------------
  // Daten

  async function load() {
    const [entities, positions, categories, years, lastYear] = await Promise.all([
      DB.getAll('entities'),
      DB.getAll('positions'),
      DB.getMeta('categories', null),
      DB.getMeta('years', []),
      DB.getMeta('lastYear', null),
    ]);
    state.entities = entities.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    state.positions = positions.map((p) => L.createPosition(p));
    state.categories = categories || L.DEFAULT_CATEGORIES.slice();
    const yearSet = new Set(years.concat(state.positions.map((p) => p.year), [new Date().getFullYear()]));
    state.years = Array.from(yearSet).sort((a, b) => a - b);
    state.year = lastYear && yearSet.has(lastYear) ? lastYear : new Date().getFullYear();
    if (state.view.type === 'entity' && !entityById(state.view.id)) state.view = { type: 'overview' };
    resetUi();
  }

  function entityById(id) {
    return state.entities.find((e) => e.id === id);
  }

  function positionsFor(entityId, year) {
    return state.positions
      .filter((p) => p.entityId === entityId && p.year === year)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  function savePosition(p) {
    return DB.put('positions', p);
  }

  async function ensureCategory(name) {
    if (!state.categories.includes(name)) {
      state.categories.push(name);
      state.categories.sort((a, b) => a.localeCompare(b, 'de'));
      await DB.setMeta('categories', state.categories);
      renderCategoryList();
    }
  }

  async function setYear(year) {
    if (!(await confirmLeave())) {
      document.getElementById('year-select').value = String(state.year);
      return;
    }
    resetUi();
    state.year = year;
    if (!state.years.includes(year)) {
      state.years.push(year);
      state.years.sort((a, b) => a - b);
      await DB.setMeta('years', state.years);
    }
    await DB.setMeta('lastYear', year);
    render();
  }

  // ---------------------------------------------------------------------------
  // Aktionen

  /** Person, die gerade angezeigt wird (oder der das angezeigte Unternehmen gehört). */
  function currentPersonId() {
    const e = state.view.type === 'entity' ? entityById(state.view.id) : null;
    if (!e) return null;
    if (e.type === 'person') return e.id;
    const owner = L.ownerOf(e, state.entities);
    return owner ? owner.id : null;
  }

  /** Dialog für Name und (bei Unternehmen) Zuordnung zu einer Person. */
  async function entityDialog(title, type, name, ownerId) {
    const nameInput = h('input', {
      class: 'input', value: name || '', required: true, autofocus: true,
      placeholder: type === 'company' ? 'z.B. Muster GmbH' : 'z.B. Max Mustermann',
    });
    const persons = state.entities.filter((e) => e.type === 'person');
    const ownerSelect = type === 'company' ? h('select', { class: 'input' },
      h('option', { value: '' }, 'Keiner Person zugeordnet'),
      persons.map((p) => h('option', { value: p.id }, p.name))) : null;
    if (ownerSelect) ownerSelect.value = ownerId || '';
    const ok = await openDialog({
      title,
      content: h('div', { class: 'dialog-fields' },
        h('label', { class: 'field' }, h('span', null, 'Name'), nameInput),
        ownerSelect && persons.length ? h('label', { class: 'field' }, h('span', null, 'Gehört zu'), ownerSelect) : null),
      confirmText: 'Speichern',
    });
    if (!ok || !nameInput.value.trim()) return null;
    return { name: nameInput.value.trim(), ownerId: ownerSelect ? ownerSelect.value || null : null };
  }

  async function addEntity(type, ownerId) {
    if (!(await confirmLeave())) return;
    const label = type === 'company' ? 'Unternehmen' : 'Person';
    const preset = ownerId === undefined ? currentPersonId() : ownerId;
    const result = await entityDialog(label + ' hinzufügen', type, '', preset);
    if (!result) return;
    const entity = L.createEntity(type, result.name, result.ownerId);
    await DB.put('entities', entity);
    state.entities.push(entity);
    resetUi();
    state.view = { type: 'entity', id: entity.id };
    render();
  }

  async function editEntity(entity) {
    const result = await entityDialog('Bearbeiten', entity.type, entity.name, entity.ownerId);
    if (!result) return;
    entity.name = result.name;
    if (entity.type === 'company') entity.ownerId = result.ownerId;
    await DB.put('entities', entity);
    render();
  }

  async function deleteEntity(entity) {
    const positions = state.positions.filter((p) => p.entityId === entity.id);
    const companies = state.entities.filter((e) => e.type === 'company' && e.ownerId === entity.id);
    const ok = await confirmDialog(
      '„' + entity.name + '“ löschen?',
      'Dabei werden ' + positions.length + ' Position(en) aus allen Jahren samt Belegen endgültig gelöscht.' +
      (companies.length ? ' Die zugeordneten Unternehmen bleiben erhalten, sind dann aber keiner Person mehr zugeordnet.' : ''),
      'Endgültig löschen', true);
    if (!ok) return;
    for (const c of companies) c.ownerId = null;
    await DB.putMany('entities', companies);
    await DB.removeMany('attachments', positions.flatMap((p) => p.attachmentIds));
    await DB.removeMany('positions', positions.map((p) => p.id));
    await DB.remove('entities', entity.id);
    state.positions = state.positions.filter((p) => p.entityId !== entity.id);
    state.entities = state.entities.filter((e) => e.id !== entity.id);
    resetUi();
    state.view = { type: 'overview' };
    render();
  }

  async function copyFromPreviousYear(entity) {
    const sourceYear = state.years
      .filter((y) => y < state.year && positionsFor(entity.id, y).length)
      .pop();
    if (!sourceYear) {
      await alertDialog('Nichts zu übernehmen', 'Für „' + entity.name + '“ gibt es in früheren Jahren keine Positionen.');
      return;
    }
    const source = positionsFor(entity.id, sourceYear);
    const target = positionsFor(entity.id, state.year);
    const keep = h('input', { type: 'checkbox' });
    const preview = L.copyPositionsToYear(source, target, state.year, false);
    if (!preview.length) {
      await alertDialog('Nichts zu übernehmen', 'Alle Positionen aus ' + sourceYear + ' sind in ' + state.year + ' bereits vorhanden.');
      return;
    }
    const ok = await openDialog({
      title: 'Positionen aus ' + sourceYear + ' übernehmen',
      content: h('div', null,
        h('p', null, preview.length + ' Position(en) werden nach ' + state.year + ' kopiert. Belege werden nicht mitkopiert.'),
        h('ul', { class: 'dialog-list' }, preview.map((p) => h('li', null, p.title || 'Ohne Bezeichnung', h('span', { class: 'muted' }, ' · ' + p.category)))),
        h('label', { class: 'check' }, keep, ' Beträge mit übernehmen')),
      confirmText: 'Übernehmen',
    });
    if (!ok) return;
    const copies = L.copyPositionsToYear(source, target, state.year, keep.checked);
    await DB.putMany('positions', copies);
    state.positions.push(...copies);
    render();
  }

  // ---------------------------------------------------------------------------
  // Backup & Export

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function base64ToBlob(base64, type) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
  }

  async function exportBackup() {
    const attachments = await DB.getAll('attachments');
    const data = {
      app: 'steuer-belege',
      version: 1,
      exportedAt: new Date().toISOString(),
      entities: state.entities,
      positions: state.positions,
      categories: state.categories,
      years: state.years,
      attachments: await Promise.all(attachments.map(async (a) => {
        const { blob, ...rest } = a;
        return Object.assign(rest, { data: await blobToBase64(blob) });
      })),
    };
    const date = new Date().toISOString().slice(0, 10);
    download('steuer-belege-backup-' + date + '.json', JSON.stringify(data), 'application/json');
  }

  async function importBackup(file) {
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (e) {
      await alertDialog('Import fehlgeschlagen', 'Die Datei ist keine gültige Backup-Datei.');
      return;
    }
    if (!data || data.app !== 'steuer-belege' || !Array.isArray(data.positions)) {
      await alertDialog('Import fehlgeschlagen', 'Die Datei ist keine Backup-Datei dieser App.');
      return;
    }
    const exportedAt = new Date(data.exportedAt).toLocaleString('de-DE');
    const items = L.describeImport(state.entities, data);
    const checkboxes = items.map((item) => h('input', { type: 'checkbox', checked: true, value: item.entity.id }));
    const modeMerge = h('input', { type: 'radio', name: 'import-mode', value: 'merge', checked: true });
    const modeReplace = h('input', { type: 'radio', name: 'import-mode', value: 'replace' });
    const entityList = h('div', { class: 'import-list' },
      h('p', { class: 'muted' }, 'Welche Personen und Unternehmen sollen übernommen werden?'),
      items.length ? items.map((item, i) => h('label', { class: 'check import-item' },
        checkboxes[i],
        h('span', null,
          h('strong', null, item.entity.name),
          h('span', { class: 'muted' }, ' · ' + item.positionCount + ' Position(en)' +
            (item.years.length ? ' · ' + item.years.join(', ') : '')),
          h('span', { class: 'import-status' + (item.status === 'update' ? ' update' : '') },
            item.status === 'update'
              ? 'Schon vorhanden: wird auf den Stand des Exports gebracht'
              : item.sameName ? 'Neu (ein Eintrag mit diesem Namen existiert bereits)' : 'Neu')))) :
        h('p', null, 'Der Export enthält keine Personen oder Unternehmen.'));
    const syncList = () => { entityList.hidden = modeReplace.checked; };
    modeMerge.addEventListener('change', syncList);
    modeReplace.addEventListener('change', syncList);

    const ok = await openDialog({
      title: 'Backup / Export laden',
      content: h('div', { class: 'import-dialog' },
        h('p', null, 'Export vom ' + exportedAt),
        h('label', { class: 'check' }, modeMerge, h('span', null, h('strong', null, 'Zu meinen Daten hinzufügen'),
          h('br'), h('span', { class: 'muted' }, 'z.B. den Export deines Partners. Deine übrigen Daten bleiben erhalten.'))),
        h('label', { class: 'check' }, modeReplace, h('span', null, h('strong', null, 'Alle meine Daten ersetzen'),
          h('br'), h('span', { class: 'muted' }, 'z.B. zum Wiederherstellen oder für ein neues Gerät.'))),
        entityList),
      confirmText: 'Laden',
    });
    if (!ok) return;

    if (modeMerge.checked) {
      const selected = checkboxes.filter((c) => c.checked).map((c) => c.value);
      if (selected.length) await mergeImport(data, selected);
      return;
    }

    const sure = await confirmDialog('Wirklich alles ersetzen?',
      'Alle aktuell gespeicherten Daten werden durch den Export vom ' + exportedAt + ' ersetzt.', 'Ersetzen', true);
    if (!sure) return;
    await DB.clearAll();
    await DB.putMany('entities', data.entities || []);
    await DB.putMany('positions', data.positions);
    await DB.putMany('attachments', (data.attachments || []).map((a) => {
      const { data: base64, ...rest } = a;
      return Object.assign(rest, { blob: base64ToBlob(base64, a.type) });
    }));
    await DB.setMeta('categories', data.categories || L.DEFAULT_CATEGORIES.slice());
    await DB.setMeta('years', data.years || []);
    state.view = { type: 'overview' };
    await load();
    render();
  }

  async function mergeImport(data, selectedEntityIds) {
    const plan = L.planMerge(state, data, selectedEntityIds);
    const wanted = new Set(plan.addedAttachmentIds);
    const attachments = (data.attachments || [])
      .filter((a) => wanted.has(a.id))
      .map((a) => {
        const { data: base64, ...rest } = a;
        return Object.assign(rest, { blob: base64ToBlob(base64, a.type) });
      });
    // Erst den alten Stand entfernen, dann den neuen schreiben (IDs können gleich sein).
    await DB.removeMany('attachments', plan.removedAttachmentIds);
    await DB.removeMany('positions', plan.removedPositions.map((p) => p.id));
    await DB.putMany('entities', plan.entities);
    await DB.putMany('positions', plan.addedPositions);
    await DB.putMany('attachments', attachments);
    const categories = Array.from(new Set(state.categories.concat(data.categories || [])))
      .sort((a, b) => a.localeCompare(b, 'de'));
    await DB.setMeta('categories', categories);
    await DB.setMeta('years', Array.from(new Set(state.years.concat(data.years || []))));
    await load();
    renderCategoryList();
    render();
    await alertDialog('Übernommen',
      plan.entities.length + ' Person(en)/Unternehmen mit ' + plan.addedPositions.length +
      ' Position(en) und ' + attachments.length + ' Beleg(en) wurden übernommen.');
  }

  /** Auswahlmöglichkeiten für den Umfang eines Exports. */
  function scopeOptions() {
    const options = [['all', 'Alle Personen & Unternehmen']];
    for (const e of L.orderEntities(state.entities)) {
      const hasCompanies = e.type === 'person' && state.entities.some((c) => c.type === 'company' && c.ownerId === e.id);
      if (hasCompanies) options.push(['p:' + e.id, e.name + ' mit Unternehmen']);
      options.push(['e:' + e.id, hasCompanies ? e.name + ' (nur Person)' : e.name]);
    }
    return options;
  }

  function scopeLabel(scope) {
    const option = scopeOptions().find(([value]) => value === scope);
    return option ? option[1] : '';
  }

  function exportFilename(scope, ext) {
    const label = scope === 'all' ? '' : '-' + scopeLabel(scope).toLowerCase()
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return 'steuer-belege-' + state.year + label + '.' + ext;
  }

  async function exportDialog() {
    if (!state.entities.length) {
      await alertDialog('Nichts zu exportieren', 'Lege zuerst eine Person oder ein Unternehmen an.');
      return;
    }
    const scopeSelect = h('select', { class: 'input' }, scopeOptions().map(([value, label]) => h('option', { value }, label)));
    const current = state.view.type === 'entity' ? entityById(state.view.id) : null;
    const hasCompanies = current && state.entities.some((c) => c.ownerId === current.id);
    scopeSelect.value = !current ? 'all' : (hasCompanies ? 'p:' : 'e:') + current.id;
    const pdf = h('input', { type: 'radio', name: 'export-format', value: 'pdf', checked: true });
    const csv = h('input', { type: 'radio', name: 'export-format', value: 'csv' });
    const receipts = h('input', { type: 'checkbox', checked: true });
    const receiptsRow = h('label', { class: 'check' }, receipts, ' Belege (Fotos und PDFs) hinten anhängen');
    const sync = () => { receiptsRow.hidden = !pdf.checked; };
    pdf.addEventListener('change', sync);
    csv.addEventListener('change', sync);

    const ok = await openDialog({
      title: 'Export ' + state.year,
      content: h('div', { class: 'import-dialog' },
        h('label', { class: 'field' }, h('span', null, 'Umfang'), scopeSelect),
        h('label', { class: 'check' }, pdf, h('span', null, h('strong', null, 'PDF-Bericht'), h('br'),
          h('span', { class: 'muted' }, 'Übersicht und alle Positionen, z.B. für den Steuerberater.'))),
        h('label', { class: 'check' }, csv, h('span', null, h('strong', null, 'CSV-Tabelle'), h('br'),
          h('span', { class: 'muted' }, 'Zum Weiterrechnen in Excel oder Numbers.'))),
        receiptsRow),
      confirmText: 'Exportieren',
    });
    if (!ok) return;
    const scope = scopeSelect.value;
    if (csv.checked) exportCsv(scope);
    else await exportPdf(scope, receipts.checked);
  }

  function exportCsv(scope) {
    const entities = L.entitiesInScope(state.entities, scope);
    const byId = Object.fromEntries(state.entities.map((e) => [e.id, e]));
    const order = new Map(entities.map((e, i) => [e.id, i]));
    const positions = state.positions
      .filter((p) => p.year === state.year && order.has(p.entityId))
      .sort((a, b) => (order.get(a.entityId) - order.get(b.entityId)) ||
        a.category.localeCompare(b.category, 'de') || a.title.localeCompare(b.title, 'de', { numeric: true }));
    download(exportFilename(scope, 'csv'), L.buildCsv(positions, byId), 'text/csv;charset=utf-8');
  }

  let pdfLibPromise = null;

  /** pdf-lib erst bei Bedarf laden (ca. 500 KB). In Claude vom CDN, sonst aus der App. */
  function loadPdfLib() {
    if (window.PDFLib) return Promise.resolve(window.PDFLib);
    if (!pdfLibPromise) {
      pdfLibPromise = new Promise((resolve, reject) => {
        const script = h('script', {
          src: inClaude ? 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js' : 'js/vendor/pdf-lib.min.js',
        });
        script.onload = () => resolve(window.PDFLib);
        script.onerror = () => { pdfLibPromise = null; reject(new Error('PDF-Bibliothek konnte nicht geladen werden')); };
        document.head.append(script);
      });
    }
    return pdfLibPromise;
  }

  /** Bilder, die pdf-lib nicht direkt kann (z.B. HEIC, WebP), über ein Canvas in JPEG umwandeln. */
  async function toJpeg(blob) {
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Bild konnte nicht gelesen werden'));
        image.src = url;
      });
      const canvas = h('canvas', { width: String(img.naturalWidth), height: String(img.naturalHeight) });
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      const jpeg = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
      return new Uint8Array(await jpeg.arrayBuffer());
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function exportPdf(scope, includeReceipts) {
    const busy = h('div', { class: 'busy', role: 'status' }, h('div', { class: 'busy-box' }, 'PDF wird erstellt …'));
    document.body.append(busy);
    let bytes;
    try {
      const PDFLib = await loadPdfLib();
      bytes = await window.PdfReport.build({
        PDFLib,
        Logic: L,
        year: state.year,
        title: 'Steuer-Belege ' + state.year,
        subtitle: scopeLabel(scope),
        entities: L.entitiesInScope(state.entities, scope),
        allEntities: state.entities,
        positions: state.positions.filter((p) => p.year === state.year),
        includeReceipts,
        getAttachment: (id) => DB.get('attachments', id),
        toJpeg,
      });
    } catch (e) {
      busy.remove();
      await alertDialog('PDF konnte nicht erstellt werden', (e && e.message) || 'Unbekannter Fehler');
      return;
    }
    busy.remove();
    await download(exportFilename(scope, 'pdf'), new Blob([bytes], { type: 'application/pdf' }));
  }

  // ---------------------------------------------------------------------------
  // Rendering

  function render() {
    renderYearSelect();
    renderSidebar();
    renderMain();
  }

  function renderCategoryList() {
    document.getElementById('category-list').replaceChildren(
      ...state.categories.map((c) => h('option', { value: c })));
  }

  function renderYearSelect() {
    const select = document.getElementById('year-select');
    select.replaceChildren(...state.years.map((y) => h('option', { value: String(y) }, String(y))));
    select.value = String(state.year);
  }

  function renderSidebar() {
    const nav = document.getElementById('sidebar');
    const isActive = (id) => state.view.type === 'entity' && state.view.id === id;
    const item = (e, sub) => h('button', {
      type: 'button',
      class: 'nav-item' + (sub ? ' nav-sub' : '') + (isActive(e.id) ? ' active' : ''),
      onclick: () => go({ type: 'entity', id: e.id }),
    }, h('span', { class: 'nav-name' }, e.name), h('span', { class: 'nav-sum', dataset: { entitySum: e.id } }));
    const head = (title, type) => h('div', { class: 'nav-group-head' },
      h('h2', null, title),
      h('button', { type: 'button', class: 'icon-btn', title: (type === 'company' ? 'Unternehmen' : 'Person') + ' hinzufügen', onclick: () => addEntity(type) }, '+'));
    const persons = state.entities.filter((e) => e.type === 'person');
    const companies = state.entities.filter((e) => e.type === 'company');
    const freeCompanies = companies.filter((c) => !L.ownerOf(c, state.entities));
    const group = (type, title) => type === 'person'
      ? h('section', { class: 'nav-group' }, head(title, type),
        persons.length
          ? persons.map((p) => [item(p), companies.filter((c) => c.ownerId === p.id).map((c) => item(c, true))])
          : h('p', { class: 'nav-empty' }, 'Noch keine Einträge'))
      : h('section', { class: 'nav-group' }, head(companies.length > freeCompanies.length ? 'Weitere Unternehmen' : title, type),
        freeCompanies.length
          ? freeCompanies.map((c) => item(c))
          : h('p', { class: 'nav-empty' }, companies.length ? 'Alle Unternehmen sind einer Person zugeordnet' : 'Noch keine Einträge'));
    nav.replaceChildren(
      h('button', {
        type: 'button',
        class: 'nav-item nav-overview' + (state.view.type === 'overview' ? ' active' : ''),
        onclick: () => go({ type: 'overview' }),
      }, 'Jahresübersicht ' + state.year),
      group('person', 'Personen'),
      group('company', 'Unternehmen'),
      h('button', {
        type: 'button',
        class: 'nav-item nav-settings' + (state.view.type === 'settings' ? ' active' : ''),
        onclick: () => go({ type: 'settings' }),
      }, '⚙︎ Einstellungen'));
    updateSidebarSums();
  }

  function updateSidebarSums() {
    for (const el of document.querySelectorAll('[data-entity-sum]')) {
      const t = L.totals(positionsFor(el.dataset.entitySum, state.year));
      el.textContent = t.expense || t.income ? L.formatAmount(t.expense) : '';
    }
  }

  function renderMain() {
    objectUrls.forEach((u) => URL.revokeObjectURL(u));
    objectUrls = [];
    const entity = state.view.type === 'entity' ? entityById(state.view.id) : null;
    const main = document.getElementById('main');
    main.replaceChildren(entity ? entityView(entity) : state.view.type === 'settings' ? settingsView() : overviewView());
  }

  // ---------------------------------------------------------------------------
  // Positionen: kompakte Liste nach Datum, Details per Antippen, Änderungen nur über
  // „Übernehmen“/„Speichern“. Während der Eingabe wird nichts neu aufgebaut oder sortiert.

  function emptyFilters() {
    return { direction: 'all', month: null, category: '', query: '' };
  }

  const ui = {
    openId: null, // aufgeklappte Position
    draft: null, // { isNew, p, pending, removed, invalid } beim Anlegen/Bearbeiten
    dirty: false,
    filters: emptyFilters(),
  };

  function resetUi() {
    ui.openId = null;
    ui.draft = null;
    ui.dirty = false;
    ui.filters = emptyFilters();
  }

  /** Vor dem Verlassen eines nicht übernommenen Entwurfs nachfragen. */
  async function confirmLeave() {
    if (!ui.draft || !ui.dirty) return true;
    return confirmDialog('Änderungen verwerfen?',
      'Die Position wurde noch nicht übernommen. Deine Eingaben gehen sonst verloren.', 'Verwerfen', true);
  }

  async function go(view) {
    if (!(await confirmLeave())) return false;
    resetUi();
    state.view = view;
    render();
    window.scrollTo(0, 0);
    return true;
  }

  function scrollToPosition(id, highlight) {
    const item = document.querySelector('.pos-item[data-id="' + id + '"]');
    if (!item) return;
    item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (highlight) {
      item.classList.remove('saved');
      void item.offsetWidth;
      item.classList.add('saved');
    }
  }

  function makeDraft(p, isNew) {
    return {
      isNew,
      p: Object.assign({}, p, { months: p.months.slice(), attachmentIds: p.attachmentIds.slice() }),
      pending: [],
      removed: [],
      invalid: new Set(),
    };
  }

  async function startNew(entity) {
    if (!(await confirmLeave())) return;
    ui.openId = null;
    ui.draft = makeDraft(L.createPosition({ year: state.year, entityId: entity.id, category: '' }), true);
    ui.dirty = false;
    renderMain();
    const title = document.querySelector('.editor .editor-title');
    if (title) {
      title.scrollIntoView({ behavior: 'smooth', block: 'center' });
      title.focus();
    }
  }

  async function toggleRow(p) {
    if (ui.draft && !(await confirmLeave())) return;
    ui.draft = null;
    ui.dirty = false;
    ui.openId = ui.openId === p.id ? null : p.id;
    renderPositionList();
    if (ui.openId) scrollToPosition(p.id);
  }

  async function startEdit(p) {
    if (ui.draft && !(await confirmLeave())) return;
    ui.openId = p.id;
    ui.draft = makeDraft(p, false);
    ui.dirty = false;
    renderMain();
    scrollToPosition(p.id);
  }

  async function cancelEdit() {
    if (!(await confirmLeave())) return;
    const wasNew = ui.draft && ui.draft.isNew;
    ui.draft = null;
    ui.dirty = false;
    renderMain();
    if (!wasNew && ui.openId) scrollToPosition(ui.openId);
  }

  async function saveDraft() {
    const d = ui.draft;
    const p = d.p;
    if (d.invalid.size) {
      await alertDialog('Betrag prüfen', 'Mindestens ein Betrag ist ungültig (rot markiert). Erlaubt sind z.B. 89, 89,50 oder 1.234,56.');
      return;
    }
    p.title = p.title.trim();
    if (!p.title) {
      await alertDialog('Bezeichnung fehlt', 'Bitte gib der Position eine Bezeichnung, z.B. „Kfz-Versicherung“.');
      const title = document.querySelector('.editor .editor-title');
      if (title) title.focus();
      return;
    }
    p.category = (p.category || '').trim() || 'Sonstiges';
    p.reference = (p.reference || '').trim();
    const before = state.positions.find((x) => x.id === p.id);
    const moved = d.isNew ? p.entityId !== state.view.id : before && before.entityId !== p.entityId;

    for (const file of d.pending) {
      await DB.put('attachments', {
        id: file.id, positionId: p.id, name: file.name, type: file.type, size: file.size,
        blob: file.blob, addedAt: new Date().toISOString(),
      });
      p.attachmentIds.push(file.id);
    }
    if (d.removed.length) {
      await DB.removeMany('attachments', d.removed);
      p.attachmentIds = p.attachmentIds.filter((id) => !d.removed.includes(id));
    }
    await savePosition(p);
    const index = state.positions.findIndex((x) => x.id === p.id);
    if (index >= 0) state.positions[index] = p;
    else state.positions.push(p);
    await ensureCategory(p.category);

    ui.draft = null;
    ui.dirty = false;
    ui.openId = null;
    renderSidebar();
    renderMain();
    if (moved) toast('„' + p.title + '“ liegt jetzt bei ' + entityById(p.entityId).name + '.');
    else scrollToPosition(p.id, true);
  }

  async function deletePosition(p) {
    const ok = await confirmDialog('Position löschen?',
      '„' + (p.title || 'Ohne Bezeichnung') + '“ wird samt ' + p.attachmentIds.length + ' Beleg(en) gelöscht.',
      'Löschen', true);
    if (!ok) return;
    await DB.removeMany('attachments', p.attachmentIds);
    await DB.remove('positions', p.id);
    state.positions = state.positions.filter((x) => x.id !== p.id);
    ui.draft = null;
    ui.dirty = false;
    ui.openId = null;
    render();
  }

  /** Dateityp bestimmen; manche Apps liefern keinen Typ mit, dann zählt die Endung. */
  function fileType(file) {
    if (file.type === 'application/pdf' || file.type.startsWith('image/')) return file.type;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const byExt = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
      heic: 'image/heic', heif: 'image/heif', webp: 'image/webp', gif: 'image/gif' };
    return byExt[ext] || null;
  }

  async function addFilesToDraft(d, files, refresh) {
    const rejected = [];
    for (const file of files) {
      const type = fileType(file);
      if (!type) { rejected.push(file.name); continue; }
      d.pending.push({ id: L.uid(), name: file.name, type, size: file.size, blob: file });
    }
    ui.dirty = true;
    refresh();
    if (rejected.length) {
      await alertDialog('Nicht unterstützt', 'Nur Bilder und PDFs können angehängt werden: ' + rejected.join(', '));
    }
  }

  // ---------------------------------------------------------------------------
  // Ansicht einer Person / eines Unternehmens

  function stat(label, value, key, tone) {
    return h('div', { class: 'stat' + (tone ? ' stat-' + tone : '') },
      h('span', { class: 'stat-label' }, label),
      h('span', { class: 'stat-value', dataset: key ? { sum: key } : {} }, value));
  }

  function attachmentCount(positions) {
    return positions.reduce((n, p) => n + p.attachmentIds.length, 0);
  }

  function entityView(entity) {
    const positions = positionsFor(entity.id, state.year);
    const t = L.totals(positions);
    const owner = L.ownerOf(entity, state.entities);
    const open = (id) => go({ type: 'entity', id });
    const newDraft = ui.draft && ui.draft.isNew ? ui.draft : null;
    return h('div', { class: 'view' },
      h('div', { class: 'view-head' },
        h('div', null,
          h('span', { class: 'eyebrow' },
            (entity.type === 'company' ? 'Unternehmen' : 'Person') + ' · ' + state.year,
            owner ? [' · gehört zu ', h('button', { type: 'button', class: 'link-btn', onclick: () => open(owner.id) }, owner.name)] : null),
          h('h2', null, entity.name)),
        h('div', { class: 'actions' },
          button('Bearbeiten', () => editEntity(entity), 'ghost'),
          button('Löschen', () => deleteEntity(entity), 'ghost-danger'))),
      h('div', { class: 'stats' },
        stat('Ausgaben', L.formatEuro(t.expense)),
        stat('Einnahmen', L.formatEuro(t.income), null, 'income'),
        stat('Positionen', String(positions.length)),
        stat('Belege', String(attachmentCount(positions)))),
      entity.type === 'person' ? ownedCompanies(entity, open) : null,
      newDraft
        ? h('section', { class: 'card editor-card' }, h('h3', null, 'Neue Position'), positionEditor(newDraft))
        : h('div', { class: 'toolbar' },
          button('+ Neue Position', () => startNew(entity), 'primary'),
          button('Aus Vorjahr übernehmen', () => copyFromPreviousYear(entity))),
      positions.length
        ? h('section', { class: 'card list-card' },
          filterBar(positions),
          h('div', { id: 'pos-list' }, positionListContent(positions)))
        : newDraft ? null : h('div', { class: 'empty' },
          h('p', null, 'Für ' + state.year + ' gibt es noch keine Positionen.'),
          h('p', { class: 'muted' }, 'Lege z.B. ein Bankkonto, eine Kfz-Versicherung oder die Kfz-Steuer an.')));
  }

  /** Nur die Liste neu zeichnen (z.B. bei Filteränderung), damit z.B. das Suchfeld den Fokus behält. */
  function renderPositionList() {
    const host = document.getElementById('pos-list');
    const entity = state.view.type === 'entity' ? entityById(state.view.id) : null;
    if (!host || !entity) return renderMain();
    host.replaceChildren(positionListContent(positionsFor(entity.id, state.year)));
  }

  function filterBar(positions) {
    const f = ui.filters;
    const categories = Array.from(new Set(positions.map((p) => p.category))).sort((a, b) => a.localeCompare(b, 'de'));
    if (f.category && !categories.includes(f.category)) f.category = '';
    const direction = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Ausgaben oder Einnahmen' },
      [['all', 'Alle'], ['expense', 'Ausgaben'], ['income', 'Einnahmen']].map(([value, label]) => h('button', {
        type: 'button',
        class: f.direction === value ? 'active' : '',
        'aria-pressed': f.direction === value ? 'true' : 'false',
        onclick: (e) => {
          f.direction = value;
          for (const b of e.currentTarget.parentNode.children) {
            const active = b === e.currentTarget;
            b.classList.toggle('active', active);
            b.setAttribute('aria-pressed', active ? 'true' : 'false');
          }
          renderPositionList();
        },
      }, label)));
    const month = h('select', {
      class: 'input', 'aria-label': 'Monat',
      onchange: (e) => { f.month = e.target.value === '' ? null : Number(e.target.value); renderPositionList(); },
    }, h('option', { value: '' }, 'Alle Monate'), L.MONTHS_LONG.map((m, i) => h('option', { value: String(i) }, m)));
    month.value = f.month === null ? '' : String(f.month);
    const category = h('select', {
      class: 'input', 'aria-label': 'Kategorie',
      onchange: (e) => { f.category = e.target.value; renderPositionList(); },
    }, h('option', { value: '' }, 'Alle Kategorien'), categories.map((c) => h('option', { value: c }, c)));
    category.value = f.category;
    const search = h('input', {
      class: 'input', type: 'search', placeholder: 'Suchen …', 'aria-label': 'Suchen', value: f.query,
      oninput: (e) => { f.query = e.target.value; renderPositionList(); },
    });
    return h('div', { class: 'filters' }, direction, h('div', { class: 'filter-selects' }, month, category), search);
  }

  function positionListContent(positions) {
    const f = ui.filters;
    const filtered = L.sortByDate(L.filterPositions(positions, f));
    const t = L.totalsFor(filtered, f.month);
    const active = f.direction !== 'all' || f.month !== null || f.category || f.query.trim();
    const summary = h('div', { class: 'list-summary' },
      h('span', null,
        (active ? filtered.length + ' von ' + positions.length : String(positions.length)) + ' Position(en)' +
        (f.month !== null ? ' im ' + L.MONTHS_LONG[f.month] : '')),
      h('span', { class: 'list-sum' },
        t.expense || !t.income ? L.formatEuro(t.expense) : null,
        t.income ? h('span', { class: 'income-text' }, (t.expense ? ' · ' : '') + '+' + L.formatEuro(t.income)) : null),
      active ? h('button', {
        type: 'button', class: 'link-btn',
        onclick: () => { ui.filters = emptyFilters(); renderMain(); },
      }, 'Filter zurücksetzen') : null);
    return h('div', null,
      summary,
      filtered.length
        ? h('ul', { class: 'pos-list' }, filtered.map(positionRow))
        : h('p', { class: 'muted list-empty' }, 'Keine Position passt zu diesem Filter.'));
  }

  function formatDay(iso) {
    return iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.';
  }

  function dateBadge(p) {
    if (p.kind === 'once') {
      return h('span', { class: 'pos-date' }, h('strong', null, p.onceDate ? formatDay(p.onceDate) : '–'), h('small', null, 'einmalig'));
    }
    const filled = L.filledMonths(p);
    const range = !filled.length ? '–' : filled.length === 1 ? L.MONTHS[filled[0]]
      : L.MONTHS[filled[0]] + '–' + L.MONTHS[filled[filled.length - 1]];
    return h('span', { class: 'pos-date' }, h('strong', null, range), h('small', null, 'monatlich'));
  }

  function positionRow(p) {
    const open = ui.openId === p.id;
    const editing = open && ui.draft && !ui.draft.isNew && ui.draft.p.id === p.id;
    const month = ui.filters.month;
    const amount = month === null ? L.positionTotal(p) : L.amountInMonth(p, month);
    const income = p.direction === 'income';
    const meta = [p.category];
    if (p.reference) meta.push(p.reference);
    if (p.attachmentIds.length) meta.push('📎 ' + p.attachmentIds.length);
    return h('li', { class: 'pos-item' + (open ? ' open' : '') + (income ? ' income' : ''), dataset: { id: p.id } },
      h('button', { type: 'button', class: 'pos-row', 'aria-expanded': open ? 'true' : 'false', onclick: () => toggleRow(p) },
        dateBadge(p),
        h('span', { class: 'pos-main' },
          h('span', { class: 'pos-title' }, p.title || 'Ohne Bezeichnung'),
          h('span', { class: 'pos-meta' }, meta.join(' · '))),
        h('span', { class: 'pos-amount' },
          h('span', null, (income ? '+' : '') + L.formatEuro(amount)),
          month !== null ? h('small', null, 'Jahr ' + L.formatEuro(L.positionTotal(p))) : null),
        h('span', { class: 'pos-chevron', 'aria-hidden': 'true' }, '›')),
      open ? h('div', { class: 'pos-body' }, editing ? positionEditor(ui.draft) : positionDetail(p)) : null);
  }

  function positionDetail(p) {
    const rows = [
      ['Kategorie', p.category],
      ['Art', p.direction === 'income' ? 'Einnahme' : 'Ausgabe'],
      ['Zahlung', p.kind === 'once'
        ? 'Einmalig' + (p.onceDate ? ' am ' + formatDay(p.onceDate) + p.onceDate.slice(0, 4) : '')
        : 'Monatlich'],
      ['Jahressumme', L.formatEuro(L.positionTotal(p))],
    ];
    if (p.reference) rows.push(['Kennung', p.reference]);
    if (p.note) rows.push(['Notiz', p.note]);
    const list = h('div', { class: 'attachment-list' });
    renderAttachmentChips(list, p.attachmentIds, [], null);
    return h('div', { class: 'pos-detail' },
      h('dl', { class: 'detail-grid' }, rows.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
      p.kind === 'monthly' ? h('div', { class: 'months-read' }, L.MONTHS.map((m, i) => h('div', { class: 'month-read' },
        h('span', null, m),
        h('strong', { class: p.months[i] === null ? 'muted' : '' }, p.months[i] === null ? '–' : L.formatAmount(p.months[i]))))) : null,
      p.attachmentIds.length ? list : h('p', { class: 'muted' }, 'Keine Belege angehängt.'),
      h('div', { class: 'detail-actions' },
        button('Bearbeiten', () => startEdit(p), 'primary'),
        button('Verschieben …', () => movePosition(p), 'ghost'),
        h('span', { class: 'spacer' }),
        button('Löschen', () => deletePosition(p), 'ghost-danger')));
  }

  function amountInput(getValue, setValue, attrs, onValidity) {
    const input = h('input', Object.assign({
      class: 'amount',
      inputmode: 'decimal',
      autocomplete: 'off',
      placeholder: '0,00',
      value: L.formatAmount(getValue()),
    }, attrs || {}));
    input.addEventListener('input', () => {
      const v = L.parseAmount(input.value);
      const valid = !Number.isNaN(v);
      input.classList.toggle('invalid', !valid);
      if (onValidity) onValidity(valid);
      if (valid) setValue(v);
    });
    input.addEventListener('change', () => {
      const v = L.parseAmount(input.value);
      if (!Number.isNaN(v)) input.value = L.formatAmount(v);
    });
    return input;
  }

  /** Auswahlknöpfe, die nur ihren eigenen Zustand umschalten (kein Neuaufbau). */
  function choice(options, current, onChange, label) {
    const group = h('div', { class: 'segmented', role: 'group', 'aria-label': label });
    for (const [value, text] of options) {
      group.append(h('button', {
        type: 'button',
        class: value === current ? 'active' : '',
        'aria-pressed': value === current ? 'true' : 'false',
        onclick: (e) => {
          for (const b of group.children) {
            const active = b === e.currentTarget;
            b.classList.toggle('active', active);
            b.setAttribute('aria-pressed', active ? 'true' : 'false');
          }
          onChange(value);
        },
      }, text));
    }
    return group;
  }

  function positionEditor(d) {
    const p = d.p;
    const dirty = () => { ui.dirty = true; };
    const validity = (key) => (valid) => {
      if (valid) d.invalid.delete(key);
      else d.invalid.add(key);
      dirty();
    };

    const monthsBlock = editorMonths(d, dirty, validity);
    const onceBlock = h('div', { class: 'once-row' },
      h('label', { class: 'field' }, h('span', null, 'Datum'),
        h('input', {
          class: 'input', type: 'date', value: p.onceDate,
          onchange: (e) => { p.onceDate = e.target.value; dirty(); },
        })),
      h('label', { class: 'field' }, h('span', null, 'Betrag (€)'),
        amountInput(() => p.onceAmount, (v) => { p.onceAmount = v; dirty(); }, { 'aria-label': 'Betrag' }, validity('once'))));
    monthsBlock.hidden = p.kind !== 'monthly';
    onceBlock.hidden = p.kind !== 'once';

    const attachments = editorAttachments(d);
    const editor = h('div', { class: 'editor' },
      h('label', { class: 'field' }, h('span', null, 'Bezeichnung'),
        h('input', {
          class: 'input editor-title', value: p.title, placeholder: 'z.B. Kfz-Versicherung', autocomplete: 'off',
          oninput: (e) => { p.title = e.target.value; dirty(); },
        })),
      h('div', { class: 'editor-grid' },
        h('label', { class: 'field' }, h('span', null, 'Kategorie'), categorySelect(p, dirty)),
        h('label', { class: 'field' }, h('span', null, 'Gehört zu'),
          entitySelect(p.entityId, (id) => { p.entityId = id; dirty(); }))),
      h('label', { class: 'field' }, h('span', null, 'Kennung (IBAN, Kennzeichen, Vertragsnr. …)'),
        h('input', {
          class: 'input', value: p.reference, autocomplete: 'off',
          oninput: (e) => { p.reference = e.target.value; dirty(); },
        })),
      h('div', { class: 'editor-grid' },
        h('div', { class: 'field' }, h('span', null, 'Art'),
          choice([['expense', 'Ausgabe'], ['income', 'Einnahme']], p.direction, (v) => { p.direction = v; dirty(); }, 'Ausgabe oder Einnahme')),
        h('div', { class: 'field' }, h('span', null, 'Zahlung'),
          choice([['monthly', 'Monatlich'], ['once', 'Einmalig']], p.kind, (v) => {
            p.kind = v;
            monthsBlock.hidden = v !== 'monthly';
            onceBlock.hidden = v !== 'once';
            dirty();
          }, 'Zahlungsart'))),
      monthsBlock,
      onceBlock,
      h('label', { class: 'field' }, h('span', null, 'Notiz'),
        h('textarea', { class: 'input', rows: '2', placeholder: 'Optional', oninput: (e) => { p.note = e.target.value; dirty(); } }, p.note)),
      attachments,
      h('div', { class: 'editor-actions' },
        button(d.isNew ? 'Übernehmen' : 'Speichern', saveDraft, 'primary'),
        button('Abbrechen', cancelEdit),
        d.isNew ? null : h('span', { class: 'spacer' }),
        d.isNew ? null : button('Löschen', () => deletePosition(state.positions.find((x) => x.id === p.id)), 'ghost-danger')));

    editor.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      editor.classList.add('dragging');
    });
    editor.addEventListener('dragleave', (e) => {
      if (!editor.contains(e.relatedTarget)) editor.classList.remove('dragging');
    });
    editor.addEventListener('drop', (e) => {
      e.preventDefault();
      editor.classList.remove('dragging');
      if (e.dataTransfer.files.length) addFilesToDraft(d, Array.from(e.dataTransfer.files), attachments.refresh);
    });
    return editor;
  }

  function editorMonths(d, dirty, validity) {
    const p = d.p;
    const inputs = [];

    async function fill(i) {
      const v = L.parseAmount(inputs[i].value);
      if (Number.isNaN(v)) return;
      p.months[i] = v;
      const next = L.fillForward(p.months, i);
      // Nur nachfragen, wenn individuell eingetragene Werte verloren gingen. Ein durchgehend
      // gleicher Rest (z.B. aus einer früheren Übertragung) wird ohne Rückfrage ersetzt.
      const tail = p.months.slice(i + 1);
      const uniformTail = tail.every((m) => m !== null && m === tail[0]);
      const overwrites = !uniformTail && tail.some((old, j) => old !== null && old !== next[i + 1 + j]);
      if (overwrites) {
        const ok = await confirmDialog('Folgemonate überschreiben?',
          'In den Monaten nach ' + L.MONTHS_LONG[i] + ' stehen bereits andere Beträge. Diese werden durch ' +
          (v === null ? 'leere Felder' : L.formatEuro(v)) + ' ersetzt.', 'Überschreiben');
        if (!ok) return;
      }
      p.months = next;
      inputs.forEach((input, j) => {
        input.value = L.formatAmount(p.months[j]);
        if (j > i) {
          input.classList.remove('invalid');
          d.invalid.delete('m' + j);
          input.classList.remove('flash');
          void input.offsetWidth;
          input.classList.add('flash');
        }
      });
      dirty();
    }

    async function clearAll() {
      if (p.months.every((m) => m === null)) return;
      const ok = await confirmDialog('Alle Monate leeren?', 'Alle 12 Monatsbeträge dieser Position werden entfernt.', 'Leeren', true);
      if (!ok) return;
      p.months = L.emptyMonths();
      inputs.forEach((input, j) => { input.value = ''; input.classList.remove('invalid'); d.invalid.delete('m' + j); });
      dirty();
    }

    const grid = h('div', { class: 'months' }, L.MONTHS.map((m, i) => {
      const input = amountInput(() => p.months[i], (v) => { p.months[i] = v; dirty(); },
        { 'aria-label': L.MONTHS_LONG[i] }, validity('m' + i));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (inputs[i + 1] || input).focus();
        }
      });
      inputs.push(input);
      return h('div', { class: 'month' },
        h('span', { class: 'month-label' }, m),
        h('div', { class: 'month-field' },
          input,
          i < 11 ? h('button', {
            type: 'button',
            class: 'fill-btn',
            title: L.MONTHS_LONG[i] + '-Betrag auf alle Folgemonate übertragen',
            'aria-label': L.MONTHS_LONG[i] + '-Betrag auf alle Folgemonate übertragen',
            onclick: () => fill(i),
          }, '»') : null));
    }));

    return h('div', { class: 'months-wrap' },
      grid,
      h('div', { class: 'months-actions' },
        h('span', { class: 'muted' }, 'Tipp: » überträgt den Betrag auf alle folgenden Monate.'),
        button('Monate leeren', clearAll, 'link')));
  }

  function editorAttachments(d) {
    const list = h('div', { class: 'attachment-list' });
    const refresh = () => renderAttachmentChips(list,
      d.p.attachmentIds.filter((id) => !d.removed.includes(id)), d.pending,
      (item) => {
        if (item.pending) d.pending = d.pending.filter((f) => f.id !== item.id);
        else d.removed.push(item.id);
        ui.dirty = true;
        refresh();
      });
    const fileInput = h('input', {
      type: 'file',
      multiple: true,
      accept: 'image/*,application/pdf,.pdf,.heic,.heif',
      hidden: true,
      onchange: (e) => {
        const files = Array.from(e.target.files);
        e.target.value = '';
        addFilesToDraft(d, files, refresh);
      },
    });
    refresh();
    const section = h('div', { class: 'attachments' },
      h('span', { class: 'field-label' }, 'Belege'),
      list,
      h('div', { class: 'attach-actions' },
        fileInput,
        button('📎 Beleg anhängen (Bild/PDF)', () => fileInput.click(), 'small'),
        h('span', { class: 'muted drop-hint' }, 'oder Datei hierher ziehen')));
    section.refresh = refresh;
    return section;
  }

  function openAttachment(att, url) {
    if (att.type.startsWith('image/')) {
      openDialog({
        title: att.name,
        content: h('img', { class: 'preview-img', src: url, alt: att.name }),
        confirmText: 'Schließen',
        cancelText: null,
      });
    } else if (inClaude) {
      download(att.name, att.blob);
    } else {
      window.open(url, '_blank', 'noopener');
    }
  }

  /**
   * Beleg-Chips zeichnen: gespeicherte (ids) und noch nicht übernommene (pending).
   * onRemove: null = nur ansehen, sonst Callback mit { id, pending }.
   */
  async function renderAttachmentChips(list, ids, pending, onRemove) {
    const stored = (await Promise.all(ids.map((id) => DB.get('attachments', id)))).filter(Boolean);
    const items = stored.map((a) => ({ att: a, pending: false })).concat(pending.map((a) => ({ att: a, pending: true })));
    list.replaceChildren(...items.map(({ att: a, pending: isPending }) => {
      const url = URL.createObjectURL(a.blob);
      objectUrls.push(url);
      const isImage = a.type.startsWith('image/');
      return h('div', { class: 'chip' + (isPending ? ' chip-new' : '') },
        h('button', { type: 'button', class: 'chip-main', title: a.name + ' öffnen', onclick: () => openAttachment(a, url) },
          isImage ? h('img', { src: url, alt: '' }) : h('span', { class: 'file-icon' }, 'PDF'),
          h('span', { class: 'chip-text' },
            h('span', { class: 'chip-name' }, a.name),
            h('span', { class: 'chip-size' }, isPending ? 'neu · ' + formatSize(a.size) : formatSize(a.size)))),
        h('button', { type: 'button', class: 'chip-btn', title: 'Herunterladen', onclick: () => download(a.name, a.blob) }, '⤓'),
        onRemove ? h('button', {
          type: 'button', class: 'chip-btn danger', title: 'Beleg entfernen',
          onclick: () => onRemove({ id: a.id, pending: isPending }),
        }, '✕') : null);
    }));
  }

  const NEW_CATEGORY = '\u0000neu';

  /** Kategorie-Auswahl mit „+ Neue Kategorie …“ (statt Freitext, damit das iPhone eine Liste zeigt). */
  function categorySelect(p, dirty) {
    const select = h('select', { class: 'input' });
    const fill = () => {
      const names = L.allCategories(state.categories, []);
      if (p.category && !names.includes(p.category)) names.push(p.category);
      select.replaceChildren(
        h('option', { value: '' }, 'Kategorie wählen …'),
        ...names.map((c) => h('option', { value: c }, c)),
        h('option', { value: NEW_CATEGORY }, '+ Neue Kategorie …'));
      select.value = p.category || '';
    };
    select.addEventListener('change', async () => {
      if (select.value !== NEW_CATEGORY) {
        p.category = select.value;
        dirty();
        return;
      }
      const name = await promptDialog('Neue Kategorie', 'Name', '', { placeholder: 'z.B. Handwerker' });
      if (name) {
        const existing = L.findCategory(state.categories, name);
        p.category = existing || name;
        if (!existing) await ensureCategory(name);
        dirty();
      }
      fill();
    });
    fill();
    return select;
  }

  function entityOptionLabel(e) {
    if (e.type === 'person') return e.name + ' (Person)';
    const owner = L.ownerOf(e, state.entities);
    return e.name + ' (Unternehmen' + (owner ? ' von ' + owner.name : '') + ')';
  }

  function entitySelect(current, onChange) {
    const select = h('select', { class: 'input' },
      L.orderEntities(state.entities).map((e) => h('option', { value: e.id }, entityOptionLabel(e))));
    select.value = current;
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }

  async function movePosition(p) {
    if (state.entities.length < 2) {
      await alertDialog('Verschieben nicht möglich', 'Lege zuerst eine weitere Person oder ein Unternehmen an.');
      return;
    }
    let target = p.entityId;
    const select = entitySelect(p.entityId, (id) => { target = id; });
    const ok = await openDialog({
      title: 'Position verschieben',
      content: h('div', { class: 'dialog-fields' },
        h('p', null, 'Wohin soll „' + (p.title || 'Ohne Bezeichnung') + '“ verschoben werden? Belege kommen mit.'),
        h('label', { class: 'field' }, h('span', null, 'Nach'), select)),
      confirmText: 'Verschieben',
    });
    if (!ok || target === p.entityId) return;
    p.entityId = target;
    await savePosition(p);
    ui.openId = null;
    render();
    toast('„' + p.title + '“ liegt jetzt bei ' + entityById(target).name + '.');
  }

  /** Kurzer Hinweis am unteren Rand, verschwindet von selbst. */
  function toast(text) {
    const old = document.querySelector('.toast');
    if (old) old.remove();
    const el = h('div', { class: 'toast', role: 'status' }, text);
    document.body.append(el);
    setTimeout(() => el.remove(), 3200);
  }

  // ---------------------------------------------------------------------------
  // Einstellungen: Kategorien zentral verwalten

  async function saveCategories(list) {
    state.categories = Array.from(new Set(list)).sort((a, b) => a.localeCompare(b, 'de'));
    await DB.setMeta('categories', state.categories);
    renderCategoryList();
  }

  /** Alle Positionen (alle Jahre) von einer Kategorie in eine andere umhängen. */
  async function recategorize(from, to) {
    const changed = state.positions.filter((p) => p.category === from);
    for (const p of changed) p.category = to;
    await DB.putMany('positions', changed);
    return changed.length;
  }

  async function addCategory(name) {
    name = name.trim();
    if (!name) return false;
    const existing = L.findCategory(L.allCategories(state.categories, state.positions), name);
    if (existing) {
      await alertDialog('Gibt es schon', 'Die Kategorie „' + existing + '“ ist bereits vorhanden.');
      return false;
    }
    await saveCategories(state.categories.concat(name));
    return true;
  }

  async function renameCategory(name) {
    const next = await promptDialog('Kategorie umbenennen', 'Neuer Name', name);
    if (!next || next === name) return;
    const others = L.allCategories(state.categories, state.positions).filter((c) => c !== name);
    const existing = L.findCategory(others, next);
    if (existing) {
      const ok = await confirmDialog('Kategorien zusammenführen?',
        '„' + existing + '“ gibt es schon. Alle Positionen aus „' + name + '“ werden nach „' + existing + '“ verschoben.',
        'Zusammenführen');
      if (!ok) return;
    }
    const target = existing || next;
    const count = await recategorize(name, target);
    await saveCategories(state.categories.filter((c) => c !== name).concat(target));
    renderMain();
    toast(count ? count + ' Position(en) geändert.' : 'Kategorie umbenannt.');
  }

  async function deleteCategory(name) {
    const count = L.categoryUsage(state.positions).get(name) || 0;
    if (!count) {
      const ok = await confirmDialog('Kategorie löschen?', '„' + name + '“ wird aus der Liste entfernt.', 'Löschen', true);
      if (!ok) return;
      await saveCategories(state.categories.filter((c) => c !== name));
      renderMain();
      return;
    }
    const others = L.allCategories(state.categories, state.positions).filter((c) => c !== name);
    if (!others.includes('Sonstiges')) others.push('Sonstiges');
    const select = h('select', { class: 'input' }, others.map((c) => h('option', { value: c }, c)));
    select.value = 'Sonstiges';
    const ok = await openDialog({
      title: 'Kategorie löschen?',
      content: h('div', { class: 'dialog-fields' },
        h('p', null, '„' + name + '“ wird von ' + count + ' Position(en) verwendet (alle Jahre). Wohin sollen diese?'),
        h('label', { class: 'field' }, h('span', null, 'Verschieben nach'), select)),
      confirmText: 'Löschen und verschieben',
      danger: true,
    });
    if (!ok) return;
    await recategorize(name, select.value);
    await saveCategories(state.categories.filter((c) => c !== name).concat(select.value));
    renderMain();
    toast(count + ' Position(en) nach „' + select.value + '“ verschoben.');
  }

  function settingsView() {
    const usage = L.categoryUsage(state.positions);
    const categories = L.allCategories(state.categories, state.positions);
    const input = h('input', { class: 'input', placeholder: 'z.B. Handwerker', autocomplete: 'off', 'aria-label': 'Neue Kategorie' });
    const add = async () => {
      if (await addCategory(input.value)) {
        renderMain();
        toast('Kategorie hinzugefügt.');
      }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    const missingDefaults = L.DEFAULT_CATEGORIES.filter((c) => !L.findCategory(categories, c));
    return h('div', { class: 'view' },
      h('div', { class: 'view-head' },
        h('div', null, h('span', { class: 'eyebrow' }, 'Gilt für alle Personen, Unternehmen und Jahre'), h('h2', null, 'Einstellungen'))),
      h('section', { class: 'card settings-card' },
        h('h3', null, 'Kategorien'),
        h('p', { class: 'muted' }, 'Diese Kategorien stehen beim Anlegen einer Position zur Auswahl. ' +
          'Umbenennen ändert alle Positionen mit dieser Kategorie.'),
        h('div', { class: 'add-row' }, input, button('Hinzufügen', add, 'primary')),
        h('ul', { class: 'cat-list' }, categories.map((c) => {
          const n = usage.get(c) || 0;
          return h('li', null,
            h('span', { class: 'cat-name' }, c),
            h('span', { class: 'cat-usage' }, n ? n + ' Position' + (n === 1 ? '' : 'en') : 'nicht verwendet'),
            h('span', { class: 'cat-actions' },
              button('Umbenennen', () => renameCategory(c), 'small'),
              button('Löschen', () => deleteCategory(c), 'ghost-danger')));
        })),
        missingDefaults.length ? h('p', { class: 'muted' },
          h('button', {
            type: 'button', class: 'link-btn',
            onclick: async () => { await saveCategories(state.categories.concat(missingDefaults)); renderMain(); },
          }, 'Standardkategorien ergänzen'), ' (' + missingDefaults.join(', ') + ')') : null));
  }

  /** Liste der Unternehmen einer Person mit ihren Jahressummen. */
  function ownedCompanies(person, open) {
    const companies = state.entities.filter((e) => e.type === 'company' && e.ownerId === person.id);
    return h('section', { class: 'card owned' },
      h('div', { class: 'owned-head' },
        h('h3', null, 'Unternehmen von ' + person.name),
        button('+ Unternehmen', () => addEntity('company', person.id), 'small')),
      companies.length
        ? h('div', { class: 'owned-list' }, companies.map((c) => {
          const ps = positionsFor(c.id, state.year);
          const t = L.totals(ps);
          return h('button', { type: 'button', class: 'owned-item', onclick: () => open(c.id) },
            h('span', { class: 'owned-name' }, c.name),
            h('span', { class: 'muted' }, ps.length + ' Position(en)'),
            h('span', { class: 'owned-sum' }, L.formatEuro(t.expense),
              t.income ? h('span', { class: 'income-text' }, ' · +' + L.formatEuro(t.income)) : null),
            h('span', { class: 'owned-arrow', 'aria-hidden': 'true' }, '›'));
        }))
        : h('p', { class: 'muted' }, 'Noch keine Unternehmen zugeordnet. Bestehende Unternehmen ordnest du über „Bearbeiten“ beim Unternehmen zu.'));
  }

  function overviewView() {
    const yearPositions = state.positions.filter((p) => p.year === state.year);
    const t = L.totals(yearPositions);
    const open = async (entityId, positionId) => {
      if (!(await go({ type: 'entity', id: entityId })) || !positionId) return;
      ui.openId = positionId;
      renderPositionList();
      scrollToPosition(positionId, true);
    };

    if (!state.entities.length) {
      return h('div', { class: 'view' },
        h('div', { class: 'welcome card' },
          h('h2', null, 'Willkommen 👋'),
          h('p', null, 'Hier sammelst du alle steuerrelevanten Daten pro Jahr – getrennt nach Personen und Unternehmen. ' +
            'Zu jeder Position kannst du einmalige oder monatliche Beträge sowie Belege (Bilder/PDFs) hinterlegen.'),
          h('p', { class: 'muted' }, 'Alle Daten bleiben ausschließlich in diesem Browser gespeichert.'),
          h('div', { class: 'toolbar' },
            button('+ Person anlegen', () => addEntity('person'), 'primary'),
            button('+ Unternehmen anlegen', () => addEntity('company')))));
    }

    const entityRows = L.orderEntities(state.entities).map((e) => {
      const owner = L.ownerOf(e, state.entities);
      const ps = yearPositions.filter((p) => p.entityId === e.id);
      const et = L.totals(ps);
      return h('tr', { class: 'clickable', onclick: () => open(e.id) },
        h('td', { class: owner ? 'sub-name' : null }, e.name),
        h('td', null, e.type === 'company' ? 'Unternehmen' + (owner ? ' von ' + owner.name : '') : 'Person'),
        h('td', { class: 'num' }, String(ps.length)),
        h('td', { class: 'num' }, String(attachmentCount(ps))),
        h('td', { class: 'num' }, L.formatEuro(et.expense)),
        h('td', { class: 'num income-text' }, et.income ? L.formatEuro(et.income) : '–'));
    });

    const categoryRows = L.groupByCategory(yearPositions).map((g) => {
      const ct = L.totals(g.items);
      return h('tr', null,
        h('td', null, g.category),
        h('td', { class: 'num' }, String(g.items.length)),
        h('td', { class: 'num' }, L.formatEuro(ct.expense)),
        h('td', { class: 'num income-text' }, ct.income ? L.formatEuro(ct.income) : '–'));
    });

    const hints = [];
    for (const p of yearPositions) {
      const entity = entityById(p.entityId);
      if (!entity) continue;
      const label = (p.title || 'Ohne Bezeichnung') + ' (' + entity.name + ')';
      const filled = p.months.filter((m) => m !== null).length;
      if (p.kind === 'monthly' && filled > 0 && filled < 12) hints.push([p, label, 'nur ' + filled + ' von 12 Monaten ausgefüllt']);
      if (L.positionTotal(p) === 0) hints.push([p, label, 'ohne Betrag']);
      if (!p.attachmentIds.length) hints.push([p, label, 'ohne Beleg']);
    }

    return h('div', { class: 'view' },
      h('div', { class: 'view-head' },
        h('div', null, h('span', { class: 'eyebrow' }, 'Alle Personen & Unternehmen'), h('h2', null, 'Jahresübersicht ' + state.year))),
      h('div', { class: 'stats' },
        stat('Ausgaben', L.formatEuro(t.expense)),
        stat('Einnahmen', L.formatEuro(t.income), null, 'income'),
        stat('Positionen', String(yearPositions.length)),
        stat('Belege', String(attachmentCount(yearPositions)))),
      h('section', { class: 'card' },
        h('h3', null, 'Personen & Unternehmen'),
        h('div', { class: 'table-wrap' },
          h('table', null,
            h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Typ'), h('th', { class: 'num' }, 'Positionen'),
              h('th', { class: 'num' }, 'Belege'), h('th', { class: 'num' }, 'Ausgaben'), h('th', { class: 'num' }, 'Einnahmen'))),
            h('tbody', null, entityRows)))),
      categoryRows.length ? h('section', { class: 'card' },
        h('h3', null, 'Nach Kategorie'),
        h('div', { class: 'table-wrap' },
          h('table', null,
            h('thead', null, h('tr', null, h('th', null, 'Kategorie'), h('th', { class: 'num' }, 'Positionen'),
              h('th', { class: 'num' }, 'Ausgaben'), h('th', { class: 'num' }, 'Einnahmen'))),
            h('tbody', null, categoryRows)))) : null,
      hints.length ? h('section', { class: 'card' },
        h('h3', null, 'Noch offen (' + hints.length + ')'),
        h('ul', { class: 'hints' }, hints.map(([p, label, text]) =>
          h('li', null, h('button', { type: 'button', class: 'link-btn', onclick: () => open(p.entityId, p.id) }, label), ' – ', text)))) : null);
  }

  // ---------------------------------------------------------------------------
  // Start

  function bindTopbar() {
    document.getElementById('year-select').addEventListener('change', (e) => setYear(Number(e.target.value)));
    document.getElementById('add-year').addEventListener('click', async () => {
      const suggestion = Math.max(...state.years) + 1;
      const value = await promptDialog('Jahr hinzufügen', 'Jahr', String(suggestion), { type: 'number', min: '1990', max: '2100', step: '1' });
      if (value) setYear(Number(value));
    });
    document.getElementById('export').addEventListener('click', exportDialog);
    document.getElementById('export-backup').addEventListener('click', exportBackup);
    const importInput = document.getElementById('import-file');
    document.getElementById('import-backup').addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (file) importBackup(file);
    });
  }

  async function start() {
    bindTopbar();
    document.getElementById('claude-notice').hidden = !inClaude;
    try {
      await DB.open();
    } catch (e) {
      document.getElementById('main').replaceChildren(h('div', { class: 'empty' },
        h('p', null, 'Der lokale Speicher (IndexedDB) ist in diesem Browser nicht verfügbar.'),
        h('p', { class: 'muted' }, 'Bitte einen aktuellen Browser verwenden und ggf. den privaten Modus verlassen.')));
      return;
    }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !inClaude) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    await load();
    renderCategoryList();
    render();
  }

  start();
})();
