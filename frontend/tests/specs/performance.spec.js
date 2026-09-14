// Testes de performance: medem tempo real (não só "passa/falha" funcional)
// e travam com um limite (threshold) generoso — o objetivo não é
// microotimizar, é pegar regressão grosseira antes de virar reclamação de
// usuário ("demora pra abrir"). Se um teste destes começar a falhar, o
// primeiro lugar a olhar é o que mudou em app.js:load()/render().
const { test, expect } = require('@playwright/test');
const { buildFakeTires, installCommonMocks, bootIntoApp } = require('../helpers/mock-app');

// tempo entre o boot começar e o estoque aparecer de fato na tela
async function measureTimeToRender(page) {
  const t0 = await page.evaluate(() => performance.now());
  await page.waitForFunction(
    () => {
      const el = document.getElementById('content');
      return el && !el.querySelector('.loading') && el.children.length > 0;
    },
    { timeout: 30000 }
  );
  return (await page.evaluate(() => performance.now())) - t0;
}

test.describe('Performance — carregar o estoque', () => {
  test('300 itens, sem duplicados: renderiza rápido mesmo com API lenta', async ({ page }) => {
    await installCommonMocks(page, { tires: buildFakeTires(300), writeLatencyMs: 400 });
    await bootIntoApp(page);
    const ms = await measureTimeToRender(page);
    // sem duplicados só existe 1 requisição (a GET inicial) — o teto aqui é
    // folgado, cobre a latência simulada da API + render.
    expect(ms).toBeLessThan(1500);
  });

  test('300 itens com 40 grupos duplicados: tela não pode esperar a faxina de fundo', async ({ page }) => {
    // Guarda de regressão pro bug real já corrigido: load() chegou a só
    // chamar render() DEPOIS de mergeExistingDuplicates() terminar — com
    // duplicados isso significava esperar PUT+DELETE reais pro backend
    // antes de mostrar qualquer coisa. Ver commit "Não trava a tela
    // esperando a limpeza de duplicados".
    await installCommonMocks(page, {
      tires: buildFakeTires(300, { withDuplicates: 40 }),
      writeLatencyMs: 400,
    });
    await bootIntoApp(page);
    const ms = await measureTimeToRender(page);

    // se render() voltasse a esperar o merge, isso ficaria pertinho de
    // 2×400ms (PUT em lote + DELETE em lote) só de latência de fundo —
    // 700ms dá margem confortável sem deixar a regressão passar batido.
    expect(ms).toBeLessThan(700);
  });

  test('1000 itens: renderização client-side não vira gargalo', async ({ page }) => {
    await installCommonMocks(page, { tires: buildFakeTires(1000) });
    await bootIntoApp(page);
    const ms = await measureTimeToRender(page);
    expect(ms).toBeLessThan(2000);
  });

  test('sem conexão com a API: cai pro cache local rapidamente (não fica travado)', async ({ page }) => {
    // 1ª carga: guarda o cache offline de propósito
    await installCommonMocks(page, { tires: buildFakeTires(20) });
    await bootIntoApp(page);
    await page.waitForFunction(() => {
      const el = document.getElementById('content');
      return el && !el.querySelector('.loading');
    });

    // 2ª carga (navegação nova): API fora do ar — deve usar o cache e
    // avisar, não travar
    await installCommonMocks(page, { apiFail: true });
    await bootIntoApp(page);
    const ms = await measureTimeToRender(page);
    expect(ms).toBeLessThan(2000);
    await expect(page.locator('#toast')).toContainText('Sem conexão com a API');
  });
});
