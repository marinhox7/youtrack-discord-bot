require('dotenv').config();

import { Client, GatewayIntentBits, Partials, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';

import { post } from 'axios';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import express from 'express';
import { json } from 'body-parser';

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const YOUTRACK_TOKEN = process.env.YOUTRACK_TOKEN;
const YOUTRACK_URL = process.env.YOUTRACK_URL;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const PORT = process.env.WEBHOOK_PORT || 3000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

const USER_MAP_FILE = join(__dirname, 'userMap.json');
let userMap = {};
if (existsSync(USER_MAP_FILE)) {
  userMap = JSON.parse(readFileSync(USER_MAP_FILE));
}
function saveUserMap() {
  writeFileSync(USER_MAP_FILE, JSON.stringify(userMap, null, 2));
}

client.once(Events.ClientReady, () => {
  console.log(`✅ Bot está online como ${client.user.tag}`);
});

async function updateIssue(issueId, fields) {
  await post(
    `${YOUTRACK_URL}/api/issues/${issueId}`,
    { fields },
    {
      headers: {
        Authorization: `Bearer ${YOUTRACK_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    }
  );
}

async function askYouTrackLogin(user) {
  try {
    const dm = await user.createDM();
    await dm.send('Olá! Por favor, envie seu login do YouTrack.');
    const filter = (m) => m.author.id === user.id;
    const collected = await dm.awaitMessages({ filter, max: 1, time: 60000 });
    if (!collected.size) return null;
    const login = collected.first().content.trim();
    return login;
  } catch (err) {
    console.error('Erro ao enviar DM:', err);
    return null;
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton()) {
    const [action, issueId] = interaction.customId.split('_');
    const discordUserId = interaction.user.id;
    let youTrackLogin = userMap[discordUserId];

    if (!youTrackLogin) {
      await interaction.reply({ content: '❓ Login YouTrack não encontrado. Verifique seu DM.', ephemeral: true });
      const login = await askYouTrackLogin(interaction.user);
      if (!login) return;
      userMap[discordUserId] = login;
      saveUserMap();
      youTrackLogin = login;
    }

    if (action === 'assign') {
      try {
        await updateIssue(issueId, [{ name: 'Assignee', value: { login: youTrackLogin } }]);
        await interaction.reply({ content: `✅ Issue ${issueId} atribuída a você.`, ephemeral: true });
      } catch (err) {
        console.error(err);
        await interaction.reply({ content: '❌ Erro ao atribuir a issue.', ephemeral: true });
      }
    } else if (action === 'changeState') {
      const states = [
        { label: 'OPEN', value: 'OPEN' },
        { label: 'CORRECTION', value: 'CORRECTION' },
        { label: 'IN DEVELOPMENT', value: 'IN DEVELOPMENT' },
        { label: 'READY TO REVIEW', value: 'READY TO REVIEW' },
        { label: 'REVIEWING', value: 'REVIEWING' },
        { label: 'APPROVED', value: 'APPROVED' },
        { label: 'DONE', value: 'DONE' },
        { label: 'CLOSED', value: 'CLOSED' },
      ];
      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`selectState_${issueId}`)
        .setPlaceholder('Escolha o novo estado')
        .addOptions(states);
      const row = new ActionRowBuilder().addComponents(selectMenu);
      await interaction.reply({ content: 'Selecione o novo estado:', components: [row], ephemeral: true });
    }
  } else if (interaction.isStringSelectMenu()) {
    const issueId = interaction.customId.split('_')[1];
    const selectedState = interaction.values[0];
    const discordUserId = interaction.user.id;
    const youTrackLogin = userMap[discordUserId];
    if (!youTrackLogin) return;
    try {
      await updateIssue(issueId, [{ name: 'State', value: { name: selectedState } }]);
      await interaction.reply({ content: `✅ Estado da issue ${issueId} atualizado para ${selectedState}.`, ephemeral: true });
    } catch (err) {
      console.error(err);
      await interaction.reply({ content: '❌ Erro ao mudar o estado.', ephemeral: true });
    }
  }
});

// Endpoint de webhook do YouTrack
const app = express();
app.use(json());

app.post('/webhook', async (req, res) => {
  const data = req.body;

  const issueId = data.issueId;
  const description = data.description || 'Sem descrição';
  const title = data.title || `Issue ${issueId}`;
  const url = data.url || null;
  const fields = data.fields || [];
  const statusChange = data.statusChange || 'created';

  if (!issueId) {
    console.warn(`⚠️ Issue ID ausente no payload recebido.`);
    return res.status(400).send('Issue ID não encontrado');
  }

  try {
    const embed = {
      title: title,
      description: description.length > 2048 ? description.slice(0, 2044) + '...' : description,
      url: url,
      color: statusChange === 'created' ? 0x22C55E : 0x3093D1,
      timestamp: new Date().toISOString(),
      fields: fields.map(field => ({
        name: field.title,
        value: field.value || 'Nenhum valor',
        inline: true
      }))
    };

    const assignBtn = new ButtonBuilder()
      .setCustomId(`assign_${issueId}`)
      .setLabel('🔧 Atribuir a mim')
      .setStyle(ButtonStyle.Primary);

    const changeStateBtn = new ButtonBuilder()
      .setCustomId(`changeState_${issueId}`)
      .setLabel('🔄 Mudar estado')
      .setStyle(ButtonStyle.Secondary);

    const linkBtn = new ButtonBuilder()
      .setLabel('Acessar Issue')
      .setURL(url)
      .setStyle(ButtonStyle.Link);

    const row = new ActionRowBuilder().addComponents(assignBtn, changeStateBtn, linkBtn);

    const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
    await channel.send({
      embeds: [embed],
      components: [row]
    });

    res.sendStatus(200);
  } catch (err) {
    console.error('Erro ao processar webhook:', err);
    res.status(500).send('Erro interno');
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Webhook escutando em http://localhost:${PORT}/webhook`);
});

client.login(DISCORD_BOT_TOKEN);
