// Personalização por conta (frontend/branding.js + aba Configurações):
// nome do sistema, logo recortada e — o ponto mais importante — o
// isolamento entre contas: o que uma conta escolhe nunca pode aparecer
// pra outra, nem na tela de login.
const path = require('path');
const { test, expect } = require('@playwright/test');
const {
  buildFakeTires,
  installCommonMocks,
  bootIntoApp,
  waitForContentReady,
  disableServiceWorker,
} = require('../helpers/mock-app');

// 640x480 de propósito: não é quadrada, então o recorte tem trabalho a fazer.
const LOGO_FIXTURE = path.join(__dirname, '..', 'fixtures', 'codes', 'qr.png');
// PNG 1x1 válido — serve de "logo já salva" nos testes que começam com uma.
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const STORAGE_KEY = 'sb-oytoeuoehoqdkhnhuuyy-auth-token';
const USER_A = { id: 'user-aaa', email: 'a@loja.com' };
const USER_B = { id: 'user-bbb', email: 'b@loja.com' };

/** Captura os corpos dos PUT /api/settings que saírem da página. */
function watchSettingsPuts(page) {
  const puts = [];
  page.on('request', (r) => {
    if (r.method() === 'PUT' && r.url().includes('/api/settings')) puts.push(r.postDataJSON());
  });
  return puts;
}

const DEFAULT_ACCENT = '#d71920';

/** Cor de destaque efetiva dentro do app (o que os botões usam). */
function accent(page) {
  return page.evaluate(() => getComputedStyle(document.getElementById('appScreen')).getPropertyValue('--accent').trim().toLowerCase());
}

test.beforeEach(async ({ page }) => {
  await disableServiceWorker(page);
});

/* ==========================================================================
   Tela de configurações
========================================================================== */

test('sem personalização, cabeçalho e título da aba ficam no padrão', async ({ page }) => {
  await installCommonMocks(page, { tires: buildFakeTires(2) });
  await bootIntoApp(page);
  await waitForContentReady(page);

  await expect(page.locator('#brandTitle')).toHaveText('Estoque de Pneus');
  await expect(page).toHaveTitle('Controle de Estoque de Pneus');
  await expect(page.locator('#appScreen')).not.toHaveClass(/has-custom-logo/);
});

test('salvar o nome troca cabeçalho, título da aba e o que vai pra API', async ({ page }) => {
  const state = await installCommonMocks(page, { tires: buildFakeTires(2) });
  const puts = watchSettingsPuts(page);
  await bootIntoApp(page);
  await waitForContentReady(page);

  await page.click('#settingsBtn');
  await expect(page.locator('#settingsPanel')).toBeVisible();
  await page.fill('#setAppName', 'Pneus do Arthur');
  await page.click('#saveSettingsBtn');

  await expect(page.locator('#settingsPanel')).toBeHidden();
  await expect(page.locator('#brandTitle')).toHaveText('Pneus do Arthur');
  await expect(page).toHaveTitle('Pneus do Arthur');
  expect(puts).toEqual([{ appName: 'Pneus do Arthur', logo: null, accentColor: null }]);
  expect(state.settings.appName).toBe('Pneus do Arthur');
});

test('API publicada sem /api/settings (404) explica o que fazer em vez de "rota não encontrada"', async ({ page }) => {
  await installCommonMocks(page, { tires: buildFakeTires(2) });
  // Edge Function antiga: não conhece a rota e responde o 404 genérico dela
  await page.route('**/api/settings**', (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'rota não encontrada' }) })
  );
  await bootIntoApp(page);
  await waitForContentReady(page);

  await page.click('#settingsBtn');
  await page.fill('#setAppName', 'teste');
  await page.click('#saveSettingsBtn');

  await expect(page.locator('#settingsErr')).toContainText('Servidor desatualizado');
  await expect(page.locator('#settingsPanel')).toBeVisible();
  await expect(page.locator('#brandTitle')).toHaveText('Estoque de Pneus');
});

