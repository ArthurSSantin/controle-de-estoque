// Testes da edge function (supabase/functions/api/index.ts) rodando no Node,
// contra um Supabase falso em memória. Rodar com:
//   node --experimental-strip-types --test supabase/tests/

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSupabase } from './fake-supabase.mjs';

const SUPABASE_URL = 'https://fake-projeto.supabase.co';
const ANON = 'anon-key-teste';
const ORIGIN = 'https://estoque.exemplo.com';
const USERS = {
  'token-a': { id: '11111111-1111-4111-8111-111111111111', email: 'a@loja.com' },
  'token-b': { id: '22222222-2222-4222-8222-222222222222', email: 'b@loja.com' },
};

const ENV = { SUPABASE_URL, SUPABASE_ANON_KEY: ANON, ALLOWED_ORIGIN: ORIGIN };
globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: () => {} };
const { handleRequest } = await import('../functions/api/index.ts');

let fake;
beforeEach(() => {
  fake = createFakeSupabase({ url: SUPABASE_URL, anonKey: ANON, users: USERS });
  globalThis.fetch = fake.fetch;
});

async function call(method, path, { token = 'token-a', body, origin = ORIGIN, rawBody } = {}) {
  const headers = { Origin: origin };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined || rawBody !== undefined) headers['Content-Type'] = 'application/json';
  const res = await handleRequest(new Request(`https://fake-projeto.supabase.co${path}`, {
    method,
    headers,
    body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
  }));
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}

const TIRE = { marca: 'Pirelli P1', medida: '185/65 R14', quantidade: 4, preco: '350,00', condicao: 'novo' };

test('preflight CORS: origem liberada recebe headers, outra não', async () => {
  const ok = await handleRequest(new Request('https://x/api/tires', { method: 'OPTIONS', headers: { Origin: ORIGIN } }));
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.match(ok.headers.get('Access-Control-Allow-Methods'), /PUT/);
  assert.match(ok.headers.get('Access-Control-Allow-Headers'), /Authorization/);

  const bad = await handleRequest(new Request('https://x/api/tires', { method: 'OPTIONS', headers: { Origin: 'https://exemplo.invalid' } }));
  assert.equal(bad.status, 204);
  assert.equal(bad.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(fake.calls.length, 0, 'preflight não pode bater no Supabase');
});

test('sem token → 401; token inválido → 401; Auth fora do ar → 503', async () => {
  assert.equal((await call('GET', '/api/tires', { token: null })).status, 401);
  assert.equal((await call('GET', '/api/tires', { token: 'forjado' })).status, 401);
  fake.state.authDown = true;
  const r = await call('GET', '/api/tires');
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN, 'erro também precisa de CORS');
});

test('rota fora de /api e rota desconhecida → 404', async () => {
  assert.equal((await call('GET', '/outra/coisa')).status, 404);
  assert.equal((await call('GET', '/api/nada')).status, 404);
});

test('criar pneu: 201 em camelCase + histórico "criado"', async () => {
  const r = await call('POST', '/api/tires', { body: { ...TIRE, codigoBarras: '7891234567895', fornecedor: 'Distribuidora ABC' } });
  assert.equal(r.status, 201);
  assert.equal(r.json.marca, 'Pirelli P1');
  assert.equal(r.json.codigoBarras, '7891234567895');
  assert.equal(r.json.fornecedor, 'Distribuidora ABC');
  assert.equal(typeof r.json.addedAt, 'number');
  assert.equal(fake.rows.tires[0].owner_id, USERS['token-a'].id);
  assert.equal(fake.rows.tire_history.length, 1);
  assert.equal(fake.rows.tire_history[0].acao, 'criado');
  assert.equal(fake.rows.tire_history[0].valor_novo, '4');
});

