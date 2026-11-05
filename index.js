// index.js (prune bot)
// Logs per-member activity and grades every member 1-10 for moderators.
// Data is kept indefinitely. Members who leave are kept and marked as left,
// so their history comes back if they rejoin.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const {
  Client, GatewayIntentBits, Partials, Events, ChannelType,
  AttachmentBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits, MessageFlags, SlashCommandBuilder,
} = require('discord.js');

// ---------- config ----------
const { DISCORD_TOKEN, GUILD_ID, REPORT_CHANNEL_ID, BACKUP_CHANNEL_ID } = process.env;
const csv = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean);
const INACTIVE_DAYS = Number(process.env.INACTIVE_DAYS || 3);
const MAX_MESSAGES = Number(process.env.MAX_MESSAGES ?? 5);
const REPORT_HOUR_UTC = Number(process.env.REPORT_HOUR_UTC ?? 12);
const BACKFILL_CAP = Number(process.env.BACKFILL_CAP ?? 5000);
const EXEMPT_ROLE_IDS = csv(process.env.EXEMPT_ROLE_IDS);
// Only this role can use the bot's commands without Manage Messages.
const PRUNE_ROLE_ID = '1564340344873553920';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

if (!DISCORD_TOKEN || !GUILD_ID || !REPORT_CHANNEL_ID) {
  console.error('Missing DISCORD_TOKEN, GUILD_ID or REPORT_CHANNEL_ID');
  process.exit(1);
}

// ---------- grading config ----------
const GRADE_WINDOW_DAYS = 30;
// Weights sum to 1. Voice and reactions are deliberately small (5% combined).
const WEIGHTS = {
  activity: 0.35,
  consistency: 0.20,
  recency: 0.15,
  tenure: 0.15,
  behavior: 0.10,
  voice: 0.03,
  reactions: 0.02,
};
const LABELS = {
  activity: 'Activity', consistency: 'Consistency', recency: 'Recency', tenure: 'Tenure',
  behavior: 'Behavior', voice: 'Voice', reactions: 'Reactions',
};
// Values at which a metric counts as full marks (log scale for counts).
const CAPS = { messages: 300, voiceMinutes: 600, reactions: 100, serverDays: 365, accountDays: 730 };
const MONTHLY_FOLD_AFTER_DAYS = 60; // older daily buckets are merged into monthly ones

const DAY = 86400000;
const DATA_FILE = path.join(DATA_DIR, 'prune-data.json');
const BAK_FILE = DATA_FILE + '.bak';
const INACTIVE_FILE = path.join(DATA_DIR, 'inactives.txt');
const PAGE_SIZE = 10;
const reportCache = new Map(); // messageId -> { list, text, page }

// ---------- state ----------
let state = defaultState();
let loadedFrom = null;
let ready = false; // false until boot sync and restore are done; live events are ignored before this
const voiceSessions = new Map(); // userId -> session start (ms)

function defaultState() {
  return { version: 2, heartbeat: 0, lastReport: null, members: {} };
}
function newRecord() {
  return {
    left: false,
    leftAt: null,
    firstJoinedAt: null,
    joinedAt: null,
    joinCount: 0,
    accountCreatedAt: null,
    lastMessageAt: null,
    totalMessages: 0, // lifetime count, used for the never-talked rule
    days: {}, // "<dayIndex>" -> { m: messages, v: voice ms, r: reactions }; "M<yyyy-mm>" for folded months
  };
}
const dayIdx = (ts = Date.now()) => Math.floor(ts / DAY);
const todayIdx = () => dayIdx(Date.now());
const isMonthKey = (k) => k.startsWith('M');
const stamp = (ts) => `<t:${Math.floor(ts / 1000)}:D>`;
const gradeColor = (g) => (g >= 7 ? 0x2ecc71 : g >= 4 ? 0xe67e22 : 0xed4245);

function getRecord(id) {
  return (state.members[id] ??= newRecord());
}
function dayBucket(rec, ts) {
  return (rec.days[String(dayIdx(ts))] ??= { m: 0, v: 0, r: 0, p: 0, ch: [] });
}

