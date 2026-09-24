// API do Controle de Estoque de Pneus — Supabase Edge Function (Deno).
// Zero dependências de terceiros: roteamento, CORS e acesso ao Supabase
// (PostgREST pra banco, GoTrue pra validar sessão) são feitos direto com
// fetch/Deno.serve. Mesmo contrato de API consumido por frontend/app.js.

const SUPABASE_URL = (Deno.env.get('SUPABASE_URL') || '').replace(/\/+$/, '');
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || '';
const ALLOWED_ORIGIN = (Deno.env.get('ALLOWED_ORIGIN') || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

if (ALLOWED_ORIGIN.length === 0) {
  console.warn('ALLOWED_ORIGIN não configurado — CORS negado para todas as origens (fail-safe).');
}

/* ===========================================================================
   HTTP: CORS, JSON e roteamento
=========================================================================== */

const API_PREFIX = '/api';
const CORS_ALLOW_METHODS = 'GET,POST,PUT,DELETE,OPTIONS';
const CORS_ALLOW_HEADERS = 'Content-Type,Authorization';

function withCors(req: Request, res: Response): Response {
  const origin = req.headers.get('Origin');
  const headers = new Headers(res.headers);
  // Sem ALLOWED_ORIGIN configurado, nega CORS por padrão em vez de abrir
  // geral — um secret esquecido em prod não deve virar CORS aberto.
  if (origin && ALLOWED_ORIGIN.includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
  }
  headers.append('Vary', 'Origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function preflight(): Response {
  const headers = new Headers({
    'Access-Control-Allow-Methods': CORS_ALLOW_METHODS,
    'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
  });
  return new Response(null, { status: 204, headers });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

class BadRequest extends Error {}

async function readJson(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    throw new BadRequest('Corpo da requisição não é um JSON válido.');
  }
}

type Ctx = {
  req: Request;
  url: URL;
  params: Record<string, string>;
  token: string;
  userId: string;
};
type Handler = (ctx: Ctx) => Promise<Response>;
type Route = { method: string; segments: string[]; handler: Handler };

const routes: Route[] = [];

function route(method: string, path: string, handler: Handler) {
  routes.push({ method, segments: path.split('/').filter(Boolean), handler });
}

function matchRoute(method: string, path: string) {
  const parts = path.split('/').filter(Boolean);
  for (const r of routes) {
    if (r.method !== method || r.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      const seg = r.segments[i];
      if (seg.startsWith(':')) {
        try {
          params[seg.slice(1)] = decodeURIComponent(parts[i]);
        } catch {
          ok = false;
          break;
        }
      } else if (seg !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler: r.handler, params };
  }
  return null;
}

/* ===========================================================================
   SUPABASE: Auth (GoTrue) e banco (PostgREST), via fetch
=========================================================================== */

// Valida o JWT do usuário no próprio Supabase Auth — mesma chamada que o
// supabase-js fazia em auth.getUser(token).
async function fetchUser(token: string): Promise<{ id: string } | null | 'unavailable'> {
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    console.error('Supabase Auth inacessível:', (err as Error).message);
    return 'unavailable';
  }
  if (res.status >= 500) return 'unavailable';
  if (!res.ok) return null;
  const user = await res.json().catch(() => null);
  return user && typeof user.id === 'string' ? user : null;
}

type DbError = { message: string; code?: string };
type DbResult = { data: any; error: DbError | null; count: number | null };

// Todas as chamadas ao banco vão com o token do próprio usuário — o RLS do
// Postgres garante que cada empresa só lê/escreve as próprias linhas.
async function db(
  token: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  table: string,
  query: URLSearchParams,
  opts: { body?: unknown; prefer?: string } = {},
): Promise<DbResult> {
  const headers: Record<string, string> = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.prefer) headers.Prefer = opts.prefer;

  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    return { data: null, error: { message: `falha de rede: ${(err as Error).message}` }, count: null };
  }

  const text = await res.text();
  let payload: any = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!res.ok) {
    const message = (payload && typeof payload === 'object' && payload.message) || `HTTP ${res.status}`;
    const code = payload && typeof payload === 'object' ? payload.code : undefined;
    return { data: null, error: { message, code }, count: null };
  }

  // Prefer: count=exact → "Content-Range: 0-49/123" (ou "*/0" sem linhas).
  let count: number | null = null;
  const range = res.headers.get('Content-Range');
  if (range && range.includes('/')) {
    const total = range.split('/')[1];
    if (total && total !== '*' && !isNaN(Number(total))) count = Number(total);
  }
  return { data: payload, error: null, count };
}

