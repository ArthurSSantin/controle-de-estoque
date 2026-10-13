// Conferência de estoque: confronta o estoque físico com o digital —
// presença/ausência confirmada por item, manualmente ou escaneando o
// código de barras. Ver frontend/app.js seção "10e2/10e3".
const { test, expect } = require('@playwright/test');
const { buildFakeTires, installCommonMocks, bootIntoApp, waitForContentReady } = require('../helpers/mock-app');

// Substitui getUserMedia e BarcodeDetector por versões determinísticas ANTES
// da página carregar — evita depender de câmera real ou de um código de
// barras de verdade estar visível num frame de vídeo sintético. `rawValue`
// null simula "nenhum código detectado neste frame".
async function mockCamera(page, rawValue) {
  await page.addInitScript((code) => {
    if (!navigator.mediaDevices) navigator.mediaDevices = {};
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 240;
      canvas.getContext('2d').fillRect(0, 0, 320, 240);
      return canvas.captureStream(10);
    };
    window.BarcodeDetector = class {
      static async getSupportedFormats() {
        return ['code_128', 'ean_13'];
      }
      async detect() {
        return code ? [{ rawValue: code }] : [];
      }
    };
  }, rawValue || null);
}

test.describe('Conferência de estoque — fluxo manual', () => {
  test('abrir a aba lista todos os pneus, todos pendentes de início', async ({ page }) => {
    await installCommonMocks(page, { tires: buildFakeTires(5) });
    await bootIntoApp(page);
    await waitForContentReady(page);

    await page.click('[data-tab="conferencia"]');
    await expect(page.locator('#conferList .confer-row')).toHaveCount(5);

    const stats = page.locator('#conferStats');
    await expect(stats.locator('.confer-stat.pendente b')).toHaveText('5');
    await expect(stats.locator('.confer-stat.presente b')).toHaveText('0');
    await expect(stats.locator('.confer-stat.ausente b')).toHaveText('0');
  });

  test('confirmar presença manualmente marca a tag "conferido" com data e soma nas estatísticas', async ({ page }) => {
    await installCommonMocks(page, { tires: buildFakeTires(3) });
    await bootIntoApp(page);
    await waitForContentReady(page);
    await page.click('[data-tab="conferencia"]');

    const firstRow = page.locator('#conferList .confer-row').first();
    await firstRow.locator('.presente-btn').click();

    await expect(firstRow).toHaveClass(/is-presente/);
    await expect(firstRow.locator('.tag-conferido.presente')).toContainText('conferido em');
    await expect(page.locator('#conferStats .confer-stat.presente b')).toHaveText('1');
    await expect(page.locator('#conferStats .confer-stat.pendente b')).toHaveText('2');

    // a tag também aparece na aba Estoque (a mesma informação, visível fora da conferência)
    await page.click('[data-tab="estoque"]');
    await expect(page.locator('.row .tag-conferido.presente').first()).toBeVisible();
  });

  test('marcar ausente deixa uma tag buscável pelo estoque principal', async ({ page }) => {
    await installCommonMocks(page, { tires: buildFakeTires(3) });
    await bootIntoApp(page);
    await waitForContentReady(page);
    await page.click('[data-tab="conferencia"]');

    const firstRow = page.locator('#conferList .confer-row').first();
    const marca = await firstRow.locator('.confer-row-brand').textContent();
    await firstRow.locator('.ausente-btn').click();

    await expect(firstRow).toHaveClass(/is-ausente/);
    await expect(firstRow.locator('.tag-conferido.ausente')).toContainText('não encontrado');
    await expect(page.locator('#conferStats .confer-stat.ausente b')).toHaveText('1');

    // busca "ausente" no estoque principal encontra esse item marcado
    await page.click('[data-tab="estoque"]');
    await page.fill('#searchInput', 'ausente');
    await expect(page.locator('.row')).toHaveCount(1);
    await expect(page.locator('.row')).toContainText(marca);
    await expect(page.locator('.row .tag-conferido.ausente')).toBeVisible();
  });

  test('dá pra corrigir uma marcação (ausente -> presente)', async ({ page }) => {
    await installCommonMocks(page, { tires: buildFakeTires(2) });
    await bootIntoApp(page);
    await waitForContentReady(page);
    await page.click('[data-tab="conferencia"]');

    const firstRow = page.locator('#conferList .confer-row').first();
    await firstRow.locator('.ausente-btn').click();
    await expect(firstRow).toHaveClass(/is-ausente/);

    await firstRow.locator('.presente-btn').click();
    await expect(firstRow).toHaveClass(/is-presente/);
    await expect(firstRow).not.toHaveClass(/is-ausente/);
    await expect(page.locator('#conferStats .confer-stat.ausente b')).toHaveText('0');
    await expect(page.locator('#conferStats .confer-stat.presente b')).toHaveText('1');
  });

  test('reiniciar conferência pede confirmação, limpa tudo e grava no servidor', async ({ page }) => {
    const resets = [];
    const state = await installCommonMocks(page, {
      tires: buildFakeTires(4),
      onRequest: (method, url) => { if (url.includes('/conferencia/reset')) resets.push(method); },
    });
    await bootIntoApp(page);
    await waitForContentReady(page);
    await page.click('[data-tab="conferencia"]');

    const resetBtn = page.locator('#conferResetBtn');
    await expect(resetBtn, 'nada marcado, nada pra reiniciar').toBeDisabled();

    const rows = page.locator('#conferList .confer-row');
    await rows.nth(0).locator('.presente-btn').click();
    await expect(rows.nth(0)).toHaveClass(/is-presente/);
    await rows.nth(1).locator('.ausente-btn').click();
    await expect(page.locator('#conferStats .confer-stat.ausente b')).toHaveText('1');
    await expect(resetBtn).toBeEnabled();

    // 1º clique só pede confirmação
    await resetBtn.click();
    await expect(resetBtn).toContainText('Confirmar');
    await expect(page.locator('#conferStats .confer-stat.presente b')).toHaveText('1');

    await resetBtn.click();
    await expect(page.locator('#conferStats .confer-stat.pendente b')).toHaveText('4');
    await expect(page.locator('#conferStats .confer-stat.presente b')).toHaveText('0');
    await expect(page.locator('#conferStats .confer-stat.ausente b')).toHaveText('0');
    await expect(page.locator('#toast')).toContainText('Conferência reiniciada');
    await expect(page.locator('#conferList .is-presente, #conferList .is-ausente')).toHaveCount(0);

    // grava depois da janela de "Desfazer"
    await expect.poll(() => resets, { timeout: 10000 }).toEqual(['POST']);
    expect(state.tires.filter((t) => t.conferidoStatus)).toHaveLength(0);
  });

  test('"Desfazer" do reinício devolve as marcas sem chamar o servidor', async ({ page }) => {
    await page.clock.install();
    const resets = [];
    await installCommonMocks(page, {
      tires: buildFakeTires(3),
      onRequest: (method, url) => { if (url.includes('/conferencia/reset')) resets.push(method); },
    });
    await bootIntoApp(page);
    await waitForContentReady(page);
    await page.click('[data-tab="conferencia"]');

    const rows = page.locator('#conferList .confer-row');
    await rows.nth(0).locator('.presente-btn').click();
    await expect(page.locator('#conferStats .confer-stat.presente b')).toHaveText('1');

    await page.click('#conferResetBtn');
    await page.click('#conferResetBtn');
    await expect(page.locator('#conferStats .confer-stat.presente b')).toHaveText('0');
    await page.click('#toast .undo-btn');

    await expect(page.locator('#conferStats .confer-stat.presente b')).toHaveText('1');
    await page.clock.fastForward(10000);
    expect(resets, 'desfeito: nada vai pro servidor').toEqual([]);
  });

  test('marcar um pneu logo após reiniciar grava o reinício antes (a marca nova não some)', async ({ page }) => {
    const order = [];
    const state = await installCommonMocks(page, {
      tires: buildFakeTires(3),
      onRequest: (method, url) => {
        if (url.includes('/conferencia/reset')) order.push('reset');
        else if (url.includes('/conferencia') && method === 'PUT') order.push('marca');
      },
    });
    await bootIntoApp(page);
    await waitForContentReady(page);
    await page.click('[data-tab="conferencia"]');

    const rows = page.locator('#conferList .confer-row');
    await rows.nth(0).locator('.presente-btn').click();
    await expect(page.locator('#conferStats .confer-stat.presente b')).toHaveText('1');
    await page.click('#conferResetBtn');
    await page.click('#conferResetBtn');
    await expect(page.locator('#conferStats .confer-stat.presente b')).toHaveText('0');

    await rows.nth(2).locator('.presente-btn').click();
    await expect(page.locator('#conferStats .confer-stat.presente b')).toHaveText('1');
    expect(order).toEqual(['marca', 'reset', 'marca']);
    expect(state.tires.filter((t) => t.conferidoStatus === 'presente')).toHaveLength(1);
  });

  test('busca da aba filtra por marca/medida', async ({ page }) => {
    const tires = buildFakeTires(10);
    await installCommonMocks(page, { tires });
    await bootIntoApp(page);
    await waitForContentReady(page);
    await page.click('[data-tab="conferencia"]');

    await page.fill('#conferSearchInput', 'Marca Exclusiva 5');
    await expect(page.locator('#conferList .confer-row')).toHaveCount(1);
  });

  test('Esc fecha o modal de escaneamento da conferência sem travar a página', async ({ page }) => {
    await mockCamera(page, null);
    await installCommonMocks(page, { tires: buildFakeTires(2) });
    await bootIntoApp(page);
    await waitForContentReady(page);
    await page.click('[data-tab="conferencia"]');

    await page.click('#conferScanBtn');
    await expect(page.locator('#conferScanModal')).toHaveClass(/open/);

    await page.keyboard.press('Escape');
    await expect(page.locator('#conferScanModal')).not.toHaveClass(/open/);

    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.waitForTimeout(200);
    expect(errors).toEqual([]);
  });
});

