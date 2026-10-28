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
  const saveTimers = new Map();

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

  function segmented(options, current, onChange, label) {
    return h('div', { class: 'segmented', role: 'group', 'aria-label': label },
      options.map(([value, text]) => h('button', {
        type: 'button',
        class: value === current ? 'active' : '',
        'aria-pressed': value === current ? 'true' : 'false',
        onclick: () => { if (value !== current) onChange(value); },
      }, text)));
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1).replace('.', ',') + ' MB';
  }

  function totalsText(t) {
    const parts = [];
    if (t.expense || !t.income) parts.push(L.formatEuro(t.expense));
    if (t.income) parts.push('Einnahmen ' + L.formatEuro(t.income));
    return parts.join(' · ');
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
    clearTimeout(saveTimers.get(p.id));
    saveTimers.delete(p.id);
    return DB.put('positions', p);
  }

  function queueSave(p) {
    clearTimeout(saveTimers.get(p.id));
    saveTimers.set(p.id, setTimeout(() => savePosition(p), 250));
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
    const label = type === 'company' ? 'Unternehmen' : 'Person';
    const preset = ownerId === undefined ? currentPersonId() : ownerId;
    const result = await entityDialog(label + ' hinzufügen', type, '', preset);
    if (!result) return;
    const entity = L.createEntity(type, result.name, result.ownerId);
    await DB.put('entities', entity);
    state.entities.push(entity);
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
    state.view = { type: 'overview' };
    render();
  }

  async function addPosition(entity) {
    const p = L.createPosition({ year: state.year, entityId: entity.id, category: 'Sonstiges' });
    await savePosition(p);
    state.positions.push(p);
    render();
    const card = document.querySelector('[data-id="' + p.id + '"]');
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.querySelector('.title-input').focus();
    }
  }

  async function deletePosition(p) {
    const ok = await confirmDialog('Position löschen?',
      '„' + (p.title || 'Ohne Bezeichnung') + '“ wird samt ' + p.attachmentIds.length + ' Beleg(en) gelöscht.',
      'Löschen', true);
    if (!ok) return;
    clearTimeout(saveTimers.get(p.id));
    await DB.removeMany('attachments', p.attachmentIds);
    await DB.remove('positions', p.id);
    state.positions = state.positions.filter((x) => x.id !== p.id);
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

  async function addFiles(p, files, list) {
    const accepted = [];
    const rejected = [];
    for (const file of files) {
      if (file.type.startsWith('image/') || file.type === 'application/pdf') accepted.push(file);
      else rejected.push(file.name);
    }
    for (const file of accepted) {
      const att = {
        id: L.uid(),
        positionId: p.id,
        name: file.name,
        type: file.type,
        size: file.size,
        blob: file,
        addedAt: new Date().toISOString(),
      };
      await DB.put('attachments', att);
      p.attachmentIds.push(att.id);
    }
    if (accepted.length) {
      await savePosition(p);
      renderAttachments(p, list);
      updateTotals();
    }
    if (rejected.length) {
      await alertDialog('Nicht unterstützt', 'Nur Bilder und PDFs können angehängt werden: ' + rejected.join(', '));
    }
  }

  async function removeAttachment(p, att, list) {
    const ok = await confirmDialog('Beleg entfernen?', '„' + att.name + '“ wird gelöscht.', 'Entfernen', true);
    if (!ok) return;
    await DB.remove('attachments', att.id);
    p.attachmentIds = p.attachmentIds.filter((id) => id !== att.id);
    await savePosition(p);
    renderAttachments(p, list);
    updateTotals();
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
    for (const p of state.positions) if (saveTimers.has(p.id)) await savePosition(p);
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
    for (const p of state.positions) if (saveTimers.has(p.id)) await savePosition(p);
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

  function exportCsv() {
    const byId = Object.fromEntries(state.entities.map((e) => [e.id, e]));
    const order = new Map(L.orderEntities(state.entities).map((e, i) => [e.id, i]));
    const positions = state.positions
      .filter((p) => p.year === state.year)
      .sort((a, b) => (order.get(a.entityId) - order.get(b.entityId)) ||
        a.category.localeCompare(b.category, 'de') || a.title.localeCompare(b.title, 'de'));
    download('steuer-belege-' + state.year + '.csv', L.buildCsv(positions, byId), 'text/csv;charset=utf-8');
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
      onclick: () => { state.view = { type: 'entity', id: e.id }; render(); },
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
        onclick: () => { state.view = { type: 'overview' }; render(); },
      }, 'Jahresübersicht ' + state.year),
      group('person', 'Personen'),
      group('company', 'Unternehmen'));
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
    main.replaceChildren(entity ? entityView(entity) : overviewView());
  }

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
    const groups = L.groupByCategory(positions);
    const owner = L.ownerOf(entity, state.entities);
    const open = (id) => { state.view = { type: 'entity', id }; render(); window.scrollTo(0, 0); };
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
        stat('Ausgaben', L.formatEuro(t.expense), 'expense'),
        stat('Einnahmen', L.formatEuro(t.income), 'income', 'income'),
        stat('Positionen', String(positions.length)),
        stat('Belege', String(attachmentCount(positions)), 'attachments')),
      entity.type === 'person' ? ownedCompanies(entity, open) : null,
      h('div', { class: 'toolbar' },
        button('+ Position hinzufügen', () => addPosition(entity), 'primary'),
        button('Aus Vorjahr übernehmen', () => copyFromPreviousYear(entity))),
      positions.length
        ? groups.map((g) => h('section', { class: 'category' },
          h('div', { class: 'category-head' },
            h('h3', null, g.category),
            h('span', { class: 'category-sum', dataset: { catTotal: g.category } }, totalsText(L.totals(g.items)))),
          g.items.map(positionCard)))
        : h('div', { class: 'empty' },
          h('p', null, 'Für ' + state.year + ' gibt es noch keine Positionen.'),
          h('p', { class: 'muted' }, 'Lege z.B. ein Bankkonto, eine Kfz-Versicherung oder die Kfz-Steuer an.')));
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

  function updateTotals() {
    updateSidebarSums();
    const entity = state.view.type === 'entity' ? entityById(state.view.id) : null;
    if (!entity) return;
    const positions = positionsFor(entity.id, state.year);
    const t = L.totals(positions);
    const set = (sel, text) => { const el = document.querySelector(sel); if (el) el.textContent = text; };
    set('[data-sum="expense"]', L.formatEuro(t.expense));
    set('[data-sum="income"]', L.formatEuro(t.income));
    set('[data-sum="attachments"]', String(attachmentCount(positions)));
    for (const el of document.querySelectorAll('[data-cat-total]')) {
      el.textContent = totalsText(L.totals(positions.filter((p) => p.category === el.dataset.catTotal)));
    }
    for (const el of document.querySelectorAll('[data-pos-total]')) {
      const p = positions.find((x) => x.id === el.dataset.posTotal);
      if (p) el.textContent = L.formatEuro(L.positionTotal(p));
    }
  }

  function amountInput(getValue, setValue, attrs) {
    const input = h('input', Object.assign({
      class: 'amount',
      inputmode: 'decimal',
      autocomplete: 'off',
      placeholder: '0,00',
      value: L.formatAmount(getValue()),
    }, attrs || {}));
    input.addEventListener('input', () => {
      const v = L.parseAmount(input.value);
      input.classList.toggle('invalid', Number.isNaN(v));
      if (!Number.isNaN(v)) setValue(v);
    });
    input.addEventListener('change', () => {
      const v = L.parseAmount(input.value);
      if (!Number.isNaN(v)) input.value = L.formatAmount(v);
    });
    return input;
  }

  function positionCard(p) {
    const rerender = () => card.replaceWith(positionCard(p));
    const onAmountChange = () => { queueSave(p); updateTotals(); };

    const card = h('article', { class: 'card position ' + p.direction, dataset: { id: p.id } },
      h('div', { class: 'card-head' },
        h('input', {
          class: 'title-input',
          value: p.title,
          placeholder: 'Bezeichnung, z.B. Kfz-Versicherung',
          'aria-label': 'Bezeichnung',
          oninput: (e) => { p.title = e.target.value; queueSave(p); },
        }),
        h('span', { class: 'pos-total', dataset: { posTotal: p.id } }, L.formatEuro(L.positionTotal(p))),
        h('button', { type: 'button', class: 'icon-btn danger', title: 'Position löschen', onclick: () => deletePosition(p) }, '🗑')),
      h('div', { class: 'card-meta' },
        h('label', { class: 'field' }, h('span', null, 'Kategorie'),
          h('input', {
            class: 'input',
            list: 'category-list',
            value: p.category,
            onchange: async (e) => {
              p.category = e.target.value.trim() || 'Sonstiges';
              await ensureCategory(p.category);
              await savePosition(p);
              renderMain();
            },
          })),
        h('label', { class: 'field' }, h('span', null, 'Kennung (IBAN, Kennzeichen, Vertragsnr. …)'),
          h('input', { class: 'input', value: p.reference, oninput: (e) => { p.reference = e.target.value; queueSave(p); } })),
        h('div', { class: 'field' }, h('span', null, 'Zahlung'),
          segmented([['monthly', 'Monatlich'], ['once', 'Einmalig']], p.kind,
            async (v) => { p.kind = v; await savePosition(p); rerender(); updateTotals(); }, 'Zahlungsart')),
        h('div', { class: 'field' }, h('span', null, 'Art'),
          segmented([['expense', 'Ausgabe'], ['income', 'Einnahme']], p.direction,
            async (v) => { p.direction = v; await savePosition(p); rerender(); updateTotals(); }, 'Ausgabe oder Einnahme'))),
      p.kind === 'monthly' ? monthGrid(p, onAmountChange) : onceRow(p, onAmountChange),
      h('label', { class: 'field note' }, h('span', null, 'Notiz'),
        h('textarea', { class: 'input', rows: '1', placeholder: 'Optional', oninput: (e) => { p.note = e.target.value; queueSave(p); } }, p.note)),
      attachmentSection(p));

    card.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      card.classList.add('dragging');
    });
    card.addEventListener('dragleave', (e) => {
      if (!card.contains(e.relatedTarget)) card.classList.remove('dragging');
    });
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('dragging');
      if (e.dataTransfer.files.length) addFiles(p, e.dataTransfer.files, card.querySelector('.attachment-list'));
    });
    return card;
  }

  function monthGrid(p, onChange) {
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
        input.classList.remove('invalid');
        if (j > i) {
          input.classList.remove('flash');
          void input.offsetWidth;
          input.classList.add('flash');
        }
      });
      await savePosition(p);
      updateTotals();
    }

    async function clearAll() {
      if (p.months.every((m) => m === null)) return;
      const ok = await confirmDialog('Alle Monate leeren?', 'Alle 12 Monatsbeträge dieser Position werden entfernt.', 'Leeren', true);
      if (!ok) return;
      p.months = L.emptyMonths();
      inputs.forEach((input) => { input.value = ''; });
      await savePosition(p);
      updateTotals();
    }

    const grid = h('div', { class: 'months' }, L.MONTHS.map((m, i) => {
      const input = amountInput(() => p.months[i], (v) => { p.months[i] = v; onChange(); }, { 'aria-label': L.MONTHS_LONG[i] });
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

  function onceRow(p, onChange) {
    return h('div', { class: 'once-row' },
      h('label', { class: 'field' }, h('span', null, 'Datum'),
        h('input', {
          class: 'input',
          type: 'date',
          value: p.onceDate,
          min: state.year + '-01-01',
          max: state.year + '-12-31',
          onchange: (e) => { p.onceDate = e.target.value; queueSave(p); },
        })),
      h('label', { class: 'field' }, h('span', null, 'Betrag (€)'),
        amountInput(() => p.onceAmount, (v) => { p.onceAmount = v; onChange(); })));
  }

  function attachmentSection(p) {
    const list = h('div', { class: 'attachment-list' });
    const fileInput = h('input', {
      type: 'file',
      multiple: true,
      accept: 'image/*,application/pdf',
      hidden: true,
      onchange: (e) => {
        const files = Array.from(e.target.files);
        e.target.value = '';
        addFiles(p, files, list);
      },
    });
    renderAttachments(p, list);
    return h('div', { class: 'attachments' },
      list,
      h('div', { class: 'attach-actions' },
        fileInput,
        button('📎 Beleg anhängen (Bild/PDF)', () => fileInput.click(), 'small'),
        h('span', { class: 'muted drop-hint' }, 'oder Datei auf die Karte ziehen')));
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

  async function renderAttachments(p, list) {
    const atts = (await Promise.all(p.attachmentIds.map((id) => DB.get('attachments', id)))).filter(Boolean);
    list.replaceChildren(...atts.map((a) => {
      const url = URL.createObjectURL(a.blob);
      objectUrls.push(url);
      const isImage = a.type.startsWith('image/');
      return h('div', { class: 'chip' },
        h('button', { type: 'button', class: 'chip-main', title: a.name + ' öffnen', onclick: () => openAttachment(a, url) },
          isImage ? h('img', { src: url, alt: '' }) : h('span', { class: 'file-icon' }, 'PDF'),
          h('span', { class: 'chip-text' },
            h('span', { class: 'chip-name' }, a.name),
            h('span', { class: 'chip-size' }, formatSize(a.size)))),
        h('button', { type: 'button', class: 'chip-btn', title: 'Herunterladen', onclick: () => download(a.name, a.blob) }, '⤓'),
        h('button', { type: 'button', class: 'chip-btn danger', title: 'Beleg entfernen', onclick: () => removeAttachment(p, a, list) }, '✕'));
    }));
  }

  function overviewView() {
    const yearPositions = state.positions.filter((p) => p.year === state.year);
    const t = L.totals(yearPositions);
    const open = (entityId, positionId) => {
      state.view = { type: 'entity', id: entityId };
      render();
      if (positionId) {
        const card = document.querySelector('[data-id="' + positionId + '"]');
        if (card) {
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          card.classList.add('highlight');
          setTimeout(() => card.classList.remove('highlight'), 1600);
        }
      }
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
    document.getElementById('export-csv').addEventListener('click', exportCsv);
    document.getElementById('export-backup').addEventListener('click', exportBackup);
    const importInput = document.getElementById('import-file');
    document.getElementById('import-backup').addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (file) importBackup(file);
    });
    window.addEventListener('pagehide', () => {
      for (const p of state.positions) if (saveTimers.has(p.id)) savePosition(p);
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
