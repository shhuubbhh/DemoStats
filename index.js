// index.js
// Main Discord bot (Node.js, discord.js v14)
// Tracks messages, attachments, voice sessions, and X/Twitter links per message.
// Requires: dotenv, discord.js@14, better-sqlite3
// Make sure package.json has "type": "module" if using ES modules.

import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import Database from 'better-sqlite3';

// --- Config & env ---
const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || null; // optional: for guild-scoped command registration

if (!TOKEN) {
  console.error('Missing BOT_TOKEN in .env — please set it and restart.');
  process.exit(1);
}

// --- X / Twitter link regex ---
const X_LINK_REGEX = /(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com|t\.co)\/[^\s/$.?#].[^\s]*/gi;

// --- Database (SQLite via better-sqlite3) ---
const DB_PATH = './data.sqlite';
const db = new Database(DB_PATH);

// Create tables if they don't exist (safe - will not overwrite existing)
db.exec(`
CREATE TABLE IF NOT EXISTS guild_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  UNIQUE(guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  has_attachment INTEGER DEFAULT 0,
  attachment_count INTEGER DEFAULT 0,
  x_link_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS voice_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  left_at INTEGER,
  duration_seconds INTEGER
);
`);

// Prepared statements
const insertOrUpdateUser = db.prepare(`
INSERT INTO guild_users (guild_id, user_id, first_seen, last_seen)
VALUES (@guild_id, @user_id, @ts, @ts)
ON CONFLICT(guild_id, user_id) DO UPDATE SET last_seen = @ts;
`);

const insertMessage = db.prepare(`
INSERT OR IGNORE INTO messages
  (guild_id, channel_id, user_id, message_id, created_at, has_attachment, attachment_count, x_link_count)
VALUES (@guild_id, @channel_id, @user_id, @message_id, @created_at, @has_attachment, @attachment_count, @x_link_count);
`);

const insertVoiceSession = db.prepare(`
INSERT INTO voice_sessions (guild_id, user_id, channel_id, joined_at) VALUES (@guild_id, @user_id, @channel_id, @joined_at);
`);

const selectOpenVoiceSession = db.prepare(`
SELECT id, joined_at FROM voice_sessions WHERE guild_id = ? AND user_id = ? AND left_at IS NULL ORDER BY joined_at DESC LIMIT 1
`);

const updateVoiceSessionLeave = db.prepare(`
UPDATE voice_sessions SET left_at = @left_at, duration_seconds = @duration WHERE id = @id
`);

// --- Helpers ---
function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function secondsToHrsMin(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

// --- Bot client ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Channel]
});

