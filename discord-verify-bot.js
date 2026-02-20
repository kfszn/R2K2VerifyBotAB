const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
require('dotenv').config();

// Configuration
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const ACEBET_TOKEN = process.env.ACEBET_TOKEN;
const WAGER_WINDOW_START = process.env.WAGER_WINDOW_START || '2025-01-01'; // Adjust as needed
const OWNER_DISCORD_ID = '687823175647887394'; // Your Discord ID

// Links storage file
const LINKS_FILE = path.join(__dirname, 'acebet_links.json');

// Rewards storage file
const REWARDS_FILE = path.join(__dirname, 'acebet_rewards.json');

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

// Load rewards from file
async function loadRewards() {
  try {
    const data = await fs.readFile(REWARDS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    // If file doesn't exist, return empty array
    return { rewards: [] };
  }
}

// Save rewards to file
async function saveRewards(rewardsData) {
  try {
    await fs.writeFile(REWARDS_FILE, JSON.stringify(rewardsData, null, 2));
  } catch (error) {
    console.error('Error saving rewards:', error);
  }
}

// Get weekly stats for Sunday report
async function getWeeklyStats() {
  try {
    // Get current date (should be Sunday when this runs)
    const today = new Date();
    
    // Calculate last Sunday (start of previous week)
    const lastSunday = new Date(today);
    lastSunday.setDate(today.getDate() - 7);
    
    // Calculate last Saturday (end of previous week)
    const lastSaturday = new Date(today);
    lastSaturday.setDate(today.getDate() - 1);
    
    // Format dates
    const formatDate = (date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };
    
    const sundayStr = formatDate(lastSunday);
    const saturdayStr = formatDate(lastSaturday);
    
    // Track min/max wagered per user
    const userStats = {};
    
    for (let d = new Date(lastSunday); d <= lastSaturday; d.setDate(d.getDate() + 1)) {
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
        
        snapshot.forEach(user => {
          if (!userStats[user.userId]) {
            userStats[user.userId] = {
              active: user.active,
              minWagered: user.wagered || 0,
              maxWagered: user.wagered || 0,
              minDeposited: user.deposited || 0,
              maxDeposited: user.deposited || 0,
              minEarned: user.earned || 0,
              maxEarned: user.earned || 0,
            };
          }
          
          // Track min/max for each user
          userStats[user.userId].minWagered = Math.min(userStats[user.userId].minWagered, user.wagered || 0);
          userStats[user.userId].maxWagered = Math.max(userStats[user.userId].maxWagered, user.wagered || 0);
          userStats[user.userId].minDeposited = Math.min(userStats[user.userId].minDeposited, user.deposited || 0);
          userStats[user.userId].maxDeposited = Math.max(userStats[user.userId].maxDeposited, user.deposited || 0);
          userStats[user.userId].minEarned = Math.min(userStats[user.userId].minEarned, user.earned || 0);
          userStats[user.userId].maxEarned = Math.max(userStats[user.userId].maxEarned, user.earned || 0);
          userStats[user.userId].active = user.active; // Latest active status
        });
      }
    }
    
    // Calculate totals
    let totalWagered = 0;
    let totalDeposits = 0;
    let totalEarned = 0;
    let activeCount = 0;
    
    Object.values(userStats).forEach(user => {
      totalWagered += (user.maxWagered - user.minWagered);
      totalDeposits += (user.maxDeposited - user.minDeposited);
      totalEarned += (user.maxEarned - user.minEarned);
      if (user.active) activeCount++;
    });
    
    return {
      weekStart: sundayStr,
      weekEnd: saturdayStr,
      totalWagered: totalWagered / 100, // Convert from pennies
      totalDeposits: totalDeposits / 100,
      affiliateIncome: totalEarned / 100,
      activeMembers: activeCount,
    };
  } catch (error) {
    console.error('Error getting weekly stats:', error);
    throw error;
  }
}

// Send weekly summary DM
async function sendWeeklySummary() {
  try {
    const stats = await getWeeklyStats();
    
    const owner = await client.users.fetch(OWNER_DISCORD_ID);
    
    const message = `
📊 **R2K2 Weekly Summary**
Week: ${stats.weekStart} to ${stats.weekEnd}

💰 **Total Wagered:** $${stats.totalWagered.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
💳 **Total Deposits:** $${stats.totalDeposits.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
👥 **Active Referrals:** ${stats.activeMembers}
💵 **Affiliate Income:** $${stats.affiliateIncome.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
    `.trim();
    
    await owner.send(message);
    console.log('Weekly summary sent successfully!');
  } catch (error) {
    console.error('Error sending weekly summary:', error);
  }
}

