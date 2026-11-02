// Configuração do frontend.
// Em desenvolvimento local, aponta para o backend rodando na sua máquina.
// Quando publicar o backend (Render, Railway, Fly.io, etc.), troque pela URL pública dele.
window.APP_CONFIG = {
  apiBase: 'https://nshuziaceagrkkzngrrx.supabase.co/functions/v1/api',

  // Mesmos dados usados no backend/.env — aqui é seguro expor, pois é a
  // chave "anon" (pública), pensada para rodar no navegador. O acesso aos
  // dados continua protegido pelas políticas de RLS no banco.
  supabaseUrl: 'https://nshuziaceagrkkzngrrx.supabase.co',
  supabaseAnonKey: 'sb_publishable_SKJh7uc6pz-beHu7T9Dllw_-ki60L0j'
};
