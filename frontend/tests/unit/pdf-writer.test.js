// Testes unitários do pdf-writer.js (frontend/) — isolados, sem Playwright,
// sem browser. Rodam com: node --test tests/unit/ (ou npm run test:unit).
//
// Estratégia de verificação: assim como no zip-writer.test.js, este arquivo
// NÃO reaproveita a lógica interna do pdf-writer.js pra "ler de volta" o que
// ele mesmo escreveu — implementa seu próprio parser de PDF minimalista só
// pros testes, validando a estrutura byte a byte (xref, offsets, trailer,
// conteúdo dos streams) de forma independente.
//
// save() (que dispara download via document/URL.createObjectURL) não é
// testado aqui — precisa de DOM real, isso fica pra um teste de integração
// em Playwright quando a camada de tabela estiver ligada em app.js. Aqui só
// output(), que é puro e não tem efeito colateral.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createDocument, _internals } = require(path.join(__dirname, '..', '..', 'pdf-writer.js'));

// --- parser de PDF independente, só pra validar o que o writer produziu ---

async function blobToBinaryString(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
  return s;
}

// Inverso de toWinAnsiByte, só pra conferir round-trip nos testes.
const WINANSI_TO_UNICODE = {};
(function buildReverseMap() {
  for (let b = 0; b <= 0xff; b++) WINANSI_TO_UNICODE[b] = b; // identidade fora das exceções
  Object.assign(WINANSI_TO_UNICODE, {
    0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
    0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
    0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
    0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
    0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
    0x9e: 0x017e, 0x9f: 0x0178,
  });
})();
function decodeWinAnsiByte(byte) {
  return String.fromCodePoint(WINANSI_TO_UNICODE[byte]);
}

// Parseia a estrutura de um PDF gerado por este módulo: header, objetos
// (número + conteúdo bruto), xref (offset de cada objeto) e trailer —
// confere que cada offset do xref realmente aponta pro "N 0 obj" certo.
function parsePdf(binaryStr) {
  assert.match(binaryStr, /^%PDF-1\.4\n/, 'arquivo precisa começar com %PDF-1.4');

  const startxrefMatch = /startxref\n(\d+)\n%%EOF$/.exec(binaryStr);
  assert.ok(startxrefMatch, 'startxref/%%EOF não encontrados no fim do arquivo (ou fora do formato esperado)');
  const xrefOffset = Number(startxrefMatch[1]);

  const xrefChunk = binaryStr.slice(xrefOffset);
  const xrefHeaderMatch = /^xref\n0 (\d+)\n/.exec(xrefChunk);
  assert.ok(xrefHeaderMatch, 'seção xref malformada no offset indicado por startxref');
  const totalEntries = Number(xrefHeaderMatch[1]);

  const entriesStart = xrefHeaderMatch[0].length;
  const offsets = [];
  for (let i = 0; i < totalEntries; i++) {
    const line = xrefChunk.slice(entriesStart + i * 20, entriesStart + i * 20 + 20);
    assert.equal(line.length, 20, `entrada de xref ${i} não tem exatamente 20 bytes`);
    if (i === 0) {
      assert.match(line, /^0000000000 65535 f \n$/, 'entrada 0 do xref precisa ser o cabeçalho livre padrão');
      offsets.push(null);
    } else {
      const m = /^(\d{10}) 00000 n \n$/.exec(line);
      assert.ok(m, `entrada de xref ${i} malformada: ${JSON.stringify(line)}`);
      offsets.push(Number(m[1]));
    }
  }

  const trailerMatch = /trailer\n<< \/Size (\d+) \/Root (\d+) 0 R >>\nstartxref/.exec(binaryStr);
  assert.ok(trailerMatch, 'trailer malformado ou não encontrado');
  assert.equal(Number(trailerMatch[1]), totalEntries, '/Size do trailer precisa bater com o total de entradas do xref');
  const rootNum = Number(trailerMatch[2]);

  // Cada offset (exceto o 0, que é o marcador livre) precisa apontar
  // exatamente pro início de "N 0 obj" daquele número de objeto.
  const objects = {};
  for (let num = 1; num < totalEntries; num++) {
    const offset = offsets[num];
    const objHeaderMatch = new RegExp(`^${num} 0 obj\\n`).exec(binaryStr.slice(offset));
    assert.ok(objHeaderMatch, `xref aponta objeto ${num} pro offset ${offset}, mas não há "${num} 0 obj" lá`);
    const bodyStart = offset + objHeaderMatch[0].length;
    const endIdx = binaryStr.indexOf('\nendobj\n', bodyStart);
    assert.notEqual(endIdx, -1, `objeto ${num} não tem "endobj" correspondente`);
    objects[num] = binaryStr.slice(bodyStart, endIdx);
  }

  return { objects, rootNum, totalEntries };
}

