/*
 * Reine Datenlogik ohne DOM- oder Datenbankzugriff.
 * Beträge werden intern als ganze Cent gespeichert, um Rundungsfehler zu vermeiden.
 * Läuft im Browser (window.Logic) und in Node (module.exports) für Tests.
 */
(function (root) {
  'use strict';

  const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
  const MONTHS_LONG = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August',
    'September', 'Oktober', 'November', 'Dezember'];

  const DEFAULT_CATEGORIES = [
    'Bankkonten',
    'Versicherungen',
    'Kfz',
    'Wohnung / Miete',
    'Arbeitsmittel',
    'Fahrtkosten',
    'Fortbildung',
    'Gesundheit',
    'Kinderbetreuung',
    'Haushaltsnahe Dienstleistungen',
    'Spenden',
    'Einnahmen',
    'Sonstiges',
  ];

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  /**
   * Liest einen Betrag in deutscher oder englischer Schreibweise ein und gibt Cent zurück.
   * Leere Eingabe ergibt null. Ungültige Eingabe ergibt NaN.
   *   "1.234,56" -> 123456, "12,5" -> 1250, "12.50" -> 1250, "1.234" -> 123400
   */
  function parseAmount(input) {
    if (input === null || input === undefined) return null;
    let s = String(input).trim().replace(/[€\s ]/g, '');
    if (s === '') return null;
    let negative = false;
    if (s.startsWith('-')) {
      negative = true;
      s = s.slice(1);
    }
    if (s.includes(',')) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
      s = s.replace(/\./g, '');
    }
    if (!/^\d*(\.\d*)?$/.test(s) || s === '.') return NaN;
    const cents = Math.round(parseFloat(s) * 100);
    return negative ? -cents : cents;
  }

  /** Cent -> "1.234,56" (ohne Währungszeichen). null -> "". */
  function formatAmount(cents) {
    if (cents === null || cents === undefined || Number.isNaN(cents)) return '';
    const negative = cents < 0;
    const abs = Math.abs(cents);
    const euros = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    const rest = String(abs % 100).padStart(2, '0');
    return (negative ? '-' : '') + euros + ',' + rest;
  }

  /** Cent -> "1.234,56 €". */
  function formatEuro(cents) {
    return formatAmount(cents || 0) + ' €';
  }

  function emptyMonths() {
    return new Array(12).fill(null);
  }

  function createPosition(fields) {
    return Object.assign({
      id: uid(),
      year: new Date().getFullYear(),
      entityId: null,
      category: 'Sonstiges',
      title: '',
      reference: '',
      note: '',
      kind: 'monthly', // 'monthly' | 'once'
      direction: 'expense', // 'expense' | 'income'
      onceAmount: null,
      onceDate: '',
      months: emptyMonths(),
      attachmentIds: [],
      createdAt: new Date().toISOString(),
    }, fields || {});
  }

  function createEntity(type, name) {
    return { id: uid(), type: type, name: name, createdAt: new Date().toISOString() };
  }

  /**
   * Überträgt den Wert des Monats `fromIndex` auf alle folgenden Monate.
   * Gibt ein neues Array zurück.
   */
  function fillForward(months, fromIndex) {
    const result = months.slice();
    const value = result[fromIndex];
    for (let i = fromIndex + 1; i < 12; i++) result[i] = value;
    return result;
  }

  /** Jahressumme einer Position in Cent. */
  function positionTotal(position) {
    if (position.kind === 'once') return position.onceAmount || 0;
    return position.months.reduce((sum, v) => sum + (v || 0), 0);
  }

  /** Summen getrennt nach Ausgaben und Einnahmen. */
  function totals(positions) {
    const result = { expense: 0, income: 0 };
    for (const p of positions) result[p.direction === 'income' ? 'income' : 'expense'] += positionTotal(p);
    return result;
  }

  /** Gruppiert Positionen nach Kategorie, Kategorien alphabetisch sortiert. */
  function groupByCategory(positions) {
    const map = new Map();
    for (const p of positions) {
      const key = p.category || 'Sonstiges';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(p);
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0].localeCompare(b[0], 'de'))
      .map(([category, items]) => ({ category, items }));
  }

  /**
   * Kopiert Positionen aus einem Vorjahr in ein Zieljahr.
   * Positionen, die im Zieljahr schon existieren (gleicher Titel + Kategorie), werden übersprungen.
   * Belege werden nie mitkopiert, da sie zum jeweiligen Jahr gehören.
   */
  function copyPositionsToYear(sourcePositions, existingTargetPositions, targetYear, keepAmounts) {
    const key = (p) => (p.category + '\u0000' + p.title).toLowerCase();
    const existing = new Set(existingTargetPositions.map(key));
    const copies = [];
    for (const p of sourcePositions) {
      if (existing.has(key(p))) continue;
      copies.push(createPosition({
        year: targetYear,
        entityId: p.entityId,
        category: p.category,
        title: p.title,
        reference: p.reference,
        note: p.note,
        kind: p.kind,
        direction: p.direction,
        onceAmount: keepAmounts ? p.onceAmount : null,
        onceDate: keepAmounts && p.onceDate ? String(targetYear) + p.onceDate.slice(4) : '',
        months: keepAmounts ? p.months.slice() : emptyMonths(),
      }));
    }
    return copies;
  }

  /**
   * Beschreibt für jede Person/jedes Unternehmen aus einem fremden Export, was beim
   * Hinzufügen passiert: 'new' (gibt es noch nicht) oder 'update' (gleiche ID, also schon
   * einmal übernommen). sameName markiert neue Einträge, deren Name es schon gibt.
   */
  function describeImport(currentEntities, incoming) {
    const ids = new Set(currentEntities.map((e) => e.id));
    const names = new Set(currentEntities.map((e) => e.name.trim().toLowerCase()));
    return (incoming.entities || []).map((entity) => {
      const positions = (incoming.positions || []).filter((p) => p.entityId === entity.id);
      const isUpdate = ids.has(entity.id);
      return {
        entity,
        status: isUpdate ? 'update' : 'new',
        sameName: !isUpdate && names.has(entity.name.trim().toLowerCase()),
        positionCount: positions.length,
        years: Array.from(new Set(positions.map((p) => p.year))).sort(),
      };
    });
  }

  /**
   * Plant das Zusammenführen eines Exports in die eigenen Daten. Für jede gewählte
   * Person/jedes gewählte Unternehmen gilt der Stand aus dem Export: vorhandene Positionen
   * dazu werden entfernt und durch die importierten ersetzt (so kommen auch Löschungen an).
   * Alle anderen eigenen Daten bleiben unberührt.
   */
  function planMerge(current, incoming, selectedEntityIds) {
    const selected = new Set(selectedEntityIds);
    const removedPositions = current.positions.filter((p) => selected.has(p.entityId));
    const addedPositions = (incoming.positions || []).filter((p) => selected.has(p.entityId));
    return {
      entities: (incoming.entities || []).filter((e) => selected.has(e.id)),
      removedPositions,
      addedPositions,
      removedAttachmentIds: removedPositions.flatMap((p) => p.attachmentIds || []),
      addedAttachmentIds: addedPositions.flatMap((p) => p.attachmentIds || []),
    };
  }

  function csvCell(value) {
    const s = value === null || value === undefined ? '' : String(value);
    return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /**
   * CSV (Semikolon, Dezimalkomma) für Excel/LibreOffice.
   * entitiesById: { [id]: entity }
   */
  function buildCsv(positions, entitiesById) {
    const header = ['Jahr', 'Typ', 'Person/Unternehmen', 'Kategorie', 'Position', 'Kennung', 'Art',
      'Zahlung', 'Datum (einmalig)'].concat(MONTHS_LONG, ['Jahressumme', 'Anzahl Belege', 'Notiz']);
    const rows = [header];
    for (const p of positions) {
      const entity = entitiesById[p.entityId] || { name: '?', type: '' };
      const months = p.kind === 'monthly' ? p.months.map(formatAmount) : new Array(12).fill('');
      rows.push([
        p.year,
        entity.type === 'company' ? 'Unternehmen' : 'Person',
        entity.name,
        p.category,
        p.title,
        p.reference,
        p.direction === 'income' ? 'Einnahme' : 'Ausgabe',
        p.kind === 'once' ? 'Einmalig' : 'Monatlich',
        p.kind === 'once' ? p.onceDate : '',
      ].concat(months, [formatAmount(positionTotal(p)), p.attachmentIds.length, p.note]));
    }
    return '﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n');
  }

  const Logic = {
    MONTHS,
    MONTHS_LONG,
    DEFAULT_CATEGORIES,
    uid,
    parseAmount,
    formatAmount,
    formatEuro,
    emptyMonths,
    createPosition,
    createEntity,
    fillForward,
    positionTotal,
    totals,
    groupByCategory,
    copyPositionsToYear,
    describeImport,
    planMerge,
    buildCsv,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Logic;
  else root.Logic = Logic;
})(typeof window !== 'undefined' ? window : globalThis);
