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
  const importPanel = document.getElementById('importPanel');
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
    closeImportPanel();
    editingId = null;
    formTitle.textContent = 'Adicionar pneu';
    fMarca.value = ''; fMedida.value = ''; fQtd.value = ''; fPreco.value = ''; fCondicao.value = 'novo';
    formErr.classList.remove('show');
    formPanel.classList.add('open');
    fMarca.focus();
  }

  function openEditForm(id){
    closeScanPanel();
    closeImportPanel();
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
    closeImportPanel();
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
        'Não foi possível carregar o leitor de câmera. Verifique sua conexão e recarregue a página.';
      return;
    }

    const hint = document.querySelector('#scanStage .scan-hint');
    hint.textContent = 'Solicitando acesso à câmera...';

    html5QrCode = new Html5Qrcode("reader");

    // Busca as câmeras disponíveis e prefere a traseira — mais confiável do que
    // depender só de facingMode, que falha em vários notebooks/desktops.
    Html5Qrcode.getCameras().then(cameras=>{
      if(!cameras || cameras.length === 0){
        hint.textContent = 'Nenhuma câmera encontrada neste dispositivo. Use a opção "Enviar foto do código" abaixo.';
        return;
      }
      const traseira = cameras.find(c => /back|traseir|rear|environment/i.test(c.label));
      const cameraId = (traseira || cameras[cameras.length - 1]).id;

      html5QrCode.start(
        cameraId,
        { fps: 10, qrbox: 240 },
        onScanSuccess,
        ()=>{ /* leitura em andamento, ignora frames sem código */ }
      ).catch(err=>{
        hint.textContent = 'Não foi possível iniciar a câmera (' + (err && err.message ? err.message : 'permissão negada') + '). Use a opção "Enviar foto do código" abaixo.';
      });
    }).catch(err=>{
      hint.textContent = 'Acesso à câmera negado ou indisponível neste navegador. Use a opção "Enviar foto do código" abaixo.';
    });
  }

  function stopScanner(){
    if(html5QrCode){
      html5QrCode.stop().then(()=>html5QrCode.clear()).catch(()=>{
        try{ html5QrCode.clear(); }catch(e){}
      });
      html5QrCode = null;
    }
  }

  function scanFromUploadedFile(file){
    const hint = document.querySelector('#scanStage .scan-hint');
    hint.textContent = 'Lendo código na imagem enviada...';
    stopScanner();
    const fileScanner = new Html5Qrcode("reader");
    fileScanner.scanFile(file, false)
      .then(decodedText=>{
        fileScanner.clear();
        onScanSuccess(decodedText);
      })
      .catch(()=>{
        fileScanner.clear().catch(()=>{});
        hint.textContent = 'Não foi possível ler nenhum código nessa imagem. Tente uma foto mais nítida, focando bem no código de barras/QR.';
      });
  }

  function onScanSuccess(decodedText){
    stopScanner();
    // a chave de acesso da NFe/NFC-e tem 44 dígitos, geralmente dentro da URL do QR Code
    const digits = (decodedText.match(/\d/g) || []).join('');
    const chaveMatch = /\d{44}/.exec(digits);
    const isUrl = /^https?:\/\//i.test(decodedText.trim());
    scannedNota = {
      chave: chaveMatch ? chaveMatch[0] : null,
      raw: decodedText,
      url: isUrl ? decodedText.trim() : null
    };
    document.getElementById('scanStage').style.display = 'none';
    document.getElementById('notaResult').style.display = 'block';
    document.getElementById('notaChaveShown').textContent =
      scannedNota.chave ? scannedNota.chave.slice(-8) + ' (final)' : 'não identificada — código lido: ' + decodedText.slice(0,30);

    const openLinkBtn = document.getElementById('openNotaLinkBtn');
    openLinkBtn.style.display = scannedNota.url ? 'inline-flex' : 'none';

    document.getElementById('batchRows').innerHTML = '';
    batchRowCount = 0;
    addBatchRow('batchRows');
    showToast('Código lido. Informe os itens recebidos.');
  }

  function addBatchRow(containerId, prefill){
    containerId = containerId || 'batchRows';
    prefill = prefill || {};
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
    if(prefill.marca) div.querySelector('.b-marca').value = prefill.marca;
    if(prefill.medida) div.querySelector('.b-medida').value = prefill.medida;
    if(prefill.quantidade !== undefined && prefill.quantidade !== '') div.querySelector('.b-qtd').value = prefill.quantidade;
    if(prefill.preco) div.querySelector('.b-preco').value = prefill.preco;
    if(prefill.condicao === 'usado') div.querySelector('.b-condicao').value = 'usado';
    div.querySelector('.rm').onclick = ()=> div.remove();
    document.getElementById(containerId).appendChild(div);
    return div;
  }

  function collectRows(containerId){
    return document.querySelectorAll(`#${containerId} .batch-row`);
  }

  function rowsToItems(containerId, errEl, notaRefValue){
    const rows = collectRows(containerId);
    const items = [];
    for(const row of rows){
      const marca = row.querySelector('.b-marca').value.trim();
      const medida = row.querySelector('.b-medida').value.trim();
      const qtd = row.querySelector('.b-qtd').value.trim();
      const preco = row.querySelector('.b-preco').value.trim();
      const condicao = row.querySelector('.b-condicao').value;
      if(!marca && !medida && !qtd) continue; // linha vazia, ignora
      if(!marca || !medida || qtd === '' || !validMedida(medida)){
        errEl.textContent = 'Verifique se todas as linhas têm marca, medida válida (R13–R20) e quantidade.';
        errEl.classList.add('show');
        return null;
      }
      items.push({
        marca, medida, quantidade: Number(qtd), preco, condicao,
        novo: true,
        notaRef: notaRefValue
      });
    }
    return items;
  }

  async function saveBatch(){
    const batchErr = document.getElementById('batchErr');
    batchErr.classList.remove('show');

    const notaRefValue = scannedNota && scannedNota.chave ? scannedNota.chave.slice(-8) : 'nota s/ chave';
    const newItems = rowsToItems('batchRows', batchErr, notaRefValue);
    if(newItems === null) return;

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

  /* ---------- IMPORTAR PLANILHA (EXCEL / CSV) ---------- */

  function normalizeHeader(h){
    return String(h||'')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g,'') // remove acentos
      .trim();
  }

  const HEADER_MAP = {
    marca: 'marca', modelo: 'marca',
    medida: 'medida', tamanho: 'medida', aro: 'medida',
    quantidade: 'quantidade', qtd: 'quantidade', qtde: 'quantidade',
    preco: 'preco', valor: 'preco', 'preco unitario': 'preco', 'valor unitario': 'preco',
    condicao: 'condicao', estado: 'condicao'
  };

  function parseSpreadsheet(file){
    return new Promise((resolve, reject)=>{
      if(typeof XLSX === 'undefined'){
        reject(new Error('Biblioteca de planilhas não carregou. Verifique sua conexão e recarregue a página.'));
        return;
      }
      const reader = new FileReader();
      reader.onload = (e)=>{
        try{
          const data = new Uint8Array(e.target.result);
          const workbook = XLSX.read(data, { type: 'array' });
          const sheet = workbook.Sheets[workbook.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
          resolve(rows);
        }catch(err){
          reject(err);
        }
      };
      reader.onerror = ()=> reject(new Error('Não foi possível ler o arquivo.'));
      reader.readAsArrayBuffer(file);
    });
  }

  function mapSpreadsheetRow(row){
    const mapped = {};
    Object.keys(row).forEach(key=>{
      const canonical = HEADER_MAP[normalizeHeader(key)];
      if(canonical) mapped[canonical] = String(row[key]).trim();
    });
    if(mapped.condicao){
      mapped.condicao = /usad/i.test(mapped.condicao) ? 'usado' : 'novo';
    }
    return mapped;
  }

  function openImportPanel(){
    closeForm();
    closeScanPanel();
    importPanel.classList.add('open');
    document.getElementById('importRows').innerHTML = '';
    document.getElementById('importErr').classList.remove('show');
    document.getElementById('importFileInput').value = '';
  }

  function closeImportPanel(){
    importPanel.classList.remove('open');
  }

  function downloadTemplate(){
    const ws = XLSX.utils.aoa_to_sheet([
      ['Marca', 'Medida', 'Quantidade', 'Preço', 'Condição'],
      ['Pirelli', '185/65 R14', 4, '350', 'Novo'],
      ['Michelin', '225/45 R18', 2, '', 'Usado']
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Pneus');
    XLSX.writeFile(wb, 'modelo-importacao-pneus.xlsx');
  }

  async function handleSpreadsheetUpload(file){
    const importErr = document.getElementById('importErr');
    importErr.classList.remove('show');
    try{
      const rawRows = await parseSpreadsheet(file);
      if(rawRows.length === 0){
        importErr.textContent = 'A planilha está vazia.';
        importErr.classList.add('show');
        return;
      }
      document.getElementById('importRows').innerHTML = '';
      batchRowCount = 0;
      rawRows.forEach(row=>{
        const mapped = mapSpreadsheetRow(row);
        addBatchRow('importRows', mapped);
      });
      showToast(`${rawRows.length} linha(s) lidas. Confira antes de salvar.`);
    }catch(err){
      importErr.textContent = err.message || 'Não foi possível ler essa planilha.';
      importErr.classList.add('show');
    }
  }

  async function saveImport(){
    const importErr = document.getElementById('importErr');
    importErr.classList.remove('show');

    const newItems = rowsToItems('importRows', importErr, 'planilha importada');
    if(newItems === null) return;

    if(newItems.length === 0){
      importErr.textContent = 'Nenhum item válido para importar.';
      importErr.classList.add('show');
      return;
    }

    try{
      const created = await api.bulkCreate(newItems);
      tires.push(...created);
      closeImportPanel();
      render();
      showToast(`${created.length} item(ns) importados da planilha.`);
    }catch(e){
      importErr.textContent = 'Não foi possível salvar os itens. Verifique sua conexão com a API.';
      importErr.classList.add('show');
    }
  }

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
  document.getElementById('scanFileInput').onchange = (e)=>{
    const file = e.target.files[0];
    if(file) scanFromUploadedFile(file);
  };
  document.getElementById('openNotaLinkBtn').onclick = ()=>{
    if(scannedNota && scannedNota.url) window.open(scannedNota.url, '_blank');
  };
  document.getElementById('cancelBatchBtn').onclick = closeScanPanel;
  document.getElementById('addBatchRowBtn').onclick = ()=> addBatchRow('batchRows');
  document.getElementById('saveBatchBtn').onclick = saveBatch;

  document.getElementById('importBtn').onclick = ()=>{
    if(importPanel.classList.contains('open')){ closeImportPanel(); }
    else { openImportPanel(); }
  };
  document.getElementById('importFileInput').onchange = (e)=>{
    const file = e.target.files[0];
    if(file) handleSpreadsheetUpload(file);
  };
  document.getElementById('downloadTemplateBtn').onclick = downloadTemplate;
  document.getElementById('addImportRowBtn').onclick = ()=> addBatchRow('importRows');
  document.getElementById('cancelImportBtn').onclick = closeImportPanel;
  document.getElementById('saveImportBtn').onclick = saveImport;

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
