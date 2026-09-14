// Testes funcionais: os fluxos que o usuário realmente usa no dia a dia.
// Cobrem os pontos que já causaram bug real neste projeto (ver
// regressions.spec.js pros casos específicos já corrigidos).
const { test, expect } = require('@playwright/test');
const { buildFakeTires, installCommonMocks, bootIntoApp, waitForContentReady } = require('../helpers/mock-app');

test.describe('Cadastro manual', () => {
  test('adicionar um pneu novo aparece na lista', async ({ page }) => {
    await installCommonMocks(page, { tires: buildFakeTires(2) });
    await bootIntoApp(page);
    await waitForContentReady(page);

    await page.click('#toggleFormBtn');
    await expect(page.locator('#formPanel')).toHaveClass(/open/);

    await page.fill('#fMarca', 'Pneu de Teste E2E');
    await page.fill('#fMedida', '185/65 R14');
    await page.fill('#fQtd', '7');
    await page.click('#saveBtn');

    await expect(page.locator('#formPanel')).not.toHaveClass(/open/);
    await expect(page.locator('#content')).toContainText('Pneu de Teste E2E');
  });

  test('rejeita medida sem aro válido (R13-R20)', async ({ page }) => {
    await installCommonMocks(page, { tires: [] });
    await bootIntoApp(page);
    await waitForContentReady(page);

    await page.click('#toggleFormBtn');
    await page.fill('#fMarca', 'Pneu Inválido');
    await page.fill('#fMedida', '185/65');
    await page.fill('#fQtd', '1');
    await page.click('#saveBtn');

    await expect(page.locator('#formErr')).toBeVisible();
    await expect(page.locator('#formPanel')).toHaveClass(/open/); // não fechou
  });

  test('editar um pneu existente atualiza a linha', async ({ page }) => {
    await installCommonMocks(page, { tires: buildFakeTires(1) });
    await bootIntoApp(page);
    await waitForContentReady(page);

    await page.click('.edit-btn');
    await expect(page.locator('#formPanel')).toHaveClass(/open/);
    await page.fill('#fQtd', '42');
    await page.click('#saveBtn');

    await expect(page.locator('.qty-pill')).toContainText('42 un.');
  });

  test('excluir exige confirmação e permite desfazer', async ({ page }) => {
    await installCommonMocks(page, { tires: buildFakeTires(1) });
    await bootIntoApp(page);
    await waitForContentReady(page);

    await page.click('.del-btn'); // 1º clique: vira "Confirmar"
    await expect(page.locator('.del-btn')).toHaveText('Confirmar');
    await expect(page.locator('.row')).toHaveCount(1); // ainda não excluiu

    await page.click('.del-btn'); // 2º clique: exclui de fato
    await expect(page.locator('#toast')).toContainText('Pneu removido do estoque.');
    await expect(page.locator('.row')).toHaveCount(0);

    await page.click('#toast .undo-btn');
    await expect(page.locator('.row')).toHaveCount(1);
  });

  test('pop-out fecha ao clicar fora (no fundo escurecido)', async ({ page }) => {
    await installCommonMocks(page, { tires: [] });
    await bootIntoApp(page);
    await waitForContentReady(page);

    await page.click('#toggleFormBtn');
    await expect(page.locator('#formPanel')).toHaveClass(/open/);
    await page.click('#formPanel', { position: { x: 5, y: 5 } }); // fora do .modal-card
    await expect(page.locator('#formPanel')).not.toHaveClass(/open/);
  });
});

test.describe('Busca, filtros e ordenação', () => {
  test('busca por marca filtra a lista', async ({ page }) => {
    const tires = buildFakeTires(20);
    await installCommonMocks(page, { tires });
    await bootIntoApp(page);
    await waitForContentReady(page);

    await page.fill('#searchInput', 'Marca Exclusiva 5');
    await expect(page.locator('.row')).toHaveCount(1);
  });

  test('filtro de condição (novo/usado) funciona', async ({ page }) => {
    const tires = buildFakeTires(20); // metade novo, metade usado
    await installCommonMocks(page, { tires });
    await bootIntoApp(page);
    await waitForContentReady(page);

    await page.click('#condFilterGroup [data-cond="usado"]');
    await expect(page.locator('.row')).toHaveCount(10);
    for (const el of await page.locator('.row .tag-cond').all()) {
      await expect(el).toHaveText('Usado');
    }
  });

  test('ordenar por menor quantidade primeiro', async ({ page }) => {
    const tires = buildFakeTires(10);
    await installCommonMocks(page, { tires });
    await bootIntoApp(page);
    await waitForContentReady(page);

    await page.selectOption('#sortModeSelect', 'qtd_asc');
    const first = await page.locator('.qty-pill').first().textContent();
    const min = Math.min(...tires.map((t) => t.quantidade));
    expect(first).toContain(`${min} un.`);
  });

  test('"Limpar" reseta busca e filtros', async ({ page }) => {
    await installCommonMocks(page, { tires: buildFakeTires(5) });
    await bootIntoApp(page);
    await waitForContentReady(page);

    await page.fill('#searchInput', 'nada-vai-bater-com-isso');
    await expect(page.locator('.row')).toHaveCount(0);
    await page.click('#clearSearchBtn');
    await expect(page.locator('.row')).toHaveCount(5);
  });
});