test('desktop: botões Configurações/Sair cabem na barra lateral (sem rolagem horizontal)', async ({ page }, testInfo) => {
  test.skip((page.viewportSize() || {}).width < 901, 'barra lateral só existe no desktop');
  await installCommonMocks(page, { tires: buildFakeTires(2) });
  await bootIntoApp(page);
  await waitForContentReady(page);
  await page.evaluate(() => { document.getElementById('userEmail').textContent = 'arthursantin123@gmail.com'; });

  const m = await page.evaluate(() => {
    const side = document.querySelector('.app-sidebar').getBoundingClientRect();
    const sideEl = document.querySelector('.app-sidebar');
    const btns = ['#settingsBtn', '#logoutBtn'].map((sel) => document.querySelector(sel).getBoundingClientRect());
    return {
      overflow: sideEl.scrollWidth - sideEl.clientWidth,
      inside: btns.every((b) => b.left >= side.left && b.right <= side.right),
    };
  });
  expect(m.overflow).toBeLessThanOrEqual(0);
  expect(m.inside).toBe(true);
});

/* ==========================================================================
   Cor do sistema
========================================================================== */

test('escolher uma cor mostra a prévia na hora e salvar grava na conta', async ({ page }) => {
  const state = await installCommonMocks(page, { tires: buildFakeTires(2) });
  const puts = watchSettingsPuts(page);
  await bootIntoApp(page);
  await waitForContentReady(page);
  expect(await accent(page)).toBe(DEFAULT_ACCENT);

  await page.click('#settingsBtn');
  await expect(page.locator('.accent-swatch[aria-label="Vermelho (padrão)"]')).toHaveAttribute('aria-checked', 'true');
  await page.click('.accent-swatch[aria-label="Azul"]');
  await expect(page.locator('.accent-swatch[aria-label="Azul"]')).toHaveAttribute('aria-checked', 'true');
  expect(await accent(page), 'prévia ao vivo antes de salvar').toBe('#1c6dd0');
  expect(puts).toEqual([]);

  await page.click('#saveSettingsBtn');
  await expect(page.locator('#settingsPanel')).toBeHidden();
  expect(puts).toEqual([{ appName: null, logo: null, accentColor: '#1c6dd0' }]);
  expect(state.settings.accentColor).toBe('#1c6dd0');
  expect(await accent(page)).toBe('#1c6dd0');
  // botão principal usa a cor nova de verdade
  const bg = await page.locator('#saveSettingsBtn').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe('rgb(28, 109, 208)');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#1c6dd0');
});

test('cancelar desfaz a prévia da cor', async ({ page }) => {
  await installCommonMocks(page, { tires: buildFakeTires(1), settings: { appName: null, logo: null, accentColor: '#2f9e44' } });
  const puts = watchSettingsPuts(page);
  await bootIntoApp(page);
  await expect.poll(() => accent(page)).toBe('#2f9e44');

  await page.click('#settingsBtn');
  await expect(page.locator('.accent-swatch[aria-label="Verde"]')).toHaveAttribute('aria-checked', 'true');
  await page.click('.accent-swatch[aria-label="Roxo"]');
  expect(await accent(page)).toBe('#7048e8');
  await page.click('#cancelSettingsBtn');

  expect(await accent(page)).toBe('#2f9e44');
  expect(puts).toEqual([]);
});

