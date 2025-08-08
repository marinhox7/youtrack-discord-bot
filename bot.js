import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import express from 'express';
import axios from 'axios';
import { config } from 'dotenv';
import fs from 'fs';

// Carregar variáveis de ambiente
config();

const app = express();
app.use(express.json());

// Configurações / env
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const YOUTRACK_TOKEN = process.env.YOUTRACK_TOKEN;
const YOUTRACK_URL = process.env.YOUTRACK_URL; // Ex: "https://braiphub.youtrack.cloud"
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const WEBHOOK_PORT = process.env.WEBHOOK_PORT || 3000;
const YOUTRACK_BASE_URL = (process.env.YOUTRACK_BASE_URL || 'https://braiphub.youtrack.cloud/issues');

// O approvalChannelId agora busca o ID do arquivo .env para maior segurança
const approvalChannelId = process.env.DISCORD_CHANNEL_ID; 

// Inicializar cliente Discord com intents básicos necessários
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, 
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, 
    GatewayIntentBits.GuildPresences 
  ]
});

// Carregar mapeamento de usuários (Discord ID => YouTrack login)
let userMap = {};
try {
  const userMapData = fs.readFileSync('userMap.json', 'utf8');
  userMap = JSON.parse(userMapData);
} catch (error) {
  console.log('userMap.json não encontrado, criando arquivo vazio de exemplo...');
  userMap = {
    "exemplo_discord_id": "exemplo.youtrack.login"
  };
  try {
    fs.writeFileSync('userMap.json', JSON.stringify(userMap, null, 2));
  } catch (e) {
    console.error('Erro ao criar userMap.json de exemplo:', e);
  }
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
    daily: 0x00ff00,
    weekly: 0x0099ff,
    monthly: 0xff9900,
    critical: 0xff0000,
    warning: 0xffff00,
    success: 0x00ff00
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

class YouTrackDashboardEngine {
  constructor(youtrackUrl, token) {
    this.youtrackUrl = youtrackUrl;
    this.token = token;
    this.headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    };
  }

  // Busca issues com paginação robusta
  async getIssuesWithFilters(query, fields = 'id,idReadable,summary,created,updated,resolved,reporter(login,name),assignee(login,name),resolved(date,isResolved,resolvedBy(login,name))') {
    let allIssues = [];
    let skip = 0;
    const top = 100;

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

        const issues = Array.isArray(response.data) ? response.data : (response.data?.issues || []);
        allIssues = allIssues.concat(issues);

        if (issues.length < top) {
          break;
        }

        skip += top;
      } catch (error) {
        console.error('Erro ao buscar issues (com paginação):', error.response?.data || error.message);
        console.log(`Query que falhou: ${query}`);
        return allIssues;
      }
    }

    console.log(`Query completa retornou ${allIssues.length} issues`);
    return allIssues;
  }

  // Métricas diárias (versão robusta com queries básicas)
  async getDailyMetrics(projectId = null) {
    const baseQuery = projectId ? `project: {${projectId}}` : '';

    const today = new Date();
    const todayString = today.toISOString().slice(0, 10); // YYYY-MM-DD

    // Queries - adaptação simples; ajuste se sua sintaxe YouTrack for diferente
    const createdQuery = `${baseQuery} created: ${todayString}`;
    const resolvedQuery = `${baseQuery} resolved: ${todayString}`;
    const totalOpenQuery = `${baseQuery} #Unresolved`;
    const inProgressQuery = `${baseQuery} State: {In Progress}`; // ajuste se necessário
    const staleQuery = `${baseQuery} updated: *..{minus 7d} #Unresolved`;

    const [createdToday, resolvedToday, totalOpen, inProgress, staleIssues] = await Promise.all([
      this.getIssuesWithFilters(createdQuery),
      this.getIssuesWithFilters(resolvedQuery),
      this.getIssuesWithFilters(totalOpenQuery),
      this.getIssuesWithFilters(inProgressQuery),
      this.getIssuesWithFilters(staleQuery)
    ]);

    return {
      createdToday: Array.isArray(createdToday) ? createdToday : [],
      resolvedToday: Array.isArray(resolvedToday) ? resolvedToday : [],
      totalOpen: Array.isArray(totalOpen) ? totalOpen : [],
      inProgress: Array.isArray(inProgress) ? inProgress : [],
      staleIssues: Array.isArray(staleIssues) ? staleIssues : [],
      netChange: (Array.isArray(createdToday) ? createdToday.length : 0) - (Array.isArray(resolvedToday) ? resolvedToday.length : 0),
      issues: {
        created: createdToday,
        resolved: resolvedToday,
        open: totalOpen,
        stale: staleIssues
      }
    };
  }

  // Métricas semanais (exemplo com intervalo de 7 dias)
  async getWeeklyMetrics(projectId = null) {
    const baseQuery = projectId ? `project: {${projectId}}` : '';

    const today = new Date();
    const end = new Date(today);
    const startThisWeek = new Date(today);
    startThisWeek.setDate(today.getDate() - 7);
    const startLastWeek = new Date(today);
    startLastWeek.setDate(today.getDate() - 14);

    const toISO = (d) => d.toISOString().slice(0, 10);

    const thisWeekCreatedQuery = `${baseQuery} created: ${toISO(startThisWeek)}..${toISO(end)}`;
    const thisWeekResolvedQuery = `${baseQuery} resolved: ${toISO(startThisWeek)}..${toISO(end)}`;
    const lastWeekCreatedQuery = `${baseQuery} created: ${toISO(startLastWeek)}..${toISO(startThisWeek)}`;
    const lastWeekResolvedQuery = `${baseQuery} resolved: ${toISO(startLastWeek)}..${toISO(startThisWeek)}`;
    const staleQuery = `${baseQuery} updated: *..{minus 7d} #Unresolved`;

    const [thisWeekCreated, thisWeekResolved, lastWeekCreated, lastWeekResolved, staleIssues] = await Promise.all([
      this.getIssuesWithFilters(thisWeekCreatedQuery),
      this.getIssuesWithFilters(thisWeekResolvedQuery),
      this.getIssuesWithFilters(lastWeekCreatedQuery),
      this.getIssuesWithFilters(lastWeekResolvedQuery),
      this.getIssuesWithFilters(staleQuery)
    ]);

    const userMetrics = this.analyzeByUser(thisWeekCreated, thisWeekResolved);

    return {
      thisWeek: {
        created: Array.isArray(thisWeekCreated) ? thisWeekCreated.length : 0,
        resolved: Array.isArray(thisWeekResolved) ? thisWeekResolved.length : 0
      },
      lastWeek: {
        created: Array.isArray(lastWeekCreated) ? lastWeekCreated.length : 0,
        resolved: Array.isArray(lastWeekResolved) ? lastWeekResolved.length : 0
      },
      staleIssues: Array.isArray(staleIssues) ? staleIssues : [],
      userMetrics,
      trends: {
        createdTrend: this.calculateTrend(Array.isArray(lastWeekCreated) ? lastWeekCreated.length : 0, Array.isArray(thisWeekCreated) ? thisWeekCreated.length : 0),
        resolvedTrend: this.calculateTrend(Array.isArray(lastWeekResolved) ? lastWeekResolved.length : 0, Array.isArray(thisWeekResolved) ? thisWeekResolved.length : 0)
      },
      issues: {
        created: thisWeekCreated,
        resolved: thisWeekResolved,
        stale: staleIssues
      }
    };
  }

  analyzeByUser(createdIssues = [], resolvedIssues = []) {
    const users = new Map();

    (createdIssues || []).forEach(issue => {
      const reporter = issue.reporter;
      if (reporter && reporter.login) {
        const login = reporter.login;
        if (!users.has(login)) {
          users.set(login, { name: reporter.name || login, created: 0, resolved: 0 });
        }
        users.get(login).created++;
      }
    });

    (resolvedIssues || []).forEach(issue => {
      const resolver = issue.assignee;
      if (resolver && resolver.login) {
        const login = resolver.login;
        if (!users.has(login)) {
          users.set(login, { name: resolver.name || login, created: 0, resolved: 0 });
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

// Template Engine para embed de relatórios
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
      `🆕 Criadas hoje: **${metrics.createdToday.length}**`,
      `✅ Resolvidas hoje: **${metrics.resolvedToday.length}**`,
      `📂 Abertas (total): **${metrics.totalOpen.length}**`,
      `🚧 Em progresso: **${metrics.inProgress.length}**`
    ].join('\n');

    embed.addFields({ name: `${emojis.trend_up} KPIs do Dia`, value: kpisValue, inline: false });

    const netChangeEmoji = metrics.netChange > 0 ? emojis.trend_up :
      (metrics.netChange < 0 ? emojis.trend_down : '➖');
    const netChangeText = metrics.netChange > 0 ? `+${metrics.netChange} (criou mais que resolveu)` :
      (metrics.netChange < 0 ? `${metrics.netChange} (resolveu mais que criou)` : '0 (equilíbrio)');

    embed.addFields({ name: `${emojis.clock} Saldo Líquido`, value: `${netChangeEmoji} **${netChangeText}**`, inline: true });

    if (metrics.staleIssues && metrics.staleIssues.length > 0) {
      embed.addFields({ name: `${emojis.blocked} Alerta de Gargalos`, value: `⚠️ **${metrics.staleIssues.length} issues** sem atualização há +7 dias`, inline: true });
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
      `📦 Criadas esta semana: **${metrics.thisWeek.created}** ${createdTrendEmoji}`,
      `🏁 Resolvidas esta semana: **${metrics.thisWeek.resolved}** ${resolvedTrendEmoji}`
    ].join('\n');

    embed.addFields({ name: `${emojis.trend_up} Performance da Semana`, value: performanceValue, inline: false });

    const comparisonValue = [
      `⬅️ Semana anterior - Criadas: **${metrics.lastWeek.created}**, Resolvidas: **${metrics.lastWeek.resolved}**`,
      `➡️ Semana atual - Criadas: **${metrics.thisWeek.created}**, Resolvidas: **${metrics.thisWeek.resolved}**`
    ].join('\n');

    embed.addFields({ name: `${emojis.calendar} Comparação`, value: comparisonValue, inline: true });

    if (metrics.userMetrics && metrics.userMetrics.length > 0) {
      const topUsers = metrics.userMetrics
        .sort((a, b) => b.resolved - a.resolved)
        .slice(0, 5)
        .map((user, index) => {
          const medals = ['🥇', '🥈', '🥉', '🏅', '⭐'];
          const medal = medals[index] || '👤';
          const productivity = user.productivity > 0 ? `(+${user.productivity})` :
            (user.productivity < 0 ? `(${user.productivity})` : '(0)');
          return `${medal} **${user.name || user.login}**: ${user.resolved} resolvidas ${productivity}`;
        })
        .join('\n');

      embed.addFields({ name: `${emojis.team} Top 5 Performers`, value: topUsers, inline: false });
    }

    return embed;
  }

  createUserDetailTemplate(userMetrics, period = 'semanal') {
    const { emojis, colors } = REPORT_CONFIG;

    const embed = new EmbedBuilder()
      .setTitle(`${emojis.user} Detalhamento por Usuário - ${period}`)
      .setColor(colors.weekly)
      .setTimestamp();

    const arr = Array.isArray(userMetrics) ? userMetrics : [];
    const userDetails = arr
      .sort((a, b) => (b.productivity || 0) - (a.productivity || 0))
      .map(user => {
        const productivityEmoji = user.productivity > 0 ? REPORT_CONFIG.emojis.trend_up :
          (user.productivity < 0 ? REPORT_CONFIG.emojis.trend_down : '➖');
        return `${productivityEmoji} **${user.name || user.login}**\nCriadas: ${user.created || 0} | Resolvidas: ${user.resolved || 0} | Prod: ${user.productivity || 0}`;
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
    return template(metrics, projectName);
  }
}

// Cache de relatórios
class ReportCacheManager {
  constructor() {
    this.cache = REPORT_CONFIG.cache;
    this.expiry = REPORT_CONFIG.cacheExpiry;
  }

  getCacheKey(type, projectId, additionalParams = {}) {
    const params = JSON.stringify(additionalParams || {});
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
    this.cache.set(key, { data, timestamp: Date.now() });
  }
}

// Sistema principal de relatórios
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

    const staleIssuesQuery = `updated: *..{minus 7d} #Unresolved`;
    const encodedStaleQuery = encodeURIComponent(staleIssuesQuery);
    const staleUrl = `${YOUTRACK_BASE_URL}?q=${encodedStaleQuery}`;

    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`report_drill_users_daily`).setLabel('📂 Ver por Usuário').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setLabel('⚠️ Issues Antigas').setStyle(ButtonStyle.Link).setURL(staleUrl).setDisabled(metrics.staleIssues.length === 0)
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

    const staleIssuesQuery = `updated: *..{minus 1w} #Unresolved`;
    const encodedStaleQuery = encodeURIComponent(staleIssuesQuery);
    const staleUrl = `${YOUTRACK_BASE_URL}?q=${encodedStaleQuery}`;

    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`report_drill_users_weekly`).setLabel('👥 Ver por Usuário').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setLabel('⚠️ Issues Antigas').setStyle(ButtonStyle.Link).setURL(staleUrl).setDisabled(metrics.staleIssues.length === 0)
    );

    return { embed, components: [buttons], metrics };
  }
}

