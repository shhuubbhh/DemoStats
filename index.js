// index.js
import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import Database from 'better-sqlite3';
import fs from 'fs';

// ---- Config ----
const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || null; // if set, register commands to this guild for instant update

if (!TOKEN) {
  console.error('Missing BOT_TOKEN in .env');
  process.exit(1);
}

// ---- Setup DB (SQLite) ----
const dbFile = './data.sqlite';
const db = new Database(dbFile);

// Create tables if not exist
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
  message_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  has_attachment INTEGER DEFAULT 0,
  attachment_count INTEGER DEFAULT 0
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
INSERT INTO messages (guild_id, channel_id, user_id, message_id, created_at, has_attachment, attachment_count)
VALUES (@guild_id, @channel_id, @user_id, @message_id, @created_at, @has_attachment, @attachment_count);
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

// ---- Create minimal bot client ----
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,      // required for reading message content & attachments
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Channel]
});

// ---- Helpers ----
function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function logMessageToDB(message) {
  if (!message.guild) return;
  if (message.author?.bot) return;
  const ts = nowTs();
  insertOrUpdateUser.run({ guild_id: message.guild.id, user_id: message.author.id, ts });
  const hasAttachment = message.attachments?.size > 0 ? 1 : 0;
  const attachmentCount = message.attachments?.size || 0;
  insertMessage.run({
    guild_id: message.guild.id,
    channel_id: message.channel.id,
    user_id: message.author.id,
    message_id: message.id,
    created_at: ts,
    has_attachment: hasAttachment,
    attachment_count: attachmentCount
  });
}

async function handleVoiceUpdate(oldState, newState) {
  try {
    // ignore bots
    const member = newState.member ?? oldState.member;
    if (!member) return;
    if (member.user.bot) return;

    const guildId = (newState.guild ?? oldState.guild).id;
    const userId = member.id;

    // JOIN
    if (!oldState.channel && newState.channel) {
      insertVoiceSession.run({
        guild_id: guildId,
        user_id: userId,
        channel_id: newState.channel.id,
        joined_at: nowTs()
      });
      return;
    }

    // LEAVE
    if (oldState.channel && !newState.channel) {
      const row = selectOpenVoiceSession.get(guildId, userId);
      if (row) {
        const leftAt = nowTs();
        const duration = leftAt - row.joined_at;
        updateVoiceSessionLeave.run({ left_at: leftAt, duration, id: row.id });
      }
      return;
    }

    // Switch channel (treat as leave + join)
    if (oldState.channel && newState.channel && oldState.channel.id !== newState.channel.id) {
      // leave old
      const row = selectOpenVoiceSession.get(guildId, userId);
      if (row) {
        const leftAt = nowTs();
        const duration = leftAt - row.joined_at;
        updateVoiceSessionLeave.run({ left_at: leftAt, duration, id: row.id });
      }
      // join new
      insertVoiceSession.run({
        guild_id: guildId,
        user_id: userId,
        channel_id: newState.channel.id,
        joined_at: nowTs()
      });
    }
  } catch (err) {
    console.error('voice update error', err);
  }
}

function secondsToHrsMin(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

function buildStatsEmbed(guildId, user) {
  // messages
  const msgRow = db.prepare(`
    SELECT COUNT(*) as total_messages, COALESCE(SUM(attachment_count),0) as total_attachments
    FROM messages WHERE guild_id = ? AND user_id = ?
  `).get(guildId, user.id);

  const voiceRow = db.prepare(`
    SELECT COALESCE(SUM(duration_seconds),0) as total_voice
    FROM voice_sessions WHERE guild_id = ? AND user_id = ?
  `).get(guildId, user.id);

  const totalMessages = msgRow?.total_messages ?? 0;
  const totalAttachments = msgRow?.total_attachments ?? 0;
  const totalVoiceSec = voiceRow?.total_voice ?? 0;

  const embed = new EmbedBuilder()
    .setTitle(`${user.tag} — server stats`)
    .addFields(
      { name: 'Messages', value: `${totalMessages}`, inline: true },
      { name: 'Attachments / media', value: `${totalAttachments}`, inline: true },
      { name: 'Voice time', value: `${secondsToHrsMin(totalVoiceSec)}`, inline: true }
    )
    .setTimestamp();

  return embed;
}

// ---- Register slash command (Guild-scoped if GUILD_ID set for instant update) ----
async function registerCommands() {
  const cmd = new SlashCommandBuilder()
    .setName('userstats')
    .setDescription('Show stats for a user')
    .addUserOption(opt => opt.setName('user').setDescription('Select user').setRequired(true))
    .toJSON();

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: [cmd] });
    console.log('Registered guild command to', GUILD_ID);
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [cmd] });
    console.log('Registered global command (may take up to 1 hour to appear).');
  }
}

// ---- Events ----
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.on('messageCreate', message => {
  try {
    logMessageToDB(message);
  } catch (e) {
    console.error('message log error', e);
  }
});

client.on('voiceStateUpdate', (oldState, newState) => {
  handleVoiceUpdate(oldState, newState);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'userstats') {
    const user = interaction.options.getUser('user', true);
    await interaction.deferReply();
    const embed = buildStatsEmbed(interaction.guild.id, user);
    await interaction.editReply({ embeds: [embed] });
  }
});

// ---- Start ----
client.login(TOKEN);