test('cor livre pelo seletor e volta pro padrão', async ({ page }) => {
  await installCommonMocks(page, { tires: buildFakeTires(1) });
  const puts = watchSettingsPuts(page);
  await bootIntoApp(page);

  await page.click('#settingsBtn');
  await page.locator('#setAccentCustom').evaluate((el) => {
    el.value = '#123456';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#accentCustomHex')).toHaveText('#123456');
  await expect(page.locator('.accent-swatch[aria-checked="true"]')).toHaveCount(0);
  await page.click('#saveSettingsBtn');
  expect(puts[0].accentColor).toBe('#123456');

  await page.click('#settingsBtn');
  await expect(page.locator('#accentCustomHex')).toHaveText('#123456');
  await page.click('.accent-swatch[aria-label="Vermelho (padrão)"]');
  await page.click('#saveSettingsBtn');
  expect(puts[1].accentColor, 'padrão é gravado como null').toBe(null);
  expect(await accent(page)).toBe(DEFAULT_ACCENT);
});

test('cor clara continua legível: texto do botão fica escuro', async ({ page }) => {
  await installCommonMocks(page, { tires: buildFakeTires(1), settings: { appName: null, logo: null, accentColor: '#ffe066' } });
  await bootIntoApp(page);
  await expect.poll(() => accent(page)).toBe('#ffe066');
  const ink = await page.evaluate(() => getComputedStyle(document.getElementById('appScreen')).getPropertyValue('--accent-ink').trim());
  expect(ink.toLowerCase()).toBe('#1e1f22');
  // texto colorido sobre fundo claro é escurecido até passar no contraste
  const text = await page.evaluate(() => getComputedStyle(document.getElementById('appScreen')).getPropertyValue('--accent-text').trim());
  expect(text.toLowerCase()).not.toBe('#ffe066');
});

test('cabeçalho do PDF usa a cor do sistema da conta', async ({ page }) => {
  await installCommonMocks(page, { tires: buildFakeTires(3), settings: { appName: null, logo: null, accentColor: '#2f9e44' } });
  await bootIntoApp(page);
  await waitForContentReady(page);
  await expect.poll(() => accent(page)).toBe('#2f9e44');

  const fill = await page.evaluate(() => {
    let capturado = null;
    const original = window.PdfTable.renderReport;
    window.PdfTable.renderReport = (doc, opts) => {
      capturado = opts.headerFill;
      return original(doc, opts);
    };
    document.querySelector('.tabbar .tab[data-tab="exportar"]').click();
    document.getElementById('exportFormatSelect').value = 'pdf';
    document.getElementById('exportBtn').click();
    return new Promise((r) => setTimeout(r, 300)).then(() => {
      window.PdfTable.renderReport = original;
      return capturado;
    });
  });
  expect(fill).toEqual([47, 158, 68]);
});

test('cache adulterado com cor maliciosa é ignorado', async ({ page }) => {
  await installCommonMocks(page, { tires: buildFakeTires(1), settings: { appName: null, logo: null, accentColor: 'red;background:url(x)' } });
  await bootIntoApp(page);
  await waitForContentReady(page);
  expect(await accent(page)).toBe(DEFAULT_ACCENT);
});

test('nome em branco volta pro padrão', async ({ page }) => {
  await installCommonMocks(page, { tires: buildFakeTires(1), settings: { appName: 'Loja Antiga', logo: null } });
  const puts = watchSettingsPuts(page);
  await bootIntoApp(page);
  await expect(page.locator('#brandTitle')).toHaveText('Loja Antiga');

  await page.click('#settingsBtn');
  await page.fill('#setAppName', '   ');
  await page.click('#saveSettingsBtn');

  await expect(page.locator('#brandTitle')).toHaveText('Estoque de Pneus');
  expect(puts[0].appName).toBe(null);
});

test('a logo escolhida vira um quadrado de 256x256 e entra no lugar da padrão', async ({ page }) => {
  await installCommonMocks(page, { tires: buildFakeTires(2) });
  const puts = watchSettingsPuts(page);
  await bootIntoApp(page);
  await waitForContentReady(page);

  await page.click('#settingsBtn');
  await expect(page.locator('#settingsCrop')).toBeHidden();
  await page.setInputFiles('#setLogoInput', LOGO_FIXTURE);
  await expect(page.locator('#settingsCrop')).toBeVisible();
  await page.click('#saveSettingsBtn');

  await expect(page.locator('#settingsPanel')).toBeHidden();
  expect(puts).toHaveLength(1);
  const logo = puts[0].logo;
  expect(logo).toMatch(/^data:image\/(png|webp|jpeg);base64,/);

  // Recortada num quadrado, mesmo vindo de uma imagem 640x480.
  const tamanho = await page.evaluate(
    (url) =>
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve([img.naturalWidth, img.naturalHeight]);
        img.src = url;
      }),
    logo
  );
  expect(tamanho).toEqual([256, 256]);

  await expect(page.locator('#appScreen')).toHaveClass(/has-custom-logo/);
  const marca = await page
    .locator('.app-sidebar .brand-mark')
    .evaluate((el) => ({ bg: getComputedStyle(el).backgroundImage, w: el.getBoundingClientRect().width }));
  expect(marca.bg).toContain('data:image/');
  // Mesmo tamanho da logo padrão — 42px no cabeçalho empilhado, 38px na sidebar.
  expect([38, 42]).toContain(Math.round(marca.w));

  // e o ícone da aba do navegador também vira a logo
  await expect(page.locator('#favicon')).toHaveAttribute('href', logo);
});

test('"Usar logo padrão" tira a logo da conta', async ({ page }) => {
  await installCommonMocks(page, { tires: buildFakeTires(1), settings: { appName: 'Loja A', logo: TINY_PNG } });
  const puts = watchSettingsPuts(page);
  await bootIntoApp(page);
  await expect(page.locator('#appScreen')).toHaveClass(/has-custom-logo/);
  await expect(page.locator('#favicon')).toHaveAttribute('href', TINY_PNG);

  await page.click('#settingsBtn');
  await page.click('#setLogoResetBtn');
  await page.click('#saveSettingsBtn');

  await expect(page.locator('#appScreen')).not.toHaveClass(/has-custom-logo/);
  await expect(page.locator('#favicon')).toHaveAttribute('href', 'icons/icon-192.png');
  expect(puts[0].logo).toBe(null);
  expect(puts[0].appName).toBe('Loja A');
});

