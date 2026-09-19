// Guarda de regressão: um teste por bug real já encontrado e corrigido
// neste projeto. Cada teste explica no comentário qual bug ele impede de
// voltar — se um destes falhar, é exatamente aquele problema de volta.
const { test, expect } = require('@playwright/test');
const { buildFakeTires, installCommonMocks, bootIntoApp, waitForContentReady, disableServiceWorker } = require('../helpers/mock-app');

test.describe('Regressão — exportação sem CDN externo', () => {
  // Bug: xlsx/jsPDF/autoTable vinham de cdnjs.cloudflare.com. Um
  // ad-blocker/DNS filtrado/firewall bloqueando esse domínio (aconteceu de
  // verdade com o usuário, no PC e no celular) travava a exportação sem
  // alternativa. Corrigido vendorizando as 3 libs em frontend/vendor/.
  test('exportar .xlsx e PDF funciona com cdnjs.cloudflare.com 100% bloqueado', async ({ page }) => {
    let cdnjsHits = 0;
    await page.route('https://cdnjs.cloudflare.com/**', (route) => {
      cdnjsHits++;
      route.abort('connectionrefused');
    });

    await installCommonMocks(page, { tires: buildFakeTires(3) });
    await bootIntoApp(page);
    await waitForContentReady(page);
    await page.click('[data-tab="exportar"]');

    const [xlsxDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#exportBtn'),
    ]);
    expect(xlsxDownload.suggestedFilename()).toMatch(/\.xlsx$/);

    await page.selectOption('#exportFormatSelect', 'pdf');
    const [pdfDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#exportBtn'),
    ]);
    expect(pdfDownload.suggestedFilename()).toMatch(/\.pdf$/);

    expect(cdnjsHits, 'exportar não deveria nem tentar chamar o cdnjs').toBe(0);
  });
});

