# Lava Jato — gestão e agendamento

Sistema web em **PHP + MySQL** para lava jato. Roda no **XAMPP** e em hospedagens comuns como a **HostGator**, sem instalar nada além do que elas já têm.

- **Área do cliente** (`/`): o cliente cria uma conta, escolhe o serviço, o dia e um horário livre, informa o carro, aplica um cupom de desconto e paga com **Pix (QR Code + Copia e Cola)** ou escolhe pagar no local (cartão ou dinheiro). Em "Meus agendamentos" ele acompanha o status, paga e cancela.
- **Painel do dono** (`/admin/`):
  - **Resumo**: faturamento líquido, descontos concedidos, ticket médio, valores a receber, totais por forma de pagamento e faturamento por dia.
  - **Agenda**: agendamentos por dia, com botões para iniciar, concluir, cancelar e receber. O dono também cria agendamentos, inclusive encaixes.
  - **Recebimentos**: lança recebimentos (avulsos ou de um agendamento) em **Pix, cartão de crédito, cartão de débito ou dinheiro**, com desconto em R$ ou %. Confirma os Pix pagos pelos clientes.
  - **Serviços**, **Descontos** (cupons), **Clientes** e **Configurações** (dados da empresa, horário de funcionamento, vagas simultâneas, dias da semana, dias bloqueados, chave Pix, liga/desliga o agendamento online e troca de senha).

**Requisitos:** PHP 8.0 ou mais novo e MySQL 5.7+ (ou MariaDB 10.3+).

---

## Rodando no XAMPP (no seu PC)

1. Instale o XAMPP (https://www.apachefriends.org) e, no **XAMPP Control Panel**, clique em **Start** no **Apache** e no **MySQL**.
2. Copie a pasta do projeto para dentro de `C:\xampp\htdocs\` e renomeie para `lava-jato`, ficando `C:\xampp\htdocs\lava-jato\index.html`.
3. Abra no navegador:
   - Painel do dono: **http://localhost/lava-jato/admin/**
   - Área do cliente: **http://localhost/lava-jato/**
4. No primeiro acesso ao painel aparece a tela **"Crie a conta do dono"**. Preencha nome, e-mail e senha.
5. Vá em **Configurações** e preencha a **chave Pix**, o nome do recebedor e a cidade.

Não precisa criar o banco: no XAMPP o sistema cria o banco `lavajato` e as tabelas sozinho. Você pode ver os dados no phpMyAdmin (http://localhost/phpmyadmin).

> Se o seu MySQL do XAMPP tiver senha no usuário `root`, coloque-a em `app/config.php`.

## Colocando na HostGator (ou outra hospedagem com cPanel)

1. **Crie o banco de dados.** No cPanel, abra **Bancos de dados MySQL**:
   - crie um banco (ex.: `lavajato`; o cPanel adiciona um prefixo, ficando algo como `seuusuario_lavajato`);
   - crie um usuário com uma senha forte;
   - em "Adicionar usuário ao banco de dados", ligue os dois e marque **Todos os privilégios**.
2. **Configure a conexão.** Edite o arquivo `app/config.php` com os nomes completos, já com o prefixo:
   ```php
   'db_host'    => 'localhost',
   'db_nome'    => 'seuusuario_lavajato',
   'db_usuario' => 'seuusuario_lavajato',
   'db_senha'   => 'a-senha-que-voce-criou',
   ```
3. **Envie os arquivos.** Pelo **Gerenciador de Arquivos** do cPanel (ou FTP), envie todo o conteúdo da pasta para `public_html/`, para usar o domínio principal, ou para uma subpasta como `public_html/agendamento/`. Inclua os arquivos `.htaccess`: no Gerenciador de Arquivos, ative "Mostrar arquivos ocultos".
4. **Versão do PHP.** Em **MultiPHP Manager** (ou "Selecionar versão do PHP"), escolha **PHP 8.1 ou mais novo** para o domínio.
5. **HTTPS.** Ative o certificado SSL gratuito (AutoSSL / Let's Encrypt) no cPanel. Como o sistema tem login, o site deve abrir com `https://`.
6. Acesse `https://seudominio.com.br/admin/` e crie a conta do dono no primeiro acesso.

**Backup:** no phpMyAdmin do cPanel, selecione o banco e use **Exportar** de tempos em tempos. Todos os dados (clientes, agendamentos e recebimentos) ficam no banco.

---

## Como funcionam os pagamentos

- **Pix:** o sistema gera o QR Code e o código Copia e Cola no padrão do Banco Central, já com o valor do agendamento, direto para a chave Pix do dono, sem intermediário nem taxa. Por ser um Pix estático, o banco não avisa o sistema quando o dinheiro cai: o dono confere no app do banco e clica em **Confirmar** em Recebimentos.
- **Cartão e dinheiro:** o cliente escolhe pagar no local e o dono lança o recebimento no balcão (na maquininha), indicando crédito ou débito.
- **Descontos:** cupons são aplicados pelo cliente ao agendar; no balcão, o dono informa o desconto ao lançar o recebimento. Os dois aparecem em "Descontos concedidos".

Para cobrar **cartão online** e **confirmar o Pix automaticamente**, é preciso integrar um serviço de pagamento (Mercado Pago, Asaas, PagSeguro…), que exige conta e credenciais da empresa.

## Estrutura

```
index.html          área do cliente
admin/index.html    painel do dono
api.php             API usada pelas telas (api.php?r=<rota>)
app/                código do servidor (acesso bloqueado pelo .htaccess)
  config.php        dados de conexão com o MySQL  ← edite este
  bootstrap.php     conexão com o banco e utilitários
  schema.php        criação automática das tabelas
  negocio.php       regras: horários livres, descontos, pagamentos, relatórios
  rotas.php         rotas da API e login
  pix.php           gerador do Pix Copia e Cola (BR Code)
css/, js/           visual e telas (js/vendor/qrcode.js gera o QR Code)
tests/              testes automatizados
```

## Testes (para desenvolvedores)

Com um MySQL rodando, execute na pasta do projeto:

```bash
php tests/teste_api.php
```

O teste **apaga e recria** o banco `lavajato_teste`. Credenciais diferentes de `root` sem senha podem ser passadas por `LAVAJATO_DB_USUARIO` e `LAVAJATO_DB_SENHA`.
