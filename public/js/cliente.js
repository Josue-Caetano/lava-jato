const estado = {
  info: null,
  servicos: [],
  servico: null,
  hora: null,
  cupom: null,
  modoCadastro: false,
  agendamentoPagar: null,
  acaoPosLogin: null,
};

const $ = (s) => document.querySelector(s);

// ----------------------------------------------------------------- sessão
function atualizarCabecalho() {
  const s = sessao.ler();
  $('#saudacao').textContent = s ? `Olá, ${s.usuario.nome.split(' ')[0]}` : '';
  $('#btn-sair').hidden = !s;
}

function exigirLogin(depois) {
  if (sessao.ler()) return depois();
  estado.acaoPosLogin = depois;
  $('#tela-login').hidden = false;
  document.querySelectorAll('[data-painel]').forEach((p) => { p.hidden = true; });
  $('#abas').hidden = true;
}

function fecharLogin() {
  $('#tela-login').hidden = true;
  $('#abas').hidden = false;
  const ativa = $('#abas button.ativa').dataset.aba;
  document.querySelectorAll('[data-painel]').forEach((p) => { p.hidden = p.dataset.painel !== ativa; });
}

window.aoExpirarSessao = () => { atualizarCabecalho(); toast('Sua sessão expirou, entre novamente', true); };

$('#alternar-login').onclick = (ev) => {
  ev.preventDefault();
  estado.modoCadastro = !estado.modoCadastro;
  $('#campo-nome').hidden = $('#campo-telefone').hidden = !estado.modoCadastro;
  $('#form-login [name=nome]').required = estado.modoCadastro;
  $('#titulo-login').textContent = estado.modoCadastro ? 'Criar conta' : 'Entrar';
  $('#form-login button').textContent = estado.modoCadastro ? 'Cadastrar' : 'Entrar';
  ev.target.textContent = estado.modoCadastro ? 'Já tenho conta' : 'Não tem conta? Cadastre-se';
};

$('#form-login').onsubmit = (ev) => tentar(async () => {
  ev.preventDefault();
  const dados = dadosForm(ev.target);
  const r = estado.modoCadastro
    ? await api('POST', '/api/auth/cadastro', dados)
    : await api('POST', '/api/auth/login', dados);
  if (r.usuario.papel !== 'cliente') {
    toast('Esta é a conta do dono. Use o painel em /admin.', true);
    return;
  }
  sessao.salvar(r);
  atualizarCabecalho();
  fecharLogin();
  ev.target.reset();
  const acao = estado.acaoPosLogin;
  estado.acaoPosLogin = null;
  if (acao) await acao();
});

$('#btn-sair').onclick = () => {
  sessao.limpar();
  atualizarCabecalho();
  $('#lista-meus').innerHTML = '';
  toast('Você saiu da sua conta');
};

// --------------------------------------------------------------- agendar
function renderServicos() {
  $('#lista-servicos').innerHTML = estado.servicos.map((s) => `
    <button type="button" class="opcao ${estado.servico?.id === s.id ? 'sel' : ''}" data-id="${s.id}">
      <strong>${esc(s.nome)}</strong>
      <span class="muted">${esc(s.descricao || '')}</span><br>
      <span class="preco">${dinheiro(s.preco_centavos)}</span>
      <span class="muted"> · ${s.duracao_min} min</span>
    </button>`).join('') || '<p class="muted">Nenhum serviço disponível.</p>';
}

$('#lista-servicos').onclick = (ev) => {
  const b = ev.target.closest('[data-id]');
  if (!b) return;
  estado.servico = estado.servicos.find((s) => s.id === Number(b.dataset.id));
  renderServicos();
  carregarHorarios();
  atualizarTotal();
};

