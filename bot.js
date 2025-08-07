import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder } from 'discord.js';
import express from 'express';
import axios from 'axios';
import { config } from 'dotenv';
import fs from 'fs';
import path from 'path';

// Configurar dotenv
config();

const app = express();

// Middleware para parsing JSON
app.use(express.json());

// Configurações
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const YOUTRACK_TOKEN = process.env.YOUTRACK_TOKEN;
const YOUTRACK_URL = process.env.YOUTRACK_URL;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const WEBHOOK_PORT = process.env.WEBHOOK_PORT || 3000;

// Inicializar cliente Discord
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Carregar mapeamento de usuários
let userMap = {};
try {
    const userMapData = fs.readFileSync('userMap.json', 'utf8');
    userMap = JSON.parse(userMapData);
} catch (error) {
    console.log('userMap.json não encontrado, criando arquivo vazio...');
    userMap = {
        "exemplo_discord_id": "exemplo.youtrack.login"
    };
    fs.writeFileSync('userMap.json', JSON.stringify(userMap, null, 2));
}

// Cache para estados de projeto
const projectStatesCache = new Map();

// Função para obter estados do projeto
async function getProjectStates(projectId) {
    if (projectStatesCache.has(projectId)) {
        return projectStatesCache.get(projectId);
    }

    try {
        // 1. Obter campos customizados do projeto
        const projectFieldsResponse = await axios.get(
            `${YOUTRACK_URL}/api/admin/projects/${projectId}/customFields?fields=id,field(name),$type`,
            {
                headers: {
                    Authorization: `Bearer ${YOUTRACK_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        // 2. Encontrar field ID do campo State
        const customFields = projectFieldsResponse.data;
        const stateField = customFields.find(field => 
            field.field.name === 'State' && field.$type === 'StateProjectCustomField'
        );

        if (!stateField) {
            console.log('Campo State não encontrado no projeto');
            return [];
        }

        // 3. Buscar valores do bundle usando fieldId
        const bundleValuesResponse = await axios.get(
            `${YOUTRACK_URL}/api/admin/projects/${projectId}/customFields/${stateField.id}/bundle/values?fields=id,name,isResolved,ordinal`,
            {
                headers: {
                    Authorization: `Bearer ${YOUTRACK_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        const states = bundleValuesResponse.data;
        projectStatesCache.set(projectId, states);
        return states;

    } catch (error) {
        console.error('Erro ao obter estados do projeto:', error.response?.data || error.message);
        return [];
    }
}

// Função para atribuir issue
async function assignIssue(issueId, userLogin) {
    try {
        // MÉTODO 1: Commands API (RECOMENDADO)
        const commandPayload = {
            query: `Assignee ${userLogin}`,
            issues: [{ idReadable: issueId }]
        };
        
        await axios.post(`${YOUTRACK_URL}/api/commands`, commandPayload, {
            headers: {
                Authorization: `Bearer ${YOUTRACK_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        
        console.log(`Issue ${issueId} atribuída para ${userLogin} via Commands API`);
        return true;
        
    } catch (error) {
        console.error('Erro Commands API, tentando método alternativo:', error.response?.data || error.message);
        
        try {
            // MÉTODO 2: Fallback customFields
            await axios.post(`${YOUTRACK_URL}/api/issues/${issueId}`, {
                customFields: [{
                    name: 'Assignee',
                    '$type': 'SingleUserIssueCustomField',
                    value: { login: userLogin }
                }]
            }, {
                headers: {
                    Authorization: `Bearer ${YOUTRACK_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            });
            
            console.log(`Issue ${issueId} atribuída para ${userLogin} via customFields`);
            return true;
            
        } catch (fallbackError) {
            console.error('Erro ao atribuir issue (ambos métodos falharam):', fallbackError.response?.data || fallbackError.message);
            return false;
        }
    }
}

// Função para mudar estado da issue
async function changeIssueState(issueId, stateId) {
    try {
        const payload = {
            customFields: [{
                name: 'State',
                '$type': 'StateIssueCustomField',
                value: { id: stateId }
            }]
        };
        
        await axios.post(`${YOUTRACK_URL}/api/issues/${issueId}`, payload, {
            headers: {
                Authorization: `Bearer ${YOUTRACK_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        
        console.log(`Estado da issue ${issueId} alterado para ${stateId}`);
        return true;
        
    } catch (error) {
        console.error('Erro ao alterar estado:', error.response?.data || error.message);
        return false;
    }
}

// Event listener quando o bot estiver pronto
client.once('ready', () => {
    console.log(`Bot Discord conectado como: ${client.user.tag}`);
});

// Event listener para interações
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;

    const issueId = interaction.customId.split('_')[1];
    
    try {
        if (interaction.isButton()) {
            const action = interaction.customId.split('_')[0];
            
            if (action === 'assign') {
                const discordUserId = interaction.user.id;
                const youtrackLogin = userMap[discordUserId];
                
                if (!youtrackLogin) {
                    await interaction.reply({
                        content: '❌ Usuário não mapeado. Configure o userMap.json',
                        ephemeral: true
                    });
                    return;
                }
                
                const success = await assignIssue(issueId, youtrackLogin);
                
                if (success) {
                    await interaction.reply({
                        content: `✅ Issue ${issueId} atribuída para você!`,
                        ephemeral: true
                    });
                } else {
                    await interaction.reply({
                        content: `❌ Erro ao atribuir issue ${issueId}`,
                        ephemeral: true
                    });
                }
                
            } else if (action === 'states') {
                try {
                    // Obter projectId da issue
                    const issueResponse = await axios.get(`${YOUTRACK_URL}/api/issues/${issueId}?fields=project(id)`, {
                        headers: {
                            Authorization: `Bearer ${YOUTRACK_TOKEN}`,
                            'Content-Type': 'application/json'
                        }
                    });
                    
                    const projectId = issueResponse.data.project.id;
                    const states = await getProjectStates(projectId);
                    
                    if (states.length === 0) {
                        await interaction.reply({
                            content: '❌ Não foi possível obter os estados disponíveis',
                            ephemeral: true
                        });
                        return;
                    }
                    
                    // Limitar a 25 opções (limite do Discord)
                    const limitedStates = states.slice(0, 25);
                    
                    const selectMenu = new StringSelectMenuBuilder()
                        .setCustomId(`state_${issueId}`)
                        .setPlaceholder('Selecione o novo estado')
                        .addOptions(
                            limitedStates.map(state => ({
                                label: state.name,
                                value: state.id,
                                description: state.isResolved ? 'Estado resolvido' : 'Estado ativo'
                            }))
                        );
                    
                    const row = new ActionRowBuilder().addComponents(selectMenu);
                    
                    await interaction.reply({
                        content: `Escolha o novo estado para ${issueId}:`,
                        components: [row],
                        ephemeral: true
                    });
                    
                } catch (error) {
                    console.error('Erro ao buscar estados:', error);
                    await interaction.reply({
                        content: '❌ Erro ao buscar estados disponíveis',
                        ephemeral: true
                    });
                }
            }
        }
        
        if (interaction.isStringSelectMenu()) {
            const action = interaction.customId.split('_')[0];
            
            if (action === 'state') {
                const selectedStateId = interaction.values[0];
                const success = await changeIssueState(issueId, selectedStateId);
                
                if (success) {
                    await interaction.reply({
                        content: `✅ Estado da issue ${issueId} alterado com sucesso!`,
                        ephemeral: true
                    });
                } else {
                    await interaction.reply({
                        content: `❌ Erro ao alterar estado da issue ${issueId}`,
                        ephemeral: true
                    });
                }
            }
        }
        
    } catch (error) {
        console.error('Erro ao processar interação:', error);
        await interaction.reply({
            content: '❌ Erro interno do bot',
            ephemeral: true
        });
    }
});

// Webhook endpoint
app.post('/webhook', async (req, res) => {
    try {
        const data = req.body;
        console.log('Webhook recebido:', JSON.stringify(data, null, 2));
        
        const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
        
        // Criar embed
        const embed = new EmbedBuilder()
            .setTitle(data.title)
            .setURL(data.url)
            .setDescription(data.description)
            .setColor(data.statusChange === 'created' ? 0x00ff00 : 0x0099ff)
            .setTimestamp()
            .setFooter({ text: `Por ${data.userVisibleName}` });
        
        // Adicionar campos
        if (data.fields && data.fields.length > 0) {
            data.fields.forEach(field => {
                embed.addFields({
                    name: field.title,
                    value: field.value,
                    inline: true
                });
            });
        }
        
        // Criar botões
        const assignButton = new ButtonBuilder()
            .setCustomId(`assign_${data.issueId}`)
            .setLabel('Atribuir para mim')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('👤');
        
        const stateButton = new ButtonBuilder()
            .setCustomId(`states_${data.issueId}`)
            .setLabel('Alterar Estado')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🔄');
        
        const row = new ActionRowBuilder()
            .addComponents(assignButton, stateButton);
        
        await channel.send({
            embeds: [embed],
            components: [row]
        });
        
        res.status(200).json({ success: true });
        
    } catch (error) {
        console.error('Erro no webhook:', error);
        res.status(500).json({ error: 'Erro interno' });
    }
});

// Inicializar bot e servidor
client.login(DISCORD_BOT_TOKEN);

app.listen(WEBHOOK_PORT, () => {
    console.log(`Servidor webhook rodando na porta ${WEBHOOK_PORT}`);
});

// Tratamento de erros não capturados
process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', error => {
    console.error('Uncaught exception:', error);
    process.exit(1);
});