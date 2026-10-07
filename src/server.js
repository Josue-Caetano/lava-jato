'use strict';

const path = require('node:path');
const { abrirBanco, garantirAdmin } = require('./db');
const { criarApp } = require('./app');

process.env.TZ = process.env.TZ || 'America/Sao_Paulo';

const PORTA = Number(process.env.PORT) || 3000;
const ARQUIVO_BANCO = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'lavajato.db');

const db = abrirBanco(ARQUIVO_BANCO);
const admin = garantirAdmin(db, { email: process.env.ADMIN_EMAIL, senha: process.env.ADMIN_SENHA });
if (admin) {
  console.log('\n=== Usuário do dono criado ===');
  console.log(`E-mail: ${admin.email}`);
  if (admin.senha) console.log(`Senha:  ${admin.senha}   (anote e troque no painel)`);
  console.log('==============================\n');
}

criarApp(db).listen(PORTA, () => {
  console.log(`Lava Jato rodando em http://localhost:${PORTA}`);
  console.log(`  Área do cliente: http://localhost:${PORTA}/`);
  console.log(`  Painel do dono:  http://localhost:${PORTA}/admin`);
});
