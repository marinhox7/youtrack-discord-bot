import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, SlashCommandBuilder } from 'discord.js';
import express from 'express';
import axios from 'axios';
import { config } from 'dotenv';
import fs from 'fs';

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

// ==========================================
// SISTEMA DE RELATÓRIOS
// ==========================================

const REPORT_CONFIG = {
    colors: {
        daily: 0x00ff00,      // Verde
        weekly: 0x0099ff,     // Azul  
        monthly: 0xff9900,    // Laranja
        critical: 0xff0000,   // Vermelho
        warning: 0xffff00,    // Amarelo
        success: 0x00ff00     // Verde
    },
    emojis: {
        report: '📊',
        calendar: '📅',
        user: '👤',
        issue: '🎫',
        done: '✅',
        progress: '🚧',
        blocked: '🚫',
        critical: '🔴',
        warning: '🟡',
        clock: '⏰',
        trend_up: '📈',
        trend_down: '📉',
        team: '👥',
        sprint: '🏃‍♂️'
    },
    cache: new Map(),
    cacheExpiry: 5 * 60 * 1000 // 5 minutos
};

// Dashboard Engine
class YouTrackDashboardEngine {
    constructor(youtrackUrl, token) {
        this.youtrackUrl = youtrackUrl;
        this.token = token;
        this.headers = {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        };
    }

    // CORREÇÃO: Implementação de paginação para lidar com grandes volumes de issues
    async getIssuesWithFilters(query, fields = 'id,idReadable,summary,created,updated,resolved,reporter(login,name),assignee(login,name),resolved(date,isResolved,resolvedBy(login,name))') {
        let allIssues = [];
        let skip = 0;
        const top = 100; // Tamanho do lote. 100 é um bom valor para começar.

        while (true) {
            try {
                console.log(`Executando query YouTrack (lote ${skip / top + 1}): ${query} com $skip=${skip}`);
                
                const response = await axios.get(`${this.youtrackUrl}/api/issues`, {
                    headers: this.headers,
                    params: {
                        query: query,
                        fields: fields,
                        '$top': top,
                        '$skip': skip
                    }
                });

                const issues = response.data || [];
                allIssues = allIssues.concat(issues);

                if (issues.length < top) {
                    // Se o número de issues retornadas for menor que o tamanho do lote,
                    // significa que chegamos ao fim dos dados.
                    break;
                }

                skip += top; // Prepara para o próximo lote
            } catch (error) {
                console.error('Erro ao buscar issues (com paginação):', error.response?.data || error.message);
                console.log(`Query que falhou: ${query}`);
                // Em caso de erro, retornamos o que já foi coletado
                return allIssues;
            }
        }

        console.log(`Query completa retornou ${allIssues.length} issues`);
        return allIssues;
    }

    // CORREÇÃO: Simplificado para usar a busca por data de resolução, sem múltiplas tentativas.
    async getDailyMetrics(projectId = null) {
        const baseQuery = projectId ? `project: {${projectId}}` : '';
        
        const [createdToday, resolvedToday, totalOpen, inProgress] = await Promise.all([
            this.getIssuesWithFilters(`${baseQuery} created: Today`),
            this.getIssuesWithFilters(`${baseQuery} resolved date: Today`),
            this.getIssuesWithFilters(`${baseQuery} #Unresolved`),
            this.getIssuesWithFilters(`${baseQuery} #Unresolved`)
        ]);

        const staleIssues = await this.getIssuesWithFilters(`${baseQuery} updated: * .. {minus 7d} #Unresolved`);

        return {
            createdToday: createdToday.length,
            resolvedToday: resolvedToday.length,
            totalOpen: totalOpen.length,
            inProgress: inProgress.length,
            staleIssues: staleIssues.length,
            netChange: createdToday.length - resolvedToday.length,
            issues: {
                created: createdToday,
                resolved: resolvedToday,
                open: totalOpen,
                stale: staleIssues
            }
        };
    }

