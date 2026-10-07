const $ = (s) => document.querySelector(s);
const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const cache = { servicos: [], aReceber: [] };

const vazio = (msg) => `<p class="muted">${msg}</p>`;
const tabela = (cab, linhas) => `<div class="tabela-rolagem"><table><thead><tr>${cab}</tr></thead><tbody>${linhas}</tbody></table></div>`;

// ----------------------------------------------------------------- sessão
function mostrarApp(logado) {
  $('#tela-primeiro-acesso').hidden = true;
  $('#tela-login').hidden = logado;
  $('#app').hidden = !logado;
  $('#btn-sair').hidden = !logado;
}

window.aoExpirarSessao = () => { mostrarApp(false); toast('Sessão expirada, entre novamente', true); };

$('#form-login').onsubmit = (ev) => tentar(async () => {
  ev.preventDefault();
  const r = await api('POST', 'auth/login', dadosForm(ev.target));
  sessao.salvar(r);
  ev.target.reset();
  iniciar();
});

$('#form-primeiro-acesso').onsubmit = (ev) => tentar(async () => {
  ev.preventDefault();
  const r = await api('POST', 'auth/primeiro-acesso', dadosForm(ev.target));
  sessao.salvar(r);
  ev.target.reset();
  toast('Conta criada! Agora configure sua chave Pix em Configurações.');
  iniciar();
});

$('#btn-sair').onclick = async () => { await sair(); mostrarApp(false); };

// ----------------------------------------------------------------- resumo
function definirPeriodo(tipo) {
  const hoje = hojeISO();
  $('#resumo-fim').value = hoje;
  $('#resumo-inicio').value = tipo === 'semana' ? hojeISO(-6) : tipo === 'mes' ? hoje.slice(0, 8) + '01' : hoje;
  carregarResumo();
}

document.querySelectorAll('[data-periodo]').forEach((b) => { b.onclick = () => definirPeriodo(b.dataset.periodo); });
$('#resumo-inicio').onchange = $('#resumo-fim').onchange = () => carregarResumo();

async function carregarResumo() {
  const r = await tentar(() => api('GET', `admin/resumo?inicio=${$('#resumo-inicio').value}&fim=${$('#resumo-fim').value}`));
  if (!r) return;
  const ticket = r.quantidade ? Math.round(r.liquido_centavos / r.quantidade) : 0;
  $('#kpis').innerHTML = [
    ['Faturamento líquido', dinheiro(r.liquido_centavos)],
    ['Recebimentos', r.quantidade],
    ['Descontos concedidos', dinheiro(r.descontos_centavos)],
    ['Ticket médio', dinheiro(ticket)],
    ['A receber (pendentes)', `${dinheiro(r.pendentes.liquido_centavos)} <small class="muted">(${r.pendentes.quantidade})</small>`],
  ].map(([rot, val]) => `<div class="kpi"><div class="rotulo">${rot}</div><div class="valor">${val}</div></div>`).join('');

  $('#por-metodo').innerHTML = r.por_metodo.length
    ? tabela('<th>Forma</th><th class="num">Qtd.</th><th class="num">Total</th>', r.por_metodo.map((m) =>
      `<tr><td>${NOMES_METODO[m.metodo]}</td><td class="num">${m.quantidade}</td><td class="num">${dinheiro(m.liquido_centavos)}</td></tr>`).join(''))
    : vazio('Nenhum recebimento no período.');

  const max = Math.max(1, ...r.por_dia.map((d) => d.liquido_centavos));
  $('#por-dia').innerHTML = r.por_dia.length
    ? `<div class="barras">${r.por_dia.map((d) =>
      `<div style="height:${Math.max(2, (d.liquido_centavos / max) * 100)}%" data-tip="${dataBR(d.dia)}: ${dinheiro(d.liquido_centavos)}"></div>`).join('')}</div>`
    : vazio('Sem dados no período.');

  const hoje = await tentar(() => api('GET', `admin/agendamentos?data=${hojeISO()}`));
  if (hoje) $('#agenda-hoje').innerHTML = tabelaAgenda(hoje.filter((a) => a.status !== 'cancelado'));
}