async function carregarHorarios() {
  const data = $('#data-agendamento').value;
  estado.hora = null;
  const box = $('#lista-horarios');
  if (!estado.servico || !data) {
    box.innerHTML = '<span class="muted">Escolha um serviço e uma data.</span>';
    return;
  }
  box.innerHTML = '<span class="muted">Carregando…</span>';
  const horas = await tentar(() => api('GET', `/api/publico/horarios?data=${data}&servico_id=${estado.servico.id}`));
  if (!horas) return;
  box.innerHTML = horas.length
    ? horas.map((h) => `<button type="button" data-hora="${h}">${h}</button>`).join('')
    : '<span class="muted">Sem horários livres nesse dia. Tente outra data.</span>';
}

$('#data-agendamento').onchange = carregarHorarios;
$('#lista-horarios').onclick = (ev) => {
  const b = ev.target.closest('[data-hora]');
  if (!b) return;
  estado.hora = b.dataset.hora;
  $('#lista-horarios').querySelectorAll('button').forEach((x) => x.classList.toggle('sel', x === b));
};

function atualizarTotal() {
  if (!estado.servico) {
    $('#total-agendamento').textContent = '—';
    $('#info-desconto').textContent = '';
    return;
  }
  const preco = estado.servico.preco_centavos;
  let desconto = 0;
  if (estado.cupom) {
    desconto = estado.cupom.tipo === 'percentual'
      ? Math.round(preco * estado.cupom.valor / 100)
      : Math.min(estado.cupom.valor, preco);
  }
  $('#total-agendamento').textContent = dinheiro(preco - desconto);
  $('#info-desconto').textContent = desconto ? `(desconto de ${dinheiro(desconto)} com ${estado.cupom.codigo})` : '';
}

$('#cupom').onchange = async (ev) => {
  const codigo = ev.target.value.trim();
  estado.cupom = null;
  if (codigo) {
    estado.cupom = await tentar(() => api('GET', `/api/publico/cupom/${encodeURIComponent(codigo)}`)) || null;
    if (estado.cupom) toast('Cupom aplicado!');
  }
  atualizarTotal();
};

$('#form-agendar').onsubmit = (ev) => {
  ev.preventDefault();
  if (!estado.servico) return toast('Escolha um serviço', true);
  if (!estado.hora) return toast('Escolha um horário', true);
  exigirLogin(() => tentar(async () => {
    const dados = dadosForm(ev.target);
    const ag = await api('POST', '/api/cliente/agendamentos', {
      ...dados,
      cupom: estado.cupom ? estado.cupom.codigo : '',
      servico_id: estado.servico.id,
      data: $('#data-agendamento').value,
      hora: estado.hora,
    });
    toast('Agendamento confirmado!');
    ev.target.reset();
    estado.cupom = null;
    atualizarTotal();
    await carregarHorarios();
    abrirPagamento(ag);
  }));
};

// ------------------------------------------------------ meus agendamentos
async function carregarMeus() {
  if (!sessao.ler()) {
    $('#lista-meus').innerHTML = '<p class="muted">Entre na sua conta para ver seus agendamentos.</p><button type="button" id="btn-entrar">Entrar</button>';
    $('#btn-entrar').onclick = () => exigirLogin(carregarMeus);
    return;
  }
  const lista = await tentar(() => api('GET', '/api/cliente/agendamentos'));
  if (!lista) return;
  window.meusAgendamentos = lista;
  $('#lista-meus').innerHTML = lista.length ? `
    <div class="tabela-rolagem"><table>
      <thead><tr><th>Data</th><th>Serviço</th><th>Veículo</th><th class="num">Valor</th><th>Status</th><th>Pagamento</th><th></th></tr></thead>
      <tbody>${lista.map((a) => {
        const pago = a.pago_centavos >= a.total_centavos;
        const podePagar = !pago && a.status !== 'cancelado';
        return `<tr>
          <td>${dataBR(a.data)} ${a.hora}</td>
          <td>${esc(a.servico_nome)}</td>
          <td>${esc(a.placa)} <span class="muted">${esc(a.modelo || '')}</span></td>
          <td class="num">${dinheiro(a.total_centavos)}</td>
          <td>${tag(a.status)}</td>
          <td>${pago ? tag('pago') : a.status === 'cancelado' ? '—' : tag('pendente')}</td>
          <td><div class="acoes">
            ${podePagar ? `<button class="peq" data-pagar="${a.id}">Pagar</button>` : ''}
            ${a.status === 'agendado' && !a.pago_centavos ? `<button class="peq perigo" data-cancelar="${a.id}">Cancelar</button>` : ''}
          </div></td></tr>`;
      }).join('')}</tbody></table></div>`
    : '<p class="muted">Você ainda não tem agendamentos.</p>';
}