function countMessage(m) {
  if (m.author.bot || m.webhookId) return false;
  const rec = getRecord(m.author.id);
  const bucket = dayBucket(rec, m.createdTimestamp);
  bucket.m += 1;
  if (!bucket.ch.includes(m.channelId)) bucket.ch.push(m.channelId);
  if (m.reference?.messageId) bucket.p += 1;
  rec.totalMessages += 1;
  if (!rec.lastMessageAt || m.createdTimestamp > rec.lastMessageAt) rec.lastMessageAt = m.createdTimestamp;
  return true;
}

function addVoiceTime(userId, start, end) {
  if (end <= start) return;
  dayBucket(getRecord(userId), end).v += end - start;
}
function closeVoice(userId, now = Date.now()) {
  const start = voiceSessions.get(userId);
  if (start === undefined) return;
  voiceSessions.delete(userId);
  addVoiceTime(userId, start, now);
}

// ---------- persistence (local file + .bak + Discord backup) ----------
function tryRead(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // missing or corrupt
  }
}

/** Converts the old v1 format (users -> d) into the v2 layout, keeping counts. */
function migrateV1(s) {
  const next = defaultState();
  next.heartbeat = s.heartbeat || 0;
  next.lastReport = s.lastReport ?? null;
  for (const [id, u] of Object.entries(s.users)) {
    const rec = newRecord();
    let last = 0;
    for (const [k, n] of Object.entries(u.d || {})) {
      rec.days[k] = { m: n, v: 0, r: 0, p: 0, ch: [] };
      last = Math.max(last, Number(k));
    }
    rec.lastMessageAt = last ? last * DAY : null;
    rec.totalMessages = Object.values(rec.days).reduce((sum, b) => sum + b.m, 0);
    next.members[id] = rec;
  }
  return next;
}

function normalizeLoaded(s) {
  if (!s || typeof s !== 'object') return null;
  if (s.members && typeof s.members === 'object') return { ...defaultState(), ...s };
  if (s.users && typeof s.users === 'object') return migrateV1(s);
  return null;
}

function loadLocal() {
  const s = normalizeLoaded(tryRead(DATA_FILE)) || normalizeLoaded(tryRead(BAK_FILE));
  if (s) {
    state = s;
    loadedFrom = 'local file';
  }
}

function saveLocal() {
  try {
    state.heartbeat = Date.now();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state)); // write the new copy first...
    if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, BAK_FILE);
    fs.renameSync(tmp, DATA_FILE); // ...then swap atomically
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
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(state)));
    await ch.send({
      content: `Backup ${new Date().toISOString()}`,
      files: [new AttachmentBuilder(gz, { name: 'prune-data.json.gz' })],
    });
    // keep only the 5 newest backups
    const recent = await ch.messages.fetch({ limit: 50 });
    const mine = [...recent.values()]
      .filter((m) => m.author.id === client.user.id && m.attachments.size)
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
      .filter((m) => m.author.id === client.user.id && m.attachments.size)
      .sort((a, b) => b.createdTimestamp - a.createdTimestamp)[0];
    if (!newest) return;
    const res = await fetch(newest.attachments.first().url);
    const buf = Buffer.from(await res.arrayBuffer());
    const s = normalizeLoaded(JSON.parse(zlib.gunzipSync(buf).toString('utf8')));
    if (s) {
      state = s;
      loadedFrom = 'Discord backup';
    }
  } catch (e) {
    console.warn('restoreFromDiscord failed:', e.message);
  }
}

