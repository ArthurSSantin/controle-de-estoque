import { supabaseAnon, supabaseForUser } from '../supabaseClient.js';

// Exige um token válido do Supabase Auth no header Authorization.
// Se for válido, anexa em req.supabase um cliente já "carimbado" com o
// usuário logado (usado pelas rotas) e em req.userId o id desse usuário.
export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Não autenticado. Faça login novamente.' });
  }

  const { data, error } = await supabaseAnon.auth.getUser(token);
  if (error || !data.user) {
    return res.status(401).json({ error: 'Sessão inválida ou expirada. Faça login novamente.' });
  }

  req.userId = data.user.id;
  req.supabase = supabaseForUser(token);
  next();
}
