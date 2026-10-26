require('dotenv').config(); // loads .env if present; real env vars still win
const fs = require('fs');
const path = require('path');
const {
  Client, GatewayIntentBits, AttachmentBuilder, EmbedBuilder,
  ChannelType, PermissionFlagsBits, Events,
} = require('discord.js');

// ---------- config (env vars) ----------
const {
  DISCORD_TOKEN, GUILD_ID, REPORT_CHANNEL_ID, BACKUP_CHANNEL_ID,
} = process.env;
const WINDOW_DAYS = Number(process.env.INACTIVE_DAYS || 3);        // how many days to look back
const MAX_MESSAGES = Number(process.env.MAX_MESSAGES ?? 5);         // <= this many msgs = inactive
const REPORT_HOUR_UTC = Number(process.env.REPORT_HOUR_UTC ?? 12);  // daily report time (UTC hour)
const BACKFILL_CAP = Number(process.env.BACKFILL_CAP ?? 5000);      // max msgs scanned per channel on boot
const EXEMPT_ROLE_IDS = (process.env.EXEMPT_ROLE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

const DAY = 86400000;
const DATA_FILE = path.join(DATA_DIR, 'activity.txt');
const BAK_FILE = DATA_FILE + '.bak';
const INACTIVE_FILE = path.join(DATA_DIR, 'inactives.txt');

if (!DISCORD_TOKEN || !GUILD_ID || !REPORT_CHANNEL_ID) {
  console.error('Missing DISCORD_TOKEN, GUILD_ID or REPORT_CHANNEL_ID');
  process.exit(1);
}

// ---------- state ----------
// users[userId] = { d: { "<dayIndex>": messageCount }, v: lastVoiceTimestamp }
let state = { version: 1, lastReport: null, heartbeat: 0, users: {} };
let loadedFrom = null;
let ready = false; // true once boot backfill is finished

const dayKey = (ts = Date.now()) => Math.floor(ts / DAY);

function bumpMessage(userId, ts = Date.now()) {
  const u = (state.users[userId] ??= { d: {}, v: 0 });
  const k = dayKey(ts);
  u.d[k] = (u.d[k] || 0) + 1;
}
function bumpVoice(userId, ts = Date.now()) {
  const u = (state.users[userId] ??= { d: {}, v: 0 });
  u.v = Math.max(u.v, ts);
}

function pruneData() {
  const minKey = dayKey() - WINDOW_DAYS; // keep keys >= minKey (full window + today)
  const vcCutoff = Date.now() - WINDOW_DAYS * DAY;
  for (const [id, u] of Object.entries(state.users)) {
    for (const k of Object.keys(u.d)) if (Number(k) < minKey) delete u.d[k];
    if (!Object.keys(u.d).length && u.v < vcCutoff) delete state.users[id];
  }
}

// ---------- persistence (local .txt + .bak + Discord backup) ----------
function tryRead(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (s && typeof s.users === 'object') return s;
  } catch { /* missing or corrupt */ }
  return null;
}

function loadLocal() {
  const s = tryRead(DATA_FILE) || tryRead(BAK_FILE);
  if (s) { state = { ...state, ...s }; loadedFrom = 'local file'; }
}

function saveLocal() {
  try {
    state.heartbeat = Date.now();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));        // write new copy first...
    if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, BAK_FILE);
    fs.renameSync(tmp, DATA_FILE);                       // ...then swap atomically
  } catch (e) {
    console.warn('saveLocal failed:', e.message);
  }
}

async function backupChannel() {
  if (!BACKUP_CHANNEL_ID) return null;
  const ch = await client.channels.fetch(BACKUP_CHANNEL_ID).catch(() => null);
  return ch?.isTextBased() ? ch : null;
}

async function backupToDiscord() {
  try {
    const ch = await backupChannel();
    if (!ch) return;
    saveLocal();
    await ch.send({
      content: `Backup ${new Date().toISOString()}`,
      files: [new AttachmentBuilder(Buffer.from(JSON.stringify(state)), { name: 'activity.txt' })],
    });
    // keep only the 5 newest backups
    const recent = await ch.messages.fetch({ limit: 50 });
    const mine = [...recent.values()]
      .filter(m => m.author.id === client.user.id && m.attachments.size)
      .sort((a, b) => b.createdTimestamp - a.createdTimestamp);
    for (const m of mine.slice(5)) await m.delete().catch(() => {});
  } catch (e) {
    console.warn('backupToDiscord failed:', e.message);
  }
}

