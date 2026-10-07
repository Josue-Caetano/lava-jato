<?php
defined('LAVAJATO') or exit;

const METODOS = ['pix', 'cartao_credito', 'cartao_debito', 'dinheiro'];
const STATUS_AGENDAMENTO = ['agendado', 'em_andamento', 'concluido', 'cancelado'];

function para_minutos(string $hora): int
{
    [$h, $m] = array_map('intval', explode(':', $hora));
    return $h * 60 + $m;
}

function para_hora(int $minutos): string
{
    return sprintf('%02d:%02d', intdiv($minutos, 60), $minutos % 60);
}

function validar_data($data): string
{
    $data = (string) $data;
    $d = DateTime::createFromFormat('!Y-m-d', $data);
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $data) || !$d || $d->format('Y-m-d') !== $data) {
        throw new ErroNegocio('Data inválida (use AAAA-MM-DD)');
    }
    return $data;
}

function validar_hora($hora): string
{
    $hora = (string) $hora;
    if (!preg_match('/^([01]\d|2[0-3]):[0-5]\d$/', $hora)) {
        throw new ErroNegocio('Horário inválido (use HH:MM)');
    }
    return $hora;
}

/** Converte "12,50" / "1.234,50" / "12.50" / 12.5 em centavos. */
function reais_para_centavos($valor): int
{
    if (is_int($valor) || is_float($valor)) {
        if ($valor < 0) {
            throw new ErroNegocio("Valor inválido: $valor");
        }
        return (int) round($valor * 100);
    }
    $limpo = preg_replace('/\s|R\$/u', '', trim((string) $valor));
    $normalizado = str_contains($limpo, ',') ? str_replace(',', '.', str_replace('.', '', $limpo)) : $limpo;
    if ($limpo === '' || !is_numeric($normalizado) || (float) $normalizado < 0) {
        throw new ErroNegocio("Valor inválido: $valor");
    }
    return (int) round((float) $normalizado * 100);
}

function numero_decimal($valor): float
{
    return (float) str_replace(',', '.', trim((string) $valor));
}

function calcular_desconto(int $valorCentavos, string $tipo, float $valor): int
{
    if ($valor <= 0) {
        return 0;
    }
    $desconto = $tipo === 'percentual'
        ? (int) round($valorCentavos * min($valor, 100) / 100)
        : (int) $valor;
    return min($desconto, $valorCentavos);
}

function buscar_cupom(?string $codigo): ?array
{
    $codigo = trim((string) $codigo);
    if ($codigo === '') {
        return null;
    }
    $cupom = linha('SELECT * FROM cupons WHERE codigo = ? AND ativo = 1', [$codigo]);
    if (!$cupom || ($cupom['validade'] && $cupom['validade'] < hoje())) {
        throw new ErroNegocio('Cupom inválido ou expirado');
    }
    return $cupom;
}

/**
 * Horários livres de um dia para um serviço. Um horário fica livre se a quantidade
 * de agendamentos que se sobrepõem a ele for menor que o nº de vagas simultâneas.
 */
function horarios_disponiveis($data, int $servicoId): array
{
    $data = validar_data($data);
    $cfg = ler_config();
    $servico = linha('SELECT * FROM servicos WHERE id = ? AND ativo = 1', [$servicoId]);
    if (!$servico) {
        throw new ErroNegocio('Serviço não encontrado', 404);
    }

    $hoje = hoje();
    if ($data < $hoje || $data > hoje((int) ($cfg['antecedencia_max_dias'] ?: 30))) {
        return [];
    }
    $diaSemana = (int) date('w', strtotime($data));
    if (!in_array($diaSemana, array_map('intval', explode(',', $cfg['dias_funcionamento'])), true)) {
        return [];
    }
    if (linha('SELECT 1 FROM bloqueios WHERE data = ?', [$data])) {
        return [];
    }

    $abertura = para_minutos($cfg['horario_abertura']);
    $fechamento = para_minutos($cfg['horario_fechamento']);
    $passo = max(5, (int) $cfg['intervalo_min'] ?: 30);
    $vagas = max(1, (int) $cfg['vagas_simultaneas']);
    $minutoAtual = $data === $hoje ? (int) date('G') * 60 + (int) date('i') : -1;

    $ocupados = array_map(
        fn ($a) => [para_minutos($a['hora']), para_minutos($a['hora']) + (int) $a['duracao_min']],
        linhas("SELECT hora, duracao_min FROM agendamentos WHERE data = ? AND status <> 'cancelado'", [$data])
    );

    $livres = [];
    $duracao = (int) $servico['duracao_min'];
    for ($ini = $abertura; $ini + $duracao <= $fechamento; $ini += $passo) {
        if ($ini <= $minutoAtual) {
            continue;
        }
        $fim = $ini + $duracao;
        $sobrepostos = count(array_filter($ocupados, fn ($o) => $o[0] < $fim && $ini < $o[1]));
        if ($sobrepostos < $vagas) {
            $livres[] = para_hora($ini);
        }
    }
    return $livres;
}

