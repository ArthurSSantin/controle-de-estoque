// Gerador de .xlsx próprio (write-only) — substitui XLSX.utils/XLSX.writeFile
// da lib xlsx (vendor/xlsx.full.min.js) nas telas de export/modelo. A leitura
// de planilhas (import) continua na lib original em xlsx-worker.js; este
// arquivo não mexe nisso.
//
// Decisões de design (documentadas por serem diferentes da lib substituída):
//  - Strings inline (t="inlineStr"), sem xl/sharedStrings.xml. Simplifica a
//    geração (não precisa de tabela de dedupe) às custas de um arquivo um
//    pouco maior em planilhas com strings muito repetidas — irrelevante no
//    tamanho de export deste app (centenas de linhas, não milhões).
//  - Sem xl/styles.xml: todas as células saem sem formatação custom (fonte
//    padrão do Excel, sem negrito/cor). O arquivo abre normalmente porque
//    nenhuma célula referencia um índice de estilo.
//  - Mitigação de Excel Formula Injection (CWE-1236): valores de célula que
//    são string e começam com `=`, `+`, `-`, `@`, TAB ou CR são gravados com
//    um apóstrofo (`'`) na frente, igual ao Excel faz quando você digita
//    manualmente um valor que não quer que vire fórmula. A lib original
//    (xlsx) não fazia essa sanitização.
//
// Depende de frontend/zip-writer.js estar carregado na página
// (window.ZipWriter.createZipWriter), mas só resolve essa dependência dentro
// de writeFile — não importa a ordem dos <script> desde que ambos estejam no
// DOM antes do primeiro export ser disparado pelo usuário.

