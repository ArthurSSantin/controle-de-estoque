// Configuração do frontend.
// Em desenvolvimento local, aponta para o backend rodando na sua máquina.
// Quando publicar o backend (Render, Railway, Fly.io, etc.), troque pela URL pública dele.
window.APP_CONFIG = {
  apiBase: 'http://localhost:3000/api'
};
