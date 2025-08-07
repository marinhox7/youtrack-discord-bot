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

// A URL do ngrok é variável e deve ser configurada no YouTrack
// a cada vez que o ngrok for reiniciado. Pegue a URL gerada
// e a insira no seu arquivo .env, na variável NGROK_WEBHOOK_URL.

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
    console.log(`🚀 Servidor Express rodando na porta ${WEBHOOK_PORT}`);
});