let reportSystem = null;

// Map de tipos de trabalho (id que você já tinha)
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
  if (!durationString || typeof durationString !== 'string') return NaN;
  let totalMinutes = 0;
  const cleanString = durationString.replace(/\s/g, '').replace('-', '');

  const hoursMatch = cleanString.match(/(\d+)h/);
  if (hoursMatch) {
    totalMinutes += parseInt(hoursMatch[1], 10) * 60;
  }

  const minutesMatch = cleanString.match(/(\d+)m/);
  if (minutesMatch) {
    totalMinutes += parseInt(minutesMatch[1], 10);
  }

  // Caso o usuário informe apenas número (ex: "90"), interpretamos como minutos
  if (!hoursMatch && !minutesMatch && /^\d+$/.test(cleanString)) {
    totalMinutes = parseInt(cleanString, 10);
  }

  return totalMinutes;
}

async function getProjectStates(projectId) {
  if (!projectId) return [];
  if (projectStatesCache.has(projectId)) {
    return projectStatesCache.get(projectId);
  }
  try {
    const projectFieldsResponse = await axios.get(`${YOUTRACK_URL}/api/admin/projects/${projectId}/customFields?fields=id,field(name),$type`, {
      headers: { Authorization: `Bearer ${YOUTRACK_TOKEN}`, 'Content-Type': 'application/json' }
    });
    const customFields = projectFieldsResponse.data || [];
    const stateField = customFields.find(field => field?.field?.name === 'State' && field.$type === 'StateProjectCustomField');
    if (!stateField) {
      return [];
    }
    const bundleValuesResponse = await axios.get(`${YOUTRACK_URL}/api/admin/projects/${projectId}/customFields/${stateField.id}/bundle/values?fields=id,name,isResolved,ordinal`, {
      headers: { Authorization: `Bearer ${YOUTRACK_TOKEN}`, 'Content-Type': 'application/json' }
    });
    const states = bundleValuesResponse.data || [];
    projectStatesCache.set(projectId, states);
    return states;
  } catch (error) {
    console.error('Erro ao obter estados do projeto:', error.response?.data || error.message);
    return [];
  }
}

