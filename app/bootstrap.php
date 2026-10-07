<?php
defined('LAVAJATO') or exit;

class ErroNegocio extends Exception
{
    public int $status;

    public function __construct(string $mensagem, int $status = 400)
    {
        parent::__construct($mensagem);
        $this->status = $status;
    }
}

function config(): array
{
    static $cfg = null;
    if ($cfg === null) {
        $cfg = require __DIR__ . '/config.php';
        // Permite sobrescrever por variáveis de ambiente (usado nos testes).
        foreach (['db_host', 'db_porta', 'db_nome', 'db_usuario', 'db_senha'] as $chave) {
            $env = getenv('LAVAJATO_' . strtoupper($chave));
            if ($env !== false) {
                $cfg[$chave] = $env;
            }
        }
    }
    return $cfg;
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo !== null) {
        return $pdo;
    }
    $c = config();
    $opcoes = [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
        PDO::ATTR_STRINGIFY_FETCHES => false,
    ];
    $base = "mysql:host={$c['db_host']};port={$c['db_porta']};charset=utf8mb4";
    try {
        $pdo = new PDO("$base;dbname={$c['db_nome']}", $c['db_usuario'], $c['db_senha'], $opcoes);
    } catch (PDOException $e) {
        // 1049 = banco não existe. No XAMPP o root pode criá-lo sozinho.
        if ((int) ($e->errorInfo[1] ?? 0) !== 1049) {
            throw $e;
        }
        $pdo = new PDO($base, $c['db_usuario'], $c['db_senha'], $opcoes);
        $nome = str_replace('`', '', $c['db_nome']);
        $pdo->exec("CREATE DATABASE `$nome` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
        $pdo->exec("USE `$nome`");
    }
    $pdo->exec("SET time_zone = '" . date('P') . "'");
    require_once __DIR__ . '/schema.php';
    garantir_schema($pdo);
    return $pdo;
}

function agora(): string
{
    return date('Y-m-d H:i:s');
}

function hoje(int $offsetDias = 0): string
{
    return date('Y-m-d', strtotime("$offsetDias days"));
}

/** Executa $fn dentro de uma transação. */
function transacao(callable $fn)
{
    $pdo = db();
    $pdo->beginTransaction();
    try {
        $r = $fn($pdo);
        $pdo->commit();
        return $r;
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
}

function consulta(string $sql, array $params = []): PDOStatement
{
    $st = db()->prepare($sql);
    $st->execute($params);
    return $st;
}

function linha(string $sql, array $params = []): ?array
{
    $r = consulta($sql, $params)->fetch();
    return $r === false ? null : $r;
}

function linhas(string $sql, array $params = []): array
{
    return consulta($sql, $params)->fetchAll();
}

function ultimo_id(): int
{
    return (int) db()->lastInsertId();
}

function ler_config(): array
{
    $cfg = [];
    foreach (linhas('SELECT chave, valor FROM config') as $l) {
        $cfg[$l['chave']] = $l['valor'];
    }
    return $cfg;
}

date_default_timezone_set(config()['fuso_horario'] ?? 'America/Sao_Paulo');
