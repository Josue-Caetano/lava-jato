'use strict';

const crypto = require('node:crypto');
const QRCode = require('qrcode');
const { lerConfig, transacao } = require('./db');
const { gerarPixCopiaECola } = require('./pix');

class ErroNegocio extends Error {
  constructor(mensagem, status = 400) {
    super(mensagem);
    this.status = status;
  }
}

const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const RE_HORA = /^\d{2}:\d{2}$/;

function paraMinutos(hora) {
  const [h, m] = hora.split(':').map(Number);
  return h * 60 + m;
}

function paraHora(minutos) {
  return `${String(Math.floor(minutos / 60)).padStart(2, '0')}:${String(minutos % 60).padStart(2, '0')}`;
}

function dataLocal(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function validarData(data) {
  if (!RE_DATA.test(String(data))) throw new ErroNegocio('Data inválida (use AAAA-MM-DD)');
  const d = new Date(`${data}T00:00:00`);
  if (Number.isNaN(d.getTime()) || dataLocal(d) !== data) throw new ErroNegocio('Data inválida');
  return d;
}

/** Converte "12,50" / "12.50" / 12.5 em centavos. */
function reaisParaCentavos(valor) {
  if (typeof valor === 'number') return Math.round(valor * 100);
  const limpo = String(valor ?? '').trim().replace(/\s|R\$/g, '');
  const normalizado = limpo.includes(',') ? limpo.replace(/\./g, '').replace(',', '.') : limpo;
  const n = Number(normalizado);
  if (!limpo || !Number.isFinite(n) || n < 0) throw new ErroNegocio(`Valor inválido: ${valor}`);
  return Math.round(n * 100);
}

function calcularDesconto(valorCentavos, tipo, valor) {
  if (!valor) return 0;
  const desconto =
    tipo === 'percentual' ? Math.round((valorCentavos * Math.min(valor, 100)) / 100) : valor;
  return Math.min(desconto, valorCentavos);
}

function buscarCupom(db, codigo, hoje = dataLocal()) {
  if (!codigo) return null;
  const cupom = db
    .prepare('SELECT * FROM cupons WHERE codigo = ? AND ativo = 1')
    .get(String(codigo).trim());
  if (!cupom || (cupom.validade && cupom.validade < hoje)) {
    throw new ErroNegocio('Cupom inválido ou expirado');
  }
  return cupom;
}

/**
 * Lista os horários livres de um dia para um serviço. Um horário fica livre se a
 * quantidade de agendamentos que se sobrepõem a ele for menor que o nº de vagas.
 */
function horariosDisponiveis(db, data, servicoId, agora = new Date()) {
  const cfg = lerConfig(db);
  const dia = validarData(data);
  const servico = db.prepare('SELECT * FROM servicos WHERE id = ? AND ativo = 1').get(servicoId);
  if (!servico) throw new ErroNegocio('Serviço não encontrado', 404);

  const hoje = dataLocal(agora);
  const limite = new Date(agora);
  limite.setDate(limite.getDate() + Number(cfg.antecedencia_max_dias || 30));
  if (data < hoje || data > dataLocal(limite)) return [];

  const dias = cfg.dias_funcionamento.split(',').map(Number);
  if (!dias.includes(dia.getDay())) return [];
  if (db.prepare('SELECT 1 FROM bloqueios WHERE data = ?').get(data)) return [];

  const abertura = paraMinutos(cfg.horario_abertura);
  const fechamento = paraMinutos(cfg.horario_fechamento);
  const passo = Math.max(5, Number(cfg.intervalo_min) || 30);
  const vagas = Math.max(1, Number(cfg.vagas_simultaneas) || 1);
  const minutoAtual = data === hoje ? agora.getHours() * 60 + agora.getMinutes() : -1;

  const ocupados = db
    .prepare(
      "SELECT hora, duracao_min FROM agendamentos WHERE data = ? AND status != 'cancelado'"
    )
    .all(data)
    .map((a) => [paraMinutos(a.hora), paraMinutos(a.hora) + a.duracao_min]);

  const livres = [];
  for (let ini = abertura; ini + servico.duracao_min <= fechamento; ini += passo) {
    if (ini <= minutoAtual) continue;
    const fim = ini + servico.duracao_min;
    const sobrepostos = ocupados.filter(([a, b]) => a < fim && ini < b).length;
    if (sobrepostos < vagas) livres.push(paraHora(ini));
  }
  return livres;
}

function criarAgendamento(db, dados, { clienteId = null, origemAdmin = false } = {}) {
  const nome = String(dados.nome_cliente || '').trim();
  const placa = String(dados.placa || '').trim().toUpperCase();
  if (!nome) throw new ErroNegocio('Informe o nome do cliente');
  if (!placa) throw new ErroNegocio('Informe a placa do veículo');
  if (!RE_HORA.test(String(dados.hora))) throw new ErroNegocio('Horário inválido');
  validarData(dados.data);

  const cfg = lerConfig(db);
  if (!origemAdmin && cfg.agendamento_online !== '1') {
    throw new ErroNegocio('O agendamento online está desativado no momento');
  }

  return transacao(db, () => {
    const servico = db
      .prepare('SELECT * FROM servicos WHERE id = ? AND ativo = 1')
      .get(Number(dados.servico_id));
    if (!servico) throw new ErroNegocio('Serviço não encontrado', 404);

    // O dono pode encaixar fora da grade; o cliente só nos horários livres.
    if (!origemAdmin && !horariosDisponiveis(db, dados.data, servico.id).includes(dados.hora)) {
      throw new ErroNegocio('Horário indisponível, escolha outro', 409);
    }

    const cupom = buscarCupom(db, dados.cupom);
    let desconto = cupom ? calcularDesconto(servico.preco_centavos, cupom.tipo, cupom.valor) : 0;
    if (origemAdmin && dados.desconto) {
      desconto = Math.min(servico.preco_centavos, desconto + reaisParaCentavos(dados.desconto));
    }

    const r = db
      .prepare(
        `INSERT INTO agendamentos
          (cliente_id, nome_cliente, telefone, placa, modelo, servico_id, data, hora,
           duracao_min, valor_centavos, desconto_centavos, cupom_codigo, observacoes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        clienteId,
        nome,
        String(dados.telefone || '').trim() || null,
        placa,
        String(dados.modelo || '').trim() || null,
        servico.id,
        dados.data,
        dados.hora,
        servico.duracao_min,
        servico.preco_centavos,
        desconto,
        cupom ? cupom.codigo : null,
        String(dados.observacoes || '').trim() || null
      );
    return buscarAgendamento(db, Number(r.lastInsertRowid));
  });
}

const SQL_AGENDAMENTO = `
  SELECT a.*, s.nome AS servico_nome,
    (a.valor_centavos - a.desconto_centavos) AS total_centavos,
    COALESCE((SELECT SUM(p.valor_liquido_centavos) FROM pagamentos p
              WHERE p.agendamento_id = a.id AND p.status = 'pago'), 0) AS pago_centavos,
    (SELECT p.id FROM pagamentos p WHERE p.agendamento_id = a.id AND p.status = 'pendente'
     ORDER BY p.id DESC LIMIT 1) AS pagamento_pendente_id
  FROM agendamentos a JOIN servicos s ON s.id = a.servico_id`;

function buscarAgendamento(db, id) {
  return db.prepare(`${SQL_AGENDAMENTO} WHERE a.id = ?`).get(id) || null;
}

function listarAgendamentos(db, { data, inicio, fim, status, clienteId } = {}) {
  const where = [];
  const params = [];
  if (data) (where.push('a.data = ?'), params.push(data));
  if (inicio) (where.push('a.data >= ?'), params.push(inicio));
  if (fim) (where.push('a.data <= ?'), params.push(fim));
  if (status) (where.push('a.status = ?'), params.push(status));
  if (clienteId) (where.push('a.cliente_id = ?'), params.push(clienteId));
  const filtro = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(`${SQL_AGENDAMENTO} ${filtro} ORDER BY a.data, a.hora, a.id`).all(...params);
}

async function anexarQrCode(pagamento) {
  if (pagamento && pagamento.pix_copia_cola) {
    pagamento.pix_qrcode = await QRCode.toDataURL(pagamento.pix_copia_cola, { margin: 1, width: 280 });
  }
  return pagamento;
}

/**
 * Valor ainda em aberto de um agendamento. No primeiro pagamento o desconto do
 * agendamento (cupom/balcão) entra no recebimento, para aparecer nos relatórios.
 */
function valoresEmAberto(ag) {
  if (ag.pago_centavos === 0) return { bruto: ag.valor_centavos, desconto: ag.desconto_centavos };
  return { bruto: Math.max(0, ag.total_centavos - ag.pago_centavos), desconto: 0 };
}

function buscarPagamento(db, id) {
  return db.prepare('SELECT * FROM pagamentos WHERE id = ?').get(id) || null;
}

/**
 * Cliente gera a cobrança de um agendamento. Pix gera um QR Code estático com o valor;
 * cartão/dinheiro ficam pendentes para pagamento no balcão.
 */
async function solicitarPagamentoCliente(db, agendamentoId, clienteId, metodo) {
  if (!['pix', 'cartao_credito', 'cartao_debito', 'dinheiro'].includes(metodo)) {
    throw new ErroNegocio('Forma de pagamento inválida');
  }
  const ag = buscarAgendamento(db, agendamentoId);
  if (!ag || ag.cliente_id !== clienteId) throw new ErroNegocio('Agendamento não encontrado', 404);
  if (ag.status === 'cancelado') throw new ErroNegocio('Agendamento cancelado');
  const aberto = valoresEmAberto(ag);
  const restante = aberto.bruto - aberto.desconto;
  if (restante <= 0) throw new ErroNegocio('Este agendamento já está pago');

  const cfg = lerConfig(db);
  if (metodo === 'pix' && !cfg.pix_chave) {
    throw new ErroNegocio('O lava jato ainda não configurou a chave Pix. Pague no local.');
  }

  const pagamento = transacao(db, () => {
    db.prepare(
      "UPDATE pagamentos SET status = 'cancelado' WHERE agendamento_id = ? AND status = 'pendente'"
    ).run(ag.id);

    const txid = metodo === 'pix' ? `LJ${ag.id}${crypto.randomBytes(4).toString('hex')}`.toUpperCase() : null;
    const copiaCola =
      metodo === 'pix'
        ? gerarPixCopiaECola({
            chave: cfg.pix_chave,
            nome: cfg.pix_nome || cfg.nome_empresa,
            cidade: cfg.pix_cidade,
            valorCentavos: restante,
            txid,
          })
        : null;

    const r = db
      .prepare(
        `INSERT INTO pagamentos
          (agendamento_id, descricao, valor_bruto_centavos, desconto_centavos,
           valor_liquido_centavos, metodo, status, origem, pix_txid, pix_copia_cola)
         VALUES (?, ?, ?, ?, ?, ?, 'pendente', 'cliente', ?, ?)`
      )
      .run(
        ag.id,
        `${ag.servico_nome} - ${ag.placa}`,
        aberto.bruto,
        aberto.desconto,
        restante,
        metodo,
        txid,
        copiaCola
      );
    return buscarPagamento(db, Number(r.lastInsertRowid));
  });
  return anexarQrCode(pagamento);
}

/** Dono lança um recebimento (avulso ou vinculado a um agendamento). */
function lancarRecebimento(db, dados) {
  const metodo = dados.metodo;
  if (!['pix', 'cartao_credito', 'cartao_debito', 'dinheiro'].includes(metodo)) {
    throw new ErroNegocio('Forma de pagamento inválida');
  }

  return transacao(db, () => {
    let ag = null;
    let descricao = String(dados.descricao || '').trim();
    let bruto;
    let descontoBase = 0;
    if (dados.agendamento_id) {
      ag = buscarAgendamento(db, Number(dados.agendamento_id));
      if (!ag) throw new ErroNegocio('Agendamento não encontrado', 404);
      if (ag.status === 'cancelado') throw new ErroNegocio('Agendamento cancelado');
      if (dados.valor !== undefined && dados.valor !== '') {
        bruto = reaisParaCentavos(dados.valor);
      } else {
        ({ bruto, desconto: descontoBase } = valoresEmAberto(ag));
      }
      descricao = descricao || `${ag.servico_nome} - ${ag.placa}`;
    } else {
      bruto = reaisParaCentavos(dados.valor);
    }
    if (!descricao) throw new ErroNegocio('Informe uma descrição');
    if (bruto <= 0) throw new ErroNegocio('Valor deve ser maior que zero');

    // Desconto dado no balcão, aplicado sobre o valor já com o desconto do agendamento.
    const base = bruto - descontoBase;
    let extra = 0;
    const descontoInformado = String(dados.desconto ?? '').trim();
    if (descontoInformado && Number(descontoInformado.replace(',', '.')) !== 0) {
      extra =
        dados.desconto_tipo === 'percentual'
          ? calcularDesconto(base, 'percentual', Number(descontoInformado.replace(',', '.')))
          : Math.min(base, reaisParaCentavos(descontoInformado));
    }
    const desconto = descontoBase + extra;

    const status = dados.status === 'pendente' ? 'pendente' : 'pago';
    if (ag) {
      // Um recebimento manual substitui cobranças pendentes geradas pelo cliente.
      db.prepare(
        "UPDATE pagamentos SET status = 'cancelado' WHERE agendamento_id = ? AND status = 'pendente'"
      ).run(ag.id);
    }
    const r = db
      .prepare(
        `INSERT INTO pagamentos
          (agendamento_id, descricao, valor_bruto_centavos, desconto_centavos,
           valor_liquido_centavos, metodo, status, origem, pago_em)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'admin',
                 CASE WHEN ? = 'pago' THEN datetime('now', 'localtime') END)`
      )
      .run(ag ? ag.id : null, descricao, bruto, desconto, bruto - desconto, metodo, status, status);
    return buscarPagamento(db, Number(r.lastInsertRowid));
  });
}

function alterarStatusPagamento(db, id, status) {
  if (!['pago', 'cancelado'].includes(status)) throw new ErroNegocio('Status inválido');
  const p = buscarPagamento(db, id);
  if (!p) throw new ErroNegocio('Pagamento não encontrado', 404);
  if (p.status !== 'pendente') throw new ErroNegocio(`Pagamento já está ${p.status}`);
  db.prepare(
    `UPDATE pagamentos SET status = ?,
       pago_em = CASE WHEN ? = 'pago' THEN datetime('now', 'localtime') END
     WHERE id = ?`
  ).run(status, status, id);
  return buscarPagamento(db, id);
}

function resumoFinanceiro(db, inicio, fim) {
  validarData(inicio);
  validarData(fim);
  const filtro = "status = 'pago' AND date(pago_em) BETWEEN ? AND ?";
  const total = db
    .prepare(
      `SELECT COUNT(*) AS quantidade,
              COALESCE(SUM(valor_bruto_centavos), 0) AS bruto_centavos,
              COALESCE(SUM(desconto_centavos), 0) AS descontos_centavos,
              COALESCE(SUM(valor_liquido_centavos), 0) AS liquido_centavos
       FROM pagamentos WHERE ${filtro}`
    )
    .get(inicio, fim);
  const porMetodo = db
    .prepare(
      `SELECT metodo, COUNT(*) AS quantidade, SUM(valor_liquido_centavos) AS liquido_centavos
       FROM pagamentos WHERE ${filtro} GROUP BY metodo ORDER BY liquido_centavos DESC`
    )
    .all(inicio, fim);
  const porDia = db
    .prepare(
      `SELECT date(pago_em) AS dia, SUM(valor_liquido_centavos) AS liquido_centavos
       FROM pagamentos WHERE ${filtro} GROUP BY dia ORDER BY dia`
    )
    .all(inicio, fim);
  const pendentes = db
    .prepare(
      `SELECT COUNT(*) AS quantidade, COALESCE(SUM(valor_liquido_centavos), 0) AS liquido_centavos
       FROM pagamentos WHERE status = 'pendente'`
    )
    .get();
  return { inicio, fim, ...total, por_metodo: porMetodo, por_dia: porDia, pendentes };
}

module.exports = {
  ErroNegocio,
  dataLocal,
  reaisParaCentavos,
  calcularDesconto,
  buscarCupom,
  horariosDisponiveis,
  criarAgendamento,
  buscarAgendamento,
  listarAgendamentos,
  buscarPagamento,
  anexarQrCode,
  solicitarPagamentoCliente,
  lancarRecebimento,
  alterarStatusPagamento,
  resumoFinanceiro,
};
