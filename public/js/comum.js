// Utilitários compartilhados entre a área do cliente e o painel do dono.

const CHAVE_SESSAO = window.CHAVE_SESSAO || 'lavajato_sessao';

const sessao = {
  ler() {
    try { return JSON.parse(localStorage.getItem(CHAVE_SESSAO)) || null; } catch { return null; }
  },
  salvar(dados) {
    try { localStorage.setItem(CHAVE_SESSAO, JSON.stringify(dados)); } catch { /* sem storage */ }
  },
  limpar() {
    try { localStorage.removeItem(CHAVE_SESSAO); } catch { /* sem storage */ }
  },
};

async function api(metodo, url, corpo) {
  const s = sessao.ler();
  const resp = await fetch(url, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      ...(s ? { Authorization: `Bearer ${s.token}` } : {}),
    },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const dados = await resp.json().catch(() => ({}));
  if (resp.status === 401 && s) {
    sessao.limpar();
    if (window.aoExpirarSessao) window.aoExpirarSessao();
  }
  if (!resp.ok) throw new Error(dados.erro || 'Erro na comunicação com o servidor');
  return dados;
}

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const dinheiro = (centavos) => brl.format((centavos || 0) / 100);

function dataBR(iso) {
  if (!iso) return '';
  const [a, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${a}${iso.length > 10 ? ' ' + iso.slice(11, 16) : ''}`;
}

function hojeISO(offsetDias = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDias);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function esc(texto) {
  return String(texto ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

const NOMES_STATUS = {
  agendado: 'Agendado', em_andamento: 'Em andamento', concluido: 'Concluído',
  cancelado: 'Cancelado', pendente: 'Pendente', pago: 'Pago',
};
const NOMES_METODO = {
  pix: 'Pix', cartao_credito: 'Cartão de crédito', cartao_debito: 'Cartão de débito', dinheiro: 'Dinheiro',
};
const tag = (status) => `<span class="tag ${esc(status)}">${esc(NOMES_STATUS[status] || status)}</span>`;

let timerToast;
function toast(msg, erro = false) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = erro ? 'erro' : '';
  el.hidden = false;
  clearTimeout(timerToast);
  timerToast = setTimeout(() => { el.hidden = true; }, 3500);
}

/** Executa uma ação assíncrona mostrando o erro num toast. */
async function tentar(fn) {
  try { return await fn(); } catch (e) { toast(e.message, true); return undefined; }
}

function dadosForm(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function abas(nav, aoTrocar) {
  nav.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-aba]');
    if (!b) return;
    nav.querySelectorAll('button').forEach((x) => x.classList.toggle('ativa', x === b));
    document.querySelectorAll('[data-painel]').forEach((p) => { p.hidden = p.dataset.painel !== b.dataset.aba; });
    aoTrocar && aoTrocar(b.dataset.aba);
  });
}

function mostrarPix(container, pagamento) {
  container.innerHTML = `
    <div class="pix-box">
      <p>Escaneie o QR Code no app do seu banco ou use o Pix Copia e Cola.</p>
      <p class="total">${dinheiro(pagamento.valor_liquido_centavos)}</p>
      <img src="${pagamento.pix_qrcode}" alt="QR Code Pix">
      <label>Pix Copia e Cola
        <textarea readonly>${esc(pagamento.pix_copia_cola)}</textarea>
      </label>
      <button type="button" class="sec" data-copiar>Copiar código</button>
      <p class="muted">Após pagar, o lava jato confirma o recebimento e o status muda para <strong>Pago</strong>.</p>
    </div>`;
  container.querySelector('[data-copiar]').onclick = async () => {
    try {
      await navigator.clipboard.writeText(pagamento.pix_copia_cola);
      toast('Código Pix copiado!');
    } catch {
      container.querySelector('textarea').select();
      toast('Selecione e copie o código manualmente');
    }
  };
}
