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
const YOUTRACK_BASE_URL = 'https://braiphub.youtrack.cloud/issues';

const approvalChannelId = '1402836514165231797';

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

    async getIssuesWithFilters(query, fields = 'id,idReadable,summary,created,updated,resolved,reporter(login,name),updater(login,name),state(name),type(name),priority(name),customFields(name,value(name,login))') {
        try {
            console.log(`🔍 Executando query YouTrack: ${query}`);
            const response = await axios.get(`${this.youtrackUrl}/api/issues`, {
                headers: this.headers,
                params: {
                    query: query,
                    fields: fields,
                    '$top': 1000
                }
            });
            console.log(`✅ Query retornou ${(response.data || []).length} issues`);
            
            if (response.data && response.data.length > 0) {
                const sample = response.data[0];
                console.log(`📋 Estrutura da primeira issue:`, {
                    id: sample.id,
                    reporter: sample.reporter?.login,
                    assignee_custom: sample.customFields?.find(f => f.name === 'Assignee')?.value,
                    updater: sample.updater?.login,
                    state: sample.state?.name
                });
            }
            
            return response.data || [];
        } catch (error) {
            console.error('❌ Erro ao buscar issues:', error.response?.data || error.message);
            console.log(`💥 Query que falhou: ${query}`);
            return [];
        }
    }

    async getDailyMetrics(projectId = null) {
        console.log(`📊 Gerando métricas diárias para projeto: ${projectId || 'todos'}`);
        
        const baseQuery = projectId ? `project: {${projectId}}` : '';
        
        const [createdToday, resolvedToday, totalOpen, inProgress, staleIssues] = await Promise.all([
            this.getIssuesWithFilters(`${baseQuery} created: Today`),
            this.getResolvedIssuesToday(baseQuery),
            this.getIssuesWithFilters(`${baseQuery} #Unresolved`),
            this.getIssuesWithFilters(`${baseQuery} #Unresolved`),
            this.getIssuesWithFilters(`${baseQuery} updated: * .. {minus 7d} #Unresolved`)
        ]);

        const userMetrics = this.analyzeByUser(createdToday, resolvedToday);
        console.log(`👥 UserMetrics geradas para daily: ${userMetrics.length} usuários`);

        return {
            createdToday: createdToday.length,
            resolvedToday: resolvedToday.length,
            totalOpen: totalOpen.length,
            inProgress: inProgress.length,
            staleIssues: staleIssues.length,
            netChange: createdToday.length - resolvedToday.length,
            userMetrics: userMetrics,
            issues: {
                created: createdToday,
                resolved: resolvedToday,
                open: totalOpen,
                stale: staleIssues
            }
        };
    }

    async getResolvedIssuesToday(baseQuery) {
        const approaches = [
            `${baseQuery} resolved date: Today`,
            `${baseQuery} #Resolved updated: Today`
        ];

        for (const query of approaches) {
            try {
                const result = await this.getIssuesWithFilters(query);
                if (result.length > 0) {
                    console.log(`✅ Query de issues resolvidas hoje funcionou: ${query} (${result.length} issues)`);
                    return result;
                }
            } catch (error) {
                console.log(`❌ Query falhou: ${query}`);
                continue;
            }
        }
        return [];
    }

    async getWeeklyMetrics(projectId = null) {
        const baseQuery = projectId ? `project: {${projectId}}` : '';
        
        const [thisWeekCreated, thisWeekResolved, lastWeekCreated, lastWeekResolved, staleIssues] = await Promise.all([
            this.getIssuesWithFilters(`${baseQuery} created: {This week}`),
            this.getResolvedIssuesThisWeek(baseQuery),
            this.getIssuesWithFilters(`${baseQuery} created: {Last week}`),
            this.getResolvedIssuesLastWeek(baseQuery),
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

    async getResolvedIssuesThisWeek(baseQuery) {
        const approaches = [
            `${baseQuery} resolved date: {This week}`,
            `${baseQuery} #Resolved updated: {This week}`,
        ];

        for (const query of approaches) {
            try {
                const result = await this.getIssuesWithFilters(query);
                if (result.length > 0) {
                    return result;
                }
            } catch (error) {
                continue;
            }
        }
        return [];
    }

    async getResolvedIssuesLastWeek(baseQuery) {
        const approaches = [
            `${baseQuery} resolved date: {Last week}`,
            `${baseQuery} #Resolved updated: {Last week}`,
        ];

        for (const query of approaches) {
            try {
                const result = await this.getIssuesWithFilters(query);
                if (result.length > 0) {
                    return result;
                }
            } catch (error) {
                continue;
            }
        }
        return [];
    }

    analyzeByUser(createdIssues, resolvedIssues) {
        const users = new Map();
        
        createdIssues.forEach(issue => {
            if (issue.reporter?.login) {
                const login = issue.reporter.login;
                if (!users.has(login)) {
                    users.set(login, { name: issue.reporter.name || issue.reporter.login, created: 0, resolved: 0 });
                }
                users.get(login).created++;
            }
        });
        
        resolvedIssues.forEach(issue => {
            const assigneeField = issue.customFields?.find(field => field.name === 'Assignee');
            
            if (assigneeField?.value?.length > 0) {
                assigneeField.value.forEach(assignee => {
                    if (assignee?.login) {
                        const login = assignee.login;
                        if (!users.has(login)) {
                            users.set(login, { name: assignee.name || assignee.login, created: 0, resolved: 0 });
                        }
                        users.get(login).resolved++;
                    }
                });
            }
        });
        
        const result = Array.from(users.entries()).map(([login, data]) => ({
            login,
            name: data.name,
            created: data.created,
            resolved: data.resolved,
            productivity: data.resolved - data.created
        }));
        
        return result;
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

        const netChangeEmoji = metrics.netChange > 0 ? emojis.trend_up : 
                             metrics.netChange < 0 ? emojis.trend_down : '➖';
        const netChangeText = metrics.netChange > 0 ? `+${metrics.netChange} (criou mais que resolveu)` :
                             metrics.netChange < 0 ? `${metrics.netChange} (resolveu mais que criou)` :
                             '0 (equilíbrio)';

        embed.addFields({
            name: `${emojis.clock} Saldo Líquido`,
            value: `${netChangeEmoji} **${netChangeText}**`,
            inline: true
        });

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

        const comparisonValue = [
            `${emojis.issue} **Semana passada - Criadas:** ${metrics.lastWeek.created}`,
            `${emojis.done} **Semana passada - Resolvidas:** ${metrics.lastWeek.resolved}`
        ].join('\n');

        embed.addFields({
            name: `${emojis.calendar} Comparação`,
            value: comparisonValue,
            inline: true
        });

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

        const userDetails = (Array.isArray(userMetrics) ? userMetrics : [])
            .sort((a, b) => b.resolved - a.resolved)
            .map(user => {
                return [
                    `**${user.name}**`,
                    `${emojis.issue} Criadas: ${user.created}`,
                    `${emojis.done} Resolvidas: ${user.resolved}`
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
    
    generateReport(type, metrics, projectName) {
        const template = this.templates.get(type);
        if (!template) {
            throw new Error(`Template '${type}' não encontrado`);
        }
        
        switch(type) {
            case 'daily':
            case 'weekly':
                return template(metrics, projectName);
            case 'user_detail':
                return template(metrics.userMetrics, projectName);
            default:
                throw new Error(`Template '${type}' não suportado`);
        }
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
        console.log(`📊 Gerando relatório diário para projeto: ${projectId || 'todos'}`);
        
        const cacheKey = this.cache.getCacheKey('daily', projectId);
        let metrics = this.cache.get(cacheKey);
        
        if (!metrics) {
            console.log(`🔄 Cache não encontrado, gerando métricas...`);
            metrics = await this.engine.getDailyMetrics(projectId);
            this.cache.set(cacheKey, metrics);
            console.log(`💾 Métricas salvas no cache com chave: ${cacheKey}`);
        } else {
            console.log(`⚡ Usando métricas do cache`);
        }
        
        const projectName = projectId || 'Todos os Projetos';
        const embed = this.templates.generateReport('daily', metrics, projectName);
        
        const staleIssuesQuery = `updated: * .. {minus 7d} #Unresolved`;
        const encodedStaleQuery = encodeURIComponent(staleIssuesQuery);
        const staleUrl = `${YOUTRACK_BASE_URL}?q=${encodedStaleQuery}`;
        
        const buttons = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`report_drill_users_daily`)
                    .setLabel('📂 Ver por Usuário')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setLabel('⚠️ Issues Antigas')
                    .setStyle(ButtonStyle.Link)
                    .setURL(staleUrl)
                    .setDisabled(metrics.staleIssues === 0)
            );

        return { embed, components: [buttons], metrics };
    }

    async generateWeeklyReport(projectId = null) {
        console.log(`📊 Gerando relatório semanal para projeto: ${projectId || 'todos'}`);
        
        const cacheKey = this.cache.getCacheKey('weekly', projectId);
        let metrics = this.cache.get(cacheKey);
        
        if (!metrics) {
            console.log(`🔄 Cache não encontrado, gerando métricas...`);
            metrics = await this.engine.getWeeklyMetrics(projectId);
            this.cache.set(cacheKey, metrics);
            console.log(`💾 Métricas salvas no cache com chave: ${cacheKey}`);
        } else {
            console.log(`⚡ Usando métricas do cache`);
        }
        
        const projectName = projectId || 'Todos os Projetos';
        const embed = this.templates.generateReport('weekly', metrics, projectName);

        const staleIssuesQuery = `updated: * .. {minus 1w} #Unresolved`;
        const encodedStaleQuery = encodeURIComponent(staleIssuesQuery);
        const staleUrl = `${YOUTRACK_BASE_URL}?q=${encodedStaleQuery}`;
        
        const buttons = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`report_drill_users_weekly`)
                    .setLabel('👥 Ver por Usuário')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setLabel('⚠️ Issues Antigas')
                    .setStyle(ButtonStyle.Link)
                    .setURL(staleUrl)
                    .setDisabled(metrics.staleIssues === 0)
            );

        return { embed, components: [buttons], metrics };
    }
}

let reportSystem;

const WORK_TYPE_IDS = {
    'Desenvolvimento': '147-0',
    'Teste': '147-1',
    'Documentação': '147-2',
    'Investigação': '147-3',
    'Implementação': '147-4',
    'Revisão': '147-5',
    'Correção': '147-8',
    'Reunião': '147-9',
    'Planejamento': '147-10',
    'Estudo': '147-11',
    'Prototipagem': '147-12',
    'Suporte': '147-14',
};

function convertDurationToMinutes(durationString) {
    let totalMinutes = 0;
    const isNegative = durationString.startsWith('-');
    const cleanString = isNegative ? durationString.substring(1) : durationString;

    const hoursMatch = cleanString.match(/(\d+)h/);
    if (hoursMatch) {
        totalMinutes += parseInt(hoursMatch[1]) * 60;
    }

    const minutesMatch = cleanString.match(/(\d+)m/);
    if (minutesMatch) {
        totalMinutes += parseInt(minutesMatch[1]);
    }

    return isNegative ? -totalMinutes : totalMinutes;
}

async function getProjectStates(projectId) {
    if (projectStatesCache.has(projectId)) {
        return projectStatesCache.get(projectId);
    }
    try {
        const projectFieldsResponse = await axios.get(
            `${YOUTRACK_URL}/api/admin/projects/${projectId}/customFields?fields=id,field(name),$type`,
            {
                headers: { Authorization: `Bearer ${YOUTRACK_TOKEN}`, 'Content-Type': 'application/json' }
            }
        );
        const customFields = projectFieldsResponse.data;
        const stateField = customFields.find(field => 
            field.field.name === 'State' && field.$type === 'StateProjectCustomField'
        );
        if (!stateField) {
            return [];
        }
        const bundleValuesResponse = await axios.get(
            `${YOUTRACK_URL}/api/admin/projects/${projectId}/customFields/${stateField.id}/bundle/values?fields=id,name,isResolved,ordinal`,
            {
                headers: { Authorization: `Bearer ${YOUTRACK_TOKEN}`, 'Content-Type': 'application/json' }
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

async function assignIssue(issueId, userLogin) {
    try {
        const commandPayload = {
            query: `Assignee ${userLogin}`,
            issues: [{ idReadable: issueId }]
        };
        await axios.post(`${YOUTRACK_URL}/api/commands`, commandPayload, {
            headers: { Authorization: `Bearer ${YOUTRACK_TOKEN}`, 'Content-Type': 'application/json' }
        });
        return true;
    } catch (error) {
        try {
            await axios.post(`${YOUTRACK_URL}/api/issues/${issueId}`, {
                customFields: [{
                    name: 'Assignee',
                    '$type': 'SingleUserIssueCustomField',
                    value: { login: userLogin }
                }]
            }, {
                headers: { Authorization: `Bearer ${YOUTRACK_TOKEN}`, 'Content-Type': 'application/json' }
            });
            return true;
        } catch (fallbackError) {
            console.error('Erro ao atribuir issue (ambos métodos falharam):', fallbackError.response?.data || fallbackError.message);
            return false;
        }
    }
}

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
            headers: { Authorization: `Bearer ${YOUTRACK_TOKEN}`, 'Content-Type': 'application/json' }
        });
        return true;
    } catch (error) {
        console.error('Erro ao alterar estado:', error.response?.data || error.message);
        return false;
    }
}

async function addCommentToIssue(issueId, comment, authorName) {
    try {
        let internalId = issueId;
        if (!/^\d+-\d+$/.test(issueId)) {
            try {
                const resolveResponse = await axios.get(
                    `${YOUTRACK_URL}/api/issues/${issueId}?fields=id`,
                    { headers: { Authorization: `Bearer ${YOUTRACK_TOKEN}`, 'Content-Type': 'application/json' } }
                );
                internalId = resolveResponse.data.id;
            } catch (resolveError) {
                console.log(`Não foi possível resolver ID ${issueId}, usando original`);
            }
        }
        const payload = {
            text: `${comment}\n\n*— ${authorName}*`,
            visibility: { "$type": "UnlimitedVisibility" }
        };
        const response = await axios.post(
            `${YOUTRACK_URL}/api/issues/${internalId}/comments`,
            payload,
            { headers: { Authorization: `Bearer ${YOUTRACK_TOKEN}`, 'Content-Type': 'application/json', 'Accept': 'application/json' } }
        );
        return { success: true, commentId: response.data.id, method: 'REST' };
    } catch (error) {
        try {
            const commandPayload = {
                query: "",
                comment: `${comment}\n\n*— ${authorName}*`,
                issues: [{ idReadable: issueId }]
            };
            const commandResponse = await axios.post(
                `${YOUTRACK_URL}/api/commands`,
                commandPayload,
                { headers: { Authorization: `Bearer ${YOUTRACK_TOKEN}`, 'Content-Type': 'application/json' } }
            );
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

async function logWorkItemTime(issueId, minutes, comment, userLogin, workTypeId) {
    try {
        const payload = {
            date: Date.now(), 
            duration: {
                minutes: minutes
            },
            text: comment,
            author: { 
                login: userLogin 
            }
        };

        if (workTypeId) {
            payload.type = {
                id: workTypeId 
            };
        }
        
        await axios.post(`${YOUTRACK_URL}/api/issues/${issueId}/timeTracking/workItems`, payload, {
            headers: {
                Authorization: `Bearer ${YOUTRACK_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        
        return { success: true };
    } catch (error) {
        console.error(`Erro ao registrar tempo na issue ${issueId}:`, error.response?.data || error.message);
        return { success: false, error: error.response?.data?.error || error.message };
    }
}

client.once('ready', async () => {
    console.log(`Bot Discord conectado como: ${client.user.tag}`);
    reportSystem = new YouTrackReportSystem(YOUTRACK_URL, YOUTRACK_TOKEN);
});

const WORK_TYPES = [
    { label: 'Desenvolvimento', value: 'Desenvolvimento' },
    { label: 'Revisão', value: 'Revisão' },
    { label: 'Correção', value: 'Correção' },
    { label: 'Teste', value: 'Teste' },
    { label: 'Documentação', value: 'Documentação' },
    { label: 'Investigação', value: 'Investigação' },
    { label: 'Implementação', value: 'Implementação' },
    { label: 'Reunião', value: 'Reunião' },
    { label: 'Planejamento', value: 'Planejamento' },
    { label: 'Estudo', value: 'Estudo' },
    { label: 'Prototipagem', value: 'Prototipagem' },
    { label: 'Suporte', value: 'Suporte' },
];

client.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'youtrack') {
            if (interaction.options.getSubcommand() === 'report') {
                await handleReportCommand(interaction);
                return;
            }
            // NOVO: Handler para o comando 'adicionar_tempo'
            if (interaction.options.getSubcommand() === 'adicionar_tempo') {
                const selectMenu = new StringSelectMenuBuilder()
                    .setCustomId(`work_type_select_adicionar_${interaction.user.id}`)
                    .setPlaceholder('Selecione o tipo de trabalho')
                    .addOptions(WORK_TYPES);

                const row = new ActionRowBuilder().addComponents(selectMenu);
                
                await interaction.reply({
                    content: 'Por favor, selecione o tipo de trabalho para a sua solicitação de tempo:',
                    components: [row],
                    ephemeral: true
                });
                return;
            }
            // NOVO: Handler para o comando 'subtrair_tempo'
            if (interaction.options.getSubcommand() === 'subtrair_tempo') {
                const selectMenu = new StringSelectMenuBuilder()
                    .setCustomId(`work_type_select_subtrair_${interaction.user.id}`)
                    .setPlaceholder('Selecione o tipo de trabalho')
                    .addOptions(WORK_TYPES);

                const row = new ActionRowBuilder().addComponents(selectMenu);
                
                await interaction.reply({
                    content: 'Por favor, selecione o tipo de trabalho para a sua solicitação de correção:',
                    components: [row],
                    ephemeral: true
                });
                return;
            }
        }
    }
    
    if (interaction.isButton()) {
        if (interaction.customId.startsWith('report_drill_')) {
            await handleReportDrillDown(interaction);
            return;
        }

        if (interaction.customId.startsWith('aprovar_') || interaction.customId.startsWith('rejeitar_')) {
            await handleTimeApproval(interaction);
            return;
        }
    }
    
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('work_type_select_')) {
        const parts = interaction.customId.split('_');
        const action = parts[2]; // 'adicionar' ou 'subtrair'
        const selectedWorkType = interaction.values[0];
        const userId = parts[3];

        const modal = new ModalBuilder()
            .setCustomId(`ajuste_modal_${action}_${userId}_${selectedWorkType.replace(/\s/g, '_')}`)
            .setTitle(`${action === 'adicionar' ? 'Adicionar' : 'Corrigir'} Tempo: ${selectedWorkType}`);

        const issueIdInput = new TextInputBuilder()
            .setCustomId('issueIdInput')
            .setLabel('ID da Issue (Ex: PROJ-123)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const timeInput = new TextInputBuilder()
            .setCustomId('timeInput')
            .setLabel('Tempo a ser ajustado (Ex: 3h, 1h30m, 30m)')
            .setPlaceholder(action === 'subtrair' ? 'Ex: 1h30m' : 'Ex: 3h, 1h30m')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const reasonInput = new TextInputBuilder()
            .setCustomId('reasonInput')
            .setLabel('Motivo da solicitação')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true);

        const firstActionRow = new ActionRowBuilder().addComponents(issueIdInput);
        const secondActionRow = new ActionRowBuilder().addComponents(timeInput);
        const thirdActionRow = new ActionRowBuilder().addComponents(reasonInput);

        modal.addComponents(firstActionRow, secondActionRow, thirdActionRow);

        await interaction.showModal(modal);
        return;
    }

    if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;

    try {
        if (interaction.isModalSubmit()) {
            if (interaction.customId.startsWith('ajuste_modal_')) {
                await handleTimeRequestModal(interaction);
                return;
            }
            
            if (interaction.customId.startsWith('comment_modal_')) {
                const issueId = interaction.customId.replace('comment_modal_', '');
                const commentText = interaction.fields.getTextInputValue('comment_input');
                const authorName = `${interaction.user.globalName || interaction.user.username} (via Discord)`;
                
                const result = await addCommentToIssue(issueId, commentText, authorName);
                
                if (result.success) {
                    await interaction.reply({ content: `✅ Comentário adicionado à issue ${issueId}!`, flags: 64 });
                } else {
                    await interaction.reply({ content: `❌ Erro ao adicionar comentário: ${result.error}`, flags: 64 });
                }
                return;
            }
        }
        
        let issueId;
        if (interaction.isButton() || interaction.isStringSelectMenu()) {
            const parts = interaction.customId.split('_');
            if (parts.length >= 2) {
                issueId = parts[1];
            } else {
                return;
            }
        }
        
        if (interaction.isButton()) {
            const action = interaction.customId.split('_')[0];
            
            if (action === 'assign') {
                const discordUserId = interaction.user.id;
                const youtrackLogin = userMap[discordUserId];
                if (!youtrackLogin) {
                    await interaction.reply({ content: '❌ Usuário não mapeado. Configure o userMap.json', flags: 64 });
                    return;
                }
                const success = await assignIssue(issueId, youtrackLogin);
                if (success) {
                    await interaction.reply({ content: `✅ Issue ${issueId} atribuída para você!`, flags: 64 });
                } else {
                    await interaction.reply({ content: `❌ Erro ao atribuir issue ${issueId}`, flags: 64 });
                }
            } else if (action === 'states') {
                try {
                    const issueResponse = await axios.get(`${YOUTRACK_URL}/api/issues/${issueId}?fields=project(id)`, {
                        headers: { Authorization: `Bearer ${YOUTRACK_TOKEN}`, 'Content-Type': 'application/json' }
                    });
                    const projectId = issueResponse.data.project.id;
                    const states = await getProjectStates(projectId);
                    if (states.length === 0) {
                        await interaction.reply({ content: '❌ Não foi possível obter os estados disponíveis', flags: 64 });
                        return;
                    }
                    const limitedStates = states.slice(0, 25);
                    const selectMenu = new StringSelectMenuBuilder()
                        .setCustomId(`state_${issueId}`)
                        .setPlaceholder('Selecione o novo estado')
                        .addOptions(limitedStates.map(state => ({ label: state.name, value: state.id, description: state.isResolved ? 'Estado resolvido' : 'Estado ativo' })));
                    const row = new ActionRowBuilder().addComponents(selectMenu);
                    await interaction.reply({ content: `Escolha o novo estado para ${issueId}:`, components: [row], flags: 64 });
                } catch (error) {
                    await interaction.reply({ content: '❌ Erro ao buscar estados disponíveis', flags: 64 });
                }
            } else if (action === 'comment') {
                const modal = new ModalBuilder().setCustomId(`comment_modal_${issueId}`).setTitle(`Comentar na Issue ${issueId}`);
                const commentInput = new TextInputBuilder().setCustomId('comment_input').setLabel('Seu comentário').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000);
                const actionRow = new ActionRowBuilder().addComponents(commentInput);
                modal.addComponents(actionRow);
                await interaction.showModal(modal);
            } else if (action === 'quick') {
                const templateKey = interaction.customId.split('_')[2];
                const template = COMMENT_TEMPLATES[templateKey];
                if (!template) {
                    await interaction.reply({ content: '❌ Template de comentário não encontrado', flags: 64 });
                    return;
                }
                const authorName = `${interaction.user.globalName || interaction.user.username} (via Discord)`;
                const result = await addCommentToIssue(issueId, template.text, authorName);
                if (result.success) {
                    await interaction.reply({ content: `${template.emoji} Comentário "${templateKey}" adicionado à issue ${issueId}!`, flags: 64 });
                } else {
                    await interaction.reply({ content: `❌ Erro ao adicionar comentário: ${result.error}`, flags: 64 });
                }
            } else if (action === 'templates') {
                const templateButtons = Object.keys(COMMENT_TEMPLATES).slice(0, 5).map(key => {
                    const template = COMMENT_TEMPLATES[key];
                    return new ButtonBuilder().setCustomId(`quick_${issueId}_${key}`).setLabel(key.replace('_', ' ').toUpperCase()).setStyle(ButtonStyle.Secondary).setEmoji(template.emoji);
                });
                const rows = [];
                for (let i = 0; i < templateButtons.length; i += 5) {
                    rows.push(new ActionRowBuilder().addComponents(templateButtons.slice(i, i + 5)));
                }
                await interaction.reply({ content: `Escolha um comentário rápido para ${issueId}:`, components: rows, flags: 64 });
            }
        }
        
        if (interaction.isStringSelectMenu()) {
            const action = interaction.customId.split('_')[0];
            if (action === 'state') {
                const selectedStateId = interaction.values[0];
                const success = await changeIssueState(issueId, selectedStateId);
                if (success) {
                    await interaction.reply({ content: `✅ Estado da issue ${issueId} alterado com sucesso!`, flags: 64 });
                } else {
                    await interaction.reply({ content: `❌ Erro ao alterar estado da issue ${issueId}`, flags: 64 });
                }
            }
        }
    } catch (error) {
        console.error('Erro ao processar interação:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '❌ Erro interno do bot', flags: 64 });
        }
    }
});

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
        
        await interaction.editReply({ embeds: [result.embed], components: result.components });
    } catch (error) {
        console.error('Erro ao gerar relatório:', error);
        await interaction.editReply('❌ Erro ao gerar relatório. Tente novamente.');
    }
}

async function handleReportDrillDown(interaction) {
    await interaction.deferReply({ flags: 64 });
    try {
        const parts = interaction.customId.split('_');
        const action = parts[2];
        const period = parts[3];
        
        if (action === 'users') {
            const cacheKey = reportSystem.cache.getCacheKey(period, null);
            const cachedMetrics = reportSystem.cache.get(cacheKey);
            if (cachedMetrics?.userMetrics?.length > 0) {
                const embed = reportSystem.templates.generateReport('user_detail', cachedMetrics, period);
                await interaction.editReply({ embeds: [embed] });
            } else {
                await interaction.editReply(`❌ Não há dados de usuários para o período ${period}.`);
            }
        } else {
            await interaction.editReply('❌ Ação de drill-down não reconhecida.');
        }
    } catch (error) {
        console.error('❌ Erro no drill-down:', error);
        await interaction.editReply('❌ Erro ao carregar detalhes');
    }
}

async function handleTimeRequestModal(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const parts = interaction.customId.split('_');
    const issueId = interaction.fields.getTextInputValue('issueIdInput');
    const time = interaction.fields.getTextInputValue('timeInput');
    const reason = interaction.fields.getTextInputValue('reasonInput');
    const action = parts[2]; // 'adicionar' ou 'subtrair'
    const requesterId = parts[3];
    const workType = parts.length > 4 ? parts.slice(4).join(' ') : null;

    const requester = client.users.cache.get(requesterId);
    const approvalChannel = client.channels.cache.get(approvalChannelId);

    if (!approvalChannel) {
        await interaction.editReply('❌ Erro: Canal de aprovação não encontrado. Verifique a configuração.');
        return;
    }

    const embed = new EmbedBuilder()
        .setTitle(`🕒 Solicitação de Ajuste de Tempo para ${issueId}`)
        .setDescription(`**Usuário:** ${requester.username}\n**Ação:** ${action}\n**Tempo:** ${time}\n**Tipo de Trabalho:** ${workType}\n**Motivo:**\n${reason}`)
        .setColor(action === 'adicionar' ? 0x00ff00 : 0xff0000)
        .setTimestamp();

    const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`aprovar_${issueId}_${time}_${requesterId}_${workType.replace(/\s/g, '_')}_${action}`)
            .setLabel('Aprovar')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`rejeitar_${issueId}_${time}_${requesterId}_${workType.replace(/\s/g, '_')}_${action}`)
            .setLabel('Rejeitar')
            .setStyle(ButtonStyle.Danger)
    );

    await approvalChannel.send({ embeds: [embed], components: [buttons] });
    await interaction.editReply('✅ Sua solicitação foi enviada para aprovação.');
    return;
}

async function handleTimeApproval(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const parts = interaction.customId.split('_');
    const action = parts[0];
    const issueId = parts[1];
    const timeString = parts[2];
    const requesterId = parts[3];
    const workType = parts.length > 5 ? parts.slice(4, -1).join(' ') : null;
    const timeAction = parts[parts.length - 1]; // 'adicionar' ou 'subtrair'
    const approver = interaction.user;
    
    const requester = client.users.cache.get(requesterId);
    
    const newEmbed = EmbedBuilder.from(interaction.message.embeds[0]);

    if (action === 'aprovar') {
        const requesterYouTrackLogin = userMap[requesterId];
        
        if (!requesterYouTrackLogin) {
            newEmbed.setColor(0xff0000).setFooter({ text: `Falha na aprovação. Usuário não mapeado.` });
            await interaction.message.edit({ embeds: [newEmbed], components: [] });
            await interaction.editReply(`❌ Erro: O usuário solicitante não está mapeado no userMap.json.`);
            return;
        }
        
        const workTypeId = WORK_TYPE_IDS[workType];
        
        if (!workTypeId) {
            newEmbed.setColor(0xff0000).setFooter({ text: `Falha na aprovação. Tipo de trabalho não mapeado.` });
            await interaction.message.edit({ embeds: [newEmbed], components: [] });
            await interaction.editReply(`❌ Erro: O tipo de trabalho "${workType}" não está mapeado para um ID no código.`);
            return;
        }
        
        let minutes = convertDurationToMinutes(timeString);
        if (timeAction === 'subtrair') {
            minutes = -minutes;
        }

        const timeLogged = await logWorkItemTime(issueId, minutes, `Ajuste de tempo aprovado por: ${approver.username} (via Discord)`, requesterYouTrackLogin, workTypeId);
        
        if (timeLogged.success) {
            newEmbed.setColor(0x00ff00).setFooter({ text: `Aprovado por ${approver.username}` });
            await interaction.message.edit({ embeds: [newEmbed], components: [] });
            await interaction.editReply(`✅ Tempo de ${timeString} foi registrado na issue ${issueId} para o usuário ${requesterYouTrackLogin} como "${workType}".`);
            requester?.send(`✅ Sua solicitação de ajuste de tempo para a issue ${issueId} foi aprovada por ${approver.username} e o tempo foi registrado como "${workType}".`);
        } else {
            newEmbed.setColor(0xff0000).setFooter({ text: `Falha na aprovação. Erro: ${timeLogged.error}` });
            await interaction.message.edit({ embeds: [newEmbed], components: [] });
            await interaction.editReply(`❌ Erro ao registrar o tempo na issue ${issueId}.`);
            requester?.send(`❌ Sua solicitação de ajuste de tempo para a issue ${issueId} foi rejeitada pelo bot devido a um erro técnico. Por favor, entre em contato com o administrador.`);
        }
    } else if (action === 'rejeitar') {
        newEmbed.setColor(0xff0000).setFooter({ text: `Rejeitado por ${approver.username}` });
        await interaction.message.edit({ embeds: [newEmbed], components: [] });
        await interaction.editReply(`❌ Solicitação de ajuste de tempo para a issue ${issueId} foi rejeitada.`);
        requester?.send(`❌ Sua solicitação de ajuste de tempo para a issue ${issueId} foi rejeitada por ${approver.username}.`);
    }
}

app.post('/webhook', async (req, res) => {
    try {
        const data = req.body;
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
                embed.addFields({ name: field.title, value: field.value, inline: true });
            });
        }
        
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
        
        const row1 = new ActionRowBuilder().addComponents(assignButton, stateButton, commentButton, templatesButton);
        
        await channel.send({ embeds: [embed], components: [row1] });
        res.status(200).json({ success: true });
    } catch (error) {
        console.o.error('Erro no webhook:', error);
        res.status(500).json({ error: 'Erro interno' });
    }
});

client.login(DISCORD_BOT_TOKEN);

app.listen(WEBHOOK_PORT, () => {
    console.log(`Servidor webhook rodando na porta ${WEBHOOK_PORT}`);
});

process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', error => {
    console.error('Uncaught exception:', error);
    process.exit(1);
});