/** Merges daily buckets older than MONTHLY_FOLD_AFTER_DAYS into monthly buckets. */
function foldOldDays() {
  const cutoff = todayIdx() - MONTHLY_FOLD_AFTER_DAYS;
  for (const rec of Object.values(state.members)) {
    for (const [k, b] of Object.entries(rec.days)) {
      if (isMonthKey(k)) continue;
      const d = Number(k);
      if (d >= cutoff) continue;
      const mk = 'M' + new Date(d * DAY).toISOString().slice(0, 7);
      const t = (rec.days[mk] ??= { m: 0, v: 0, r: 0, p: 0, ch: [] });
      t.m += b.m;
      t.v += b.v;
      t.r += b.r;
      t.p += b.p || 0;
      delete rec.days[k];
    }
  }
}

// ---------- grading ----------
/** Metrics from the last GRADE_WINDOW_DAYS days, including any voice session still running. */
function metricsFor(id, rec, now = Date.now()) {
  const today = dayIdx(now);
  const from = today - (GRADE_WINDOW_DAYS - 1);
  let msgs = 0;
  let voiceMs = 0;
  let reacts = 0;
  let replies = 0;
  let activeDays = 0;
  const channels = new Set();
  for (const [k, b] of Object.entries(rec.days)) {
    if (isMonthKey(k)) continue;
    const d = Number(k);
    if (d < from || d > today) continue;
    msgs += b.m;
    voiceMs += b.v;
    reacts += b.r;
    replies += b.p || 0;
    if (b.m > 0) activeDays++;
    for (const c of b.ch || []) channels.add(c);
  }
  const open = voiceSessions.get(id);
  if (open !== undefined) voiceMs += Math.max(0, now - open);
  return {
    msgs,
    voiceMinutes: voiceMs / 60000,
    reacts,
    replies,
    activeDays,
    channels: channels.size,
  };
}

/**
 * Rule-based behavior score (0 to 1) from message patterns. Rules:
 *  - replies: half of messages being replies is full marks (conversation, not just posting)
 *  - breadth: four or more channels in the window is full marks
 *  - flood check: 100+ messages averaging over 60 a day counts against the score
 */
function behaviorFor(m) {
  if (m.msgs === 0) return { score: 0, replyRatio: 0, spamLike: false };
  const replyRatio = m.replies / m.msgs;
  const replyScore = Math.min(1, replyRatio / 0.5);
  const breadth = Math.min(1, m.channels / 4);
  const perActiveDay = m.msgs / Math.max(1, m.activeDays);
  const spamLike = m.msgs >= 100 && perActiveDay > 60;
  const score = 0.5 * replyScore + 0.3 * breadth + 0.2 * (spamLike ? 0 : 1);
  return { score, replyRatio, spamLike };
}

/** Grade 0 to 10. 0 means the member has never sent a message. Otherwise 1 to 10. */
function gradeFor(id, rec, now = Date.now()) {
  const m = metricsFor(id, rec, now);
  const sat = (value, cap) => Math.min(1, Math.log10(1 + value) / Math.log10(1 + cap));

  const daysSinceMsg = rec.lastMessageAt ? (now - rec.lastMessageAt) / DAY : Infinity;
  const recency = daysSinceMsg <= 3 ? 1 : Math.max(0, 1 - (daysSinceMsg - 3) / 57); // 0 by ~60 days

  const serverDays = rec.firstJoinedAt ? (now - rec.firstJoinedAt) / DAY : 0;
  const accountDays = rec.accountCreatedAt ? (now - rec.accountCreatedAt) / DAY : 0;
  const tenure =
    0.6 * Math.min(1, serverDays / CAPS.serverDays) +
    0.4 * Math.min(1, accountDays / CAPS.accountDays);

  const behavior = behaviorFor(m);
  const parts = {
    activity: sat(m.msgs, CAPS.messages),
    consistency: m.activeDays / GRADE_WINDOW_DAYS,
    recency,
    tenure,
    behavior: behavior.score,
    voice: sat(m.voiceMinutes, CAPS.voiceMinutes),
    reactions: sat(m.reacts, CAPS.reactions),
  };

  const raw = Object.keys(WEIGHTS).reduce((sum, k) => sum + WEIGHTS[k] * parts[k], 0);
  const neverTalked = (rec.totalMessages || 0) === 0;
  const grade = neverTalked ? 0 : Math.min(10, Math.max(1, 1 + Math.round(raw * 9)));
  return { grade, raw, parts, metrics: m, behavior, serverDays, accountDays, neverTalked };
}

