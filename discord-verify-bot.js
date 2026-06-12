const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
const { Pool } = require('pg');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fetch = require('node-fetch');
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

// Cloudflare bypass headers
const CF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept": "application/json",
  "Referer": "https://acebet.co/",
};

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
    await pool.query(`ALTER TABLE rewards ADD COLUMN IF NOT EXISTS site VARCHAR(50) DEFAULT 'acebet'`);
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

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const ACEBET_API_TOKEN = process.env.ACEBET_API_TOKEN || process.env.ACEBET_TOKEN;
const WAGER_WINDOW_START = process.env.WAGER_WINDOW_START || '2025-01-01';
const OWNER_DISCORD_ID = '687823175647887394';

// All reward types (Acebet only)
const REWARD_TYPE_NAMES = {
  lossback: 'Lossback',
  wagerbonus: 'Wager Bonus',
  depobonus: 'Deposit Bonus',
  gw: 'Giveaway',
  vip: 'VIP Deal',
  slottournament: 'Slot Tournament',
  rewardmatch: 'Reward Match',
  raffle: 'Raffle'
};

const REWARD_TYPE_CHOICES = [
  { name: 'Lossback', value: 'lossback' },
  { name: 'Wager Bonus', value: 'wagerbonus' },
  { name: 'Deposit Bonus', value: 'depobonus' },
  { name: 'Giveaway', value: 'gw' },
  { name: 'VIP Deal', value: 'vip' },
  { name: 'Slot Tournament', value: 'slottournament' },
  { name: 'Reward Match', value: 'rewardmatch' },
  { name: 'Raffle', value: 'raffle' },
];

const REWARD_TYPE_CHOICES_WITH_ALL = [
  ...REWARD_TYPE_CHOICES,
  { name: 'All', value: 'all' },
];

async function loadLinks() {
  try {
    const result = await pool.query('SELECT * FROM user_links');
    const links = {};
    result.rows.forEach(row => { links[row.discord_id] = row.acebet_username; });
    return links;
  } catch (error) {
    console.error('Error loading links:', error);
    return {};
  }
}

