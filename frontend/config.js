// Configuração do frontend.
// Em desenvolvimento local, aponta para o backend rodando na sua máquina.
// Quando publicar o backend (Render, Railway, Fly.io, etc.), troque pela URL pública dele.
window.APP_CONFIG = {
  apiBase: 'https://controle-de-estoque-914p.onrender.com/api',

  // Mesmos dados usados no backend/.env — aqui é seguro expor, pois é a
  // chave "anon" (pública), pensada para rodar no navegador. O acesso aos
  // dados continua protegido pelas políticas de RLS no banco.
  supabaseUrl: 'https://oytoeuoehoqdkhnhuuyy.supabase.co',
  supabaseAnonKey: 'sb_publishable_OZizOTVvAV5xAUInXFU2rg_YGjTDxeG'
};