// ---------- member sync ----------
/** Brings records in line with the server at boot: marks people who left while the bot was down. */
async function syncMembers(guild) {
  await guild.members.fetch();
  const now = Date.now();
  for (const m of guild.members.cache.values()) {
    if (m.user.bot) continue;
    const rec = getRecord(m.id);
    rec.left = false;
    rec.leftAt = null;
    rec.firstJoinedAt ??= m.joinedTimestamp ?? now;
    rec.joinedAt = m.joinedTimestamp ?? rec.joinedAt;
    rec.accountCreatedAt ??= m.user.createdTimestamp;
  }
  for (const [id, rec] of Object.entries(state.members)) {
    if (!rec.left && !guild.members.cache.has(id)) {
      rec.left = true;
      rec.leftAt = now;
    }
  }
}

function seedVoice(guild) {
  const now = Date.now();
  for (const vs of guild.voiceStates.cache.values()) {
    if (!vs.channelId || vs.member?.user.bot || voiceSessions.has(vs.id)) continue;
    voiceSessions.set(vs.id, now);
  }
}

/** Message counts from history between the last save and boot, so downtime isn't lost. */
async function backfill(guild, cutoff) {
  const after = state.heartbeat || cutoff - GRADE_WINDOW_DAYS * DAY;
  const me = guild.members.me;
  const channels = guild.channels.cache.filter((c) =>
    (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) &&
    c.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]));

  console.log(`Backfilling ${channels.size} channels since ${new Date(after).toISOString()}`);
  let counted = 0;
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
          if (m.createdTimestamp >= cutoff) continue; // live handler counts these
          if (countMessage(m)) counted++;
        }
        seen += batch.size;
        before = batch.last().id;
        if (reachedOld) break;
      }
    } catch (e) {
      console.warn(`Backfill skipped #${ch.name}: ${e.message}`);
    }
  }
  console.log(`Backfill counted ${counted} messages`);
}

// ---------- inactivity report ----------
const SORT_FIELDS = ['messages', 'grade', 'last', 'joined'];
const SORT_ORDERS = ['asc', 'desc'];
const SORT_LABELS = { messages: 'messages', grade: 'grade', last: 'last message', joined: 'join date' };
const pickOr = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
// Default order: messages low to high, so the most inactive members come first.
const DEFAULT_SORT = {
  by: pickOr(process.env.REPORT_SORT_BY, SORT_FIELDS, 'messages'),
  order: pickOr(process.env.REPORT_SORT_ORDER, SORT_ORDERS, 'asc'),
};
const SORT_CMP = {
  messages: (a, b) => a.msgs - b.msgs,
  grade: (a, b) => a.grade - b.grade,
  last: (a, b) => (a.lastTs || 0) - (b.lastTs || 0),
  joined: (a, b) => (a.joined || 0) - (b.joined || 0),
};

function sortList(list, by, order) {
  const dir = order === 'desc' ? -1 : 1;
  return [...list].sort((a, b) => SORT_CMP[by](a, b) * dir || (a.joined || 0) - (b.joined || 0));
}

function sortLabel(sort) {
  const dir = sort.order === 'desc' ? 'high to low' : 'low to high';
  return `Sorted by ${SORT_LABELS[sort.by]} (${dir})`;
}

