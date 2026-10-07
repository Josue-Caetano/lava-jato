<?php
// Ponto de entrada da API. As telas chamam: api.php?r=<rota>

define('LAVAJATO', true);

require __DIR__ . '/app/bootstrap.php';
require __DIR__ . '/app/pix.php';
require __DIR__ . '/app/negocio.php';
require __DIR__ . '/app/rotas.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function responder(int $status, $dados): void
{
    http_response_code($status);
    echo json_encode($dados, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

$https = ($_SERVER['HTTPS'] ?? '') !== '' && $_SERVER['HTTPS'] !== 'off';
session_name('LAVAJATO');
session_set_cookie_params(['lifetime' => 60 * 60 * 24 * 7, 'path' => '/', 'httponly' => true, 'samesite' => 'Lax', 'secure' => $https]);
session_start();

$metodo = $_SERVER['REQUEST_METHOD'];
$rota = trim((string) ($_GET['r'] ?? ''), '/');

try {
    // Proteção contra CSRF: requisições que alteram dados precisam do cabeçalho
    // X-Area, que outros sites não conseguem enviar.
    if ($metodo !== 'GET' && empty($_SERVER['HTTP_X_AREA'])) {
        throw new ErroNegocio('Requisição inválida', 400);
    }

    $corpo = [];
    if ($metodo !== 'GET') {
        $bruto = file_get_contents('php://input');
        if ($bruto !== '') {
            $corpo = json_decode($bruto, true);
            if (!is_array($corpo)) {
                throw new ErroNegocio('JSON inválido');
            }
        }
    }

    foreach (rotas() as [$m, $padrao, $acao]) {
        if ($m === $metodo && preg_match("#^$padrao$#", $rota, $params)) {
            array_shift($params);
            $resultado = $acao($params, $corpo);
            if (session_status() === PHP_SESSION_ACTIVE) {
                session_write_close();
            }
            responder(http_response_code() ?: 200, $resultado);
        }
    }
    throw new ErroNegocio('Rota não encontrada', 404);
} catch (ErroNegocio $e) {
    responder($e->status, ['erro' => $e->getMessage()]);
} catch (PDOException $e) {
    error_log('[lavajato] ' . $e->getMessage());
    $msg = str_contains($e->getMessage(), 'SQLSTATE[HY000] [')
        ? 'Não foi possível conectar ao banco de dados. Confira o arquivo app/config.php.'
        : 'Erro interno no servidor';
    responder(500, ['erro' => $msg]);
} catch (Throwable $e) {
    error_log('[lavajato] ' . $e);
    responder(500, ['erro' => 'Erro interno no servidor']);
}