// ----------------------------------------------------------------- agenda
function tabelaAgenda(lista) {
  if (!lista.length) return vazio('Nenhum agendamento.');
  return tabela(
    '<th>Data</th><th>Cliente</th><th>Veículo</th><th>Serviço</th><th class="num">Valor</th><th>Status</th><th>Pagamento</th><th>Ações</th>',
    lista.map((a) => {
      const pago = a.pago_centavos >= a.total_centavos;
      const proximo = { agendado: ['em_andamento', 'Iniciar'], em_andamento: ['concluido', 'Concluir'] }[a.status];
      return `<tr>
        <td>${dataBR(a.data)} <strong>${a.hora}</strong></td>
        <td>${esc(a.nome_cliente)}<br><span class="muted">${esc(a.telefone || '')}</span></td>
        <td>${esc(a.placa)}<br><span class="muted">${esc(a.modelo || '')}</span></td>
        <td>${esc(a.servico_nome)}${a.observacoes ? `<br><span class="muted">${esc(a.observacoes)}</span>` : ''}</td>
        <td class="num">${dinheiro(a.total_centavos)}${a.desconto_centavos ? `<br><span class="muted">-${dinheiro(a.desconto_centavos)}${a.cupom_codigo ? ' ' + esc(a.cupom_codigo) : ''}</span>` : ''}</td>
        <td>${tag(a.status)}</td>
        <td>${pago ? tag('pago') : a.status === 'cancelado' ? '—' : a.pagamento_pendente_id ? tag('pendente') : '<span class="muted">Não pago</span>'}</td>
        <td><div class="acoes">
          ${proximo ? `<button class="peq sec" data-status="${proximo[0]}" data-id="${a.id}">${proximo[1]}</button>` : ''}
          ${!pago && a.status !== 'cancelado' ? `<button class="peq ok" data-receber="${a.id}">Receber</button>` : ''}
          ${a.status === 'agendado' ? `<button class="peq perigo" data-status="cancelado" data-id="${a.id}">Cancelar</button>` : ''}
        </div></td></tr>`;
    }).join('')
  );
}

async function carregarAgenda() {
  const lista = await tentar(() => api('GET', `admin/agendamentos?data=${$('#agenda-data').value}&status=${$('#agenda-status').value}`));
  if (lista) $('#lista-agenda').innerHTML = tabelaAgenda(lista);
}
$('#agenda-data').onchange = $('#agenda-status').onchange = carregarAgenda;

document.addEventListener('click', (ev) => {
  const st = ev.target.closest('[data-status][data-id]');
  const rec = ev.target.closest('[data-receber]');
  if (st) {
    if (st.dataset.status === 'cancelado' && !confirm('Cancelar este agendamento?')) return;
    tentar(async () => {
      await api('PATCH', `admin/agendamentos/${st.dataset.id}`, { status: st.dataset.status });
      toast('Agendamento atualizado');
      carregarAgenda();
      carregarResumo();
    });
  } else if (rec) {
    irParaRecebimento(Number(rec.dataset.receber));
  }
});

$('#btn-novo-agendamento').onclick = () => {
  const f = $('#form-agendamento');
  f.reset();
  $('#ag-servico').innerHTML = cache.servicos.filter((s) => s.ativo)
    .map((s) => `<option value="${s.id}">${esc(s.nome)} — ${dinheiro(s.preco_centavos)}</option>`).join('');
  f.data.value = $('#agenda-data').value || hojeISO();
  $('#dlg-agendamento').showModal();
};
$('#cancelar-agendamento').onclick = () => $('#dlg-agendamento').close();
$('#form-agendamento').onsubmit = (ev) => tentar(async () => {
  ev.preventDefault();
  const ag = await api('POST', 'admin/agendamentos', dadosForm(ev.target));
  $('#dlg-agendamento').close();
  toast('Agendamento criado');
  $('#agenda-data').value = ag.data;
  carregarAgenda();
});

// ----------------------------------------------------------- recebimentos
async function carregarAReceber() {
  const lista = await tentar(() => api('GET', `admin/agendamentos?inicio=${hojeISO(-60)}&fim=${hojeISO(60)}`));
  if (!lista) return;
  cache.aReceber = lista.filter((a) => a.status !== 'cancelado' && a.pago_centavos < a.total_centavos);
  const sel = $('#rec-agendamento');
  const atual = sel.value;
  sel.innerHTML = '<option value="">Avulso (sem agendamento)</option>' + cache.aReceber.map((a) =>
    `<option value="${a.id}">${dataBR(a.data)} ${a.hora} · ${esc(a.nome_cliente)} · ${esc(a.placa)} · ${dinheiro(a.total_centavos - a.pago_centavos)}</option>`).join('');
  sel.value = cache.aReceber.some((a) => String(a.id) === atual) ? atual : '';
}