test('cancelar não grava nada nem mexe no cabeçalho', async ({ page }) => {
  await installCommonMocks(page, { tires: buildFakeTires(1), settings: { appName: 'Loja A', logo: null } });
  const puts = watchSettingsPuts(page);
  await bootIntoApp(page);

  await page.click('#settingsBtn');
  await page.fill('#setAppName', 'Nome Descartado');
  await page.setInputFiles('#setLogoInput', LOGO_FIXTURE);
  await page.click('#cancelSettingsBtn');

  await expect(page.locator('#settingsPanel')).toBeHidden();
  await expect(page.locator('#brandTitle')).toHaveText('Loja A');
  await expect(page.locator('#appScreen')).not.toHaveClass(/has-custom-logo/);
  expect(puts).toEqual([]);

  // Reabrir começa limpo, sem a imagem descartada pendurada.
  await page.click('#settingsBtn');
  await expect(page.locator('#setAppName')).toHaveValue('Loja A');
  await expect(page.locator('#settingsCrop')).toBeHidden();
});

test('a logo vale também pros .brand-mark que o render cria depois', async ({ page }) => {
  // Estoque vazio: o .brand-mark do estado vazio nasce por innerHTML, muito
  // depois do branding ser aplicado.
  await installCommonMocks(page, { tires: [], settings: { appName: null, logo: TINY_PNG } });
  await bootIntoApp(page);
  await waitForContentReady(page);

  const bg = await page.locator('.empty .brand-mark').evaluate((el) => getComputedStyle(el).backgroundImage);
  expect(bg).toContain('data:image/png');
});

test('o nome da conta vai pro título do relatório em PDF', async ({ page }) => {
  await installCommonMocks(page, { tires: buildFakeTires(3), settings: { appName: 'Pneus do Arthur', logo: null } });
  await bootIntoApp(page);
  await waitForContentReady(page);

  const titulo = await page.evaluate(() => {
    let capturado = null;
    const original = window.PdfTable.renderReport;
    window.PdfTable.renderReport = (doc, opts) => {
      capturado = opts.title;
      return original(doc, opts);
    };
    return Promise.resolve()
      .then(() => {
        document.querySelector('.tabbar .tab[data-tab="exportar"]').click();
        document.getElementById('exportFormatSelect').value = 'pdf';
        return document.getElementById('exportBtn').click();
      })
      .then(() => new Promise((r) => setTimeout(r, 300)))
      .then(() => {
        window.PdfTable.renderReport = original;
        return capturado;
      });
  });
  expect(titulo).toBe('Pneus do Arthur');
});

/* ==========================================================================
   Isolamento entre contas — o requisito central da tela
========================================================================== */

/** GoTrue falso: login com e-mail/senha e logout, pro fluxo real do auth.js. */
async function fakeGoTrue(page, user) {
  await page.route('**/auth/v1/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/logout')) return route.fulfill({ status: 204, body: '' });
    if (url.pathname.endsWith('/token')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: 'at-' + user.id,
          refresh_token: 'rt-' + user.id,
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user,
        }),
      });
    }
    return route.fulfill({ status: 401, contentType: 'application/json', body: '{"msg":"não mockado"}' });
  });
}

/**
 * /api/settings servindo uma personalização por conta, escolhida pelo token
 * do Authorization — é assim que o RLS se comporta no backend de verdade.
 * O PUT grava no mapa, como a tabela faria.
 */
async function settingsPorConta(page, porToken) {
  await page.route('**/api/settings**', (route) => {
    const req = route.request();
    const token = (req.headers()['authorization'] || '').replace('Bearer ', '');
    if (req.method() === 'PUT') {
      const body = req.postDataJSON();
      porToken[token] = { appName: body.appName || null, logo: body.logo || null };
    }
    const conta = porToken[token] || { appName: null, logo: null };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(conta) });
  });
}

async function entrar(page, user) {
  await page.fill('#loginEmail', user.email);
  await page.fill('#loginPassword', 'segredo123');
  await page.click('#loginForm button[type="submit"]');
  await expect(page.locator('#appScreen')).toBeVisible();
  await expect(page.locator('#userEmail')).toHaveText(user.email);
}

