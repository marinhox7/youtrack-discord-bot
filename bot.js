import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, InteractionResponseType } from 'discord.js';
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

// Templates de comentários rápidos
const COMMENT_TEMPLATES = {
    'needs_info': {
        text: '❓ **Informações Adicionais Necessárias**\n\nPor favor, forneça mais detalhes sobre:\n- Passos para reproduzir\n- Comportamento esperado vs atual\n- Ambiente (browser, OS, versão)',
        emoji: '❓'
    },
    'duplicate': {
        text: '🔄 **Issue Duplicada**\n\nEsta issue parece ser duplicada. Por favor, verifique issues existentes antes de criar uma nova.',
        emoji: '🔄'
    },
    'not_bug': {
        text: '✅ **Não é um Bug**\n\nEste comportamento está funcionando conforme esperado. Para esclarecimentos sobre funcionalidades, consulte a documentação.',
        emoji: '✅'
    },
    'in_progress': {
        text: '🚧 **Em Desenvolvimento**\n\nEsta issue foi priorizada e está sendo trabalhada. Atualizações serão fornecidas conforme o progresso.',
        emoji: '🚧'
    },
    'testing': {
        text: '🧪 **Pronto para Testes**\n\nA correção foi implementada e está disponível para testes. Por favor, verifique se resolve o problema reportado.',
        emoji: '🧪'
    },
    'resolved': {
        text: '✅ **Resolvido**\n\nEsta issue foi corrigida e está disponível na versão mais recente. Obrigado pelo report!',
        emoji: '✅'
    }
};

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

