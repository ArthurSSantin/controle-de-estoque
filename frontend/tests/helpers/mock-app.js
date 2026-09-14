// Utilitários compartilhados por todos os testes: simulam o Supabase (auth)
// e a API (backend) via interceptação de rede do Playwright, já que os
// testes não têm (e não devem precisar de) acesso ao Supabase/backend reais.
// Gerar dados fictícios aqui, nunca aponte um teste pra API de produção.

const SUPABASE_STUB = `
window.supabase = {
  createClient: function () {
    return {
      auth: {
        getSession: async function () { return { data: { session: null } }; },
        onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function(){} } } }; },
        signInWithPassword: async function () { return { error: null }; },
        signUp: async function () { return { error: null }; },
        signOut: async function () { return {}; },
      },
    };
  },
};
`;

let nextFakeId = 1000;

/** Gera N pneus fictícios com marca/medida ÚNICAS por construção (sem
 * colisão acidental de chave de duplicata) — use `withDuplicates` pra
 * injetar de propósito grupos que o app deve reconhecer como duplicados. */
function buildFakeTires(n, { withDuplicates = 0, lowStockEvery = 0 } = {}) {
  const tires = [];
  for (let i = 0; i < n; i++) {
    tires.push({
      id: 'id-' + i,
      marca: `Marca Exclusiva ${i}`,
      medida: `${100 + (i % 200)}/60 R${13 + (i % 8)}`,
      quantidade: lowStockEvery && i % lowStockEvery === 0 ? 1 : (i % 20) + 1,
      preco: (200 + (i % 50) * 7) + ',00',
      condicao: i % 2 === 0 ? 'novo' : 'usado',
      novo: i < 3, // primeiros 3 marcados como "recente", pra testar a tag
      notaRef: null,
      origem: 'local',
      fornecedor: i % 3 === 0 ? 'Distribuidora ABC' : null,
      codigoBarras: i % 4 === 0 ? `78912345${String(i).padStart(4, '0')}` : null,
      addedAt: Date.now() - i * 3600000,
    });
  }
  for (let g = 0; g < withDuplicates; g++) {
    const base = tires[g];
    tires.push({ ...base, id: 'dup-' + g, quantidade: 3, addedAt: base.addedAt - 1000 });
  }
  return tires;
}

/**
 * Instala os mocks de rede comuns a praticamente todo teste:
 *  - supabase-js (CDN) -> stub sem sessão
 *  - Google Fonts -> aborta (sem custo, sem depender de rede externa)
 *  - GET/POST/PUT/DELETE /api/tires -> serve `state.tires` em memória
 *  - GET /api/history -> lista vazia por padrão
 *
 * `state.tires` é um array mutável — os testes podem inspecioná-lo/alterá-lo
 * depois de ações na UI pra conferir o que "chegaria" no backend real.
 * `opts.writeLatencyMs` simula round-trip de um backend hospedado longe
 * (Render + Supabase) — use pra testes de performance.
 * `opts.onRequest(method, url)` é chamado a cada chamada de API, útil pra
 * contar quantas requisições um fluxo disparou.
 */