    // CORREÇÃO: Simplificado para usar a busca por data de resolução, sem múltiplas tentativas.
    async getWeeklyMetrics(projectId = null) {
        const baseQuery = projectId ? `project: {${projectId}}` : '';

        const [thisWeekCreated, thisWeekResolved, lastWeekCreated, lastWeekResolved, staleIssues] = await Promise.all([
            this.getIssuesWithFilters(`${baseQuery} created: {This week}`),
            this.getIssuesWithFilters(`${baseQuery} resolved date: {This week}`),
            this.getIssuesWithFilters(`${baseQuery} created: {Last week}`),
            this.getIssuesWithFilters(`${baseQuery} resolved date: {Last week}`),
            this.getIssuesWithFilters(`${baseQuery} updated: * .. {minus 1w} #Unresolved`)
        ]);

        const userMetrics = this.analyzeByUser(thisWeekCreated, thisWeekResolved);
        
        return {
            thisWeek: {
                created: thisWeekCreated.length,
                resolved: thisWeekResolved.length
            },
            lastWeek: {
                created: lastWeekCreated.length,
                resolved: lastWeekResolved.length
            },
            staleIssues: staleIssues.length,
            userMetrics,
            trends: {
                createdTrend: this.calculateTrend(lastWeekCreated.length, thisWeekCreated.length),
                resolvedTrend: this.calculateTrend(lastWeekResolved.length, thisWeekResolved.length)
            },
            issues: {
                created: thisWeekCreated,
                resolved: thisWeekResolved,
                stale: staleIssues
            }
        };
    }

    // CORREÇÃO: Lógica de ranking otimizada para usar o assignee, conforme a regra de negócio.
    analyzeByUser(createdIssues, resolvedIssues) {
        const users = new Map();
        
        createdIssues.forEach(issue => {
            if (issue.reporter) {
                const login = issue.reporter.login;
                if (!users.has(login)) {
                    users.set(login, { name: issue.reporter.name, created: 0, resolved: 0 });
                }
                users.get(login).created++;
            }
        });
        
        resolvedIssues.forEach(issue => {
            // Agora usamos o assignee em vez do resolvedBy
            const resolver = issue.assignee;
            if (resolver) {
                const login = resolver.login;
                if (!users.has(login)) {
                    users.set(login, { name: resolver.name, created: 0, resolved: 0 });
                }
                users.get(login).resolved++;
            }
        });

        return Array.from(users.entries()).map(([login, data]) => ({
            login,
            name: data.name,
            created: data.created,
            resolved: data.resolved,
            productivity: data.resolved - data.created
        }));
    }

    calculateTrend(oldValue, newValue) {
        if (oldValue === 0) return newValue > 0 ? 'up' : 'stable';
        const change = ((newValue - oldValue) / oldValue) * 100;
        if (Math.abs(change) < 5) return 'stable';
        return change > 0 ? 'up' : 'down';
    }
}

// Template System
class ReportTemplateEngine {
    constructor() {
        this.templates = new Map();
        this.initializeTemplates();
    }

    initializeTemplates() {
        this.templates.set('daily', this.createDailyTemplate.bind(this));
        this.templates.set('weekly', this.createWeeklyTemplate.bind(this));
        this.templates.set('user_detail', this.createUserDetailTemplate.bind(this));
    }

