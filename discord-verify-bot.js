const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

// Configuration
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const ACEBET_TOKEN = process.env.ACEBET_TOKEN;
const WAGER_WINDOW_START = process.env.WAGER_WINDOW_START || '2025-01-01'; // Adjust as needed

// Links storage file
const LINKS_FILE = path.join(__dirname, 'acebet_links.json');

// Load links from file
async function loadLinks() {
  try {
    const data = await fs.readFile(LINKS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    // If file doesn't exist, return empty object
    return {};
  }
}

// Save links to file
async function saveLinks(links) {
  try {
    await fs.writeFile(LINKS_FILE, JSON.stringify(links, null, 2));
  } catch (error) {
    console.error('Error saving links:', error);
  }
}

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
    new SlashCommandBuilder()
      .setName('link')
      .setDescription('Link your Discord account to your Acebet username')
      .addStringOption(option =>
        option
          .setName('acebet_username')
          .setDescription('Your Acebet username')
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('linkuser')
      .setDescription('Manually link a Discord user to an Acebet username (Staff only)')
      .addUserOption(option =>
        option
          .setName('discord_user')
          .setDescription('Discord user to link')
          .setRequired(true)
      )
      .addStringOption(option =>
        option
          .setName('acebet_username')
          .setDescription('Acebet username')
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('unlink')
      .setDescription('Unlink your Discord account from your Acebet username'),
    new SlashCommandBuilder()
      .setName('unlinkuser')
      .setDescription('Manually unlink a Discord user (Staff only)')
      .addUserOption(option =>
        option
          .setName('discord_user')
          .setDescription('Discord user to unlink')
          .setRequired(true)
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

  // Commands that require staff/owner role
  const staffOnlyCommands = ['acebet', 'wager', 'linkuser', 'unlinkuser'];
  
  if (staffOnlyCommands.includes(interaction.commandName)) {
    // Check if user has staff or owner role
    const allowedRoles = ['staff', 'owner']; // Change these to your exact role names (case-sensitive)
    const hasPermission = interaction.member.roles.cache.some(role => 
      allowedRoles.some(allowedRole => role.name.toLowerCase() === allowedRole.toLowerCase())
    );

    if (!hasPermission) {
      await interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
      return;
    }
  }

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
      
      // Calculate start date for current period: base + (period - 1) * 30 days
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

      // Aggregate snapshots across date range
      let userFound = false;
      let maxWagered = 0;
      let minWagered = Infinity;
      let userName = username;

      // Loop through each day in the period
      for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
        const dateStr = formatDate(d);
        
        const url = `https://api.acebet.com/affiliates/detailed-summary/v2/${dateStr}`;
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${ACEBET_TOKEN}`,
          },
          cache: "no-store",
        });

        if (response.ok) {
          const snapshot = await response.json();
          const user = snapshot.find(u => u.name?.toLowerCase() === username.toLowerCase());
          
          if (user) {
            userFound = true;
            userName = user.name; // Use exact capitalization from API
            
            // Track min/max wagered for this user
            if (user.wagered > maxWagered) {
              maxWagered = user.wagered;
            }
            if (user.wagered < minWagered) {
              minWagered = user.wagered;
            }
          }
        }
      }

      if (!userFound) {
        await interaction.editReply(`❌ User **${username}** not found under code R2K2 for this period`);
        return;
      }

      // Calculate period wager as difference between max and min cumulative wager
      // This represents the actual wager activity during this period
      const periodWager = maxWagered - (minWagered === Infinity ? 0 : minWagered);

      // Format the wager amount with commas (divide by 100 since API returns pennies)
      const wagerInDollars = periodWager / 100;
      const formattedWager = wagerInDollars.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      });

      const report = `**${userName} Wager Report**\nPeriod ${period}: ${startDateStr} - ${endDateStr}\nTotal Wagered: $${formattedWager}`;
      
      await interaction.editReply(report);

    } catch (error) {
      console.error('Error in wager command:', error);
      await interaction.editReply('❌ An error occurred while fetching wager data.');
    }
  }

  if (interaction.commandName === 'link') {
    const acebetUsername = interaction.options.getString('acebet_username');
    const discordId = interaction.user.id;

    await interaction.deferReply({ ephemeral: true });

    try {
      // Verify the Acebet username exists in the API
      const users = await getAcebetUsers();
      const user = users.find(u => u.name.toLowerCase() === acebetUsername.toLowerCase());

      if (!user) {
        await interaction.editReply(`❌ Acebet username **${acebetUsername}** not found under code R2K2.`);
        return;
      }

      // Load existing links
      const links = await loadLinks();

      // Check if user is already linked
      if (links[discordId]) {
        await interaction.editReply(`❌ You are already linked to **${links[discordId]}**. Use \`/unlink\` first to change your linked account.`);
        return;
      }

      // Save the link
      links[discordId] = user.name; // Use the exact username from API
      await saveLinks(links);

      await interaction.editReply(`✅ Successfully linked your Discord account to Acebet username **${user.name}**`);
    } catch (error) {
      console.error('Error in link command:', error);
      await interaction.editReply('❌ An error occurred while linking your account.');
    }
  }

  if (interaction.commandName === 'linkuser') {
    const targetUser = interaction.options.getUser('discord_user');
    const acebetUsername = interaction.options.getString('acebet_username');

    await interaction.deferReply({ ephemeral: true });

    try {
      // Verify the Acebet username exists in the API
      const users = await getAcebetUsers();
      const user = users.find(u => u.name.toLowerCase() === acebetUsername.toLowerCase());

      if (!user) {
        await interaction.editReply(`❌ Acebet username **${acebetUsername}** not found under code R2K2.`);
        return;
      }

      // Load existing links
      const links = await loadLinks();

      // Save the link
      links[targetUser.id] = user.name;
      await saveLinks(links);

      await interaction.editReply(`✅ Successfully linked <@${targetUser.id}> to Acebet username **${user.name}**`);
    } catch (error) {
      console.error('Error in linkuser command:', error);
      await interaction.editReply('❌ An error occurred while linking the user.');
    }
  }

  if (interaction.commandName === 'unlink') {
    const discordId = interaction.user.id;

    await interaction.deferReply({ ephemeral: true });

    try {
      const links = await loadLinks();

      if (!links[discordId]) {
        await interaction.editReply('❌ You are not currently linked to any Acebet account.');
        return;
      }

      const oldUsername = links[discordId];
      delete links[discordId];
      await saveLinks(links);

      await interaction.editReply(`✅ Successfully unlinked your account from **${oldUsername}**`);
    } catch (error) {
      console.error('Error in unlink command:', error);
      await interaction.editReply('❌ An error occurred while unlinking your account.');
    }
  }

  if (interaction.commandName === 'unlinkuser') {
    const targetUser = interaction.options.getUser('discord_user');

    await interaction.deferReply({ ephemeral: true });

    try {
      const links = await loadLinks();

      if (!links[targetUser.id]) {
        await interaction.editReply(`❌ <@${targetUser.id}> is not currently linked to any Acebet account.`);
        return;
      }

      const oldUsername = links[targetUser.id];
      delete links[targetUser.id];
      await saveLinks(links);

      await interaction.editReply(`✅ Successfully unlinked <@${targetUser.id}> from **${oldUsername}**`);
    } catch (error) {
      console.error('Error in unlinkuser command:', error);
      await interaction.editReply('❌ An error occurred while unlinking the user.');
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