function params(entries: [string, string][]): URLSearchParams {
  const q = new URLSearchParams();
  for (const [k, v] of entries) q.append(k, v);
  return q;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ===========================================================================
   PNEUS
=========================================================================== */

const MEDIDA_REGEX = /R\s*-?\s*(1[3-9]|2[0-2])[A-Z]?\b/i;
const MAX_TEXT_LEN = 120;
const TIRES_DEFAULT_LIMIT = 200;
const TIRES_MAX_LIMIT = 500;
const MAX_BULK_ITEMS = 300;
const TRACKED_EDIT_FIELDS = ['marca', 'medida', 'preco'] as const;

function validateTirePayload(body: any) {
  const marca = String(body?.marca ?? '').trim();
  const medida = String(body?.medida ?? '').trim();
  const quantidade = Number(body?.quantidade);
  const preco = body?.preco === undefined || body?.preco === null ? '' : String(body.preco).trim();
  const condicao = body?.condicao === 'usado' ? 'usado' : 'novo';

  if (!marca || marca.length > MAX_TEXT_LEN) {
    return { error: 'Marca inválida.' };
  }
  if (!medida || medida.length > MAX_TEXT_LEN || !MEDIDA_REGEX.test(medida)) {
    return { error: 'Medida inválida. Informe o aro no formato R13 a R22 (ex: 185/65 R14).' };
  }
  if (!Number.isFinite(quantidade) || quantidade < 0 || !Number.isInteger(quantidade)) {
    return { error: 'Quantidade inválida.' };
  }
  if (preco.length > 40) {
    return { error: 'Preço inválido.' };
  }

  return {
    value: {
      marca,
      medida,
      quantidade,
      preco: preco || null,
      condicao,
      novo: body?.novo !== undefined ? Boolean(body.novo) : true,
      nota_ref: body?.notaRef ? String(body.notaRef).trim().slice(0, MAX_TEXT_LEN) : null,
      origem: body?.origem === 'empresa' ? 'empresa' : 'local',
      fornecedor: body?.fornecedor ? String(body.fornecedor).trim().slice(0, MAX_TEXT_LEN) : null,
      codigo_barras: body?.codigoBarras ? String(body.codigoBarras).trim().slice(0, MAX_TEXT_LEN) : null,
    },
  };
}

function toRow(validated: any, ownerId: string) {
  return { ...validated, owner_id: ownerId };
}

function toApi(row: any) {
  return {
    id: row.id,
    marca: row.marca,
    medida: row.medida,
    quantidade: row.quantidade,
    preco: row.preco,
    condicao: row.condicao,
    novo: row.novo,
    notaRef: row.nota_ref,
    origem: row.origem || 'local',
    fornecedor: row.fornecedor || null,
    codigoBarras: row.codigo_barras || null,
    addedAt: row.created_at ? new Date(row.created_at).getTime() : null,
    conferidoStatus: row.conferido_status || null,
    conferidoEm: row.conferido_em ? new Date(row.conferido_em).getTime() : null,
  };
}

function dbErrorResponse(error: DbError) {
  console.error('Erro no Supabase:', error.message);
  if (error.code === '23505' && /codigo_barras/.test(error.message || '')) {
    return json({ error: 'Esse código de barras já está cadastrado em outro item do estoque.' }, 409);
  }
  return json({ error: 'Não foi possível completar a operação. Tente novamente.' }, 500);
}

async function logHistory(token: string, ownerId: string, entries: any[]) {
  if (!entries.length) return;
  const rows = entries.map((e) => ({
    owner_id: ownerId,
    tire_id: e.tireId ?? null,
    marca: e.marca,
    medida: e.medida,
    condicao: e.condicao,
    acao: e.acao,
    campo: e.campo ?? null,
    valor_anterior: e.valorAnterior != null ? String(e.valorAnterior) : null,
    valor_novo: e.valorNovo != null ? String(e.valorNovo) : null,
  }));
  const { error } = await db(token, 'POST', 'tire_history', params([]), { body: rows, prefer: 'return=minimal' });
  if (error) console.error('Erro ao gravar histórico:', error.message);
}

function diffToHistoryEntries(oldRow: any, newRow: any) {
  const entries: any[] = [];
  const base = { tireId: newRow.id, marca: newRow.marca, medida: newRow.medida, condicao: newRow.condicao };

  const oldQtd = Number(oldRow.quantidade);
  const newQtd = Number(newRow.quantidade);
  if (oldQtd !== newQtd) {
    entries.push({
      ...base,
      acao: newQtd > oldQtd ? 'entrada' : 'saida',
      campo: 'quantidade',
      valorAnterior: oldQtd,
      valorNovo: newQtd,
    });
  }

  TRACKED_EDIT_FIELDS.forEach((field) => {
    const oldVal = oldRow[field] ?? '';
    const newVal = newRow[field] ?? '';
    if (oldVal !== newVal) {
      entries.push({ ...base, acao: 'editado', campo: field, valorAnterior: oldRow[field], valorNovo: newRow[field] });
    }
  });

  return entries;
}

async function fetchTireById(token: string, id: string): Promise<DbResult> {
  return db(token, 'GET', 'tires', params([['select', '*'], ['id', `eq.${id}`]]));
}

// GET /api/tires
route('GET', '/tires', async ({ url, token }) => {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || TIRES_DEFAULT_LIMIT, 1), TIRES_MAX_LIMIT);
  const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);

  const { data, error, count } = await db(
    token,
    'GET',
    'tires',
    params([['select', '*'], ['order', 'created_at.asc'], ['offset', String(offset)], ['limit', String(limit)]]),
    { prefer: 'count=exact' },
  );
  if (error) return dbErrorResponse(error);
  return json({ items: data.map(toApi), total: count ?? data.length, offset, limit });
});

