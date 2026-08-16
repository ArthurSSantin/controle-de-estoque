import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// Todas as rotas de pneus exigem login — o middleware anexa req.supabase
// (já autenticado como o usuário da requisição) e req.userId.
router.use(requireAuth);

function toRow(body, ownerId) {
  return {
    owner_id: ownerId,
    marca: body.marca,
    medida: body.medida,
    quantidade: body.quantidade,
    preco: body.preco ?? null,
    condicao: body.condicao === 'usado' ? 'usado' : 'novo',
    novo: body.novo !== undefined ? body.novo : true,
    nota_ref: body.notaRef ?? null,
  };
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
    addedAt: row.created_at ? new Date(row.created_at).getTime() : null,
  };
}

// GET /api/tires — lista os pneus do usuário logado
// (a política de RLS já restringe isso sozinha, mas o filtro aqui deixa explícito)
router.get('/', async (req, res) => {
  const { data, error } = await req.supabase
    .from('tires')
    .select('*')
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(toApi));
});

// POST /api/tires — cria um pneu do usuário logado
router.post('/', async (req, res) => {
  const { marca, medida, quantidade } = req.body;
  if (!marca || !medida || quantidade === undefined) {
    return res.status(400).json({ error: 'marca, medida e quantidade são obrigatórios' });
  }

  const { data, error } = await req.supabase
    .from('tires')
    .insert([toRow(req.body, req.userId)])
    .select();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(toApi(data[0]));
});

// POST /api/tires/bulk — cria vários pneus de uma vez (ex: entrada por nota fiscal)
router.post('/bulk', async (req, res) => {
  const items = req.body.items;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'envie { items: [...] } com ao menos um item' });
  }

  const rows = items.map((i) => toRow(i, req.userId));
  const { data, error } = await req.supabase.from('tires').insert(rows).select();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data.map(toApi));
});

// PUT /api/tires/:id — atualiza um pneu (edição ou marcar como visto)
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { data, error } = await req.supabase
    .from('tires')
    .update(toRow(req.body, req.userId))
    .eq('id', id)
    .select();

  if (error) return res.status(500).json({ error: error.message });
  if (!data.length) return res.status(404).json({ error: 'item não encontrado' });
  res.json(toApi(data[0]));
});

// DELETE /api/tires/:id — remove um pneu
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await req.supabase.from('tires').delete().eq('id', id);

  if (error) return res.status(500).json({ error: error.message });
  res.status(204).send();
});

export default router;
