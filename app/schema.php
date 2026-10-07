<?php
defined('LAVAJATO') or exit;

const VERSAO_SCHEMA = '1';

const CONFIG_PADRAO = [
    'nome_empresa' => 'Lava Jato',
    'telefone_empresa' => '',
    'endereco_empresa' => '',
    'agendamento_online' => '1',
    'horario_abertura' => '08:00',
    'horario_fechamento' => '18:00',
    'intervalo_min' => '30',
    'vagas_simultaneas' => '2',
    'dias_funcionamento' => '1,2,3,4,5,6', // 0 = domingo ... 6 = sábado
    'antecedencia_max_dias' => '30',
    'pix_chave' => '',
    'pix_nome' => '',
    'pix_cidade' => '',
];

/** Cria as tabelas na primeira execução. */
function garantir_schema(PDO $pdo): void
{
    try {
        $versao = $pdo->query("SELECT valor FROM config WHERE chave = 'versao_schema'")->fetchColumn();
        if ($versao === VERSAO_SCHEMA) {
            return;
        }
    } catch (PDOException $e) {
        // tabela ainda não existe
    }

    $tabelas = [
        "CREATE TABLE IF NOT EXISTS usuarios (
            id INT AUTO_INCREMENT PRIMARY KEY,
            nome VARCHAR(120) NOT NULL,
            email VARCHAR(190) NOT NULL UNIQUE,
            telefone VARCHAR(40) NULL,
            senha_hash VARCHAR(255) NOT NULL,
            papel VARCHAR(10) NOT NULL,
            criado_em DATETIME NOT NULL
        )",
        "CREATE TABLE IF NOT EXISTS servicos (
            id INT AUTO_INCREMENT PRIMARY KEY,
            nome VARCHAR(120) NOT NULL,
            descricao VARCHAR(255) NULL,
            preco_centavos INT NOT NULL,
            duracao_min INT NOT NULL,
            ativo TINYINT NOT NULL DEFAULT 1
        )",
        "CREATE TABLE IF NOT EXISTS cupons (
            id INT AUTO_INCREMENT PRIMARY KEY,
            codigo VARCHAR(30) NOT NULL UNIQUE,
            tipo VARCHAR(12) NOT NULL,
            valor INT NOT NULL,
            validade DATE NULL,
            ativo TINYINT NOT NULL DEFAULT 1
        )",
        "CREATE TABLE IF NOT EXISTS agendamentos (
            id INT AUTO_INCREMENT PRIMARY KEY,
            cliente_id INT NULL,
            nome_cliente VARCHAR(120) NOT NULL,
            telefone VARCHAR(40) NULL,
            placa VARCHAR(10) NOT NULL,
            modelo VARCHAR(80) NULL,
            servico_id INT NOT NULL,
            data DATE NOT NULL,
            hora CHAR(5) NOT NULL,
            duracao_min INT NOT NULL,
            valor_centavos INT NOT NULL,
            desconto_centavos INT NOT NULL DEFAULT 0,
            cupom_codigo VARCHAR(30) NULL,
            status VARCHAR(15) NOT NULL DEFAULT 'agendado',
            observacoes VARCHAR(255) NULL,
            criado_em DATETIME NOT NULL,
            INDEX idx_agendamentos_data (data, status),
            INDEX idx_agendamentos_cliente (cliente_id),
            FOREIGN KEY (cliente_id) REFERENCES usuarios(id),
            FOREIGN KEY (servico_id) REFERENCES servicos(id)
        )",
        "CREATE TABLE IF NOT EXISTS pagamentos (
            id INT AUTO_INCREMENT PRIMARY KEY,
            agendamento_id INT NULL,
            descricao VARCHAR(160) NOT NULL,
            valor_bruto_centavos INT NOT NULL,
            desconto_centavos INT NOT NULL DEFAULT 0,
            valor_liquido_centavos INT NOT NULL,
            metodo VARCHAR(15) NOT NULL,
            status VARCHAR(10) NOT NULL DEFAULT 'pendente',
            origem VARCHAR(10) NOT NULL,
            pix_txid VARCHAR(25) NULL,
            pix_copia_cola TEXT NULL,
            criado_em DATETIME NOT NULL,
            pago_em DATETIME NULL,
            INDEX idx_pagamentos_pago (status, pago_em),
            INDEX idx_pagamentos_agendamento (agendamento_id),
            FOREIGN KEY (agendamento_id) REFERENCES agendamentos(id)
        )",
        "CREATE TABLE IF NOT EXISTS bloqueios (
            data DATE PRIMARY KEY,
            motivo VARCHAR(120) NULL
        )",
        "CREATE TABLE IF NOT EXISTS tentativas_login (
            id INT AUTO_INCREMENT PRIMARY KEY,
            ip VARCHAR(45) NOT NULL,
            em DATETIME NOT NULL,
            INDEX idx_tentativas (ip, em)
        )",
        "CREATE TABLE IF NOT EXISTS config (
            chave VARCHAR(40) PRIMARY KEY,
            valor TEXT NOT NULL
        )",
    ];
    foreach ($tabelas as $sql) {
        $pdo->exec($sql . ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
    }

    $ins = $pdo->prepare('INSERT IGNORE INTO config (chave, valor) VALUES (?, ?)');
    foreach (CONFIG_PADRAO as $chave => $valor) {
        $ins->execute([$chave, $valor]);
    }

    if ((int) $pdo->query('SELECT COUNT(*) FROM servicos')->fetchColumn() === 0) {
        $s = $pdo->prepare('INSERT INTO servicos (nome, descricao, preco_centavos, duracao_min) VALUES (?, ?, ?, ?)');
        $s->execute(['Lavagem simples', 'Lavagem externa com secagem', 4000, 30]);
        $s->execute(['Lavagem completa', 'Externa + aspiração e painel', 7000, 60]);
        $s->execute(['Lavagem + cera', 'Lavagem completa com enceramento', 11000, 90]);
        $s->execute(['Higienização interna', 'Bancos, carpetes e teto', 25000, 180]);
    }

    $pdo->prepare("REPLACE INTO config (chave, valor) VALUES ('versao_schema', ?)")->execute([VERSAO_SCHEMA]);
}