async function installCommonMocks(page, {
  tires = [],
  writeLatencyMs = 0,   // atraso pra TODAS as chamadas (simula API/backend lento em geral)
  mutationLatencyMs = 0, // atraso só pra POST/PUT/DELETE (isola a latência só das escritas)
  apiFail = false,
  onRequest,
} = {}) {
  const state = { tires, history: [] };

  await page.route('**/supabase-js@2**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: SUPABASE_STUB })
  );
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
  await page.route('https://fonts.gstatic.com/**', (route) => route.abort());

  // Um único handler pra tudo debaixo de /api/tires — evita a armadilha
  // clássica de vários page.route() com globs que se sobrepõem (a ordem de
  // resolução do Playwright é a inversa do registro, e é fácil um padrão
  // "vazar" pra outro por engano). Decide o roteamento pelo path exato.
  await page.route('**/api/tires**', async (route) => {
    const req = route.request();
    const method = req.method();
    const url = new URL(req.url());
    const segments = url.pathname.split('/').filter(Boolean); // ['api','tires', ...]
    const tail = segments.slice(segments.indexOf('tires') + 1); // [] | ['bulk'] | [':id']

    if (onRequest) onRequest(method, req.url());
    if (apiFail) return route.abort('connectionrefused');
    if (writeLatencyMs) await new Promise((r) => setTimeout(r, writeLatencyMs));
    if (mutationLatencyMs && method !== 'GET') await new Promise((r) => setTimeout(r, mutationLatencyMs));

    // GET /api/tires — lista paginada
    if (method === 'GET' && tail.length === 0) {
      const offset = Number(url.searchParams.get('offset')) || 0;
      const limit = Number(url.searchParams.get('limit')) || 200;
      const items = state.tires.slice(offset, offset + limit);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items, total: state.tires.length, offset, limit }),
      });
    }

    // POST /api/tires — cria um item
    if (method === 'POST' && tail.length === 0) {
      const body = req.postDataJSON();
      const created = { id: 'new-' + nextFakeId++, novo: true, notaRef: null, ...body, codigoBarras: body.codigoBarras || null };
      state.tires.push(created);
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(created) });
    }

    // POST /api/tires/bulk — cria vários (XML/planilha/sincronização)
    if (method === 'POST' && tail[0] === 'bulk') {
      const body = req.postDataJSON();
      const created = body.items.map((item) => ({ id: 'new-' + nextFakeId++, novo: true, notaRef: null, ...item, codigoBarras: item.codigoBarras || null }));
      state.tires.push(...created);
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(created) });
    }

    // PUT /api/tires/:id — atualiza
    if (method === 'PUT' && tail.length === 1) {
      const id = tail[0];
      const body = req.postDataJSON();
      const idx = state.tires.findIndex((t) => t.id === id);
      const updated = { ...(state.tires[idx] || {}), id, ...body, codigoBarras: body.codigoBarras || null };
      if (idx >= 0) state.tires[idx] = updated;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(updated) });
    }

    // DELETE /api/tires/:id — remove
    if (method === 'DELETE' && tail.length === 1) {
      state.tires = state.tires.filter((t) => t.id !== tail[0]);
      return route.fulfill({ status: 204, body: '' });
    }

    return route.continue();
  });

  await page.route('**/api/history**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state.history) })
  );

  return state;
}

/** Pula a tela de login (auth.js real nunca chega a autenticar contra um
 * Supabase de verdade nos testes) e entra direto no app, chamando o mesmo
 * `window.__bootApp` que auth.js chamaria depois de um login real. */
async function bootIntoApp(page) {
  await page.goto('/index.html');
  await page.evaluate(() => {
    document.getElementById('bootLoading').style.display = 'none';
    document.getElementById('authScreen').style.display = 'none';
    document.getElementById('appScreen').style.display = 'block';
    document.getElementById('userEmail').textContent = 'demo@estoque.com';
    window.__bootApp();
  });
}

/** Espera o placeholder "Carregando estoque..." sumir e o conteúdo real
 * (lista de pneus OU estado vazio) aparecer. */
async function waitForContentReady(page, timeout = 10000) {
  await page.waitForFunction(
    () => {
      const el = document.getElementById('content');
      return el && !el.querySelector('.loading');
    },
    { timeout }
  );
}

/**
 * Desliga o Service Worker pra essa página. Use em testes que simulam
 * falha de rede num arquivo estático (ex: uma lib vendorizada) — o SW
 * cacheia a casca do app (ver frontend/sw.js) e serviria a resposta do
 * cache em vez de deixar sua simulação de falha/retry acontecer de verdade.
 * Precisa ser chamado ANTES de `bootIntoApp`/`page.goto`.
 */
async function disableServiceWorker(page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serviceWorker', { value: undefined });
  });
}

module.exports = { buildFakeTires, installCommonMocks, bootIntoApp, waitForContentReady, disableServiceWorker };
