// Testes do gerador .xlsx próprio (frontend/xlsx-writer.js), que substitui
// XLSX.utils/XLSX.writeFile da lib vendor nas telas de export/modelo.
//
// zip-writer.js (empacotamento real em .zip) é escopo de outro módulo — aqui
// usamos um mock de window.ZipWriter.createZipWriter que só grava os
// arquivos (nome + bytes) em memória, pra poder inspecionar o XML OOXML
// gerado sem depender da implementação de compressão. Contrato real
// (confirmado pelo autor do zip-writer): createZipWriter() -> { addFile(path,
// bytes: Uint8Array), finalize(mimeType?): Promise<Blob> }, exposto em
// window.ZipWriter.createZipWriter.
const { test, expect } = require('@playwright/test');
const path = require('path');

const MOCK_ZIP_WRITER = `
  window.__zipFiles = null;
  window.__zipMimeType = null;
  window.ZipWriter = {
    createZipWriter: function () {
      const files = [];
      const seen = new Set();
      return {
        addFile(name, bytes) {
          if (seen.has(name)) throw new Error('path duplicado: ' + name);
          if (!(bytes instanceof Uint8Array)) throw new Error('bytes precisa ser Uint8Array');
          seen.add(name);
          files.push({ name, bytes });
        },
        async finalize(mimeType) {
          window.__zipFiles = files;
          window.__zipMimeType = mimeType;
          return new Blob(['mock-zip-bytes'], { type: mimeType || 'application/octet-stream' });
        },
      };
    },
  };
`;

test.beforeEach(async ({ page }) => {
  await page.goto('about:blank');
  await page.addScriptTag({ content: MOCK_ZIP_WRITER });
  await page.addScriptTag({ path: path.join(__dirname, '..', '..', 'xlsx-writer.js') });
});

// Lê de volta o XML de uma planilha específica do último writeFile(), a
// partir dos bytes que foram passados pro (mock de) zip-writer.
async function readSheetXml(page, sheetIndex = 0) {
  return page.evaluate((idx) => {
    const file = window.__zipFiles.find((f) => f.name === `xl/worksheets/sheet${idx + 1}.xml`);
    return new TextDecoder().decode(file.bytes);
  }, sheetIndex);
}

