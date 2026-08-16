(function(){
  const cfg = window.APP_CONFIG || {};
  const supabase = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  window.__supabaseAuth = supabase.auth;

  // Usado pelo app.js para anexar o token em cada chamada à API.
  window.getAccessToken = async function(){
    const { data } = await supabase.auth.getSession();
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
  }

  function showApp(email){
    bootLoading.style.display = 'none';
    authScreen.style.display = 'none';
    appScreen.style.display = 'block';
    userEmailEl.textContent = email || '';
    if(!appStarted && typeof window.__bootApp === 'function'){
      appStarted = true;
      window.__bootApp();
    }
  }

  document.getElementById('showSignup').onclick = (e)=>{
    e.preventDefault();
    loginForm.style.display = 'none';
    signupForm.style.display = 'block';
  };
  document.getElementById('showLogin').onclick = (e)=>{
    e.preventDefault();
    signupForm.style.display = 'none';
    loginForm.style.display = 'block';
  };

  loginForm.addEventListener('submit', async (e)=>{
    e.preventDefault();
    loginErr.classList.remove('show');
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if(error){
      loginErr.textContent = error.message.includes('Invalid login')
        ? 'E-mail ou senha incorretos.'
        : 'Não foi possível entrar. Tente novamente.';
      loginErr.classList.add('show');
    }
  });

  signupForm.addEventListener('submit', async (e)=>{
    e.preventDefault();
    signupErr.classList.remove('show');
    const email = document.getElementById('signupEmail').value.trim();
    const password = document.getElementById('signupPassword').value;
    if(password.length < 6){
      signupErr.textContent = 'A senha precisa ter pelo menos 6 caracteres.';
      signupErr.classList.add('show');
      return;
    }
    const { error } = await supabase.auth.signUp({ email, password });
    if(error){
      signupErr.textContent = error.message.includes('already registered')
        ? 'Este e-mail já tem uma conta. Faça login.'
        : 'Não foi possível criar a conta. Tente novamente.';
      signupErr.classList.add('show');
      return;
    }
    signupErr.textContent = 'Conta criada! Verifique seu e-mail para confirmar antes de entrar.';
    signupErr.style.color = 'var(--green)';
    signupErr.classList.add('show');
  });

  document.getElementById('logoutBtn').onclick = async ()=>{
    await supabase.auth.signOut();
  };

  supabase.auth.onAuthStateChange((event, session)=>{
    if(session){
      showApp(session.user.email);
    } else {
      showAuth();
    }
  });

  // Verificação inicial da sessão ao carregar a página.
  supabase.auth.getSession().then(({ data })=>{
    if(data.session){
      showApp(data.session.user.email);
    } else {
      showAuth();
    }
  });
})();