function criar_agendamento(array $dados, ?int $clienteId = null, bool $origemAdmin = false): array
{
    $nome = trim((string) ($dados['nome_cliente'] ?? ''));
    $placa = strtoupper(trim((string) ($dados['placa'] ?? '')));
    if ($nome === '') {
        throw new ErroNegocio('Informe o nome do cliente');
    }
    if ($placa === '' || strlen($placa) > 10) {
        throw new ErroNegocio('Informe a placa do veículo');
    }
    $data = validar_data($dados['data'] ?? '');
    $hora = validar_hora($dados['hora'] ?? '');

    if (!$origemAdmin && ler_config()['agendamento_online'] !== '1') {
        throw new ErroNegocio('O agendamento online está desativado no momento');
    }

    // Trava para dois clientes não pegarem a última vaga ao mesmo tempo.
    consulta("SELECT GET_LOCK('lavajato_agenda', 10)");
    try {
        return transacao(function () use ($dados, $clienteId, $origemAdmin, $nome, $placa, $data, $hora) {
            $servico = linha('SELECT * FROM servicos WHERE id = ? AND ativo = 1', [(int) ($dados['servico_id'] ?? 0)]);
            if (!$servico) {
                throw new ErroNegocio('Serviço não encontrado', 404);
            }
            // O dono pode encaixar fora da grade; o cliente só nos horários livres.
            if (!$origemAdmin && !in_array($hora, horarios_disponiveis($data, (int) $servico['id']), true)) {
                throw new ErroNegocio('Horário indisponível, escolha outro', 409);
            }

            $preco = (int) $servico['preco_centavos'];
            $cupom = buscar_cupom($dados['cupom'] ?? null);
            $desconto = $cupom ? calcular_desconto($preco, $cupom['tipo'], (float) $cupom['valor']) : 0;
            if ($origemAdmin && trim((string) ($dados['desconto'] ?? '')) !== '') {
                $desconto = min($preco, $desconto + reais_para_centavos($dados['desconto']));
            }

            $texto = fn ($chave, $max) => mb_substr(trim((string) ($dados[$chave] ?? '')), 0, $max) ?: null;
            consulta(
                'INSERT INTO agendamentos
                  (cliente_id, nome_cliente, telefone, placa, modelo, servico_id, data, hora,
                   duracao_min, valor_centavos, desconto_centavos, cupom_codigo, observacoes, criado_em)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [
                    $clienteId, mb_substr($nome, 0, 120), $texto('telefone', 40), $placa, $texto('modelo', 80),
                    $servico['id'], $data, $hora, $servico['duracao_min'], $preco, $desconto,
                    $cupom['codigo'] ?? null, $texto('observacoes', 255), agora(),
                ]
            );
            return buscar_agendamento(ultimo_id());
        });
    } finally {
        consulta("SELECT RELEASE_LOCK('lavajato_agenda')");
    }
}

const SQL_AGENDAMENTO = "
  SELECT a.*, s.nome AS servico_nome,
    CAST(a.valor_centavos - a.desconto_centavos AS SIGNED) AS total_centavos,
    CAST(COALESCE((SELECT SUM(p.valor_liquido_centavos) FROM pagamentos p
                   WHERE p.agendamento_id = a.id AND p.status = 'pago'), 0) AS SIGNED) AS pago_centavos,
    (SELECT p.id FROM pagamentos p WHERE p.agendamento_id = a.id AND p.status = 'pendente'
     ORDER BY p.id DESC LIMIT 1) AS pagamento_pendente_id
  FROM agendamentos a JOIN servicos s ON s.id = a.servico_id";

function buscar_agendamento(int $id): ?array
{
    return linha(SQL_AGENDAMENTO . ' WHERE a.id = ?', [$id]);
}

