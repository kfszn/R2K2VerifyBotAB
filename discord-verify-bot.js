const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
require('dotenv').config();

// Configuration
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
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
      .setName('acebet')
      .setDescription('Check if an Acebet user is active under code R2K2')
      .addStringOption(option =>
        option
          .setName('username')
          .setDescription('Acebet username to check')
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('wager')
      .setDescription('Get wager report for an Acebet user by period')
      .addStringOption(option =>
        option
          .setName('username')
          .setDescription('Acebet username')
          .setRequired(true)
      )
      .addIntegerOption(option =>
        option
          .setName('period')
          .setDescription('Period number (1-12)')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(12)
      ),
  ].map(command => command.toJSON());

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

  try {
    console.log('Started refreshing application (/) commands.');

    // Use global commands instead of guild-specific
    await rest.put(
      Routes.applicationCommands(CLIENT_ID),
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

  if (interaction.commandName === 'acebet') {
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
      console.error('Error in acebet command:', error);
      await interaction.editReply('❌ An error occurred while verifying the user.');
    }
  }

  if (interaction.commandName === 'wager') {
    const username = interaction.options.getString('username');
    const period = interaction.options.getInteger('period');

    await interaction.deferReply();

    try {
      // Calculate date range based on period
      // Period 1 starts on Dec 26, 2025
      const periodStartBase = new Date('2025-12-26');
      
      // Calculate start date: base + (period - 1) * 30 days
      const startDate = new Date(periodStartBase);
      startDate.setDate(startDate.getDate() + ((period - 1) * 30));
      
      // Calculate end date: start + 29 days (30 day period inclusive)
      const endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 29);
      
      // Format dates as YYYY-MM-DD
      const formatDate = (date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      };
      
      const startDateStr = formatDate(startDate);
      const endDateStr = formatDate(endDate);

      // Fetch user data from start date
      const url = `https://api.acebet.com/affiliates/detailed-summary/v2/${startDateStr}`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${ACEBET_TOKEN}`,
        },
        cache: "no-store",
      });

      if (!response.ok) {
        await interaction.editReply('❌ Error fetching data from API. Please try again later.');
        return;
      }

      const users = await response.json();
      const user = users.find(u => u.name.toLowerCase() === username.toLowerCase());

      if (!user) {
        await interaction.editReply(`❌ User **${username}** not found under code R2K2`);
        return;
      }

      // Format the wager amount with commas
      const formattedWager = user.wagered.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      });

      const report = `**${username} Wager Report**\nPeriod ${period}: ${startDateStr} - ${endDateStr}\nTotal Wagered: $${formattedWager}`;
      
      await interaction.editReply(report);

    } catch (error) {
      console.error('Error in wager command:', error);
      await interaction.editReply('❌ An error occurred while fetching wager data.');
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
