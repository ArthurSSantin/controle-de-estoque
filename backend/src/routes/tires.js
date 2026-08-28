import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// Todas as rotas de pneus exigem login — o middleware anexa req.supabase
// (já autenticado como o usuário da requisição) e req.userId.
router.use(requireAuth);

const MEDIDA_REGEX = /R\s*-?\s*(1[3-9]|20)[A-Z]?\b/i;
const MAX_TEXT_LEN = 120;

/**
 * Valida e normaliza o corpo de uma requisição de criação/edição de pneu.
 * Nunca confiamos só na validação feita no navegador — o backend valida
 * de novo, porque qualquer um pode chamar a API diretamente.
 */
function validateTirePayload(body) {
  const marca = String(body.marca ?? '').trim();
  const medida = String(body.medida ?? '').trim();
  const quantidade = Number(body.quantidade);
  const preco = body.preco === undefined || body.preco === null ? '' : String(body.preco).trim();
  const condicao = body.condicao === 'usado' ? 'usado' : 'novo';

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
      novo: body.novo !== undefined ? Boolean(body.novo) : true,
      nota_ref: body.notaRef ? String(body.notaRef).trim().slice(0, MAX_TEXT_LEN) : null,
      origem: body.origem === 'empresa' ? 'empresa' : 'local',
    },
  };
}

function toRow(validated, ownerId) {
  return { ...validated, owner_id: ownerId };
}

function toApi(row) {
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
    addedAt: row.created_at ? new Date(row.created_at).getTime() : null,
  };
}

// Esconde detalhes internos do erro do Supabase do cliente, mas loga no servidor.
function handleDbError(res, error) {
  console.error('Erro no Supabase:', error.message);
  return res.status(500).json({ error: 'Não foi possível completar a operação. Tente novamente.' });
}

// Campos cuja edição manual entra no histórico como "editado".
const TRACKED_EDIT_FIELDS = ['marca', 'medida', 'preco'];

// Grava uma ou mais linhas no histórico. Nunca deixa uma falha aqui derrubar
// a operação principal (criar/editar/excluir o pneu) — só loga no servidor.
async function logHistory(supabase, ownerId, entries) {
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
    console.error('Erro ao gravar histórico:', err.message);
  }
}

// Compara o pneu antes/depois de um PUT e monta as entradas de histórico
// correspondentes: quantidade virou entrada/saída, e marca/medida/preco
// virou uma entrada "editado" por campo alterado.
function diffToHistoryEntries(oldRow, newRow) {
  const entries = [];
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
      entries.push({
        ...base,
        acao: 'editado',
        campo: field,
        valorAnterior: oldRow[field],
        valorNovo: newRow[field],
      });
    }
  });

  return entries;
}

// GET /api/tires — lista os pneus do usuário logado
// (a política de RLS já restringe isso sozinha, mas o filtro aqui deixa explícito)
router.get('/', async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from('tires')
      .select('*')
      .order('created_at', { ascending: true });

    if (error) return handleDbError(res, error);
    res.json(data.map(toApi));
  } catch (err) {
    handleDbError(res, err);
  }
});

// POST /api/tires — cria um pneu do usuário logado
router.post('/', async (req, res) => {
  try {
    const { value, error: validationError } = validateTirePayload(req.body);
    if (validationError) return res.status(400).json({ error: validationError });

    const { data, error } = await req.supabase
      .from('tires')
      .insert([toRow(value, req.userId)])
      .select();

    if (error) return handleDbError(res, error);
    const created = data[0];
    await logHistory(req.supabase, req.userId, [{
      tireId: created.id, marca: created.marca, medida: created.medida, condicao: created.condicao,
      acao: 'criado', valorNovo: created.quantidade,
    }]);
    res.status(201).json(toApi(created));
  } catch (err) {
    handleDbError(res, err);
  }
});

// POST /api/tires/bulk — cria vários pneus de uma vez (nota XML, planilha, PDF)
const MAX_BULK_ITEMS = 300;

router.post('/bulk', async (req, res) => {
  try {
    const items = req.body.items;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'envie { items: [...] } com ao menos um item' });
    }
    if (items.length > MAX_BULK_ITEMS) {
      return res.status(400).json({ error: `Envie no máximo ${MAX_BULK_ITEMS} itens por vez.` });
    }

    const rows = [];
    for (const item of items) {
      const { value, error: validationError } = validateTirePayload(item);
      if (validationError) {
        return res.status(400).json({ error: `Item inválido (${item.marca || '?'}): ${validationError}` });
      }
      rows.push(toRow(value, req.userId));
    }

    const { data, error } = await req.supabase.from('tires').insert(rows).select();
    if (error) return handleDbError(res, error);
    await logHistory(req.supabase, req.userId, data.map((row) => ({
      tireId: row.id, marca: row.marca, medida: row.medida, condicao: row.condicao,
      acao: 'criado', valorNovo: row.quantidade,
    })));
    res.status(201).json(data.map(toApi));
  } catch (err) {
    handleDbError(res, err);
  }
});

// PUT /api/tires/:id — atualiza um pneu (edição ou marcar como visto)
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { value, error: validationError } = validateTirePayload(req.body);
    if (validationError) return res.status(400).json({ error: validationError });

    const { data: existingRows, error: fetchError } = await req.supabase
      .from('tires')
      .select('*')
      .eq('id', id);
    if (fetchError) return handleDbError(res, fetchError);
    if (!existingRows.length) return res.status(404).json({ error: 'item não encontrado' });
    const oldRow = existingRows[0];

    const { data, error } = await req.supabase
      .from('tires')
      .update(toRow(value, req.userId))
      .eq('id', id)
      .select();

    if (error) return handleDbError(res, error);
    if (!data.length) return res.status(404).json({ error: 'item não encontrado' });

    await logHistory(req.supabase, req.userId, diffToHistoryEntries(oldRow, data[0]));
    res.json(toApi(data[0]));
  } catch (err) {
    handleDbError(res, err);
  }
});

// DELETE /api/tires/:id — remove um pneu
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: existingRows, error: fetchError } = await req.supabase
      .from('tires')
      .select('*')
      .eq('id', id);
    if (fetchError) return handleDbError(res, fetchError);
    const oldRow = existingRows[0];

    const { error } = await req.supabase.from('tires').delete().eq('id', id);
    if (error) return handleDbError(res, error);

    if (oldRow) {
      await logHistory(req.supabase, req.userId, [{
        tireId: oldRow.id, marca: oldRow.marca, medida: oldRow.medida, condicao: oldRow.condicao,
        acao: 'excluido', valorAnterior: oldRow.quantidade,
      }]);
    }
    res.status(204).send();
  } catch (err) {
    handleDbError(res, err);
  }
});

export default router;