test.describe('Regressão — biblioteca externa que falha ao carregar', () => {
  // Bug: loadScriptOnce() guardava a Promise rejeitada em cache pra sempre
  // depois de UMA falha — qualquer tentativa seguinte falhava na hora, sem
  // nunca tentar a rede de novo (usuário via o erro pra sempre na mesma
  // sessão, mesmo depois de resolver a rede real). Corrigido limpando o
  // cache em caso de falha.
  //
  // Simulamos a falha bloqueando o CDN de verdade (cdnjs, pdf.js) via
  // `page.route()` — determinístico, sem depender de um domínio externo
  // realmente estar fora do ar. Desligamos o Service Worker porque ele
  // cacheia a casca do app (ver sw.js) e poderia interferir na simulação.
  //
  // Alvo: LEITURA de PDF (import de relatório), via ensurePdfJs() ->
  // loadScriptOnce(PDFJS_CDN). Não é mais a exportação em PDF — desde que
  // ela passou a ser gerada por pdf-writer.js + pdf-table.js (sem terceiro,
  // sem loadScriptOnce), a exportação não carrega mais nenhum script
  // externo. A leitura de PDF (pdf.js, só usada no import/sincronização)
  // continua vindo de CDN com SRI, então é ela que ainda exercita o bug
  // original de loadScriptOnce().
  test('depois de uma falha ao carregar, uma nova tentativa tenta de novo (não fica presa em cache)', async ({ page }) => {
    await disableServiceWorker(page);
    await installCommonMocks(page, { tires: buildFakeTires(2) });

    let blockPdfJs = true;
    let hits = 0;
    await page.route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/**', (route) => {
      hits++;
      if (blockPdfJs) return route.abort('connectionrefused');
      return route.continue();
    });

    await bootIntoApp(page);
    await waitForContentReady(page);

    // PDF mínimo, mas válido de verdade (gerado pelo nosso próprio
    // pdf-writer.js, já carregado na página) — pdf.js precisa conseguir
    // abrir o arquivo pra provar que a 2ª tentativa funcionou; o conteúdo em
    // si não precisa ter nenhuma linha de estoque reconhecível.
    const pdfBytes = await page.evaluate(async () => {
      const doc = PdfWriter.createDocument();
      doc.text('relatório de teste', 14, 20);
      const blob = await doc.output();
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    });

    await page.click('#importBtn');

    // 1ª tentativa: CDN "bloqueado" -> erro visível (não trava silencioso)
    await page.setInputFiles('#importFileInput', {
      name: 'relatorio.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(pdfBytes),
    });
    await expect(page.locator('#importStatus')).toContainText('biblioteca externa', { timeout: 15000 });
    expect(hits, 'deveria ter tentado buscar o pdf.js pelo menos uma vez').toBeGreaterThan(0);
    const hitsAfterFirstTry = hits;

    // "conserta a rede" e tenta importar de novo — se o bug estivesse de
    // volta, isso falharia na hora com o mesmo erro em cache, SEM gerar
    // uma requisição nova pro arquivo.
    blockPdfJs = false;
    await page.setInputFiles('#importFileInput', {
      name: 'relatorio.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(pdfBytes),
    });
    await expect(page.locator('#importStatus')).not.toContainText('biblioteca externa', { timeout: 15000 });
    expect(hits, 'a 2ª tentativa deveria ter buscado o pdf.js de novo, não reusado o erro em cache').toBeGreaterThan(hitsAfterFirstTry);
  });
});

test.describe('Regressão — não travar a tela esperando limpeza de duplicados', () => {
  // Bug: load() só renderizava depois de mergeExistingDuplicates() terminar
  // — com duplicatas, isso disparava PUT/DELETE reais antes de mostrar
  // qualquer coisa. Ver também performance.spec.js pro limite de tempo.
  test('estoque aparece antes da faxina de duplicados terminar', async ({ page }) => {
    let mergeRequestsInFlight = 0;
    let renderedBeforeMergeFinished = false;

    await installCommonMocks(page, {
      tires: buildFakeTires(10, { withDuplicates: 3 }),
      mutationLatencyMs: 2000, // só as escritas do merge são lentas — a GET inicial é rápida
      onRequest: (method) => {
        if (method === 'PUT' || method === 'DELETE') mergeRequestsInFlight++;
      },
    });

    await bootIntoApp(page);

    // no meio da janela de latência simulada (bem antes de 2s), o conteúdo
    // já deveria estar visível — se estivesse esperando o merge, ainda
    // estaria em "Carregando estoque..." aqui.
    await page.waitForTimeout(600);
    const stillLoading = await page.evaluate(() => !!document.querySelector('#content .loading'));
    expect(stillLoading, 'o estoque deveria já estar na tela antes do merge terminar').toBe(false);
    expect(mergeRequestsInFlight, 'as chamadas de merge deveriam ter começado em paralelo, não travar a tela').toBeGreaterThan(0);
  });
});

test.describe('Regressão — overflow horizontal com marca comprida', () => {
  // Bug: o <select> de filtro do Histórico (.sort-select) não tinha
  // max-width — com uma marca/medida comprida entre as opções, o navegador
  // dimensionava o select pelo texto mais longo e empurrava a PÁGINA INTEIRA
  // pra largura maior que a tela (scroll horizontal no app inteiro, não só
  // no select). Mesma causa-raiz achada no gráfico do Dashboard (as barras
  // de 14 dias não cabiam e não tinham overflow-x próprio). Corrigido com
  // max-width:100%/min-width:0 no .sort-select e overflow-x:auto no
  // #dashboardChart — os dois têm que rolar sozinhos, nunca a página toda.
  test('Histórico e Dashboard não estouram a largura da tela com marca comprida', async ({ page }) => {
    const longTire = {
      id: 'long-1',
      marca: 'Pirelli Scorpion All Terrain Plus Edição Especial Off-Road Extra Comprida',
      medida: '265/70 R16',
      quantidade: 4,
      preco: '1.250,00',
      condicao: 'novo',
      novo: true,
      origem: 'empresa',
      fornecedor: null,
      codigoBarras: null,
      addedAt: Date.now(),
    };
    const state = await installCommonMocks(page, { tires: [longTire, ...buildFakeTires(5)] });
    state.history = [
      { id: 'h1', tireId: 'long-1', marca: longTire.marca, medida: longTire.medida, condicao: 'novo', acao: 'criado', valorNovo: '4', createdAt: Date.now() },
    ];
    await bootIntoApp(page);
    await waitForContentReady(page);

    for (const tab of ['historico', 'dashboard']) {
      await page.click(`[data-tab="${tab}"]`);
      await page.waitForTimeout(300);
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(scrollWidth, `aba "${tab}" não deveria criar scroll horizontal na página`).toBeLessThanOrEqual(clientWidth);
    }
  });
});

test.describe('Regressão — merges de duplicados concorrentes', () => {
  // Bug: mergeExistingDuplicates() é chamada em 3 pontos (load(), commitItems(),
  // syncCompanyStock()) que podem se sobrepor no tempo (ex: usuário adiciona um
  // pneu novo enquanto o merge automático de fundo do load() ainda não terminou
  // de gravar no backend). Sem uma trava, as duas chamadas liam o MESMO grupo
  // de duplicados antes de qualquer uma das duas terminar de atualizar o array
  // `tires` — cada uma somava a quantidade do grupo de novo por cima do
  // resultado da outra, inflando a quantidade final (ex: 4+6 devia dar 10, mas
  // virava 16) e gravando uma entrada de "entrada"/"saída" fantasma no
  // histórico. Corrigido com um guard de reentrância: só um merge por vez.
  test('adicionar um pneu durante o merge de fundo não infla a quantidade mesclada', async ({ page }) => {
    const base = { marca: 'Goodyear Duplicado', medida: '205/55 R16', condicao: 'novo', novo: false, origem: 'local' };
    await installCommonMocks(page, {
      tires: [
        { id: 'x1', ...base, quantidade: 4, preco: '250,00', addedAt: Date.now() - 5000 },
        { id: 'x2', ...base, quantidade: 6, preco: '260,00', addedAt: Date.now() - 3000 },
      ],
      // atraso nas escritas (PUT/DELETE) do merge automático, pra dar tempo
      // de disparar uma 2ª ação enquanto ele ainda está "no ar" — replica o
      // timing real de um backend hospedado longe.
      mutationLatencyMs: 500,
    });
    await bootIntoApp(page);
    await waitForContentReady(page);

    // enquanto o merge de fundo do load() ainda não terminou de gravar,
    // adiciona um pneu novo — commitItems() dispara outro mergeExistingDuplicates().
    await page.click('#toggleFormBtn');
    await page.fill('#fMarca', 'Pneu Qualquer');
    await page.fill('#fMedida', '175/70 R13');
    await page.fill('#fQtd', '1');
    await page.click('#saveBtn');

    await page.waitForTimeout(1500); // dá tempo dos dois merges terminarem

    await page.evaluate(() => new Promise((r) => setTimeout(r, 0))); // deixa a fila de microtasks assentar
    await page.reload();
    await bootIntoApp(page);
    await waitForContentReady(page);

    const goodyearRows = await page.locator('.row', { hasText: 'Goodyear Duplicado' }).count();
    expect(goodyearRows, 'não deveria sobrar linha duplicada do grupo mesclado').toBe(1);

    const qtyText = await page.locator('.row', { hasText: 'Goodyear Duplicado' }).locator('.qty-pill').textContent();
    expect(qtyText, 'a quantidade mesclada deveria ser exatamente a soma real (4+6=10), não inflada por um merge duplicado').toContain('10 un.');
  });
});

test.describe('Regressão — ícone maskable do PWA', () => {
  // Bug: o ícone maskable veio com cantos arredondados transparentes e o
  // desenho colado na borda — no Android (que aplica sua própria máscara
  // por cima), isso corta a arte de forma imprevisível. Corrigido com fundo
  // sólido de borda a borda e a arte dentro da "zona segura" (~80% central).
  test('fundo do ícone maskable é opaco de ponta a ponta e a arte fica na zona segura', async ({ page, request }) => {
    const manifest = await (await request.get('/manifest.json')).json();
    const maskable = manifest.icons.find((i) => i.purpose === 'maskable');
    expect(maskable, 'manifest deveria ter um ícone maskable').toBeTruthy();

    await page.goto('/index.html');
    const metrics = await page.evaluate(async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const { width: w, height: h } = canvas;
      const corners = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]].map(
        ([x, y]) => ctx.getImageData(x, y, 1, 1).data[3]
      );

      // acha o pixel mais distante do centro que difere do fundo (canto 0,0)
      const bg = ctx.getImageData(0, 0, 1, 1).data;
      const { data } = ctx.getImageData(0, 0, w, h);
      const cx = w / 2, cy = h / 2;
      let maxDist = 0;
      for (let y = 0; y < h; y += 4) { // amostra a cada 4px, suficiente e bem mais rápido
        for (let x = 0; x < w; x += 4) {
          const idx = (y * w + x) * 4;
          const diff = Math.abs(data[idx] - bg[0]) + Math.abs(data[idx + 1] - bg[1]) + Math.abs(data[idx + 2] - bg[2]);
          if (diff > 30) {
            const dist = Math.hypot(x - cx, y - cy);
            if (dist > maxDist) maxDist = dist;
          }
        }
      }
      return { w, h, cornerAlphas: corners, contentRadiusRatio: maxDist / (Math.min(w, h) / 2) };
    }, '/' + maskable.src);

    expect(metrics.cornerAlphas, 'os 4 cantos precisam ser 100% opacos (sem cantos arredondados transparentes)').toEqual([255, 255, 255, 255]);
    expect(metrics.contentRadiusRatio, 'a arte precisa caber na zona segura (~80% central) do ícone maskable').toBeLessThan(0.8);
  });
});

test.describe('Regressão — fallback de leitura de código sem BarcodeDetector', () => {
  // Bug: JSQR_CDN apontava pra cdnjs.cloudflare.com/ajax/libs/jsQR/1.4.0/jsQR.js
  // — jsQR NUNCA existiu no cdnjs (404), então em qualquer navegador sem a
  // BarcodeDetector API nativa (Firefox, Safari mais antigos) o scanner de
  // código de barras/QR simplesmente não funcionava, silenciosamente, sem
  // ninguém perceber (os testes sempre mockavam BarcodeDetector, então nunca
  // exercitavam esse caminho). Corrigido servindo jsQR pelo jsDelivr (espelho
  // do pacote npm oficial `jsqr`, com SHA-384 fixado no <script>).
  //
  // Este teste força a ausência de BarcodeDetector e faz uma chamada de rede
  // DE VERDADE pro jsDelivr (sem mockar essa URL) — é o único jeito de provar
  // que o arquivo existe e carrega, não só que o código "tentou" carregar algo.
  test('sem BarcodeDetector nativo, carrega o jsQR de verdade e a câmera inicia', async ({ page }) => {
    await page.addInitScript(() => {
      delete window.BarcodeDetector;
      if (!navigator.mediaDevices) navigator.mediaDevices = {};
      navigator.mediaDevices.getUserMedia = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 240;
        canvas.getContext('2d').fillRect(0, 0, 320, 240);
        return canvas.captureStream(10);
      };
    });

    await installCommonMocks(page, { tires: buildFakeTires(1) });
    await bootIntoApp(page);
    await waitForContentReady(page);

    await page.click('#conferBtn');
    // Se o jsQR não carregasse, #scannerStatus ficaria visível com a mensagem
    // de erro de biblioteca externa em vez de sumir (câmera "ligada").
    await expect(page.locator('#scannerStatus')).toBeHidden({ timeout: 15000 });
  });
});
