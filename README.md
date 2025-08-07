🚀 YouTrack Discord Bot
Um bot do Discord que se integra com o YouTrack para automatizar a comunicação e o fluxo de trabalho de issues.

🌟 Visão Geral
Este projeto conecta o YouTrack ao Discord, enviando notificações automáticas para um canal específico sempre que uma issue é criada ou atualizada. Além disso, o bot adiciona botões interativos que permitem aos membros do servidor realizar ações diretamente no YouTrack, como atribuir a si mesmos ou mudar o estado de uma issue.

A solução foi desenvolvida para contornar algumas limitações da API do YouTrack, utilizando a Commands API para operações que falhavam com customFields, garantindo assim um sistema mais robusto.

✨ Funcionalidades
📢 Notificações de Issues: Receba alertas em tempo real no Discord para issues criadas ou finalizadas.

🖱️ Interações com Botões: Interaja diretamente com as issues do YouTrack através de botões na mensagem do Discord para:

🔧 Atribuir a mim: Atribui a issue ao usuário que clicou no botão.

🔄 Mudar estado: Apresenta um menu para mudar o estado da issue (e.g., de "To do" para "In Progress").

🔗 Acessar Issue: Link direto para a issue no YouTrack.

👤 Mapeamento de Usuários: Mapeia usuários do Discord para usuários do YouTrack, permitindo a correta atribuição de issues.

🔒 Validação de Webhook: Garante que apenas webhooks válidos do YouTrack sejam processados, protegendo contra acessos não autorizados.

🏗️ Arquitetura
O sistema é composto por três partes principais:

YouTrack: Envia webhooks para um servidor externo em resposta a eventos de issues.

Servidor Express (server.js): Recebe os webhooks do YouTrack. Ele valida o token de segurança e processa o payload. Este servidor pode ser exposto à internet usando uma ferramenta como o ngrok.

Discord Bot (bot.js): Processa o payload do webhook e envia mensagens formatadas e com botões interativos para o canal do Discord. Ele também gerencia as interações de clique nos botões.

graph TD
    A[YouTrack] -- Webhook --> B(ngrok/Servidor Express);
    B -- Payload Processado --> C(Discord Bot);
    C -- Mensagem com Botões --> D[Canal do Discord];
    D -- Clique em Botão --> C;
    C -- API Call --> A;

⚙️ Configuração do Ambiente
📋 Pré-requisitos
Node.js instalado

Uma conta e um bot no Discord Developer Portal

Uma conta e um projeto no YouTrack

ngrok para expor o servidor local (opcional, mas recomendado para desenvolvimento)

1. 🔑 Variáveis de Ambiente
Crie um arquivo .env na raiz do projeto com as seguintes variáveis:

DISCORD_BOT_TOKEN="SEU_TOKEN_DO_DISCORD"
YOUTRACK_TOKEN="SEU_TOKEN_DE_WEBHOOK_DO_YOUTRACK"
YOUTRACK_URL="https://seu-dominio.youtrack.cloud"
DISCORD_CHANNEL_ID="ID_DO_CANAL_DO_DISCORD"
WEBHOOK_PORT=3000

2. 📦 Instalação das Dependências
Instale todas as dependências do projeto usando o npm:

npm install

3. 👥 Configuração do Mapeamento de Usuários
O bot utiliza o arquivo userMap.json para mapear IDs de usuários do Discord para logins de usuários do YouTrack. Adicione os usuários relevantes neste arquivo:

{
  "ID_DO_USUARIO_DISCORD_1": "login.youtrack.1",
  "ID_DO_USUARIO_DISCORD_2": "login.youtrack.2"
}

4. 🔗 Configuração do Webhook no YouTrack
Exponha seu servidor local à internet usando ngrok: ngrok http 3000. Copie o URL gerado.

No seu projeto do YouTrack, vá em Project Settings > Workflows > Webhooks.

Adicione um novo webhook com o URL do ngrok (ex: https://seu-url-ngrok.ngrok-free.app/webhook).

Certifique-se de que o webhook está configurado para enviar eventos de issue created e issue updated com a opção summary marcada.

Adicione um cabeçalho de autenticação personalizado x-youtrack-webhook-auth com o valor do YOUTRACK_TOKEN que você definiu no seu .env.

▶️ Como Executar
💻 Modo de Desenvolvimento (com nodemon)
npm run dev

🚀 Modo de Produção
npm start

📝 Próximos Passos
[ ] Implementar cache de estados de projeto

[ ] Adicionar mais tipos de campos personalizados

[ ] Implementar notificações de comentários

[ ] Adicionar comandos slash do Discord

[ ] Melhorar tratamento de permissões