test('trocar de conta na mesma aba troca a marca junto — nunca a da conta anterior', async ({ page }) => {
  await installCommonMocks(page, { tires: buildFakeTires(2) });
  await settingsPorConta(page, {
    ['at-' + USER_A.id]: { appName: 'Loja do A', logo: TINY_PNG, accentColor: '#1c6dd0' },
    ['at-' + USER_B.id]: { appName: 'Loja do B', logo: null },
  });

  await fakeGoTrue(page, USER_A);
  await page.goto('/index.html');
  await entrar(page, USER_A);
  await expect(page.locator('#brandTitle')).toHaveText('Loja do A');
  await expect(page.locator('#appScreen')).toHaveClass(/has-custom-logo/);
  expect(await accent(page)).toBe('#1c6dd0');

  await page.click('#logoutBtn');
  await expect(page.locator('#authScreen')).toBeVisible();
  expect(await accent(page), 'login volta pra cor padrão').toBe(DEFAULT_ACCENT);
  // A tela de login é sempre padrão: nada da conta que acabou de sair.
  await expect(page.locator('#authScreen h1')).toHaveText('Estoque de Pneus');
  await expect(page.locator('#appScreen')).not.toHaveClass(/has-custom-logo/);

  await fakeGoTrue(page, USER_B);
  await entrar(page, USER_B);
  await expect(page.locator('#brandTitle')).toHaveText('Loja do B');
  await expect(page.locator('#appScreen')).not.toHaveClass(/has-custom-logo/, {
    // B não tem logo: não pode herdar a de A.
  });
  await expect(page).toHaveTitle('Loja do B');
  expect(await accent(page), 'B não herda a cor de A').toBe(DEFAULT_ACCENT);
});

test('o cache local é por conta: offline, cada uma vê a sua (ou o padrão)', async ({ page }) => {
  await installCommonMocks(page, { tires: buildFakeTires(1) });
  // API de configurações fora do ar: só o cache local pode responder.
  await page.route('**/api/settings**', (route) => route.abort('connectionrefused'));
  await page.addInitScript(
    ([chaveA, valorA]) => localStorage.setItem(chaveA, valorA),
    ['estoque_branding_' + USER_A.id, JSON.stringify({ appName: 'Loja do A', logo: null })]
  );

  await fakeGoTrue(page, USER_A);
  await page.goto('/index.html');
  await entrar(page, USER_A);
  await expect(page.locator('#brandTitle')).toHaveText('Loja do A');

  await page.click('#logoutBtn');
  await expect(page.locator('#authScreen')).toBeVisible();

  await fakeGoTrue(page, USER_B);
  await entrar(page, USER_B);
  // B não tem cache próprio — cai no padrão, jamais no de A.
  await expect(page.locator('#brandTitle')).toHaveText('Estoque de Pneus');
});

test('o cache guardado é o da conta logada, com a chave dela', async ({ page }) => {
  await installCommonMocks(page, { tires: buildFakeTires(1) });
  await settingsPorConta(page, { ['at-' + USER_A.id]: { appName: null, logo: null } });
  await fakeGoTrue(page, USER_A);
  await page.goto('/index.html');
  await entrar(page, USER_A);

  await page.click('#settingsBtn');
  await page.fill('#setAppName', 'Loja do A');
  await page.click('#saveSettingsBtn');
  await expect(page.locator('#brandTitle')).toHaveText('Loja do A');

  const chaves = await page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith('estoque_branding_'))
  );
  expect(chaves).toEqual(['estoque_branding_' + USER_A.id]);
});

test('cache adulterado com url() maliciosa é ignorado', async ({ page }) => {
  await installCommonMocks(page, { tires: buildFakeTires(1) });
  await page.route('**/api/settings**', (route) => route.abort('connectionrefused'));
  await page.addInitScript(
    ([chave, valor]) => localStorage.setItem(chave, valor),
    [
      'estoque_branding_' + USER_A.id,
      JSON.stringify({ appName: 'Loja do A', logo: 'x"); background:url(https://exemplo.invalid/x.png' }),
    ]
  );

  await fakeGoTrue(page, USER_A);
  await page.goto('/index.html');
  await entrar(page, USER_A);

  await expect(page.locator('#brandTitle')).toHaveText('Loja do A');
  await expect(page.locator('#appScreen')).not.toHaveClass(/has-custom-logo/);
  const bg = await page.locator('.app-sidebar .brand-mark').evaluate((el) => getComputedStyle(el).backgroundImage);
  expect(bg).toBe('none');
});
