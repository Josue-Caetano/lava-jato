'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirBanco, garantirAdmin } = require('../src/db');
const { criarApp } = require('../src/app');
const { gerarPixCopiaECola, crc16 } = require('../src/pix');
const { horariosDisponiveis, dataLocal } = require('../src/negocio');

let servidor;
let base;
let db;
let tokenAdmin;
let tokenCliente;

function proximoDiaUtil() {
  const d = new Date();
  do d.setDate(d.getDate() + 1); while (d.getDay() === 0);
  return dataLocal(d);
}

async function req(metodo, url, corpo, token) {
  const r = await fetch(base + url, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  return { status: r.status, corpo: await r.json() };
}

before(async () => {
  db = abrirBanco(':memory:');
  garantirAdmin(db, { email: 'dono@teste.com', senha: 'segredo123' });
  servidor = criarApp(db).listen(0);
  await new Promise((ok) => servidor.once('listening', ok));
  base = `http://127.0.0.1:${servidor.address().port}`;
  tokenAdmin = (await req('POST', '/api/auth/login', { email: 'dono@teste.com', senha: 'segredo123' })).corpo.token;
});

after(() => servidor.close());

test('CRC16 do Pix segue o padrão CCITT-FALSE', () => {
  assert.equal(crc16('123456789'), '29B1');
});

test('gera Pix Copia e Cola com valor, recebedor e CRC válido', () => {
  const codigo = gerarPixCopiaECola({
    chave: 'contato@lavajato.com.br', nome: 'João Lavações', cidade: 'São Paulo', valorCentavos: 7050, txid: 'LJ1',
  });
  assert.ok(codigo.startsWith('000201'));
  assert.ok(codigo.includes('0014br.gov.bcb.pix0123contato@lavajato.com.br'));
  assert.ok(codigo.includes('540570.50'));
  assert.ok(codigo.includes('5913JOAO LAVACOES'));
  assert.ok(codigo.includes('6009SAO PAULO'));
  assert.ok(codigo.includes('62070503LJ1'));
  assert.equal(codigo.slice(-4), crc16(codigo.slice(0, -4)));
});

test('cadastro e login do cliente', async () => {
  const r = await req('POST', '/api/auth/cadastro', { nome: 'Maria', email: 'maria@x.com', telefone: '11999', senha: '123456' });
  assert.equal(r.status, 201);
  assert.equal(r.corpo.usuario.papel, 'cliente');
  tokenCliente = r.corpo.token;

  assert.equal((await req('POST', '/api/auth/cadastro', { nome: 'M', email: 'MARIA@x.com', senha: '123456' })).status, 409);
  assert.equal((await req('POST', '/api/auth/login', { email: 'maria@x.com', senha: 'errada' })).status, 401);
});

test('cliente não acessa o painel do dono', async () => {
  assert.equal((await req('GET', '/api/admin/resumo', undefined, tokenCliente)).status, 403);
  assert.equal((await req('GET', '/api/admin/resumo')).status, 401);
});

test('fluxo completo: cupom, agendamento, Pix e confirmação pelo dono', async () => {
  await req('PUT', '/api/admin/config', { pix_chave: '12345678901', pix_nome: 'Lava Jato Teste', pix_cidade: 'Campinas' }, tokenAdmin);
  const cupom = await req('POST', '/api/admin/cupons', { codigo: 'promo10', tipo: 'percentual', valor: 10 }, tokenAdmin);
  assert.equal(cupom.status, 201);
  assert.equal(cupom.corpo.codigo, 'PROMO10');

  const servicos = (await req('GET', '/api/publico/servicos')).corpo;
  const completa = servicos.find((s) => s.nome === 'Lavagem completa'); // R$ 70,00
  const data = proximoDiaUtil();
  const horarios = (await req('GET', `/api/publico/horarios?data=${data}&servico_id=${completa.id}`)).corpo;
  assert.ok(horarios.includes('08:00'));

  const ag = await req('POST', '/api/cliente/agendamentos', {
    servico_id: completa.id, data, hora: '08:00', placa: 'abc1d23', modelo: 'Gol', cupom: 'PROMO10',
  }, tokenCliente);
  assert.equal(ag.status, 201, JSON.stringify(ag.corpo));
  assert.equal(ag.corpo.placa, 'ABC1D23');
  assert.equal(ag.corpo.nome_cliente, 'Maria');
  assert.equal(ag.corpo.total_centavos, 6300);

  const pix = await req('POST', `/api/cliente/agendamentos/${ag.corpo.id}/pagamento`, { metodo: 'pix' }, tokenCliente);
  assert.equal(pix.status, 201);
  assert.equal(pix.corpo.status, 'pendente');
  assert.equal(pix.corpo.valor_bruto_centavos, 7000);
  assert.equal(pix.corpo.desconto_centavos, 700);
  assert.equal(pix.corpo.valor_liquido_centavos, 6300);
  assert.ok(pix.corpo.pix_copia_cola.includes('540563.00'));
  assert.ok(pix.corpo.pix_qrcode.startsWith('data:image/png;base64,'));

  const confirmado = await req('PATCH', `/api/admin/pagamentos/${pix.corpo.id}`, { status: 'pago' }, tokenAdmin);
  assert.equal(confirmado.corpo.status, 'pago');

  const meus = (await req('GET', '/api/cliente/agendamentos', undefined, tokenCliente)).corpo;
  assert.equal(meus[0].pago_centavos, 6300);
  const novamente = await req('POST', `/api/cliente/agendamentos/${ag.corpo.id}/pagamento`, { metodo: 'pix' }, tokenCliente);
  assert.equal(novamente.status, 400);
  assert.equal((await req('POST', `/api/cliente/agendamentos/${ag.corpo.id}/cancelar`, undefined, tokenCliente)).status, 400);
});

test('respeita a quantidade de vagas simultâneas', async () => {
  await req('PUT', '/api/admin/config', { vagas_simultaneas: '1' }, tokenAdmin);
  const data = proximoDiaUtil();
  const servico = (await req('GET', '/api/publico/servicos')).corpo[0];
  // 08:00 já está ocupado pela lavagem completa (60 min) do teste anterior.
  const livres = horariosDisponiveis(db, data, servico.id);
  assert.ok(!livres.includes('08:00'));
  assert.ok(!livres.includes('08:30'));
  assert.ok(livres.includes('09:00'));
  const r = await req('POST', '/api/cliente/agendamentos', { servico_id: servico.id, data, hora: '08:30', placa: 'XYZ' }, tokenCliente);
  assert.equal(r.status, 409);
  await req('PUT', '/api/admin/config', { vagas_simultaneas: '2' }, tokenAdmin);
});

test('dia bloqueado e agendamento online desativado', async () => {
  const data = proximoDiaUtil();
  await req('POST', '/api/admin/bloqueios', { data, motivo: 'Feriado' }, tokenAdmin);
  assert.deepEqual((await req('GET', `/api/publico/horarios?data=${data}&servico_id=1`)).corpo, []);
  await req('DELETE', `/api/admin/bloqueios/${data}`, undefined, tokenAdmin);

  await req('PUT', '/api/admin/config', { agendamento_online: '0' }, tokenAdmin);
  const r = await req('POST', '/api/cliente/agendamentos', { servico_id: 1, data, hora: '10:00', placa: 'AAA' }, tokenCliente);
  assert.equal(r.status, 400);
  await req('PUT', '/api/admin/config', { agendamento_online: '1' }, tokenAdmin);
});

test('dono lança recebimentos com desconto e vê o resumo por forma de pagamento', async () => {
  const avulso = await req('POST', '/api/admin/pagamentos', {
    descricao: 'Lavagem de moto', valor: '35,00', metodo: 'dinheiro', desconto: '5', desconto_tipo: 'fixo',
  }, tokenAdmin);
  assert.equal(avulso.status, 201);
  assert.equal(avulso.corpo.valor_liquido_centavos, 3000);

  const ag = await req('POST', '/api/admin/agendamentos', {
    nome_cliente: 'Carlos', placa: 'CAR0001', servico_id: 3, data: dataLocal(), hora: '07:00',
  }, tokenAdmin);
  assert.equal(ag.status, 201, JSON.stringify(ag.corpo));
  const cartao = await req('POST', '/api/admin/pagamentos', {
    agendamento_id: ag.corpo.id, metodo: 'cartao_credito', desconto: '10', desconto_tipo: 'percentual',
  }, tokenAdmin);
  assert.equal(cartao.corpo.valor_bruto_centavos, 11000);
  assert.equal(cartao.corpo.desconto_centavos, 1100);
  assert.equal(cartao.corpo.valor_liquido_centavos, 9900);

  const hoje = dataLocal();
  const resumo = (await req('GET', `/api/admin/resumo?inicio=${hoje}&fim=${hoje}`, undefined, tokenAdmin)).corpo;
  assert.equal(resumo.quantidade, 3);
  assert.equal(resumo.liquido_centavos, 6300 + 3000 + 9900);
  // 10% do cupom PROMO10 (R$ 7,00) + R$ 5,00 + 10% no balcão (R$ 11,00)
  assert.equal(resumo.descontos_centavos, 700 + 500 + 1100);
  const porMetodo = Object.fromEntries(resumo.por_metodo.map((m) => [m.metodo, m.liquido_centavos]));
  assert.deepEqual(porMetodo, { pix: 6300, dinheiro: 3000, cartao_credito: 9900 });
});

test('valida entradas inválidas', async () => {
  assert.equal((await req('POST', '/api/admin/pagamentos', { descricao: 'x', valor: 'abc', metodo: 'pix' }, tokenAdmin)).status, 400);
  assert.equal((await req('POST', '/api/admin/pagamentos', { descricao: 'x', valor: '10', metodo: 'boleto' }, tokenAdmin)).status, 400);
  assert.equal((await req('GET', '/api/publico/horarios?data=2024-02-31&servico_id=1')).status, 400);
  assert.equal((await req('GET', '/api/publico/cupom/NAOEXISTE')).status, 400);
  assert.equal((await req('PUT', '/api/admin/config', { horario_abertura: '8h' }, tokenAdmin)).status, 400);
});
