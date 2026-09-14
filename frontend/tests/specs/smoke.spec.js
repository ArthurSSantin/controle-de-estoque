// Testes de fumaça: o app carrega, não quebra, e os elementos estruturais
// básicos existem — a primeira coisa que deveria falhar se algo saiu muito
// errado (HTML quebrado, script com erro de sintaxe, id renomeado etc).
const { test, expect } = require('@playwright/test');
const { buildFakeTires, installCommonMocks, bootIntoApp, waitForContentReady } = require('../helpers/mock-app');

test.describe('Smoke', () => {
  // Google Fonts é bloqueado de propósito pelo mock (sem custo, sem rede
  // externa) — o "Failed to load resource" que isso gera é ruído esperado
  // do harness de teste, não um erro do app.
  function collectRealErrors(page) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !msg.text().includes('Failed to load resource')) errors.push(msg.text());
    });
    return errors;
  }

  test('carrega sem erros de console/página com estoque vazio', async ({ page }) => {
    const errors = collectRealErrors(page);

    await installCommonMocks(page, { tires: [] });
    await bootIntoApp(page);
    await waitForContentReady(page);

    await expect(page.locator('.empty h3')).toHaveText('Nenhum pneu cadastrado');
    expect(errors, 'não deveria haver erros de console/página').toEqual([]);
  });

  test('carrega sem erros de console/página com estoque populado', async ({ page }) => {
    const errors = collectRealErrors(page);

    await installCommonMocks(page, { tires: buildFakeTires(50) });
    await bootIntoApp(page);
    await waitForContentReady(page);

    await expect(page.locator('#content .row')).toHaveCount(50);
    expect(errors).toEqual([]);
  });

  test('estatísticas do topo batem com os dados carregados', async ({ page }) => {
    const tires = buildFakeTires(10, { lowStockEvery: 5 });
    await installCommonMocks(page, { tires });
    await bootIntoApp(page);
    await waitForContentReady(page);

    const totalUnidades = tires.reduce((s, t) => s + t.quantidade, 0);
    const baixoEstoque = tires.filter((t) => t.quantidade <= 2).length;
    await expect(page.locator('#stats .stat').nth(0).locator('b')).toHaveText('10');
    await expect(page.locator('#stats .stat').nth(1).locator('b')).toHaveText(String(totalUnidades));
    await expect(page.locator('#stats .stat').nth(2).locator('b')).toHaveText(String(baixoEstoque));
  });

  test('as 4 abas trocam de painel corretamente', async ({ page }) => {
    await installCommonMocks(page, { tires: buildFakeTires(5) });
    await bootIntoApp(page);
    await waitForContentReady(page);

    const tabs = [
      ['historico', 'tabHistorico'],
      ['dashboard', 'tabDashboard'],
      ['exportar', 'tabExportar'],
      ['estoque', 'tabEstoque'],
    ];
    for (const [tab, panelId] of tabs) {
      await page.click(`[data-tab="${tab}"]`);
      await expect(page.locator(`#${panelId}`)).toBeVisible();
    }
  });

  test('manifest do PWA é válido e referencia ícones existentes', async ({ page, request }) => {
    await page.goto('/index.html');
    const manifestHref = await page.getAttribute('link[rel="manifest"]', 'href');
    expect(manifestHref).toBeTruthy();

    const res = await request.get('/manifest.json');
    expect(res.ok()).toBeTruthy();
    const manifest = await res.json();
    expect(manifest.icons.length).toBeGreaterThan(0);
    for (const icon of manifest.icons) {
      const iconRes = await request.get('/' + icon.src);
      expect(iconRes.ok(), `ícone ${icon.src} deveria existir`).toBeTruthy();
    }
  });

  test('service worker registra sem erro', async ({ page }) => {
    await page.goto('/index.html');
    const active = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      return !!reg.active;
    });
    expect(active).toBe(true);
  });
});
