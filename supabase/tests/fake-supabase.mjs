// Emulador em memória do pedaço do Supabase que a edge function usa:
// GoTrue (GET /auth/v1/user) e PostgREST (/rest/v1/<tabela>). É estrito de
// propósito — parâmetro, operador ou header fora do esperado vira erro, pra
// um teste pegar requisição mal montada em vez de "passar por acaso".

import { randomUUID } from 'node:crypto';

const TABLES = {
  tires: {
    defaults: () => ({
      quantidade: 0,
      preco: null,
      condicao: 'novo',
      novo: true,
      nota_ref: null,
      origem: 'local',
      fornecedor: null,
      codigo_barras: null,
      conferido_status: null,
      conferido_em: null,
    }),
    unique: { name: 'idx_tires_owner_codigo_barras', cols: ['owner_id', 'codigo_barras'], where: 'codigo_barras' },
  },
  tire_history: {
    defaults: () => ({ tire_id: null, campo: null, valor_anterior: null, valor_novo: null }),
  },
};

const ALLOWED_PARAMS = new Set(['select', 'order', 'limit', 'offset']);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pgError(status, code, message) {
  return new Response(JSON.stringify({ code, message, details: null, hint: null }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function createFakeSupabase({ url, anonKey, users }) {
  // users: { [token]: { id, email } }
  const rows = { tires: [], tire_history: [] };
  const calls = [];
  let clock = Date.parse('2026-09-01T12:00:00Z');
  const state = { authDown: false };

  function nextTimestamp() {
    clock += 1000;
    return new Date(clock).toISOString();
  }

  function userFor(req) {
    if (req.headers.get('apikey') !== anonKey) return { error: pgError(401, 'PGRST301', 'No API key found in request') };
    const auth = req.headers.get('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const user = users[token];
    if (!user) return { error: pgError(401, 'PGRST301', 'JWT expired') };
    return { user };
  }

  function parseFilters(table, searchParams) {
    const filters = [];
    let order = null;
    let limit = null;
    let offset = 0;
    for (const [key, raw] of searchParams) {
      if (ALLOWED_PARAMS.has(key)) {
        if (key === 'select' && raw !== '*') throw pgError(400, 'PGRST100', `select não suportado no fake: ${raw}`);
        if (key === 'order') {
          const [col, dir] = raw.split('.');
          if (!['asc', 'desc'].includes(dir)) throw pgError(400, 'PGRST100', `order inválido: ${raw}`);
          order = { col, dir };
        }
        if (key === 'limit') limit = Number(raw);
        if (key === 'offset') offset = Number(raw);
        continue;
      }
      const dot = raw.indexOf('.');
      if (dot < 0) throw pgError(400, 'PGRST100', `filtro sem operador: ${key}=${raw}`);
      const op = raw.slice(0, dot);
      const value = raw.slice(dot + 1);
      if (!['eq', 'gte', 'lte'].includes(op)) throw pgError(400, 'PGRST100', `operador não suportado: ${op}`);
      if ((key === 'id' || key === 'tire_id') && !UUID_REGEX.test(value)) {
        throw pgError(400, '22P02', `invalid input syntax for type uuid: "${value}"`);
      }
      filters.push({ col: key, op, value });
    }
    if (!(table in TABLES)) throw pgError(404, '42P01', `relation "${table}" does not exist`);
    return { filters, order, limit, offset };
  }

  function matches(row, filters) {
    return filters.every(({ col, op, value }) => {
      const v = row[col];
      if (v === null || v === undefined) return false;
      if (op === 'eq') return String(v) === value;
      if (op === 'gte') return String(v) >= value;
      if (op === 'lte') return String(v) <= value;
      return false;
    });
  }

  function checkUnique(table, candidate, ignoreRow) {
    const u = TABLES[table].unique;
    if (!u || candidate[u.where] === null || candidate[u.where] === undefined) return null;
    const clash = rows[table].find(
      (r) => r !== ignoreRow && u.cols.every((c) => r[c] === candidate[c]),
    );
    return clash ? pgError(409, '23505', `duplicate key value violates unique constraint "${u.name}"`) : null;
  }

  function preferOf(req) {
    const p = (req.headers.get('Prefer') || '').split(',').map((s) => s.trim()).filter(Boolean);
    return { representation: p.includes('return=representation'), count: p.includes('count=exact') };
  }

  async function handleRest(req, u) {
    const table = u.pathname.slice('/rest/v1/'.length);
    const who = userFor(req);
    if (who.error) return who.error;
    const ownerId = who.user.id;
    let q;
    try {
      q = parseFilters(table, u.searchParams);
    } catch (res) {
      return res;
    }
    const prefer = preferOf(req);
    // RLS: cada usuário só enxerga as próprias linhas.
    const visible = () => rows[table].filter((r) => r.owner_id === ownerId && matches(r, q.filters));

    if (req.method === 'GET') {
      let list = visible();
      if (q.order) {
        list = [...list].sort((a, b) => {
          const cmp = String(a[q.order.col]).localeCompare(String(b[q.order.col]));
          return q.order.dir === 'asc' ? cmp : -cmp;
        });
      }
      const total = list.length;
      list = list.slice(q.offset, q.limit != null ? q.offset + q.limit : undefined);
      const headers = { 'Content-Type': 'application/json' };
      if (prefer.count) {
        headers['Content-Range'] = list.length ? `${q.offset}-${q.offset + list.length - 1}/${total}` : `*/${total}`;
      }
      return new Response(JSON.stringify(list), { status: 200, headers });
    }

    if (req.method === 'POST') {
      if (q.filters.length) return pgError(400, 'PGRST100', 'POST não aceita filtro');
      if (req.headers.get('Content-Type') !== 'application/json') return pgError(415, 'PGRST102', 'Content-Type');
      const body = JSON.parse(await req.text());
      const items = Array.isArray(body) ? body : [body];
      const created = [];
      for (const item of items) {
        if (item.owner_id !== ownerId) {
          return pgError(403, '42501', `new row violates row-level security policy for table "${table}"`);
        }
        const row = { ...TABLES[table].defaults(), ...item, id: randomUUID(), created_at: nextTimestamp() };
        const dup = checkUnique(table, row, null) || (created.some((c) => c.codigo_barras && c.codigo_barras === row.codigo_barras)
          ? pgError(409, '23505', 'duplicate key value violates unique constraint "idx_tires_owner_codigo_barras"')
          : null);
        if (dup) return dup;
        created.push(row);
      }
      rows[table].push(...created);
      return prefer.representation
        ? new Response(JSON.stringify(created), { status: 201, headers: { 'Content-Type': 'application/json' } })
        : new Response(null, { status: 201 });
    }

    if (req.method === 'PATCH') {
      if (!q.filters.length) return pgError(400, 'PGRST100', 'PATCH sem filtro');
      const patch = JSON.parse(await req.text());
      if (Array.isArray(patch)) return pgError(400, 'PGRST102', 'PATCH com array');
      if ('owner_id' in patch && patch.owner_id !== ownerId) {
        return pgError(403, '42501', 'new row violates row-level security policy');
      }
      const target = visible();
      for (const r of target) {
        const dup = checkUnique(table, { ...r, ...patch }, r);
        if (dup) return dup;
      }
      target.forEach((r) => Object.assign(r, patch));
      return prefer.representation
        ? new Response(JSON.stringify(target), { status: 200, headers: { 'Content-Type': 'application/json' } })
        : new Response(null, { status: 204 });
    }

    if (req.method === 'DELETE') {
      if (!q.filters.length) return pgError(400, 'PGRST100', 'DELETE sem filtro');
      const target = new Set(visible());
      rows[table] = rows[table].filter((r) => !target.has(r));
      return new Response(null, { status: 204 });
    }

    return pgError(405, 'PGRST000', 'método não suportado');
  }

  async function fetchImpl(input, init) {
    const req = input instanceof Request ? input : new Request(input, init);
    const u = new URL(req.url);
    calls.push({ method: req.method, path: u.pathname, search: u.search });
    if (!req.url.startsWith(url)) throw new TypeError(`fetch inesperado pra ${req.url}`);

    if (u.pathname === '/auth/v1/user') {
      if (state.authDown) throw new TypeError('fetch failed');
      if (req.headers.get('apikey') !== anonKey) return new Response('{"msg":"no apikey"}', { status: 401 });
      const auth = req.headers.get('Authorization') || '';
      const user = users[auth.startsWith('Bearer ') ? auth.slice(7) : ''];
      if (!user) return new Response(JSON.stringify({ code: 401, msg: 'invalid JWT' }), { status: 401 });
      return new Response(JSON.stringify({ id: user.id, email: user.email, aud: 'authenticated' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (u.pathname.startsWith('/rest/v1/')) return handleRest(req, u);
    throw new TypeError(`rota inesperada no fake: ${u.pathname}`);
  }

  return { fetch: fetchImpl, rows, calls, state };
}