async function restoreFromDiscord() {
  try {
    const ch = await backupChannel();
    if (!ch) return;
    const recent = await ch.messages.fetch({ limit: 50 });
    const newest = [...recent.values()]
      .filter(m => m.author.id === client.user.id && m.attachments.size)
      .sort((a, b) => b.createdTimestamp - a.createdTimestamp)[0];
    if (!newest) return;
    const res = await fetch(newest.attachments.first().url);
    const s = await res.json();
    if (s && typeof s.users === 'object') {
      state = { ...state, ...s };
      loadedFrom = 'Discord backup';
    }
  } catch (e) {
    console.warn('restoreFromDiscord failed:', e.message);
  }
}

// ---------- client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,      // privileged: enable in Dev Portal
    GatewayIntentBits.GuildMessages,     // no Message Content intent needed
    GatewayIntentBits.GuildVoiceStates,
  ],
});

client.on(Events.MessageCreate, m => {
  if (m.guildId !== GUILD_ID || m.author.bot || m.webhookId) return;
  bumpMessage(m.author.id, m.createdTimestamp);
});

client.on(Events.VoiceStateUpdate, (_old, n) => {
  if (n.guild.id !== GUILD_ID || n.member?.user.bot || !n.channelId) return;
  bumpVoice(n.id);
});

client.on(Events.GuildMemberRemove, m => {
  if (m.guild.id === GUILD_ID) delete state.users[m.id];
});

// ---------- boot backfill (fills gaps from downtime) ----------
async function backfill(guild) {
  const bootTs = Date.now();
  const after = Math.max(state.heartbeat || 0, (dayKey(bootTs) - WINDOW_DAYS) * DAY - 1);
  const me = guild.members.me;
  const channels = guild.channels.cache.filter(c =>
    (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) &&
    c.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]));

  console.log(`Backfilling ${channels.size} channels since ${new Date(after).toISOString()}`);
  for (const ch of channels.values()) {
    let before;
    let seen = 0;
    try {
      while (seen < BACKFILL_CAP) {
        const batch = await ch.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        if (!batch.size) break;
        let reachedOld = false;
        for (const m of batch.values()) {
          if (m.createdTimestamp <= after) { reachedOld = true; continue; }
          if (m.createdTimestamp >= bootTs) continue; // live handler already counted these
          if (!m.author.bot && !m.webhookId) bumpMessage(m.author.id, m.createdTimestamp);
        }
        seen += batch.size;
        before = batch.last().id;
        if (reachedOld) break;
      }
    } catch (e) {
      console.warn(`Backfill skipped #${ch.name}: ${e.message}`);
    }
  }
  // anyone sitting in voice right now counts as active
  guild.voiceStates.cache.forEach(vs => { if (vs.channelId && !vs.member?.user.bot) bumpVoice(vs.id); });
}

// ---------- inactivity detection ----------
async function findInactives(guild) {
  // member cache is already filled at boot and kept live by the GuildMembers intent;
  // re-fetching here trips Discord's member-request rate limit (opcode 8)
  if (guild.members.cache.size < guild.memberCount) {
    try { await guild.members.fetch(); } catch (e) { console.warn('Member fetch skipped:', e.message); }
  }
  const now = Date.now();
  const minKey = dayKey() - WINDOW_DAYS;
  const vcCutoff = now - WINDOW_DAYS * DAY;
  const out = [];

  for (const member of guild.members.cache.values()) {
    if (member.user.bot) continue;
    if (EXEMPT_ROLE_IDS.some(r => member.roles.cache.has(r))) continue;

    const u = state.users[member.id];
    let msgs = 0;
    let lastDay = 0;
    if (u) {
      for (const [k, n] of Object.entries(u.d)) {
        if (Number(k) >= minKey) { msgs += n; lastDay = Math.max(lastDay, Number(k)); }
      }
    }
    const inVoice = !!member.voice?.channelId || (u && u.v > vcCutoff);
    if (msgs <= MAX_MESSAGES && !inVoice) {
      const last = lastDay ? new Date(lastDay * DAY).toISOString().slice(0, 10) : 'none in window';
      out.push({
        tag: member.user.tag, id: member.id, msgs, last,
        joined: member.joinedTimestamp ? new Date(member.joinedTimestamp).toISOString().slice(0, 10) : '?',
      });
    }
  }
  out.sort((a, b) => a.msgs - b.msgs || a.joined.localeCompare(b.joined));
  return out;
}

