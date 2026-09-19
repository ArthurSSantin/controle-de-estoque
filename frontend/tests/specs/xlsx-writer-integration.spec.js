// Integração real: xlsx-writer.js + zip-writer.js (o de verdade, não mock) —
// gera um .xlsx de verdade, salva em disco e confere que é um ZIP válido com
// as partes OOXML esperadas. Os specs em xlsx-writer.spec.js cobrem a lógica
// de geração de XML isoladamente com um mock de zip-writer; este aqui existe
// só pra pegar problema de integração entre os dois módulos (contrato de
// addFile/finalize, encoding dos bytes, etc).
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');

function parseZipEntries(buffer) {
  // Parser mínimo de ZIP local headers só pra teste — lê sequencialmente a
  // partir do início (não usa o central directory), suficiente pra validar
  // o que o nosso próprio writer produziu.
  const entries = {};
  let offset = 0;
  while (offset < buffer.length) {
    const sig = buffer.readUInt32LE(offset);
    if (sig !== 0x04034b50) break;
    const method = buffer.readUInt16LE(offset + 8);
    const compSize = buffer.readUInt32LE(offset + 18);
    const uncompSize = buffer.readUInt32LE(offset + 22);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.toString('utf8', nameStart, nameStart + nameLen);
    const dataStart = nameStart + nameLen + extraLen;
    const compData = buffer.subarray(dataStart, dataStart + compSize);
    const data = method === 0 ? compData : zlib.inflateRawSync(compData);
    if (data.length !== uncompSize) throw new Error(`tamanho descomprimido divergente em ${name}`);
    entries[name] = data.toString('utf8');
    offset = dataStart + compSize;
  }
  return entries;
}

test('gera um .xlsx real (zip válido) com as partes OOXML esperadas', async ({ page }) => {
  await page.goto('about:blank');
  await page.addScriptTag({ path: path.join(__dirname, '..', '..', 'zip-writer.js') });
  await page.addScriptTag({ path: path.join(__dirname, '..', '..', 'xlsx-writer.js') });

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.evaluate(async () => {
      const ws1 = XlsxWriter.aoaToSheet([
        ['Marca', 'Medida', 'Quantidade'],
        ['Pirelli Ação', '185/65 R14', 4],
        ['=CMD|/c calc', '225/45 R18', 2],
      ]);
      const ws2 = XlsxWriter.jsonToSheet([{ Campo: 'Fornecedor', Valor: 'Distribuidora ABC' }]);
      const wb = XlsxWriter.bookNew();
      XlsxWriter.bookAppendSheet(wb, ws1, 'Pneus');
      XlsxWriter.bookAppendSheet(wb, ws2, 'Meta');
      await XlsxWriter.writeFile(wb, 'integracao-real.xlsx');
    }),
  ]);

  const savePath = path.join(os.tmpdir(), 'xlsx-writer-integration-test.xlsx');
  await download.saveAs(savePath);
  const buffer = fs.readFileSync(savePath);

  // Assinatura ZIP local file header ("PK\x03\x04").
  expect(buffer.readUInt32LE(0)).toBe(0x04034b50);

  const entries = parseZipEntries(buffer);
  expect(Object.keys(entries)).toEqual(
    expect.arrayContaining([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
    ])
  );

  expect(entries['xl/workbook.xml']).toContain('name="Pneus"');
  expect(entries['xl/workbook.xml']).toContain('name="Meta"');
  expect(entries['xl/worksheets/sheet1.xml']).toContain('Pirelli Ação');
  // Formula injection: valor bruto começava com "=", tem que sair com "'" na frente.
  expect(entries['xl/worksheets/sheet1.xml']).toContain("'=CMD|/c calc");
  expect(entries['xl/worksheets/sheet2.xml']).toContain('Distribuidora ABC');

  fs.unlinkSync(savePath);
});
