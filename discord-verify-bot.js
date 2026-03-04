const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
const { Pool } = require('pg');
const { HttpsProxyAgent } = require('https-proxy-agent');
require('dotenv').config();

// Proxy agent for Cloudflare bypass
const PROXY_URL = process.env.PROXY_URL;
const proxyAgent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : undefined;
console.log(`[boot] Proxy configured: ${!!proxyAgent} (${PROXY_URL || 'none'})`);

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Cloudflare bypass headers — required or Acebet returns 403
const CF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept": "application/json",
  "Referer": "https://acebet.co/",
};

// Initialize database tables
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rewards (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) NOT NULL,
        reward_type VARCHAR(50) NOT NULL,
        amount DECIMAL(10, 2) NOT NULL,
        period INTEGER NOT NULL,
        net_loss DECIMAL(10, 2),
        claimed_by VARCHAR(255) NOT NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        site VARCHAR(50) DEFAULT 'acebet'
      )
    `);

    await pool.query(`
      ALTER TABLE rewards ADD COLUMN IF NOT EXISTS site VARCHAR(50) DEFAULT 'acebet'
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_links (
        discord_id VARCHAR(255) PRIMARY KEY,
        acebet_username VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    console.log('✅ Database tables initialized');
  } catch (error) {
    console.error('❌ Error initializing database:', error);
  }
}

// Configuration
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const ACEBET_API_TOKEN = process.env.ACEBET_API_TOKEN || process.env.ACEBET_TOKEN;
const WAGER_WINDOW_START = process.env.WAGER_WINDOW_START || '2025-01-01';
const OWNER_DISCORD_ID = '687823175647887394';

const LINKS_FILE = path.join(__dirname, 'acebet_links.json');
const REWARDS_FILE = path.join(__dirname, 'acebet_rewards.json');

// Load links from database
async function loadLinks() {
  try {
    const result = await pool.query('SELECT * FROM user_links');
    const links = {};
    result.rows.forEach(row => {
      links[row.discord_id] = row.acebet_username;
    });
    return links;
  } catch (error) {
    console.error('Error loading links:', error);
    return {};
  }
}

async function saveLink(discordId, acebetUsername) {
  try {
    await pool.query(
      `INSERT INTO user_links (discord_id, acebet_username)
       VALUES ($1, $2)
       ON CONFLICT (discord_id)
       DO UPDATE SET acebet_username = $2`,
      [discordId, acebetUsername]
    );
  } catch (error) {
    console.error('Error saving link:', error);
  }
}

async function deleteLink(discordId) {
  try {
    await pool.query('DELETE FROM user_links WHERE discord_id = $1', [discordId]);
  } catch (error) {
    console.error('Error deleting link:', error);
  }
}

async function loadRewards() {
  try {
    const result = await pool.query('SELECT * FROM rewards ORDER BY timestamp DESC');
    return { rewards: result.rows };
  } catch (error) {
    console.error('Error loading rewards:', error);
    return { rewards: [] };
  }
}

async function saveReward(reward) {
  try {
    console.log('Saving reward:', reward);
    const query = `
      INSERT INTO rewards (username, reward_type, amount, period, net_loss, claimed_by, timestamp, site)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `;
    const values = [
      reward.username,
      reward.reward_type,
      reward.amount,
      reward.period,
      reward.net_loss || null,
      reward.claimed_by,
      reward.timestamp || new Date().toISOString(),
      reward.site || 'acebet'
    ];
    const result = await pool.query(query, values);
    console.log('Saved reward successfully:', result.rows[0]);
    return result.rows[0];
  } catch (error) {
    console.error('Error saving reward:', error);
    console.error('Attempted to save:', reward);
    return null;
  }
}

