'use strict';

const path = require('node:path');
const express = require('express');
const { lerConfig, hashSenha, conferirSenha, CONFIG_PADRAO } = require('./db');
const { criarToken, middlewareAuth, exigir } = require('./auth');
const n = require('./negocio');

const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RE_HORA = /^\d{2}:\d{2}$/;

function limitadorLogin() {
  const tentativas = new Map();
  return (req, res, next) => {
    const agora = Date.now();
    const chave = req.ip;
    const t = (tentativas.get(chave) || []).filter((ts) => agora - ts < 15 * 60 * 1000);
    if (t.length >= 20) {
      return res.status(429).json({ erro: 'Muitas tentativas. Aguarde alguns minutos.' });
    }
    t.push(agora);
    tentativas.set(chave, t);
    next();
  };
}

function criarApp(db) {
  const app = express();
  const segredo = lerConfig(db).segredo_sessao;
  const rota = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const id = (req) => Number(req.params.id);

  app.use(express.json({ limit: '100kb' }));
  app.use(middlewareAuth(db, segredo));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ---------------------------------------------------------------- público
  app.get('/api/publico/info', (_req, res) => {
    const c = lerConfig(db);
    res.json({
      nome_empresa: c.nome_empresa,
      telefone_empresa: c.telefone_empresa,
      endereco_empresa: c.endereco_empresa,
      agendamento_online: c.agendamento_online === '1',
      pix_disponivel: Boolean(c.pix_chave),
      horario_abertura: c.horario_abertura,
      horario_fechamento: c.horario_fechamento,
      dias_funcionamento: c.dias_funcionamento.split(',').map(Number),
      antecedencia_max_dias: Number(c.antecedencia_max_dias),
    });
  });

  app.get('/api/publico/servicos', (_req, res) => {
    res.json(db.prepare('SELECT * FROM servicos WHERE ativo = 1 ORDER BY preco_centavos').all());
  });

  app.get('/api/publico/horarios', (req, res) => {
    res.json(n.horariosDisponiveis(db, req.query.data, Number(req.query.servico_id)));
  });

  app.get('/api/publico/cupom/:codigo', (req, res) => {
    const c = n.buscarCupom(db, req.params.codigo);
    res.json({ codigo: c.codigo, tipo: c.tipo, valor: c.valor });
  });

  // ------------------------------------------------------------ autenticação
  const respostaLogin = (u) => ({
    token: criarToken(segredo, u),
    usuario: { id: u.id, nome: u.nome, email: u.email, telefone: u.telefone, papel: u.papel },
  });

  app.post('/api/auth/cadastro', limitadorLogin(), (req, res) => {
    const nome = String(req.body.nome || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const telefone = String(req.body.telefone || '').trim();
    const senha = String(req.body.senha || '');
    if (!nome) throw new n.ErroNegocio('Informe seu nome');
    if (!RE_EMAIL.test(email)) throw new n.ErroNegocio('E-mail inválido');
    if (senha.length < 6) throw new n.ErroNegocio('A senha deve ter pelo menos 6 caracteres');
    if (db.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(email)) {
      throw new n.ErroNegocio('Este e-mail já está cadastrado', 409);
    }
    const r = db
      .prepare(
        "INSERT INTO usuarios (nome, email, telefone, senha_hash, papel) VALUES (?, ?, ?, ?, 'cliente')"
      )
      .run(nome, email, telefone || null, hashSenha(senha));
    const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(Number(r.lastInsertRowid));
    res.status(201).json(respostaLogin(u));
  });

  app.post('/api/auth/login', limitadorLogin(), (req, res) => {
    const u = db
      .prepare('SELECT * FROM usuarios WHERE email = ?')
      .get(String(req.body.email || '').trim());
    if (!u || !conferirSenha(String(req.body.senha || ''), u.senha_hash)) {
      return res.status(401).json({ erro: 'E-mail ou senha incorretos' });
    }
    res.json(respostaLogin(u));
  });

  app.get('/api/auth/eu', exigir(), (req, res) => res.json(req.usuario));

  app.post('/api/auth/senha', exigir(), (req, res) => {
    const u = db.prepare('SELECT senha_hash FROM usuarios WHERE id = ?').get(req.usuario.id);
    if (!conferirSenha(String(req.body.atual || ''), u.senha_hash)) {
      throw new n.ErroNegocio('Senha atual incorreta');
    }
    const nova = String(req.body.nova || '');
    if (nova.length < 6) throw new n.ErroNegocio('A nova senha deve ter pelo menos 6 caracteres');
    db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(hashSenha(nova), req.usuario.id);
    res.json({ ok: true });
  });

  // ----------------------------------------------------------------- cliente
  const cliente = express.Router();
  cliente.use(exigir('cliente'));

  cliente.get('/agendamentos', (req, res) => {
    res.json(n.listarAgendamentos(db, { clienteId: req.usuario.id }).reverse());
  });

  cliente.post('/agendamentos', (req, res) => {
    const ag = n.criarAgendamento(
      db,
      {
        ...req.body,
        nome_cliente: req.body.nome_cliente || req.usuario.nome,
        telefone: req.body.telefone || req.usuario.telefone,
        desconto: undefined,
      },
      { clienteId: req.usuario.id }
    );
    res.status(201).json(ag);
  });

  cliente.post('/agendamentos/:id/cancelar', (req, res) => {
    const ag = n.buscarAgendamento(db, id(req));
    if (!ag || ag.cliente_id !== req.usuario.id) {
      throw new n.ErroNegocio('Agendamento não encontrado', 404);
    }
    if (ag.status !== 'agendado') throw new n.ErroNegocio('Este agendamento não pode mais ser cancelado');
    if (ag.pago_centavos > 0) {
      throw new n.ErroNegocio('Agendamento já pago. Fale com o lava jato para cancelar.');
    }
    db.prepare("UPDATE agendamentos SET status = 'cancelado' WHERE id = ?").run(ag.id);
    db.prepare(
      "UPDATE pagamentos SET status = 'cancelado' WHERE agendamento_id = ? AND status = 'pendente'"
    ).run(ag.id);
    res.json(n.buscarAgendamento(db, ag.id));
  });

  cliente.post(
    '/agendamentos/:id/pagamento',
    rota(async (req, res) => {
      res.status(201).json(
        await n.solicitarPagamentoCliente(db, id(req), req.usuario.id, req.body.metodo)
      );
    })
  );

  cliente.get(
    '/pagamentos/:id',
    rota(async (req, res) => {
      const p = n.buscarPagamento(db, id(req));
      const ag = p && p.agendamento_id ? n.buscarAgendamento(db, p.agendamento_id) : null;
      if (!ag || ag.cliente_id !== req.usuario.id) {
        throw new n.ErroNegocio('Pagamento não encontrado', 404);
      }
      res.json(await n.anexarQrCode(p));
    })
  );

  app.use('/api/cliente', cliente);

  // ------------------------------------------------------------------- admin
  const admin = express.Router();
  admin.use(exigir('admin'));

  admin.get('/resumo', (req, res) => {
    const hoje = n.dataLocal();
    res.json(n.resumoFinanceiro(db, req.query.inicio || hoje, req.query.fim || hoje));
  });

  admin.get('/agendamentos', (req, res) => {
    const { data, inicio, fim, status } = req.query;
    res.json(n.listarAgendamentos(db, { data, inicio, fim, status }));
  });

  admin.post('/agendamentos', (req, res) => {
    res.status(201).json(n.criarAgendamento(db, req.body, { origemAdmin: true }));
  });

  admin.patch('/agendamentos/:id', (req, res) => {
    const ag = n.buscarAgendamento(db, id(req));
    if (!ag) throw new n.ErroNegocio('Agendamento não encontrado', 404);
    const status = req.body.status;
    if (!['agendado', 'em_andamento', 'concluido', 'cancelado'].includes(status)) {
      throw new n.ErroNegocio('Status inválido');
    }
    db.prepare('UPDATE agendamentos SET status = ? WHERE id = ?').run(status, ag.id);
    if (status === 'cancelado') {
      db.prepare(
        "UPDATE pagamentos SET status = 'cancelado' WHERE agendamento_id = ? AND status = 'pendente'"
      ).run(ag.id);
    }
    res.json(n.buscarAgendamento(db, ag.id));
  });

  admin.get('/pagamentos', (req, res) => {
    const where = [];
    const params = [];
    if (req.query.status) (where.push('p.status = ?'), params.push(req.query.status));
    if (req.query.inicio) (where.push('date(p.criado_em) >= ?'), params.push(req.query.inicio));
    if (req.query.fim) (where.push('date(p.criado_em) <= ?'), params.push(req.query.fim));
    const filtro = where.length ? `WHERE ${where.join(' AND ')}` : '';
    res.json(
      db
        .prepare(
          `SELECT p.*, a.nome_cliente, a.placa, a.data AS agendamento_data, a.hora AS agendamento_hora
           FROM pagamentos p LEFT JOIN agendamentos a ON a.id = p.agendamento_id
           ${filtro} ORDER BY p.id DESC LIMIT 500`
        )
        .all(...params)
    );
  });

  admin.post('/pagamentos', (req, res) => {
    res.status(201).json(n.lancarRecebimento(db, req.body));
  });

  admin.patch('/pagamentos/:id', (req, res) => {
    res.json(n.alterarStatusPagamento(db, id(req), req.body.status));
  });

  // Serviços
  const lerServico = (b) => {
    const nome = String(b.nome || '').trim();
    const duracao = Number(b.duracao_min);
    if (!nome) throw new n.ErroNegocio('Informe o nome do serviço');
    if (!Number.isInteger(duracao) || duracao <= 0) throw new n.ErroNegocio('Duração inválida');
    return [nome, String(b.descricao || '').trim() || null, n.reaisParaCentavos(b.preco), duracao];
  };

  admin.get('/servicos', (_req, res) => {
    res.json(db.prepare('SELECT * FROM servicos ORDER BY ativo DESC, nome').all());
  });
  admin.post('/servicos', (req, res) => {
    const r = db
      .prepare('INSERT INTO servicos (nome, descricao, preco_centavos, duracao_min) VALUES (?, ?, ?, ?)')
      .run(...lerServico(req.body));
    res.status(201).json(db.prepare('SELECT * FROM servicos WHERE id = ?').get(Number(r.lastInsertRowid)));
  });
  admin.put('/servicos/:id', (req, res) => {
    const r = db
      .prepare(
        'UPDATE servicos SET nome = ?, descricao = ?, preco_centavos = ?, duracao_min = ?, ativo = ? WHERE id = ?'
      )
      .run(...lerServico(req.body), req.body.ativo === false ? 0 : 1, id(req));
    if (!r.changes) throw new n.ErroNegocio('Serviço não encontrado', 404);
    res.json(db.prepare('SELECT * FROM servicos WHERE id = ?').get(id(req)));
  });

  // Cupons de desconto
  admin.get('/cupons', (_req, res) => {
    res.json(db.prepare('SELECT * FROM cupons ORDER BY ativo DESC, codigo').all());
  });
  admin.post('/cupons', (req, res) => {
    const codigo = String(req.body.codigo || '').trim().toUpperCase();
    const tipo = req.body.tipo === 'fixo' ? 'fixo' : 'percentual';
    const valor =
      tipo === 'fixo' ? n.reaisParaCentavos(req.body.valor) : Math.round(Number(req.body.valor));
    if (!/^[A-Z0-9_-]{3,30}$/.test(codigo)) {
      throw new n.ErroNegocio('Código deve ter de 3 a 30 letras/números');
    }
    if (!(valor > 0) || (tipo === 'percentual' && valor > 100)) {
      throw new n.ErroNegocio('Valor do desconto inválido');
    }
    if (db.prepare('SELECT 1 FROM cupons WHERE codigo = ?').get(codigo)) {
      throw new n.ErroNegocio('Já existe um cupom com esse código', 409);
    }
    const r = db
      .prepare('INSERT INTO cupons (codigo, tipo, valor, validade) VALUES (?, ?, ?, ?)')
      .run(codigo, tipo, valor, req.body.validade || null);
    res.status(201).json(db.prepare('SELECT * FROM cupons WHERE id = ?').get(Number(r.lastInsertRowid)));
  });
  admin.patch('/cupons/:id', (req, res) => {
    db.prepare('UPDATE cupons SET ativo = ? WHERE id = ?').run(req.body.ativo ? 1 : 0, id(req));
    res.json(db.prepare('SELECT * FROM cupons WHERE id = ?').get(id(req)));
  });

  // Dias bloqueados (feriados, manutenção...)
  admin.get('/bloqueios', (_req, res) => {
    res.json(db.prepare('SELECT * FROM bloqueios WHERE data >= ? ORDER BY data').all(n.dataLocal()));
  });
  admin.post('/bloqueios', (req, res) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(req.body.data))) throw new n.ErroNegocio('Data inválida');
    db.prepare('INSERT OR REPLACE INTO bloqueios (data, motivo) VALUES (?, ?)').run(
      req.body.data,
      String(req.body.motivo || '').trim() || null
    );
    res.status(201).json({ ok: true });
  });
  admin.delete('/bloqueios/:data', (req, res) => {
    db.prepare('DELETE FROM bloqueios WHERE data = ?').run(req.params.data);
    res.json({ ok: true });
  });

  // Configurações
  admin.get('/config', (_req, res) => {
    const { segredo_sessao, ...cfg } = lerConfig(db);
    res.json(cfg);
  });
  admin.put('/config', (req, res) => {
    const novo = {};
    for (const chave of Object.keys(CONFIG_PADRAO)) {
      if (req.body[chave] !== undefined) novo[chave] = String(req.body[chave]).trim();
    }
    for (const chave of ['horario_abertura', 'horario_fechamento']) {
      if (novo[chave] !== undefined && !RE_HORA.test(novo[chave])) {
        throw new n.ErroNegocio('Horário inválido (use HH:MM)');
      }
    }
    for (const chave of ['intervalo_min', 'vagas_simultaneas', 'antecedencia_max_dias']) {
      if (novo[chave] !== undefined && !(Number.isInteger(Number(novo[chave])) && Number(novo[chave]) > 0)) {
        throw new n.ErroNegocio(`Valor inválido para ${chave}`);
      }
    }
    if (novo.dias_funcionamento !== undefined && !/^[0-6](,[0-6])*$/.test(novo.dias_funcionamento)) {
      throw new n.ErroNegocio('Dias de funcionamento inválidos');
    }
    const up = db.prepare('UPDATE config SET valor = ? WHERE chave = ?');
    for (const [chave, valor] of Object.entries(novo)) up.run(valor, chave);
    const { segredo_sessao, ...cfg } = lerConfig(db);
    res.json(cfg);
  });

  admin.get('/clientes', (_req, res) => {
    res.json(
      db
        .prepare(
          `SELECT u.id, u.nome, u.email, u.telefone, u.criado_em,
             (SELECT COUNT(*) FROM agendamentos a WHERE a.cliente_id = u.id) AS agendamentos
           FROM usuarios u WHERE u.papel = 'cliente' ORDER BY u.nome`
        )
        .all()
    );
  });

  app.use('/api/admin', admin);

  // ------------------------------------------------------------------- erros
  app.use('/api', (_req, res) => res.status(404).json({ erro: 'Rota não encontrada' }));
  app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof n.ErroNegocio) return res.status(err.status).json({ erro: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ erro: 'JSON inválido' });
    console.error(err);
    res.status(500).json({ erro: 'Erro interno no servidor' });
  });

  return app;
}

module.exports = { criarApp };