async function saveLink(discordId, acebetUsername) {
  try {
    await pool.query(
      `INSERT INTO user_links (discord_id, acebet_username) VALUES ($1, $2)
       ON CONFLICT (discord_id) DO UPDATE SET acebet_username = $2`,
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
    const query = `
      INSERT INTO rewards (username, reward_type, amount, period, net_loss, claimed_by, timestamp, site)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *
    `;
    const values = [
      reward.username, reward.reward_type, reward.amount, reward.period,
      reward.net_loss || null, reward.claimed_by,
      reward.timestamp || new Date().toISOString(), reward.site || 'acebet'
    ];
    const result = await pool.query(query, values);
    return result.rows[0];
  } catch (error) {
    console.error('Error saving reward:', error);
    return null;
  }
}

async function getRewardsByFilter(username, rewardType, period) {
  try {
    let query, params;
    if (rewardType === 'all') {
      query = `SELECT * FROM rewards WHERE LOWER(username) = LOWER($1) AND period = $2 ORDER BY timestamp ASC`;
      params = [username, period];
    } else {
      query = `SELECT * FROM rewards WHERE LOWER(username) = LOWER($1) AND reward_type = $2 AND period = $3 ORDER BY timestamp ASC`;
      params = [username, rewardType, period];
    }
    const result = await pool.query(query, params);
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
      return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
    };
    const userStats = {};
    for (let d = new Date(lastSunday); d <= lastSaturday; d.setDate(d.getDate() + 1)) {
      const dateStr = formatDate(d);
      const url = `https://api.acebet.co/affiliates/detailed-summary/v2/${dateStr}`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${ACEBET_API_TOKEN}`, ...CF_HEADERS },
        cache: "no-store", ...(proxyAgent ? { agent: proxyAgent } : {}),
      });
      if (response.ok) {
        const snapshot = await response.json();
        snapshot.forEach(user => {
          if (!userStats[user.userId]) {
            userStats[user.userId] = { active: user.active, minWagered: user.wagered||0, maxWagered: user.wagered||0, minDeposited: user.deposited||0, maxDeposited: user.deposited||0, minEarned: user.earned||0, maxEarned: user.earned||0 };
          }
          userStats[user.userId].minWagered = Math.min(userStats[user.userId].minWagered, user.wagered||0);
          userStats[user.userId].maxWagered = Math.max(userStats[user.userId].maxWagered, user.wagered||0);
          userStats[user.userId].minDeposited = Math.min(userStats[user.userId].minDeposited, user.deposited||0);
          userStats[user.userId].maxDeposited = Math.max(userStats[user.userId].maxDeposited, user.deposited||0);
          userStats[user.userId].minEarned = Math.min(userStats[user.userId].minEarned, user.earned||0);
          userStats[user.userId].maxEarned = Math.max(userStats[user.userId].maxEarned, user.earned||0);
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
      weekStart: formatDate(lastSunday), weekEnd: formatDate(lastSaturday),
      totalWagered: totalWagered/100, totalDeposits: totalDeposits/100,
      affiliateIncome: totalEarned/100, activeMembers: activeCount,
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
    const message = `📊 **R2K2 Weekly Summary**\nWeek: ${stats.weekStart} to ${stats.weekEnd}\n\n💰 **Total Wagered:** $${stats.totalWagered.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}\n💳 **Total Deposits:** $${stats.totalDeposits.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}\n👥 **Active Referrals:** ${stats.activeMembers}\n💵 **Affiliate Income:** $${stats.affiliateIncome.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
    await owner.send(message);
    console.log('Weekly summary sent successfully!');
  } catch (error) {
    console.error('Error sending weekly summary:', error);
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function getAcebetUsers() {
  try {
    const url = `https://api.acebet.co/affiliates/detailed-summary/v2/${WAGER_WINDOW_START}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${ACEBET_API_TOKEN}`, ...CF_HEADERS },
      cache: "no-store", ...(proxyAgent ? { agent: proxyAgent } : {}),
    });
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error('Error fetching Acebet users:', error);
    throw error;
  }
}

async function checkUserActive(username) {
  try {
    const users = await getAcebetUsers();
    const user = users.find(u => u.name && u.name.toLowerCase() === username.toLowerCase());
    if (!user) return { found: false };
    return { found: true, active: user.active, wagered: user.wagered, deposited: user.deposited, lastSeen: user.lastSeen };
  } catch (error) {
    return { found: false };
  }
}

function getPeriodDates(period) {
  const periodStartBase = new Date('2025-12-26');
  const startDate = new Date(periodStartBase);
  startDate.setDate(startDate.getDate() + ((period - 1) * 30));
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + 29);
  const formatDate = (date) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  return { startDate, endDate, startDateStr: formatDate(startDate), endDateStr: formatDate(endDate), formatDate };
}

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('acebet').setDescription('Check if an Acebet user is active under code R2K2')
      .addStringOption(o => o.setName('username').setDescription('Acebet username').setRequired(true)),
    new SlashCommandBuilder()
      .setName('wager').setDescription('Get wager report for an Acebet user by period')
      .addStringOption(o => o.setName('username').setDescription('Acebet username').setRequired(true))
      .addIntegerOption(o => o.setName('period').setDescription('Period number (1-12)').setRequired(true).setMinValue(1).setMaxValue(12)),
    new SlashCommandBuilder()
      .setName('link').setDescription('Link your Discord account to your Acebet username')
      .addStringOption(o => o.setName('acebet_username').setDescription('Your Acebet username').setRequired(true)),
    new SlashCommandBuilder()
      .setName('linkuser').setDescription('Manually link a Discord user to an Acebet username (Staff only)')
      .addUserOption(o => o.setName('discord_user').setDescription('Discord user to link').setRequired(true))
      .addStringOption(o => o.setName('acebet_username').setDescription('Acebet username').setRequired(true)),
    new SlashCommandBuilder()
      .setName('unlink').setDescription('Unlink your Discord account from your Acebet username'),
    new SlashCommandBuilder()
      .setName('unlinkuser').setDescription('Manually unlink a Discord user (Staff only)')
      .addUserOption(o => o.setName('discord_user').setDescription('Discord user to unlink').setRequired(true)),
    new SlashCommandBuilder()
      .setName('checklink').setDescription('Check which Acebet account a Discord user is linked to (Staff only)')
      .addUserOption(o => o.setName('discord_user').setDescription('Discord user to check').setRequired(true)),
    new SlashCommandBuilder().setName('summary').setDescription('Get weekly stats summary (Owner only)'),
    new SlashCommandBuilder().setName('exportrewards').setDescription('Export rewards data as JSON file (Owner only)'),
    new SlashCommandBuilder().setName('setupdb').setDescription('Manually initialize database tables (Owner only)'),
    new SlashCommandBuilder()
      .setName('periodstats').setDescription('View period statistics (Owner only)')
      .addIntegerOption(o => o.setName('period').setDescription('Period number (1-12)').setRequired(true).setMinValue(1).setMaxValue(12)),
    new SlashCommandBuilder()
      .setName('lossback').setDescription('Calculate lossback owed for a user (Staff/Owner only)')
      .addStringOption(o => o.setName('username').setDescription('Acebet username').setRequired(true))
      .addNumberOption(o => o.setName('pnl').setDescription('P&L amount (use negative for loss, e.g., -500)').setRequired(true))
      .addNumberOption(o => o.setName('rewards_claimed').setDescription('Total rewards this period (excluding leaderboard payments)').setRequired(true))
      .addNumberOption(o => o.setName('wager_amount').setDescription('Total wager for this period').setRequired(true))
      .addIntegerOption(o => o.setName('period').setDescription('Period number (1-12)').setRequired(true).setMinValue(1).setMaxValue(12)),
    new SlashCommandBuilder()
      .setName('claim').setDescription('Record a reward payment (Owner only)')
      .addStringOption(o => o.setName('username').setDescription('Acebet username').setRequired(true))
      .addStringOption(o => o.setName('reward_type').setDescription('Type of reward').setRequired(true).addChoices(...REWARD_TYPE_CHOICES))
      .addNumberOption(o => o.setName('amount').setDescription('Amount being paid').setRequired(true))
      .addIntegerOption(o => o.setName('period').setDescription('Period number (1-12)').setRequired(true).setMinValue(1).setMaxValue(12))
      .addNumberOption(o => o.setName('net_loss').setDescription('Net loss value (for lossback only)').setRequired(false)),
    new SlashCommandBuilder()
      .setName('claimed').setDescription('View claim history for a user (Staff/Owner only)')
      .addStringOption(o => o.setName('username').setDescription('Acebet username').setRequired(true))
      .addStringOption(o => o.setName('reward_type').setDescription('Type of reward').setRequired(true).addChoices(...REWARD_TYPE_CHOICES_WITH_ALL))
      .addStringOption(o => o.setName('period').setDescription('Period number or all').setRequired(true).addChoices(
        { name: 'All Periods', value: 'all' },
        ...Array.from({length: 12}, (_, i) => ({ name: `Period ${i+1}`, value: String(i+1) }))
      )),
    new SlashCommandBuilder()
      .setName('payouts').setDescription('Detailed payout breakdown for a period (Owner only)')
      .addStringOption(o => o.setName('period').setDescription('Period number or all').setRequired(true).addChoices(
        { name: 'All Periods', value: 'all' },
        ...Array.from({length: 12}, (_, i) => ({ name: `Period ${i+1}`, value: String(i+1) }))
      )),
    new SlashCommandBuilder()
      .setName('giveaway').setDescription('Start a giveaway (Owner only)')
      .addStringOption(o => o.setName('prize').setDescription('What are you giving away?').setRequired(true))
      .addIntegerOption(o => o.setName('duration').setDescription('Duration in minutes').setRequired(true).setMinValue(1).setMaxValue(10080))
      .addChannelOption(o => o.setName('channel').setDescription('Channel to post the giveaway in').setRequired(true))
      .addRoleOption(o => o.setName('role').setDescription('Required role to enter').setRequired(true)),
  ].map(command => command.toJSON());

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: [] });
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('✅ Commands registered.');
  } catch (error) {
    console.error('Error registering commands:', error);
  }
}

