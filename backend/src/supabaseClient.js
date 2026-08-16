import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn(
    '⚠️  SUPABASE_URL ou SUPABASE_KEY não configurados.\n' +
    '    Copie backend/.env.example para backend/.env e preencha com os dados do seu projeto Supabase.'
  );
}

// Cliente "genérico", só usado para validar o token de login (auth.getUser).
export const supabaseAnon = createClient(supabaseUrl, supabaseKey);

// Cria um cliente Supabase "carimbado" com o token do usuário logado.
// Com isso, toda query feita por esse cliente roda como aquele usuário —
// e as políticas de RLS do banco (auth.uid() = owner_id) fazem o isolamento
// automaticamente, sem precisar filtrar nada manualmente no código.
export function supabaseForUser(accessToken) {
  return createClient(supabaseUrl, supabaseKey, {
    global: {
      headers: { Authorization: `Bearer ${accessToken}` }
    }
  });
}
