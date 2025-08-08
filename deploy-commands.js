import { REST, Routes } from 'discord.js';
import { SlashCommandBuilder } from '@discordjs/builders';
import { config } from 'dotenv';
config();

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

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
        // COMANDO ORIGINAL: solicitar_ajuste agora é o primeiro passo
        .addSubcommand(subcommand =>
            subcommand
                .setName('adicionar_tempo')
                .setDescription('Adiciona tempo a uma issue.')
                .addStringOption(option =>
                    option
                        .setName('tipo_trabalho')
                        .setDescription('Tipo de trabalho para o registro de tempo.')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Desenvolvimento', value: 'Desenvolvimento' },
                            { name: 'Revisão', value: 'Revisão' },
                            { name: 'Correção', value: 'Correção' },
                            { name: 'Teste', value: 'Teste' },
                            { name: 'Documentação', value: 'Documentação' },
                            { name: 'Investigação', value: 'Investigação' },
                            { name: 'Implementação', value: 'Implementação' },
                            { name: 'Reunião', value: 'Reunião' },
                            { name: 'Planejamento', value: 'Planejamento' },
                            { name: 'Estudo', value: 'Estudo' },
                            { name: 'Prototipagem', value: 'Prototipagem' },
                            { name: 'Suporte', value: 'Suporte' }
                        )
                )
        )
        // NOVO SUBCOMANDO: Subtrair tempo
        .addSubcommand(subcommand =>
            subcommand
                .setName('subtrair_tempo')
                .setDescription('Subtrai tempo de uma issue para correção.')
                .addStringOption(option =>
                    option
                        .setName('tipo_trabalho')
                        .setDescription('Tipo de trabalho para o registro de tempo.')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Desenvolvimento', value: 'Desenvolvimento' },
                            { name: 'Revisão', value: 'Revisão' },
                            { name: 'Correção', value: 'Correção' },
                            { name: 'Teste', value: 'Teste' },
                            { name: 'Documentação', value: 'Documentação' },
                            { name: 'Investigação', value: 'Investigação' },
                            { name: 'Implementação', value: 'Implementação' },
                            { name: 'Reunião', value: 'Reunião' },
                            { name: 'Planejamento', value: 'Planejamento' },
                            { name: 'Estudo', value: 'Estudo' },
                            { name: 'Prototipagem', value: 'Prototipagem' },
                            { name: 'Suporte', value: 'Suporte' }
                        )
                )
        ),
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);

(async () => {
    try {
        console.log(`Iniciando o deploy de ${commands.length} comandos slash.`);
        const data = await rest.put(
            Routes.applicationCommands(CLIENT_ID),
            { body: commands },
        );
        console.log(`✅ Deploy de ${data.length} comandos slash concluído com sucesso!`);
    } catch (error) {
        console.error('❌ Erro ao registrar comandos:', error);
    }
})();