async function assignIssue(issueId, userLogin) {
  try {
    // Tentar via API de comandos (se suportado)
    const commandPayload = {
      query: `Assignee ${userLogin}`,
      issues: [issueId]
    };
    await axios.post(`${YOUTRACK_URL}/api/commands`, commandPayload, {
      headers: { Authorization: `Bearer ${YOUTRACK_TOKEN}`, 'Content-Type': 'application/json' }
    });
    return true;
  } catch (error) {
    // Fallback: atualizar a issue diretamente (pode variar conforme sua instância)
    try {
      const payload = {
        customFields: [
          { name: 'Assignee', value: { login: userLogin } }
        ]
      };
      await axios.post(`${YOUTRACK_URL}/api/issues/${issueId}`, payload, {
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
      customFields: [
        { name: 'State', value: { id: stateId } }
        ]
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
    // Tenta resolver casos em que user passa id legível
    if (!/^\d+-\d+$/.test(issueId)) {
      try {
        const resolveResponse = await axios.get(`${YOUTRACK_URL}/api/issues/${encodeURIComponent(issueId)}?fields=id`, {
          headers: { Authorization: `Bearer ${YOUTRACK_TOKEN}`, 'Content-Type': 'application/json' }
        });
        if (resolveResponse.data?.id) internalId = resolveResponse.data.id;
      } catch (resolveError) {
        console.log(`Não foi possível resolver ID ${issueId}, usando original`);
      }
    }

    const payload = {
      text: `${comment}\n\n*— ${authorName}*`,
      visibility: { "$type": "UnlimitedVisibility" }
    };

    const response = await axios.post(`${YOUTRACK_URL}/api/issues/${internalId}/comments`, payload, {
      headers: { Authorization: `Bearer ${YOUTRACK_TOKEN}`, 'Content-Type': 'application/json', 'Accept': 'application/json' }
    });

    return { success: true, commentId: response.data?.id, method: 'REST' };
  } catch (error) {
    // Fallback via comandos
    try {
      const commandPayload = {
        query: "",
        comment: `${comment}\n\n*— ${authorName}*`,
        issues: [issueId]
      };
      await axios.post(`${YOUTRACK_URL}/api/commands`, commandPayload, {
        headers: { Authorization: `Bearer ${YOUTRACK_TOKEN}`, 'Content-Type': 'application/json' }
      });
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
      duration: { minutes: minutes },
      text: comment,
      author: { login: userLogin }
    };

    if (workTypeId) payload.type = { id: workTypeId };

    await axios.post(`${YOUTRACK_URL}/api/issues/${issueId}/timeTracking/workItems`, payload, {
      headers: { Authorization: `Bearer ${YOUTRACK_TOKEN}`, 'Content-Type': 'application/json' }
    });

    return { success: true };
  } catch (error) {
    console.error(`Erro ao registrar tempo na issue ${issueId}:`, error.response?.data || error.message);
    return { success: false, error: error.response?.data || error.message };
  }
}

async function findAndDeleteWorkItem(issueId, youtrackLogin, durationMinutes, workTypeName, approverUsername) {
  try {
    const response = await axios.get(`${YOUTRACK_URL}/api/issues/${issueId}/timeTracking/workItems?fields=id,author(login,name),duration(minutes,presentation),type(name)`, {
      headers: { Authorization: `Bearer ${YOUTRACK_TOKEN}`, 'Content-Type': 'application/json' }
    });
    const workItems = Array.isArray(response.data) ? response.data : [];

    console.log(`Encontrados ${workItems.length} work items para a issue ${issueId}.`);

    let foundWorkItem = null;
    for (const item of workItems) {
      const isAuthorMatch = item.author && item.author.login === youtrackLogin;
      const isDurationMatch = item.duration && item.duration.minutes === durationMinutes;
      const isTypeMatch = item.type && item.type.name === workTypeName;

      if (isAuthorMatch && isDurationMatch && isTypeMatch) {
        foundWorkItem = item;
        break;
      }
    }

    if (foundWorkItem) {
      await axios.delete(`${YOUTRACK_URL}/api/issues/${issueId}/timeTracking/workItems/${foundWorkItem.id}`, {
        headers: { Authorization: `Bearer ${YOUTRACK_TOKEN}` }
      });
      console.log(`Work item ID: ${foundWorkItem.id} excluído com sucesso da issue ${issueId}.`);

      const commentText = `AUTOMATICAMENTE REMOVIDO: O work item idêntico (ID: ${foundWorkItem.id}, ${foundWorkItem.duration?.presentation || ''} de ${foundWorkItem.type?.name || ''} por ${foundWorkItem.author?.name || foundWorkItem.author?.login}) foi excluído da issue ${issueId}. Aprovado por: ${approverUsername} (via Discord).`;
      await addCommentToIssue(issueId, commentText, 'Bot de Automação');
      return { success: true, message: `Work item ${foundWorkItem.id} excluído com sucesso.` };
    } else {
      const commentText = `ATENÇÃO: NENHUM work item idêntico (${durationMinutes / 60}h de ${workTypeName} por ${youtrackLogin}) foi encontrado na issue ${issueId} para exclusão automática. Aprovado por: ${approverUsername} (via Discord). Por favor, verifique e remova manualmente, se necessário.`;
      await addCommentToIssue(issueId, commentText, 'Bot de Automação');
      return { success: false, message: `Nenhum work item idêntico encontrado para exclusão automática.` };
    }
  } catch (error) {
    console.error(`Erro na função findAndDeleteWorkItem para issue ${issueId}:`, error.response?.data || error.message);
    const errorDetails = error.response?.data?.error || error.message;
    const commentText = `ERRO CRÍTICO NA AUTOMAÇÃO: Falha ao buscar/excluir work item idêntico para a issue ${issueId} (${durationMinutes / 60}h de ${workTypeName} por ${youtrackLogin}). Aprovado por: ${approverUsername} (via Discord). Erro: ${errorDetails}. Por favor, verifique e remova manualmente, se necessário.`;
    await addCommentToIssue(issueId, commentText, 'Bot de Automação');
    return { success: false, message: `Erro ao tentar excluir work item: ${errorDetails}` };
  }
}

// Evento ready
client.once('ready', async () => {
  console.log(`Bot Discord conectado como: ${client.user.tag}`);
  reportSystem = new YouTrackReportSystem(YOUTRACK_URL, YOUTRACK_TOKEN);
});

// Handler central de interações
client.on('interactionCreate', async (interaction) => {
  try {
    // Comandos de slash (report, adicionar_tempo, subtrair_tempo)
    if (interaction.isChatInputCommand && interaction.isChatInputCommand()) {
      const sub = interaction.options.getSubcommand();
      if (interaction.commandName === 'youtrack' && sub === 'report') {
        await handleReportCommand(interaction);
        return;
      }
      if (interaction.commandName === 'youtrack' && sub === 'adicionar_tempo') {
        const workType = interaction.options.getString('tipo_trabalho') || 'Desenvolvimento';
        const modal = new ModalBuilder()
          .setCustomId(`ajuste_modal_adicionar_${interaction.user.id}_${workType.replace(/\s/g, '_')}`)
          .setTitle(`Adicionar Tempo: ${workType}`);

        const issueIdInput = new TextInputBuilder().setCustomId('issueIdInput').setLabel('ID da Issue (Ex: PROJ-123)').setStyle(TextInputStyle.Short).setRequired(true);
        const timeInput = new TextInputBuilder().setCustomId('timeInput').setLabel('Tempo a ser ajustado (Ex: 3h, 1h30m, 30m)').setPlaceholder('Ex: 3h, 1h30m').setStyle(TextInputStyle.Short).setRequired(true);
        const reasonInput = new TextInputBuilder().setCustomId('reasonInput').setLabel('Motivo da solicitação').setStyle(TextInputStyle.Paragraph).setRequired(true);

        modal.addComponents(
          new ActionRowBuilder().addComponents(issueIdInput),
          new ActionRowBuilder().addComponents(timeInput),
          new ActionRowBuilder().addComponents(reasonInput)
        );

        await interaction.showModal(modal);
        return;
      }
      if (interaction.commandName === 'youtrack' && sub === 'subtrair_tempo') {
        const workType = interaction.options.getString('tipo_trabalho') || 'Desenvolvimento';
        const modal = new ModalBuilder()
          .setCustomId(`ajuste_modal_subtrair_${interaction.user.id}_${workType.replace(/\s/g, '_')}`)
          .setTitle(`Corrigir Tempo: ${workType}`);

        const issueIdInput = new TextInputBuilder().setCustomId('issueIdInput').setLabel('ID da Issue (Ex: PROJ-123)').setStyle(TextInputStyle.Short).setRequired(true);
        const timeInput = new TextInputBuilder().setCustomId('timeInput').setLabel('Tempo a ser ajustado (Ex: 3h, 1h30m, 30m)').setPlaceholder('Ex: 1h30m (sem o sinal de -)').setStyle(TextInputStyle.Short).setRequired(true);
        const reasonInput = new TextInputBuilder().setCustomId('reasonInput').setLabel('Motivo da solicitação').setStyle(TextInputStyle.Paragraph).setRequired(true);

        modal.addComponents(
          new ActionRowBuilder().addComponents(issueIdInput),
          new ActionRowBuilder().addComponents(timeInput),
          new ActionRowBuilder().addComponents(reasonInput)
        );

        await interaction.showModal(modal);
        return;
      }
    }

    // Botões e selects (customId parsing)
    if (interaction.isButton && (interaction.isButton() || interaction.isStringSelectMenu && interaction.isStringSelectMenu())) {
      const isButton = interaction.isButton ? interaction.isButton() : false;
      const isSelect = interaction.isStringSelectMenu ? interaction.isStringSelectMenu() : false;
      const parts = (interaction.customId || '').split('_').filter(Boolean);

      if (isButton) {
        const action = parts[0];
        // Approve/reject flow (aprovar_xyz / rejeitar_xyz)
        if (action === 'aprovar' || action === 'rejeitar') {
          await handleTimeApproval(interaction);
          return;
        }

        // Report drill buttons
        if (interaction.customId.startsWith('report_drill_')) {
          await handleReportDrillDown(interaction);
          return;
        }

        // Actions on issue message: assign, states, comment, quick, templates
        if (action === 'assign') {
          const issueId = parts[1];
          const discordUserId = interaction.user.id;
          const youtrackLogin = userMap[discordUserId];
          if (!youtrackLogin) {
            await interaction.reply({ content: '❌ Usuário não mapeado. Configure o userMap.json', ephemeral: true });
            return;
          }
          const success = await assignIssue(issueId, youtrackLogin);
          if (success) {
            await interaction.reply({ content: `✅ Issue ${issueId} atribuída para você!`, ephemeral: true });
          } else {
            await interaction.reply({ content: `❌ Erro ao atribuir issue ${issueId}`, ephemeral: true });
          }
          return;
        } else if (action === 'states') {
          try {
            const issueId = parts[1];
            const issueResponse = await axios.get(`${YOUTRACK_URL}/api/issues/${issueId}?fields=project(id)`, {
              headers: { Authorization: `Bearer ${YOUTRACK_TOKEN}`, 'Content-Type': 'application/json' }
            });
            const projectId = issueResponse.data?.project?.id;
            const states = await getProjectStates(projectId);
            if (!states || states.length === 0) {
              await interaction.reply({ content: '❌ Não foi possível obter os estados disponíveis', ephemeral: true });
              return;
            }
            const limitedStates = states.slice(0, 25);
            const selectMenu = new StringSelectMenuBuilder()
              .setCustomId(`state_${issueId}`)
              .setPlaceholder('Selecione o novo estado')
              .addOptions(limitedStates.map(state => ({
                label: state.name,
                value: state.id,
                description: state.isResolved ? 'Estado resolvido' : 'Estado ativo'
              })));

            const row = new ActionRowBuilder().addComponents(selectMenu);
            await interaction.reply({ content: `Escolha o novo estado para ${issueId}:`, components: [row], ephemeral: true });
          } catch (error) {
            console.error('Erro ao buscar estados:', error);
            await interaction.reply({ content: '❌ Erro ao buscar estados disponíveis', ephemeral: true });
          }
          return;
        } else if (action === 'comment') {
          const issueId = parts[1];
          const modal = new ModalBuilder().setCustomId(`comment_modal_${issueId}`).setTitle(`Comentar na Issue ${issueId}`);
          const commentInput = new TextInputBuilder().setCustomId('comment_input').setLabel('Seu comentário').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000);
          modal.addComponents(new ActionRowBuilder().addComponents(commentInput));
          await interaction.showModal(modal);
          return;
        } else if (action === 'quick') {
          const issueId = parts[1];
          const templateKey = parts[2];
          const template = COMMENT_TEMPLATES[templateKey];
          if (!template) {
            await interaction.reply({ content: '❌ Template de comentário não encontrado', ephemeral: true });
            return;
          }
          const authorName = `${interaction.member?.displayName || interaction.user.username} (via Discord)`;
          const result = await addCommentToIssue(issueId, template.text, authorName);
          if (result.success) {
            await interaction.reply({ content: `${template.emoji} Comentário "${templateKey}" adicionado à issue ${issueId}!`, ephemeral: true });
          } else {
            await interaction.reply({ content: `❌ Erro ao adicionar comentário: ${result.error}`, ephemeral: true });
          }
          return;
        } else if (action === 'templates') {
          const issueId = parts[1];
          const templateButtons = Object.keys(COMMENT_TEMPLATES).slice(0, 5).map((key) => {
            const template = COMMENT_TEMPLATES[key];
            return new ButtonBuilder().setCustomId(`quick_${issueId}_${key}`).setLabel(key.replace('_', ' ').toUpperCase()).setStyle(ButtonStyle.Secondary).setEmoji(template.emoji);
          });
          const rows = [];
          for (let i = 0; i < templateButtons.length; i += 5) {
            rows.push(new ActionRowBuilder().addComponents(templateButtons.slice(i, i + 5)));
          }
          await interaction.reply({ content: `Escolha um comentário rápido para ${issueId}:`, components: rows, ephemeral: true });
          return;
        }
      } // fim botão
      if (isSelect) {
        const action = parts[0];
        if (action === 'state') {
          const issueId = parts[1];
          const selectedStateId = (interaction.values && interaction.values[0]) || null;
          if (!selectedStateId) {
            await interaction.reply({ content: '❌ Nenhum estado selecionado', ephemeral: true });
            return;
          }
          const success = await changeIssueState(issueId, selectedStateId);
          if (success) {
            await interaction.reply({ content: `✅ Estado da issue ${issueId} alterado com sucesso!`, ephemeral: true });
          } else {
            await interaction.reply({ content: `❌ Erro ao alterar estado da issue ${issueId}`, ephemeral: true });
          }
          return;
        }
      }
    } // fim buttons/selects block

    // Modal submissions
    if (interaction.isModalSubmit && interaction.isModalSubmit()) {
      const custom = interaction.customId || '';
      if (custom.startsWith('ajuste_modal_')) {
        await handleTimeRequestModal(interaction);
        return;
      }

      if (custom.startsWith('comment_modal_')) {
        const issueId = custom.replace('comment_modal_', '');
        const commentText = interaction.fields.getTextInputValue('comment_input');
        const authorName = `${interaction.member?.displayName || interaction.user.username} (via Discord)`;
        const result = await addCommentToIssue(issueId, commentText, authorName);
        if (result.success) {
          await interaction.reply({ content: `✅ Comentário adicionado à issue ${issueId}!`, ephemeral: true });
        } else {
          await interaction.reply({ content: `❌ Erro ao adicionar comentário: ${result.error}`, ephemeral: true });
        }
        return;
      }
    }
  } catch (err) {
    console.error('Erro no interactionCreate:', err);
    try { if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: '❌ Ocorreu um erro ao processar sua interação.', ephemeral: true }); } catch(e){}
  }
});