    createDailyTemplate(metrics, projectName = 'Todos os Projetos') {
        const { emojis, colors } = REPORT_CONFIG;
        const today = new Date().toLocaleDateString('pt-BR');
        
        const embed = new EmbedBuilder()
            .setTitle(`${emojis.report} Relatório Diário - ${projectName}`)
            .setDescription(`${emojis.calendar} **${today}**`)
            .setColor(colors.daily)
            .setTimestamp();

        // KPIs principais
        const kpisValue = [
            `${emojis.issue} **Criadas hoje:** ${metrics.createdToday}`,
            `${emojis.done} **Resolvidas hoje:** ${metrics.resolvedToday}`,
            `${emojis.progress} **Em andamento:** ${metrics.inProgress}`,
            `${emojis.warning} **Total abertas:** ${metrics.totalOpen}`
        ].join('\n');

        embed.addFields({
            name: `${emojis.trend_up} KPIs do Dia`,
            value: kpisValue,
            inline: false
        });

        // Saldo líquido
        const netChangeEmoji = metrics.netChange > 0 ? emojis.trend_up : 
                              metrics.netChange < 0 ? emojis.trend_down : '➖';
        const netChangeText = metrics.netChange > 0 ? `+${metrics.netChange} (criou mais que resolveu)` :
                             metrics.netChange < 0 ? `${metrics.netChange} (resolveu mais que criou)` :
                             '0 (equilibrio)';

        embed.addFields({
            name: `${emojis.clock} Saldo Líquido`,
            value: `${netChangeEmoji} **${netChangeText}**`,
            inline: true
        });

        // Alertas
        if (metrics.staleIssues > 0) {
            embed.addFields({
                name: `${emojis.blocked} Alerta de Gargalos`,
                value: `⚠️ **${metrics.staleIssues} issues** sem atualização há +7 dias`,
                inline: true
            });
        }

        return embed;
    }

    createWeeklyTemplate(metrics, projectName = 'Todos os Projetos') {
        const { emojis, colors } = REPORT_CONFIG;
        
        const embed = new EmbedBuilder()
            .setTitle(`${emojis.sprint} Relatório Semanal - ${projectName}`)
            .setDescription(`${emojis.calendar} **Esta Semana**`)
            .setColor(colors.weekly)
            .setTimestamp();

        // Performance da semana com tendências
        const createdTrendEmoji = this.getTrendEmoji(metrics.trends.createdTrend);
        const resolvedTrendEmoji = this.getTrendEmoji(metrics.trends.resolvedTrend);
        
        const performanceValue = [
            `${emojis.issue} **Criadas:** ${metrics.thisWeek.created} ${createdTrendEmoji}`,
            `${emojis.done} **Resolvidas:** ${metrics.thisWeek.resolved} ${resolvedTrendEmoji}`,
            `${emojis.warning} **Issues antigas:** ${metrics.staleIssues} (+1 semana sem atualização)`
        ].join('\n');

        embed.addFields({
            name: `${emojis.trend_up} Performance da Semana`,
            value: performanceValue,
            inline: false
        });

        // Comparação com semana passada
        const comparisonValue = [
            `${emojis.issue} **Semana passada - Criadas:** ${metrics.lastWeek.created}`,
            `${emojis.done} **Semana passada - Resolvidas:** ${metrics.lastWeek.resolved}`
        ].join('\n');

        embed.addFields({
            name: `${emojis.calendar} Comparação`,
            value: comparisonValue,
            inline: true
        });

        // Top 5 performers com ranking
        if (metrics.userMetrics && metrics.userMetrics.length > 0) {
            const topUsers = metrics.userMetrics
                .sort((a, b) => b.resolved - a.resolved)
                .slice(0, 5)
                .map((user, index) => {
                    const medals = ['🥇', '🥈', '🥉', '🏅', '⭐'];
                    const medal = medals[index] || '👤';
                    const productivity = user.productivity > 0 ? `(+${user.productivity})` : 
                                       user.productivity < 0 ? `(${user.productivity})` : '(0)';
                    return `${medal} **${user.name}**: ${user.resolved} resolvidas ${productivity}`;
                })
                .join('\n');

            embed.addFields({
                name: `${emojis.team} Top 5 Performers`,
                value: topUsers,
                inline: false
            });
        }

        return embed;
    }