// POST /api/tires
route('POST', '/tires', async ({ req, token, userId }) => {
  const body = await readJson(req);
  const { value, error: validationError } = validateTirePayload(body);
  if (validationError) return json({ error: validationError }, 400);

  const { data, error } = await db(token, 'POST', 'tires', params([['select', '*']]), {
    body: [toRow(value, userId)],
    prefer: 'return=representation',
  });
  if (error) return dbErrorResponse(error);

  const created = data[0];
  await logHistory(token, userId, [{
    tireId: created.id, marca: created.marca, medida: created.medida, condicao: created.condicao,
    acao: 'criado', valorNovo: created.quantidade,
  }]);
  return json(toApi(created), 201);
});

// POST /api/tires/bulk
route('POST', '/tires/bulk', async ({ req, token, userId }) => {
  const body = await readJson(req);
  const items = body?.items;
  if (!Array.isArray(items) || items.length === 0) {
    return json({ error: 'envie { items: [...] } com ao menos um item' }, 400);
  }
  if (items.length > MAX_BULK_ITEMS) {
    return json({ error: `Envie no máximo ${MAX_BULK_ITEMS} itens por vez.` }, 400);
  }

  const rows = [];
  for (const item of items) {
    const { value, error: validationError } = validateTirePayload(item);
    if (validationError) {
      return json({ error: `Item inválido (${item?.marca || '?'}): ${validationError}` }, 400);
    }
    rows.push(toRow(value, userId));
  }

  const { data, error } = await db(token, 'POST', 'tires', params([['select', '*']]), {
    body: rows,
    prefer: 'return=representation',
  });
  if (error) return dbErrorResponse(error);

  await logHistory(token, userId, data.map((row: any) => ({
    tireId: row.id, marca: row.marca, medida: row.medida, condicao: row.condicao,
    acao: 'criado', valorNovo: row.quantidade,
  })));
  return json(data.map(toApi), 201);
});

// PUT /api/tires/:id
route('PUT', '/tires/:id', async ({ req, params: p, token, userId }) => {
  const id = p.id;
  if (!UUID_REGEX.test(id)) return json({ error: 'item não encontrado' }, 404);
  const body = await readJson(req);
  const { value, error: validationError } = validateTirePayload(body);
  if (validationError) return json({ error: validationError }, 400);

  const existing = await fetchTireById(token, id);
  if (existing.error) return dbErrorResponse(existing.error);
  if (!existing.data.length) return json({ error: 'item não encontrado' }, 404);
  const oldRow = existing.data[0];

  const { data, error } = await db(token, 'PATCH', 'tires', params([['select', '*'], ['id', `eq.${id}`]]), {
    body: toRow(value, userId),
    prefer: 'return=representation',
  });
  if (error) return dbErrorResponse(error);
  if (!data.length) return json({ error: 'item não encontrado' }, 404);

  await logHistory(token, userId, diffToHistoryEntries(oldRow, data[0]));
  return json(toApi(data[0]));
});