test.describe('XlsxWriter — geração de OOXML', () => {
  test('acentos/UTF-8 são preservados como inlineStr', async ({ page }) => {
    await page.evaluate(async () => {
      const ws = XlsxWriter.aoaToSheet([['Município', 'Pneu Aço Ávila 185/65 R14 São Paulo']]);
      const wb = XlsxWriter.bookNew();
      XlsxWriter.bookAppendSheet(wb, ws, 'Pneus');
      await XlsxWriter.writeFile(wb, 'teste.xlsx');
    });
    const xml = await readSheetXml(page);
    expect(xml).toContain('Município');
    expect(xml).toContain('Pneu Aço Ávila 185/65 R14 São Paulo');
  });

  test('células vazias (null/undefined/string vazia) viram <c/> sem valor', async ({ page }) => {
    await page.evaluate(async () => {
      const ws = XlsxWriter.aoaToSheet([['a', null, undefined, '', 'b']]);
      const wb = XlsxWriter.bookNew();
      XlsxWriter.bookAppendSheet(wb, ws, 'S1');
      await XlsxWriter.writeFile(wb, 'teste.xlsx');
    });
    const xml = await readSheetXml(page);
    expect(xml).toContain('<c r="B1"/>');
    expect(xml).toContain('<c r="C1"/>');
    expect(xml).toContain('<c r="D1"/>');
    expect(xml).not.toMatch(/<c r="B1"[^/][^>]*>/);
  });

  test('números ficam sem t (numeric) e strings viram t="inlineStr"', async ({ page }) => {
    await page.evaluate(async () => {
      const ws = XlsxWriter.aoaToSheet([[42, '42', 3.5, true]]);
      const wb = XlsxWriter.bookNew();
      XlsxWriter.bookAppendSheet(wb, ws, 'S1');
      await XlsxWriter.writeFile(wb, 'teste.xlsx');
    });
    const xml = await readSheetXml(page);
    expect(xml).toContain('<c r="A1"><v>42</v></c>');
    expect(xml).toContain('<c r="B1" t="inlineStr"><is><t xml:space="preserve">42</t></is></c>');
    expect(xml).toContain('<c r="C1"><v>3.5</v></c>');
    expect(xml).toContain('<c r="D1" t="b"><v>1</v></c>');
  });

  test('valores começando com = + - @ ganham prefixo de apóstrofo (CWE-1236)', async ({ page }) => {
    await page.evaluate(async () => {
      const ws = XlsxWriter.aoaToSheet([
        ['=SOMA(A1:A2)', '+cmd', '-cmd', '@cmd', 'texto normal', '\tcmd'],
      ]);
      const wb = XlsxWriter.bookNew();
      XlsxWriter.bookAppendSheet(wb, ws, 'S1');
      await XlsxWriter.writeFile(wb, 'teste.xlsx');
    });
    const xml = await readSheetXml(page);
    expect(xml).toContain('<t xml:space="preserve">\'=SOMA(A1:A2)</t>');
    expect(xml).toContain('<t xml:space="preserve">\'+cmd</t>');
    expect(xml).toContain('<t xml:space="preserve">\'-cmd</t>');
    expect(xml).toContain('<t xml:space="preserve">\'@cmd</t>');
    expect(xml).toContain('<t xml:space="preserve">\'\tcmd</t>');
    // valor "normal" não deve ganhar apóstrofo indevido
    expect(xml).toMatch(/<t xml:space="preserve">texto normal<\/t>/);
  });

  test('jsonToSheet usa a união das chaves como cabeçalho, na ordem de 1ª aparição', async ({ page }) => {
    const rows = await page.evaluate(() => {
      const sheet = XlsxWriter.jsonToSheet([
        { Marca: 'Pirelli', Medida: '185/65 R14' },
        { Marca: 'Michelin', Medida: '225/45 R18', Fornecedor: 'ABC' },
      ]);
      return sheet.rows;
    });
    expect(rows[0]).toEqual(['Marca', 'Medida', 'Fornecedor']);
    expect(rows[1]).toEqual(['Pirelli', '185/65 R14', undefined]);
    expect(rows[2]).toEqual(['Michelin', '225/45 R18', 'ABC']);
  });

  test('planilha grande (500 linhas) gera todas as linhas sem erro', async ({ page }) => {
    await page.evaluate(async () => {
      const aoa = [];
      for (let i = 0; i < 500; i++) aoa.push([`Marca ${i}`, i, `185/${i % 90} R14`]);
      const ws = XlsxWriter.aoaToSheet(aoa);
      const wb = XlsxWriter.bookNew();
      XlsxWriter.bookAppendSheet(wb, ws, 'Estoque');
      await XlsxWriter.writeFile(wb, 'estoque-grande.xlsx');
    });
    const xml = await readSheetXml(page);
    expect((xml.match(/<row /g) || []).length).toBe(500);
    expect(xml).toContain('<row r="500">');
    expect(xml).toContain('Marca 499');
  });

  test('writeFile dispara download com o nome de arquivo pedido', async ({ page }) => {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate(async () => {
        const ws = XlsxWriter.aoaToSheet([['a', 'b']]);
        const wb = XlsxWriter.bookNew();
        XlsxWriter.bookAppendSheet(wb, ws, 'S1');
        await XlsxWriter.writeFile(wb, 'estoque-pneus-2026-09-19.xlsx');
      }),
    ]);
    expect(download.suggestedFilename()).toBe('estoque-pneus-2026-09-19.xlsx');
  });

  test('nomes de planilha inválidos/duplicados são sanitizados', async ({ page }) => {
    const xml = await page.evaluate(() => {
      const used = new Set();
      const a = XlsxWriter._internal.sanitizeSheetName('Pneus/Estoque:2026', used);
      const b = XlsxWriter._internal.sanitizeSheetName('Pneus Estoque', used);
      const c = XlsxWriter._internal.sanitizeSheetName('Pneus Estoque', used);
      return JSON.stringify([a, b, c]);
    });
    const [a, b, c] = JSON.parse(xml);
    expect(a).not.toMatch(/[:\\/?*[\]]/);
    expect(b).toBe('Pneus Estoque');
    expect(c).not.toBe(b); // duplicata precisa virar único
  });

  test('writeFile rejeita workbook sem planilhas', async ({ page }) => {
    const message = await page.evaluate(async () => {
      try {
        await XlsxWriter.writeFile(XlsxWriter.bookNew(), 'vazio.xlsx');
        return null;
      } catch (e) {
        return e.message;
      }
    });
    expect(message).toMatch(/pelo menos uma planilha/);
  });

  test('finalize é chamado com o content-type correto de .xlsx', async ({ page }) => {
    const mimeType = await page.evaluate(async () => {
      const ws = XlsxWriter.aoaToSheet([['a']]);
      const wb = XlsxWriter.bookNew();
      XlsxWriter.bookAppendSheet(wb, ws, 'S1');
      await XlsxWriter.writeFile(wb, 'teste.xlsx');
      return window.__zipMimeType;
    });
    expect(mimeType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });
});

test.describe('XlsxWriter — sem zip-writer.js carregado', () => {
  test('writeFile falha com mensagem clara se window.ZipWriter não existir', async ({ page }) => {
    await page.goto('about:blank');
    await page.addScriptTag({ path: path.join(__dirname, '..', '..', 'xlsx-writer.js') });
    const message = await page.evaluate(async () => {
      try {
        const ws = XlsxWriter.aoaToSheet([['a']]);
        const wb = XlsxWriter.bookNew();
        XlsxWriter.bookAppendSheet(wb, ws, 'S1');
        await XlsxWriter.writeFile(wb, 'teste.xlsx');
        return null;
      } catch (e) {
        return e.message;
      }
    });
    expect(message).toMatch(/zip-writer\.js precisa estar carregado/);
  });
});