function findInactives(guild) {
  const today = todayIdx();
  const from = today - INACTIVE_DAYS;
  const now = Date.now();
  const out = [];
  for (const member of guild.members.cache.values()) {
    if (member.user.bot) continue;
    if (EXEMPT_ROLE_IDS.some((r) => member.roles.cache.has(r))) continue;

    const rec = state.members[member.id];
    let msgs = 0;
    let lastDay = 0;
    if (rec) {
      for (const [k, b] of Object.entries(rec.days)) {
        if (isMonthKey(k)) continue;
        const d = Number(k);
        if (d < from || d > today) continue;
        msgs += b.m;
        if (b.m > 0) lastDay = Math.max(lastDay, d);
      }
    }
    if (msgs <= MAX_MESSAGES) {
      out.push({
        tag: member.user.tag,
        id: member.id,
        msgs,
        grade: gradeFor(member.id, rec ?? newRecord(), now).grade,
        lastTs: lastDay ? lastDay * DAY : 0,
        joined: member.joinedTimestamp || 0,
      });
    }
  }
  return out;
}

function buildText(list, sort) {
  const iso = (ts) => (ts ? new Date(ts).toISOString().slice(0, 10) : 'none in window');
  const lines = list.map((i) =>
    `${i.tag} | ${i.id} | messages: ${i.msgs} | grade: ${i.grade} | last msg day: ${iso(i.lastTs)} | joined: ${iso(i.joined)}`);
  return [
    `Inactive members - generated ${new Date().toISOString()}`,
    `Criteria: <= ${MAX_MESSAGES} messages in the last ${INACTIVE_DAYS} days`,
    `Order: ${sortLabel(sort)}`,
    `Excluded: bots and exempt roles`,
    `Total: ${list.length}`,
    '---',
    ...lines,
  ].join('\n');
}

async function buildReport(sort = DEFAULT_SORT) {
  const guild = await client.guilds.fetch(GUILD_ID);
  if (guild.members.cache.size < guild.memberCount) await guild.members.fetch().catch(() => {});
  const list = sortList(findInactives(guild), sort.by, sort.order);
  const text = buildText(list, sort);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(INACTIVE_FILE, text);
  } catch { /* ignore */ }
  return { list, text, sort };
}

function cacheReport(messageId, list, text, sort, title) {
  reportCache.set(messageId, { list, text, sort, title, page: 0 });
  if (reportCache.size > 20) reportCache.delete(reportCache.keys().next().value);
}

