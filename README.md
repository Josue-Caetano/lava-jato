# Lava Jato — gestão e agendamento

Sistema web para lava jato com duas áreas:

- **Área do cliente** (`/`): o cliente cria uma conta, escolhe o serviço, o dia e o horário livre, informa o carro, aplica um cupom de desconto e paga com **Pix (QR Code + Copia e Cola)** ou escolhe pagar no local (cartão ou dinheiro). Em "Meus agendamentos" ele acompanha o status, paga e cancela.
- **Painel do dono** (`/admin`):
  - **Resumo**: faturamento líquido, descontos concedidos, ticket médio, valores a receber, totais por forma de pagamento e faturamento por dia (hoje, 7 dias, mês ou período livre).
  - **Agenda**: agendamentos por dia, com ações para iniciar, concluir, cancelar e receber. O dono também cria agendamentos (inclusive encaixes fora da grade).
  - **Recebimentos**: lança recebimentos (avulsos ou de um agendamento) em **Pix, cartão de crédito, cartão de débito ou dinheiro**, com desconto em R$ ou %. Confirma os Pix pagos pelos clientes e cancela cobranças.
  - **Serviços**: preços, duração e ativação de cada serviço.
  - **Descontos**: cupons percentuais ou de valor fixo, com validade.
  - **Clientes**: lista de clientes cadastrados.
  - **Configurações**: dados da empresa, liga/desliga o agendamento online, horário de funcionamento, intervalo entre horários, quantos carros ao mesmo tempo, dias da semana, dias bloqueados (feriados), chave Pix e troca de senha.

Os dados ficam num banco **SQLite** (arquivo `data/lavajato.db`), criado automaticamente na primeira execução.

## Como rodar

Requer **Node.js 22.13 ou mais novo** (o SQLite já vem embutido no Node).

```bash
npm install
npm start
```

- Cliente: http://localhost:3000
- Dono: http://localhost:3000/admin

Na primeira execução é criado o usuário do dono. Defina o e-mail e a senha por variável de ambiente:

```bash
ADMIN_EMAIL=dono@meulavajato.com ADMIN_SENHA=uma-senha-forte npm start
```

Sem essas variáveis, o login é `admin@lavajato.local` com uma senha aleatória mostrada no terminal; troque-a em **Configurações**.

Depois de entrar no painel, vá em **Configurações** e preencha a **chave Pix**, o nome do recebedor e a cidade. Sem isso, o cliente só consegue escolher pagar no local.

### Variáveis de ambiente

| Variável | Padrão | Para quê |
|---|---|---|
| `PORT` | `3000` | Porta do servidor |
| `DB_PATH` | `data/lavajato.db` | Arquivo do banco de dados |
| `ADMIN_EMAIL` / `ADMIN_SENHA` | — | Usuário do dono criado na primeira execução |
| `TZ` | `America/Sao_Paulo` | Fuso horário dos agendamentos |

## Testes

```bash
npm test
```

## Como funcionam os pagamentos

- **Pix**: o sistema gera o QR Code e o código Copia e Cola no padrão do Banco Central, já com o valor do agendamento, direto para a chave Pix do dono, sem intermediário nem taxa. Como é Pix estático, o banco não avisa o sistema automaticamente: quando o dinheiro cair, o dono clica em **Confirmar** em Recebimentos.
- **Cartão e dinheiro**: o cliente escolhe pagar no local e o dono lança o recebimento no balcão (na maquininha), indicando crédito ou débito.
- **Descontos**: cupons são aplicados pelo cliente ao agendar; no balcão, o dono informa o desconto ao lançar o recebimento. Os dois aparecem em "Descontos concedidos".

### Próximos passos possíveis

- Cobrar **cartão online** e **confirmar o Pix automaticamente**: é preciso integrar um gateway de pagamento (Mercado Pago, PagSeguro, Asaas, Stripe…), que exige conta e credenciais da empresa.
- Lembretes por WhatsApp/e-mail antes do horário.

## Colocando no ar

O app é um único processo Node com um arquivo de banco, então roda em qualquer VPS ou serviço que mantenha um disco persistente (Railway, Render com disco, Fly.io com volume…). Use HTTPS e faça **backup do arquivo `data/lavajato.db`**.

## Estrutura

```
src/
  server.js    inicialização (porta, banco, usuário do dono)
  app.js       rotas da API (público, cliente, admin)
  negocio.js   regras: horários livres, descontos, pagamentos, relatórios
  pix.js       gerador do Pix Copia e Cola (BR Code)
  auth.js      login com token assinado
  db.js        esquema do banco SQLite e dados iniciais
public/
  index.html   área do cliente
  admin.html   painel do dono
test/          testes automatizados
```
