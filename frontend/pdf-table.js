/**
 * Camada de layout de tabela por cima de frontend/pdf-writer.js — substitui
 * o uso de `doc.autoTable()` (plugin jsPDF) no relatório de exportação em
 * PDF do estoque. Não é um clone genérico do autoTable: só faz o que o
 * relatório de estoque precisa (título + subtítulo + uma tabela, com quebra
 * de página repetindo o cabeçalho).
 *
 * As constantes visuais abaixo (cores, padding, tamanho de fonte) foram
 * extraídas inspecionando o content stream bruto de um PDF real gerado pela
 * combinação jsPDF+autoTable que este módulo substitui — não são "chutadas",
 * são pra reproduzir o mesmo resultado visual que já existia:
 *   header: fundo RGB(215,25,32) (vermelho da empresa), texto branco em negrito, 8pt
 *   corpo: linhas alternando branco/RGB(245,245,245), texto RGB(80,80,80), 8pt
 *   padding de célula: 5pt em todas as direções
 *   sem borda visível (só preenchimento, sem contorno)
 *
 * Decisões de design:
 * - Largura de coluna: "auto-fit" aproximado por CONTAGEM DE CARACTERES (do
 *   cabeçalho e do maior valor de cada coluna), não por métrica real de
 *   glifo — pdf-writer.js não expõe `getTextWidth()` de propósito (evitar
 *   número de fonte errado sem conferência, ver comentário lá). Pra esse
 *   relatório (nomes de marca, medida, preço — texto curto e uniforme) o
 *   resultado é visualmente equivalente ao auto-fit "de verdade" do
 *   autoTable; não tenta ser pixel-perfect.
 * - Célula de uma linha só: se o texto não couber na largura da coluna
 *   (pela mesma estimativa por contagem de caractere), trunca com "…" em vez
 *   de quebrar em várias linhas — simplificação aceita (autoTable quebra
 *   linha; aqui a altura de linha da tabela inteira é fixa). Numa planilha de
 *   estoque real (marca/medida/preço) isso raramente dispara.
 * - Altura de linha fixa (cabeçalho e corpo, mesma fonte 8pt): calculada a
 *   partir do padding + fontSize, não hardcoded em mm — ver `rowHeightMm()`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PdfTable = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PT_TO_MM = 1 / 2.8346456693;

  const MARGIN_MM = 14;
  const CELL_PADDING_PT = 5;
  const LINE_HEIGHT_FACTOR = 1.15;
  const MIN_COL_WIDTH_MM = 18;
  // Fração de fontSize usada pra estimar largura média de caractere e o
  // deslocamento vertical da linha de base dentro da célula — calibrada
  // batendo contra o PDF de referência (jsPDF+autoTable) pro caso real deste
  // relatório (fonte 8pt); não é uma métrica de fonte de verdade.
  const AVG_CHAR_WIDTH_FACTOR = 0.5;
  const BASELINE_OFFSET_FACTOR = 0.85;

  const HEADER_FILL = [215, 25, 32]; // vermelho da empresa
  const HEADER_TEXT = [255, 255, 255];
  // Índice 0 = primeira linha do corpo (cinza-claro), índice 1 = branco —
  // ordem confirmada no PDF de referência (autoTable começa pelo cinza).
  const ROW_FILL = [[245, 245, 245], [255, 255, 255]];
  const BODY_TEXT = [80, 80, 80];
  const TITLE_TEXT = [0, 0, 0];

  function rowHeightMm(fontSizePt) {
    return (CELL_PADDING_PT * 2 + fontSizePt * LINE_HEIGHT_FACTOR) * PT_TO_MM;
  }

  function baselineOffsetMm(fontSizePt) {
    return (CELL_PADDING_PT + fontSizePt * BASELINE_OFFSET_FACTOR) * PT_TO_MM;
  }

  function estimateTextWidthMm(str, fontSizePt) {
    return String(str).length * fontSizePt * AVG_CHAR_WIDTH_FACTOR * PT_TO_MM;
  }

  // Corta `str` (com "…" no final) até caber em `maxWidthMm`, pela mesma
  // estimativa de largura usada pro auto-fit de coluna. Não corta se já
  // couber inteiro.
  function truncateToWidth(str, maxWidthMm, fontSizePt) {
    str = String(str);
    if (estimateTextWidthMm(str, fontSizePt) <= maxWidthMm) return str;
    if (estimateTextWidthMm('…', fontSizePt) > maxWidthMm) return '';
    let lo = 0;
    let hi = str.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const candidate = str.slice(0, mid) + '…';
      if (estimateTextWidthMm(candidate, fontSizePt) <= maxWidthMm) lo = mid;
      else hi = mid - 1;
    }
    return lo === 0 ? '…' : str.slice(0, lo) + '…';
  }

  // Larguras proporcionais ao maior conteúdo de cada coluna (cabeçalho
  // incluído), com piso mínimo — se o piso não couber em `availableWidthMm`
  // (muitas colunas), redistribui o excesso proporcionalmente entre as
  // colunas que sobraram acima do piso.
  function computeColumnWidths(columns, bodyRows, availableWidthMm) {
    const weights = columns.map((col, i) => {
      let maxLen = String(col).length;
      bodyRows.forEach((row) => {
        maxLen = Math.max(maxLen, String(row[i] ?? '').length);
      });
      return Math.max(maxLen, 3);
    });
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    let widths = weights.map((w) => (w / totalWeight) * availableWidthMm);

    const deficits = widths.map((w) => Math.max(0, MIN_COL_WIDTH_MM - w));
    const totalDeficit = deficits.reduce((a, b) => a + b, 0);
    if (totalDeficit > 0) {
      const donors = widths.map((w, i) => (deficits[i] === 0 ? w : 0));
      const totalDonorWidth = donors.reduce((a, b) => a + b, 0);
      widths = widths.map((w, i) => {
        if (deficits[i] > 0) return MIN_COL_WIDTH_MM;
        if (totalDonorWidth <= 0) return w;
        return w - totalDeficit * (w / totalDonorWidth);
      });
    }
    return widths;
  }

  /**
   * Desenha um relatório de uma página de título + tabela, com quebra de
   * página automática (repetindo o cabeçalho da tabela) quando as linhas não
   * cabem mais.
   *
   * @param {object} doc - documento de PdfWriter.createDocument(), já criado
   *   pelo chamador (landscape/unit à escolha dele).
   * @param {object} opts
   * @param {string} opts.title
   * @param {string} opts.subtitle
   * @param {string[]} opts.columns - cabeçalhos, na ordem das colunas
   * @param {string[][]} opts.rows - linhas do corpo, cada uma um array na
   *   mesma ordem de `columns` (já formatadas como string)
   * @param {number} [opts.fontSize=8]
   */
  function renderReport(doc, { title, subtitle, columns, rows, fontSize = 8 }) {
    doc.setFont('helvetica');
    doc.setTextColor(...TITLE_TEXT);
    doc.setFontSize(14);
    doc.text(title, MARGIN_MM, 16);
    doc.setFontSize(10);
    doc.text(subtitle, MARGIN_MM, 22);

    const availableWidthMm = doc.pageWidth - MARGIN_MM * 2;
    const colWidths = computeColumnWidths(columns, rows, availableWidthMm);
    const rowHeight = rowHeightMm(fontSize);
    const baselineOffset = baselineOffsetMm(fontSize);
    const bottomLimit = doc.pageHeight - MARGIN_MM;

    function drawRow(y, cells, { fill, textColor, bold }) {
      let x = MARGIN_MM;
      doc.setFont(bold ? 'helvetica-bold' : 'helvetica');
      doc.setFontSize(fontSize);
      doc.setTextColor(...textColor);
      colWidths.forEach((w, i) => {
        doc.setFillColor(...fill);
        doc.rect(x, y, w, rowHeight, 'F');
        const innerWidth = w - CELL_PADDING_PT * 2 * PT_TO_MM;
        const text = truncateToWidth(cells[i] ?? '', innerWidth, fontSize);
        doc.text(text, x + CELL_PADDING_PT * PT_TO_MM, y + baselineOffset);
        x += w;
      });
    }

    function drawHeader(y) {
      drawRow(y, columns, { fill: HEADER_FILL, textColor: HEADER_TEXT, bold: true });
      return y + rowHeight;
    }

    let y = 28;
    y = drawHeader(y);

    rows.forEach((row, i) => {
      if (y + rowHeight > bottomLimit) {
        doc.addPage();
        y = MARGIN_MM;
        y = drawHeader(y);
      }
      drawRow(y, row, { fill: ROW_FILL[i % 2], textColor: BODY_TEXT, bold: false });
      y += rowHeight;
    });
  }

  return {
    renderReport,
    _internals: { computeColumnWidths, truncateToWidth, rowHeightMm, estimateTextWidthMm },
  };
});