// Log unhandled rejections
process.on('unhandledRejection', (reason, p) => {
  console.error('Unhandled Rejection at:', p, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

// --- Message logging (live) ---
function logMessageToDB(message) {
  try {
    if (!message.guild) return;
    if (message.author?.bot) return;

    const ts = nowTs();
    insertOrUpdateUser.run({ guild_id: message.guild.id, user_id: message.author.id, ts });

    const hasAttachment = message.attachments?.size > 0 ? 1 : 0;
    const attachmentCount = message.attachments?.size || 0;

    // detect X links in message content
    let xCount = 0;
    if (message.content) {
      const matches = message.content.match(X_LINK_REGEX);
      if (matches) xCount = matches.length;
    }

    insertMessage.run({
      guild_id: message.guild.id,
      channel_id: message.channel.id,
      user_id: message.author.id,
      message_id: message.id,
      created_at: ts,
      has_attachment: hasAttachment,
      attachment_count: attachmentCount,
      x_link_count: xCount
    });
  } catch (err) {
    console.error('logMessageToDB error', err);
  }
}

// --- Voice session handling ---
async function onVoiceUpdate(oldState, newState) {
  try {
    const member = newState.member ?? oldState.member;
    if (!member) return;
    if (member.user?.bot) return;

    const guild = newState.guild ?? oldState.guild;
    if (!guild) return;

    const guildId = guild.id;
    const userId = member.id;

    // join
    if (!oldState.channel && newState.channel) {
      insertVoiceSession.run({
        guild_id: guildId,
        user_id: userId,
        channel_id: newState.channel.id,
        joined_at: nowTs()
      });
      return;
    }

    // leave
    if (oldState.channel && !newState.channel) {
      const res = selectOpenVoiceSession.get(guildId, userId);
      if (res) {
        const leftAt = nowTs();
        const durationSec = leftAt - res.joined_at;
        updateVoiceSessionLeave.run({ left_at: leftAt, duration: durationSec, id: res.id });
      }
      return;
    }

    // switch channels -> treat as leave + join
    if (oldState.channel && newState.channel && oldState.channel.id !== newState.channel.id) {
      // close old session
      const res = selectOpenVoiceSession.get(guildId, userId);
      if (res) {
        const leftAt = nowTs();
        const durationSec = leftAt - res.joined_at;
        updateVoiceSessionLeave.run({ left_at: leftAt, duration: durationSec, id: res.id });
      }
      // open new session
      insertVoiceSession.run({
        guild_id: guildId,
        user_id: userId,
        channel_id: newState.channel.id,
        joined_at: nowTs()
      });
    }
  } catch (err) {
    console.error('onVoiceUpdate error', err);
  }
}

// --- Build stats embed ---
function buildStatsEmbed(guildId, user) {
  try {
    const msgRow = db.prepare(`
      SELECT COUNT(*) as total_messages, COALESCE(SUM(attachment_count),0) as total_attachments
      FROM messages WHERE guild_id = ? AND user_id = ?
    `).get(guildId, user.id);

    const voiceRow = db.prepare(`
      SELECT COALESCE(SUM(duration_seconds),0) as total_voice FROM voice_sessions WHERE guild_id = ? AND user_id = ?
    `).get(guildId, user.id);

    const xRow = db.prepare(`
      SELECT COALESCE(SUM(x_link_count),0) as total_x_links FROM messages WHERE guild_id = ? AND user_id = ?
    `).get(guildId, user.id);

    const totalMessages = msgRow?.total_messages ?? 0;
    const totalAttachments = msgRow?.total_attachments ?? 0;
    const totalVoiceSec = voiceRow?.total_voice ?? 0;
    const totalXLinks = xRow?.total_x_links ?? 0;

    const embed = new EmbedBuilder()
      .setTitle(`${user.tag} — server stats`)
      .addFields(
        { name: 'Messages', value: `${totalMessages}`, inline: true },
        { name: 'Attachments / media', value: `${totalAttachments}`, inline: true },
        { name: 'Voice time', value: `${secondsToHrsMin(totalVoiceSec)}`, inline: true },
        { name: 'Contributions (X links)', value: `${totalXLinks}`, inline: true }
      )
      .setTimestamp();

    return embed;
  } catch (err) {
    console.error('buildStatsEmbed error', err);
    // fallback embed
    return new EmbedBuilder().setTitle(`${user.tag} — server stats`).setDescription('Error building stats').setTimestamp();
  }
}

// --- Register slash command safely ---
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('userstats')
      .setDescription('Show stats for a user')
      .addUserOption(opt => opt.setName('user').setDescription('Select user').setRequired(true))
      .toJSON()
  ];

  const rest = new REST({ version: '10' }).setToken(TOKEN);

  try {
    if (GUILD_ID) {
      const guild = client.guilds.cache.get(GUILD_ID);
      if (!guild) {
        console.warn(`Warning: GUILD_ID ${GUILD_ID} not found in client cache. Registering globally instead.`);
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      } else {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
        console.log('Registered guild command to', GUILD_ID);
      }
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('Registered global command (may take up to 1 hour).');
    }
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
}

// --- Events ---
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag} (${client.user.id})`);
  console.log('Bot is a member of these guilds:');
  client.guilds.cache.forEach(g => console.log(` - ${g.name} (${g.id})`));
  await registerCommands();
});

client.on('messageCreate', async (message) => {
  try {
    logMessageToDB(message);
  } catch (err) {
    console.error('messageCreate error', err);
  }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    await onVoiceUpdate(oldState, newState);
  } catch (err) {
    console.error('voiceStateUpdate error', err);
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;

    if (!interaction.guild) {
      await interaction.reply({ content: "This command must be used inside a server (not in DMs).", ephemeral: true });
      return;
    }

    if (interaction.commandName === 'userstats') {
      const target = interaction.options.getUser('user', true);
      await interaction.deferReply();
      const embed = buildStatsEmbed(String(interaction.guild.id), target);
      await interaction.editReply({ embeds: [embed] });
    }
  } catch (err) {
    console.error('interactionCreate error', err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: 'An unexpected error occurred while processing your command.' });
      } else {
        await interaction.reply({ content: 'An unexpected error occurred while processing your command.', ephemeral: true });
      }
    } catch (e) {
      console.error('failed to send error reply', e);
    }
  }
});

// --- Start bot ---
client.login(TOKEN).catch(err => {
  console.error('Failed to login:', err);
  process.exit(1);
});