async function handleReportCommand(interaction) {
  await interaction.deferReply({ ephemeral: false });
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
  await interaction.deferReply({ ephemeral: true });
  try {
    const parts = (interaction.customId || '').split('_').filter(Boolean); // ex: ['report','drill','users','daily']
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
      return;
    } else if (action === 'stale') {
      const cacheKey = reportSystem.cache.getCacheKey(period, null);
      const cachedMetrics = reportSystem.cache.get(cacheKey);
      if (cachedMetrics && cachedMetrics.issues && cachedMetrics.issues.stale) {
        const staleIssues = cachedMetrics.issues.stale;
        const embed = new EmbedBuilder().setTitle('⚠️ Issues Antigas - Sem Atualização há +1 Semana').setColor(REPORT_CONFIG.colors.warning).setTimestamp();
        if (staleIssues.length === 0) {
          embed.setDescription('🎉 Nenhuma issue antiga encontrada!');
        } else {
          const staleList = staleIssues.slice(0, 20).map(issue => {
            const updatedDate = new Date(issue.updated).toLocaleDateString('pt-BR');
            const assignee = issue.assignee ? issue.assignee.name : 'Não atribuída';
            return `**${issue.idReadable || issue.id}**: ${issue.summary || ''}\n📅 Última atualização: ${updatedDate} | 👤 ${assignee}`;
          }).join('\n\n');
          embed.setDescription(staleList);
          if (staleIssues.length > 20) embed.setFooter({ text: `Mostrando 20 de ${staleIssues.length} issues antigas` });
        }
        await interaction.editReply({ embeds: [embed] });
      } else {
        await interaction.editReply('❌ Dados de issues antigas não disponíveis.');
      }
      return;
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
  try {
    const parts = (interaction.customId || '').split('_').filter(Boolean);
    // formato: ajuste_modal_adicionar_<requesterId>_<workType>
    const action = parts[2]; // 'adicionar' ou 'subtrair'
    const requesterId = parts[3];
    const workType = parts.length > 4 ? parts.slice(4).join(' ').replace(/_/g, ' ') : null;

    const issueId = interaction.fields.getTextInputValue('issueIdInput');
    const time = interaction.fields.getTextInputValue('timeInput');
    const reason = interaction.fields.getTextInputValue('reasonInput');
    const requester = interaction.user;

    const approvalChannel = client.channels.cache.get(approvalChannelId);
    if (!approvalChannel) {
      await interaction.editReply('❌ Erro: Canal de aprovação não encontrado. Verifique a configuração.');
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`🕒 Solicitação de Ajuste de Tempo para ${issueId}`)
      .setDescription(`**Usuário:** ${requester.username}\n**Ação:** ${action === 'adicionar' ? 'Adicionar' : 'Subtrair'}\n**Tempo:** ${time}\n**Tipo de Trabalho:** ${workType}\n**Motivo:**\n${reason}`)
      .setColor(action === 'adicionar' ? 0x00ff00 : 0xff0000)
      .setTimestamp();

    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`aprovar_${issueId}_${time}_${requester.id}_${(workType || '').replace(/\s/g, '_')}_${action}`).setLabel('Aprovar').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`rejeitar_${issueId}_${time}_${requester.id}_${(workType || '').replace(/\s/g, '_')}_${action}`).setLabel('Rejeitar').setStyle(ButtonStyle.Danger)
    );

    await approvalChannel.send({ embeds: [embed], components: [buttons] });
    await interaction.editReply('✅ Sua solicitação foi enviada para aprovação.');
  } catch (error) {
    console.error('Erro no handleTimeRequestModal:', error);
    await interaction.editReply('❌ Erro ao processar sua solicitação.');
  }
}

