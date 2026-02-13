# R2K2 Acebet Verification Bot

Discord bot that verifies if users are active under your R2K2 affiliate code on Acebet.

## Features

- `/verify <username>` - Check if an Acebet user is active
- Returns `Active ✅` or `Inactive ❌`
- Pulls live data from Acebet API

## Setup Instructions

### 1. Create Discord Bot

1. Go to https://discord.com/developers/applications
2. Click "New Application" and name it (e.g., "R2K2 Verify")
3. Go to "Bot" section and click "Add Bot"
4. Under "TOKEN", click "Reset Token" and copy it (you'll need this)
5. Enable these Privileged Gateway Intents:
   - Server Members Intent (optional, but recommended)
6. Go to "OAuth2" → "URL Generator"
7. Select scopes: `bot`, `applications.commands`
8. Select bot permissions: `Send Messages`, `Use Slash Commands`
9. Copy the generated URL and open it to invite the bot to your server

### 2. Get Your IDs

- **CLIENT_ID**: Found in Discord Developer Portal → General Information → Application ID
- **GUILD_ID**: Enable Developer Mode in Discord (Settings → Advanced → Developer Mode), then right-click your server and "Copy Server ID"

### 3. Install Dependencies

```bash
npm install
```

### 4. Configure Environment Variables

Create a `.env` file in the project root:

```env
DISCORD_TOKEN=your_discord_bot_token_here
CLIENT_ID=your_application_client_id
GUILD_ID=your_server_id
ACEBET_TOKEN=your_acebet_api_token
WAGER_WINDOW_START=2025-01-01
```

### 5. Run the Bot

```bash
npm start
```

For development with auto-restart:
```bash
npm run dev
```

## Usage

In your Discord server, use:

```
/verify AcebetUsername
```

The bot will respond with:
- `✅ **Username** is Active` - User is active under R2K2 code
- `❌ **Username** is Inactive` - User exists but is not active
- `❌ User **Username** not found under code R2K2` - User not found in API

## Configuration

### Wager Window Start Date

The `WAGER_WINDOW_START` determines the date range for checking user activity. Update this in your `.env` file as needed.

## Troubleshooting

**Bot doesn't respond to slash commands:**
- Make sure the bot has proper permissions in your server
- Wait a few minutes after inviting the bot for commands to register
- Try kicking and re-inviting the bot

**API errors:**
- Verify your `ACEBET_TOKEN` is correct
- Check that the API endpoint is accessible
- Ensure the wager window date is valid

**Commands not showing up:**
- Check that `GUILD_ID` matches your server
- Restart the bot
- Commands may take up to an hour to register globally (guild commands are instant)

## Tech Stack

- Node.js
- discord.js v14
- Acebet API
