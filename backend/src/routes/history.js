import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// Todas as rotas de histórico exigem login, igual às de pneus.
router.use(requireAuth);

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 200;

function toApi(row) {
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

function handleDbError(res, error) {
  console.error('Erro no Supabase (history):', error.message);
  return res.status(500).json({ error: 'Não foi possível carregar o histórico.' });
}

// GET /api/history — lista o histórico de movimentações do usuário logado,
// mais recente primeiro.
// ?limit= controla quantas linhas voltam (padrão 200).
// ?tireId= filtra por um pneu específico.
// ?from= / ?to= filtram por período (datas ISO, ex: 2026-01-01).
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || DEFAULT_LIMIT, MAX_LIMIT);

    let query = req.supabase
      .from('tire_history')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (req.query.tireId) query = query.eq('tire_id', String(req.query.tireId));
    if (req.query.from) {
      const from = new Date(String(req.query.from));
      if (!isNaN(from.getTime())) query = query.gte('created_at', from.toISOString());
    }
    if (req.query.to) {
      const to = new Date(String(req.query.to));
      if (!isNaN(to.getTime())) {
        to.setHours(23, 59, 59, 999);
        query = query.lte('created_at', to.toISOString());
      }
    }

    const { data, error } = await query;

    if (error) return handleDbError(res, error);
    res.json(data.map(toApi));
  } catch (err) {
    handleDbError(res, err);
  }
});

export default router;