(function (global) {
  'use strict';

  const FORMULA_TRIGGER_CHARS = new Set(['=', '+', '-', '@', '\t', '\r']);
  const INVALID_XML_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;
  const SHEET_NAME_INVALID_CHARS = /[:\\/?*[\]]/g;

  function columnLetter(index) {
    let n = index + 1;
    let s = '';
    while (n > 0) {
      const rem = (n - 1) % 26;
      s = String.fromCharCode(65 + rem) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function escapeXmlText(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');
  }

  function escapeXmlAttr(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  // Remove caracteres de controle inválidos em XML 1.0 (ex: colados de um
  // PDF/scanner) — sem isso o .xlsx sai corrompido e o Excel recusa abrir.
  function sanitizeXmlChars(str) {
    return str.replace(INVALID_XML_CHARS, '');
  }

  // CWE-1236 — Excel Formula Injection: dado controlado por usuário (marca,
  // fornecedor, notaRef, código de barras...) que comece com um desses
  // caracteres seria interpretado como fórmula ao abrir no Excel.
  function guardFormulaInjection(str) {
    if (str.length && FORMULA_TRIGGER_CHARS.has(str[0])) return "'" + str;
    return str;
  }

  function sanitizeSheetName(rawName, usedNames) {
    let name = String(rawName || 'Sheet').replace(SHEET_NAME_INVALID_CHARS, ' ').trim().slice(0, 31);
    if (!name) name = 'Sheet';
    if (!usedNames.has(name)) {
      usedNames.add(name);
      return name;
    }
    let i = 2;
    let candidate;
    do {
      const suffix = ` (${i})`;
      candidate = name.slice(0, 31 - suffix.length) + suffix;
      i++;
    } while (usedNames.has(candidate));
    usedNames.add(candidate);
    return candidate;
  }

  function cellXml(ref, rawValue) {
    if (rawValue === null || rawValue === undefined || rawValue === '') {
      return `<c r="${ref}"/>`;
    }
    if (typeof rawValue === 'number') {
      if (!Number.isFinite(rawValue)) return `<c r="${ref}"/>`;
      return `<c r="${ref}"><v>${rawValue}</v></c>`;
    }
    if (typeof rawValue === 'boolean') {
      return `<c r="${ref}" t="b"><v>${rawValue ? 1 : 0}</v></c>`;
    }
    const clean = guardFormulaInjection(sanitizeXmlChars(String(rawValue)));
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXmlText(clean)}</t></is></c>`;
  }

  function rowXml(rowIndex, rowValues) {
    const r = rowIndex + 1;
    const cells = rowValues.map((v, ci) => cellXml(columnLetter(ci) + r, v)).join('');
    return `<row r="${r}">${cells}</row>`;
  }

  function worksheetXml(sheet) {
    const rows = (sheet.rows || []).map((row, i) => rowXml(i, row)).join('');
    return (
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      `<sheetData>${rows}</sheetData>` +
      '</worksheet>'
    );
  }

  function contentTypesXml(sheetCount) {
    const overrides = [];
    for (let i = 1; i <= sheetCount; i++) {
      overrides.push(
        `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
      );
    }
    return (
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      overrides.join('') +
      '</Types>'
    );
  }

  function rootRelsXml() {
    return (
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>'
    );
  }

  function workbookXml(sheetNames) {
    const entries = sheetNames
      .map(
        (name, i) =>
          `<sheet name="${escapeXmlAttr(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
      )
      .join('');
    return (
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<sheets>${entries}</sheets>` +
      '</workbook>'
    );
  }

  function workbookRelsXml(sheetCount) {
    const rels = [];
    for (let i = 1; i <= sheetCount; i++) {
      rels.push(
        `<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>`
      );
    }
    return (
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      rels.join('') +
      '</Relationships>'
    );
  }

  const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ===========================================================================
     API pública — mesmas operações que app.js já usa via XLSX.utils/XLSX,
     agrupadas em XlsxWriter em vez de um global XLSX (pra não colidir com a
     lib vendor, que continua carregada e em uso pra leitura/import).
  =========================================================================== */

  // aoaToSheet(arrayOfArrays) → sheet interna { rows: value[][] }
  function aoaToSheet(aoa) {
    if (!Array.isArray(aoa)) throw new TypeError('aoaToSheet espera um array de arrays.');
    return { rows: aoa.map((row) => (Array.isArray(row) ? row.slice() : [row])) };
  }

  // jsonToSheet(arrayOfObjects) → sheet interna, cabeçalho = união das chaves
  // na ordem em que aparecem (cobre o caso raro de objetos com formatos
  // diferentes; no uso atual do app todos os objetos têm as mesmas chaves).
  function jsonToSheet(objects) {
    if (!Array.isArray(objects)) throw new TypeError('jsonToSheet espera um array de objetos.');
    if (objects.length === 0) return { rows: [] };
    const headers = [];
    const seen = new Set();
    objects.forEach((obj) => {
      Object.keys(obj || {}).forEach((k) => {
        if (!seen.has(k)) {
          seen.add(k);
          headers.push(k);
        }
      });
    });
    const dataRows = objects.map((obj) => headers.map((h) => (obj ? obj[h] : undefined)));
    return { rows: [headers, ...dataRows] };
  }

  function bookNew() {
    return { sheets: [] };
  }

  function bookAppendSheet(workbook, sheet, sheetName) {
    workbook.sheets.push({ name: sheetName, sheet });
  }

  // writeFile(workbook, filename) → monta os XMLs OOXML mínimos, empacota
  // via zip-writer.js e dispara o download.
  async function writeFile(workbook, filename) {
    if (typeof ZipWriter === 'undefined' || typeof ZipWriter.createZipWriter !== 'function') {
      throw new Error(
        'zip-writer.js precisa estar carregado antes de chamar XlsxWriter.writeFile (window.ZipWriter.createZipWriter não encontrado).'
      );
    }
    if (!workbook || !Array.isArray(workbook.sheets) || workbook.sheets.length === 0) {
      throw new Error('writeFile precisa de um workbook com pelo menos uma planilha.');
    }

    const usedNames = new Set();
    const safeNames = workbook.sheets.map((s) => sanitizeSheetName(s.name, usedNames));
    const encoder = new TextEncoder();
    const zip = ZipWriter.createZipWriter();

    zip.addFile('[Content_Types].xml', encoder.encode(contentTypesXml(workbook.sheets.length)));
    zip.addFile('_rels/.rels', encoder.encode(rootRelsXml()));
    zip.addFile('xl/workbook.xml', encoder.encode(workbookXml(safeNames)));
    zip.addFile('xl/_rels/workbook.xml.rels', encoder.encode(workbookRelsXml(workbook.sheets.length)));
    workbook.sheets.forEach((s, i) => {
      zip.addFile(`xl/worksheets/sheet${i + 1}.xml`, encoder.encode(worksheetXml(s.sheet)));
    });

    const blob = await zip.finalize(XLSX_MIME_TYPE);
    triggerDownload(blob, filename);
  }

  global.XlsxWriter = {
    aoaToSheet,
    jsonToSheet,
    bookNew,
    bookAppendSheet,
    writeFile,
    // expostos só pra teste unitário direto (geração de XML sem zip/DOM):
    _internal: { worksheetXml, workbookXml, contentTypesXml, columnLetter, sanitizeSheetName },
  };
})(typeof window !== 'undefined' ? window : globalThis);