test('validação: medida sem aro, quantidade negativa, JSON quebrado → 400', async () => {
  let r = await call('POST', '/api/tires', { body: { ...TIRE, medida: '185/65' } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Medida inválida/);
  r = await call('POST', '/api/tires', { body: { ...TIRE, quantidade: -1 } });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/tires', { rawBody: '{quebrado' });
  assert.equal(r.status, 400);
  assert.equal(fake.rows.tires.length, 0);
});

test('código de barras duplicado → 409 com mensagem amigável', async () => {
  await call('POST', '/api/tires', { body: { ...TIRE, codigoBarras: 'ABC' } });
  const r = await call('POST', '/api/tires', { body: { ...TIRE, marca: 'Outro', codigoBarras: 'ABC' } });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /código de barras já está cadastrado/);
});

test('bulk: cria N + N entradas de histórico; valida limite e item ruim', async () => {
  const items = [TIRE, { ...TIRE, marca: 'Michelin' }, { ...TIRE, marca: 'Goodyear', medida: '205/55 R16' }];
  const r = await call('POST', '/api/tires/bulk', { body: { items } });
  assert.equal(r.status, 201);
  assert.equal(r.json.length, 3);
  assert.equal(fake.rows.tire_history.length, 3);

  const tooMany = await call('POST', '/api/tires/bulk', { body: { items: Array(301).fill(TIRE) } });
  assert.equal(tooMany.status, 400);
  const badItem = await call('POST', '/api/tires/bulk', { body: { items: [TIRE, { marca: 'X', medida: 'sem aro', quantidade: 1 }] } });
  assert.equal(badItem.status, 400);
  assert.match(badItem.json.error, /Item inválido \(X\)/);
  const empty = await call('POST', '/api/tires/bulk', { body: {} });
  assert.equal(empty.status, 400);
});

test('listar: paginação com total via Content-Range', async () => {
  for (let i = 0; i < 5; i++) await call('POST', '/api/tires', { body: { ...TIRE, marca: `Marca ${i}` } });
  const r = await call('GET', '/api/tires?limit=2&offset=2');
  assert.equal(r.status, 200);
  assert.equal(r.json.total, 5);
  assert.deepEqual(r.json.items.map((t) => t.marca), ['Marca 2', 'Marca 3']);
  assert.equal(r.json.limit, 2);
  assert.equal(r.json.offset, 2);

  const empty = await call('GET', '/api/tires?offset=50');
  assert.equal(empty.json.total, 5);
  assert.equal(empty.json.items.length, 0);
});

test('editar: histórico de entrada + edição de preço; 404 pra id inexistente/inválido', async () => {
  const { json: created } = await call('POST', '/api/tires', { body: TIRE });
  const r = await call('PUT', `/api/tires/${created.id}`, { body: { ...TIRE, quantidade: 6, preco: '360,00' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.quantidade, 6);
  const acoes = fake.rows.tire_history.map((h) => `${h.acao}:${h.campo}`);
  assert.deepEqual(acoes, ['criado:null', 'entrada:quantidade', 'editado:preco']);

  assert.equal((await call('PUT', '/api/tires/00000000-0000-4000-8000-000000000000', { body: TIRE })).status, 404);
  assert.equal((await call('PUT', '/api/tires/nao-e-uuid', { body: TIRE })).status, 404);
  assert.equal((await call('PUT', '/api/tires/x%26owner_id%3Deq.1', { body: TIRE })).status, 404);
});

test('conferência: grava status/data sem gerar histórico; status inválido → 400', async () => {
  const { json: created } = await call('POST', '/api/tires', { body: TIRE });
  const r = await call('PUT', `/api/tires/${created.id}/conferencia`, { body: { status: 'presente' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.conferidoStatus, 'presente');
  assert.equal(typeof r.json.conferidoEm, 'number');
  assert.equal(fake.rows.tire_history.length, 1, 'só o "criado"');
  assert.equal((await call('PUT', `/api/tires/${created.id}/conferencia`, { body: { status: 'talvez' } })).status, 400);
});

test('excluir: 204, some do banco, histórico "excluido"', async () => {
  const { json: created } = await call('POST', '/api/tires', { body: TIRE });
  const r = await call('DELETE', `/api/tires/${created.id}`);
  assert.equal(r.status, 204);
  assert.equal(fake.rows.tires.length, 0);
  assert.equal(fake.rows.tire_history.at(-1).acao, 'excluido');
  assert.equal(fake.rows.tire_history.at(-1).valor_anterior, '4');
});

test('isolamento: usuário B não vê nem altera pneu do usuário A', async () => {
  const { json: created } = await call('POST', '/api/tires', { body: TIRE });
  const list = await call('GET', '/api/tires', { token: 'token-b' });
  assert.equal(list.json.items.length, 0);
  assert.equal((await call('PUT', `/api/tires/${created.id}`, { token: 'token-b', body: TIRE })).status, 404);
  await call('DELETE', `/api/tires/${created.id}`, { token: 'token-b' });
  assert.equal(fake.rows.tires.length, 1, 'DELETE de outro usuário não apaga nada');
});

test('histórico: ordem desc, filtro por pneu e por período', async () => {
  const { json: a } = await call('POST', '/api/tires', { body: TIRE });
  const { json: b } = await call('POST', '/api/tires', { body: { ...TIRE, marca: 'Michelin' } });
  await call('PUT', `/api/tires/${a.id}`, { body: { ...TIRE, quantidade: 1 } });

  const all = await call('GET', '/api/history');
  assert.equal(all.status, 200);
  assert.equal(all.json.length, 3);
  assert.equal(all.json[0].acao, 'saida', 'mais recente primeiro');
  assert.equal(all.json[0].valorAnterior, '4');

  const soB = await call('GET', `/api/history?tireId=${b.id}`);
  assert.equal(soB.json.length, 1);
  assert.equal(soB.json[0].marca, 'Michelin');

  const futuro = await call('GET', '/api/history?from=2030-01-01');
  assert.equal(futuro.json.length, 0);
  const passado = await call('GET', '/api/history?to=2020-01-01');
  assert.equal(passado.json.length, 0);
  const dentro = await call('GET', '/api/history?from=2026-01-01&to=2026-12-31');
  assert.equal(dentro.json.length, 3);

  assert.deepEqual((await call('GET', '/api/history?tireId=lixo')).json, []);
});

test('respostas normais levam header CORS pra origem liberada', async () => {
  const r = await call('GET', '/api/tires');
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const other = await call('GET', '/api/tires', { origin: 'https://exemplo.invalid' });
  assert.equal(other.headers.get('Access-Control-Allow-Origin'), null);
});

/* ---------------------------------------------------------------------------
   Personalização por conta (nome do sistema e logo)
--------------------------------------------------------------------------- */

const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('settings: conta sem personalização devolve os dois campos nulos', async () => {
  const r = await call('GET', '/api/settings');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { appName: null, logo: null, accentColor: null });
  assert.equal(fake.rows.user_settings.length, 0, 'GET não deve criar linha');
});

test('settings: salva nome e logo, e o segundo PUT substitui a mesma linha', async () => {
  const salvo = await call('PUT', '/api/settings', { body: { appName: 'Pneus do Arthur', logo: LOGO } });
  assert.equal(salvo.status, 200);
  assert.deepEqual(salvo.json, { appName: 'Pneus do Arthur', logo: LOGO, accentColor: null });

  assert.deepEqual((await call('GET', '/api/settings')).json, { appName: 'Pneus do Arthur', logo: LOGO, accentColor: null });

  const trocado = await call('PUT', '/api/settings', { body: { appName: 'Borracharia Central', logo: LOGO } });
  assert.equal(trocado.json.appName, 'Borracharia Central');
  assert.equal(fake.rows.user_settings.length, 1, 'upsert não pode duplicar a linha da conta');
});

test('settings: PUT sem os campos volta tudo pro padrão', async () => {
  await call('PUT', '/api/settings', { body: { appName: 'Pneus do Arthur', logo: LOGO } });

  const limpo = await call('PUT', '/api/settings', { body: {} });
  assert.equal(limpo.status, 200);
  assert.deepEqual(limpo.json, { appName: null, logo: null, accentColor: null });
  assert.deepEqual((await call('GET', '/api/settings')).json, { appName: null, logo: null, accentColor: null });
});

test('settings: nome é normalizado; nome longo, logo inválida e logo gigante → 400', async () => {
  const limpo = await call('PUT', '/api/settings', { body: { appName: '  Pneus   do\u0007 Arthur  ' } });
  assert.equal(limpo.json.appName, 'Pneus do Arthur', 'espaços repetidos e caracteres de controle saem');

  assert.equal((await call('PUT', '/api/settings', { body: { appName: 'x'.repeat(41) } })).status, 400);
  assert.equal((await call('PUT', '/api/settings', { body: { logo: 'https://exemplo.invalid/logo.png' } })).status, 400);
  assert.equal((await call('PUT', '/api/settings', { body: { logo: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' } })).status, 400);
  assert.equal((await call('PUT', '/api/settings', { body: { logo: `data:image/png;base64,${'A'.repeat(300001)}` } })).status, 400);

  assert.equal(fake.rows.user_settings[0].app_name, 'Pneus do Arthur', 'nenhuma recusa pode ter gravado');
  assert.equal(fake.rows.user_settings[0].logo_data_url, null);
});

test('settings: cada conta enxerga só a própria personalização', async () => {
  await call('PUT', '/api/settings', { token: 'token-a', body: { appName: 'Loja A', logo: LOGO } });
  await call('PUT', '/api/settings', { token: 'token-b', body: { appName: 'Loja B', accentColor: '#2f9e44' } });

  assert.deepEqual((await call('GET', '/api/settings', { token: 'token-a' })).json, { appName: 'Loja A', logo: LOGO, accentColor: null });
  assert.deepEqual((await call('GET', '/api/settings', { token: 'token-b' })).json, { appName: 'Loja B', logo: null, accentColor: '#2f9e44' });
  assert.equal(fake.rows.user_settings.length, 2, 'uma linha por conta');
});

test('settings: tabela ainda não criada (migration não rodada) avisa em vez de "erro interno"', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input.url || input).includes('/rest/v1/user_settings')) {
      return new Response(JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.user_settings' in the schema cache" }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(input, init);
  };
  try {
    const r = await call('PUT', '/api/settings', { body: { appName: 'X' } });
    assert.equal(r.status, 503);
    assert.match(r.json.error, /migrations/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('settings: cor do sistema é salva em minúsculas; formato inválido → 400', async () => {
  const salvo = await call('PUT', '/api/settings', { body: { accentColor: '#1C6DD0' } });
  assert.equal(salvo.status, 200);
  assert.equal(salvo.json.accentColor, '#1c6dd0');
  assert.equal(fake.rows.user_settings[0].accent_color, '#1c6dd0');
  assert.equal((await call('GET', '/api/settings')).json.accentColor, '#1c6dd0');

  for (const ruim of ['red', '#12345', '#1234567', 'url(x)', '#12345g', '#fff;x']) {
    assert.equal((await call('PUT', '/api/settings', { body: { accentColor: ruim } })).status, 400, ruim);
  }
  // sem o campo = volta pro padrão
  assert.equal((await call('PUT', '/api/settings', { body: { appName: 'X' } })).json.accentColor, null);
});

test('settings: coluna de cor ainda não criada (migration não rodada) avisa pra rodar as migrations', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input.url || input).includes('/rest/v1/user_settings') && (init?.method || input.method) === 'POST') {
      return new Response(JSON.stringify({ code: 'PGRST204', message: "Could not find the 'accent_color' column of 'user_settings' in the schema cache" }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(input, init);
  };
  try {
    const r = await call('PUT', '/api/settings', { body: { accentColor: '#1c6dd0' } });
    assert.equal(r.status, 503);
    assert.match(r.json.error, /migrations/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
