<?php
defined('LAVAJATO') or exit;

// ------------------------------------------------------------------ sessão
// O dono e o cliente ficam em "áreas" separadas da sessão, assim o mesmo
// navegador pode estar logado no painel e na área do cliente.

function area(): string
{
    return ($_SERVER['HTTP_X_AREA'] ?? '') === 'admin' ? 'admin' : 'cliente';
}

function usuario_logado(string $papel): ?array
{
    $id = $_SESSION['usuarios'][$papel] ?? null;
    if (!$id) {
        return null;
    }
    $u = linha('SELECT id, nome, email, telefone, papel FROM usuarios WHERE id = ? AND papel = ?', [$id, $papel]);
    if (!$u) {
        unset($_SESSION['usuarios'][$papel]);
    }
    return $u;
}

function exigir(string $papel): array
{
    $u = usuario_logado($papel);
    if (!$u) {
        throw new ErroNegocio('Faça login para continuar', 401);
    }
    return $u;
}

function entrar(array $u): array
{
    session_regenerate_id(true);
    $_SESSION['usuarios'][$u['papel']] = (int) $u['id'];
    return ['usuario' => [
        'id' => (int) $u['id'], 'nome' => $u['nome'], 'email' => $u['email'],
        'telefone' => $u['telefone'], 'papel' => $u['papel'],
    ]];
}

function limitar_tentativas(): void
{
    $ip = $_SERVER['REMOTE_ADDR'] ?? '?';
    consulta('DELETE FROM tentativas_login WHERE em < ?', [date('Y-m-d H:i:s', time() - 900)]);
    $n = (int) consulta('SELECT COUNT(*) FROM tentativas_login WHERE ip = ?', [$ip])->fetchColumn();
    if ($n >= 20) {
        throw new ErroNegocio('Muitas tentativas. Aguarde alguns minutos.', 429);
    }
    consulta('INSERT INTO tentativas_login (ip, em) VALUES (?, ?)', [$ip, agora()]);
}

function validar_email($email): string
{
    $email = strtolower(trim((string) $email));
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        throw new ErroNegocio('E-mail inválido');
    }
    return $email;
}

function validar_senha($senha, string $rotulo = 'A senha'): string
{
    $senha = (string) $senha;
    if (strlen($senha) < 6) {
        throw new ErroNegocio("$rotulo deve ter pelo menos 6 caracteres");
    }
    return $senha;
}

function existe_admin(): bool
{
    return (bool) linha("SELECT 1 FROM usuarios WHERE papel = 'admin' LIMIT 1");
}

function criar_usuario(array $b, string $papel): array
{
    $nome = trim((string) ($b['nome'] ?? ''));
    if ($nome === '') {
        throw new ErroNegocio('Informe seu nome');
    }
    $email = validar_email($b['email'] ?? '');
    $senha = validar_senha($b['senha'] ?? '');
    if (linha('SELECT 1 FROM usuarios WHERE email = ?', [$email])) {
        throw new ErroNegocio('Este e-mail já está cadastrado', 409);
    }
    consulta(
        'INSERT INTO usuarios (nome, email, telefone, senha_hash, papel, criado_em) VALUES (?, ?, ?, ?, ?, ?)',
        [mb_substr($nome, 0, 120), $email, mb_substr(trim((string) ($b['telefone'] ?? '')), 0, 40) ?: null,
         password_hash($senha, PASSWORD_DEFAULT), $papel, agora()]
    );
    return linha('SELECT * FROM usuarios WHERE id = ?', [ultimo_id()]);
}

function servico_do_corpo(array $b): array
{
    $nome = trim((string) ($b['nome'] ?? ''));
    $duracao = filter_var($b['duracao_min'] ?? null, FILTER_VALIDATE_INT);
    if ($nome === '') {
        throw new ErroNegocio('Informe o nome do serviço');
    }
    if (!$duracao || $duracao <= 0) {
        throw new ErroNegocio('Duração inválida');
    }
    return [mb_substr($nome, 0, 120), mb_substr(trim((string) ($b['descricao'] ?? '')), 0, 255) ?: null,
            reais_para_centavos($b['preco'] ?? ''), $duracao];
}

function config_sem_segredos(): array
{
    $cfg = ler_config();
    unset($cfg['versao_schema']);
    return $cfg;
}

// ------------------------------------------------------------------- rotas
// Cada rota: [método, padrão, função(array $params, array $corpo)].

