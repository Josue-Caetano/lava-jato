<?php
// Testes automatizados da API.
//
// Uso: php tests/teste_api.php
// Precisa de um MySQL/MariaDB rodando. O teste APAGA e recria o banco
// "lavajato_teste" (ou o definido em LAVAJATO_DB_NOME). Credenciais via
// LAVAJATO_DB_HOST / LAVAJATO_DB_USUARIO / LAVAJATO_DB_SENHA (padrão: root sem senha).

define('LAVAJATO', true);
require __DIR__ . '/../app/pix.php';

$env = [
    'LAVAJATO_DB_HOST' => getenv('LAVAJATO_DB_HOST') ?: '127.0.0.1',
    'LAVAJATO_DB_PORTA' => getenv('LAVAJATO_DB_PORTA') ?: '3306',
    'LAVAJATO_DB_NOME' => getenv('LAVAJATO_DB_NOME') ?: 'lavajato_teste',
    'LAVAJATO_DB_USUARIO' => getenv('LAVAJATO_DB_USUARIO') ?: 'root',
    'LAVAJATO_DB_SENHA' => getenv('LAVAJATO_DB_SENHA') ?: '',
];
date_default_timezone_set('America/Sao_Paulo');

$pdo = new PDO("mysql:host={$env['LAVAJATO_DB_HOST']};port={$env['LAVAJATO_DB_PORTA']}", $env['LAVAJATO_DB_USUARIO'], $env['LAVAJATO_DB_SENHA']);
$pdo->exec("DROP DATABASE IF EXISTS `{$env['LAVAJATO_DB_NOME']}`");

$porta = 18000 + random_int(0, 999);
$cmd = sprintf('exec php -S 127.0.0.1:%d -t %s', $porta, escapeshellarg(dirname(__DIR__)));
$servidor = proc_open($cmd, [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes, null, $env + getenv());
register_shutdown_function(fn () => proc_terminate($servidor));
for ($i = 0; $i < 50 && !@fsockopen('127.0.0.1', $porta); $i++) {
    usleep(100000);
}

$cookies = [];
function req(string $quem, string $metodo, string $rota, $corpo = null): array
{
    global $porta, $cookies;
    [$caminho, $query] = array_pad(explode('?', $rota, 2), 2, '');
    $url = "http://127.0.0.1:$porta/api.php?r=" . urlencode($caminho) . ($query ? "&$query" : '');
    $cookies[$quem] ??= tempnam(sys_get_temp_dir(), 'lj');
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => $metodo,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_COOKIEJAR => $cookies[$quem],
        CURLOPT_COOKIEFILE => $cookies[$quem],
        CURLOPT_HTTPHEADER => array_merge(['Content-Type: application/json'], $quem === 'csrf' ? [] : ['X-Area: ' . ($quem === 'admin' ? 'admin' : 'cliente')]),
        CURLOPT_POSTFIELDS => $corpo === null ? null : json_encode($corpo),
    ]);
    $resp = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    return [$status, json_decode((string) $resp, true)];
}

$falhas = 0;
$total = 0;
function teste(string $nome, callable $fn): void
{
    global $falhas, $total;
    $total++;
    try {
        $fn();
        echo "ok   - $nome\n";
    } catch (Throwable $e) {
        $falhas++;
        echo "FALHOU - $nome\n       {$e->getMessage()} (linha {$e->getLine()})\n";
    }
}
function igual($esperado, $obtido, string $msg = ''): void
{
    if ($esperado !== $obtido) {
        throw new Exception("$msg esperado " . var_export($esperado, true) . ', obtido ' . var_export($obtido, true));
    }
}
function verdade($cond, string $msg = 'condição falsa'): void
{
    if (!$cond) {
        throw new Exception($msg);
    }
}
function proximo_dia_util(): string
{
    $d = strtotime('+1 day');
    while (date('w', $d) === '0') {
        $d = strtotime('+1 day', $d);
    }
    return date('Y-m-d', $d);
}

// ---------------------------------------------------------------------------

teste('CRC16 do Pix segue o padrão CCITT-FALSE', function () {
    igual('29B1', pix_crc16('123456789'));
});

teste('gera Pix Copia e Cola com valor, recebedor e CRC válido', function () {
    $c = pix_copia_e_cola('contato@lavajato.com.br', 'João Lavações', 'São Paulo', 7050, 'LJ1');
    verdade(str_starts_with($c, '000201'));
    verdade(str_contains($c, '0014br.gov.bcb.pix0123contato@lavajato.com.br'));
    verdade(str_contains($c, '540570.50'));
    verdade(str_contains($c, '5913JOAO LAVACOES'), $c);
    verdade(str_contains($c, '6009SAO PAULO'));
    verdade(str_contains($c, '62070503LJ1'));
    igual(pix_crc16(substr($c, 0, -4)), substr($c, -4));
});

