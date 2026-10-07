'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  telefone TEXT,
  senha_hash TEXT NOT NULL,
  papel TEXT NOT NULL CHECK (papel IN ('admin', 'cliente')),
  criado_em TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS servicos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  descricao TEXT,
  preco_centavos INTEGER NOT NULL CHECK (preco_centavos >= 0),
  duracao_min INTEGER NOT NULL CHECK (duracao_min > 0),
  ativo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS cupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo TEXT NOT NULL UNIQUE COLLATE NOCASE,
  tipo TEXT NOT NULL CHECK (tipo IN ('percentual', 'fixo')),
  valor INTEGER NOT NULL CHECK (valor > 0),
  validade TEXT,
  ativo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS agendamentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id INTEGER REFERENCES usuarios(id),
  nome_cliente TEXT NOT NULL,
  telefone TEXT,
  placa TEXT NOT NULL,
  modelo TEXT,
  servico_id INTEGER NOT NULL REFERENCES servicos(id),
  data TEXT NOT NULL,
  hora TEXT NOT NULL,
  duracao_min INTEGER NOT NULL,
  valor_centavos INTEGER NOT NULL,
  desconto_centavos INTEGER NOT NULL DEFAULT 0,
  cupom_codigo TEXT,
  status TEXT NOT NULL DEFAULT 'agendado'
    CHECK (status IN ('agendado', 'em_andamento', 'concluido', 'cancelado')),
  observacoes TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_agendamentos_data ON agendamentos (data, status);

CREATE TABLE IF NOT EXISTS pagamentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agendamento_id INTEGER REFERENCES agendamentos(id),
  descricao TEXT NOT NULL,
  valor_bruto_centavos INTEGER NOT NULL CHECK (valor_bruto_centavos >= 0),
  desconto_centavos INTEGER NOT NULL DEFAULT 0 CHECK (desconto_centavos >= 0),
  valor_liquido_centavos INTEGER NOT NULL CHECK (valor_liquido_centavos >= 0),
  metodo TEXT NOT NULL
    CHECK (metodo IN ('pix', 'cartao_credito', 'cartao_debito', 'dinheiro')),
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'pago', 'cancelado')),
  origem TEXT NOT NULL CHECK (origem IN ('cliente', 'admin')),
  pix_txid TEXT,
  pix_copia_cola TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  pago_em TEXT
);
CREATE INDEX IF NOT EXISTS idx_pagamentos_pago_em ON pagamentos (status, pago_em);

CREATE TABLE IF NOT EXISTS bloqueios (
  data TEXT PRIMARY KEY,
  motivo TEXT
);

CREATE TABLE IF NOT EXISTS config (
  chave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);
`;

const CONFIG_PADRAO = {
  nome_empresa: 'Lava Jato',
  telefone_empresa: '',
  endereco_empresa: '',
  agendamento_online: '1',
  horario_abertura: '08:00',
  horario_fechamento: '18:00',
  intervalo_min: '30',
  vagas_simultaneas: '2',
  dias_funcionamento: '1,2,3,4,5,6', // 0 = domingo ... 6 = sábado
  antecedencia_max_dias: '30',
  pix_chave: '',
  pix_nome: '',
  pix_cidade: '',
};

const SERVICOS_PADRAO = [
  ['Lavagem simples', 'Lavagem externa com secagem', 4000, 30],
  ['Lavagem completa', 'Externa + aspiração e painel', 7000, 60],
  ['Lavagem + cera', 'Lavagem completa com enceramento', 11000, 90],
  ['Higienização interna', 'Bancos, carpetes e teto', 25000, 180],
];

function hashSenha(senha) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(senha, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function conferirSenha(senha, armazenado) {
  const [salt, hash] = String(armazenado).split(':');
  if (!salt || !hash) return false;
  const esperado = Buffer.from(hash, 'hex');
  const calculado = crypto.scryptSync(senha, salt, esperado.length);
  return crypto.timingSafeEqual(esperado, calculado);
}

function abrirBanco(arquivo) {
  if (arquivo !== ':memory:') fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const db = new DatabaseSync(arquivo);
  db.exec('PRAGMA foreign_keys = ON;');
  if (arquivo !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);

  const inserirConfig = db.prepare('INSERT OR IGNORE INTO config (chave, valor) VALUES (?, ?)');
  for (const [chave, valor] of Object.entries(CONFIG_PADRAO)) inserirConfig.run(chave, valor);
  inserirConfig.run('segredo_sessao', crypto.randomBytes(32).toString('hex'));

  if (db.prepare('SELECT COUNT(*) AS n FROM servicos').get().n === 0) {
    const ins = db.prepare(
      'INSERT INTO servicos (nome, descricao, preco_centavos, duracao_min) VALUES (?, ?, ?, ?)'
    );
    for (const s of SERVICOS_PADRAO) ins.run(...s);
  }

  return db;
}

/** Cria o usuário dono na primeira execução. Retorna a senha gerada, se houver. */
function garantirAdmin(db, { email, senha } = {}) {
  const existe = db.prepare("SELECT 1 FROM usuarios WHERE papel = 'admin' LIMIT 1").get();
  if (existe) return null;
  const emailAdmin = email || 'admin@lavajato.local';
  const senhaAdmin = senha || crypto.randomBytes(6).toString('base64url');
  db.prepare(
    "INSERT INTO usuarios (nome, email, senha_hash, papel) VALUES ('Dono', ?, ?, 'admin')"
  ).run(emailAdmin, hashSenha(senhaAdmin));
  return { email: emailAdmin, senha: senha ? null : senhaAdmin };
}

function lerConfig(db) {
  const cfg = {};
  for (const { chave, valor } of db.prepare('SELECT chave, valor FROM config').all()) {
    cfg[chave] = valor;
  }
  return cfg;
}

function transacao(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = {
  abrirBanco,
  garantirAdmin,
  lerConfig,
  transacao,
  hashSenha,
  conferirSenha,
  CONFIG_PADRAO,
};
