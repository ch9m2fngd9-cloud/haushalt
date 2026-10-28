/*
 * Erzeugt den PDF-Bericht: Übersicht, alle Positionen je Person/Unternehmen und
 * optional alle Belege als Anhang (Bilder als Seite, PDFs mit ihren Originalseiten).
 * Braucht die Bibliothek pdf-lib (global PDFLib) und Logic.
 */
(function (root) {
  'use strict';

  const PAGE = [595.28, 841.89]; // A4 in Punkt
  const MARGIN = 48;
  const CONTENT_W = PAGE[0] - 2 * MARGIN;

  // Standardschriften können nur WinAnsi (Latin-1 plus €, „“ usw.); alles andere wird zu '?'.
  const WIN_ANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';

  const REPLACEMENTS = { '→': '->', '←': '<-', '⇒': '=>', '✓': 'ok', '✔': 'ok', '≈': '~', '−': '-', '\u00a0': ' ' };

  function safe(text) {
    let out = '';
    for (const ch of String(text === null || text === undefined ? '' : text)) {
      const c = ch.codePointAt(0);
      if (ch === '\t' || ch === '\r' || ch === '\n') out += ' ';
      else if (REPLACEMENTS[ch]) out += REPLACEMENTS[ch];
      else if ((c >= 32 && c < 127) || (c >= 160 && c <= 255) || WIN_ANSI_EXTRA.includes(ch)) out += ch;
      else if (c > 0xffff || (c >= 0x2600 && c <= 0x27bf) || c === 0xfe0f || c === 0x200d) continue; // Emojis weglassen
      else out += '?';
    }
    return out.replace(/ {2,}/g, ' ');
  }

  function formatDate(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    return d + '.' + m + '.' + y;
  }

  class Writer {
    constructor(PDFLib, doc, fonts) {
      this.rgb = PDFLib.rgb;
      this.doc = doc;
      this.regular = fonts.regular;
      this.bold = fonts.bold;
      this.colors = {
        text: this.rgb(0.11, 0.14, 0.19),
        muted: this.rgb(0.42, 0.45, 0.52),
        line: this.rgb(0.85, 0.87, 0.9),
        accent: this.rgb(0.18, 0.44, 0.87),
        income: this.rgb(0.12, 0.54, 0.32),
        band: this.rgb(0.95, 0.96, 0.97),
      };
      this.newPage();
    }

    newPage() {
      this.page = this.doc.addPage(PAGE);
      this.y = PAGE[1] - MARGIN;
    }

    ensure(height) {
      if (this.y - height < MARGIN + 16) this.newPage();
    }

    width(text, size, bold) {
      return (bold ? this.bold : this.regular).widthOfTextAtSize(safe(text), size);
    }

    draw(text, x, y, opts) {
      const o = opts || {};
      this.page.drawText(safe(text), {
        x, y, size: o.size || 10, font: o.bold ? this.bold : this.regular, color: o.color || this.colors.text,
      });
    }

    drawRight(text, xRight, y, opts) {
      const o = opts || {};
      this.draw(text, xRight - this.width(text, o.size || 10, o.bold), y, o);
    }

    /** Text auf mehrere Zeilen umbrechen; zu lange Wörter werden hart getrennt. */
    wrap(text, size, maxWidth, bold) {
      const lines = [];
      for (const paragraph of [safe(text)]) {
        let line = '';
        for (const word of paragraph.split(' ')) {
          const candidate = line ? line + ' ' + word : word;
          if (this.width(candidate, size, bold) <= maxWidth) { line = candidate; continue; }
          if (line) lines.push(line);
          line = word;
          while (this.width(line, size, bold) > maxWidth && line.length > 1) {
            let cut = line.length - 1;
            while (cut > 1 && this.width(line.slice(0, cut), size, bold) > maxWidth) cut--;
            lines.push(line.slice(0, cut));
            line = line.slice(cut);
          }
        }
        lines.push(line);
      }
      return lines;
    }

    /** Text auf maximale Breite kürzen (mit …). */
    fit(text, size, maxWidth, bold) {
      let s = safe(text);
      if (this.width(s, size, bold) <= maxWidth) return s;
      while (s.length > 1 && this.width(s + '…', size, bold) > maxWidth) s = s.slice(0, -1);
      return s + '…';
    }

    hline(y, color) {
      this.page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE[0] - MARGIN, y }, thickness: 0.6, color: color || this.colors.line });
    }

    /** Tabelle mit fester Spaltenaufteilung. columns: [{label, width, align}] */
    table(columns, rows, opts) {
      const size = 9;
      const rowH = 17;
      const header = () => {
        this.ensure(rowH * 2);
        let x = MARGIN;
        for (const c of columns) {
          if (c.align === 'right') this.drawRight(c.label, x + c.width - 4, this.y - 11, { size: 8, color: this.colors.muted, bold: true });
          else this.draw(c.label, x + 4, this.y - 11, { size: 8, color: this.colors.muted, bold: true });
          x += c.width;
        }
        this.y -= rowH;
        this.hline(this.y);
      };
      header();
      rows.forEach((row, i) => {
        if (this.y - rowH < MARGIN + 16) { this.newPage(); header(); }
        const isTotal = opts && opts.totalRow && i === rows.length - 1;
        if (isTotal) this.page.drawRectangle({ x: MARGIN, y: this.y - rowH, width: CONTENT_W, height: rowH, color: this.colors.band });
        let x = MARGIN;
        row.forEach((cell, j) => {
          const c = columns[j];
          const value = cell && typeof cell === 'object' ? cell : { text: cell };
          const text = this.fit(value.text, size, c.width - 8 - (value.indent || 0), isTotal);
          const style = { size, bold: isTotal, color: value.color };
          if (c.align === 'right') this.drawRight(text, x + c.width - 4, this.y - 12, style);
          else this.draw(text, x + 4 + (value.indent || 0), this.y - 12, style);
          x += c.width;
        });
        this.y -= rowH;
        this.hline(this.y);
      });
      this.y -= 14;
    }
  }

  /** Eine Position als Block; wird nie über einen Seitenumbruch geteilt. */
  function drawPosition(w, L, p, receiptNumbers) {
    const meta = [];
    meta.push(p.kind === 'once' ? 'Einmalig' + (p.onceDate ? ' am ' + formatDate(p.onceDate) : '') : 'Monatlich');
    if (p.direction === 'income') meta.push('Einnahme');
    if (p.reference) meta.push(p.reference);
    if (receiptNumbers.length) {
      meta.push((receiptNumbers.length === 1 ? 'Beleg ' : 'Belege ') + receiptNumbers.join(', '));
    } else if (p.attachmentIds.length) {
      meta.push(p.attachmentIds.length + ' Beleg(e)');
    }
    const metaLines = w.wrap(meta.join(' · '), 8.5, CONTENT_W - 90);
    const noteLines = p.note ? w.wrap('Notiz: ' + p.note, 8.5, CONTENT_W - 10) : [];
    const showMonths = p.kind === 'monthly' && p.months.some((m) => m !== null);
    const height = 16 + metaLines.length * 11 + (showMonths ? 44 : 0) + noteLines.length * 11 + 10;
    w.ensure(height);

    const total = L.positionTotal(p);
    const color = p.direction === 'income' ? w.colors.income : w.colors.text;
    w.draw(w.fit(p.title || 'Ohne Bezeichnung', 10.5, CONTENT_W - 110, true), MARGIN, w.y - 11, { size: 10.5, bold: true });
    w.drawRight((p.direction === 'income' ? '+' : '') + L.formatEuro(total), PAGE[0] - MARGIN, w.y - 11, { size: 10.5, bold: true, color });
    w.y -= 16;
    for (const line of metaLines) {
      w.draw(line, MARGIN, w.y - 8, { size: 8.5, color: w.colors.muted });
      w.y -= 11;
    }

    if (showMonths) {
      w.y -= 3;
      const colW = CONTENT_W / 6;
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 6; col++) {
          const i = row * 6 + col;
          const x = MARGIN + col * colW;
          w.draw(L.MONTHS[i], x, w.y - 7, { size: 7, color: w.colors.muted });
          const v = p.months[i];
          w.drawRight(v === null ? '–' : L.formatAmount(v), x + colW - 8, w.y - 7, { size: 8.5, color: v === null ? w.colors.muted : w.colors.text });
        }
        w.y -= 20;
      }
      w.y += 2;
    }

    for (const line of noteLines) {
      w.draw(line, MARGIN, w.y - 8, { size: 8.5, color: w.colors.muted });
      w.y -= 11;
    }
    w.y -= 6;
    w.hline(w.y);
    w.y -= 8;
  }

  async function bytesOf(blob) {
    return new Uint8Array(await blob.arrayBuffer());
  }

  /** Beleg-Kopfzeile auf einer neuen Seite; liefert die verbleibende Höhe. */
  function receiptHeader(w, number, label) {
    w.newPage();
    w.draw('Beleg ' + number, MARGIN, w.y - 12, { size: 12, bold: true, color: w.colors.accent });
    w.draw(w.fit(label, 9, CONTENT_W - 70), MARGIN + 62, w.y - 12, { size: 9, color: w.colors.muted });
    w.y -= 22;
    w.hline(w.y);
    w.y -= 10;
    return w.y - MARGIN - 16;
  }

  function receiptError(w, number, label, message) {
    receiptHeader(w, number, label);
    for (const line of w.wrap(message, 10, CONTENT_W)) {
      w.draw(line, MARGIN, w.y - 12, { size: 10 });
      w.y -= 15;
    }
  }

  async function appendReceipt(PDFLib, doc, w, receipt, toJpeg) {
    const { number, label, attachment } = receipt;
    const type = attachment.type || '';
    try {
      if (type === 'application/pdf') {
        const source = await PDFLib.PDFDocument.load(await bytesOf(attachment.blob), { ignoreEncryption: true });
        const indices = source.getPageIndices();
        // Seiten ohne Inhalt (z.B. ganz leere) lassen sich nicht einbetten; pdf-lib merkt das
        // erst beim Speichern. Dann werden die Seiten unverändert übernommen.
        const embeddable = indices.every((i) => source.getPage(i).node.Contents());
        let embedded;
        try {
          if (!embeddable) throw new Error('Seite ohne Inhalt');
          embedded = await doc.embedPdf(source, indices);
        } catch (e) {
          const copies = await doc.copyPages(source, indices);
          copies.forEach((page, i) => {
            doc.addPage(page);
            const text = safe('Beleg ' + number + ' · ' + label + (copies.length > 1 ? ' (Seite ' + (i + 1) + ')' : ''));
            page.drawText(text, { x: 12, y: page.getHeight() - 14, size: 7, font: w.regular, color: w.colors.muted });
          });
          return;
        }
        embedded.forEach((ep, i) => {
          const available = receiptHeader(w, number, label + (indices.length > 1 ? ' (Seite ' + (i + 1) + ' von ' + indices.length + ')' : ''));
          const scale = Math.min(CONTENT_W / ep.width, available / ep.height, 1);
          const width = ep.width * scale;
          const height = ep.height * scale;
          w.page.drawRectangle({ x: MARGIN + (CONTENT_W - width) / 2 - 0.5, y: w.y - height - 0.5, width: width + 1, height: height + 1, borderColor: w.colors.line, borderWidth: 0.5 });
          w.page.drawPage(ep, { x: MARGIN + (CONTENT_W - width) / 2, y: w.y - height, width, height });
        });
        return;
      }
      if (type.startsWith('image/')) {
        let image;
        if (type === 'image/jpeg' || type === 'image/jpg') image = await doc.embedJpg(await bytesOf(attachment.blob));
        else if (type === 'image/png') image = await doc.embedPng(await bytesOf(attachment.blob));
        else if (toJpeg) image = await doc.embedJpg(await toJpeg(attachment.blob));
        else throw new Error('Bildformat ' + type + ' wird nicht unterstützt');
        const available = receiptHeader(w, number, label);
        const scale = Math.min(CONTENT_W / image.width, available / image.height, 1);
        const width = image.width * scale;
        const height = image.height * scale;
        w.page.drawImage(image, { x: MARGIN + (CONTENT_W - width) / 2, y: w.y - height, width, height });
        return;
      }
      throw new Error('Dateityp ' + type + ' wird nicht unterstützt');
    } catch (e) {
      receiptError(w, number, label, 'Dieser Beleg konnte nicht in das PDF eingebunden werden. Die Datei ist ' +
        'beschädigt, passwortgeschützt oder hat ein nicht unterstütztes Format. Bitte die Originaldatei „' +
        attachment.name + '“ separat beilegen.');
    }
  }

  /**
   * options: {
   *   PDFLib, Logic, year, title, subtitle,
   *   entities (in Ausgabereihenfolge), allEntities, positions (des Jahres),
   *   includeReceipts, getAttachment(id) -> {name, type, blob}, toJpeg(blob) -> Uint8Array
   * }
   * Liefert die PDF-Datei als Uint8Array.
   */
  async function build(options) {
    const { PDFLib, Logic: L } = options;
    const doc = await PDFLib.PDFDocument.create();
    doc.setTitle(safe(options.title));
    doc.setCreator('Steuer-Belege');
    const fonts = {
      regular: await doc.embedFont(PDFLib.StandardFonts.Helvetica),
      bold: await doc.embedFont(PDFLib.StandardFonts.HelveticaBold),
    };
    const w = new Writer(PDFLib, doc, fonts);
    const all = options.allEntities || options.entities;
    const positionsOf = (id) => options.positions
      .filter((p) => p.entityId === id)
      .sort((a, b) => a.category.localeCompare(b.category, 'de') ||
        a.title.localeCompare(b.title, 'de', { numeric: true }));
    const typeLabel = (e) => {
      const owner = L.ownerOf(e, all);
      return e.type === 'company' ? 'Unternehmen' + (owner ? ' von ' + owner.name : '') : 'Person';
    };

    // Belege in Reihenfolge des Berichts nummerieren
    const receipts = [];
    const receiptNumbers = new Map();
    if (options.includeReceipts) {
      for (const e of options.entities) {
        for (const p of positionsOf(e.id)) {
          const numbers = [];
          for (const id of p.attachmentIds) {
            const attachment = await options.getAttachment(id);
            if (!attachment) continue;
            const number = receipts.length + 1;
            numbers.push(number);
            receipts.push({ number, attachment, label: e.name + ' › ' + (p.title || 'Ohne Bezeichnung') + ' › ' + attachment.name });
          }
          receiptNumbers.set(p.id, numbers);
        }
      }
    }

    // Titel
    w.draw(options.title, MARGIN, w.y - 20, { size: 20, bold: true });
    w.y -= 30;
    w.draw(options.subtitle + ' · erstellt am ' + new Date().toLocaleDateString('de-DE'), MARGIN, w.y - 10, { size: 10, color: w.colors.muted });
    w.y -= 30;

    // Übersicht je Person/Unternehmen
    w.draw('Übersicht', MARGIN, w.y - 12, { size: 13, bold: true });
    w.y -= 20;
    const sum = { expense: 0, income: 0, count: 0, receipts: 0 };
    const rows = options.entities.map((e) => {
      const ps = positionsOf(e.id);
      const t = L.totals(ps);
      const r = ps.reduce((n, p) => n + p.attachmentIds.length, 0);
      sum.expense += t.expense; sum.income += t.income; sum.count += ps.length; sum.receipts += r;
      const sub = e.type === 'company' && L.ownerOf(e, all) && options.entities.includes(L.ownerOf(e, all));
      return [{ text: e.name, indent: sub ? 12 : 0 }, typeLabel(e), String(ps.length), String(r),
        L.formatEuro(t.expense), { text: t.income ? L.formatEuro(t.income) : '–', color: t.income ? w.colors.income : undefined }];
    });
    if (options.entities.length > 1) {
      rows.push(['Summe', '', String(sum.count), String(sum.receipts), L.formatEuro(sum.expense), sum.income ? L.formatEuro(sum.income) : '–']);
    }
    w.table([
      { label: 'Name', width: 130 },
      { label: 'Typ', width: 125 },
      { label: 'Positionen', width: 55, align: 'right' },
      { label: 'Belege', width: 45, align: 'right' },
      { label: 'Ausgaben', width: 72, align: 'right' },
      { label: 'Einnahmen', width: CONTENT_W - 427, align: 'right' },
    ], rows, { totalRow: options.entities.length > 1 });

    // Übersicht je Kategorie
    const scoped = options.entities.flatMap((e) => positionsOf(e.id));
    const groups = L.groupByCategory(scoped);
    if (groups.length) {
      w.ensure(80);
      w.draw('Nach Kategorie', MARGIN, w.y - 12, { size: 13, bold: true });
      w.y -= 20;
      w.table([
        { label: 'Kategorie', width: 255 },
        { label: 'Positionen', width: 100, align: 'right' },
        { label: 'Ausgaben', width: 72, align: 'right' },
        { label: 'Einnahmen', width: CONTENT_W - 427, align: 'right' },
      ], groups.map((g) => {
        const t = L.totals(g.items);
        return [g.category, String(g.items.length), L.formatEuro(t.expense),
          { text: t.income ? L.formatEuro(t.income) : '–', color: t.income ? w.colors.income : undefined }];
      }));
    }

    // Details je Person/Unternehmen
    for (const e of options.entities) {
      const ps = positionsOf(e.id);
      const t = L.totals(ps);
      w.ensure(90);
      w.y -= 8;
      w.page.drawRectangle({ x: MARGIN, y: w.y - 40, width: CONTENT_W, height: 40, color: w.colors.band });
      w.draw(w.fit(e.name, 15, CONTENT_W - 180, true), MARGIN + 10, w.y - 19, { size: 15, bold: true });
      w.draw(typeLabel(e) + ' · ' + options.year, MARGIN + 10, w.y - 32, { size: 8.5, color: w.colors.muted });
      w.drawRight('Ausgaben ' + L.formatEuro(t.expense), PAGE[0] - MARGIN - 10, w.y - 19, { size: 10, bold: true });
      if (t.income) w.drawRight('Einnahmen ' + L.formatEuro(t.income), PAGE[0] - MARGIN - 10, w.y - 32, { size: 9, color: w.colors.income });
      w.y -= 52;
      if (!ps.length) {
        w.draw('Keine Positionen in ' + options.year + '.', MARGIN, w.y - 10, { size: 9.5, color: w.colors.muted });
        w.y -= 24;
        continue;
      }
      for (const g of L.groupByCategory(ps)) {
        w.ensure(70);
        const gt = L.totals(g.items);
        w.draw(g.category, MARGIN, w.y - 11, { size: 11, bold: true, color: w.colors.accent });
        w.drawRight(L.formatEuro(gt.expense) + (gt.income ? ' · Einnahmen ' + L.formatEuro(gt.income) : ''),
          PAGE[0] - MARGIN, w.y - 11, { size: 9, color: w.colors.muted });
        w.y -= 16;
        w.hline(w.y, w.colors.accent);
        w.y -= 8;
        for (const p of g.items) drawPosition(w, L, p, receiptNumbers.get(p.id) || []);
        w.y -= 6;
      }
    }

    for (const receipt of receipts) await appendReceipt(PDFLib, doc, w, receipt, options.toJpeg);

    // Fußzeile mit Seitenzahlen
    const pages = doc.getPages();
    pages.forEach((page, i) => {
      const text = safe(options.title + ' · Seite ' + (i + 1) + ' von ' + pages.length);
      const width = fonts.regular.widthOfTextAtSize(text, 8);
      page.drawText(text, { x: (PAGE[0] - width) / 2, y: 26, size: 8, font: fonts.regular, color: w.colors.muted });
    });

    return doc.save();
  }

  const PdfReport = { build, safe };
  if (typeof module !== 'undefined' && module.exports) module.exports = PdfReport;
  else root.PdfReport = PdfReport;
})(typeof window !== 'undefined' ? window : globalThis);