// Função para adicionar comentário
// Função para adicionar comentário (SUBSTITUIR A EXISTENTE)
async function addCommentToIssue(issueId, comment, authorName) {
    try {
        // MÉTODO 1: Resolver ID legível para ID interno
        let internalId = issueId;
        
        // Se o ID não estiver no formato interno (2-42), resolver primeiro
        if (!/^\d+-\d+$/.test(issueId)) {
            try {
                const resolveResponse = await axios.get(
                    `${YOUTRACK_URL}/api/issues/${issueId}?fields=id`,
                    {
                        headers: {
                            Authorization: `Bearer ${YOUTRACK_TOKEN}`,
                            'Content-Type': 'application/json'
                        }
                    }
                );
                internalId = resolveResponse.data.id;
                console.log(`ID ${issueId} resolvido para ID interno: ${internalId}`);
            } catch (resolveError) {
                console.log(`Não foi possível resolver ID ${issueId}, usando original`);
            }
        }
        
        // Tentar adicionar comentário com ID interno
        const payload = {
            text: `${comment}\n\n*— ${authorName}*`,
            visibility: {
                "$type": "UnlimitedVisibility"
            }
        };
        
        const response = await axios.post(
            `${YOUTRACK_URL}/api/issues/${internalId}/comments`,
            payload,
            {
                headers: {
                    Authorization: `Bearer ${YOUTRACK_TOKEN}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            }
        );
        
        console.log(`Comentário adicionado à issue ${issueId} por ${authorName} (método REST)`);
        return { success: true, commentId: response.data.id, method: 'REST' };
        
    } catch (error) {
        console.error('Erro método REST, tentando Commands API:', error.response?.data || error.message);
        
        try {
            // MÉTODO 2: Commands API como fallback
            const commandPayload = {
                query: "", // Comando vazio, apenas comentário
                comment: `${comment}\n\n*— ${authorName}*`,
                issues: [{ idReadable: issueId }] // Commands API aceita ID legível
            };
            
            const commandResponse = await axios.post(
                `${YOUTRACK_URL}/api/commands`,
                commandPayload,
                {
                    headers: {
                        Authorization: `Bearer ${YOUTRACK_TOKEN}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            
            console.log(`Comentário adicionado à issue ${issueId} por ${authorName} (método Commands)`);
            return { success: true, method: 'Commands' };
            
        } catch (commandError) {
            console.error('Erro ao adicionar comentário (ambos métodos falharam):', commandError.response?.data || commandError.message);
            return { 
                success: false, 
                error: commandError.response?.data?.error_description || commandError.message 
            };
        }
    }
}
// Event listener quando o bot estiver pronto
client.once('ready', () => {
    console.log(`Bot Discord conectado como: ${client.user.tag}`);
});

// Event listener para interações
// Event listener para interações (SUBSTITUIR COMPLETAMENTE)
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;

    try {
        // ==========================================
        // MODAL PARA COMENTÁRIO CUSTOMIZADO
        // ==========================================
        if (interaction.isModalSubmit() && interaction.customId.startsWith('comment_modal_')) {
            const issueId = interaction.customId.replace('comment_modal_', ''); // FIX: Extrair ID corretamente
            const commentText = interaction.fields.getTextInputValue('comment_input');
            const authorName = `${interaction.user.globalName || interaction.user.username} (via Discord)`;
            
            console.log(`Processando modal de comentário para issue: ${issueId}`); // Debug log
            
            const result = await addCommentToIssue(issueId, commentText, authorName);
            
            if (result.success) {
                await interaction.reply({
                    content: `✅ Comentário adicionado à issue ${issueId}!`,
                    flags: 64 // EPHEMERAL flag
                });
            } else {
                await interaction.reply({
                    content: `❌ Erro ao adicionar comentário: ${result.error}`,
                    flags: 64 // EPHEMERAL flag
                });
            }
            return;
        }
        
        // Extrair issueId corretamente dos botões e select menus
        let issueId;
        if (interaction.isButton() || interaction.isStringSelectMenu()) {
            const parts = interaction.customId.split('_');
            if (parts.length >= 2) {
                issueId = parts[1];
            } else {
                console.error('CustomId malformado:', interaction.customId);
                return;
            }
        }
        
        console.log(`Processando interação para issue: ${issueId}, tipo: ${interaction.customId.split('_')[0]}`); // Debug log
        
        // ==========================================
        // BOTÕES
        // ==========================================
        if (interaction.isButton()) {
            const action = interaction.customId.split('_')[0];
            
            // BOTÃO DE ATRIBUIÇÃO
            if (action === 'assign') {
                const discordUserId = interaction.user.id;
                const youtrackLogin = userMap[discordUserId];
                
                if (!youtrackLogin) {
                    await interaction.reply({
                        content: '❌ Usuário não mapeado. Configure o userMap.json',
                        flags: 64
                    });
                    return;
                }
                
                const success = await assignIssue(issueId, youtrackLogin);
                
                if (success) {
                    await interaction.reply({
                        content: `✅ Issue ${issueId} atribuída para você!`,
                        flags: 64
                    });
                } else {
                    await interaction.reply({
                        content: `❌ Erro ao atribuir issue ${issueId}`,
                        flags: 64
                    });
                }
                
            // BOTÃO DE ESTADOS
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
                            flags: 64
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
                        flags: 64
                    });
                    
                } catch (error) {
                    console.error('Erro ao buscar estados:', error);
                    await interaction.reply({
                        content: '❌ Erro ao buscar estados disponíveis',
                        flags: 64
                    });
                }
                
            // BOTÃO DE COMENTÁRIO CUSTOMIZADO
            } else if (action === 'comment') {
                const modal = new ModalBuilder()
                    .setCustomId(`comment_modal_${issueId}`) // FIX: ID correto no modal
                    .setTitle(`Comentar na Issue ${issueId}`);

                const commentInput = new TextInputBuilder()
                    .setCustomId('comment_input')
                    .setLabel('Seu comentário')
                    .setStyle(TextInputStyle.Paragraph)
                    .setPlaceholder('Digite seu comentário aqui...')
                    .setRequired(true)
                    .setMaxLength(4000);

                const actionRow = new ActionRowBuilder().addComponents(commentInput);
                modal.addComponents(actionRow);

                await interaction.showModal(modal);
                
            // BOTÕES DE COMENTÁRIOS RÁPIDOS
            } else if (action === 'quick') {
                const templateKey = interaction.customId.split('_')[2]; // quick_issueId_templateKey
                const template = COMMENT_TEMPLATES[templateKey];
                
                if (!template) {
                    await interaction.reply({
                        content: '❌ Template de comentário não encontrado',
                        flags: 64
                    });
                    return;
                }
                
                const authorName = `${interaction.user.globalName || interaction.user.username} (via Discord)`;
                const result = await addCommentToIssue(issueId, template.text, authorName);
                
                if (result.success) {
                    await interaction.reply({
                        content: `${template.emoji} Comentário "${templateKey}" adicionado à issue ${issueId}!`,
                        flags: 64
                    });
                } else {
                    await interaction.reply({
                        content: `❌ Erro ao adicionar comentário: ${result.error}`,
                        flags: 64
                    });
                }
                
            // BOTÃO PARA MOSTRAR TEMPLATES
            } else if (action === 'templates') {
                const templateButtons = Object.keys(COMMENT_TEMPLATES).slice(0, 5).map(key => {
                    const template = COMMENT_TEMPLATES[key];
                    return new ButtonBuilder()
                        .setCustomId(`quick_${issueId}_${key}`)
                        .setLabel(key.replace('_', ' ').toUpperCase())
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji(template.emoji);
                });
                
                const rows = [];
                for (let i = 0; i < templateButtons.length; i += 5) {
                    rows.push(new ActionRowBuilder().addComponents(templateButtons.slice(i, i + 5)));
                }
                
                await interaction.reply({
                    content: `Escolha um comentário rápido para ${issueId}:`,
                    components: rows,
                    flags: 64
                });
            }
        }
        
        // ==========================================
        // SELECT MENU PARA ESTADOS
        // ==========================================
        if (interaction.isStringSelectMenu()) {
            const action = interaction.customId.split('_')[0];
            
            if (action === 'state') {
                const selectedStateId = interaction.values[0];
                const success = await changeIssueState(issueId, selectedStateId);
                
                if (success) {
                    await interaction.reply({
                        content: `✅ Estado da issue ${issueId} alterado com sucesso!`,
                        flags: 64
                    });
                } else {
                    await interaction.reply({
                        content: `❌ Erro ao alterar estado da issue ${issueId}`,
                        flags: 64
                    });
                }
            }
        }
        
    } catch (error) {
        console.error('Erro ao processar interação:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: '❌ Erro interno do bot',
                flags: 64
            });
        }
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
        
        // ==========================================
        // BOTÕES COM SISTEMA DE COMENTÁRIOS
        // ==========================================
        
        // Primeira linha: Ações principais
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
        
        const commentButton = new ButtonBuilder()
            .setCustomId(`comment_${data.issueId}`)
            .setLabel('Comentar')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('💬');
        
        const templatesButton = new ButtonBuilder()
            .setCustomId(`templates_${data.issueId}`)
            .setLabel('Comentários Rápidos')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('⚡');
        
        const row1 = new ActionRowBuilder()
            .addComponents(assignButton, stateButton, commentButton, templatesButton);
        
        await channel.send({
            embeds: [embed],
            components: [row1]
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