function listar_agendamentos(array $filtros = []): array
{
    $where = [];
    $params = [];
    $mapa = ['data' => 'a.data = ?', 'inicio' => 'a.data >= ?', 'fim' => 'a.data <= ?',
             'status' => 'a.status = ?', 'cliente_id' => 'a.cliente_id = ?'];
    foreach ($mapa as $chave => $cond) {
        if (isset($filtros[$chave]) && $filtros[$chave] !== '') {
            $where[] = $cond;
            $params[] = $filtros[$chave];
        }
    }
    $sql = SQL_AGENDAMENTO . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . ' ORDER BY a.data, a.hora, a.id';
    return linhas($sql, $params);
}

function buscar_pagamento(int $id): ?array
{
    return linha('SELECT * FROM pagamentos WHERE id = ?', [$id]);
}

/**
 * Valor ainda em aberto de um agendamento. No primeiro pagamento o desconto do
 * agendamento (cupom/balcão) entra no recebimento, para aparecer nos relatórios.
 */
function valores_em_aberto(array $ag): array
{
    if ((int) $ag['pago_centavos'] === 0) {
        return ['bruto' => (int) $ag['valor_centavos'], 'desconto' => (int) $ag['desconto_centavos']];
    }
    return ['bruto' => max(0, $ag['total_centavos'] - $ag['pago_centavos']), 'desconto' => 0];
}

function cancelar_pendentes(int $agendamentoId): void
{
    consulta("UPDATE pagamentos SET status = 'cancelado' WHERE agendamento_id = ? AND status = 'pendente'", [$agendamentoId]);
}

/**
 * Cliente gera a cobrança de um agendamento. Pix gera um código Copia e Cola com o
 * valor; cartão/dinheiro ficam pendentes para pagamento no balcão.
 */
function solicitar_pagamento_cliente(int $agendamentoId, int $clienteId, $metodo): array
{
    if (!in_array($metodo, METODOS, true)) {
        throw new ErroNegocio('Forma de pagamento inválida');
    }
    $ag = buscar_agendamento($agendamentoId);
    if (!$ag || (int) $ag['cliente_id'] !== $clienteId) {
        throw new ErroNegocio('Agendamento não encontrado', 404);
    }
    if ($ag['status'] === 'cancelado') {
        throw new ErroNegocio('Agendamento cancelado');
    }
    $aberto = valores_em_aberto($ag);
    $restante = $aberto['bruto'] - $aberto['desconto'];
    if ($restante <= 0) {
        throw new ErroNegocio('Este agendamento já está pago');
    }
    $cfg = ler_config();
    if ($metodo === 'pix' && $cfg['pix_chave'] === '') {
        throw new ErroNegocio('O lava jato ainda não configurou a chave Pix. Pague no local.');
    }

    return transacao(function () use ($ag, $aberto, $restante, $metodo, $cfg) {
        cancelar_pendentes((int) $ag['id']);
        $txid = null;
        $copiaCola = null;
        if ($metodo === 'pix') {
            $txid = strtoupper('LJ' . $ag['id'] . bin2hex(random_bytes(4)));
            $copiaCola = pix_copia_e_cola($cfg['pix_chave'], $cfg['pix_nome'] ?: $cfg['nome_empresa'], $cfg['pix_cidade'], $restante, $txid);
        }
        consulta(
            "INSERT INTO pagamentos
              (agendamento_id, descricao, valor_bruto_centavos, desconto_centavos, valor_liquido_centavos,
               metodo, status, origem, pix_txid, pix_copia_cola, criado_em)
             VALUES (?, ?, ?, ?, ?, ?, 'pendente', 'cliente', ?, ?, ?)",
            [$ag['id'], mb_substr("{$ag['servico_nome']} - {$ag['placa']}", 0, 160), $aberto['bruto'],
             $aberto['desconto'], $restante, $metodo, $txid, $copiaCola, agora()]
        );
        return buscar_pagamento(ultimo_id());
    });
}

