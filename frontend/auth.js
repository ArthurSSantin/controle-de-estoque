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
  const recoverForm = document.getElementById('recoverForm');
  const newPasswordForm = document.getElementById('newPasswordForm');
  const loginErr = document.getElementById('loginErr');
  const signupErr = document.getElementById('signupErr');
  const recoverErr = document.getElementById('recoverErr');
  const newPasswordErr = document.getElementById('newPasswordErr');

  let appStarted = false;

  // Quem chega pelo link de "esqueci minha senha" já vem logado pelo
  // Supabase, mas tem que criar a senha nova antes de entrar no app. A
  // marca fica no sessionStorage pra sobreviver a um recarregar da página.
  const RECOVERY_FLAG = 'auth-password-recovery';
  function isRecovering(){
    try { return sessionStorage.getItem(RECOVERY_FLAG) === '1'; } catch(e){ return false; }
  }
  function setRecovering(on){
    try {
      if(on) sessionStorage.setItem(RECOVERY_FLAG, '1');
      else sessionStorage.removeItem(RECOVERY_FLAG);
    } catch(e){ /* storage bloqueado: vale só nesta tela */ }
  }

  function showAuth(){
    bootLoading.style.display = 'none';
    authScreen.style.display = 'flex';
    appScreen.style.display = 'none';
    // saiu (ou cancelou) no meio da troca de senha: volta pro login
    if(newPasswordForm.style.display !== 'none') showForm('login');
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

  function showNewPassword(user){
    bootLoading.style.display = 'none';
    authScreen.style.display = 'flex';
    appScreen.style.display = 'none';
    if(window.Branding) window.Branding.reset();
    appStarted = false;
    document.getElementById('newPasswordEmail').textContent = (user && user.email) || 'sua conta';
    if(newPasswordForm.style.display === 'none'){
      showForm('newPassword');
      document.getElementById('newPassword').focus();
    }
  }

  // Decide a tela a partir da sessão.
  function route(session){
    if(!session) showAuth();
    else if(isRecovering()) showNewPassword(session.user);
    else showApp(session.user);
  }

  const authEyebrow = document.getElementById('authEyebrow');
  const authTabs = document.getElementById('authTabs');
  const showSignupBtn = document.getElementById('showSignup');
  const showLoginBtn = document.getElementById('showLogin');

  const FORMS = {
    login: { el: loginForm, eyebrow: 'Bem-vindo de volta', tabs: true },
    signup: { el: signupForm, eyebrow: 'Comece agora', tabs: true },
    recover: { el: recoverForm, eyebrow: 'Recuperar senha', tabs: false },
    newPassword: { el: newPasswordForm, eyebrow: 'Nova senha', tabs: false },
  };
  function showForm(name){
    Object.keys(FORMS).forEach((k)=>{ FORMS[k].el.style.display = k === name ? 'block' : 'none'; });
    [loginErr, signupErr, recoverErr, newPasswordErr].forEach((el)=> el.classList.remove('show', 'ok'));
    authTabs.style.display = FORMS[name].tabs ? '' : 'none';
    showLoginBtn.classList.toggle('active', name === 'login');
    showSignupBtn.classList.toggle('active', name === 'signup');
    if (authEyebrow) authEyebrow.textContent = FORMS[name].eyebrow;
  }

  showSignupBtn.onclick = (e)=>{ e.preventDefault(); showForm('signup'); };
  showLoginBtn.onclick = (e)=>{ e.preventDefault(); showForm('login'); };

  /* ---------- recuperar senha ---------- */

  document.getElementById('showRecover').onclick = ()=>{
    // aproveita o e-mail que a pessoa já digitou no login
    document.getElementById('recoverEmail').value = document.getElementById('loginEmail').value.trim();
    showForm('recover');
    document.getElementById('recoverEmail').focus();
  };
  document.getElementById('backToLogin').onclick = ()=> showForm('login');

  recoverForm.addEventListener('submit', async (e)=>{
    e.preventDefault();
    recoverErr.classList.remove('show', 'ok');
    const btn = recoverForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    const email = document.getElementById('recoverEmail').value.trim();
    // o link do e-mail volta pra esta mesma página
    const redirectTo = window.location.origin + window.location.pathname;
    const { error } = await auth.resetPasswordForEmail(email, { redirectTo });
    btn.disabled = false;
    if(error){
      recoverErr.textContent = error.status === 429
        ? 'Aguarde um minuto antes de pedir outro link.'
        : error.network
          ? 'Sem conexão com o servidor. Verifique a internet e tente de novo.'
          : 'Não foi possível enviar o link. Confira o e-mail e tente novamente.';
      recoverErr.classList.add('show');
      return;
    }
    // Mesma resposta exista ou não a conta — não dá pra descobrir por aqui
    // quais e-mails estão cadastrados.
    recoverErr.textContent = 'Pronto! Se existir uma conta com esse e-mail, o link chega em instantes. Confira também a caixa de spam.';
    recoverErr.classList.add('show', 'ok');
  });

  newPasswordForm.addEventListener('submit', async (e)=>{
    e.preventDefault();
    newPasswordErr.classList.remove('show', 'ok');
    const password = document.getElementById('newPassword').value;
    const confirm = document.getElementById('newPasswordConfirm').value;
    if(password.length < 6){
      newPasswordErr.textContent = 'A senha precisa ter pelo menos 6 caracteres.';
      newPasswordErr.classList.add('show');
      return;
    }
    if(password !== confirm){
      newPasswordErr.textContent = 'As duas senhas não são iguais.';
      newPasswordErr.classList.add('show');
      return;
    }
    const btn = newPasswordForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    const { data, error } = await auth.updateUser({ password });
    if(error){
      btn.disabled = false;
      newPasswordErr.textContent = error.code === 'same_password' || /different from the old/i.test(error.message)
        ? 'A nova senha precisa ser diferente da atual.'
        : error.code === 'weak_password'
          ? 'Senha fraca demais. Use uma senha maior, misturando letras e números.'
          : error.status === 401 || error.status === 403
            ? 'O link expirou. Volte ao login e peça um novo em "Esqueci minha senha".'
            : error.status === 429
              ? 'Muitas tentativas em sequência. Aguarde alguns minutos e tente de novo.'
              : 'Não foi possível salvar a senha. Tente novamente.';
      newPasswordErr.classList.add('show');
      return;
    }
    setRecovering(false);
    newPasswordErr.textContent = 'Senha alterada! Entrando...';
    newPasswordErr.classList.add('show', 'ok');
    document.getElementById('newPassword').value = '';
    document.getElementById('newPasswordConfirm').value = '';
    setTimeout(()=>{
      btn.disabled = false;
      showApp(data.user);
    }, 1200);
  });

  document.getElementById('cancelNewPassword').onclick = async ()=>{
    setRecovering(false);
    await auth.signOut();
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
    if(event === 'PASSWORD_RECOVERY') setRecovering(true);
    if(event === 'SIGNED_IN' || event === 'SIGNED_OUT') setRecovering(false);
    // a sessão muda durante a troca de senha (USER_UPDATED): quem decide a
    // tela ali é o próprio formulário
    if(event === 'USER_UPDATED') return;
    route(session);
  });

  // Verificação inicial da sessão ao carregar a página.
  auth.getSession().then(async ({ data })=>{
    route(data.session);
    // link de e-mail vencido ou já usado
    const urlError = await auth.takeUrlError();
    if(urlError && !data.session){
      showForm('login');
      loginErr.textContent = /expired|invalid/i.test(urlError.code + ' ' + urlError.message)
        ? 'O link do e-mail expirou ou já foi usado. Se era para trocar a senha, clique em "Esqueci minha senha" e peça outro.'
        : 'Não foi possível validar o link do e-mail. Tente de novo.';
      loginErr.classList.add('show');
    }
  });
})();