function rotas(): array
{
    return [
        // ------------------------------------------------------- público
        ['GET', 'publico/info', function () {
            $c = ler_config();
            return [
                'nome_empresa' => $c['nome_empresa'],
                'telefone_empresa' => $c['telefone_empresa'],
                'endereco_empresa' => $c['endereco_empresa'],
                'agendamento_online' => $c['agendamento_online'] === '1',
                'pix_disponivel' => $c['pix_chave'] !== '',
                'horario_abertura' => $c['horario_abertura'],
                'horario_fechamento' => $c['horario_fechamento'],
                'dias_funcionamento' => array_map('intval', explode(',', $c['dias_funcionamento'])),
                'antecedencia_max_dias' => (int) $c['antecedencia_max_dias'],
                'precisa_configurar' => !existe_admin(),
            ];
        }],
        ['GET', 'publico/servicos', fn () => linhas('SELECT * FROM servicos WHERE ativo = 1 ORDER BY preco_centavos')],
        ['GET', 'publico/horarios', fn () => horarios_disponiveis($_GET['data'] ?? '', (int) ($_GET['servico_id'] ?? 0))],
        ['GET', 'publico/cupom/([^/]+)', function ($p) {
            $c = buscar_cupom(urldecode($p[0]));
            return ['codigo' => $c['codigo'], 'tipo' => $c['tipo'], 'valor' => (int) $c['valor']];
        }],

        // -------------------------------------------------- autenticação
        ['POST', 'auth/primeiro-acesso', function ($p, $b) {
            // Cria a conta do dono, só enquanto ainda não existe nenhuma.
            return transacao(function () use ($b) {
                if (linha("SELECT id FROM usuarios WHERE papel = 'admin' LIMIT 1 FOR UPDATE")) {
                    throw new ErroNegocio('O dono já foi cadastrado. Faça login.', 409);
                }
                return entrar(criar_usuario($b, 'admin'));
            });
        }],
        ['POST', 'auth/cadastro', function ($p, $b) {
            limitar_tentativas();
            return entrar(criar_usuario($b, 'cliente'));
        }],
        ['POST', 'auth/login', function ($p, $b) {
            limitar_tentativas();
            $u = linha('SELECT * FROM usuarios WHERE email = ?', [strtolower(trim((string) ($b['email'] ?? '')))]);
            if (!$u || !password_verify((string) ($b['senha'] ?? ''), $u['senha_hash'])) {
                throw new ErroNegocio('E-mail ou senha incorretos', 401);
            }
            if ($u['papel'] !== area()) {
                throw new ErroNegocio($u['papel'] === 'admin'
                    ? 'Esta é a conta do dono. Entre pelo painel (admin).'
                    : 'Esta conta não tem acesso ao painel', 403);
            }
            return entrar($u);
        }],
        ['POST', 'auth/sair', function () {
            unset($_SESSION['usuarios'][area()]);
            return ['ok' => true];
        }],
        ['GET', 'auth/eu', fn () => exigir(area())],
        ['POST', 'auth/senha', function ($p, $b) {
            $u = exigir(area());
            $hash = linha('SELECT senha_hash FROM usuarios WHERE id = ?', [$u['id']])['senha_hash'];
            if (!password_verify((string) ($b['atual'] ?? ''), $hash)) {
                throw new ErroNegocio('Senha atual incorreta');
            }
            $nova = validar_senha($b['nova'] ?? '', 'A nova senha');
            consulta('UPDATE usuarios SET senha_hash = ? WHERE id = ?', [password_hash($nova, PASSWORD_DEFAULT), $u['id']]);
            return ['ok' => true];
        }],

        // -------------------------------------------------------- cliente
        ['GET', 'cliente/agendamentos', function () {
            $u = exigir('cliente');
            return array_reverse(listar_agendamentos(['cliente_id' => $u['id']]));
        }],
        ['POST', 'cliente/agendamentos', function ($p, $b) {
            $u = exigir('cliente');
            $b['nome_cliente'] = trim((string) ($b['nome_cliente'] ?? '')) ?: $u['nome'];
            $b['telefone'] = trim((string) ($b['telefone'] ?? '')) ?: $u['telefone'];
            unset($b['desconto']);
            http_response_code(201);
            return criar_agendamento($b, (int) $u['id']);
        }],
        ['POST', 'cliente/agendamentos/(\d+)/cancelar', function ($p) {
            $u = exigir('cliente');
            $ag = buscar_agendamento((int) $p[0]);
            if (!$ag || (int) $ag['cliente_id'] !== (int) $u['id']) {
                throw new ErroNegocio('Agendamento não encontrado', 404);
            }
            if ($ag['status'] !== 'agendado') {
                throw new ErroNegocio('Este agendamento não pode mais ser cancelado');
            }
            if ($ag['pago_centavos'] > 0) {
                throw new ErroNegocio('Agendamento já pago. Fale com o lava jato para cancelar.');
            }
            consulta("UPDATE agendamentos SET status = 'cancelado' WHERE id = ?", [$ag['id']]);
            cancelar_pendentes((int) $ag['id']);
            return buscar_agendamento((int) $ag['id']);
        }],
        ['POST', 'cliente/agendamentos/(\d+)/pagamento', function ($p, $b) {
            $u = exigir('cliente');
            http_response_code(201);
            return solicitar_pagamento_cliente((int) $p[0], (int) $u['id'], $b['metodo'] ?? '');
        }],
        ['GET', 'cliente/pagamentos/(\d+)', function ($p) {
            $u = exigir('cliente');
            $pg = buscar_pagamento((int) $p[0]);
            $ag = $pg && $pg['agendamento_id'] ? buscar_agendamento((int) $pg['agendamento_id']) : null;
            if (!$ag || (int) $ag['cliente_id'] !== (int) $u['id']) {
                throw new ErroNegocio('Pagamento não encontrado', 404);
            }
            return $pg;
        }],

        // ---------------------------------------------------------- admin
        ['GET', 'admin/resumo', function () {
            exigir('admin');
            return resumo_financeiro($_GET['inicio'] ?? hoje(), $_GET['fim'] ?? hoje());
        }],
        ['GET', 'admin/agendamentos', function () {
            exigir('admin');
            return listar_agendamentos(array_intersect_key($_GET, array_flip(['data', 'inicio', 'fim', 'status'])));
        }],
        ['POST', 'admin/agendamentos', function ($p, $b) {
            exigir('admin');
            http_response_code(201);
            return criar_agendamento($b, null, true);
        }],
        ['PATCH', 'admin/agendamentos/(\d+)', function ($p, $b) {
            exigir('admin');
            $ag = buscar_agendamento((int) $p[0]);
            if (!$ag) {
                throw new ErroNegocio('Agendamento não encontrado', 404);
            }
            $status = $b['status'] ?? '';
            if (!in_array($status, STATUS_AGENDAMENTO, true)) {
                throw new ErroNegocio('Status inválido');
            }
            consulta('UPDATE agendamentos SET status = ? WHERE id = ?', [$status, $ag['id']]);
            if ($status === 'cancelado') {
                cancelar_pendentes((int) $ag['id']);
            }
            return buscar_agendamento((int) $ag['id']);
        }],

        ['GET', 'admin/pagamentos', function () {
            exigir('admin');
            $where = [];
            $params = [];
            if (!empty($_GET['status'])) {
                $where[] = 'p.status = ?';
                $params[] = $_GET['status'];
            }
            if (!empty($_GET['inicio'])) {
                $where[] = 'p.criado_em >= ?';
                $params[] = validar_data($_GET['inicio']);
            }
            if (!empty($_GET['fim'])) {
                $where[] = 'p.criado_em < DATE_ADD(?, INTERVAL 1 DAY)';
                $params[] = validar_data($_GET['fim']);
            }
            return linhas(
                'SELECT p.*, a.nome_cliente, a.placa, a.data AS agendamento_data, a.hora AS agendamento_hora
                 FROM pagamentos p LEFT JOIN agendamentos a ON a.id = p.agendamento_id '
                . ($where ? 'WHERE ' . implode(' AND ', $where) : '') . ' ORDER BY p.id DESC LIMIT 500',
                $params
            );
        }],
        ['POST', 'admin/pagamentos', function ($p, $b) {
            exigir('admin');
            http_response_code(201);
            return lancar_recebimento($b);
        }],
        ['PATCH', 'admin/pagamentos/(\d+)', function ($p, $b) {
            exigir('admin');
            return alterar_status_pagamento((int) $p[0], $b['status'] ?? '');
        }],

        // Serviços
        ['GET', 'admin/servicos', function () {
            exigir('admin');
            return linhas('SELECT * FROM servicos ORDER BY ativo DESC, nome');
        }],
        ['POST', 'admin/servicos', function ($p, $b) {
            exigir('admin');
            consulta('INSERT INTO servicos (nome, descricao, preco_centavos, duracao_min) VALUES (?, ?, ?, ?)', servico_do_corpo($b));
            http_response_code(201);
            return linha('SELECT * FROM servicos WHERE id = ?', [ultimo_id()]);
        }],
        ['PUT', 'admin/servicos/(\d+)', function ($p, $b) {
            exigir('admin');
            $id = (int) $p[0];
            if (!linha('SELECT 1 FROM servicos WHERE id = ?', [$id])) {
                throw new ErroNegocio('Serviço não encontrado', 404);
            }
            $ativo = ($b['ativo'] ?? true) === false ? 0 : 1;
            consulta(
                'UPDATE servicos SET nome = ?, descricao = ?, preco_centavos = ?, duracao_min = ?, ativo = ? WHERE id = ?',
                [...servico_do_corpo($b), $ativo, $id]
            );
            return linha('SELECT * FROM servicos WHERE id = ?', [$id]);
        }],

        // Cupons de desconto
        ['GET', 'admin/cupons', function () {
            exigir('admin');
            return linhas('SELECT * FROM cupons ORDER BY ativo DESC, codigo');
        }],
        ['POST', 'admin/cupons', function ($p, $b) {
            exigir('admin');
            $codigo = strtoupper(trim((string) ($b['codigo'] ?? '')));
            $tipo = ($b['tipo'] ?? '') === 'fixo' ? 'fixo' : 'percentual';
            $valor = $tipo === 'fixo' ? reais_para_centavos($b['valor'] ?? '') : (int) round(numero_decimal($b['valor'] ?? 0));
            if (!preg_match('/^[A-Z0-9_-]{3,30}$/', $codigo)) {
                throw new ErroNegocio('Código deve ter de 3 a 30 letras/números');
            }
            if ($valor <= 0 || ($tipo === 'percentual' && $valor > 100)) {
                throw new ErroNegocio('Valor do desconto inválido');
            }
            if (linha('SELECT 1 FROM cupons WHERE codigo = ?', [$codigo])) {
                throw new ErroNegocio('Já existe um cupom com esse código', 409);
            }
            $validade = !empty($b['validade']) ? validar_data($b['validade']) : null;
            consulta('INSERT INTO cupons (codigo, tipo, valor, validade) VALUES (?, ?, ?, ?)', [$codigo, $tipo, $valor, $validade]);
            http_response_code(201);
            return linha('SELECT * FROM cupons WHERE id = ?', [ultimo_id()]);
        }],
        ['PATCH', 'admin/cupons/(\d+)', function ($p, $b) {
            exigir('admin');
            consulta('UPDATE cupons SET ativo = ? WHERE id = ?', [!empty($b['ativo']) ? 1 : 0, (int) $p[0]]);
            return linha('SELECT * FROM cupons WHERE id = ?', [(int) $p[0]]);
        }],

        // Dias bloqueados (feriados, manutenção...)
        ['GET', 'admin/bloqueios', function () {
            exigir('admin');
            return linhas('SELECT * FROM bloqueios WHERE data >= ? ORDER BY data', [hoje()]);
        }],
        ['POST', 'admin/bloqueios', function ($p, $b) {
            exigir('admin');
            consulta('REPLACE INTO bloqueios (data, motivo) VALUES (?, ?)', [
                validar_data($b['data'] ?? ''), mb_substr(trim((string) ($b['motivo'] ?? '')), 0, 120) ?: null,
            ]);
            http_response_code(201);
            return ['ok' => true];
        }],
        ['DELETE', 'admin/bloqueios/(\d{4}-\d{2}-\d{2})', function ($p) {
            exigir('admin');
            consulta('DELETE FROM bloqueios WHERE data = ?', [$p[0]]);
            return ['ok' => true];
        }],

        // Configurações
        ['GET', 'admin/config', function () {
            exigir('admin');
            return config_sem_segredos();
        }],
        ['PUT', 'admin/config', function ($p, $b) {
            exigir('admin');
            $novo = [];
            foreach (array_keys(CONFIG_PADRAO) as $chave) {
                if (array_key_exists($chave, $b)) {
                    $novo[$chave] = trim((string) $b[$chave]);
                }
            }
            foreach (['horario_abertura', 'horario_fechamento'] as $chave) {
                if (isset($novo[$chave])) {
                    validar_hora($novo[$chave]);
                }
            }
            foreach (['intervalo_min', 'vagas_simultaneas', 'antecedencia_max_dias'] as $chave) {
                if (isset($novo[$chave]) && !(ctype_digit($novo[$chave]) && (int) $novo[$chave] > 0)) {
                    throw new ErroNegocio("Valor inválido para $chave");
                }
            }
            if (isset($novo['dias_funcionamento']) && !preg_match('/^[0-6](,[0-6])*$/', $novo['dias_funcionamento'])) {
                throw new ErroNegocio('Dias de funcionamento inválidos');
            }
            foreach ($novo as $chave => $valor) {
                consulta('UPDATE config SET valor = ? WHERE chave = ?', [$valor, $chave]);
            }
            return config_sem_segredos();
        }],

        ['GET', 'admin/clientes', function () {
            exigir('admin');
            return linhas(
                "SELECT u.id, u.nome, u.email, u.telefone, u.criado_em,
                   (SELECT COUNT(*) FROM agendamentos a WHERE a.cliente_id = u.id) AS agendamentos
                 FROM usuarios u WHERE u.papel = 'cliente' ORDER BY u.nome"
            );
        }],
    ];
}
