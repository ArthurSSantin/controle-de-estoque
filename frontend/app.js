(function(){
  /* =========================================================================
     CAMADA DE DADOS
     Todas as chamadas ao banco passam por essa API REST (ver pasta /backend).
     O backend fala com o Supabase — o frontend nunca acessa o banco direto.

     Configure a URL da API em config.js (window.APP_CONFIG.apiBase).
  ========================================================================= */
  const API_BASE = (window.APP_CONFIG && window.APP_CONFIG.apiBase) || 'http://localhost:3000/api';

  async function authHeaders(){
    const token = await window.getAccessToken();
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    };
  }

  const api = {
    async list(){
      const res = await fetch(`${API_BASE}/tires`, { headers: await authHeaders() });
      if(!res.ok) throw new Error('Falha ao carregar o estoque');
      return res.json();
    },
    async create(tire){
      const res = await fetch(`${API_BASE}/tires`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify(tire)
      });
      if(!res.ok) throw new Error('Falha ao criar item');
      return res.json();
    },
    async bulkCreate(items){
      const res = await fetch(`${API_BASE}/tires/bulk`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ items })
      });
      if(!res.ok) throw new Error('Falha ao criar itens em lote');
      return res.json();
    },
    async update(id, tire){
      const res = await fetch(`${API_BASE}/tires/${id}`, {
        method: 'PUT',
        headers: await authHeaders(),
        body: JSON.stringify(tire)
      });
      if(!res.ok) throw new Error('Falha ao atualizar item');
      return res.json();
    },
    async remove(id){
      const res = await fetch(`${API_BASE}/tires/${id}`, {
        method: 'DELETE',
        headers: await authHeaders()
      });
      if(!res.ok) throw new Error('Falha ao excluir item');
    }
  };

  /* ========================================================================= */

  let tires = [];
  let editingId = null;
  let searchTerm = '';
  let filterNovoOnly = false;
  let condFilter = 'todos'; // 'todos' | 'novo' | 'usado'
  let html5QrCode = null;
  let scannedNota = null; // { chave, raw }
  let batchRowCount = 0;

  const contentEl = document.getElementById('content');
  const statsEl = document.getElementById('stats');
  const formPanel = document.getElementById('formPanel');
  const scanPanel = document.getElementById('scanPanel');
  const formTitle = document.getElementById('formTitle');
  const formErr = document.getElementById('formErr');
  const toast = document.getElementById('toast');
  const novoChip = document.getElementById('novoChip');
  const novoCount = document.getElementById('novoCount');

  const fMarca = document.getElementById('fMarca');
  const fMedida = document.getElementById('fMedida');
  const fQtd = document.getElementById('fQtd');
  const fPreco = document.getElementById('fPreco');
  const fCondicao = document.getElementById('fCondicao');

  function showToast(msg){
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(()=>toast.classList.remove('show'), 2400);
  }

  function parseAro(medida){
    const m = /R\s*-?\s*(\d{2})/i.exec(medida || '');
    return m ? parseInt(m[1],10) : null;
  }

  async function load(){
    try{
      tires = await api.list();
    }catch(e){
      tires = [];
      showToast('Não foi possível conectar à API. Verifique se o backend está rodando.');
    }
    render();
  }

  function formatPrice(v){
    if(v === undefined || v === null || v === '') return '';
    const n = Number(v);
    if(isNaN(n)) return v;
    return n.toLocaleString('pt-BR', {style:'currency', currency:'BRL'});
  }

  function timeAgo(ts){
    if(!ts) return '';
    const diffMin = Math.floor((Date.now()-ts)/60000);
    if(diffMin < 1) return 'agora';
    if(diffMin < 60) return `${diffMin} min atrás`;
    const diffH = Math.floor(diffMin/60);
    if(diffH < 24) return `${diffH}h atrás`;
    return `${Math.floor(diffH/24)}d atrás`;
  }

  function renderStats(){
    const totalItens = tires.length;
    const totalUnidades = tires.reduce((s,t)=>s + (Number(t.quantidade)||0), 0);
    const baixoEstoque = tires.filter(t => (Number(t.quantidade)||0) <= 2).length;
    statsEl.innerHTML = `
      <div class="stat"><b>${totalItens}</b><span>Itens cadastrados</span></div>
      <div class="stat"><b>${totalUnidades}</b><span>Unidades em estoque</span></div>
      <div class="stat"><b>${baixoEstoque}</b><span>Com estoque baixo (≤2)</span></div>
    `;
    const novos = tires.filter(t=>t.novo).length;
    novoCount.textContent = novos;
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  function render(){
    renderStats();

    let list = tires.slice();

    if(filterNovoOnly){
      list = list.filter(t => t.novo);
    }

    if(condFilter !== 'todos'){
      list = list.filter(t => (t.condicao || 'novo') === condFilter);
    }

    if(searchTerm){
      const q = searchTerm.toLowerCase();
      if(q === 'novo' || q === 'novos' || q === 'tag:novo'){
        list = list.filter(t => t.novo);
      } else {
        list = list.filter(t =>
          (t.marca||'').toLowerCase().includes(q) ||
          (t.medida||'').toLowerCase().includes(q) ||
          (t.notaRef||'').toLowerCase().includes(q)
        );
      }
    }

    novoChip.classList.toggle('active', filterNovoOnly);
    document.querySelectorAll('#condFilterGroup .chip').forEach(c=>{
      c.classList.toggle('active', c.dataset.cond === condFilter);
    });

    if(tires.length === 0){
      contentEl.innerHTML = `
        <div class="empty">
          <div class="brand-mark"></div>
          <h3>Nenhum pneu cadastrado</h3>
          <p>Adicione o primeiro item para começar a controlar seu estoque.</p>
          <button class="btn btn-primary" id="emptyAddBtn">+ Novo pneu</button>
        </div>`;
      document.getElementById('emptyAddBtn').onclick = openAddForm;
      return;
    }

    if(list.length === 0){
      contentEl.innerHTML = `
        <div class="empty">
          <h3>Nada encontrado</h3>
          <p>Nenhum item corresponde ao filtro atual.</p>
        </div>`;
      return;
    }

    // agrupa por aro (R13 -> R20), sem aro identificado por último
    const groups = {};
    list.forEach(t=>{
      const aro = parseAro(t.medida);
      const key = aro ? aro : 'other';
      if(!groups[key]) groups[key] = [];
      groups[key].push(t);
    });

    const orderedKeys = Object.keys(groups).sort((a,b)=>{
      if(a === 'other') return 1;
      if(b === 'other') return -1;
      return Number(a) - Number(b);
    });

    let html = '';
    orderedKeys.forEach(key=>{
      const items = groups[key].sort((a,b)=>{
        const m = (a.marca||'').localeCompare(b.marca||'', 'pt-BR');
        if(m !== 0) return m;
        return (a.medida||'').localeCompare(b.medida||'', 'pt-BR');
      });
      const label = key === 'other' ? 'Sem aro definido' : `R${key}`;
      html += `<div class="group">
        <div class="group-head">
          <div class="tire-badge"><span>${key === 'other' ? '—' : 'R'+key}</span></div>
          <h3>${label}</h3>
          <span class="group-count">${items.length} ${items.length===1?'item':'itens'}</span>
        </div>`;
      items.forEach(t=>{
        const qtd = Number(t.quantidade)||0;
        const low = qtd <= 2;
        html += `
          <div class="row ${t.novo?'is-novo':''}" data-id="${t.id}">
            <div class="col col-brand">
              <label class="mobile-label">Marca</label>
              ${escapeHtml(t.marca || '—')}
              <span class="tag-cond ${t.condicao === 'usado' ? 'usado' : 'novo'}">${t.condicao === 'usado' ? 'Usado' : 'Novo'}</span>
              ${t.novo ? `<span class="tag-novo" title="Adicionado ${timeAgo(t.addedAt)}">recente</span>` : ''}
            </div>
            <div class="col col-size">
              <label class="mobile-label">Medida</label>
              ${escapeHtml(t.medida || '—')}
            </div>
            <div class="col">
              <label class="mobile-label">Qtd.</label>
              <span class="qty-pill ${low?'low':''}">${qtd} un.</span>
            </div>
            <div class="col col-price">
              <label class="mobile-label">Preço</label>
              ${formatPrice(t.preco) || '—'}
            </div>
            <div class="col col-actions">
              ${t.novo ? `<button class="icon-btn check-btn" title="Marcar como visto" data-id="${t.id}">✓</button>` : ''}
              <button class="icon-btn edit-btn" title="Editar" data-id="${t.id}">✎</button>
              <button class="icon-btn del-btn" title="Excluir" data-id="${t.id}">🗑</button>
            </div>
          </div>`;
      });
      html += `</div>`;
    });

    contentEl.innerHTML = html;

    contentEl.querySelectorAll('.edit-btn').forEach(btn=>{
      btn.onclick = ()=> openEditForm(btn.dataset.id);
    });
    contentEl.querySelectorAll('.del-btn').forEach(btn=>{
      btn.onclick = ()=> confirmDelete(btn);
    });
    contentEl.querySelectorAll('.check-btn').forEach(btn=>{
      btn.onclick = ()=> markViewed(btn.dataset.id);
    });
  }

  async function markViewed(id){
    const t = tires.find(x=>x.id===id);
    if(!t) return;
    const updated = { ...t, novo: false };
    try{
      await api.update(id, updated);
      t.novo = false;
      render();
      showToast('Item marcado como visto.');
    }catch(e){
      showToast('Não foi possível salvar. Tente novamente.');
    }
  }

  function confirmDelete(btn){
    if(btn.classList.contains('confirm')){
      deleteTire(btn.dataset.id);
      return;
    }
    const original = btn.innerHTML;
    btn.classList.add('confirm');
    btn.innerHTML = 'Confirmar';
    setTimeout(()=>{
      if(btn.classList.contains('confirm')){
        btn.classList.remove('confirm');
        btn.innerHTML = original;
      }
    }, 3000);
  }

  async function deleteTire(id){
    try{
      await api.remove(id);
      tires = tires.filter(t => t.id !== id);
      render();
      showToast('Pneu removido do estoque.');
    }catch(e){
      showToast('Não foi possível excluir. Tente novamente.');
    }
  }

  /* ---------- FORMULÁRIO MANUAL ---------- */

  function openAddForm(){
    closeScanPanel();
    editingId = null;
    formTitle.textContent = 'Adicionar pneu';
    fMarca.value = ''; fMedida.value = ''; fQtd.value = ''; fPreco.value = ''; fCondicao.value = 'novo';
    formErr.classList.remove('show');
    formPanel.classList.add('open');
    fMarca.focus();
  }

  function openEditForm(id){
    closeScanPanel();
    const t = tires.find(x=>x.id===id);
    if(!t) return;
    editingId = id;
    formTitle.textContent = 'Editar pneu';
    fMarca.value = t.marca || '';
    fMedida.value = t.medida || '';
    fQtd.value = t.quantidade ?? '';
    fPreco.value = t.preco ?? '';
    fCondicao.value = t.condicao === 'usado' ? 'usado' : 'novo';
    formErr.classList.remove('show');
    formPanel.classList.add('open');
    fMarca.focus();
  }

  function closeForm(){
    formPanel.classList.remove('open');
    editingId = null;
    formErr.classList.remove('show');
  }

  function validMedida(medida){
    return /R\s*-?\s*(1[3-9]|20)\b/i.test(medida || '');
  }

  async function saveTire(){
    const marca = fMarca.value.trim();
    const medida = fMedida.value.trim();
    const qtd = fQtd.value.trim();
    const preco = fPreco.value.trim();
    const condicao = fCondicao.value;

    if(!marca || !medida || qtd === ''){
      formErr.textContent = 'Preencha marca, medida e quantidade.';
      formErr.classList.add('show');
      return;
    }
    if(!validMedida(medida)){
      formErr.textContent = 'Informe o aro no formato R13 a R20 (ex: 185/65 R14).';
      formErr.classList.add('show');
      return;
    }
    if(isNaN(Number(qtd)) || Number(qtd) < 0){
      formErr.textContent = 'Quantidade inválida.';
      formErr.classList.add('show');
      return;
    }

    try{
      if(editingId){
        const t = tires.find(x=>x.id===editingId);
        const updated = { ...t, marca, medida, quantidade: Number(qtd), preco, condicao };
        await api.update(editingId, updated);
        Object.assign(t, updated);
      } else {
        const created = await api.create({
          marca, medida, quantidade: Number(qtd), preco, condicao,
          novo: true, notaRef: null
        });
        tires.push(created);
      }
      closeForm();
      render();
      showToast(editingId ? 'Pneu atualizado.' : 'Pneu adicionado ao estoque.');
    }catch(e){
      formErr.textContent = 'Não foi possível salvar. Verifique sua conexão com a API.';
      formErr.classList.add('show');
    }
  }

  /* ---------- ENTRADA POR NOTA FISCAL (SCANNER) ---------- */

  function openScanPanel(){
    closeForm();
    scanPanel.classList.add('open');
    document.getElementById('scanStage').style.display = 'block';
    document.getElementById('notaResult').style.display = 'none';
    scannedNota = null;
    startScanner();
  }

  function closeScanPanel(){
    scanPanel.classList.remove('open');
    stopScanner();
  }

  function startScanner(){
    if(typeof Html5Qrcode === 'undefined'){
      document.querySelector('#scanStage .scan-hint').textContent =
        'Não foi possível carregar o leitor de câmera. Verifique sua conexão.';
      return;
    }
    html5QrCode = new Html5Qrcode("reader");
    html5QrCode.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: 240 },
      onScanSuccess,
      ()=>{ /* leitura em andamento, ignora frames sem código */ }
    ).catch(()=>{
      document.querySelector('#scanStage .scan-hint').textContent =
        'Não foi possível acessar a câmera. Verifique as permissões do navegador.';
    });
  }

  function stopScanner(){
    if(html5QrCode){
      html5QrCode.stop().catch(()=>{});
      html5QrCode.clear();
      html5QrCode = null;
    }
  }

  function onScanSuccess(decodedText){
    stopScanner();
    // a chave de acesso da NFe/NFC-e tem 44 dígitos, geralmente dentro da URL do QR Code
    const digits = (decodedText.match(/\d/g) || []).join('');
    const chaveMatch = /\d{44}/.exec(digits);
    scannedNota = {
      chave: chaveMatch ? chaveMatch[0] : null,
      raw: decodedText
    };
    document.getElementById('scanStage').style.display = 'none';
    document.getElementById('notaResult').style.display = 'block';
    document.getElementById('notaChaveShown').textContent =
      scannedNota.chave ? scannedNota.chave.slice(-8) + ' (final)' : 'não identificada — código lido: ' + decodedText.slice(0,30);

    document.getElementById('batchRows').innerHTML = '';
    batchRowCount = 0;
    addBatchRow();
    showToast('Código lido. Informe os itens recebidos.');
  }

  function addBatchRow(){
    batchRowCount++;
    const id = 'b' + batchRowCount;
    const div = document.createElement('div');
    div.className = 'batch-row';
    div.dataset.rowId = id;
    div.innerHTML = `
      <div class="field"><label>Marca / modelo</label><input type="text" class="b-marca" placeholder="Ex: Goodyear Assurance"></div>
      <div class="field"><label>Medida</label><input type="text" class="b-medida" placeholder="Ex: 195/60 R15"></div>
      <div class="field"><label>Qtd.</label><input type="number" class="b-qtd" min="0" step="1" placeholder="0"></div>
      <div class="field"><label>Preço (R$)</label><input type="text" class="b-preco" placeholder="Opcional"></div>
      <div class="field"><label>Condição</label>
        <select class="b-condicao">
          <option value="novo">Novo</option>
          <option value="usado">Usado</option>
        </select>
      </div>
      <button class="rm" title="Remover linha">✕</button>
    `;
    div.querySelector('.rm').onclick = ()=> div.remove();
    document.getElementById('batchRows').appendChild(div);
  }

  async function saveBatch(){
    const rows = document.querySelectorAll('#batchRows .batch-row');
    const batchErr = document.getElementById('batchErr');
    batchErr.classList.remove('show');

    const newItems = [];
    for(const row of rows){
      const marca = row.querySelector('.b-marca').value.trim();
      const medida = row.querySelector('.b-medida').value.trim();
      const qtd = row.querySelector('.b-qtd').value.trim();
      const preco = row.querySelector('.b-preco').value.trim();
      const condicao = row.querySelector('.b-condicao').value;
      if(!marca && !medida && !qtd) continue; // linha vazia, ignora
      if(!marca || !medida || qtd === '' || !validMedida(medida)){
        batchErr.textContent = 'Verifique se todas as linhas têm marca, medida válida (R13–R20) e quantidade.';
        batchErr.classList.add('show');
        return;
      }
      newItems.push({
        marca, medida, quantidade: Number(qtd), preco, condicao,
        novo: true,
        notaRef: scannedNota && scannedNota.chave ? scannedNota.chave.slice(-8) : 'nota s/ chave'
      });
    }

    if(newItems.length === 0){
      batchErr.textContent = 'Adicione pelo menos um item.';
      batchErr.classList.add('show');
      return;
    }

    try{
      const created = await api.bulkCreate(newItems);
      tires.push(...created);
      closeScanPanel();
      render();
      showToast(`${created.length} item(ns) adicionados a partir da nota.`);
    }catch(e){
      batchErr.textContent = 'Não foi possível salvar os itens. Verifique sua conexão com a API.';
      batchErr.classList.add('show');
    }
  }

  /* ---------- EVENTOS ---------- */

  document.getElementById('toggleFormBtn').onclick = ()=>{
    if(formPanel.classList.contains('open')){ closeForm(); }
    else { openAddForm(); }
  };
  document.getElementById('cancelBtn').onclick = closeForm;
  document.getElementById('saveBtn').onclick = saveTire;

  document.getElementById('scanBtn').onclick = ()=>{
    if(scanPanel.classList.contains('open')){ closeScanPanel(); }
    else { openScanPanel(); }
  };
  document.getElementById('rescanBtn').onclick = ()=>{
    document.getElementById('scanStage').style.display = 'block';
    document.getElementById('notaResult').style.display = 'none';
    document.querySelector('#scanStage .scan-hint').textContent = 'Aguardando leitura...';
    startScanner();
  };
  document.getElementById('cancelBatchBtn').onclick = closeScanPanel;
  document.getElementById('addBatchRowBtn').onclick = addBatchRow;
  document.getElementById('saveBatchBtn').onclick = saveBatch;

  document.getElementById('searchInput').oninput = (e)=>{
    searchTerm = e.target.value;
    render();
  };
  document.getElementById('clearSearchBtn').onclick = ()=>{
    searchTerm = '';
    filterNovoOnly = false;
    condFilter = 'todos';
    document.getElementById('searchInput').value = '';
    render();
  };
  novoChip.onclick = ()=>{
    filterNovoOnly = !filterNovoOnly;
    render();
  };
  document.querySelectorAll('#condFilterGroup .chip').forEach(chip=>{
    chip.onclick = ()=>{
      condFilter = chip.dataset.cond;
      render();
    };
  });

  window.__bootApp = load;
})();
