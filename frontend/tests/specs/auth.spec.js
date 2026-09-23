// Cliente de autenticação próprio (frontend/auth-client.js) contra um
// Supabase Auth (GoTrue) falso: login, cadastro, logout, refresh de token,
// sessão herdada do supabase-js e sessão vinda do link de confirmação.
const { test, expect } = require('@playwright/test');
const { buildFakeTires, installCommonMocks, disableServiceWorker } = require('../helpers/mock-app');

const STORAGE_KEY = 'sb-oytoeuoehoqdkhnhuuyy-auth-token';
const USER = { id: 'user-1', email: 'loja@exemplo.com' };

function sessionBody(access, refresh, { expiresIn = 3600, now = Date.now() } = {}) {
  return {
    access_token: access,
    refresh_token: refresh,
    token_type: 'bearer',
    expires_in: expiresIn,
    expires_at: Math.floor(now / 1000) + expiresIn,
    user: USER,
  };
}

// Registra um GoTrue falso; cada handler recebe { body, headers, url } e
// devolve { status, json } ou 'abort' (simula queda de rede).
async function fakeGoTrue(page, handlers) {
  const calls = [];
  await page.route('**/auth/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    const headers = await req.allHeaders();
    let key = url.pathname.replace(/^.*\/auth\/v1\//, '');
    if (key === 'token') key = `token:${url.searchParams.get('grant_type')}`;
    calls.push({ key, body, headers, url });
    const handler = handlers[key];
    if (!handler) return route.fulfill({ status: 500, body: `sem handler pra ${key}` });
    const out = await handler({ body, headers, url });
    if (out === 'abort') return route.abort('internetdisconnected');
    return route.fulfill({ status: out.status || 200, contentType: 'application/json', body: out.json ? JSON.stringify(out.json) : '' });
  });
  return calls;
}

async function seedSession(page, session) {
  await page.addInitScript(([key, value]) => {
    if (!sessionStorage.getItem('__seeded')) {
      localStorage.setItem(key, value);
      sessionStorage.setItem('__seeded', '1');
    }
  }, [STORAGE_KEY, JSON.stringify(session)]);
}

async function storedSession(page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) || 'null'), STORAGE_KEY);
}

test.beforeEach(async ({ page }) => {
  await disableServiceWorker(page);
  await installCommonMocks(page, { tires: buildFakeTires(2) });
});

test('login abre o app, guarda a sessão e manda o token pra API', async ({ page }) => {
  const calls = await fakeGoTrue(page, {
    'token:password': () => ({ json: sessionBody('at-1', 'rt-1') }),
  });
  const apiAuth = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/tires')) apiAuth.push(r.headers().authorization);
  });

  await page.goto('/index.html');
  await expect(page.locator('#authScreen')).toBeVisible();
  await page.fill('#loginEmail', USER.email);
  await page.fill('#loginPassword', 'segredo123');
  await page.click('#loginForm button[type="submit"]');

  await expect(page.locator('#appScreen')).toBeVisible();
  await expect(page.locator('#userEmail')).toHaveText(USER.email);
  expect((await storedSession(page)).access_token).toBe('at-1');
  expect(await page.evaluate(() => window.getAccessToken())).toBe('at-1');
  await expect.poll(() => apiAuth.length).toBeGreaterThan(0);
  expect(apiAuth[0]).toBe('Bearer at-1');

  const login = calls.find((c) => c.key === 'token:password');
  expect(login.body).toEqual({ email: USER.email, password: 'segredo123' });
  const anonKey = await page.evaluate(() => window.APP_CONFIG.supabaseAnonKey);
  expect(login.headers.apikey).toBe(anonKey);
  expect(login.headers.authorization, 'chave publishable não é JWT: não vai no Authorization').toBeUndefined();
});

