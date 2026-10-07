'use strict';

const crypto = require('node:crypto');

const VALIDADE_MS = 7 * 24 * 60 * 60 * 1000;

function assinar(segredo, dados) {
  return crypto.createHmac('sha256', segredo).update(dados).digest('base64url');
}

function criarToken(segredo, usuario) {
  const corpo = Buffer.from(
    JSON.stringify({ id: usuario.id, papel: usuario.papel, exp: Date.now() + VALIDADE_MS })
  ).toString('base64url');
  return `${corpo}.${assinar(segredo, corpo)}`;
}

function lerToken(segredo, token) {
  const [corpo, assinatura] = String(token || '').split('.');
  if (!corpo || !assinatura) return null;
  const esperado = Buffer.from(assinar(segredo, corpo));
  const recebido = Buffer.from(assinatura);
  if (esperado.length !== recebido.length || !crypto.timingSafeEqual(esperado, recebido)) {
    return null;
  }
  try {
    const dados = JSON.parse(Buffer.from(corpo, 'base64url').toString());
    return dados.exp > Date.now() ? dados : null;
  } catch {
    return null;
  }
}

function middlewareAuth(db, segredo) {
  const buscar = db.prepare('SELECT id, nome, email, telefone, papel FROM usuarios WHERE id = ?');
  return (req, _res, next) => {
    const cabecalho = req.get('authorization') || '';
    const dados = lerToken(segredo, cabecalho.replace(/^Bearer\s+/i, ''));
    req.usuario = dados ? buscar.get(dados.id) || null : null;
    next();
  };
}

function exigir(papel) {
  return (req, res, next) => {
    if (!req.usuario) return res.status(401).json({ erro: 'Faça login para continuar' });
    if (papel && req.usuario.papel !== papel) {
      return res.status(403).json({ erro: 'Acesso não permitido' });
    }
    next();
  };
}

module.exports = { criarToken, lerToken, middlewareAuth, exigir };