// PUT /api/tires/:id/conferencia — marca presença/ausência na conferência de
// estoque físico. Endpoint próprio (não o PUT genérico acima) porque não
// exige o payload completo do pneu e não deve gerar entrada de histórico —
// conferência é um registro de auditoria, não uma edição de item.
route('PUT', '/tires/:id/conferencia', async ({ req, params: p, token }) => {
  const id = p.id;
  if (!UUID_REGEX.test(id)) return json({ error: 'item não encontrado' }, 404);
  const body = await readJson(req);
  const status = body?.status;
  if (status !== 'presente' && status !== 'ausente') {
    return json({ error: 'status deve ser "presente" ou "ausente"' }, 400);
  }

  const { data, error } = await db(token, 'PATCH', 'tires', params([['select', '*'], ['id', `eq.${id}`]]), {
    body: { conferido_status: status, conferido_em: new Date().toISOString() },
    prefer: 'return=representation',
  });
  if (error) return dbErrorResponse(error);
  if (!data.length) return json({ error: 'item não encontrado' }, 404);

  return json(toApi(data[0]));
});

// DELETE /api/tires/:id
route('DELETE', '/tires/:id', async ({ params: p, token, userId }) => {
  const id = p.id;
  if (!UUID_REGEX.test(id)) return json({ error: 'item não encontrado' }, 404);

  const existing = await fetchTireById(token, id);
  if (existing.error) return dbErrorResponse(existing.error);
  const oldRow = existing.data[0];

  const { error } = await db(token, 'DELETE', 'tires', params([['id', `eq.${id}`]]));
  if (error) return dbErrorResponse(error);

  if (oldRow) {
    await logHistory(token, userId, [{
      tireId: oldRow.id, marca: oldRow.marca, medida: oldRow.medida, condicao: oldRow.condicao,
      acao: 'excluido', valorAnterior: oldRow.quantidade,
    }]);
  }
  return new Response(null, { status: 204 });
});

/* ===========================================================================
   HISTÓRICO
=========================================================================== */

const HISTORY_DEFAULT_LIMIT = 200;
const HISTORY_MAX_LIMIT = 500;

function historyToApi(row: any) {
  return {
    id: row.id,
    tireId: row.tire_id,
    marca: row.marca,
    medida: row.medida,
    condicao: row.condicao,
    acao: row.acao,
    campo: row.campo,
    valorAnterior: row.valor_anterior,
    valorNovo: row.valor_novo,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : null,
  };
}

// GET /api/history
route('GET', '/history', async ({ url, token }) => {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || HISTORY_DEFAULT_LIMIT, 1), HISTORY_MAX_LIMIT);
  const q = params([['select', '*'], ['order', 'created_at.desc'], ['limit', String(limit)]]);

  const tireId = url.searchParams.get('tireId');
  if (tireId) {
    if (!UUID_REGEX.test(tireId)) return json([]);
    q.append('tire_id', `eq.${tireId}`);
  }

  const from = url.searchParams.get('from');
  if (from) {
    const fromDate = new Date(from);
    if (!isNaN(fromDate.getTime())) q.append('created_at', `gte.${fromDate.toISOString()}`);
  }

  const to = url.searchParams.get('to');
  if (to) {
    const toDate = new Date(to);
    if (!isNaN(toDate.getTime())) {
      toDate.setHours(23, 59, 59, 999);
      q.append('created_at', `lte.${toDate.toISOString()}`);
    }
  }

  const { data, error } = await db(token, 'GET', 'tire_history', q);
  if (error) {
    console.error('Erro no Supabase (history):', error.message);
    return json({ error: 'Não foi possível carregar o histórico.' }, 500);
  }
  return json(data.map(historyToApi));
});


