// API do Controle de Estoque de Pneus — Supabase Edge Function (Deno).
// Substitui o backend Express (backend/src) mantendo as mesmas regras de
// negócio e o mesmo contrato de API consumido por frontend/app.js.

import { Hono } from 'npm:hono@4';
import { cors } from 'npm:hono/cors';
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const ALLOWED_ORIGIN = (Deno.env.get('ALLOWED_ORIGIN') || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const supabaseAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function supabaseForUser(accessToken: string) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

type Vars = { supabase: ReturnType<typeof supabaseForUser>; userId: string };

const app = new Hono<{ Variables: Vars }>().basePath('/api');

app.use(
  '*',
  cors({
    origin: ALLOWED_ORIGIN.length === 0 ? '*' : ALLOWED_ORIGIN,
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  })
);

// Exige um token válido do Supabase Auth no header Authorization.
app.use('*', async (c, next) => {
  const authHeader = c.req.header('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return c.json({ error: 'Não autenticado. Faça login novamente.' }, 401);
  }

  const { data, error } = await supabaseAnon.auth.getUser(token);
  if (error || !data.user) {
    return c.json({ error: 'Sessão inválida ou expirada. Faça login novamente.' }, 401);
  }

  c.set('userId', data.user.id);
  c.set('supabase', supabaseForUser(token));
  await next();
});

/* ===========================================================================
   PNEUS
=========================================================================== */

const MEDIDA_REGEX = /R\s*-?\s*(1[3-9]|20)[A-Z]?\b/i;
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
    return { error: 'Medida inválida. Informe o aro no formato R13 a R20 (ex: 185/65 R14).' };
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
  };
}

function dbErrorResponse(c: any, error: any) {
  console.error('Erro no Supabase:', error.message);
  if (error.code === '23505' && /codigo_barras/.test(error.message || '')) {
    return c.json({ error: 'Esse código de barras já está cadastrado em outro item do estoque.' }, 409);
  }
  return c.json({ error: 'Não foi possível completar a operação. Tente novamente.' }, 500);
}

async function logHistory(supabase: any, ownerId: string, entries: any[]) {
  if (!entries.length) return;
  try {
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
    const { error } = await supabase.from('tire_history').insert(rows);
    if (error) console.error('Erro ao gravar histórico:', error.message);
  } catch (err) {
    console.error('Erro ao gravar histórico:', (err as Error).message);
  }
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

// GET /api/tires
app.get('/tires', async (c) => {
  const supabase = c.get('supabase');
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || TIRES_DEFAULT_LIMIT, 1), TIRES_MAX_LIMIT);
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0);

  const { data, error, count } = await supabase
    .from('tires')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) return dbErrorResponse(c, error);
  return c.json({ items: data.map(toApi), total: count ?? data.length, offset, limit });
});

// POST /api/tires
app.post('/tires', async (c) => {
  const supabase = c.get('supabase');
  const userId = c.get('userId');
  const body = await c.req.json();
  const { value, error: validationError } = validateTirePayload(body);
  if (validationError) return c.json({ error: validationError }, 400);

  const { data, error } = await supabase.from('tires').insert([toRow(value, userId)]).select();
  if (error) return dbErrorResponse(c, error);

  const created = data[0];
  await logHistory(supabase, userId, [{
    tireId: created.id, marca: created.marca, medida: created.medida, condicao: created.condicao,
    acao: 'criado', valorNovo: created.quantidade,
  }]);
  return c.json(toApi(created), 201);
});

// POST /api/tires/bulk
app.post('/tires/bulk', async (c) => {
  const supabase = c.get('supabase');
  const userId = c.get('userId');
  const body = await c.req.json();
  const items = body?.items;
  if (!Array.isArray(items) || items.length === 0) {
    return c.json({ error: 'envie { items: [...] } com ao menos um item' }, 400);
  }
  if (items.length > MAX_BULK_ITEMS) {
    return c.json({ error: `Envie no máximo ${MAX_BULK_ITEMS} itens por vez.` }, 400);
  }

  const rows = [];
  for (const item of items) {
    const { value, error: validationError } = validateTirePayload(item);
    if (validationError) {
      return c.json({ error: `Item inválido (${item.marca || '?'}): ${validationError}` }, 400);
    }
    rows.push(toRow(value, userId));
  }

  const { data, error } = await supabase.from('tires').insert(rows).select();
  if (error) return dbErrorResponse(c, error);

  await logHistory(supabase, userId, data.map((row: any) => ({
    tireId: row.id, marca: row.marca, medida: row.medida, condicao: row.condicao,
    acao: 'criado', valorNovo: row.quantidade,
  })));
  return c.json(data.map(toApi), 201);
});

// PUT /api/tires/:id
app.put('/tires/:id', async (c) => {
  const supabase = c.get('supabase');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const body = await c.req.json();
  const { value, error: validationError } = validateTirePayload(body);
  if (validationError) return c.json({ error: validationError }, 400);

  const { data: existingRows, error: fetchError } = await supabase.from('tires').select('*').eq('id', id);
  if (fetchError) return dbErrorResponse(c, fetchError);
  if (!existingRows.length) return c.json({ error: 'item não encontrado' }, 404);
  const oldRow = existingRows[0];

  const { data, error } = await supabase.from('tires').update(toRow(value, userId)).eq('id', id).select();
  if (error) return dbErrorResponse(c, error);
  if (!data.length) return c.json({ error: 'item não encontrado' }, 404);

  await logHistory(supabase, userId, diffToHistoryEntries(oldRow, data[0]));
  return c.json(toApi(data[0]));
});

// DELETE /api/tires/:id
app.delete('/tires/:id', async (c) => {
  const supabase = c.get('supabase');
  const userId = c.get('userId');
  const id = c.req.param('id');

  const { data: existingRows, error: fetchError } = await supabase.from('tires').select('*').eq('id', id);
  if (fetchError) return dbErrorResponse(c, fetchError);
  const oldRow = existingRows[0];

  const { error } = await supabase.from('tires').delete().eq('id', id);
  if (error) return dbErrorResponse(c, error);

  if (oldRow) {
    await logHistory(supabase, userId, [{
      tireId: oldRow.id, marca: oldRow.marca, medida: oldRow.medida, condicao: oldRow.condicao,
      acao: 'excluido', valorAnterior: oldRow.quantidade,
    }]);
  }
  return c.body(null, 204);
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
app.get('/history', async (c) => {
  const supabase = c.get('supabase');
  const limit = Math.min(Number(c.req.query('limit')) || HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT);

  let query = supabase
    .from('tire_history')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  const tireId = c.req.query('tireId');
  if (tireId) query = query.eq('tire_id', tireId);

  const from = c.req.query('from');
  if (from) {
    const fromDate = new Date(from);
    if (!isNaN(fromDate.getTime())) query = query.gte('created_at', fromDate.toISOString());
  }

  const to = c.req.query('to');
  if (to) {
    const toDate = new Date(to);
    if (!isNaN(toDate.getTime())) {
      toDate.setHours(23, 59, 59, 999);
      query = query.lte('created_at', toDate.toISOString());
    }
  }

  const { data, error } = await query;
  if (error) {
    console.error('Erro no Supabase (history):', error.message);
    return c.json({ error: 'Não foi possível carregar o histórico.' }, 500);
  }
  return c.json(data.map(historyToApi));
});

Deno.serve(app.fetch);