// Resolve Discord user mention or Acebet username
async function resolveToAcebetUsername(input) {
  // Check if input is a Discord user mention format: <@USER_ID> or <@!USER_ID>
  const mentionMatch = input.match(/^<@!?(\d+)>$/);
  
  if (mentionMatch) {
    // It's a Discord mention - look up their linked Acebet username
    const userId = mentionMatch[1];
    const links = await loadLinks();
    
    if (links[userId]) {
      return links[userId];
    }
    return null; // User not linked
  }
  
  // Not a mention, treat as direct Acebet username
  return input;
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
          .setDescription('Acebet username')
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
    new SlashCommandBuilder()
      .setName('checklink')
      .setDescription('Check which Acebet account a Discord user is linked to (Staff only)')
      .addUserOption(option =>
        option
          .setName('discord_user')
          .setDescription('Discord user to check')
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('summary')
      .setDescription('Get weekly stats summary (Owner only)'),
    new SlashCommandBuilder()
      .setName('lossback')
      .setDescription('Calculate lossback owed for a user (Staff/Owner only)')
      .addStringOption(option =>
        option
          .setName('username')
          .setDescription('Acebet username')
          .setRequired(true)
      )
      .addNumberOption(option =>
        option
          .setName('pnl')
          .setDescription('P&L amount (use negative for loss, e.g., -500)')
          .setRequired(true)
      )
      .addNumberOption(option =>
        option
          .setName('rewards_claimed')
          .setDescription('Total rewards this period (excluding leaderboard payments)')
          .setRequired(true)
      )
      .addNumberOption(option =>
        option
          .setName('wager_amount')
          .setDescription('Total wager for this period')
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
      .setName('claim')
      .setDescription('Record a reward payment (Owner only)')
      .addStringOption(option =>
        option
          .setName('username')
          .setDescription('Acebet username')
          .setRequired(true)
      )
      .addStringOption(option =>
        option
          .setName('reward_type')
          .setDescription('Type of reward')
          .setRequired(true)
          .addChoices(
            { name: 'Lossback', value: 'lossback' },
            { name: 'Wager Bonus', value: 'wagerbonus' },
            { name: 'Deposit Bonus', value: 'depobonus' },
            { name: 'Giveaway', value: 'gw' }
          )
      )
      .addNumberOption(option =>
        option
          .setName('amount')
          .setDescription('Amount being paid')
          .setRequired(true)
      )
      .addIntegerOption(option =>
        option
          .setName('period')
          .setDescription('Period number (1-12)')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(12)
      )
      .addNumberOption(option =>
        option
          .setName('net_loss')
          .setDescription('Net loss value (for lossback only - get from /lossback command)')
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName('claimed')
      .setDescription('View claim history for a user (Staff/Owner only)')
      .addStringOption(option =>
        option
          .setName('username')
          .setDescription('Acebet username')
          .setRequired(true)
      )
      .addStringOption(option =>
        option
          .setName('reward_type')
          .setDescription('Type of reward')
          .setRequired(true)
          .addChoices(
            { name: 'Lossback', value: 'lossback' },
            { name: 'Wager Bonus', value: 'wagerbonus' },
            { name: 'Deposit Bonus', value: 'depobonus' },
            { name: 'Giveaway', value: 'gw' }
          )
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

    // Clear existing guild commands first to prevent duplicates
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: [] },
    );

    console.log('Cleared existing commands.');

    // Register new commands
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

  // Commands that require staff/owner role
  const staffOnlyCommands = ['acebet', 'wager', 'linkuser', 'unlinkuser', 'checklink', 'lossback', 'claimed'];
  
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

  if (interaction.commandName === 'checklink') {
    const targetUser = interaction.options.getUser('discord_user');

    await interaction.deferReply({ ephemeral: true });

    try {
      const links = await loadLinks();

      if (!links[targetUser.id]) {
        await interaction.editReply(`❌ <@${targetUser.id}> is not linked to any Acebet account.`);
        return;
      }

      await interaction.editReply(`<@${targetUser.id}> is linked to Acebet username **${links[targetUser.id]}**`);
    } catch (error) {
      console.error('Error in checklink command:', error);
      await interaction.editReply('❌ An error occurred while checking the link.');
    }
  }

  if (interaction.commandName === 'summary') {
    // Owner-only command
    if (interaction.user.id !== OWNER_DISCORD_ID) {
      await interaction.reply({ content: '❌ This command is owner-only.', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const stats = await getWeeklyStats();
      
      const message = `
📊 **R2K2 Weekly Summary**
Week: ${stats.weekStart} to ${stats.weekEnd}

💰 **Total Wagered:** $${stats.totalWagered.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
💳 **Total Deposits:** $${stats.totalDeposits.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
👥 **Active Referrals:** ${stats.activeMembers}
💵 **Affiliate Income:** $${stats.affiliateIncome.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      `.trim();
      
      await interaction.editReply(message);
      
      // Also send DM
      await interaction.user.send(message);
    } catch (error) {
      console.error('Error in summary command:', error);
      await interaction.editReply('❌ An error occurred while generating the summary.');
    }
  }

  if (interaction.commandName === 'lossback') {
    const username = interaction.options.getString('username');
    const pnl = interaction.options.getNumber('pnl');
    const rewardsClaimed = interaction.options.getNumber('rewards_claimed');
    const wagerAmount = interaction.options.getNumber('wager_amount');
    const period = interaction.options.getInteger('period');

    await interaction.deferReply({ ephemeral: false }); // Changed to false - visible to everyone

    try {
      // Calculate net loss
      const netLoss = pnl + rewardsClaimed;

      // Check if eligible (must be in loss)
      if (netLoss >= 0) {
        await interaction.editReply(`❌ **${username}** is in profit. Cannot claim lossback when in profit.\n\nNet P&L: $${netLoss.toFixed(2)}`);
        return;
      }

      // Determine tier and percentage
      let tierName = '';
      let percentage = 0;
      let maxPayout = 0;

      if (wagerAmount >= 0 && wagerAmount <= 99999) {
        tierName = 'Tier 1';
        percentage = 5;
        maxPayout = 100;
      } else if (wagerAmount >= 100000 && wagerAmount <= 499999) {
        tierName = 'Tier 2';
        percentage = 10;
        maxPayout = 200;
      } else if (wagerAmount >= 500000) {
        tierName = 'Tier 3';
        percentage = 15;
        maxPayout = 300;
      }

      // Calculate lossback
      const lossbackOwed = Math.abs(netLoss) * (percentage / 100);
      const finalPayout = Math.min(lossbackOwed, maxPayout);

      // Get previous claims for this user in this period
      const rewardsData = await loadRewards();
      const userLossbackClaims = rewardsData.rewards.filter(r => 
        r.username.toLowerCase() === username.toLowerCase() && 
        r.reward_type === 'lossback' && 
        r.period === period
      );

      // Check eligibility based on previous claims
      let eligibilityStatus = '✅ ELIGIBLE';
      let eligibilityNote = '';

      if (userLossbackClaims.length === 0) {
        // First claim - must be at least -$300 net loss
        if (netLoss > -300) {
          eligibilityStatus = '❌ INELIGIBLE';
          eligibilityNote = `\n\n**Not eligible yet.** Need $${(300 - Math.abs(netLoss)).toFixed(2)} more net loss to claim.\n(Minimum -$300 net loss required for first claim)`;
        }
      } else {
        // Subsequent claims - must be -$300 MORE net loss than last claim
        const lastClaim = userLossbackClaims[userLossbackClaims.length - 1];
        const lastClaimNetLoss = lastClaim.net_loss || 0;
        const requiredNetLoss = lastClaimNetLoss - 300;

        if (netLoss > requiredNetLoss) {
          eligibilityStatus = '❌ INELIGIBLE';
          const neededLoss = Math.abs(requiredNetLoss - netLoss);
          eligibilityNote = `\n\n**Not eligible yet.** Need $${neededLoss.toFixed(2)} more net loss to claim again.\n(Last claim was at $${lastClaimNetLoss.toFixed(2)} net loss. Need to reach $${requiredNetLoss.toFixed(2)})`;
        }
      }

      // Build response message
      const claimsHistory = userLossbackClaims.length > 0 
        ? `\n\n**Previous Claims in Period ${period}:**\n${userLossbackClaims.map((c, i) => `Claim #${i + 1}: $${c.amount.toFixed(2)} (Net Loss: $${c.net_loss.toFixed(2)})`).join('\n')}`
        : '';

      const message = `
**Lossback Calculation - Period ${period}**
Username: **${username}**

📊 **Calculation:**
• P&L: $${pnl.toFixed(2)}
• Rewards Claimed: $${rewardsClaimed.toFixed(2)}
• **Net Loss: $${netLoss.toFixed(2)}**

💰 **Wager Tier:**
• Total Wager: $${wagerAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
• ${tierName} (${percentage}%, max $${maxPayout})

🎯 **Lossback Calculation:**
• $${Math.abs(netLoss).toFixed(2)} × ${percentage}% = $${lossbackOwed.toFixed(2)}
• Capped at $${maxPayout} max
• **Lossback Owed: $${finalPayout.toFixed(2)}**

${eligibilityStatus}${eligibilityNote}${claimsHistory}
      `.trim();

      await interaction.editReply(message);
    } catch (error) {
      console.error('Error in lossback command:', error);
      await interaction.editReply('❌ An error occurred while calculating lossback.');
    }
  }

  if (interaction.commandName === 'claim') {
    // Owner-only command
    if (interaction.user.id !== OWNER_DISCORD_ID) {
      await interaction.reply({ content: '❌ This command is owner-only.', ephemeral: true });
      return;
    }

    const username = interaction.options.getString('username');
    const rewardType = interaction.options.getString('reward_type');
    const amount = interaction.options.getNumber('amount');
    const period = interaction.options.getInteger('period');
    const netLoss = interaction.options.getNumber('net_loss');

    await interaction.deferReply({ ephemeral: false }); // Changed to false - visible to everyone

    try {
      // Load rewards data
      const rewardsData = await loadRewards();

      // Create new reward entry
      const newReward = {
        id: rewardsData.rewards.length + 1,
        username: username,
        reward_type: rewardType,
        amount: amount,
        period: period,
        claimed_by: interaction.user.id,
        timestamp: new Date().toISOString()
      };

      // Store net_loss for lossback claims (for eligibility tracking)
      if (rewardType === 'lossback' && netLoss !== null) {
        newReward.net_loss = netLoss;
      }

      // Add to rewards array
      rewardsData.rewards.push(newReward);

      // Save to file
      await saveRewards(rewardsData);

      // Format reward type name
      const rewardTypeNames = {
        'lossback': 'Lossback',
        'wagerbonus': 'Wager Bonus',
        'depobonus': 'Deposit Bonus',
        'gw': 'Giveaway'
      };

      const netLossNote = (rewardType === 'lossback' && netLoss !== null) 
        ? `\n(Net Loss: $${netLoss.toFixed(2)})` 
        : '';

      await interaction.editReply(`✅ Successfully recorded **$${amount.toFixed(2)} ${rewardTypeNames[rewardType]}** for **${username}** in Period ${period}${netLossNote}`);
    } catch (error) {
      console.error('Error in claim command:', error);
      await interaction.editReply('❌ An error occurred while recording the claim.');
    }
  }

  if (interaction.commandName === 'claimed') {
    const username = interaction.options.getString('username');
    const rewardType = interaction.options.getString('reward_type');
    const period = interaction.options.getInteger('period');

    await interaction.deferReply({ ephemeral: false }); // Changed to false - visible to everyone

    try {
      // Load rewards data
      const rewardsData = await loadRewards();

      // Filter claims for this user, reward type, and period
      const claims = rewardsData.rewards.filter(r => 
        r.username.toLowerCase() === username.toLowerCase() && 
        r.reward_type === rewardType && 
        r.period === period
      );

      if (claims.length === 0) {
        await interaction.editReply(`📊 No ${rewardType} claims found for **${username}** in Period ${period}`);
        return;
      }

      // Calculate total
      const total = claims.reduce((sum, claim) => sum + claim.amount, 0);

      // Format reward type name
      const rewardTypeNames = {
        'lossback': 'Lossback',
        'wagerbonus': 'Wager Bonus',
        'depobonus': 'Deposit Bonus',
        'gw': 'Giveaway'
      };

      // Build claims list
      const claimsList = claims.map((claim, index) => {
        const date = new Date(claim.timestamp);
        const formattedDate = date.toLocaleString('en-US', { 
          month: 'short', 
          day: 'numeric', 
          year: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        });
        return `**Claim #${index + 1}:** $${claim.amount.toFixed(2)} on ${formattedDate}`;
      }).join('\n');

      const message = `
📊 **${rewardTypeNames[rewardType]} Claims - Period ${period}**
Username: **${username}**

${claimsList}

💰 **Total Claimed This Period:** $${total.toFixed(2)}
      `.trim();

      await interaction.editReply(message);
    } catch (error) {
      console.error('Error in claimed command:', error);
      await interaction.editReply('❌ An error occurred while fetching claim history.');
    }
  }
});

// Bot ready event
client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`Bot is ready to verify users under code R2K2`);
  
  // Schedule weekly summary every Sunday at 10:00 AM EST
  // Cron format: minute hour day month dayOfWeek
  // 0 = Sunday, 0 10 = 10:00 AM
  cron.schedule('0 10 * * 0', () => {
    console.log('Running weekly summary...');
    sendWeeklySummary();
  }, {
    timezone: "America/New_York" // EST/EDT
  });
  
  console.log('📅 Weekly summary scheduled for Sundays at 10:00 AM EST');
});

// Login and register commands
client.login(DISCORD_TOKEN).then(() => {
  registerCommands();
});
