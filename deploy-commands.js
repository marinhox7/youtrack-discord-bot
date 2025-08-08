import { REST, Routes } from 'discord.js';
import { SlashCommandBuilder } from '@discordjs/builders';
import { config } from 'dotenv';
config();

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID; // Você precisará adicionar o CLIENT_ID ao seu .env
const GUILD_ID = 'SUA_GUILD_ID'; // Opcional: ID do seu servidor de teste

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
        .addSubcommand(subcommand =>
            subcommand
                .setName('solicitar_ajuste')
                .setDescription('Solicita o ajuste de tempo em uma issue.')
        ),
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);

(async () => {
    try {
        console.log(`Iniciando o deploy de ${commands.length} comandos slash.`);
        // Para comandos globais, use `Routes.applicationCommands(CLIENT_ID)`
        // Para comandos em um servidor específico (recomendado para testes), use `Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)`
        const data = await rest.put(
            Routes.applicationCommands(CLIENT_ID), // Mudar para Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID) se preferir
            { body: commands },
        );
        console.log(`✅ Deploy de ${data.length} comandos slash concluído com sucesso!`);
    } catch (error) {
        console.error('❌ Erro ao registrar comandos:', error);
    }
})();