async function getRewardsByFilter(username, rewardType, period, site = null) {
  try {
    let query, params;

    if (rewardType === 'all') {
      query = `
        SELECT * FROM rewards
        WHERE LOWER(username) = LOWER($1)
          AND period = $2
          ${site ? 'AND site = $3' : ''}
        ORDER BY timestamp ASC
      `;
      params = site ? [username, period, site] : [username, period];
    } else {
      query = `
        SELECT * FROM rewards
        WHERE LOWER(username) = LOWER($1)
          AND reward_type = $2
          AND period = $3
          ${site ? 'AND site = $4' : ''}
        ORDER BY timestamp ASC
      `;
      params = site ? [username, rewardType, period, site] : [username, rewardType, period];
    }

    console.log('Querying rewards with:', { username, rewardType, period, site });
    const result = await pool.query(query, params);
    console.log('Found', result.rows.length, 'rewards');
    return result.rows;
  } catch (error) {
    console.error('Error getting rewards:', error);
    return [];
  }
}

async function getWeeklyStats() {
  try {
    const today = new Date();
    const lastSunday = new Date(today);
    lastSunday.setDate(today.getDate() - 7);
    const lastSaturday = new Date(today);
    lastSaturday.setDate(today.getDate() - 1);
    
    const formatDate = (date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };
    
    const sundayStr = formatDate(lastSunday);
    const saturdayStr = formatDate(lastSaturday);
    const userStats = {};
    
    for (let d = new Date(lastSunday); d <= lastSaturday; d.setDate(d.getDate() + 1)) {
      const dateStr = formatDate(d);
      const url = `https://api.acebet.co/affiliates/detailed-summary/v2/${dateStr}`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${ACEBET_API_TOKEN}`, ...CF_HEADERS },
        cache: "no-store",
        ...(proxyAgent ? { agent: proxyAgent } : {}),
      });
      
      if (response.ok) {
        const snapshot = await response.json();
        snapshot.forEach(user => {
          if (!userStats[user.userId]) {
            userStats[user.userId] = {
              active: user.active,
              minWagered: user.wagered || 0, maxWagered: user.wagered || 0,
              minDeposited: user.deposited || 0, maxDeposited: user.deposited || 0,
              minEarned: user.earned || 0, maxEarned: user.earned || 0,
            };
          }
          userStats[user.userId].minWagered = Math.min(userStats[user.userId].minWagered, user.wagered || 0);
          userStats[user.userId].maxWagered = Math.max(userStats[user.userId].maxWagered, user.wagered || 0);
          userStats[user.userId].minDeposited = Math.min(userStats[user.userId].minDeposited, user.deposited || 0);
          userStats[user.userId].maxDeposited = Math.max(userStats[user.userId].maxDeposited, user.deposited || 0);
          userStats[user.userId].minEarned = Math.min(userStats[user.userId].minEarned, user.earned || 0);
          userStats[user.userId].maxEarned = Math.max(userStats[user.userId].maxEarned, user.earned || 0);
          userStats[user.userId].active = user.active;
        });
      }
    }
    
    let totalWagered = 0, totalDeposits = 0, totalEarned = 0, activeCount = 0;
    Object.values(userStats).forEach(user => {
      totalWagered += (user.maxWagered - user.minWagered);
      totalDeposits += (user.maxDeposited - user.minDeposited);
      totalEarned += (user.maxEarned - user.minEarned);
      if (user.active) activeCount++;
    });
    
    return {
      weekStart: sundayStr, weekEnd: saturdayStr,
      totalWagered: totalWagered / 100, totalDeposits: totalDeposits / 100,
      affiliateIncome: totalEarned / 100, activeMembers: activeCount,
    };
  } catch (error) {
    console.error('Error getting weekly stats:', error);
    throw error;
  }
}

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

async function resolveToAcebetUsername(input) {
  const mentionMatch = input.match(/^<@!?(\d+)>$/);
  if (mentionMatch) {
    const userId = mentionMatch[1];
    const links = await loadLinks();
    if (links[userId]) return links[userId];
    return null;
  }
  return input;
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function getAcebetUsers() {
  try {
    const url = `https://api.acebet.co/affiliates/detailed-summary/v2/${WAGER_WINDOW_START}`;
    console.log('[acebet] Fetching users from:', url);
    console.log('[acebet] Token defined:', !!ACEBET_API_TOKEN);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${ACEBET_API_TOKEN}`, ...CF_HEADERS },
      cache: "no-store",
        ...(proxyAgent ? { agent: proxyAgent } : {}),
    });
    console.log('[acebet] Response status:', response.status);
    if (!response.ok) {
      const text = await response.text();
      console.error('[acebet] Error body:', text.slice(0, 200));
      throw new Error(`API returned ${response.status}: ${response.statusText}`);
    }
    const users = await response.json();
    console.log('[acebet] Users returned:', users.length);
    return users;
  } catch (error) {
    console.error('Error fetching Acebet users:', error);
    throw error;
  }
}

async function checkUserActive(username) {
  try {
    const users = await getAcebetUsers();
    const user = users.find(u => u.name.toLowerCase() === username.toLowerCase());
    if (!user) return { found: false };
    return { found: true, active: user.active, wagered: user.wagered, deposited: user.deposited, lastSeen: user.lastSeen };
  } catch (error) {
    console.error('Error checking user:', error);
    return { error: true };
  }
}

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('acebet')
      .setDescription('Check if an Acebet user is active under code R2K2')
      .addStringOption(option => option.setName('username').setDescription('Acebet username').setRequired(true)),
    new SlashCommandBuilder()
      .setName('wager')
      .setDescription('Get wager report for an Acebet user by period')
      .addStringOption(option => option.setName('username').setDescription('Acebet username').setRequired(true))
      .addIntegerOption(option => option.setName('period').setDescription('Period number (1-12)').setRequired(true).setMinValue(1).setMaxValue(12)),
    new SlashCommandBuilder()
      .setName('link')
      .setDescription('Link your Discord account to your Acebet username')
      .addStringOption(option => option.setName('acebet_username').setDescription('Your Acebet username').setRequired(true)),
    new SlashCommandBuilder()
      .setName('linkuser')
      .setDescription('Manually link a Discord user to an Acebet username (Staff only)')
      .addUserOption(option => option.setName('discord_user').setDescription('Discord user to link').setRequired(true))
      .addStringOption(option => option.setName('acebet_username').setDescription('Acebet username').setRequired(true)),
    new SlashCommandBuilder()
      .setName('unlink')
      .setDescription('Unlink your Discord account from your Acebet username'),
    new SlashCommandBuilder()
      .setName('unlinkuser')
      .setDescription('Manually unlink a Discord user (Staff only)')
      .addUserOption(option => option.setName('discord_user').setDescription('Discord user to unlink').setRequired(true)),
    new SlashCommandBuilder()
      .setName('checklink')
      .setDescription('Check which Acebet account a Discord user is linked to (Staff only)')
      .addUserOption(option => option.setName('discord_user').setDescription('Discord user to check').setRequired(true)),
    new SlashCommandBuilder().setName('summary').setDescription('Get weekly stats summary (Owner only)'),
    new SlashCommandBuilder().setName('exportrewards').setDescription('Export rewards data as JSON file (Owner only)'),
    new SlashCommandBuilder().setName('setupdb').setDescription('Manually initialize database tables (Owner only)'),
    new SlashCommandBuilder()
      .setName('periodstats')
      .setDescription('View period statistics (Owner only)')
      .addIntegerOption(option => option.setName('period').setDescription('Period number (1-12)').setRequired(true).setMinValue(1).setMaxValue(12)),
    new SlashCommandBuilder()
      .setName('lossback')
      .setDescription('Calculate lossback owed for a user (Staff/Owner only)')
      .addStringOption(option => option.setName('username').setDescription('Acebet username').setRequired(true))
      .addNumberOption(option => option.setName('pnl').setDescription('P&L amount (use negative for loss, e.g., -500)').setRequired(true))
      .addNumberOption(option => option.setName('rewards_claimed').setDescription('Total rewards this period (excluding leaderboard payments)').setRequired(true))
      .addNumberOption(option => option.setName('wager_amount').setDescription('Total wager for this period').setRequired(true))
      .addIntegerOption(option => option.setName('period').setDescription('Period number (1-12)').setRequired(true).setMinValue(1).setMaxValue(12)),
    new SlashCommandBuilder()
      .setName('claim')
      .setDescription('Record a reward payment (Owner only)')
      .addStringOption(option => option.setName('username').setDescription('Acebet username').setRequired(true))
      .addStringOption(option => option.setName('reward_type').setDescription('Type of reward').setRequired(true).addChoices(
        { name: 'Lossback', value: 'lossback' }, { name: 'Wager Bonus', value: 'wagerbonus' },
        { name: 'Deposit Bonus', value: 'depobonus' }, { name: 'Giveaway', value: 'gw' }
      ))
      .addStringOption(option => option.setName('site').setDescription('Which site').setRequired(true).addChoices(
        { name: 'Acebet', value: 'acebet' }, { name: 'Packdraw', value: 'packdraw' }
      ))
      .addNumberOption(option => option.setName('amount').setDescription('Amount being paid').setRequired(true))
      .addIntegerOption(option => option.setName('period').setDescription('Period number (1-12)').setRequired(true).setMinValue(1).setMaxValue(12))
      .addNumberOption(option => option.setName('net_loss').setDescription('Net loss value (for lossback only)').setRequired(false)),
    new SlashCommandBuilder()
      .setName('claimed')
      .setDescription('View claim history for a user (Staff/Owner only)')
      .addStringOption(option => option.setName('username').setDescription('Acebet username').setRequired(true))
      .addStringOption(option => option.setName('reward_type').setDescription('Type of reward (All shows both sites)').setRequired(true).addChoices(
        { name: 'Lossback', value: 'lossback' }, { name: 'Wager Bonus', value: 'wagerbonus' },
        { name: 'Deposit Bonus', value: 'depobonus' }, { name: 'Giveaway', value: 'gw' }, { name: 'All', value: 'all' }
      ))
      .addIntegerOption(option => option.setName('period').setDescription('Period number (1-12)').setRequired(true).setMinValue(1).setMaxValue(12))
      .addStringOption(option => option.setName('site').setDescription('Which site (not required when reward_type is All)').setRequired(false).addChoices(
        { name: 'Acebet', value: 'acebet' }, { name: 'Packdraw', value: 'packdraw' }
      )),
  ].map(command => command.toJSON());

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  try {
    console.log('Started refreshing application (/) commands.');
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: [] });
    console.log('Cleared existing commands.');
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error('Error registering commands:', error);
  }
}

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const staffOnlyCommands = ['acebet', 'wager', 'linkuser', 'unlinkuser', 'checklink', 'lossback', 'claimed'];
  if (staffOnlyCommands.includes(interaction.commandName)) {
    const allowedRoles = ['staff', 'owner'];
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
    await interaction.deferReply();
    try {
      const result = await checkUserActive(username);
      if (result.error) { await interaction.editReply('❌ Error checking API. Please try again later.'); return; }
      if (!result.found) { await interaction.editReply(`❌ User **${username}** not found under code R2K2`); return; }
      await interaction.editReply(result.active ? `✅ **${username}** is Active` : `❌ **${username}** is Inactive`);
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
      const periodStartBase = new Date('2025-12-26');
      const startDate = new Date(periodStartBase);
      startDate.setDate(startDate.getDate() + ((period - 1) * 30));
      const endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 29);

      const formatDate = (date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      };

      const startDateStr = formatDate(startDate);
      const endDateStr = formatDate(endDate);

      console.log(`[wager] "${username}" period ${period}: ${startDateStr} → ${endDateStr}`);
      console.log(`[wager] Token defined: ${!!ACEBET_API_TOKEN}, prefix: ${ACEBET_API_TOKEN?.slice(0, 20)}`);

      let userFound = false;
      let maxWagered = 0;
      let minWagered = Infinity;
      let userName = username;

      for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
        const dateStr = formatDate(d);
        const url = `https://api.acebet.co/affiliates/detailed-summary/v2/${dateStr}`;
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${ACEBET_API_TOKEN}`, ...CF_HEADERS },
          cache: "no-store",
        ...(proxyAgent ? { agent: proxyAgent } : {}),
        });

        console.log(`[wager] ${dateStr} → status: ${response.status}`);

        if (response.ok) {
          const snapshot = await response.json();
          console.log(`[wager] ${dateStr} → ${snapshot.length} users`);
          const user = snapshot.find(u => u.name?.toLowerCase() === username.toLowerCase());
          if (user) {
            userFound = true;
            userName = user.name;
            console.log(`[wager] Found "${userName}" wagered: ${user.wagered}`);
            if (user.wagered > maxWagered) maxWagered = user.wagered;
            if (user.wagered < minWagered) minWagered = user.wagered;
          }
        } else {
          const errText = await response.text();
          console.error(`[wager] ${dateStr} error: ${errText.slice(0, 150)}`);
        }
      }

      console.log(`[wager] Done. found: ${userFound}, min: ${minWagered}, max: ${maxWagered}`);

      if (!userFound) {
        await interaction.editReply(`❌ User **${username}** not found under code R2K2 for this period`);
        return;
      }

      const periodWager = maxWagered - (minWagered === Infinity ? 0 : minWagered);
      const wagerInDollars = periodWager / 100;
      const formattedWager = wagerInDollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      await interaction.editReply(`**${userName} Wager Report**\nPeriod ${period}: ${startDateStr} - ${endDateStr}\nTotal Wagered: $${formattedWager}`);
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
      const users = await getAcebetUsers();
      const user = users.find(u => u.name.toLowerCase() === acebetUsername.toLowerCase());
      if (!user) { await interaction.editReply(`❌ Acebet username **${acebetUsername}** not found under code R2K2.`); return; }
      const links = await loadLinks();
      if (links[discordId]) { await interaction.editReply(`❌ You are already linked to **${links[discordId]}**. Use \`/unlink\` first.`); return; }
      await saveLink(discordId, user.name);
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
      const users = await getAcebetUsers();
      const user = users.find(u => u.name.toLowerCase() === acebetUsername.toLowerCase());
      if (!user) { await interaction.editReply(`❌ Acebet username **${acebetUsername}** not found under code R2K2.`); return; }
      await saveLink(targetUser.id, user.name);
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
      if (!links[discordId]) { await interaction.editReply('❌ You are not currently linked to any Acebet account.'); return; }
      const oldUsername = links[discordId];
      await deleteLink(discordId);
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
      if (!links[targetUser.id]) { await interaction.editReply(`❌ <@${targetUser.id}> is not currently linked to any Acebet account.`); return; }
      const oldUsername = links[targetUser.id];
      await deleteLink(targetUser.id);
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
      if (!links[targetUser.id]) { await interaction.editReply(`❌ <@${targetUser.id}> is not linked to any Acebet account.`); return; }
      await interaction.editReply(`<@${targetUser.id}> is linked to Acebet username **${links[targetUser.id]}**`);
    } catch (error) {
      console.error('Error in checklink command:', error);
      await interaction.editReply('❌ An error occurred while checking the link.');
    }
  }

  if (interaction.commandName === 'summary') {
    if (interaction.user.id !== OWNER_DISCORD_ID) { await interaction.reply({ content: '❌ This command is owner-only.', ephemeral: true }); return; }
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
      await interaction.user.send(message);
    } catch (error) {
      console.error('Error in summary command:', error);
      await interaction.editReply('❌ An error occurred while generating the summary.');
    }
  }

  if (interaction.commandName === 'exportrewards') {
    if (interaction.user.id !== OWNER_DISCORD_ID) { await interaction.reply({ content: '❌ This command is owner-only.', ephemeral: true }); return; }
    await interaction.deferReply({ ephemeral: true });
    try {
      const rewardsData = await loadRewards();
      const buffer = Buffer.from(JSON.stringify(rewardsData, null, 2), 'utf-8');
      const { AttachmentBuilder } = require('discord.js');
      const attachment = new AttachmentBuilder(buffer, { name: 'acebet_rewards.json' });
      await interaction.editReply({ content: `📊 Rewards data exported (${rewardsData.rewards.length} total claims)`, files: [attachment] });
    } catch (error) {
      console.error('Error in exportrewards command:', error);
      await interaction.editReply('❌ An error occurred while exporting rewards data.');
    }
  }

  if (interaction.commandName === 'setupdb') {
    if (interaction.user.id !== OWNER_DISCORD_ID) { await interaction.reply({ content: '❌ This command is owner-only.', ephemeral: true }); return; }
    await interaction.deferReply({ ephemeral: true });
    try {
      await initDatabase();
      await interaction.editReply('✅ Database tables created successfully!');
    } catch (error) {
      console.error('Error in setupdb command:', error);
      await interaction.editReply('❌ An error occurred while setting up the database: ' + error.message);
    }
  }

  if (interaction.commandName === 'periodstats') {
    if (interaction.user.id !== OWNER_DISCORD_ID) { await interaction.reply({ content: '❌ This command is owner-only.', ephemeral: true }); return; }
    const period = interaction.options.getInteger('period');
    await interaction.deferReply({ ephemeral: true });
    try {
      const result = await pool.query('SELECT * FROM rewards WHERE period = $1 ORDER BY timestamp DESC', [period]);
      const claims = result.rows;
      if (claims.length === 0) { await interaction.editReply(`📊 No claims found for Period ${period}`); return; }

      const userClaimCounts = {}, userClaimTotals = {}, rewardTypeTotals = {};
      claims.forEach(claim => {
        const { username, reward_type: rewardType } = claim;
        const amount = parseFloat(claim.amount);
        userClaimCounts[username] = (userClaimCounts[username] || 0) + 1;
        userClaimTotals[username] = (userClaimTotals[username] || 0) + amount;
        rewardTypeTotals[rewardType] = (rewardTypeTotals[rewardType] || 0) + amount;
      });

      const mostClaimsUser = Object.entries(userClaimCounts).sort((a, b) => b[1] - a[1])[0];
      const mostClaimedUser = Object.entries(userClaimTotals).sort((a, b) => b[1] - a[1])[0];
      const mostClaimedCategory = Object.entries(rewardTypeTotals).sort((a, b) => b[1] - a[1])[0];
      const rewardTypeNames = { lossback: 'Lossback', wagerbonus: 'Wager Bonus', depobonus: 'Deposit Bonus', gw: 'Giveaway' };
      const rewardTypeBreakdown = Object.entries(rewardTypeTotals).map(([type, total]) => `• ${rewardTypeNames[type] || type}: $${total.toFixed(2)}`).join('\n');

      const message = `
📊 **Period ${period} Statistics**

👤 **Most Claims:** **${mostClaimsUser[0]}** with ${mostClaimsUser[1]} claim${mostClaimsUser[1] > 1 ? 's' : ''}
💰 **Most Claimed ($):** **${mostClaimedUser[0]}** with $${mostClaimedUser[1].toFixed(2)}
💵 **Total Paid Per Reward Type:**\n${rewardTypeBreakdown}
🏆 **Most Claimed Category:** **${rewardTypeNames[mostClaimedCategory[0]] || mostClaimedCategory[0]}** ($${mostClaimedCategory[1].toFixed(2)})
📈 **Overall:** Total Claims: ${claims.length} | Total Paid: $${Object.values(rewardTypeTotals).reduce((a, b) => a + b, 0).toFixed(2)} | Unique Users: ${Object.keys(userClaimCounts).length}
      `.trim();
      await interaction.editReply(message);
    } catch (error) {
      console.error('Error in periodstats command:', error);
      await interaction.editReply('❌ An error occurred while fetching period statistics.');
    }
  }

  if (interaction.commandName === 'lossback') {
    const username = interaction.options.getString('username');
    const pnl = interaction.options.getNumber('pnl');
    const rewardsClaimed = interaction.options.getNumber('rewards_claimed');
    const wagerAmount = interaction.options.getNumber('wager_amount');
    const period = interaction.options.getInteger('period');
    await interaction.deferReply({ ephemeral: false });
    try {
      const netLoss = pnl + rewardsClaimed;
      if (netLoss >= 0) { await interaction.editReply(`❌ **${username}** is in profit. Cannot claim lossback when in profit.\n\nNet P&L: $${netLoss.toFixed(2)}`); return; }

      let tierName = '', percentage = 0, maxPayout = 0;
      if (wagerAmount >= 0 && wagerAmount <= 99999) { tierName = 'Tier 1'; percentage = 5; maxPayout = 100; }
      else if (wagerAmount >= 100000 && wagerAmount <= 499999) { tierName = 'Tier 2'; percentage = 10; maxPayout = 200; }
      else if (wagerAmount >= 500000) { tierName = 'Tier 3'; percentage = 15; maxPayout = 300; }

      const lossbackOwed = Math.abs(netLoss) * (percentage / 100);
      const finalPayout = Math.min(lossbackOwed, maxPayout);
      const userLossbackClaims = await getRewardsByFilter(username, 'lossback', period);

      let eligibilityStatus = '✅ ELIGIBLE', eligibilityNote = '';
      if (userLossbackClaims.length === 0) {
        if (netLoss > -300) { eligibilityStatus = '❌ INELIGIBLE'; eligibilityNote = `\n\n**Not eligible yet.** Need $${(300 - Math.abs(netLoss)).toFixed(2)} more net loss to claim.\n(Minimum -$300 net loss required for first claim)`; }
      } else {
        const lastClaim = userLossbackClaims[userLossbackClaims.length - 1];
        const lastClaimNetLoss = lastClaim.net_loss || 0;
        const requiredNetLoss = lastClaimNetLoss - 300;
        if (netLoss > requiredNetLoss) { eligibilityStatus = '❌ INELIGIBLE'; eligibilityNote = `\n\n**Not eligible yet.** Need $${Math.abs(requiredNetLoss - netLoss).toFixed(2)} more net loss to claim again.\n(Last claim at $${lastClaimNetLoss.toFixed(2)}. Need $${requiredNetLoss.toFixed(2)})`; }
      }

      const claimsHistory = userLossbackClaims.length > 0
        ? `\n\n**Previous Claims in Period ${period}:**\n${userLossbackClaims.map((c, i) => `Claim #${i + 1}: $${parseFloat(c.amount).toFixed(2)} (Net Loss: $${parseFloat(c.net_loss).toFixed(2)})`).join('\n')}`
        : '';

      await interaction.editReply(`
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
      `.trim());
    } catch (error) {
      console.error('Error in lossback command:', error);
      await interaction.editReply('❌ An error occurred while calculating lossback.');
    }
  }

  if (interaction.commandName === 'claim') {
    if (interaction.user.id !== OWNER_DISCORD_ID) { await interaction.reply({ content: '❌ This command is owner-only.', ephemeral: true }); return; }
    const username = interaction.options.getString('username');
    const rewardType = interaction.options.getString('reward_type');
    const site = interaction.options.getString('site');
    const amount = interaction.options.getNumber('amount');
    const period = interaction.options.getInteger('period');
    const netLoss = interaction.options.getNumber('net_loss');
    await interaction.deferReply({ ephemeral: false });
    try {
      await saveReward({
        username, reward_type: rewardType, amount, period,
        claimed_by: interaction.user.id, timestamp: new Date().toISOString(),
        net_loss: (rewardType === 'lossback' && netLoss !== null) ? netLoss : null, site
      });
      const rewardTypeNames = { lossback: 'Lossback', wagerbonus: 'Wager Bonus', depobonus: 'Deposit Bonus', gw: 'Giveaway' };
      const siteLabel = site.charAt(0).toUpperCase() + site.slice(1);
      const netLossNote = (rewardType === 'lossback' && netLoss !== null) ? `\n(Net Loss: $${netLoss.toFixed(2)})` : '';
      await interaction.editReply(`✅ Successfully recorded **$${amount.toFixed(2)} ${rewardTypeNames[rewardType]}** for **${username}** on **${siteLabel}** in Period ${period}${netLossNote}`);
    } catch (error) {
      console.error('Error in claim command:', error);
      await interaction.editReply('❌ An error occurred while recording the claim.');
    }
  }

  if (interaction.commandName === 'claimed') {
    const username = interaction.options.getString('username');
    const rewardType = interaction.options.getString('reward_type');
    const period = interaction.options.getInteger('period');
    const site = interaction.options.getString('site');
    await interaction.deferReply({ ephemeral: false });
    try {
      const rewardTypeNames = { lossback: 'Lossback', wagerbonus: 'Wager Bonus', depobonus: 'Deposit Bonus', gw: 'Giveaway' };

      if (rewardType === 'all') {
        const types = ['lossback', 'wagerbonus', 'depobonus', 'gw'];
        const sites = [{ value: 'acebet', label: '🔵 Acebet' }, { value: 'packdraw', label: '🟣 Packdraw' }];
        let grandTotal = 0, hasAnyClaims = false, fullBreakdown = '';

        for (const s of sites) {
          let siteTotal = 0, siteBreakdown = '';
          for (const type of types) {
            const claims = await getRewardsByFilter(username, type, period, s.value);
            if (claims.length > 0) {
              const typeTotal = claims.reduce((sum, c) => sum + parseFloat(c.amount), 0);
              siteTotal += typeTotal;
              siteBreakdown += `💠 **${rewardTypeNames[type]}:** $${typeTotal.toFixed(2)} (${claims.length} claim${claims.length > 1 ? 's' : ''})\n`;
            }
          }
          if (siteBreakdown) { hasAnyClaims = true; grandTotal += siteTotal; fullBreakdown += `${s.label}\n${siteBreakdown}Subtotal: $${siteTotal.toFixed(2)}\n\n`; }
        }

        if (!hasAnyClaims) { await interaction.editReply(`📊 No claims found for **${username}** in Period ${period}`); return; }
        await interaction.editReply(`📊 **All Claims - Period ${period}**\nUsername: **${username}**\n\n${fullBreakdown}💰 **Total Redeemed: $${grandTotal.toFixed(2)}**`);
      } else {
        if (!site) { await interaction.editReply('❌ Please select a site when viewing a specific reward type.'); return; }
        const siteLabel = site.charAt(0).toUpperCase() + site.slice(1);
        const claims = await getRewardsByFilter(username, rewardType, period, site);
        if (claims.length === 0) { await interaction.editReply(`📊 No ${rewardTypeNames[rewardType]} claims found for **${username}** on **${siteLabel}** in Period ${period}`); return; }
        const total = claims.reduce((sum, claim) => sum + parseFloat(claim.amount), 0);
        const claimsList = claims.map((claim, index) => {
          const formattedDate = new Date(claim.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York' });
          return `**Claim #${index + 1}:** $${parseFloat(claim.amount).toFixed(2)} on ${formattedDate} EST`;
        }).join('\n');
        await interaction.editReply(`📊 **${rewardTypeNames[rewardType]} Claims [${siteLabel}] - Period ${period}**\nUsername: **${username}**\n\n${claimsList}\n\n💰 **Total Claimed This Period:** $${total.toFixed(2)}`);
      }
    } catch (error) {
      console.error('Error in claimed command:', error);
      await interaction.editReply('❌ An error occurred while fetching claim history.');
    }
  }
});

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`[boot] ACEBET_API_TOKEN defined: ${!!ACEBET_API_TOKEN}`);
  console.log(`[boot] WAGER_WINDOW_START: ${WAGER_WINDOW_START}`);
  await initDatabase();
  cron.schedule('0 10 * * 0', () => { console.log('Running weekly summary...'); sendWeeklySummary(); }, { timezone: "America/New_York" });
  console.log('📅 Weekly summary scheduled for Sundays at 10:00 AM EST');
});

client.login(DISCORD_TOKEN).then(() => { registerCommands(); });
