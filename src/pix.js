'use strict';

// Gera o "Pix Copia e Cola" (BR Code estático) conforme o Manual de Padrões
// para Iniciação do Pix do Banco Central (formato EMV-MPM).

function campo(id, valor) {
  const v = String(valor);
  return id + String(v.length).padStart(2, '0') + v;
}

function normalizar(texto, max) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 ]/g, '')
    .trim()
    .toUpperCase()
    .slice(0, max);
}

function crc16(payload) {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * @param {object} p
 * @param {string} p.chave   chave Pix do recebedor (CPF/CNPJ, e-mail, telefone ou aleatória)
 * @param {string} p.nome    nome do recebedor (até 25 caracteres)
 * @param {string} p.cidade  cidade do recebedor (até 15 caracteres)
 * @param {number} [p.valorCentavos]
 * @param {string} [p.txid]  identificador (até 25 caracteres alfanuméricos)
 */
function gerarPixCopiaECola({ chave, nome, cidade, valorCentavos, txid }) {
  if (!chave) throw new Error('Chave Pix não configurada');
  const conta = campo('00', 'br.gov.bcb.pix') + campo('01', chave.trim());
  const id = String(txid || '***').replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***';

  let payload =
    campo('00', '01') +
    campo('26', conta) +
    campo('52', '0000') +
    campo('53', '986') +
    (valorCentavos > 0 ? campo('54', (valorCentavos / 100).toFixed(2)) : '') +
    campo('58', 'BR') +
    campo('59', normalizar(nome, 25) || 'LAVA JATO') +
    campo('60', normalizar(cidade, 15) || 'BRASIL') +
    campo('62', campo('05', id)) +
    '6304';
  payload += crc16(payload);
  return payload;
}

module.exports = { gerarPixCopiaECola, crc16 };