function renderPage(list, page, sort = DEFAULT_SORT, title = '😴 Inactive member report') {
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  page = Math.min(Math.max(page, 0), pages - 1);
  const embed = new EmbedBuilder().setTimestamp();

  if (!list.length) {
    embed
      .setColor(0x2ecc71)
      .setTitle(`✅ ${title.replace(/^[^\s]+\s/, '')}: no inactive members`)
      .setDescription(`Everyone has more than **${MAX_MESSAGES}** messages in the last **${INACTIVE_DAYS} days**.`);
    return { payload: { embeds: [embed], components: [] }, page: 0 };
  }

  const slice = list.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const rows = slice.map((m, idx) => {
    const n = page * PAGE_SIZE + idx + 1;
    const last = m.lastTs ? stamp(m.lastTs) : 'none in window';
    const joined = m.joined ? stamp(m.joined) : 'unknown';
    return `**${n}.** <@${m.id}> · \`${m.id}\`\n└ 💬 ${m.msgs} msg${m.msgs === 1 ? '' : 's'} · 🏅 grade ${m.grade}/10 · last msg: ${last} · joined: ${joined}`;
  });

  embed
    .setColor(0xe67e22)
    .setTitle(title)
    .setDescription(
      `**${list.length}** member${list.length === 1 ? '' : 's'} with **≤ ${MAX_MESSAGES} messages** in the last **${INACTIVE_DAYS} days**.\n\n` +
      rows.join('\n\n'))
    .setFooter({ text: `Page ${page + 1}/${pages} · ${sortLabel(sort)}` });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('inact_prev').setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId('inact_page').setLabel(`${page + 1}/${pages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId('inact_next').setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
    new ButtonBuilder().setCustomId('inact_txt').setLabel('Export .txt').setEmoji('📄').setStyle(ButtonStyle.Primary),
  );
  return { payload: { embeds: [embed], components: [row] }, page };
}

async function maybeDailyReport() {
  if (!ready) return;
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (state.lastReport === today || now.getUTCHours() < REPORT_HOUR_UTC) return;
  try {
    foldOldDays();
    const { list, text, sort } = await buildReport();
    const ch = await client.channels.fetch(REPORT_CHANNEL_ID);
    const title = '😴 Inactive member report';
    const msg = await ch.send(renderPage(list, 0, sort, title).payload);
    cacheReport(msg.id, list, text, sort, title);
    state.lastReport = today;
    saveLocal();
    await backupToDiscord();
  } catch (e) {
    console.warn('Daily report failed (will retry):', e.message);
  }
}

// ---------- moderator access ----------
function isMod(i) {
  if (i.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) return true;
  return !!i.member?.roles?.cache?.has(PRUNE_ROLE_ID);
}

// ---------- slash commands ----------
// Access is checked in code by isMod(). No default permission is set, so the role can see the commands too.
const modOnly = (b) => b.setDMPermission(false);

// Sort options shared by /inactives and /testprune.
function withSortOptions(builder) {
  return builder
    .addStringOption((o) =>
      o.setName('sort_by').setDescription(`What to sort by (default: ${SORT_LABELS[DEFAULT_SORT.by]})`).setRequired(false)
        .addChoices(
          { name: 'Messages (last few days)', value: 'messages' },
          { name: 'Grade', value: 'grade' },
          { name: 'Last message', value: 'last' },
          { name: 'Join date', value: 'joined' },
        ))
    .addStringOption((o) =>
      o.setName('order').setDescription('Order (default: low to high)').setRequired(false)
        .addChoices(
          { name: 'Low to high (most inactive first)', value: 'asc' },
          { name: 'High to low', value: 'desc' },
        ));
}

const COMMANDS = [
  modOnly(withSortOptions(new SlashCommandBuilder()
    .setName('inactives')
    .setDescription('Generate the inactive member list now'))),
  modOnly(withSortOptions(new SlashCommandBuilder()
    .setName('testprune')
    .setDescription('Preview the daily prune report (only you see it)'))),
  modOnly(new SlashCommandBuilder()
    .setName('profile')
    .setDescription("Show a member's grade and the data behind it")
    .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))),
  modOnly(new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show the highest or lowest graded members')
    .addStringOption((o) =>
      o.setName('mode').setDescription('Which end to show').setRequired(false)
        .addChoices({ name: 'Lowest', value: 'low' }, { name: 'Highest', value: 'top' }))),
];

function readSort(i) {
  return {
    by: i.options.getString('sort_by') ?? DEFAULT_SORT.by,
    order: i.options.getString('order') ?? DEFAULT_SORT.order,
  };
}

async function cmdPrune(i, title) {
  const sort = readSort(i);
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const { list, text } = await buildReport(sort);
  const msg = await i.editReply(renderPage(list, 0, sort, title).payload);
  cacheReport(msg.id, list, text, sort, title);
}

async function cmdProfile(i) {
  const user = i.options.getUser('user', true);
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const rec = state.members[user.id];
  if (!rec) return i.editReply(`No data for <@${user.id}> yet.`);

  const g = gradeFor(user.id, rec);
  const inServer = i.guild.members.cache.has(user.id);
  const status = inServer ? 'In server' : rec.leftAt ? `Left ${stamp(rec.leftAt)}` : 'Not in server';
  const breakdown = Object.keys(WEIGHTS)
    .map((k) => `${LABELS[k]}: ${Math.round(g.parts[k] * 100)}% (weight ${WEIGHTS[k]})`)
    .join('\n');

  const embed = new EmbedBuilder()
    .setColor(gradeColor(g.grade))
    .setTitle(`📋 ${user.tag}`)
    .setThumbnail(user.displayAvatarURL({ extension: 'png', size: 128 }))
    .addFields(
      { name: 'Grade', value: `**${g.grade}/10**`, inline: true },
      { name: 'Status', value: status, inline: true },
      { name: 'Messages (30d)', value: String(g.metrics.msgs), inline: true },
      { name: 'Active days (30d)', value: `${g.metrics.activeDays}/${GRADE_WINDOW_DAYS}`, inline: true },
      { name: 'Last message', value: rec.lastMessageAt ? stamp(rec.lastMessageAt) : 'Never', inline: true },
      { name: 'Voice (30d)', value: `${Math.round(g.metrics.voiceMinutes)} min`, inline: true },
      { name: 'Reactions (30d)', value: String(g.metrics.reacts), inline: true },
      { name: 'Total messages', value: String(rec.totalMessages || 0), inline: true },
      { name: 'Reply rate (30d)', value: `${Math.round(g.behavior.replyRatio * 100)}%`, inline: true },
      { name: 'Channels (30d)', value: String(g.metrics.channels), inline: true },
      { name: 'Joins seen', value: String(rec.joinCount || 0), inline: true },
      { name: 'Server tenure', value: rec.firstJoinedAt ? `${Math.floor(g.serverDays)} days` : 'Unknown', inline: true },
      { name: 'Account age', value: rec.accountCreatedAt ? `${Math.floor(g.accountDays)} days` : 'Unknown', inline: true },
      { name: 'Grade breakdown', value: breakdown },
    )
    .setFooter({ text: g.neverTalked ? 'Never sent a message: grade 0' : 'Grades are for moderator reference only' })
    .setTimestamp();

  return i.editReply({ embeds: [embed] });
}

async function cmdLeaderboard(i) {
  const mode = i.options.getString('mode') ?? 'low';
  await i.deferReply({ flags: MessageFlags.Ephemeral });

  const rows = [];
  for (const [id, rec] of Object.entries(state.members)) {
    if (rec.left || !i.guild.members.cache.has(id)) continue;
    const g = gradeFor(id, rec);
    rows.push({ id, grade: g.grade, raw: g.raw });
  }
  if (!rows.length) return i.editReply('No members graded yet.');

  rows.sort((a, b) => (mode === 'top' ? b.raw - a.raw : a.raw - b.raw));
  const lines = rows.slice(0, 10).map((r, idx) => `**${idx + 1}.** <@${r.id}> · ${r.grade}/10`);
  const embed = new EmbedBuilder()
    .setColor(mode === 'top' ? 0x2ecc71 : 0xe67e22)
    .setTitle(mode === 'top' ? '🏆 Highest graded' : '⚠️ Lowest graded')
    .setDescription(lines.join('\n'))
    .setFooter({ text: `${rows.length} members graded` })
    .setTimestamp();
  return i.editReply({ embeds: [embed] });
}

async function handleCommand(i) {
  if (i.guildId !== GUILD_ID) return;
  if (!ready) return i.reply({ content: 'Still starting up, try again in a minute.', flags: MessageFlags.Ephemeral });
  if (!isMod(i)) return i.reply({ content: "You don't have permission to use this command.", flags: MessageFlags.Ephemeral });

  switch (i.commandName) {
    case 'inactives': return cmdPrune(i, '😴 Inactive member report');
    case 'testprune': return cmdPrune(i, '🧪 TEST · Inactive member report');
    case 'profile': return cmdProfile(i);
    case 'leaderboard': return cmdLeaderboard(i);
    default: return;
  }
}

async function handleReportButton(i) {
  if (!isMod(i)) return i.reply({ content: 'You need to be a moderator to use this.', flags: MessageFlags.Ephemeral });
  const entry = reportCache.get(i.message.id);
  if (!entry) {
    return i.reply({ content: 'This report expired (the bot restarted). Run `/inactives` for a fresh one.', flags: MessageFlags.Ephemeral });
  }
  if (i.customId === 'inact_txt') {
    const file = new AttachmentBuilder(Buffer.from(entry.text), {
      name: `inactives-${new Date().toISOString().slice(0, 10)}.txt`,
    });
    return i.reply({ files: [file], flags: MessageFlags.Ephemeral });
  }
  entry.page += i.customId === 'inact_next' ? 1 : -1;
  const { payload, page } = renderPage(entry.list, entry.page, entry.sort, entry.title);
  entry.page = page;
  return i.update(payload);
}

// ---------- client ----------
loadLocal();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,          // privileged: enable in Developer Portal
    GatewayIntentBits.GuildMessages,         // no Message Content intent needed
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Message, Partials.Reaction, Partials.Channel, Partials.User],
});

client.on(Events.MessageCreate, (m) => {
  if (!ready || m.guildId !== GUILD_ID) return;
  countMessage(m);
});

client.on(Events.GuildMemberAdd, (m) => {
  if (!ready || m.guild.id !== GUILD_ID || m.user.bot) return;
  const rec = getRecord(m.id);
  const now = Date.now();
  rec.left = false;
  rec.leftAt = null;
  rec.firstJoinedAt ??= m.joinedTimestamp ?? now;
  rec.joinedAt = m.joinedTimestamp ?? now;
  rec.accountCreatedAt ??= m.user.createdTimestamp;
  rec.joinCount = (rec.joinCount || 0) + 1;
});

client.on(Events.GuildMemberRemove, (m) => {
  if (!ready || m.guild.id !== GUILD_ID) return;
  closeVoice(m.id);
  const rec = state.members[m.id];
  if (rec) {
    rec.left = true;
    rec.leftAt = Date.now();
  }
});

client.on(Events.VoiceStateUpdate, (oldS, newS) => {
  const guild = newS.guild ?? oldS.guild;
  if (!ready || guild.id !== GUILD_ID) return;
  if (newS.member?.user.bot || oldS.member?.user.bot) return;
  const wasIn = !!oldS.channelId;
  const isIn = !!newS.channelId;
  if (!wasIn && isIn) voiceSessions.set(newS.id, Date.now());
  else if (wasIn && !isIn) closeVoice(newS.id);
});

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (!ready || user.bot) return;
  try {
    if (reaction.partial) await reaction.fetch();
    const msg = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
    if (msg.guildId !== GUILD_ID) return;
    const now = Date.now();
    dayBucket(getRecord(user.id), now).r += 1;
    const author = msg.author;
    if (author && !author.bot && author.id !== user.id) dayBucket(getRecord(author.id), now).r += 1;
  } catch {
    // deleted or uncached message: skip
  }
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isChatInputCommand()) return await handleCommand(i);
    if (i.isButton() && i.customId.startsWith('inact_')) return await handleReportButton(i);
  } catch (e) {
    console.warn('Interaction failed:', e.message);
    const content = 'Something went wrong. Check the bot logs.';
    if (i.deferred || i.replied) await i.editReply({ content }).catch(() => {});
    else await i.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const guild = await client.guilds.fetch(GUILD_ID);
  await guild.channels.fetch();

  if (!loadedFrom) await restoreFromDiscord(); // local data lost (free host wipe) -> pull from Discord
  console.log(loadedFrom ? `Loaded data from ${loadedFrom}` : 'No saved data, starting fresh');

  await syncMembers(guild);
  await guild.commands.set(COMMANDS.map((c) => c.toJSON()));
  foldOldDays();

  // Live events count from here on. Backfill covers everything before this moment.
  const cutoff = Date.now();
  ready = true;
  await backfill(guild, cutoff);
  seedVoice(guild);
  saveLocal();
  console.log('Backfill done, tracking live');

  setInterval(saveLocal, 30 * 1000);
  setInterval(backupToDiscord, 30 * 60 * 1000);
  setInterval(maybeDailyReport, 5 * 60 * 1000);
  maybeDailyReport();
});

// Save on shutdown (Railway, Wispbyte etc. send SIGTERM on redeploy).
async function shutdown() {
  const now = Date.now();
  for (const id of [...voiceSessions.keys()]) closeVoice(id, now);
  saveLocal();
  await backupToDiscord();
  process.exit(0);
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, shutdown);
process.on('unhandledRejection', (e) => console.warn('Unhandled:', e));

client.login(DISCORD_TOKEN);
