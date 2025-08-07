// server.js

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const {
    sendIssueNotification,
    client
} = require('./bot.js');

const app = express();
app.use(express.json());

const YOUTRACK_TOKEN = process.env.YOUTRACK_TOKEN;
const WEBHOOK_PORT = process.env.WEBHOOK_PORT || 3000;
const YOUTRACK_URL = process.env.YOUTRACK_URL;

// Este é o URL que você deve atualizar sempre que o ngrok mudar
const WEBHOOK_URL = 'https://db852ce46491.ngrok-free.app';

// Validação simples para o token do YouTrack
const validateYouTrackToken = (req, res, next) => {
    const youtrackToken = req.headers['x-youtrack-webhook-auth'];
    if (youtrackToken === YOUTRACK_TOKEN) {
        next();
    } else {
        res.status(401).send('Token de autenticação inválido.');
    }
};

app.post('/webhook', validateYouTrackToken, async (req, res) => {
    console.log('Webhook recebido. Processando...');

    const issue = req.body.issue;
    const change = req.body.change;

    if (issue && change && change.summary) {
        const title = issue.summary;
        const issueId = issue.idReadable;
        const issueUrl = `${YOUTRACK_URL}/issue/${issueId}`;
        const description = change.summary;

        if (client.isReady()) {
            await sendIssueNotification(issueId, title, issueUrl, description);
            res.status(200).send('Notificação enviada com sucesso para o Discord.');
        } else {
            console.error('❌ O bot não está pronto para enviar mensagens.');
            res.status(500).send('O bot do Discord não está pronto.');
        }
    } else {
        res.status(400).send('Dados do webhook inválidos.');
    }
});

app.listen(WEBHOOK_PORT, () => {
    console.log(`🚀 Servidor do webhook rodando em http://localhost:${WEBHOOK_PORT}`);
    console.log(`🔗 Webhook URL público: ${WEBHOOK_URL}/webhook`);
    console.log('🔔 Lembre-se de configurar este URL no YouTrack.');
});

// Inicializa o bot
client.login(process.env.DISCORD_BOT_TOKEN);