test.describe('Conferência de estoque — escaneamento contínuo', () => {
  test('escanear um código conhecido marca presente e continua escaneando', async ({ page }) => {
    const tires = buildFakeTires(3); // o item i=0 tem codigoBarras (i % 4 === 0)
    const target = tires[0];
    await mockCamera(page, target.codigoBarras);
    await installCommonMocks(page, { tires });
    await bootIntoApp(page);
    await waitForContentReady(page);
    await page.click('[data-tab="conferencia"]');

    await page.click('#conferScanBtn');
    await expect(page.locator('#conferScanModal')).toHaveClass(/open/);

    // a leitura marca o pneu automaticamente como presente
    const row = page.locator(`#conferList .confer-row[data-id="${target.id}"]`);
    await expect(row).toHaveClass(/is-presente/, { timeout: 10000 });
    await expect(page.locator('#conferScanStatus')).toContainText('presente');

    // continua escaneando — o modal não fecha sozinho
    await expect(page.locator('#conferScanModal')).toHaveClass(/open/);

    await page.click('#cancelConferScanBtn');
    await expect(page.locator('#conferScanModal')).not.toHaveClass(/open/);
  });

  test('se o servidor não salvar, o scanner NÃO diz "marcado como presente"', async ({ page }) => {
    const tires = buildFakeTires(3);
    const target = tires[0];
    await mockCamera(page, target.codigoBarras);
    await installCommonMocks(page, { tires });
    // banco sem as colunas da conferência (migration não rodada)
    await page.route('**/api/tires/*/conferencia', (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Banco de dados desatualizado: rode as migrations de database/ no SQL Editor do Supabase.' }) })
    );
    await bootIntoApp(page);
    await waitForContentReady(page);
    await page.click('[data-tab="conferencia"]');

    await page.click('#conferScanBtn');
    await expect(page.locator('#conferScanStatus')).toContainText('não foi possível salvar', { timeout: 10000 });
    await expect(page.locator('#conferScanStatus')).not.toContainText('marcado como presente');
    await expect(page.locator('#toast')).toContainText('Banco de dados desatualizado');
    await expect(page.locator(`#conferList .confer-row[data-id="${target.id}"]`)).not.toHaveClass(/is-presente/);
  });

  test('escanear um código desconhecido avisa e mantém a câmera aberta', async ({ page }) => {
    await mockCamera(page, 'codigo-que-nao-existe-999');
    await installCommonMocks(page, { tires: buildFakeTires(2) });
    await bootIntoApp(page);
    await waitForContentReady(page);
    await page.click('[data-tab="conferencia"]');

    await page.click('#conferScanBtn');
    await expect(page.locator('#conferScanStatus')).toContainText('não encontrado', { timeout: 10000 });
    await expect(page.locator('#conferScanModal')).toHaveClass(/open/);
  });
});