test('senha errada mostra mensagem e não guarda sessão', async ({ page }) => {
  await fakeGoTrue(page, {
    'token:password': () => ({ status: 400, json: { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' } }),
  });
  await page.goto('/index.html');
  await page.fill('#loginEmail', USER.email);
  await page.fill('#loginPassword', 'errada');
  await page.click('#loginForm button[type="submit"]');
  await expect(page.locator('#loginErr')).toHaveText('E-mail ou senha incorretos.');
  expect(await storedSession(page)).toBeNull();
});

test('muitas tentativas (429) mostra aviso de espera', async ({ page }) => {
  await fakeGoTrue(page, {
    'token:password': () => ({ status: 429, json: { code: 429, msg: 'Request rate limit reached' } }),
  });
  await page.goto('/index.html');
  await page.fill('#loginEmail', USER.email);
  await page.fill('#loginPassword', 'x');
  await page.click('#loginForm button[type="submit"]');
  await expect(page.locator('#loginErr')).toContainText('Muitas tentativas');
});

test('sessão salva pelo supabase-js antigo continua valendo (ninguém é deslogado)', async ({ page }) => {
  const calls = await fakeGoTrue(page, {});
  await seedSession(page, sessionBody('at-antigo', 'rt-antigo'));
  await page.goto('/index.html');
  await expect(page.locator('#appScreen')).toBeVisible();
  await expect(page.locator('#userEmail')).toHaveText(USER.email);
  expect(calls, 'sessão válida não precisa de rede').toEqual([]);
});

test('sessão vencida é renovada ao abrir o app', async ({ page }) => {
  const calls = await fakeGoTrue(page, {
    'token:refresh_token': ({ body }) => ({ json: sessionBody('at-novo', body.refresh_token === 'rt-velho' ? 'rt-novo' : 'x') }),
  });
  await seedSession(page, sessionBody('at-velho', 'rt-velho', { expiresIn: 3600, now: Date.now() - 2 * 3600 * 1000 }));
  await page.goto('/index.html');
  await expect(page.locator('#appScreen')).toBeVisible();
  expect(await page.evaluate(() => window.getAccessToken())).toBe('at-novo');
  expect((await storedSession(page)).refresh_token).toBe('rt-novo');
  expect(calls.filter((c) => c.key === 'token:refresh_token')).toHaveLength(1);
});

test('refresh token inválido desloga e limpa a sessão', async ({ page }) => {
  await fakeGoTrue(page, {
    'token:refresh_token': () => ({ status: 400, json: { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' } }),
  });
  await seedSession(page, sessionBody('at-velho', 'rt-revogado', { now: Date.now() - 2 * 3600 * 1000 }));
  await page.goto('/index.html');
  await expect(page.locator('#authScreen')).toBeVisible();
  expect(await storedSession(page)).toBeNull();
});

test('sem internet na hora do refresh, mantém a sessão (modo offline)', async ({ page }) => {
  await fakeGoTrue(page, { 'token:refresh_token': () => 'abort' });
  await seedSession(page, sessionBody('at-velho', 'rt-velho', { now: Date.now() - 2 * 3600 * 1000 }));
  await page.goto('/index.html');
  await expect(page.locator('#appScreen')).toBeVisible();
  expect((await storedSession(page)).refresh_token).toBe('rt-velho');
});

test('token é renovado sozinho antes de expirar', async ({ page }) => {
  const start = new Date('2026-09-23T10:00:00Z');
  await page.clock.install({ time: start });
  const calls = await fakeGoTrue(page, {
    'token:refresh_token': () => ({ json: sessionBody('at-renovado', 'rt-renovado', { now: start.getTime() + 61000 }) }),
  });
  await seedSession(page, sessionBody('at-curto', 'rt-curto', { expiresIn: 120, now: start.getTime() }));
  await page.goto('/index.html');
  await expect(page.locator('#appScreen')).toBeVisible();
  expect(calls).toHaveLength(0);

  await page.clock.fastForward(61000);
  await expect.poll(() => calls.filter((c) => c.key === 'token:refresh_token').length).toBe(1);
  await expect.poll(async () => (await storedSession(page)).access_token).toBe('at-renovado');
});

test('sair encerra a sessão no servidor e volta pro login', async ({ page }) => {
  const calls = await fakeGoTrue(page, { logout: () => ({ status: 204 }) });
  await seedSession(page, sessionBody('at-1', 'rt-1'));
  await page.goto('/index.html');
  await expect(page.locator('#appScreen')).toBeVisible();

  await page.click('#logoutBtn');
  await expect(page.locator('#authScreen')).toBeVisible();
  expect(await storedSession(page)).toBeNull();
  await expect.poll(() => calls.filter((c) => c.key === 'logout').length).toBe(1);
  expect(calls.find((c) => c.key === 'logout').headers.authorization).toBe('Bearer at-1');
});

test('cadastro com confirmação por e-mail avisa pra checar o e-mail', async ({ page }) => {
  const calls = await fakeGoTrue(page, {
    signup: () => ({ json: { id: 'novo', email: 'nova@loja.com', confirmation_sent_at: '2026-09-23T10:00:00Z' } }),
  });
  await page.goto('/index.html');
  await page.click('#showSignup');
  await page.fill('#signupEmail', 'nova@loja.com');
  await page.fill('#signupPassword', 'senha-forte');
  await page.click('#signupForm button[type="submit"]');
  await expect(page.locator('#signupErr')).toContainText('Verifique seu e-mail');
  expect(calls[0].body).toEqual({ email: 'nova@loja.com', password: 'senha-forte' });
  expect(await storedSession(page)).toBeNull();
});

test('cadastro com e-mail já usado mostra mensagem certa', async ({ page }) => {
  await fakeGoTrue(page, {
    signup: () => ({ status: 422, json: { code: 422, error_code: 'user_already_exists', msg: 'User already registered' } }),
  });
  await page.goto('/index.html');
  await page.click('#showSignup');
  await page.fill('#signupEmail', USER.email);
  await page.fill('#signupPassword', 'senha-forte');
  await page.click('#signupForm button[type="submit"]');
  await expect(page.locator('#signupErr')).toHaveText('Este e-mail já tem uma conta. Faça login.');
});

test('link de confirmação de e-mail entra direto e limpa o token da URL', async ({ page }) => {
  const calls = await fakeGoTrue(page, {
    user: ({ headers }) => (headers.authorization === 'Bearer at-link' ? { json: USER } : { status: 401, json: { msg: 'invalid JWT' } }),
  });
  await page.goto('/index.html#access_token=at-link&refresh_token=rt-link&expires_in=3600&token_type=bearer&type=signup');
  await expect(page.locator('#appScreen')).toBeVisible();
  await expect(page.locator('#userEmail')).toHaveText(USER.email);
  expect(page.url()).not.toContain('access_token');
  expect((await storedSession(page)).refresh_token).toBe('rt-link');
  expect(calls.map((c) => c.key)).toEqual(['user']);
});
