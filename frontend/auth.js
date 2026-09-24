(function(){
  const cfg = window.APP_CONFIG || {};
  const auth = window.AuthClient.create(cfg.supabaseUrl, cfg.supabaseAnonKey);

  // Usado pelo app.js para anexar o token em cada chamada à API.
  window.getAccessToken = async function(){
    const { data } = await auth.getSession();
    return data.session ? data.session.access_token : null;
  };

  const bootLoading = document.getElementById('bootLoading');
  const authScreen = document.getElementById('authScreen');
  const appScreen = document.getElementById('appScreen');
  const userEmailEl = document.getElementById('userEmail');

  const loginForm = document.getElementById('loginForm');
  const signupForm = document.getElementById('signupForm');
  const loginErr = document.getElementById('loginErr');
  const signupErr = document.getElementById('signupErr');

  let appStarted = false;

  function showAuth(){
    bootLoading.style.display = 'none';
    authScreen.style.display = 'flex';
    appScreen.style.display = 'none';
    // Deslogou (ou nunca logou): a marca volta pro padrão na hora, pra
    // próxima conta que entrar neste navegador não herdar a de quem saiu.
    if(window.Branding) window.Branding.reset();
    // Sem isso, entrar com OUTRA conta na mesma aba reaproveitava o app já
    // iniciado: a tela continuava com o estoque e a personalização de quem
    // saiu até alguém recarregar a página na mão.
    appStarted = false;
  }

  function showApp(user){
    bootLoading.style.display = 'none';
    authScreen.style.display = 'none';
    appScreen.style.display = 'block';
    userEmailEl.textContent = (user && user.email) || '';
    // Nome e logo são por conta: aplica o que estiver em cache pra ESTE
    // usuário já na abertura; o app.js confirma depois com a API.
    if(window.Branding) window.Branding.setUser(user && user.id);
    if(!appStarted){
      appStarted = true;
      // Sessão salva resolve sem rede, às vezes antes do app.js rodar:
      // aí só marca, e o app.js carrega o estoque ao terminar de carregar.
      if(typeof window.__bootApp === 'function') window.__bootApp();
      else window.__bootPending = true;
    }
  }

  const authEyebrow = document.getElementById('authEyebrow');
  const showSignupBtn = document.getElementById('showSignup');
  const showLoginBtn = document.getElementById('showLogin');

  showSignupBtn.onclick = (e)=>{
    e.preventDefault();
    loginForm.style.display = 'none';
    signupForm.style.display = 'block';
    showSignupBtn.classList.add('active');
    showLoginBtn.classList.remove('active');
    if (authEyebrow) authEyebrow.textContent = 'Comece agora';
  };
  showLoginBtn.onclick = (e)=>{
    e.preventDefault();
    signupForm.style.display = 'none';
    loginForm.style.display = 'block';
    showLoginBtn.classList.add('active');
    showSignupBtn.classList.remove('active');
    if (authEyebrow) authEyebrow.textContent = 'Bem-vindo de volta';
  };

  loginForm.addEventListener('submit', async (e)=>{
    e.preventDefault();
    loginErr.classList.remove('show');
    const btn = loginForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const { error } = await auth.signInWithPassword({ email, password });
    btn.disabled = false;
    if(error){
      loginErr.textContent = error.message.includes('Invalid login')
        ? 'E-mail ou senha incorretos.'
        : error.status === 429
          ? 'Muitas tentativas em sequência. Aguarde alguns minutos e tente de novo.'
          : 'Não foi possível entrar. Tente novamente.';
      loginErr.classList.add('show');
    }
  });

  signupForm.addEventListener('submit', async (e)=>{
    e.preventDefault();
    signupErr.classList.remove('show');
    signupErr.style.color = '';
    const btn = signupForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    const email = document.getElementById('signupEmail').value.trim();
    const password = document.getElementById('signupPassword').value;
    if(password.length < 6){
      signupErr.textContent = 'A senha precisa ter pelo menos 6 caracteres.';
      signupErr.classList.add('show');
      btn.disabled = false;
      return;
    }
    const { error } = await auth.signUp({ email, password });
    btn.disabled = false;
    if(error){
      signupErr.textContent = error.message.includes('already registered')
        ? 'Este e-mail já tem uma conta. Faça login.'
        : error.status === 429
          ? 'Muitas tentativas em sequência. Aguarde alguns minutos e tente de novo.'
          : 'Não foi possível criar a conta. Tente novamente.';
      signupErr.classList.add('show');
      return;
    }
    signupErr.textContent = 'Conta criada! Verifique seu e-mail para confirmar antes de entrar.';
    signupErr.style.color = 'var(--green)';
    signupErr.classList.add('show');
  });

  document.getElementById('logoutBtn').onclick = async ()=>{
    await auth.signOut();
  };

  auth.onAuthStateChange((event, session)=>{
    if(session){
      showApp(session.user);
    } else {
      showAuth();
    }
  });

  // Verificação inicial da sessão ao carregar a página.
  auth.getSession().then(({ data })=>{
    if(data.session){
      showApp(data.session.user);
    } else {
      showAuth();
    }
  });
})();