/** Dono lança um recebimento (avulso ou vinculado a um agendamento). */
function lancar_recebimento(array $dados): array
{
    $metodo = $dados['metodo'] ?? '';
    if (!in_array($metodo, METODOS, true)) {
        throw new ErroNegocio('Forma de pagamento inválida');
    }

    return transacao(function () use ($dados, $metodo) {
        $ag = null;
        $descricao = trim((string) ($dados['descricao'] ?? ''));
        $valorInformado = trim((string) ($dados['valor'] ?? ''));
        $descontoBase = 0;
        if (!empty($dados['agendamento_id'])) {
            $ag = buscar_agendamento((int) $dados['agendamento_id']);
            if (!$ag) {
                throw new ErroNegocio('Agendamento não encontrado', 404);
            }
            if ($ag['status'] === 'cancelado') {
                throw new ErroNegocio('Agendamento cancelado');
            }
            if ($valorInformado !== '') {
                $bruto = reais_para_centavos($valorInformado);
            } else {
                ['bruto' => $bruto, 'desconto' => $descontoBase] = valores_em_aberto($ag);
            }
            $descricao = $descricao ?: "{$ag['servico_nome']} - {$ag['placa']}";
        } else {
            $bruto = reais_para_centavos($valorInformado);
        }
        if ($descricao === '') {
            throw new ErroNegocio('Informe uma descrição');
        }
        if ($bruto <= 0) {
            throw new ErroNegocio('Valor deve ser maior que zero');
        }

        // Desconto dado no balcão, aplicado sobre o valor já com o desconto do agendamento.
        $base = $bruto - $descontoBase;
        $extra = 0;
        $descontoInformado = trim((string) ($dados['desconto'] ?? ''));
        if ($descontoInformado !== '' && numero_decimal($descontoInformado) != 0) {
            $extra = ($dados['desconto_tipo'] ?? '') === 'percentual'
                ? calcular_desconto($base, 'percentual', numero_decimal($descontoInformado))
                : min($base, reais_para_centavos($descontoInformado));
        }
        $desconto = $descontoBase + $extra;

        $status = ($dados['status'] ?? '') === 'pendente' ? 'pendente' : 'pago';
        if ($ag) {
            // Um recebimento manual substitui cobranças pendentes geradas pelo cliente.
            cancelar_pendentes((int) $ag['id']);
        }
        consulta(
            "INSERT INTO pagamentos
              (agendamento_id, descricao, valor_bruto_centavos, desconto_centavos, valor_liquido_centavos,
               metodo, status, origem, criado_em, pago_em)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'admin', ?, ?)",
            [$ag['id'] ?? null, mb_substr($descricao, 0, 160), $bruto, $desconto, $bruto - $desconto,
             $metodo, $status, agora(), $status === 'pago' ? agora() : null]
        );
        return buscar_pagamento(ultimo_id());
    });
}

function alterar_status_pagamento(int $id, $status): array
{
    if (!in_array($status, ['pago', 'cancelado'], true)) {
        throw new ErroNegocio('Status inválido');
    }
    $p = buscar_pagamento($id);
    if (!$p) {
        throw new ErroNegocio('Pagamento não encontrado', 404);
    }
    if ($p['status'] !== 'pendente') {
        throw new ErroNegocio("Pagamento já está {$p['status']}");
    }
    consulta('UPDATE pagamentos SET status = ?, pago_em = ? WHERE id = ?', [$status, $status === 'pago' ? agora() : null, $id]);
    return buscar_pagamento($id);
}

function resumo_financeiro($inicio, $fim): array
{
    $inicio = validar_data($inicio);
    $fim = validar_data($fim);
    $filtro = "status = 'pago' AND pago_em >= ? AND pago_em < DATE_ADD(?, INTERVAL 1 DAY)";
    $p = [$inicio, $fim];
    $total = linha(
        "SELECT COUNT(*) AS quantidade,
                CAST(COALESCE(SUM(valor_bruto_centavos), 0) AS SIGNED) AS bruto_centavos,
                CAST(COALESCE(SUM(desconto_centavos), 0) AS SIGNED) AS descontos_centavos,
                CAST(COALESCE(SUM(valor_liquido_centavos), 0) AS SIGNED) AS liquido_centavos
         FROM pagamentos WHERE $filtro",
        $p
    );
    $porMetodo = linhas(
        "SELECT metodo, COUNT(*) AS quantidade, CAST(SUM(valor_liquido_centavos) AS SIGNED) AS liquido_centavos
         FROM pagamentos WHERE $filtro GROUP BY metodo ORDER BY liquido_centavos DESC",
        $p
    );
    $porDia = linhas(
        "SELECT DATE_FORMAT(pago_em, '%Y-%m-%d') AS dia, CAST(SUM(valor_liquido_centavos) AS SIGNED) AS liquido_centavos
         FROM pagamentos WHERE $filtro GROUP BY dia ORDER BY dia",
        $p
    );
    $pendentes = linha(
        "SELECT COUNT(*) AS quantidade, CAST(COALESCE(SUM(valor_liquido_centavos), 0) AS SIGNED) AS liquido_centavos
         FROM pagamentos WHERE status = 'pendente'"
    );
    return ['inicio' => $inicio, 'fim' => $fim] + $total
        + ['por_metodo' => $porMetodo, 'por_dia' => $porDia, 'pendentes' => $pendentes];
}
