// Testes de frontend/pdf-table.js + frontend/pdf-writer.js: geram um PDF de
// verdade num browser real (CompressionStream/Blob não existem em
// node:test) e validam a estrutura com um parser independente — mesma
// estratégia usada em xlsx-writer-integration.spec.js e no
// tests/unit/pdf-writer.test.js do agente que fez a camada baixa.
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { installCommonMocks, bootIntoApp, waitForContentReady, buildFakeTires } = require('../helpers/mock-app');

async function loadPdfModules(page) {
  await page.goto('about:blank');
  await page.addScriptTag({ path: path.join(__dirname, '..', '..', 'pdf-writer.js') });
  await page.addScriptTag({ path: path.join(__dirname, '..', '..', 'pdf-table.js') });
}

// Parser minimalista de PDF só pros testes: acha os N objetos "N 0 obj" e
// extrai o /Contents de cada página, na ordem das páginas do /Kids.
function parsePdf(text) {
  const objects = {};
  const objRe = /(\d+) 0 obj\n([\s\S]*?)\nendobj/g;
  let m;
  while ((m = objRe.exec(text))) objects[Number(m[1])] = m[2];

  const catalog = objects[1];
  const pagesRefMatch = /\/Pages (\d+) 0 R/.exec(catalog);
  const pagesObj = objects[Number(pagesRefMatch[1])];
  const kids = [...pagesObj.matchAll(/(\d+) 0 R/g)].map((k) => Number(k[1]));

  const pages = kids.map((pageNum) => {
    const pageObj = objects[pageNum];
    const contentsMatch = /\/Contents (\d+) 0 R/.exec(pageObj);
    const contentObj = objects[Number(contentsMatch[1])];
    const streamMatch = /stream\n([\s\S]*?)endstream/.exec(contentObj);
    return streamMatch[1];
  });

  return { objectCount: Object.keys(objects).length, pages };
}

async function blobToText(page, blob) {
  return page.evaluate(async (b) => {
    const buf = new Uint8Array(await b.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
    return s;
  }, blob);
}

test.describe('PdfTable — geração de relatório', () => {
  test('dataset pequeno cabe em 1 página, com cabeçalho e linhas', async ({ page }) => {
    await loadPdfModules(page);
    const text = await page.evaluate(async () => {
      const doc = PdfWriter.createDocument({ orientation: 'landscape' });
      PdfTable.renderReport(doc, {
        title: 'Estoque de Pneus',
        subtitle: 'Gerado em 19/09/2026 — 2 item(ns)',
        columns: ['Marca', 'Medida', 'Quantidade'],
        rows: [
          ['Pirelli', '185/65 R14', '4'],
          ['Michelin', '225/45 R18', '2'],
        ],
      });
      const blob = await doc.output();
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
      return s;
    });

    const parsed = parsePdf(text);
    expect(parsed.pages.length).toBe(1);
    expect(parsed.pages[0]).toContain('(Estoque de Pneus)');
    expect(parsed.pages[0]).toContain('(Pirelli)');
    expect(parsed.pages[0]).toContain('(Michelin)');
    expect(parsed.pages[0]).toContain('(Marca)');
  });

  test('dataset grande força quebra de página, repetindo o cabeçalho', async ({ page }) => {
    await loadPdfModules(page);
    const parsedInfo = await page.evaluate(async () => {
      const rows = [];
      for (let i = 0; i < 60; i++) rows.push([`Marca ${i}`, `185/${i % 90} R14`, String(i)]);
      const doc = PdfWriter.createDocument({ orientation: 'landscape' });
      PdfTable.renderReport(doc, {
        title: 'Estoque de Pneus',
        subtitle: 'Gerado em 19/09/2026 — 60 item(ns)',
        columns: ['Marca', 'Medida', 'Quantidade'],
        rows,
      });
      const blob = await doc.output();
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
      return s;
    });

    const parsed = parsePdf(parsedInfo);
    expect(parsed.pages.length).toBeGreaterThan(1);
    // cabeçalho repetido: "(Marca)" precisa aparecer em CADA página, não só na primeira
    parsed.pages.forEach((pageContent, i) => {
      expect(pageContent, `página ${i + 1} deveria ter o cabeçalho da tabela repetido`).toContain('(Marca)');
    });
    // última linha (Marca 59) precisa estar em algum lugar, sem se perder na quebra
    const allPages = parsed.pages.join('\n');
    expect(allPages).toContain('(Marca 59)');
  });

  test('acentuação PT-BR sobrevive (ç, ã, é, º, travessão)', async ({ page }) => {
    await loadPdfModules(page);
    const text = await page.evaluate(async () => {
      const doc = PdfWriter.createDocument({ orientation: 'landscape' });
      PdfTable.renderReport(doc, {
        title: 'Estoque de Pneus',
        subtitle: 'Relatório — 1º lote',
        columns: ['Marca', 'Condição'],
        rows: [['Pneu Aço Ação Ltda.', 'usado']],
      });
      const blob = await doc.output();
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
      return s;
    });

    // WinAnsiEncoding: ç=0xE7, ã=0xE3, º=0xBA, travessão(—)=0x97 — bytes crus
    // dentro da string literal do PDF (não dá pra procurar o char UTF-8
    // "ç"/"ã" numa binary-string JS; procura pelo byte WinAnsi equivalente).
    // "Pneu Aço Ação Ltda." tem as duas palavras (ç e ã) separadas.
    expect(text).toContain('Pneu A\xe7o A\xe7\xe3o'); // "Pneu Aço Ação"
    expect(text).toContain('Condi\xe7\xe3o');
    expect(text).toContain('\xba lote'); // "1º lote"
    expect(text).toContain('\x97'); // travessão do subtítulo "Relatório — 1º lote"
  });
});

test.describe('Exportação em PDF — fluxo completo do app', () => {
  test('exportar PDF com dataset grande gera arquivo válido, com acento, sem CDN', async ({ page }) => {
    let cdnHits = 0;
    await page.route('https://cdnjs.cloudflare.com/**', (route) => {
      cdnHits++;
      route.abort('connectionrefused');
    });

    const tires = buildFakeTires(60);
    tires[0].marca = 'Pirelli Scorpion Ação Especial Extra Comprida Demais';
    await installCommonMocks(page, { tires });
    await bootIntoApp(page);
    await waitForContentReady(page);
    await page.click('[data-tab="exportar"]');
    await page.selectOption('#exportFormatSelect', 'pdf');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#exportBtn'),
    ]);
    expect(download.suggestedFilename()).toMatch(/^estoque-pneus-\d{4}-\d{2}-\d{2}\.pdf$/);
    expect(cdnHits, 'exportar PDF não deveria chamar CDN nenhum (nem o pdf.js de leitura)').toBe(0);

    const savePath = path.join(os.tmpdir(), 'pdf-report-integration-test.pdf');
    await download.saveAs(savePath);
    const buffer = fs.readFileSync(savePath);

    expect(buffer.toString('ascii', 0, 8)).toBe('%PDF-1.4');
    const text = buffer.toString('latin1');
    const parsed = parsePdf(text);
    expect(parsed.pages.length).toBeGreaterThan(1); // 60 itens força quebra de página
    expect(text).toContain('(Estoque de Pneus)');

    fs.unlinkSync(savePath);
  });
});