function buildText(list) {
  const lines = list.map(i =>
    `${i.tag} | ${i.id} | messages: ${i.msgs} | last msg day: ${i.last} | joined: ${i.joined}`);
  return [
    `Inactive members - generated ${new Date().toISOString()}`,
    `Criteria: <= ${MAX_MESSAGES} messages and no voice activity in the last ${WINDOW_DAYS} days`,
    `Excluded: bots and exempt roles`,
    `Total: ${list.length}`,
    '---',
    ...lines,
  ].join('\n');
}

async function buildReport() {
  pruneData();
  const guild = await client.guilds.fetch(GUILD_ID);
  await guild.channels.fetch();
  const list = await findInactives(guild);
  const text = buildText(list);
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(INACTIVE_FILE, text); } catch { /* ignore */ }
  const file = new AttachmentBuilder(Buffer.from(text), { name: `inactives-${new Date().toISOString().slice(0, 10)}.txt` });
  const embed = new EmbedBuilder()
    .setTitle('Inactive member report')
    .setDescription(`**${list.length}** inactive (<= ${MAX_MESSAGES} msgs, no VC, last ${WINDOW_DAYS} days). Full list attached.`)
    .setTimestamp();
  return { list, file, embed };
}

async function maybeDailyReport() {
  if (!ready) return;
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (state.lastReport === today || now.getUTCHours() < REPORT_HOUR_UTC) return;
  try {
    const { file, embed } = await buildReport();
    const ch = await client.channels.fetch(REPORT_CHANNEL_ID);
    await ch.send({ embeds: [embed], files: [file] });
    state.lastReport = today;
    saveLocal();
    await backupToDiscord();
  } catch (e) {
    console.warn('Daily report failed (will retry):', e.message);
  }
}

// ---------- slash command: /inactives ----------
client.on(Events.InteractionCreate, async i => {
  if (!i.isChatInputCommand() || i.commandName !== 'inactives') return;
  if (!ready) return i.reply({ content: 'Still catching up on history, try again in a few minutes.', ephemeral: true });
  await i.deferReply({ ephemeral: true });
  try {
    const { file, embed } = await buildReport();
    await i.editReply({ embeds: [embed], files: [file] });
  } catch (e) {
    await i.editReply(`Failed: ${e.message}`);
  }
});

// ---------- startup ----------
loadLocal();

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const guild = await client.guilds.fetch(GUILD_ID);
  await guild.members.fetch();
  await guild.channels.fetch();

  if (!loadedFrom) await restoreFromDiscord(); // local data lost (free host wipe) -> pull from Discord
  console.log(loadedFrom ? `Loaded data from ${loadedFrom}` : 'No saved data, starting fresh');

  await guild.commands.set([{
    name: 'inactives',
    description: 'Generate the inactive member list now',
    defaultMemberPermissions: PermissionFlagsBits.ManageGuild.toString(),
  }]);

  await backfill(guild);
  pruneData();
  saveLocal();
  ready = true;
  console.log('Backfill done, tracking live');

  setInterval(saveLocal, 30 * 1000);
  setInterval(backupToDiscord, 30 * 60 * 1000);
  setInterval(maybeDailyReport, 5 * 60 * 1000);
  maybeDailyReport();
});

// final save on shutdown (Railway etc. send SIGTERM on redeploy)
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => { saveLocal(); await backupToDiscord(); process.exit(0); });
}
process.on('unhandledRejection', e => console.warn('Unhandled:', e));

client.login(DISCORD_TOKEN);