function getDictValue(dict, key) {
  const m = new RegExp(`/${key}\\s+(\\d+)\\s+0\\s+R`).exec(dict);
  return m ? Number(m[1]) : null;
}

function getStream(contentObj) {
  const m = /stream\n([\s\S]*)endstream$/.exec(contentObj);
  assert.ok(m, 'stream de conteúdo não encontrado');
  return m[1];
}

function firstContentStream(objects) {
  const contentObj = Object.values(objects).find((o) => /^<< \/Length/.test(o));
  return getStream(contentObj);
}

// --- testes ---

test('estrutura básica: header, objetos, xref e trailer bem formados', async () => {
  const doc = createDocument({ orientation: 'landscape', format: 'a4', unit: 'pt' });
  doc.setFont('helvetica-bold');
  doc.setFontSize(14);
  doc.text('Estoque de Pneus', 14, 16);
  const blob = await doc.output();

  assert.equal(blob.type, 'application/pdf');
  const { objects, rootNum, totalEntries } = parsePdf(await blobToBinaryString(blob));

  const catalog = objects[rootNum];
  assert.match(catalog, /\/Type \/Catalog/);
  const pagesNum = getDictValue(catalog, 'Pages');
  assert.ok(pagesNum);

  const pagesDict = objects[pagesNum];
  assert.match(pagesDict, /\/Type \/Pages/);
  assert.match(pagesDict, /\/Count 1\b/);

  // 1 Catalog + 1 Pages + 2 Fonts + (1 Page + 1 Contents) por página = 6 objetos, +1 do free-list = 7 entradas no xref
  assert.equal(totalEntries, 7);
});

test('unit "mm" (default): pageWidth/pageHeight saem em mm, mas o MediaBox interno do PDF é sempre em pt', async () => {
  const doc = createDocument({ orientation: 'landscape', format: 'a4' }); // unit default = mm
  assert.ok(Math.abs(doc.pageWidth - 297) < 0.1, `esperado ~297mm, veio ${doc.pageWidth}`);
  assert.ok(Math.abs(doc.pageHeight - 210) < 0.1, `esperado ~210mm, veio ${doc.pageHeight}`);

  const { objects } = parsePdf(await blobToBinaryString(await doc.output()));
  const pageObj = Object.values(objects).find((o) => /\/Type \/Page\b/.test(o));
  const [, w, h] = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(pageObj).map(Number);
  assert.ok(Math.abs(w - 841.89) < 0.1, `MediaBox largura esperada ~841.89pt, veio ${w}`);
  assert.ok(Math.abs(h - 595.28) < 0.1, `MediaBox altura esperada ~595.28pt, veio ${h}`);
});

test('unit "mm": uma coordenada x=10mm vira ~28.35pt no content stream', async () => {
  const doc = createDocument({ orientation: 'portrait', format: 'a4' }); // mm
  doc.setFontSize(12);
  doc.text('x', 10, 0.01); // y quase 0 só pra não zerar a conta do flip
  const stream = firstContentStream(parsePdf(await blobToBinaryString(await doc.output())).objects);
  assert.match(stream, /Tf 28\.35 /); // 10mm * 2.8346456693 ≈ 28.35pt
});

test('orientação landscape/portrait em A4 (unit pt): larguras e alturas saem certas', async () => {
  const land = createDocument({ orientation: 'landscape', format: 'a4', unit: 'pt' });
  assert.ok(land.pageWidth > land.pageHeight);
  const port = createDocument({ orientation: 'portrait', format: 'a4', unit: 'pt' });
  assert.ok(port.pageHeight > port.pageWidth);
});

test('texto com acentuação PT-BR round-tripa corretamente via WinAnsiEncoding', async () => {
  const doc = createDocument({ orientation: 'portrait', format: 'a4', unit: 'pt' });
  doc.setFontSize(10);
  const original = 'Pneu Aro Ção, ação, não, café, número — item 1º';
  doc.text(original, 10, 20);
  const { objects } = parsePdf(await blobToBinaryString(await doc.output()));
  const stream = firstContentStream(objects);

  const tjMatch = /\(([\s\S]*?)\) Tj/.exec(stream);
  assert.ok(tjMatch, 'operador Tj não encontrado no stream');
  let decoded = '';
  for (let i = 0; i < tjMatch[1].length; i++) decoded += decodeWinAnsiByte(tjMatch[1].charCodeAt(i));
  assert.equal(decoded, original);
});

test('parênteses e barra invertida no texto são escapados (não quebram a string literal do PDF)', async () => {
  const doc = createDocument({ orientation: 'portrait', format: 'a4', unit: 'pt' });
  doc.text('Pneu (usado) C:\\caminho', 10, 20);
  const { objects } = parsePdf(await blobToBinaryString(await doc.output()));
  const stream = firstContentStream(objects);
  assert.match(stream, /\(Pneu \\\(usado\\\) C:\\\\caminho\) Tj/);
});

