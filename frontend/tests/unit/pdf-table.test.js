// Testes unitários da lógica pura de frontend/pdf-table.js (layout de
// coluna e truncamento de texto) — sem browser, sem PdfWriter real. A
// integração de verdade (renderReport() desenhando num doc real, quebra de
// página, resultado visual) fica em frontend/tests/specs/pdf-report.spec.js
// (Playwright), porque aí sim faz sentido gerar o PDF e inspecionar os bytes.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { _internals } = require(path.join(__dirname, '..', '..', 'pdf-table.js'));
const { computeColumnWidths, truncateToWidth, rowHeightMm, estimateTextWidthMm } = _internals;

test('computeColumnWidths — colunas maiores recebem mais espaço, soma bate com o disponível', () => {
  const columns = ['Marca', 'Medida', 'Qtd'];
  const rows = [
    ['Pirelli Scorpion All Terrain Plus Edição Especial', '185/65 R14', '4'],
    ['Michelin', '225/45 R18', '2'],
  ];
  const widths = computeColumnWidths(columns, rows, 200);

  assert.equal(widths.length, 3);
  const sum = widths.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 200) < 0.01, `soma das larguras (${sum}) deveria bater com os 200mm disponíveis`);
  assert.ok(widths[0] > widths[1], 'coluna "Marca" (conteúdo bem mais longo) deveria ficar mais larga que "Medida"');
  assert.ok(widths[1] > widths[2], '"Medida" (maior valor "185/65 R14", 10 chars) deveria ficar mais larga que "Qtd" (maior valor "4", 1 char)');
});

test('computeColumnWidths — respeita a largura mínima mesmo com coluna de conteúdo curtíssimo', () => {
  const columns = ['Marca com nome bem comprido pra dominar o peso', 'Qtd'];
  const rows = [['x', '1']];
  const widths = computeColumnWidths(columns, rows, 100);

  assert.ok(widths[1] >= 17.9, `coluna "Qtd" não deveria ficar menor que o piso mínimo, ficou ${widths[1]}`);
  const sum = widths.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 100) < 0.01, 'soma ainda deveria bater com o disponível mesmo aplicando o piso');
});

test('computeColumnWidths — muitas colunas de conteúdo mínimo dividem o espaço quase igualmente', () => {
  const columns = ['A', 'B', 'C', 'D'];
  const rows = [['1', '2', '3', '4']];
  const widths = computeColumnWidths(columns, rows, 80);
  widths.forEach((w) => assert.ok(Math.abs(w - 20) < 0.5, `esperava ~20mm por coluna, veio ${w}`));
});

test('truncateToWidth — não mexe em texto que já cabe', () => {
  const result = truncateToWidth('Pirelli', 50, 8);
  assert.equal(result, 'Pirelli');
});

test('truncateToWidth — corta com reticências texto que não cabe', () => {
  const fontSize = 8;
  const longText = 'Pneu Aro Comprido Demais Pra Caber Na Coluna De Verdade';
  const maxWidth = estimateTextWidthMm(longText, fontSize) / 3; // força não caber

  const result = truncateToWidth(longText, maxWidth, fontSize);
  assert.ok(result.endsWith('…'), 'resultado truncado deveria terminar com "…"');
  assert.ok(result.length < longText.length, 'resultado truncado deveria ser mais curto que o original');
  assert.ok(
    estimateTextWidthMm(result, fontSize) <= maxWidth + 0.001,
    'o texto truncado (com reticências) precisa caber na largura pedida'
  );
});

test('truncateToWidth — coluna largura zero/negativa vira vazio ou só reticências, nunca lança erro', () => {
  assert.doesNotThrow(() => truncateToWidth('qualquer coisa', 0, 8));
  assert.doesNotThrow(() => truncateToWidth('qualquer coisa', -5, 8));
});

test('rowHeightMm — cresce com o tamanho da fonte', () => {
  const h8 = rowHeightMm(8);
  const h12 = rowHeightMm(12);
  assert.ok(h12 > h8, 'fonte maior deveria produzir linha mais alta');
  assert.ok(h8 > 0);
});
