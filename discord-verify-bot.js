const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
require('dotenv').config();

// Configuration
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID; // Your Discord server ID
const ACEBET_TOKEN = process.env.ACEBET_TOKEN;
const WAGER_WINDOW_START = process.env.WAGER_WINDOW_START || '2025-01-01'; // Adjust as needed

// Create Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
  ],
});

// Fetch Acebet users from API
async function getAcebetUsers() {
  try {
    const url = `https://api.acebet.com/affiliates/detailed-summary/v2/${WAGER_WINDOW_START}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${ACEBET_TOKEN}`,
      },
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`API returned ${response.status}: ${response.statusText}`);
    }

    const users = await response.json();
    return users;
  } catch (error) {
    console.error('Error fetching Acebet users:', error);
    throw error;
  }
}

// Check if username is active
async function checkUserActive(username) {
  try {
    const users = await getAcebetUsers();
    
    // Find user by name (case-insensitive)
    const user = users.find(u => u.name.toLowerCase() === username.toLowerCase());
    
    if (!user) {
      return { found: false };
    }

    return {
      found: true,
      active: user.active,
      wagered: user.wagered,
      deposited: user.deposited,
      lastSeen: user.lastSeen
    };
  } catch (error) {
    console.error('Error checking user:', error);
    return { error: true };
  }
}

// Register slash commands
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('verify')
      .setDescription('Verify if an Acebet user is active under code R2K2')
      .addStringOption(option =>
        option
          .setName('username')
          .setDescription('Acebet username to verify')
          .setRequired(true)
      ),
  ].map(command => command.toJSON());

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

  try {
    console.log('Started refreshing application (/) commands.');

    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands },
    );

    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error('Error registering commands:', error);
  }
}

// Handle interactions
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'verify') {
    const username = interaction.options.getString('username');

    // Defer reply since API call might take a moment
    await interaction.deferReply();

    try {
      const result = await checkUserActive(username);

      if (result.error) {
        await interaction.editReply('❌ Error checking API. Please try again later.');
        return;
      }

      if (!result.found) {
        await interaction.editReply(`❌ User **${username}** not found under code R2K2`);
        return;
      }

      if (result.active) {
        await interaction.editReply(`✅ **${username}** is Active`);
      } else {
        await interaction.editReply(`❌ **${username}** is Inactive`);
      }

    } catch (error) {
      console.error('Error in verify command:', error);
      await interaction.editReply('❌ An error occurred while verifying the user.');
    }
  }
});

// Bot ready event
client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`Bot is ready to verify users under code R2K2`);
});

// Login and register commands
client.login(DISCORD_TOKEN).then(() => {
  registerCommands();
});