test('setTextColor() muda a cor do texto desenhado a seguir', async () => {
  const doc = createDocument({ orientation: 'portrait', format: 'a4', unit: 'pt' });
  doc.setTextColor(255, 255, 255);
  doc.text('branco', 0, 10);
  const { objects } = parsePdf(await blobToBinaryString(await doc.output()));
  const stream = firstContentStream(objects);
  assert.match(stream, /1 1 1 rg BT/);
});

test('rect(..., "F"): preenche com fillColor atual; canto topo-esquerda vira canto inferior no PDF nativo', async () => {
  const doc = createDocument({ orientation: 'portrait', format: 'a4', unit: 'pt' });
  doc.setFillColor(227, 167, 43);
  doc.rect(10, 10, 100, 20, 'F');
  const { objects } = parsePdf(await blobToBinaryString(await doc.output()));
  const stream = firstContentStream(objects);

  assert.match(stream, /0\.89 0\.65 0\.17 rg/); // 227/255≈0.89, 167/255≈0.65, 43/255≈0.17
  // y de entrada = 10 (topo), altura = 20, página A4 portrait = 841.89pt de altura
  // -> canto inferior-esquerdo nativo do PDF = 841.89 - 10 - 20 = 811.89
  assert.match(stream, /10 811\.89 100 20 re/);
  assert.match(stream, / f$/m);
});

test('rect(..., "S") contorna com drawColor; rect(..., "FD") preenche e contorna', async () => {
  const doc = createDocument({ orientation: 'portrait', format: 'a4', unit: 'pt' });
  doc.setDrawColor(10, 20, 30);
  doc.rect(0, 0, 5, 5, 'S');
  doc.setFillColor(100, 110, 120);
  doc.rect(0, 0, 5, 5, 'FD');
  const { objects } = parsePdf(await blobToBinaryString(await doc.output()));
  const stream = firstContentStream(objects);

  assert.match(stream, /0\.04 0\.08 0\.12 RG .*re S/); // só stroke
  assert.match(stream, /0\.39 0\.43 0\.47 rg 0\.04 0\.08 0\.12 RG .*re B/); // fill+stroke
});

test('rect() sem style desenhado desenha stroke por padrão (igual jsPDF quando "style" é omitido)', async () => {
  const doc = createDocument({ orientation: 'portrait', format: 'a4', unit: 'pt' });
  doc.rect(0, 0, 5, 5);
  const { objects } = parsePdf(await blobToBinaryString(await doc.output()));
  assert.match(firstContentStream(objects), /re S$/m);
});

test('múltiplas páginas: addPage() cria página nova, Kids/Count refletem o total, cada offset resolve certo, estado (fonte/cor) persiste entre páginas', async () => {
  const doc = createDocument({ orientation: 'landscape', format: 'a4', unit: 'pt' });
  const PAGE_COUNT = 5;
  doc.setFont('helvetica-bold');
  doc.setFontSize(9);
  for (let p = 0; p < PAGE_COUNT; p++) {
    if (p > 0) doc.addPage();
    for (let row = 0; row < 3; row++) {
      doc.text(`pagina ${p + 1} linha ${row}`, 10, 20 + row * 12);
    }
  }
  const { objects, rootNum } = parsePdf(await blobToBinaryString(await doc.output()));

  const pagesNum = getDictValue(objects[rootNum], 'Pages');
  const pagesDict = objects[pagesNum];
  assert.match(pagesDict, new RegExp(`/Count ${PAGE_COUNT}\\b`));
  const kids = [...pagesDict.matchAll(/(\d+) 0 R/g)].map((m) => Number(m[1]));
  assert.equal(kids.length, PAGE_COUNT);

  kids.forEach((pageNum, i) => {
    const contentsNum = getDictValue(objects[pageNum], 'Contents');
    const stream = getStream(objects[contentsNum]);
    assert.ok(stream.includes(`pagina ${i + 1} linha 0`), `página ${i + 1} deveria conter seu próprio texto`);
    assert.match(stream, /\/F2 9 Tf/, 'fonte/tamanho setados antes do loop deveriam valer em todas as páginas');
  });
});

test('output() é assíncrono e retorna um Blob mesmo sem nenhum desenho (página em branco válida)', async () => {
  const doc = createDocument({ orientation: 'portrait', format: 'a4', unit: 'pt' });
  const blob = await doc.output();
  assert.ok(blob instanceof Blob);
  const { objects, totalEntries } = parsePdf(await blobToBinaryString(blob));
  assert.equal(totalEntries, 7); // catalog+pages+2 fonts+page+contents+free = 7
  assert.ok(Object.keys(objects).length > 0);
});

test('format/orientation/unit inválidos lançam erro claro', () => {
  assert.throws(() => createDocument({ format: 'letter' }), /não suportado/);
  assert.throws(() => createDocument({ orientation: 'diagonal' }), /não suportada/);
  assert.throws(() => createDocument({ unit: 'in' }), /não suportada/);
});