// In-memory giveaway store: messageId -> { prize, endsAt, roleId, channelId, entries: Set<userId>, messageId }
const giveaways = new Map();

async function rollGiveawayWinner(messageId, channel) {
  const gw = giveaways.get(messageId);
  if (!gw) return;
  giveaways.delete(messageId);

  try {
    const msg = await channel.messages.fetch(messageId);
    const disabledBtn = new ButtonBuilder().setCustomId('giveaway_enter').setLabel('🎉 Giveaway Ended').setStyle(ButtonStyle.Secondary).setDisabled(true);
    const row = new ActionRowBuilder().addComponents(disabledBtn);

    if (gw.entries.size === 0) {
      const embed = new EmbedBuilder().setTitle(`🎉 GIVEAWAY — ${gw.prize}`).setColor(0x888888).setDescription(`**No entries!** No winner this time.`).setTimestamp();
      await msg.edit({ embeds: [embed], components: [row] });
      await channel.send(`😢 The giveaway for **${gw.prize}** ended with no entries.`);
      return;
    }

    const entriesArr = [...gw.entries];
    const winnerId = entriesArr[Math.floor(Math.random() * entriesArr.length)];
    const embed = new EmbedBuilder().setTitle(`🎉 GIVEAWAY — ${gw.prize}`).setColor(0x00FF00).setDescription(`**Winner: <@${winnerId}>** 🏆\n\n**Total Entries:** ${gw.entries.size}`).setTimestamp();
    await msg.edit({ embeds: [embed], components: [row] });
    await channel.send(`🎉 Congratulations <@${winnerId}>! You won **${gw.prize}**!`);
  } catch (err) {
    console.error('[giveaway] Error rolling winner:', err);
  }
}

