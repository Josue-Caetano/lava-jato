<?php
defined('LAVAJATO') or exit;

// Configuração do banco de dados MySQL.
// Os valores abaixo já funcionam no XAMPP (usuário "root" sem senha).
// Na hospedagem (HostGator etc.), crie o banco e o usuário no cPanel
// em "Bancos de dados MySQL" e preencha os dados aqui.
return [
    'db_host'    => 'localhost',
    'db_porta'   => 3306,
    'db_nome'    => 'lavajato',
    'db_usuario' => 'root',
    'db_senha'   => '',

    'fuso_horario' => 'America/Sao_Paulo',
];
