<?php
defined('LAVAJATO') or exit;

// Gera o "Pix Copia e Cola" (BR Code estático) conforme o Manual de Padrões
// para Iniciação do Pix do Banco Central (formato EMV-MPM).

function pix_campo(string $id, string $valor): string
{
    return $id . str_pad((string) strlen($valor), 2, '0', STR_PAD_LEFT) . $valor;
}

function pix_normalizar(?string $texto, int $max): string
{
    $t = (string) $texto;
    if (class_exists('Normalizer')) {
        $t = preg_replace('/\p{Mn}/u', '', Normalizer::normalize($t, Normalizer::FORM_D));
    } else {
        $t = strtr($t, [
            'á' => 'a', 'à' => 'a', 'â' => 'a', 'ã' => 'a', 'ä' => 'a', 'é' => 'e', 'ê' => 'e', 'è' => 'e',
            'í' => 'i', 'ó' => 'o', 'ô' => 'o', 'õ' => 'o', 'ö' => 'o', 'ú' => 'u', 'ü' => 'u', 'ç' => 'c',
            'Á' => 'A', 'À' => 'A', 'Â' => 'A', 'Ã' => 'A', 'É' => 'E', 'Ê' => 'E', 'Í' => 'I', 'Ó' => 'O',
            'Ô' => 'O', 'Õ' => 'O', 'Ú' => 'U', 'Ç' => 'C',
        ]);
    }
    $t = strtoupper(trim(preg_replace('/[^A-Za-z0-9 ]/', '', $t)));
    return substr($t, 0, $max);
}

function pix_crc16(string $payload): string
{
    $crc = 0xFFFF;
    $len = strlen($payload);
    for ($i = 0; $i < $len; $i++) {
        $crc ^= ord($payload[$i]) << 8;
        for ($b = 0; $b < 8; $b++) {
            $crc = ($crc & 0x8000) ? (($crc << 1) ^ 0x1021) : ($crc << 1);
            $crc &= 0xFFFF;
        }
    }
    return strtoupper(str_pad(dechex($crc), 4, '0', STR_PAD_LEFT));
}

function pix_copia_e_cola(string $chave, ?string $nome, ?string $cidade, int $valorCentavos = 0, ?string $txid = null): string
{
    if (trim($chave) === '') {
        throw new ErroNegocio('Chave Pix não configurada');
    }
    $conta = pix_campo('00', 'br.gov.bcb.pix') . pix_campo('01', trim($chave));
    $id = substr(preg_replace('/[^A-Za-z0-9]/', '', (string) $txid), 0, 25) ?: '***';

    $payload = pix_campo('00', '01')
        . pix_campo('26', $conta)
        . pix_campo('52', '0000')
        . pix_campo('53', '986')
        . ($valorCentavos > 0 ? pix_campo('54', number_format($valorCentavos / 100, 2, '.', '')) : '')
        . pix_campo('58', 'BR')
        . pix_campo('59', pix_normalizar($nome, 25) ?: 'LAVA JATO')
        . pix_campo('60', pix_normalizar($cidade, 15) ?: 'BRASIL')
        . pix_campo('62', pix_campo('05', $id))
        . '6304';
    return $payload . pix_crc16($payload);
}