async function handleTimeApproval(interaction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const parts = (interaction.customId || '').split('_').filter(Boolean);
    const action = parts[0]; // 'aprovar' ou 'rejeitar'
    const issueId = parts[1];
    const timeString = parts[2];
    const requesterId = parts[3];
    const workType = parts.length > 4 ? parts[4].replace(/_/g, ' ') : null;
    const timeAction = parts[5]; // 'adicionar' ou 'subtrair'
    const approver = interaction.user;

    const requester = await client.users.fetch(requesterId).catch(() => null);

    if (!requester) {
      const origEmbed = interaction.message.embeds[0] ? EmbedBuilder.from(interaction.message.embeds[0]) : new EmbedBuilder();
      origEmbed.setColor(0xff0000).setFooter({ text: `Falha na aprovação. Usuário solicitante não encontrado.` });
      await interaction.message.edit({ embeds: [origEmbed], components: [] });
      await interaction.editReply(`❌ Erro: Não foi possível encontrar o usuário que fez a solicitação.`);
      return;
    }

    if (action === 'aprovar') {
      const requesterYouTrackLogin = userMap[requesterId];
      if (!requesterYouTrackLogin) {
        const origEmbed = interaction.message.embeds[0] ? EmbedBuilder.from(interaction.message.embeds[0]) : new EmbedBuilder();
        origEmbed.setColor(0xff0000).setFooter({ text: `Falha na aprovação. Usuário não mapeado.` });
        await interaction.message.edit({ embeds: [origEmbed], components: [] });
        await interaction.editReply(`❌ Erro: O usuário solicitante não está mapeado no userMap.json.`);
        return;
      }

      if (timeAction === 'subtrair') {
        const durationMinutes = convertDurationToMinutes(timeString);
        if (isNaN(durationMinutes) || durationMinutes <= 0) {
          const origEmbed = interaction.message.embeds[0] ? EmbedBuilder.from(interaction.message.embeds[0]) : new EmbedBuilder();
          origEmbed.setColor(0xff0000).setFooter({ text: `Falha na aprovação. Formato de tempo inválido.` });
          await interaction.message.edit({ embeds: [origEmbed], components: [] });
          await interaction.editReply(`❌ Erro: Formato de tempo inválido para subtração: "${timeString}".`);
          requester?.send(`❌ Sua solicitação de correção de tempo para a issue ${issueId} foi rejeitada devido a um formato de tempo inválido. Por favor, verifique.`).catch(()=>{});
          return;
        }

        const deleteResult = await findAndDeleteWorkItem(issueId, requesterYouTrackLogin, durationMinutes, workType, approver.username);
        if (deleteResult.success) {
          const origEmbed = interaction.message.embeds[0] ? EmbedBuilder.from(interaction.message.embeds[0]) : new EmbedBuilder();
          origEmbed.setColor(0x00ff00).setFooter({ text: `Aprovado por ${approver.username}` });
          await interaction.message.edit({ embeds: [origEmbed], components: [] });
          await interaction.editReply(`✅ Correção de tempo de ${timeString} aprovada. ${deleteResult.message}`);
          requester?.send(`✅ Sua solicitação de correção de tempo (${timeString}) para a issue ${issueId} foi aprovada. ${deleteResult.message}`).catch(()=>{});
        } else {
          const origEmbed = interaction.message.embeds[0] ? EmbedBuilder.from(interaction.message.embeds[0]) : new EmbedBuilder();
          origEmbed.setColor(0xff0000).setFooter({ text: `Falha na aprovação. Erro: ${deleteResult.message}` });
          await interaction.message.edit({ embeds: [origEmbed], components: [] });
          await interaction.editReply(`❌ Erro ao processar a correção de tempo na issue ${issueId}. ${deleteResult.message}`);
          requester?.send(`❌ Sua solicitação de correção de tempo para a issue ${issueId} foi processada com erro: ${deleteResult.message}. Por favor, verifique a issue no YouTrack.`).catch(()=>{});
        }
        return;
      }

      // Adicionar tempo
      const workTypeId = WORK_TYPE_IDS[workType] || null;
      if (!workTypeId) {
        const origEmbed = interaction.message.embeds[0] ? EmbedBuilder.from(interaction.message.embeds[0]) : new EmbedBuilder();
        origEmbed.setColor(0xff0000).setFooter({ text: `Falha na aprovação. Tipo de trabalho não mapeado.` });
        await interaction.message.edit({ embeds: [origEmbed], components: [] });
        await interaction.editReply(`❌ Erro: O tipo de trabalho "${workType}" não está mapeado para um ID no código.`);
        return;
      }

      const minutes = convertDurationToMinutes(timeString);
      if (isNaN(minutes) || minutes <= 0) {
        await interaction.editReply(`❌ Formato de tempo inválido: ${timeString}`);
        return;
      }

      const timeLogged = await logWorkItemTime(issueId, minutes, `Ajuste de tempo aprovado por: ${approver.username} (via Discord)`, requesterYouTrackLogin, workTypeId);
      if (timeLogged.success) {
        const origEmbed = interaction.message.embeds[0] ? EmbedBuilder.from(interaction.message.embeds[0]) : new EmbedBuilder();
        origEmbed.setColor(0x00ff00).setFooter({ text: `Aprovado por ${approver.username}` });
        await interaction.message.edit({ embeds: [origEmbed], components: [] });
        await interaction.editReply(`✅ Tempo de ${timeString} foi registrado na issue ${issueId} para o usuário ${requesterYouTrackLogin} como "${workType}".`);
        requester?.send(`✅ Sua solicitação de ajuste de tempo para a issue ${issueId} foi aprovada por ${approver.username} e o tempo foi registrado como "${workType}".`).catch(()=>{});
      } else {
        const origEmbed = interaction.message.embeds[0] ? EmbedBuilder.from(interaction.message.embeds[0]) : new EmbedBuilder();
        origEmbed.setColor(0xff0000).setFooter({ text: `Falha na aprovação. Erro: ${timeLogged.error}` });
        await interaction.message.edit({ embeds: [origEmbed], components: [] });
        await interaction.editReply(`❌ Erro ao registrar o tempo na issue ${issueId}.`);
        requester?.send(`❌ Sua solicitação de ajuste de tempo para a issue ${issueId} foi rejeitada pelo bot devido a um erro técnico. Por favor, entre em contato com o administrador.`).catch(()=>{});
      }
    } else if (action === 'rejeitar') {
      const origEmbed = interaction.message.embeds[0] ? EmbedBuilder.from(interaction.message.embeds[0]) : new EmbedBuilder();
      origEmbed.setColor(0xff0000).setFooter({ text: `Rejeitado por ${approver.username}` });
      await interaction.message.edit({ embeds: [origEmbed], components: [] });
      await interaction.editReply(`❌ Solicitação de ajuste de tempo para a issue ${issueId} foi rejeitada.`);
      requester?.send(`❌ Sua solicitação de ajuste de tempo para a issue ${issueId} foi rejeitada por ${approver.username}.`).catch(()=>{});
    }
  } catch (error) {
    console.error('Erro no handleTimeApproval:', error);
    try { await interaction.editReply('❌ Erro ao processar aprovação/rejeição'); } catch(e){}
  }
}