    createUserDetailTemplate(userMetrics, period = 'semanal') {
        const { emojis, colors } = REPORT_CONFIG;
        
        const embed = new EmbedBuilder()
            .setTitle(`${emojis.user} Detalhamento por Usuário - ${period}`)
            .setColor(colors.weekly)
            .setTimestamp();

        // Garantir que userMetrics seja um array antes de ordenar
        const userDetails = (Array.isArray(userMetrics) ? userMetrics : [])
            .sort((a, b) => b.productivity - a.productivity)
            .map(user => {
                const productivityEmoji = user.productivity > 0 ? emojis.trend_up :
                                        user.productivity < 0 ? emojis.trend_down : '➖';
                return [
                    `**${user.name}**`,
                    `${emojis.issue} Criadas: ${user.created}`,
                    `${emojis.done} Resolvidas: ${user.resolved}`,
                    `${productivityEmoji} Saldo: ${user.productivity > 0 ? '+' : ''}${user.productivity}`
                ].join('\n');
            })
            .join('\n\n');

        embed.setDescription(userDetails || 'Nenhum dado disponível');
        return embed;
    }

    getTrendEmoji(trend) {
        const { emojis } = REPORT_CONFIG;
        switch (trend) {
            case 'up': return emojis.trend_up;
            case 'down': return emojis.trend_down;
            default: return '➖';
        }
    }

    getWeekRange() {
        const today = new Date();
        const weekAgo = new Date(today - 7 * 24 * 60 * 60 * 1000);
        return `${weekAgo.toLocaleDateString('pt-BR')} - ${today.toLocaleDateString('pt-BR')}`;
    }

    generateReport(type, metrics, projectName) {
        const template = this.templates.get(type);
        if (!template) {
            throw new Error(`Template '${type}' não encontrado`);
        }
        return template(metrics, projectName);
    }
}

// Smart Caching
class ReportCacheManager {
    constructor() {
        this.cache = REPORT_CONFIG.cache;
        this.expiry = REPORT_CONFIG.cacheExpiry;
    }

    getCacheKey(type, projectId, additionalParams = {}) {
        const params = JSON.stringify(additionalParams);
        return `${type}_${projectId || 'all'}_${params}`;
    }

    get(key) {
        const cached = this.cache.get(key);
        if (!cached) return null;
        
        if (Date.now() - cached.timestamp > this.expiry) {
            this.cache.delete(key);
            return null;
        }
        
        return cached.data;
    }

    set(key, data) {
        this.cache.set(key, {
            data,
            timestamp: Date.now()
        });
    }
}

// Sistema Principal de Relatórios
class YouTrackReportSystem {
    constructor(youtrackUrl, token) {
        this.engine = new YouTrackDashboardEngine(youtrackUrl, token);
        this.templates = new ReportTemplateEngine();
        this.cache = new ReportCacheManager();
    }

    async generateDailyReport(projectId = null) {
        const cacheKey = this.cache.getCacheKey('daily', projectId);
        let metrics = this.cache.get(cacheKey);
        
        if (!metrics) {
            metrics = await this.engine.getDailyMetrics(projectId);
            this.cache.set(cacheKey, metrics);
        }
        
        const projectName = projectId || 'Todos os Projetos';
        const embed = this.templates.generateReport('daily', metrics, projectName);
        
        // Criar botões de interação
        const buttons = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`report_drill_users_daily`)
                    .setLabel('📂 Ver por Usuário')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(`report_drill_issues_stale`)
                    .setLabel('⚠️ Issues Antigas')
                    .setStyle(ButtonStyle.Danger)
                    .setDisabled(metrics.staleIssues === 0)
            );

        return { embed, components: [buttons], metrics };
    }

    async generateWeeklyReport(projectId = null) {
        const cacheKey = this.cache.getCacheKey('weekly', projectId);
        let metrics = this.cache.get(cacheKey);
        
        if (!metrics) {
            metrics = await this.engine.getWeeklyMetrics(projectId);
            this.cache.set(cacheKey, metrics);
        }
        
        const projectName = projectId || 'Todos os Projetos';
        const embed = this.templates.generateReport('weekly', metrics, projectName);
        
        // Criar botões de interação
        const buttons = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`report_drill_users_weekly`)
                    .setLabel('👥 Ver por Usuário')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId(`report_drill_stale_weekly`)
                    .setLabel('⚠️ Issues Antigas')
                    .setStyle(ButtonStyle.Danger)
                    .setDisabled(metrics.staleIssues === 0)
            );

        return { embed, components: [buttons], metrics };
    }

    async generateUserDetailReport(userMetrics, period) {
        const embed = this.templates.generateReport('user_detail', userMetrics, period);
        return { embed, components: [] };
    }
}