teste('primeiro acesso cria o dono uma única vez', function () {
    [, $info] = req('anon', 'GET', 'publico/info');
    igual(true, $info['precisa_configurar']);
    [$s, $r] = req('admin', 'POST', 'auth/primeiro-acesso', ['nome' => 'Dono', 'email' => 'dono@teste.com', 'senha' => 'segredo123']);
    igual(200, $s, json_encode($r));
    igual('admin', $r['usuario']['papel']);
    [$s] = req('anon', 'POST', 'auth/primeiro-acesso', ['nome' => 'Intruso', 'email' => 'x@x.com', 'senha' => '123456']);
    igual(409, $s);
    [, $info] = req('anon', 'GET', 'publico/info');
    igual(false, $info['precisa_configurar']);
});

teste('cadastro e login do cliente', function () {
    [$s, $r] = req('cliente', 'POST', 'auth/cadastro', ['nome' => 'Maria', 'email' => 'maria@x.com', 'telefone' => '11999', 'senha' => '123456']);
    igual(200, $s, json_encode($r));
    igual('cliente', $r['usuario']['papel']);
    [$s] = req('anon', 'POST', 'auth/cadastro', ['nome' => 'M', 'email' => 'MARIA@x.com', 'senha' => '123456']);
    igual(409, $s);
    [$s] = req('anon', 'POST', 'auth/login', ['email' => 'maria@x.com', 'senha' => 'errada']);
    igual(401, $s);
    [$s, $eu] = req('cliente', 'GET', 'auth/eu');
    igual(200, $s);
    igual('Maria', $eu['nome']);
});

teste('cliente não acessa o painel do dono, e o dono não entra pela área do cliente', function () {
    [$s] = req('cliente', 'GET', 'admin/resumo');
    igual(401, $s);
    [$s] = req('anon', 'GET', 'admin/resumo');
    igual(401, $s);
    [$s] = req('anon', 'POST', 'auth/login', ['email' => 'dono@teste.com', 'senha' => 'segredo123']);
    igual(403, $s);
});

teste('bloqueia requisições de outros sites (sem cabeçalho X-Area)', function () {
    [$s] = req('csrf', 'POST', 'auth/login', ['email' => 'dono@teste.com', 'senha' => 'segredo123']);
    igual(400, $s);
});

teste('fluxo completo: cupom, agendamento, Pix e confirmação pelo dono', function () {
    req('admin', 'PUT', 'admin/config', ['pix_chave' => '12345678901', 'pix_nome' => 'Lava Jato Teste', 'pix_cidade' => 'Campinas']);
    [$s, $cupom] = req('admin', 'POST', 'admin/cupons', ['codigo' => 'promo10', 'tipo' => 'percentual', 'valor' => '10']);
    igual(201, $s, json_encode($cupom));
    igual('PROMO10', $cupom['codigo']);

    [, $servicos] = req('anon', 'GET', 'publico/servicos');
    $completa = array_values(array_filter($servicos, fn ($x) => $x['nome'] === 'Lavagem completa'))[0];
    $data = proximo_dia_util();
    [, $horarios] = req('anon', 'GET', "publico/horarios?data=$data&servico_id={$completa['id']}");
    verdade(in_array('08:00', $horarios, true), json_encode($horarios));

    [$s, $ag] = req('cliente', 'POST', 'cliente/agendamentos', [
        'servico_id' => $completa['id'], 'data' => $data, 'hora' => '08:00', 'placa' => 'abc1d23', 'modelo' => 'Gol', 'cupom' => 'PROMO10',
    ]);
    igual(201, $s, json_encode($ag));
    igual('ABC1D23', $ag['placa']);
    igual('Maria', $ag['nome_cliente']);
    igual(6300, $ag['total_centavos']);

    [$s, $pix] = req('cliente', 'POST', "cliente/agendamentos/{$ag['id']}/pagamento", ['metodo' => 'pix']);
    igual(201, $s, json_encode($pix));
    igual('pendente', $pix['status']);
    igual(7000, $pix['valor_bruto_centavos']);
    igual(700, $pix['desconto_centavos']);
    igual(6300, $pix['valor_liquido_centavos']);
    verdade(str_contains($pix['pix_copia_cola'], '540563.00'));

    [$s, $outro] = req('anon', 'GET', "cliente/pagamentos/{$pix['id']}");
    igual(401, $s);

    [, $conf] = req('admin', 'PATCH', "admin/pagamentos/{$pix['id']}", ['status' => 'pago']);
    igual('pago', $conf['status']);

    [, $meus] = req('cliente', 'GET', 'cliente/agendamentos');
    igual(6300, $meus[0]['pago_centavos']);
    [$s] = req('cliente', 'POST', "cliente/agendamentos/{$ag['id']}/pagamento", ['metodo' => 'pix']);
    igual(400, $s);
    [$s] = req('cliente', 'POST', "cliente/agendamentos/{$ag['id']}/cancelar");
    igual(400, $s);
});

