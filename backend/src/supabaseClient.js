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

export const supabase = createClient(supabaseUrl, supabaseKey);