// Webhook endpoint que publica em canal do Discord
app.post('/webhook', async (req, res) => {
  try {
    const data = req.body;
    const channel = await client.channels.fetch(DISCORD_CHANNEL_ID).catch(() => null);
    if (!channel) {
      console.error('Canal do Discord não encontrado para envio de webhook');
      return res.status(500).json({ error: 'Canal do Discord não encontrado' });
    }

    const embed = new EmbedBuilder()
      .setTitle(data.title || 'Notificação')
      .setURL(data.url || '')
      .setDescription(data.description || '')
      .setColor(data.statusChange === 'created' ? 0x00ff00 : 0x0099ff)
      .setTimestamp()
      .setFooter({ text: `Por ${data.userVisibleName || 'Sistema'}` });

    if (Array.isArray(data.fields) && data.fields.length > 0) {
      data.fields.forEach(field => {
        embed.addFields({ name: field.title || 'Campo', value: field.value || '-', inline: true });
      });
    }

    const assignButton = new ButtonBuilder().setCustomId(`assign_${data.issueId}`).setLabel('Atribuir para mim').setStyle(ButtonStyle.Primary).setEmoji('👤');
    const stateButton = new ButtonBuilder().setCustomId(`states_${data.issueId}`).setLabel('Alterar Estado').setStyle(ButtonStyle.Secondary).setEmoji('🔄');
    const commentButton = new ButtonBuilder().setCustomId(`comment_${data.issueId}`).setLabel('Comentar').setStyle(ButtonStyle.Secondary).setEmoji('💬');
    const templatesButton = new ButtonBuilder().setCustomId(`templates_${data.issueId}`).setLabel('Comentários Rápidos').setStyle(ButtonStyle.Secondary).setEmoji('⚡');

    const row1 = new ActionRowBuilder().addComponents(assignButton, stateButton, commentButton, templatesButton);
    await channel.send({ embeds: [embed], components: [row1] });
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Erro no webhook:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Login do bot e start do servidor webhook
client.login(DISCORD_BOT_TOKEN).catch(err => console.error('Erro ao logar o bot Discord:', err));

app.listen(WEBHOOK_PORT, () => {
  console.log(`Servidor webhook rodando na porta ${WEBHOOK_PORT}`);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});