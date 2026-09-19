/**
 * Gerador de PDF mínimo, sem nenhuma dependência externa — camada baixa
 * usada pelo relatório de exportação em PDF (substitui jsPDF + autoTable).
 * A camada de layout de tabela (cabeçalho, quebra de página quando a tabela
 * não cabe, etc.) é responsabilidade de quem consome este módulo — aqui só
 * tem os primitivos de desenho (texto e retângulo), paginação manual, e um
 * pouco de estado mutável (fonte/cor atual) pra API ficar parecida com a do
 * jsPDF que este módulo substitui (facilita a migração de quem já tinha
 * código escrito contra jsPDF).
 *
 * Decisões de design (leia antes de estender este módulo):
 *
 * - API modelada de propósito em cima da API real do jsPDF (setFont,
 *   setFontSize, setTextColor, setFillColor, text, rect, save, output) —
 *   não é coincidência, é pra minimizar a distância entre "código que usava
 *   jsPDF" e "código que usa isto aqui".
 * - Unidade configurável (`unit: 'mm' | 'pt'`, default 'mm' — mesmo default
 *   do jsPDF) pra x/y/w/h e pageWidth/pageHeight. `setFontSize()` é SEMPRE
 *   em pontos, nunca convertido pela unidade — igual jsPDF de verdade.
 *   Internamente tudo vira pt (unidade nativa do PDF) antes de desenhar.
 * - Sistema de coordenadas exposto: origem no canto SUPERIOR ESQUERDO da
 *   página, Y crescendo pra BAIXO (igual jsPDF/canvas/CSS/DOM). O formato
 *   PDF nativo é o oposto (origem embaixo à esquerda, Y crescendo pra
 *   cima) — a conversão é feita internamente, símbolo por símbolo.
 * - `text(str, x, y)`: x/y é a posição da LINHA DE BASE do texto (mesma
 *   convenção do jsPDF), usa a fonte/tamanho/cor atuais (setados antes).
 * - `rect(x, y, w, h, style)`: x/y é o canto SUPERIOR esquerdo (jsPDF também
 *   funciona assim). `style`: 'F' preenche (com a fillColor atual), 'S'
 *   contorna (com a drawColor atual), 'FD'/'DF' os dois; omitido = 'S' (é o
 *   que jsPDF faz quando você não passa nada).
 * - Fonte: só as Standard 14 Fonts do PDF (Helvetica e Helvetica-Bold) —
 *   todo leitor de PDF já tem essas fontes embutidas, então o arquivo
 *   nunca precisa embutir dados de fonte. Encoding é WinAnsiEncoding
 *   (=Windows-1252), que cobre acentuação PT-BR (ç, ã, é, õ, ü etc. — todos
 *   no bloco Latin-1 Supplement, idêntico entre Unicode e WinAnsi nessa
 *   faixa) e "pontuação inteligente" comum em texto gerado (—, –, aspas
 *   curvas, …) via tabela de exceção pros bytes 0x80–0x9F. Caractere fora
 *   desse repertório (emoji, CJK etc.) vira '?' — não trava, só perde o
 *   glifo exato.
 * - getTextWidth() NÃO existe nesta versão (métrica real de largura por
 *   glifo do Helvetica não foi incluída pra não arriscar números errados
 *   sem conferência — dá pra adicionar depois se fizer falta pro layout de
 *   coluna da tabela).
 * - Paginação: quem chama decide quando a página está cheia e chama
 *   `addPage()` — este módulo expõe `pageWidth`/`pageHeight` pra isso, mas
 *   não sabe nada sobre "linhas de tabela" ou altura de conteúdo. O estado
 *   de fonte/cor NÃO é resetado por addPage() — igual jsPDF.
 * - Sem compressão de stream (`/Filter /FlateDecode`): os streams de
 *   conteúdo daqui são só texto ASCII com poucos comandos por página — o
 *   ganho de comprimir seria mínimo e não vale a complexidade extra.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PdfWriter = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MM_TO_PT = 2.8346456693;

  // Tamanhos de página em pontos (1pt = 1/72 polegada), sempre na orientação
  // "retrato" de referência — orientation vira/swap isso depois. Só A4 por
  // enquanto, é o único usado no app.
  const PAGE_SIZES = {
    a4: { width: 595.28, height: 841.89 },
  };

  /* =========================================================================
     WinAnsiEncoding (~Windows-1252): converte um code point Unicode pro byte
     que representa o mesmo caractere nessa codificação de 1 byte.
  ========================================================================= */

  // Exceções na faixa 0x80–0x9F (nessa faixa, WinAnsi diverge do Unicode —
  // fora dela, até 0xFF, o byte WinAnsi é sempre igual ao code point).
  const WINANSI_HIGH_EXCEPTIONS = {
    0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
    0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
    0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
    0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
    0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
    0x017e: 0x9e, 0x0178: 0x9f,
  };
  const FALLBACK_BYTE = 0x3f; // '?' — usado quando o caractere não existe em WinAnsi

  function toWinAnsiByte(codePoint) {
    if (codePoint <= 0x7f) return codePoint;
    if (codePoint >= 0xa0 && codePoint <= 0xff) return codePoint;
    return WINANSI_HIGH_EXCEPTIONS[codePoint] !== undefined ? WINANSI_HIGH_EXCEPTIONS[codePoint] : FALLBACK_BYTE;
  }

  // Retorna uma "binary string" (cada caractere JS = 1 byte de saída, code
  // unit 0–255) — o mesmo truque usado em zip-writer.js/xlsx-writer.js pra
  // montar bytes usando concatenação normal de string.
  function encodeWinAnsi(str) {
    let out = '';
    for (const ch of String(str)) {
      out += String.fromCharCode(toWinAnsiByte(ch.codePointAt(0)));
    }
    return out;
  }

  // Escapa `(`, `)` e `\` (únicos caracteres especiais dentro de uma string
  // literal PDF) e remove caracteres de controle (não têm por que aparecer
  // em texto de relatório, e podem quebrar a leitura da string literal).
  function escapePdfString(winAnsiStr) {
    let out = '';
    for (let i = 0; i < winAnsiStr.length; i++) {
      const byte = winAnsiStr.charCodeAt(i);
      if (byte < 0x20) continue;
      if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += '\\';
      out += winAnsiStr[i];
    }
    return out;
  }

  // Formata um número pro conteúdo do PDF: no máximo 2 casas decimais, sem
  // notação científica, sem zeros à toa (PDF aceita tanto "12" quanto "12.5").
  function fmtNum(n) {
    return (Math.round(n * 100) / 100).toString();
  }

  function colorOp(rgb, op) {
    return `${fmtNum(rgb[0] / 255)} ${fmtNum(rgb[1] / 255)} ${fmtNum(rgb[2] / 255)} ${op}`;
  }

  /* =========================================================================
     Montagem de baixo nível do arquivo PDF (objetos indexados + xref +
     trailer). Ver comentário no topo do arquivo pra estrutura geral.
  ========================================================================= */

  function createDocument(opts) {
    opts = opts || {};

    const unitName = opts.unit || 'mm';
    const scale = unitName === 'mm' ? MM_TO_PT : unitName === 'pt' ? 1 : null;
    if (scale === null) {
      throw new Error(`createDocument: unit "${opts.unit}" não suportada (use "mm" ou "pt").`);
    }

    const formatName = (opts.format || opts.pageSize || 'a4').toLowerCase();
    const baseSize = PAGE_SIZES[formatName];
    if (!baseSize) {
      throw new Error(`createDocument: format "${opts.format || opts.pageSize}" não suportado (só: ${Object.keys(PAGE_SIZES).join(', ')}).`);
    }

    const orientation = opts.orientation || 'portrait';
    let pageWidthPt, pageHeightPt;
    if (orientation === 'landscape') {
      pageWidthPt = baseSize.height;
      pageHeightPt = baseSize.width;
    } else if (orientation === 'portrait') {
      pageWidthPt = baseSize.width;
      pageHeightPt = baseSize.height;
    } else {
      throw new Error(`createDocument: orientation "${orientation}" não suportada (use "portrait" ou "landscape").`);
    }

    const pages = []; // cada item: { ops: string[] } — comandos do content stream, nesta ordem
    const addPage = () => {
      pages.push({ ops: [] });
    };
    addPage(); // começa já com a página 1 — quem usa não precisa chamar addPage() antes do 1º desenho

    function currentPage() {
      return pages[pages.length - 1];
    }

    // Estado mutável (igual jsPDF): fica valendo pros próximos text()/rect()
    // até ser trocado de novo. addPage() NÃO reseta nada disso.
    const state = {
      bold: false,
      fontSize: 12,
      textColor: [0, 0, 0],
      fillColor: [0, 0, 0],
      drawColor: [0, 0, 0],
    };

    function setFont(name) {
      state.bold = /bold/i.test(name || '');
    }
    function setFontSize(size) {
      state.fontSize = size; // sempre em pt, como no jsPDF — não passa por `scale`
    }
    function setTextColor(r, g, b) {
      state.textColor = [r, g, b];
    }
    function setFillColor(r, g, b) {
      state.fillColor = [r, g, b];
    }
    function setDrawColor(r, g, b) {
      state.drawColor = [r, g, b];
    }

    function text(str, x, y) {
      const xPt = x * scale;
      const pdfY = pageHeightPt - y * scale; // flip: topo-esquerda/Y-baixo -> nativo do PDF (base-esquerda/Y-cima)
      const font = state.bold ? '/F2' : '/F1';
      const escaped = escapePdfString(encodeWinAnsi(str));
      currentPage().ops.push(
        `${colorOp(state.textColor, 'rg')} BT ${font} ${fmtNum(state.fontSize)} Tf ${fmtNum(xPt)} ${fmtNum(pdfY)} Td (${escaped}) Tj ET`
      );
    }

    function rect(x, y, w, h, style) {
      style = style || 'S';
      const doFill = style === 'F' || style === 'FD' || style === 'DF';
      const doStroke = style === 'S' || style === 'FD' || style === 'DF';
      const xPt = x * scale;
      const wPt = w * scale;
      const hPt = h * scale;
      const pdfY = pageHeightPt - y * scale - hPt; // canto superior-esquerdo -> canto inferior-esquerdo nativo do PDF
      const ops = [];
      if (doFill) ops.push(colorOp(state.fillColor, 'rg'));
      if (doStroke) ops.push(colorOp(state.drawColor, 'RG'));
      ops.push(`${fmtNum(xPt)} ${fmtNum(pdfY)} ${fmtNum(wPt)} ${fmtNum(hPt)} re`);
      ops.push(doFill && doStroke ? 'B' : doFill ? 'f' : 'S');
      currentPage().ops.push(ops.join(' '));
    }

    async function output() {
      // Numeração de objetos: 1=Catalog, 2=Pages, 3=Font Helvetica,
      // 4=Font Helvetica-Bold, depois 2 objetos por página (Page + Contents).
      const CATALOG = 1, PAGES = 2, FONT_REGULAR = 3, FONT_BOLD = 4;
      const firstPageObjNum = 5;
      const pageObjNum = (i) => firstPageObjNum + i * 2;
      const contentObjNum = (i) => firstPageObjNum + i * 2 + 1;
      const totalObjects = firstPageObjNum + pages.length * 2 - 1;

      let body = '%PDF-1.4\n';
      const offsets = new Array(totalObjects + 1).fill(0);

      function emit(num, content) {
        offsets[num] = body.length;
        body += `${num} 0 obj\n${content}\nendobj\n`;
      }

      const kids = pages.map((_, i) => `${pageObjNum(i)} 0 R`).join(' ');
      emit(CATALOG, `<< /Type /Catalog /Pages ${PAGES} 0 R >>`);
      emit(PAGES, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
      emit(FONT_REGULAR, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
      emit(FONT_BOLD, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

      pages.forEach((page, i) => {
        const resources = `<< /Font << /F1 ${FONT_REGULAR} 0 R /F2 ${FONT_BOLD} 0 R >> >>`;
        emit(
          pageObjNum(i),
          `<< /Type /Page /Parent ${PAGES} 0 R /MediaBox [0 0 ${fmtNum(pageWidthPt)} ${fmtNum(pageHeightPt)}] /Resources ${resources} /Contents ${contentObjNum(i)} 0 R >>`
        );
        const streamBody = page.ops.join('\n') + '\n';
        emit(contentObjNum(i), `<< /Length ${streamBody.length} >>\nstream\n${streamBody}endstream`);
      });

      const xrefOffset = body.length;
      let xref = `xref\n0 ${totalObjects + 1}\n`;
      xref += '0000000000 65535 f \n';
      for (let n = 1; n <= totalObjects; n++) {
        xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
      }
      body += xref;
      body += `trailer\n<< /Size ${totalObjects + 1} /Root ${CATALOG} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

      const bytes = Uint8Array.from(body, (c) => c.charCodeAt(0));
      return new Blob([bytes], { type: 'application/pdf' });
    }

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

    async function save(filename) {
      const blob = await output();
      triggerDownload(blob, filename);
    }

    return {
      pageWidth: pageWidthPt / scale,
      pageHeight: pageHeightPt / scale,
      addPage,
      setFont,
      setFontSize,
      setTextColor,
      setFillColor,
      setDrawColor,
      text,
      rect,
      output,
      save,
    };
  }

  return {
    createDocument,
    createPdfWriter: createDocument, // alias — mesma função, nome alternativo
    _internals: { toWinAnsiByte, encodeWinAnsi, escapePdfString, fmtNum, PAGE_SIZES, MM_TO_PT },
  };
});