test.describe('Exportar', () => {
  test('desmarcar coluna risca no preview e some da planilha exportada', async ({ page }) => {
    await installCommonMocks(page, { tires: buildFakeTires(3) });
    await bootIntoApp(page);
    await waitForContentReady(page);

    await page.click('[data-tab="exportar"]');
    const fornecedorCheckbox = page.locator('#exportPreviewTable th input[data-col="fornecedor"]');
    await expect(fornecedorCheckbox).toBeChecked();
    await fornecedorCheckbox.uncheck();

    await expect(page.locator('#exportPreviewTable th').filter({ hasText: 'Fornecedor' })).toHaveClass(/col-excluded/);
  });

  test('preview e exportação saem ordenados por medida (largura, menor pro maior)', async ({ page }) => {
    // largura cresce com i em buildFakeTires — inverte a ordem de entrega
    // da API pra garantir que o preview reordena de verdade, não só ecoa
    // a ordem que já veio pronta.
    await installCommonMocks(page, { tires: buildFakeTires(9).reverse() });
    await bootIntoApp(page);
    await waitForContentReady(page);
    await page.click('[data-tab="exportar"]');
    await page.waitForSelector('#exportPreviewTable tbody tr');

    const medidaColIndex = await page.locator('#exportPreviewTable th').evaluateAll(
      (ths) => ths.findIndex((th) => th.textContent.includes('Medida'))
    );
    const larguras = await page.locator('#exportPreviewTable tbody tr').evaluateAll(
      (rows, col) => rows.map((r) => {
        const text = r.children[col].textContent;
        return Number(/^(\d+)\//.exec(text)[1]);
      }),
      medidaColIndex
    );

    const sortedLarguras = [...larguras].sort((a, b) => a - b);
    expect(larguras, 'linhas do preview deveriam estar em ordem crescente de largura').toEqual(sortedLarguras);

    // o arquivo exportado tem que respeitar a mesma ordem
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#exportBtn'),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
  });

  test('não deixa desmarcar a última coluna restante', async ({ page }) => {
    await installCommonMocks(page, { tires: buildFakeTires(2) });
    await bootIntoApp(page);
    await waitForContentReady(page);

    await page.click('[data-tab="exportar"]');
    const checkboxes = page.locator('#exportPreviewTable th input[type="checkbox"]');
    const count = await checkboxes.count();
    for (let i = 0; i < count - 1; i++) await checkboxes.nth(i).uncheck();

    await checkboxes.last().click(); // deveria ser recusado (não usar .uncheck(), que esperaria o estado mudar)
    await expect(page.locator('#toast')).toContainText('Deixe pelo menos uma coluna selecionada.');
    await expect(checkboxes.last()).toBeChecked();
  });

  test('gera .xlsx sem depender de nenhum CDN externo', async ({ page }) => {
    await installCommonMocks(page, { tires: buildFakeTires(3) });
    await bootIntoApp(page);
    await waitForContentReady(page);
    await page.click('[data-tab="exportar"]');

    // só conta requisições a partir daqui — supabase-js/fonts no boot da
    // página não contam, o que importa é o clique em "Exportar" não sair
    // do domínio local.
    let externalRequests = 0;
    page.on('request', (req) => {
      if (!req.url().startsWith('http://localhost')) externalRequests++;
    });

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#exportBtn'),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
    expect(externalRequests, 'exportar não deveria chamar nenhum host externo (libs vendorizadas)').toBe(0);
  });

  test('gera PDF sem depender de nenhum CDN externo', async ({ page }) => {
    await installCommonMocks(page, { tires: buildFakeTires(3) });
    await bootIntoApp(page);
    await waitForContentReady(page);
    await page.click('[data-tab="exportar"]');
    await page.selectOption('#exportFormatSelect', 'pdf');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#exportBtn'),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  });
});