// Instância do sistema de relatórios (será inicializada após as variáveis estarem carregadas)
let reportSystem;

// ==========================================
// FUNÇÕES EXISTENTES
// ==========================================

// Função para obter estados do projeto
async function getProjectStates(projectId) {
    if (projectStatesCache.has(projectId)) {
        return projectStatesCache.get(projectId);
    }

    try {
        const projectFieldsResponse = await axios.get(
            `${YOUTRACK_URL}/api/admin/projects/${projectId}/customFields?fields=id,field(name),$type`,
            {
                headers: {
                    Authorization: `Bearer ${YOUTRACK_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        const customFields = projectFieldsResponse.data;
        const stateField = customFields.find(field => 
            field.field.name === 'State' && field.$type === 'StateProjectCustomField'
        );

        if (!stateField) {
            console.log('Campo State não encontrado no projeto');
            return [];
        }

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
client.once('ready', async () => {
    console.log(`Bot Discord conectado como: ${client.user.tag}`);
    
    // Inicializar sistema de relatórios
    reportSystem = new YouTrackReportSystem(YOUTRACK_URL, YOUTRACK_TOKEN);
    
    // Registrar comandos slash
    const commands = [
        new SlashCommandBuilder()
            .setName('youtrack')
            .setDescription('Comandos do YouTrack')
            .addSubcommand(subcommand =>
                subcommand
                    .setName('report')
                    .setDescription('Gerar relatório')
                    .addStringOption(option =>
                        option
                            .setName('tipo')
                            .setDescription('Tipo de relatório')
                            .setRequired(true)
                            .addChoices(
                                { name: '📅 Diário', value: 'daily' },
                                { name: '📊 Semanal', value: 'weekly' }
                            )
                    )
                    .addStringOption(option =>
                        option
                            .setName('projeto')
                            .setDescription('ID do projeto (opcional)')
                            .setRequired(false)
                    )
            )
    ];

    try {
        await client.application.commands.set(commands);
        console.log('Comandos slash registrados com sucesso!');
    } catch (error) {
        console.error('Erro ao registrar comandos slash:', error);
    }
});

// Event listener para interações
client.on('interactionCreate', async interaction => {
    // Handler para comandos slash
    if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'youtrack') {
            if (interaction.options.getSubcommand() === 'report') {
                await handleReportCommand(interaction);
                return;
            }
        }
    }
    
    // Handler para botões de drill-down de relatórios
    if (interaction.isButton() && interaction.customId.startsWith('report_drill_')) {
        await handleReportDrillDown(interaction);
        return;
    }
    
    // Continuar com os handlers existentes...
    if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;

    try {
        // MODAL PARA COMENTÁRIO CUSTOMIZADO
        if (interaction.isModalSubmit() && interaction.customId.startsWith('comment_modal_')) {
            const issueId = interaction.customId.replace('comment_modal_', '');
            const commentText = interaction.fields.getTextInputValue('comment_input');
            const authorName = `${interaction.user.globalName || interaction.user.username} (via Discord)`;
            
            console.log(`Processando modal de comentário para issue: ${issueId}`);
            
            const result = await addCommentToIssue(issueId, commentText, authorName);
            
            if (result.success) {
                await interaction.reply({
                    content: `✅ Comentário adicionado à issue ${issueId}!`,
                    flags: 64
                });
            } else {
                await interaction.reply({
                    content: `❌ Erro ao adicionar comentário: ${result.error}`,
                    flags: 64
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
        
        console.log(`Processando interação para issue: ${issueId}, tipo: ${interaction.customId.split('_')[0]}`);
        
        // BOTÕES
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
                    .setCustomId(`comment_modal_${issueId}`)
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
                const templateKey = interaction.customId.split('_')[2];
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
        
        // SELECT MENU PARA ESTADOS
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

// Handlers para relatórios
async function handleReportCommand(interaction) {
    await interaction.deferReply();
    
    try {
        const reportType = interaction.options.getString('tipo');
        const projectId = interaction.options.getString('projeto');
        
        let result;
        switch (reportType) {
            case 'daily':
                result = await reportSystem.generateDailyReport(projectId);
                break;
            case 'weekly':
                result = await reportSystem.generateWeeklyReport(projectId);
                break;
            default:
                await interaction.editReply('❌ Tipo de relatório não suportado');
                return;
        }
        
        await interaction.editReply({
            embeds: [result.embed],
            components: result.components
        });
        
    } catch (error) {
        console.error('Erro ao gerar relatório:', error);
        await interaction.editReply('❌ Erro ao gerar relatório. Tente novamente.');
    }
}

async function handleReportDrillDown(interaction) {
    await interaction.deferReply({ flags: 64 });
    
    try {
        const action = interaction.customId.split('_')[2];
        const period = interaction.customId.split('_')[3];
        
        if (action === 'users') {
            const cacheKey = reportSystem.cache.getCacheKey(period, null);
            const cachedMetrics = reportSystem.cache.get(cacheKey);
            
            if (cachedMetrics && cachedMetrics.userMetrics) {
                const result = await reportSystem.generateUserDetailReport(cachedMetrics.userMetrics, period);
                await interaction.editReply({
                    embeds: [result.embed],
                    components: result.components
                });
            } else {
                await interaction.editReply('❌ Dados não disponíveis. Execute o relatório principal primeiro.');
            }
        } else if (action === 'stale') {
            const cacheKey = reportSystem.cache.getCacheKey(period, null);
            const cachedMetrics = reportSystem.cache.get(cacheKey);
            
            if (cachedMetrics && cachedMetrics.issues && cachedMetrics.issues.stale) {
                const staleIssues = cachedMetrics.issues.stale;
                
                const embed = new EmbedBuilder()
                    .setTitle('⚠️ Issues Antigas - Sem Atualização há +1 Semana')
                    .setColor(REPORT_CONFIG.colors.warning)
                    .setTimestamp();

                if (staleIssues.length === 0) {
                    embed.setDescription('🎉 Nenhuma issue antiga encontrada!');
                } else {
                    const staleList = staleIssues
                        .slice(0, 20) // Limitar a 20 issues
                        .map(issue => {
                            const updatedDate = new Date(issue.updated).toLocaleDateString('pt-BR');
                            const assignee = issue.assignee ? issue.assignee.name : 'Não atribuída';
                            return `**${issue.idReadable}**: ${issue.summary}\n📅 Última atualização: ${updatedDate} | 👤 ${assignee}`;
                        })
                        .join('\n\n');

                    embed.setDescription(staleList);
                    
                    if (staleIssues.length > 20) {
                        embed.setFooter({ text: `Mostrando 20 de ${staleIssues.length} issues antigas` });
                    }
                }
                
                await interaction.editReply({
                    embeds: [embed]
                });
            } else {
                await interaction.editReply('❌ Dados de issues antigas não disponíveis.');
            }
        }
        
    } catch (error) {
        console.error('Erro no drill-down:', error);
        await interaction.editReply('❌ Erro ao carregar detalhes');
    }
}

// Webhook endpoint
app.post('/webhook', async (req, res) => {
    try {
        const data = req.body;
        console.log('Webhook recebido:', JSON.stringify(data, null, 2));
        
        const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
        
        const embed = new EmbedBuilder()
            .setTitle(data.title)
            .setURL(data.url)
            .setDescription(data.description)
            .setColor(data.statusChange === 'created' ? 0x00ff00 : 0x0099ff)
            .setTimestamp()
            .setFooter({ text: `Por ${data.userVisibleName}` });
        
        if (data.fields && data.fields.length > 0) {
            data.fields.forEach(field => {
                embed.addFields({
                    name: field.title,
                    value: field.value,
                    inline: true
                });
            });
        }
        
        // Botões com sistema de comentários
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