teste('respeita a quantidade de vagas simultâneas', function () {
    req('admin', 'PUT', 'admin/config', ['vagas_simultaneas' => '1']);
    $data = proximo_dia_util();
    // 08:00 já está ocupado pela lavagem completa (60 min) do teste anterior.
    [, $livres] = req('anon', 'GET', "publico/horarios?data=$data&servico_id=1");
    verdade(!in_array('08:00', $livres, true));
    verdade(!in_array('08:30', $livres, true));
    verdade(in_array('09:00', $livres, true));
    [$s] = req('cliente', 'POST', 'cliente/agendamentos', ['servico_id' => 1, 'data' => $data, 'hora' => '08:30', 'placa' => 'XYZ']);
    igual(409, $s);
    req('admin', 'PUT', 'admin/config', ['vagas_simultaneas' => '2']);
});

teste('dia bloqueado e agendamento online desativado', function () {
    $data = proximo_dia_util();
    req('admin', 'POST', 'admin/bloqueios', ['data' => $data, 'motivo' => 'Feriado']);
    [, $h] = req('anon', 'GET', "publico/horarios?data=$data&servico_id=1");
    igual([], $h);
    req('admin', 'DELETE', "admin/bloqueios/$data");

    req('admin', 'PUT', 'admin/config', ['agendamento_online' => '0']);
    [$s] = req('cliente', 'POST', 'cliente/agendamentos', ['servico_id' => 1, 'data' => $data, 'hora' => '10:00', 'placa' => 'AAA']);
    igual(400, $s);
    req('admin', 'PUT', 'admin/config', ['agendamento_online' => '1']);
});

teste('dono lança recebimentos com desconto e vê o resumo por forma de pagamento', function () {
    [$s, $avulso] = req('admin', 'POST', 'admin/pagamentos', [
        'descricao' => 'Lavagem de moto', 'valor' => '35,00', 'metodo' => 'dinheiro', 'desconto' => '5', 'desconto_tipo' => 'fixo',
    ]);
    igual(201, $s, json_encode($avulso));
    igual(3000, $avulso['valor_liquido_centavos']);

    [$s, $ag] = req('admin', 'POST', 'admin/agendamentos', [
        'nome_cliente' => 'Carlos', 'placa' => 'CAR0001', 'servico_id' => 3, 'data' => date('Y-m-d'), 'hora' => '07:00',
    ]);
    igual(201, $s, json_encode($ag));
    [, $cartao] = req('admin', 'POST', 'admin/pagamentos', [
        'agendamento_id' => $ag['id'], 'metodo' => 'cartao_credito', 'desconto' => '10', 'desconto_tipo' => 'percentual',
    ]);
    igual(11000, $cartao['valor_bruto_centavos']);
    igual(1100, $cartao['desconto_centavos']);
    igual(9900, $cartao['valor_liquido_centavos']);

    $hoje = date('Y-m-d');
    [, $r] = req('admin', 'GET', "admin/resumo?inicio=$hoje&fim=$hoje");
    igual(3, $r['quantidade']);
    igual(6300 + 3000 + 9900, $r['liquido_centavos']);
    // 10% do cupom PROMO10 (R$ 7,00) + R$ 5,00 + 10% no balcão (R$ 11,00)
    igual(700 + 500 + 1100, $r['descontos_centavos']);
    $porMetodo = array_column($r['por_metodo'], 'liquido_centavos', 'metodo');
    ksort($porMetodo);
    igual(['cartao_credito' => 9900, 'dinheiro' => 3000, 'pix' => 6300], $porMetodo);
});

teste('valida entradas inválidas', function () {
    igual(400, req('admin', 'POST', 'admin/pagamentos', ['descricao' => 'x', 'valor' => 'abc', 'metodo' => 'pix'])[0]);
    igual(400, req('admin', 'POST', 'admin/pagamentos', ['descricao' => 'x', 'valor' => '10', 'metodo' => 'boleto'])[0]);
    igual(400, req('anon', 'GET', 'publico/horarios?data=2024-02-31&servico_id=1')[0]);
    igual(400, req('anon', 'GET', 'publico/cupom/NAOEXISTE')[0]);
    igual(400, req('admin', 'PUT', 'admin/config', ['horario_abertura' => '8h'])[0]);
    igual(404, req('anon', 'GET', 'nao/existe')[0]);
});

teste('sair encerra a sessão', function () {
    req('cliente', 'POST', 'auth/sair');
    igual(401, req('cliente', 'GET', 'cliente/agendamentos')[0]);
    // o dono continua logado no painel
    igual(200, req('admin', 'GET', 'admin/servicos')[0]);
});

echo "\n" . ($total - $falhas) . "/$total testes passaram\n";
exit($falhas ? 1 : 0);
