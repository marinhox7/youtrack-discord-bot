# 🎫 YouTrack Discord Bot

<div align="center">

![YouTrack Discord Bot](https://img.shields.io/badge/YouTrack-Discord-7289DA?style=for-the-badge&logo=discord&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-000000?style=for-the-badge&logo=express&logoColor=white)
![Status](https://img.shields.io/badge/Status-Production%20Ready-brightgreen?style=for-the-badge)

*Bot Discord avançado com integração completa ao YouTrack para automação de workflows e relatórios de produtividade*

[📥 Instalação](#-instalação) • [⚡ Recursos](#-recursos) • [🚀 Uso](#-uso) • [⚙️ Configuração](#️-configuração) • [📊 Relatórios](#-relatórios)

</div>

---

## ✨ Recursos

### 🔔 **Notificações Inteligentes**
- Notificações automáticas de criação e resolução de issues
- Embeds personalizados com informações detalhadas
- Integração via webhooks do YouTrack

### 🎛️ **Controles Interativos**
- **Botões de atribuição** - Atribua issues para você com um clique
- **Seletor de estados** - Altere o status das issues diretamente no Discord
- **Sistema de comentários** - Adicione comentários customizados ou use templates rápidos
- **Templates pré-definidos** - Respostas padronizadas para situações comuns

### 📊 **Relatórios Avançados**
- **Relatórios diários** - KPIs, saldo líquido, alertas de gargalos
- **Relatórios semanais** - Tendências, top performers, comparações
- **Drill-down interativo** - Detalhamento por usuário e issues críticas
- **Cache inteligente** - Performance otimizada com cache de 5 minutos

### 🔧 **Sistema Robusto**
- **Fallback automático** - Commands API + CustomFields API
- **Tratamento de erros** - Recuperação automática de falhas
- **Mapeamento de usuários** - Sincronização Discord ↔ YouTrack
- **Cache de estados** - Performance melhorada para projetos

---

## 🚀 Demonstração

### 📱 Notificação de Issue
```
🆕 Issue YOU-123: Implementar autenticação OAuth
📝 Descrição: Adicionar sistema de login social...

[👤 Atribuir para mim] [🔄 Alterar Estado] [💬 Comentar] [⚡ Comentários Rápidos]
```

### 📈 Relatório Diário
```
📊 Relatório Diário - Projeto Alpha
📅 07/08/2025

📈 KPIs do Dia
🎫 Criadas hoje: 18
✅ Resolvidas hoje: 12
🚧 Em andamento: 45
🟡 Total abertas: 156

⏰ Saldo Líquido
✅ +6 (resolveu mais que criou)

[📂 Ver por Usuário] [⚠️ Issues Antigas]
```

---

## 📥 Instalação

### Pré-requisitos
- **Node.js** 16+ 
- **YouTrack** Server/Cloud com API access
- **Discord Bot** com permissões adequadas
- **ngrok** ou servidor público para webhooks

### 1️⃣ Clone o repositório
```bash
git clone https://github.com/seu-usuario/youtrack-discord-bot.git
cd youtrack-discord-bot
```

### 2️⃣ Instale as dependências
```bash
npm install
```

### 3️⃣ Configure o ambiente
```bash
# Copie e configure o arquivo .env
cp .env.example .env
```

### 4️⃣ Configure o package.json
```json
{
  "name": "youtrack-discord-bot",
  "version": "1.0.0",
  "type": "module",
  "main": "bot.js",
  "scripts": {
    "start": "node bot.js",
    "dev": "nodemon bot.js"
  },
  "dependencies": {
    "discord.js": "^14.0.0",
    "express": "^4.18.0",
    "axios": "^1.5.0",
    "dotenv": "^16.0.0"
  }
}
```

### 5️⃣ Execute o bot
```bash
npm start
```

---

## ⚙️ Configuração

### 🔐 Variáveis de Ambiente (.env)
```env
# Discord
DISCORD_BOT_TOKEN="MTQwMjY2MDc1NzA3MzgyMTc3Ng.GiAiFQ.exemplo"
DISCORD_CHANNEL_ID="1402360170834694327"

# YouTrack
YOUTRACK_TOKEN="perm:dXNlcg==.VG9rZW4=.exemplo"
YOUTRACK_URL="https://sua-instancia.youtrack.cloud"

# Webhook
WEBHOOK_PORT=3000
```

### 👥 Mapeamento de Usuários (userMap.json)
```json
{
  "123456789012345678": "joao.silva",
  "987654321098765432": "maria.santos",
  "456789123456789123": "pedro.costa"
}
```
*Mapeamento Discord User ID → YouTrack Login*

### 🎯 Configuração do YouTrack Workflow

**1. Crie um novo workflow no YouTrack**
```javascript
const entities = require("@jetbrains/youtrack-scripting-api/entities");
const http = require("@jetbrains/youtrack-scripting-api/http");

exports.rule = entities.Issue.onChange({
    title: "Discord Webhook Integration",
    guard: (ctx) => ctx.issue.isReported || ctx.issue.isResolved,
    action: (ctx) => {
        const webhookData = {
            issueId: extractIssueId(ctx.issue.url),
            title: `${ctx.issue.becomesReported ? '🆕' : '✅'} Issue ${issueId}: ${ctx.issue.summary}`,
            url: ctx.issue.url,
            description: ctx.issue.description || 'Sem descrição',
            userVisibleName: ctx.currentUser.visibleName,
            statusChange: ctx.issue.becomesReported ? 'created' : 'resolved'
        };
        
        const connection = new http.Connection('SUA_URL_NGROK/webhook');
        connection.postSync('', null, JSON.stringify(webhookData));
    }
});
```

**2. Configure o ngrok para desenvolvimento**
```bash
ngrok http 3000
# Use a URL HTTPS gerada no workflow
```

---

## 🚀 Uso

### 💬 Comandos Slash

#### `/youtrack report`
Gera relatórios detalhados de produtividade

**Parâmetros:**
- `tipo`: `daily` (diário) ou `weekly` (semanal)
- `projeto`: ID do projeto (opcional)

**Exemplos:**
```
/youtrack report tipo:daily
/youtrack report tipo:weekly projeto:PROJ1
```

### 🎛️ Botões Interativos

| Botão | Função | Descrição |
|-------|--------|-----------|
| 👤 **Atribuir para mim** | Atribuição | Atribui a issue para o usuário que clicou |
| 🔄 **Alterar Estado** | Estados | Abre menu para seleção de novo estado |
| 💬 **Comentar** | Comentário | Modal para comentário personalizado |
| ⚡ **Comentários Rápidos** | Templates | Menu com respostas pré-definidas |

### 📝 Templates de Comentários

- **❓ Needs Info** - Solicitar informações adicionais
- **🔄 Duplicate** - Marcar como duplicada
- **✅ Not Bug** - Comportamento esperado
- **🚧 In Progress** - Comunicar início do desenvolvimento
- **🧪 Testing** - Sinalizar que está pronto para testes
- **✅ Resolved** - Confirmar resolução

---

## 📊 Relatórios

### 📅 Relatório Diário

**Métricas incluídas:**
- Issues criadas vs resolvidas no dia
- Saldo líquido de produtividade
- Total de issues em andamento
- Alertas de issues antigas (+7 dias sem atualização)

**Drill-downs disponíveis:**
- Detalhamento por usuário
- Lista de issues antigas

### 📈 Relatório Semanal

**Análises incluídas:**
- Tendências de criação/resolução
- Comparação com semana anterior
- Top performers da equipe
- Issues críticas em aberto

**Funcionalidades extras:**
- Cálculo automático de produtividade por usuário
- Identificação de tendências (alta/baixa/estável)
- Alertas de issues críticas não resolvidas

---

## 🔧 Desenvolvimento

### 🏗️ Arquitetura

```
YouTrack Workflow → ngrok → Express Server → Discord Bot → Canal Discord
                                ↓
                         Interações de botões
                                ↓
                         YouTrack REST API
```

### 🧪 Testing Local

```bash
# Terminal 1: Execute o bot
npm run dev

# Terminal 2: Expose via ngrok
ngrok http 3000

# Terminal 3: Teste as APIs
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{"issueId":"TEST-1","title":"Teste","url":"#"}'
```

### 🐛 Debug Common Issues

**1. Warning "MODULE_TYPELESS_PACKAGE_JSON"**
```json
// Adicione no package.json
{
  "type": "module"
}
```

**2. Erro "updated: ..date" inválido**
```javascript
// ❌ Incorreto
updated: ..2025-07-31

// ✅ Correto  
updated: * .. 2025-07-31
```

**3. Commands API vs CustomFields API**
```javascript
// O bot usa fallback automático:
// 1. Tenta Commands API (mais robusta)
// 2. Se falhar, usa CustomFields API
// 3. Logs detalhados para debug
```

---

## 📈 Roadmap

### 🔴 **Alta Prioridade**
- [x] Sistema de comentários rápidos
- [x] Relatórios automáticos com comandos slash
- [ ] Notificações de menções em comentários
- [ ] Sistema de aprovação para issues críticas

### 🟡 **Média Prioridade**
- [ ] Threads automáticas para discussão
- [ ] Templates de resposta customizáveis
- [ ] Integração com calendário de sprints
- [ ] Dashboard web complementar

### 🟢 **Baixa Prioridade**
- [ ] Comandos de voz para criação de issues
- [ ] Integração com Jira (migração)
- [ ] Analytics avançados com ML
- [ ] Mobile app companion

---

## 🤝 Contribuição

### 🌟 Como Contribuir

1. **Fork** o projeto
2. **Clone** seu fork: `git clone https://github.com/seu-usuario/youtrack-discord-bot.git`
3. **Crie** uma branch: `git checkout -b feature/nova-funcionalidade`
4. **Commit** suas mudanças: `git commit -m 'feat: adiciona nova funcionalidade'`
5. **Push** para a branch: `git push origin feature/nova-funcionalidade`
6. **Abra** um Pull Request

### 📝 Padrões de Commit

```
feat: nova funcionalidade
fix: correção de bug
docs: atualização de documentação
style: mudanças de formatação
refactor: refatoração de código
test: adição/correção de testes
chore: tarefas de manutenção
```

### 🧪 Guidelines

- **Testes**: Adicione testes para novas funcionalidades
- **Docs**: Mantenha a documentação atualizada
- **Lint**: Use `npm run lint` antes de commitar
- **Conventional Commits**: Siga os padrões de commit

---

## 📄 Licença

Este projeto está licenciado sob a **MIT License** - veja o arquivo [LICENSE](LICENSE) para detalhes.

---

## 🙋‍♂️ Suporte

### 🆘 Precisa de Ajuda?

- **📖 Wiki**: [Documentação completa](../../wiki)
- **🐛 Bug Reports**: [Issues](../../issues)
- **💬 Discussões**: [Discussions](../../discussions)
- **📧 Email**: suporte@exemplo.com

### 📊 Status do Projeto

- **🟢 Estável**: Sistema de notificações e controles
- **🟡 Beta**: Sistema de relatórios avançados  
- **🔴 Desenvolvimento**: Analytics e ML features

---

<div align="center">

**⭐ Se este projeto te ajudou, considere dar uma estrela!**

Made with ❤️ by [Seu Nome](https://github.com/seu-usuario)

</div>