$('#lista-meus').onclick = (ev) => {
  const pagar = ev.target.closest('[data-pagar]');
  const cancelar = ev.target.closest('[data-cancelar]');
  if (pagar) {
    abrirPagamento(window.meusAgendamentos.find((a) => a.id === Number(pagar.dataset.pagar)));
  } else if (cancelar && confirm('Cancelar este agendamento?')) {
    tentar(async () => {
      await api('POST', `/api/cliente/agendamentos/${cancelar.dataset.cancelar}/cancelar`);
      toast('Agendamento cancelado');
      carregarMeus();
    });
  }
};

// -------------------------------------------------------------- pagamento
function abrirPagamento(ag) {
  estado.agendamentoPagar = ag;
  const restante = ag.total_centavos - ag.pago_centavos;
  $('#pagar-resumo').innerHTML = `${esc(ag.servico_nome)} · ${esc(ag.placa)} · ${dataBR(ag.data)} às ${ag.hora}<br>Valor: <strong>${dinheiro(restante)}</strong>`;
  $('#pagar-opcoes').hidden = false;
  $('#pagar-opcoes [data-metodo=pix]').hidden = !estado.info.pix_disponivel;
  $('#pagar-conteudo').innerHTML = '';
  if (ag.pagamento_pendente_id) {
    tentar(async () => {
      const p = await api('GET', `/api/cliente/pagamentos/${ag.pagamento_pendente_id}`);
      if (p.metodo === 'pix') mostrarPix($('#pagar-conteudo'), p);
    });
  }
  $('#dlg-pagar').showModal();
}

$('#pagar-opcoes').onclick = (ev) => {
  const b = ev.target.closest('[data-metodo]');
  if (!b) return;
  tentar(async () => {
    const p = await api('POST', `/api/cliente/agendamentos/${estado.agendamentoPagar.id}/pagamento`, { metodo: b.dataset.metodo });
    if (p.metodo === 'pix') {
      mostrarPix($('#pagar-conteudo'), p);
    } else {
      $('#pagar-conteudo').innerHTML = `<p>Combinado! Você paga <strong>${dinheiro(p.valor_liquido_centavos)}</strong> com ${NOMES_METODO[p.metodo].toLowerCase()} quando trouxer o carro.</p>`;
    }
  });
};

$('#fechar-pagar').onclick = () => {
  $('#dlg-pagar').close();
  if (!$('[data-painel=meus]').hidden) carregarMeus();
};

// ---------------------------------------------------------------- início
abas($('#abas'), (aba) => { if (aba === 'meus') carregarMeus(); });

(async function iniciar() {
  atualizarCabecalho();
  const [info, servicos] = await Promise.all([
    api('GET', '/api/publico/info'),
    api('GET', '/api/publico/servicos'),
  ]);
  estado.info = info;
  estado.servicos = servicos;
  document.title = `${info.nome_empresa} - Agendamento`;
  $('#nome-empresa').textContent = info.nome_empresa;
  $('#info-empresa').textContent = [info.endereco_empresa, info.telefone_empresa, `${info.horario_abertura}–${info.horario_fechamento}`].filter(Boolean).join(' · ');
  $('#aviso-fechado').hidden = info.agendamento_online;
  $('#btn-agendar').disabled = !info.agendamento_online;
  const data = $('#data-agendamento');
  data.min = hojeISO();
  data.max = hojeISO(info.antecedencia_max_dias);
  data.value = hojeISO();
  renderServicos();
})().catch((e) => toast(e.message, true));