/* ===========================================================================
   PERSONALIZAÇÃO DA CONTA (nome do sistema e logo)
   Uma linha por conta em user_settings, protegida por RLS — o que uma conta
   salva aqui nunca aparece pra outra. Conta sem linha = padrão do app.
=========================================================================== */

const MAX_APP_NAME_LEN = 40;
// A logo chega como data URL base64, já recortada em 256x256 pelo frontend.
// O teto vale mesmo se alguém chamar a API direto, sem passar pela tela.
const MAX_LOGO_CHARS = 300_000;
const LOGO_DATA_URL_REGEX = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

function settingsToApi(row: any) {
  return {
    appName: row?.app_name || null,
    logo: row?.logo_data_url || null,
  };
}

// GET /api/settings — null nos dois campos significa "usa o padrão".
route('GET', '/settings', async ({ token, userId }) => {
  const { data, error } = await db(
    token,
    'GET',
    'user_settings',
    params([['select', '*'], ['owner_id', `eq.${userId}`], ['limit', '1']]),
  );
  if (error) return dbErrorResponse(error);
  return json(settingsToApi(data[0]));
});

// PUT /api/settings — substitui a personalização inteira da conta. Campo
// ausente/vazio volta pro padrão, então "restaurar padrão" é só um PUT
// com o campo nulo.
route('PUT', '/settings', async ({ req, token, userId }) => {
  const body = await readJson(req);

  let appName: string | null = null;
  if (body?.appName !== undefined && body?.appName !== null) {
    // colapsa espaços repetidos e tira caracteres de controle — o nome vai
    // pro cabeçalho e pro título dos relatórios exportados.
    appName = String(body.appName).replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
    if (!appName) appName = null;
    else if (appName.length > MAX_APP_NAME_LEN) {
      return json({ error: `O nome do sistema deve ter no máximo ${MAX_APP_NAME_LEN} caracteres.` }, 400);
    }
  }

  let logo: string | null = null;
  if (body?.logo !== undefined && body?.logo !== null && body.logo !== '') {
    logo = String(body.logo);
    if (logo.length > MAX_LOGO_CHARS) {
      return json({ error: 'A logo ficou grande demais. Escolha uma imagem menor.' }, 400);
    }
    if (!LOGO_DATA_URL_REGEX.test(logo)) {
      return json({ error: 'Logo inválida. Envie uma imagem PNG, JPG ou WebP.' }, 400);
    }
  }

  // Upsert pela chave primária (owner_id): a primeira vez insere, as
  // seguintes substituem — sem precisar de um GET antes.
  const { data, error } = await db(token, 'POST', 'user_settings', params([['select', '*']]), {
    body: {
      owner_id: userId,
      app_name: appName,
      logo_data_url: logo,
      updated_at: new Date().toISOString(),
    },
    prefer: 'resolution=merge-duplicates,return=representation',
  });
  if (error) return dbErrorResponse(error);
  return json(settingsToApi(Array.isArray(data) ? data[0] : data));
});

/* ===========================================================================
   ENTRADA
=========================================================================== */

async function dispatch(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return preflight();

  const url = new URL(req.url);
  if (url.pathname !== API_PREFIX && !url.pathname.startsWith(API_PREFIX + '/')) {
    return json({ error: 'rota não encontrada' }, 404);
  }
  const path = url.pathname.slice(API_PREFIX.length) || '/';

  // Exige um token válido do Supabase Auth no header Authorization.
  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    return json({ error: 'Não autenticado. Faça login novamente.' }, 401);
  }
  const user = await fetchUser(token);
  if (user === 'unavailable') {
    return json({ error: 'Não foi possível validar a sessão agora. Tente novamente.' }, 503);
  }
  if (!user) {
    return json({ error: 'Sessão inválida ou expirada. Faça login novamente.' }, 401);
  }

  const matched = matchRoute(req.method, path);
  if (!matched) return json({ error: 'rota não encontrada' }, 404);

  try {
    return await matched.handler({ req, url, params: matched.params, token, userId: user.id });
  } catch (err) {
    if (err instanceof BadRequest) return json({ error: err.message }, 400);
    console.error('Erro inesperado:', (err as Error).stack || err);
    return json({ error: 'Erro interno. Tente novamente.' }, 500);
  }
}

export async function handleRequest(req: Request): Promise<Response> {
  return withCors(req, await dispatch(req));
}

Deno.serve(handleRequest);