function paraCentavos(txt) {
  const s = String(txt || '').trim();
  if (!s) return 0;
  const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function atualizarTotalRecebimento() {
  const f = $('#form-recebimento');
  const ag = cache.aReceber.find((a) => String(a.id) === f.agendamento_id.value);
  const bruto = f.valor.value.trim() ? paraCentavos(f.valor.value) : ag ? ag.total_centavos - ag.pago_centavos : 0;
  const d = f.desconto.value.trim();
  const desconto = !d ? 0 : f.desconto_tipo.value === 'percentual'
    ? Math.round(bruto * Math.min(100, Number(d.replace(',', '.')) || 0) / 100)
    : Math.min(bruto, paraCentavos(d));
  $('#rec-total').textContent = dinheiro(bruto - desconto);
}

$('#form-recebimento').oninput = atualizarTotalRecebimento;
$('#rec-agendamento').onchange = () => {
  const f = $('#form-recebimento');
  const ag = cache.aReceber.find((a) => String(a.id) === f.agendamento_id.value);
  f.valor.placeholder = ag ? ((ag.total_centavos - ag.pago_centavos) / 100).toFixed(2).replace('.', ',') : '0,00';
  f.descricao.placeholder = ag ? `${ag.servico_nome} - ${ag.placa}` : 'Ex.: Lavagem completa - ABC1D23';
  atualizarTotalRecebimento();
};

async function irParaRecebimento(agendamentoId) {
  $('#abas [data-aba=recebimentos]').click();
  await carregarAReceber();
  $('#rec-agendamento').value = String(agendamentoId);
  $('#rec-agendamento').onchange();
  $('#form-recebimento').scrollIntoView({ behavior: 'smooth' });
}

$('#form-recebimento').onsubmit = (ev) => tentar(async () => {
  ev.preventDefault();
  const p = await api('POST', 'admin/pagamentos', dadosForm(ev.target));
  toast(`Recebimento de ${dinheiro(p.valor_liquido_centavos)} lançado`);
  ev.target.reset();
  $('#rec-agendamento').onchange();
  carregarAReceber();
  carregarPagamentos();
  carregarResumo();
});

async function carregarPagamentos() {
  const q = new URLSearchParams({ inicio: $('#pag-inicio').value, fim: $('#pag-fim').value, status: $('#pag-status').value });
  const lista = await tentar(() => api('GET', `admin/pagamentos?${q}`));
  if (!lista) return;
  $('#lista-pagamentos').innerHTML = lista.length ? tabela(
    '<th>Data</th><th>Descrição</th><th>Forma</th><th class="num">Bruto</th><th class="num">Desconto</th><th class="num">Líquido</th><th>Situação</th><th></th>',
    lista.map((p) => `<tr>
      <td>${dataBR(p.pago_em || p.criado_em)}</td>
      <td>${esc(p.descricao)}${p.nome_cliente ? `<br><span class="muted">${esc(p.nome_cliente)}${p.origem === 'cliente' ? ' · pelo app' : ''}</span>` : ''}</td>
      <td>${NOMES_METODO[p.metodo]}</td>
      <td class="num">${dinheiro(p.valor_bruto_centavos)}</td>
      <td class="num">${p.desconto_centavos ? '-' + dinheiro(p.desconto_centavos) : '—'}</td>
      <td class="num"><strong>${dinheiro(p.valor_liquido_centavos)}</strong></td>
      <td>${tag(p.status)}</td>
      <td><div class="acoes">${p.status === 'pendente' ? `
        <button class="peq ok" data-pag="${p.id}" data-novo="pago">Confirmar</button>
        <button class="peq perigo" data-pag="${p.id}" data-novo="cancelado">Cancelar</button>` : ''}</div></td>
    </tr>`).join('')
  ) : vazio('Nenhum recebimento encontrado.');
}

$('#pag-inicio').onchange = $('#pag-fim').onchange = $('#pag-status').onchange = carregarPagamentos;
$('#lista-pagamentos').onclick = (ev) => {
  const b = ev.target.closest('[data-pag]');
  if (!b) return;
  if (b.dataset.novo === 'cancelado' && !confirm('Cancelar esta cobrança?')) return;
  tentar(async () => {
    await api('PATCH', `admin/pagamentos/${b.dataset.pag}`, { status: b.dataset.novo });
    toast(b.dataset.novo === 'pago' ? 'Pagamento confirmado' : 'Cobrança cancelada');
    carregarPagamentos();
    carregarAReceber();
    carregarResumo();
  });
};

// ---------------------------------------------------------------- serviços
async function carregarServicos() {
  cache.servicos = await tentar(() => api('GET', 'admin/servicos')) || cache.servicos;
  $('#lista-servicos').innerHTML = tabela(
    '<th>Serviço</th><th class="num">Preço</th><th class="num">Duração</th><th>Situação</th><th></th>',
    cache.servicos.map((s) => `<tr>
      <td><strong>${esc(s.nome)}</strong><br><span class="muted">${esc(s.descricao || '')}</span></td>
      <td class="num">${dinheiro(s.preco_centavos)}</td>
      <td class="num">${s.duracao_min} min</td>
      <td>${s.ativo ? '<span class="tag concluido">Ativo</span>' : '<span class="tag">Inativo</span>'}</td>
      <td><div class="acoes">
        <button class="peq sec" data-editar="${s.id}">Editar</button>
        <button class="peq ${s.ativo ? 'perigo' : 'sec'}" data-ativar="${s.id}">${s.ativo ? 'Desativar' : 'Ativar'}</button>
      </div></td></tr>`).join('')
  );
}

const corpoServico = (s, extra = {}) => ({
  nome: s.nome, descricao: s.descricao, preco: (s.preco_centavos / 100).toFixed(2), duracao_min: s.duracao_min, ...extra,
});

$('#lista-servicos').onclick = (ev) => {
  const ed = ev.target.closest('[data-editar]');
  const at = ev.target.closest('[data-ativar]');
  if (ed) {
    const s = cache.servicos.find((x) => x.id === Number(ed.dataset.editar));
    const f = $('#form-servico');
    f.sid.value = s.id;
    f.nome.value = s.nome;
    f.descricao.value = s.descricao || '';
    f.preco.value = (s.preco_centavos / 100).toFixed(2).replace('.', ',');
    f.duracao_min.value = s.duracao_min;
    f.scrollIntoView({ behavior: 'smooth' });
  } else if (at) {
    const s = cache.servicos.find((x) => x.id === Number(at.dataset.ativar));
    tentar(async () => {
      await api('PUT', `admin/servicos/${s.id}`, corpoServico(s, { ativo: !s.ativo }));
      carregarServicos();
    });
  }
};

$('#form-servico').onsubmit = (ev) => tentar(async () => {
  ev.preventDefault();
  const d = dadosForm(ev.target);
  d.duracao_min = Number(d.duracao_min);
  if (d.sid) {
    const s = cache.servicos.find((x) => x.id === Number(d.sid));
    await api('PUT', `admin/servicos/${d.sid}`, { ...d, ativo: Boolean(s.ativo) });
  } else {
    await api('POST', 'admin/servicos', d);
  }
  toast('Serviço salvo');
  ev.target.reset();
  ev.target.sid.value = '';
  carregarServicos();
});

// ---------------------------------------------------------------- cupons
async function carregarCupons() {
  const lista = await tentar(() => api('GET', 'admin/cupons'));
  if (!lista) return;
  $('#lista-cupons').innerHTML = lista.length ? tabela(
    '<th>Código</th><th>Desconto</th><th>Validade</th><th>Situação</th><th></th>',
    lista.map((c) => `<tr>
      <td><strong>${esc(c.codigo)}</strong></td>
      <td>${c.tipo === 'percentual' ? c.valor + '%' : dinheiro(c.valor)}</td>
      <td>${c.validade ? dataBR(c.validade) : 'Sem validade'}</td>
      <td>${c.ativo ? '<span class="tag concluido">Ativo</span>' : '<span class="tag">Inativo</span>'}</td>
      <td><button class="peq ${c.ativo ? 'perigo' : 'sec'}" data-cupom="${c.id}" data-ativo="${c.ativo ? 0 : 1}">${c.ativo ? 'Desativar' : 'Ativar'}</button></td>
    </tr>`).join('')
  ) : vazio('Nenhum cupom criado.');
}

$('#lista-cupons').onclick = (ev) => {
  const b = ev.target.closest('[data-cupom]');
  if (b) tentar(async () => {
    await api('PATCH', `admin/cupons/${b.dataset.cupom}`, { ativo: b.dataset.ativo === '1' });
    carregarCupons();
  });
};

$('#form-cupom').onsubmit = (ev) => tentar(async () => {
  ev.preventDefault();
  await api('POST', 'admin/cupons', dadosForm(ev.target));
  toast('Cupom criado');
  ev.target.reset();
  carregarCupons();
});

// ---------------------------------------------------------------- clientes
async function carregarClientes() {
  const lista = await tentar(() => api('GET', 'admin/clientes'));
  if (!lista) return;
  $('#lista-clientes').innerHTML = lista.length ? tabela(
    '<th>Nome</th><th>E-mail</th><th>Telefone</th><th class="num">Agendamentos</th><th>Cliente desde</th>',
    lista.map((c) => `<tr><td>${esc(c.nome)}</td><td>${esc(c.email)}</td><td>${esc(c.telefone || '')}</td>
      <td class="num">${c.agendamentos}</td><td>${dataBR(c.criado_em)}</td></tr>`).join('')
  ) : vazio('Nenhum cliente cadastrado ainda.');
}

// ------------------------------------------------------------ configurações
$('#dias-semana').innerHTML = DIAS.map((d, i) =>
  `<label style="margin:0"><input type="checkbox" value="${i}" style="width:auto"> ${d}</label>`).join('');

async function carregarConfig() {
  const c = await tentar(() => api('GET', 'admin/config'));
  if (!c) return;
  const f = $('#form-config');
  for (const [k, v] of Object.entries(c)) {
    if (!f[k]) continue;
    if (f[k].type === 'checkbox') f[k].checked = v === '1';
    else f[k].value = v;
  }
  const dias = c.dias_funcionamento.split(',');
  $('#dias-semana').querySelectorAll('input').forEach((i) => { i.checked = dias.includes(i.value); });
  $('#nome-empresa').textContent = c.nome_empresa;
  carregarBloqueios();
}

$('#form-config').onsubmit = (ev) => tentar(async () => {
  ev.preventDefault();
  const d = dadosForm(ev.target);
  d.agendamento_online = ev.target.agendamento_online.checked ? '1' : '0';
  d.dias_funcionamento = [...$('#dias-semana').querySelectorAll('input:checked')].map((i) => i.value).join(',');
  if (!d.dias_funcionamento) throw new Error('Selecione ao menos um dia de funcionamento');
  await api('PUT', 'admin/config', d);
  toast('Configurações salvas');
  carregarConfig();
});

async function carregarBloqueios() {
  const lista = await tentar(() => api('GET', 'admin/bloqueios'));
  if (!lista) return;
  $('#lista-bloqueios').innerHTML = lista.length ? tabela('<th>Data</th><th>Motivo</th><th></th>',
    lista.map((b) => `<tr><td>${dataBR(b.data)}</td><td>${esc(b.motivo || '')}</td>
      <td><button class="peq perigo" data-desbloquear="${b.data}">Remover</button></td></tr>`).join(''))
    : vazio('Nenhum dia bloqueado.');
}

$('#form-bloqueio').onsubmit = (ev) => tentar(async () => {
  ev.preventDefault();
  await api('POST', 'admin/bloqueios', dadosForm(ev.target));
  ev.target.reset();
  toast('Dia bloqueado');
  carregarBloqueios();
});
$('#lista-bloqueios').onclick = (ev) => {
  const b = ev.target.closest('[data-desbloquear]');
  if (b) tentar(async () => { await api('DELETE', `admin/bloqueios/${b.dataset.desbloquear}`); carregarBloqueios(); });
};

$('#form-senha').onsubmit = (ev) => tentar(async () => {
  ev.preventDefault();
  await api('POST', 'auth/senha', dadosForm(ev.target));
  ev.target.reset();
  toast('Senha alterada');
});

// ---------------------------------------------------------------- início
const carregarAba = {
  painel: carregarResumo,
  agenda: carregarAgenda,
  recebimentos: () => { carregarAReceber(); carregarPagamentos(); },
  servicos: carregarServicos,
  descontos: carregarCupons,
  clientes: carregarClientes,
  config: carregarConfig,
};
abas($('#abas'), (aba) => carregarAba[aba]());

async function iniciar() {
  const info = await tentar(() => api('GET', 'publico/info'));
  if (info && info.precisa_configurar) {
    mostrarApp(false);
    $('#tela-login').hidden = true;
    $('#tela-primeiro-acesso').hidden = false;
    return;
  }
  if (!(await conferirSessao())) return mostrarApp(false);
  mostrarApp(true);
  $('#agenda-data').value = hojeISO();
  $('#pag-inicio').value = hojeISO().slice(0, 8) + '01';
  $('#pag-fim').value = hojeISO();
  definirPeriodo('hoje');
  carregarServicos();
  if (info) $('#nome-empresa').textContent = info.nome_empresa;
}

iniciar();
