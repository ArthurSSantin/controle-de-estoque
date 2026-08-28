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
// mais recente primeiro. ?limit= controla quantas linhas voltam (padrão 200).
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || DEFAULT_LIMIT, MAX_LIMIT);

    const { data, error } = await req.supabase
      .from('tire_history')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) return handleDbError(res, error);
    res.json(data.map(toApi));
  } catch (err) {
    handleDbError(res, err);
  }
});

export default router;