client.on('interactionCreate', async interaction => {
  // ── GIVEAWAY ENTER BUTTON ─────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === 'giveaway_enter') {
    const gw = giveaways.get(interaction.message.id);
    if (!gw) {
      await interaction.reply({ content: '❌ This giveaway has already ended.', ephemeral: true });
      return;
    }
    if (Date.now() > gw.endsAt.getTime()) {
      await interaction.reply({ content: '❌ This giveaway has ended.', ephemeral: true });
      return;
    }
    const member = interaction.member;
    if (!member.roles.cache.has(gw.roleId)) {
      await interaction.reply({ content: `❌ You need the <@&${gw.roleId}> role to enter this giveaway.`, ephemeral: true });
      return;
    }
    if (gw.entries.has(interaction.user.id)) {
      await interaction.reply({ content: '✅ You\'re already entered!', ephemeral: true });
      return;
    }
    gw.entries.add(interaction.user.id);

    // Update embed entry count
    try {
      const embed = new EmbedBuilder()
        .setTitle(`🎉 GIVEAWAY — ${gw.prize}`)
        .setColor(0xFFD700)
        .setDescription(`Click **Enter** to join!\n\n**Required Role:** <@&${gw.roleId}>\n**Entries:** ${gw.entries.size}\n**Ends:** <t:${Math.floor(gw.endsAt.getTime()/1000)}:R>`)
        .setFooter({ text: `Ends at` })
        .setTimestamp(gw.endsAt);
      await interaction.message.edit({ embeds: [embed] });
    } catch (err) {
      console.error('[giveaway] Error updating embed:', err);
    }
    await interaction.reply({ content: `✅ You've entered the giveaway for **${gw.prize}**! Good luck! 🎉`, ephemeral: true });
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const staffOnlyCommands = ['acebet', 'wager', 'linkuser', 'unlinkuser', 'checklink', 'lossback', 'claimed'];
  if (staffOnlyCommands.includes(interaction.commandName)) {
    const hasPermission = interaction.member.roles.cache.some(role =>
      ['staff', 'owner'].some(r => role.name.toLowerCase() === r)
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
      if (result.error || !result.found) { await interaction.editReply(`❌ **${username}** is Inactive`); return; }

      await interaction.editReply(result.active ? `✅ **${username}** is Active` : `❌ **${username}** is Inactive`);
    } catch (error) {
      await interaction.editReply('❌ An error occurred while verifying the user.');
    }
  }

  if (interaction.commandName === 'wager') {
    const username = interaction.options.getString('username');
    const period = interaction.options.getInteger('period');
    await interaction.deferReply();
    try {
      const { startDate, endDate, startDateStr, endDateStr, formatDate } = getPeriodDates(period);
      let userFound = false, maxWagered = 0, minWagered = Infinity, userName = username;
      for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
        const dateStr = formatDate(d);
        const url = `https://api.acebet.co/affiliates/detailed-summary/v2/${dateStr}`;
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${ACEBET_API_TOKEN}`, ...CF_HEADERS },
          cache: "no-store", ...(proxyAgent ? { agent: proxyAgent } : {}),
        });
        if (response.ok) {
          const snapshot = await response.json();
          const user = snapshot.find(u => u.name?.toLowerCase() === username.toLowerCase());
          if (user) {
            userFound = true; userName = user.name;
            if (user.wagered > maxWagered) maxWagered = user.wagered;
            if (user.wagered < minWagered) minWagered = user.wagered;
          }
        }
      }
      if (!userFound) { await interaction.editReply(`❌ User **${username}** not found under code R2K2 for this period`); return; }
      const wagerInDollars = (maxWagered - (minWagered === Infinity ? 0 : minWagered)) / 100;
      await interaction.editReply(`**${userName} Wager Report**\nPeriod ${period}: ${startDateStr} - ${endDateStr}\nTotal Wagered: $${wagerInDollars.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`);
    } catch (error) {
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
      await interaction.editReply('❌ An error occurred while checking the link.');
    }
  }

  if (interaction.commandName === 'summary') {
    if (interaction.user.id !== OWNER_DISCORD_ID) { await interaction.reply({ content: '❌ Owner only.', ephemeral: true }); return; }
    await interaction.deferReply({ ephemeral: true });
    try {
      const stats = await getWeeklyStats();
      const message = `📊 **R2K2 Weekly Summary**\nWeek: ${stats.weekStart} to ${stats.weekEnd}\n\n💰 **Total Wagered:** $${stats.totalWagered.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}\n💳 **Total Deposits:** $${stats.totalDeposits.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}\n👥 **Active Referrals:** ${stats.activeMembers}\n💵 **Affiliate Income:** $${stats.affiliateIncome.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
      await interaction.editReply(message);
      await interaction.user.send(message);
    } catch (error) {
      await interaction.editReply('❌ An error occurred while generating the summary.');
    }
  }

  if (interaction.commandName === 'exportrewards') {
    if (interaction.user.id !== OWNER_DISCORD_ID) { await interaction.reply({ content: '❌ Owner only.', ephemeral: true }); return; }
    await interaction.deferReply({ ephemeral: true });
    try {
      const rewardsData = await loadRewards();
      const buffer = Buffer.from(JSON.stringify(rewardsData, null, 2), 'utf-8');
      const { AttachmentBuilder } = require('discord.js');
      const attachment = new AttachmentBuilder(buffer, { name: 'acebet_rewards.json' });
      await interaction.editReply({ content: `📊 Rewards data exported (${rewardsData.rewards.length} total claims)`, files: [attachment] });
    } catch (error) {
      await interaction.editReply('❌ An error occurred while exporting rewards data.');
    }
  }

  if (interaction.commandName === 'setupdb') {
    if (interaction.user.id !== OWNER_DISCORD_ID) { await interaction.reply({ content: '❌ Owner only.', ephemeral: true }); return; }
    await interaction.deferReply({ ephemeral: true });
    try {
      await initDatabase();
      await interaction.editReply('✅ Database tables created successfully!');
    } catch (error) {
      await interaction.editReply('❌ An error occurred: ' + error.message);
    }
  }

  if (interaction.commandName === 'periodstats') {
    if (interaction.user.id !== OWNER_DISCORD_ID) { await interaction.reply({ content: '❌ Owner only.', ephemeral: true }); return; }
    const period = interaction.options.getInteger('period');
    await interaction.deferReply({ ephemeral: true });
    try {
      const result = await pool.query('SELECT * FROM rewards WHERE period = $1 ORDER BY timestamp DESC', [period]);
      const claims = result.rows;
      if (claims.length === 0) { await interaction.editReply(`📊 No claims found for Period ${period}`); return; }
      const userClaimCounts = {}, userClaimTotals = {}, rewardTypeTotals = {};
      claims.forEach(claim => {
        const amount = parseFloat(claim.amount);
        userClaimCounts[claim.username] = (userClaimCounts[claim.username] || 0) + 1;
        userClaimTotals[claim.username] = (userClaimTotals[claim.username] || 0) + amount;
        rewardTypeTotals[claim.reward_type] = (rewardTypeTotals[claim.reward_type] || 0) + amount;
      });
      const mostClaimsUser = Object.entries(userClaimCounts).sort((a,b) => b[1]-a[1])[0];
      const mostClaimedUser = Object.entries(userClaimTotals).sort((a,b) => b[1]-a[1])[0];
      const mostClaimedCategory = Object.entries(rewardTypeTotals).sort((a,b) => b[1]-a[1])[0];
      const rewardTypeBreakdown = Object.entries(rewardTypeTotals).map(([type, total]) => `• ${REWARD_TYPE_NAMES[type]||type}: $${total.toFixed(2)}`).join('\n');
      const message = `📊 **Period ${period} Statistics**\n\n👤 **Most Claims:** **${mostClaimsUser[0]}** with ${mostClaimsUser[1]} claim${mostClaimsUser[1]>1?'s':''}\n💰 **Most Claimed ($):** **${mostClaimedUser[0]}** with $${mostClaimedUser[1].toFixed(2)}\n💵 **Total Paid Per Reward Type:**\n${rewardTypeBreakdown}\n🏆 **Most Claimed Category:** **${REWARD_TYPE_NAMES[mostClaimedCategory[0]]||mostClaimedCategory[0]}** ($${mostClaimedCategory[1].toFixed(2)})\n📈 **Overall:** Total Claims: ${claims.length} | Total Paid: $${Object.values(rewardTypeTotals).reduce((a,b)=>a+b,0).toFixed(2)} | Unique Users: ${Object.keys(userClaimCounts).length}`;
      await interaction.editReply(message);
    } catch (error) {
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

      // New tier structure — 10% flat for everyone, cap based on monthly wager
      const percentage = 10;
      let tierLabel = '', maxPayout = 0;
      if (wagerAmount >= 0 && wagerAmount <= 50000) { tierLabel = '$0–$50,000'; maxPayout = 100; }
      else if (wagerAmount <= 99999) { tierLabel = '$50,001–$99,999'; maxPayout = 200; }
      else if (wagerAmount <= 249999) { tierLabel = '$100,000–$249,999'; maxPayout = 300; }
      else if (wagerAmount <= 499999) { tierLabel = '$250,000–$499,999'; maxPayout = 500; }
      else { tierLabel = '$500,001–$1,000,000'; maxPayout = 750; }

      const lossbackOwed = Math.abs(netLoss) * (percentage / 100);
      const calculatedPayout = Math.min(lossbackOwed, maxPayout);

      // Fetch all lossback claims for this user this period
      const userLossbackClaims = await getRewardsByFilter(username, 'lossback', period);
      const totalAlreadyClaimed = userLossbackClaims.reduce((sum, c) => sum + parseFloat(c.amount), 0);
      const remainingCap = Math.max(0, maxPayout - totalAlreadyClaimed);
      const finalPayout = Math.min(calculatedPayout, remainingCap);

      // Build claims history block
      let claimsBlock = '';
      if (userLossbackClaims.length > 0) {
        const claimLines = userLossbackClaims.map((c, i) => {
          const date = new Date(c.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York' });
          return `  Claim #${i+1}: $${parseFloat(c.amount).toFixed(2)} — ${date} EST`;
        }).join('\n');
        claimsBlock = `\n\n📋 **Claims This Period (${period}):**\n${claimLines}\n• Total Claimed: $${totalAlreadyClaimed.toFixed(2)}\n• Remaining Cap: $${remainingCap.toFixed(2)} of $${maxPayout} max`;
      } else {
        claimsBlock = `\n\n📋 **Claims This Period (${period}):** None yet`;
      }

      // Eligibility
      let eligibilityStatus = '', eligibilityNote = '';
      if (remainingCap <= 0) {
        eligibilityStatus = '🚫 CAP REACHED';
        eligibilityNote = `\n**${username} has already claimed the full $${maxPayout} cap for this wager tier this period.**`;
      } else if (finalPayout <= 0) {
        eligibilityStatus = '❌ INELIGIBLE';
        eligibilityNote = `\n**No lossback owed** — net loss too low for a payout at 10%.`;
      } else {
        eligibilityStatus = '✅ ELIGIBLE';
      }

      await interaction.editReply(`**Lossback Calculation — Period ${period}**\nUsername: **${username}**\n\n📊 **Net Loss Calculation:**\n• P&L: $${pnl.toFixed(2)}\n• Rewards Claimed: $${rewardsClaimed.toFixed(2)}\n• **Net Loss: $${netLoss.toFixed(2)}**\n\n💰 **Wager Tier:**\n• Total Wager: $${wagerAmount.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}\n• Bracket: ${tierLabel}\n• Rate: 10% — Monthly Cap: $${maxPayout}\n\n🎯 **Lossback:**\n• $${Math.abs(netLoss).toFixed(2)} × 10% = $${lossbackOwed.toFixed(2)}\n• Capped at $${maxPayout} (tier max)\n• Already Claimed: $${totalAlreadyClaimed.toFixed(2)}\n• **Eligible Now: $${finalPayout.toFixed(2)}**${claimsBlock}\n\n${eligibilityStatus}${eligibilityNote}`.trim());
    } catch (error) {
      await interaction.editReply('❌ An error occurred while calculating lossback.');
    }
  }

  if (interaction.commandName === 'claim') {
    if (interaction.user.id !== OWNER_DISCORD_ID) { await interaction.reply({ content: '❌ Owner only.', ephemeral: true }); return; }
    const username = interaction.options.getString('username');
    const rewardType = interaction.options.getString('reward_type');
    const amount = interaction.options.getNumber('amount');
    const period = interaction.options.getInteger('period');
    const netLoss = interaction.options.getNumber('net_loss');
    await interaction.deferReply({ ephemeral: false });
    try {
      await saveReward({
        username, reward_type: rewardType, amount, period,
        claimed_by: interaction.user.id, timestamp: new Date().toISOString(),
        net_loss: (rewardType === 'lossback' && netLoss !== null) ? netLoss : null,
        site: 'acebet'
      });
      const netLossNote = (rewardType === 'lossback' && netLoss !== null) ? `\n(Net Loss: $${netLoss.toFixed(2)})` : '';
      await interaction.editReply(`✅ Successfully recorded **$${amount.toFixed(2)} ${REWARD_TYPE_NAMES[rewardType]}** for **${username}** on **Acebet** in Period ${period}${netLossNote}`);
    } catch (error) {
      await interaction.editReply('❌ An error occurred while recording the claim.');
    }
  }

  if (interaction.commandName === 'claimed') {
    const username = interaction.options.getString('username');
    const rewardType = interaction.options.getString('reward_type');
    const periodRaw = interaction.options.getString('period');
    const period = periodRaw === 'all' ? 'all' : parseInt(periodRaw);
    await interaction.deferReply({ ephemeral: false });
    try {
      // Build query based on period + rewardType
      let claims;
      if (period === 'all' && rewardType === 'all') {
        const result = await pool.query(`SELECT * FROM rewards WHERE LOWER(username) = LOWER($1) ORDER BY period ASC, timestamp ASC`, [username]);
        claims = result.rows;
      } else if (period === 'all') {
        const result = await pool.query(`SELECT * FROM rewards WHERE LOWER(username) = LOWER($1) AND reward_type = $2 ORDER BY period ASC, timestamp ASC`, [username, rewardType]);
        claims = result.rows;
      } else {
        claims = await getRewardsByFilter(username, rewardType, period);
      }

      if (claims.length === 0) {
        const periodLabel = period === 'all' ? 'any period' : `Period ${period}`;
        await interaction.editReply(`📊 No claims found for **${username}** in ${periodLabel}`);
        return;
      }

      const byType = {};
      const byPeriod = {};
      claims.forEach(c => {
        const t = c.reward_type;
        const p = c.period;
        if (!byType[t]) byType[t] = { total: 0, count: 0 };
        byType[t].total += parseFloat(c.amount);
        byType[t].count++;
        if (!byPeriod[p]) byPeriod[p] = 0;
        byPeriod[p] += parseFloat(c.amount);
      });
      const grandTotal = claims.reduce((sum, c) => sum + parseFloat(c.amount), 0);

      if (period === 'all') {
        // Show breakdown by period and by type
        let periodBreakdown = '';
        for (const [p, total] of Object.entries(byPeriod).sort((a,b) => a[0]-b[0])) {
          periodBreakdown += `📅 **Period ${p}:** $${total.toFixed(2)}\n`;
        }
        let typeBreakdown = '';
        for (const [type, data] of Object.entries(byType)) {
          typeBreakdown += `💠 **${REWARD_TYPE_NAMES[type]||type}:** $${data.total.toFixed(2)} (${data.count} claim${data.count>1?'s':''})\n`;
        }
        const periodLabel = rewardType === 'all' ? 'All Types' : REWARD_TYPE_NAMES[rewardType]||rewardType;
        await interaction.editReply(`📊 **All-Time Claims — ${periodLabel}**\nUsername: **${username}**\n\n**By Period:**\n${periodBreakdown}\n**By Type:**\n${typeBreakdown}\n💰 **Total All-Time: $${grandTotal.toFixed(2)}** (${claims.length} claims)`);
      } else if (rewardType === 'all') {
        let breakdown = '';
        for (const [type, data] of Object.entries(byType)) {
          breakdown += `💠 **${REWARD_TYPE_NAMES[type]||type}:** $${data.total.toFixed(2)} (${data.count} claim${data.count>1?'s':''})\n`;
        }
        await interaction.editReply(`📊 **All Claims - Period ${period}**\nUsername: **${username}**\n\n${breakdown}\n💰 **Total Redeemed: $${grandTotal.toFixed(2)}**`);
      } else {
        const claimsList = claims.map((c, i) => {
          const date = new Date(c.timestamp).toLocaleString('en-US', { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit', hour12:true, timeZone:'America/New_York' });
          return `**Claim #${i+1}:** $${parseFloat(c.amount).toFixed(2)} on ${date} EST`;
        }).join('\n');
        await interaction.editReply(`📊 **${REWARD_TYPE_NAMES[rewardType]} Claims - Period ${period}**\nUsername: **${username}**\n\n${claimsList}\n\n💰 **Total Claimed This Period:** $${grandTotal.toFixed(2)}`);
      }
    } catch (error) {
      await interaction.editReply('❌ An error occurred while fetching claim history.');
    }
  }

  if (interaction.commandName === 'payouts') {
    if (interaction.user.id !== OWNER_DISCORD_ID) { await interaction.reply({ content: '❌ Owner only.', ephemeral: true }); return; }
    const periodRaw = interaction.options.getString('period');
    const period = periodRaw === 'all' ? 'all' : parseInt(periodRaw);
    await interaction.deferReply({ ephemeral: true });
    try {
      let claims, periodLabel;
      if (period === 'all') {
        const result = await pool.query('SELECT * FROM rewards ORDER BY period ASC, username ASC, timestamp ASC');
        claims = result.rows;
        periodLabel = 'All Periods';
      } else {
        const { startDateStr, endDateStr } = getPeriodDates(period);
        const result = await pool.query('SELECT * FROM rewards WHERE period = $1 ORDER BY username ASC, timestamp ASC', [period]);
        claims = result.rows;
        periodLabel = `Period ${period} (${startDateStr} – ${endDateStr})`;
      }
      if (claims.length === 0) { await interaction.editReply(`📊 No payouts recorded for ${periodLabel}`); return; }
      const categoryTotals = {}, categoryCounts = {}, userTotals = {}, userClaims = {}, periodTotals = {};
      for (const claim of claims) {
        const amount = parseFloat(claim.amount);
        const type = claim.reward_type;
        const user = claim.username;
        const p = claim.period;
        categoryTotals[type] = (categoryTotals[type] || 0) + amount;
        categoryCounts[type] = (categoryCounts[type] || 0) + 1;
        if (!userTotals[user]) userTotals[user] = 0;
        userTotals[user] += amount;
        if (!userClaims[user]) userClaims[user] = [];
        userClaims[user].push(claim);
        if (period === 'all') { periodTotals[p] = (periodTotals[p] || 0) + amount; }
      }
      const grandTotal = Object.values(categoryTotals).reduce((a,b) => a+b, 0);
      const uniqueUsers = Object.keys(userTotals).length;
      let msg = `💸 **Payouts — ${periodLabel}**\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      if (period === 'all') {
        msg += `📅 **By Period**\n`;
        for (const [p, total] of Object.entries(periodTotals).sort((a,b) => a[0]-b[0])) {
          msg += `• Period ${p}: **$${total.toFixed(2)}**\n`;
        }
        msg += `\n`;
      }
      msg += `📂 **By Category**\n`;
      for (const [type, total] of Object.entries(categoryTotals).sort((a,b) => b[1]-a[1])) {
        const count = categoryCounts[type];
        msg += `• ${REWARD_TYPE_NAMES[type]||type}: **$${total.toFixed(2)}** (${count} claim${count!==1?'s':''})\n`;
      }
      msg += `\n👤 **Per User** (${uniqueUsers} user${uniqueUsers!==1?'s':''})\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      for (const [user, claimList] of Object.entries(userClaims).sort((a,b) => userTotals[b[0]]-userTotals[a[0]])) {
        msg += `\n**${user}** — Total: **$${userTotals[user].toFixed(2)}**\n`;
        for (const c of claimList) {
          const date = new Date(c.timestamp).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit', hour12:true, timeZone:'America/New_York' });
          const netNote = c.net_loss ? ` (net loss: $${parseFloat(c.net_loss).toFixed(2)})` : '';
          const pNote = period === 'all' ? ` [P${c.period}]` : '';
          msg += `  🔵 ${REWARD_TYPE_NAMES[c.reward_type]||c.reward_type}: $${parseFloat(c.amount).toFixed(2)}${netNote}${pNote} — ${date} EST\n`;
        }
      }
      msg += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💰 **Grand Total Paid: $${grandTotal.toFixed(2)}** across ${claims.length} claim${claims.length!==1?'s':''}`;
      if (msg.length <= 2000) {
        await interaction.editReply(msg);
      } else {
        const chunks = [];
        let current = '';
        for (const line of msg.split('\n')) {
          if ((current + line + '\n').length > 1900) { chunks.push(current); current = ''; }
          current += line + '\n';
        }
        if (current) chunks.push(current);
        await interaction.editReply(chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp({ content: chunks[i], ephemeral: true });
        }
      }
    } catch (error) {
      await interaction.editReply('❌ An error occurred while fetching payout data.');
    }
  }
  // ── GIVEAWAY ──────────────────────────────────────────────────────────────
  if (interaction.commandName === 'giveaway') {
    if (interaction.user.id !== OWNER_DISCORD_ID) {
      await interaction.reply({ content: '❌ Only the owner can start giveaways.', ephemeral: true });
      return;
    }
    const prize = interaction.options.getString('prize');
    const duration = interaction.options.getInteger('duration');
    const channel = interaction.options.getChannel('channel');
    const role = interaction.options.getRole('role');
    const endsAt = new Date(Date.now() + duration * 60 * 1000);

    const enterBtn = new ButtonBuilder().setCustomId('giveaway_enter').setLabel('🎉 Enter').setStyle(ButtonStyle.Primary);
    const row = new ActionRowBuilder().addComponents(enterBtn);

    const embed = new EmbedBuilder()
      .setTitle(`🎉 GIVEAWAY — ${prize}`)
      .setColor(0xFFD700)
      .setDescription(`Click **Enter** to join!\n\n**Required Role:** <@&${role.id}>\n**Entries:** 0\n**Ends:** <t:${Math.floor(endsAt.getTime()/1000)}:R>`)
      .setFooter({ text: `Ends at` })
      .setTimestamp(endsAt);

    const msg = await channel.send({ embeds: [embed], components: [row] });
    giveaways.set(msg.id, { prize, endsAt, roleId: role.id, channelId: channel.id, entries: new Set(), messageId: msg.id });

    await interaction.reply({ content: `✅ Giveaway started in <#${channel.id}>!`, ephemeral: true });

    // Auto-roll winner when duration expires
    setTimeout(async () => {
      await rollGiveawayWinner(msg.id, channel);
    }, duration * 60 * 1000);
  }
});

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`[boot] ACEBET_API_TOKEN defined: ${!!ACEBET_API_TOKEN}`);
  console.log(`[boot] WAGER_WINDOW_START: ${WAGER_WINDOW_START}`);
  await initDatabase();
  cron.schedule('0 10 * * 0', () => { sendWeeklySummary(); }, { timezone: "America/New_York" });
  console.log('📅 Weekly summary scheduled for Sundays at 10:00 AM EST');
});

client.login(DISCORD_TOKEN).then(() => { registerCommands(); });
