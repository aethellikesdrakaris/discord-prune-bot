// economy.js
// Economy module: balance, baltop, daily/weekly, profile, coinflip, slots,
// blackjack, mines, work, crime, steal. Exposes the slash commands, a command
// handler, a button handler, and a message tracker for activity.
'use strict';

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CURRENCY = 'M$';
const STARTING_BALANCE = 5000;
const DAILY_AMOUNT = 500;
const WEEKLY_AMOUNT = 2000;
const DAILY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const WEEKLY_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const WORK_COOLDOWN_MS = 60 * 60 * 1000;
const CRIME_COOLDOWN_MS = 60 * 60 * 1000;
const STEAL_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const MIN_BET = 1;

const GAME_TIMEOUT_MS = 5 * 60 * 1000;
const MINES_TOTAL = 20;
const MINES_COLS = 5;

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SLOT_SYMBOLS = ['🍒', '🍋', '🍊', '🍇', '🔔', '💎', '7️⃣'];
const SLOT_TRIPLE_PAYOUTS = {
  '🍒': 20, '🍋': 20, '🍊': 20, '🍇': 25, '🔔': 35, '💎': 50, '7️⃣': 100,
};
const SLOT_PAIR_PAYOUT = 3;

const JOBS = [
  { name: 'Barista', min: 80, max: 220 },
  { name: 'Cashier', min: 100, max: 260 },
  { name: 'Delivery Driver', min: 150, max: 360 },
  { name: 'Tutor', min: 200, max: 420 },
  { name: 'Chef', min: 250, max: 520 },
  { name: 'Software Developer', min: 320, max: 640 },
  { name: 'Streamer', min: 60, max: 800 },
  { name: 'Street Performer', min: 20, max: 500 },
];

const CRIME_SCENARIOS = [
  'robbed a convenience store',
  'pickpocketed a tourist',
  'hacked into an ATM',
  'ran a shady poker game',
  'smuggled contraband across the border',
  'scammed someone online',
  'broke into a jewelry store',
  'sold counterfeit tickets',
];

const ECONOMY_FILE = path.join(__dirname, 'economy.json');
// ---------------------------------------------------------------------------
// Storage (debounced save, flush on exit)
// ---------------------------------------------------------------------------
let store = null;
let saveTimer = null;

function loadStore() {
  if (store) return store;
  try {
    store = JSON.parse(fs.readFileSync(ECONOMY_FILE, 'utf8'));
  } catch {
    store = {};
  }
  if (!store.guilds || typeof store.guilds !== 'object') store.guilds = {};
  return store;
}

function saveStoreNow() {
  if (!store) return;
  try {
    fs.writeFileSync(ECONOMY_FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    console.error('Failed to save economy data:', err);
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveStoreNow();
  }, 2000);
}

process.on('exit', () => {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  saveStoreNow();
});

function getGuild(guildId) {
  const s = loadStore();
  if (!s.guilds[guildId]) s.guilds[guildId] = { users: {} };
  if (!s.guilds[guildId].users) s.guilds[guildId].users = {};
  return s.guilds[guildId];
}

function normalizeUser(u) {
  if (!u || typeof u !== 'object') u = {};
  if (!u.stats || typeof u.stats !== 'object') u.stats = {};
  const s = u.stats;
  if (typeof s.messages !== 'number') s.messages = 0;
  if (typeof s.gamesPlayed !== 'number') s.gamesPlayed = 0;
  if (typeof s.gamesWon !== 'number') s.gamesWon = 0;
  if (typeof s.gamesLost !== 'number') s.gamesLost = 0;
  if (typeof s.totalWon !== 'number') s.totalWon = 0;
  if (typeof s.totalLost !== 'number') s.totalLost = 0;
  if (typeof s.biggestWin !== 'number') s.biggestWin = 0;
  if (typeof s.lastActive !== 'number') s.lastActive = 0;
  if (typeof u.balance !== 'number' || !Number.isFinite(u.balance)) u.balance = STARTING_BALANCE;
  if (typeof u.lastDaily !== 'number') u.lastDaily = 0;
  if (typeof u.lastWeekly !== 'number') u.lastWeekly = 0;
  if (typeof u.lastWork !== 'number') u.lastWork = 0;
  if (typeof u.lastCrime !== 'number') u.lastCrime = 0;
  if (typeof u.lastSteal !== 'number') u.lastSteal = 0;
  if (u.job === undefined) u.job = null;
  return u;
}

function getUser(guildId, userId) {
  const g = getGuild(guildId);
  if (!g.users[userId]) {
    g.users[userId] = normalizeUser({ balance: STARTING_BALANCE });
    scheduleSave();
  } else {
    normalizeUser(g.users[userId]);
  }
  return g.users[userId];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmt(n) {
  const rounded = Math.round(n);
  const sign = rounded < 0 ? '-' : '';
  return `${sign}${CURRENCY}${Math.abs(rounded).toLocaleString('en-US')}`;
}

function fmtDuration(ms) {
  if (ms <= 0) return 'now';
  const totalSeconds = Math.ceil(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s && !h) parts.push(`${s}s`);
  if (!parts.length) parts.push('0s');
  return parts.join(' ');
}

function recordGame(u, net) {
  u.stats.gamesPlayed += 1;
  if (net > 0) {
    u.stats.gamesWon += 1;
    u.stats.totalWon += net;
    if (net > u.stats.biggestWin) u.stats.biggestWin = net;
  } else if (net < 0) {
    u.stats.gamesLost += 1;
    u.stats.totalLost += -net;
  }
}

function checkBet(u, bet) {
  if (!Number.isInteger(bet) || bet < MIN_BET) return 'Bet must be a positive whole number.';
  if (bet > u.balance) return `You don't have enough money. Your balance is ${fmt(u.balance)}.`;
  return null;
}

function trackMessage(guildId, userId) {
  try {
    const u = getUser(guildId, userId);
    u.stats.messages += 1;
    u.stats.lastActive = Date.now();
    scheduleSave();
  } catch (err) {
    console.warn('trackMessage failed:', err.message);
  }
}
// ---------------------------------------------------------------------------
// Blackjack
// ---------------------------------------------------------------------------
function makeDeck() {
  const deck = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push({ rank, suit });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function cardStr(c) { return `${c.rank}${c.suit}`; }

function hardValue(cards) {
  let t = 0;
  for (const c of cards) {
    if (c.rank === 'A') t += 1;
    else if (['J', 'Q', 'K'].includes(c.rank)) t += 10;
    else t += parseInt(c.rank, 10);
  }
  return t;
}

function handValue(cards) {
  let total = 0, aces = 0;
  for (const c of cards) {
    if (c.rank === 'A') { aces++; total += 11; }
    else if (['J', 'Q', 'K'].includes(c.rank)) total += 10;
    else total += parseInt(c.rank, 10);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

function isBlackjack(cards) {
  return cards.length === 2 && handValue(cards) === 21;
}

function isSoft(cards) {
  return handValue(cards) !== hardValue(cards);
}

function dealerShouldHit(hand, table) {
  const v = handValue(hand);
  if (v < 17) return true;
  if (v === 17 && table === 'european' && isSoft(hand)) return true;
  return false;
}

function resolveBlackjack(game) {
  while (dealerShouldHit(game.dealer, game.table)) {
    game.dealer.push(game.deck.pop());
  }
  const pv = handValue(game.player);
  const dv = handValue(game.dealer);
  const pbj = isBlackjack(game.player);
  const dbj = isBlackjack(game.dealer);

  if (pbj && dbj) return { outcome: 'push', net: 0, refund: game.bet };
  if (pbj) {
    const refund = Math.floor(game.bet * 2.5);
    return { outcome: 'blackjack', net: refund - game.bet, refund };
  }
  if (dbj) return { outcome: 'lose', net: -game.bet, refund: 0 };
  if (pv > 21) return { outcome: 'bust', net: -game.bet, refund: 0 };
  if (dv > 21) return { outcome: 'win', net: game.bet, refund: game.bet * 2 };
  if (pv > dv) return { outcome: 'win', net: game.bet, refund: game.bet * 2 };
  if (pv < dv) return { outcome: 'lose', net: -game.bet, refund: 0 };
  return { outcome: 'push', net: 0, refund: game.bet };
}

function applyBlackjackResult(game, result) {
  const u = getUser(game.guildId, game.userId);
  u.balance += result.refund;
  recordGame(u, result.net);
  scheduleSave();
  return u;
}

function blackjackPlayingEmbed(game) {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🃏 Blackjack')
    .addFields(
      { name: 'Your hand', value: `${game.player.map(cardStr).join(' ')}\n**${handValue(game.player)}**`, inline: true },
      { name: 'Dealer hand', value: `${cardStr(game.dealer[0])} 🂠\n**?**`, inline: true },
      { name: 'Bet', value: fmt(game.bet), inline: true },
      { name: 'Table', value: game.table === 'european' ? 'European (hits soft 17)' : 'Classic (stands on 17)', inline: true },
    )
    .setFooter({ text: 'Hit or Stand — game expires in 5 minutes.' });
}

function blackjackResultEmbed(game, result, balance) {
  const pv = handValue(game.player);
  const dv = handValue(game.dealer);
  const color = result.net > 0 ? 0x2ecc71 : result.net < 0 ? 0xe74c3c : 0xf1c40f;
  const title =
    result.outcome === 'blackjack' ? '🃏 Blackjack!' :
    result.outcome === 'bust' ? '💀 Bust!' :
    result.outcome === 'push' ? '🤝 Push' :
    result.net > 0 ? '🎉 You win!' : '💀 You lose';
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .addFields(
      { name: 'Your hand', value: `${game.player.map(cardStr).join(' ')}\n**${pv}**`, inline: true },
      { name: 'Dealer hand', value: `${game.dealer.map(cardStr).join(' ')}\n**${dv}**`, inline: true },
      { name: 'Bet', value: fmt(game.bet), inline: true },
      { name: 'Net', value: result.net > 0 ? `+${fmt(result.net)}` : result.net < 0 ? fmt(result.net) : fmt(0), inline: true },
      { name: 'Balance', value: fmt(balance), inline: true },
    );
}

function blackjackComponents(game) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`econ_bj:${game.id}:hit`).setLabel('Hit').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`econ_bj:${game.id}:stand`).setLabel('Stand').setStyle(ButtonStyle.Secondary),
  )];
}
// ---------------------------------------------------------------------------
// Mines
// ---------------------------------------------------------------------------
function minesMultiplier(total, bombs, revealed) {
  if (revealed <= 0) return 1;
  const safe = total - bombs;
  let prob = 1;
  for (let i = 0; i < revealed; i++) {
    prob *= (safe - i) / (total - i);
    if (prob <= 0) return 0;
  }
  if (prob <= 0) return 0;
  return (1 / prob) * 0.97;
}

function minesGrid(game, revealBombs) {
  const rows = game.total / MINES_COLS;
  const lines = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < MINES_COLS; c++) {
      const i = r * MINES_COLS + c;
      if (game.revealed.has(i) && !game.bombs.has(i)) row.push('💎');
      else if (revealBombs && game.bombs.has(i)) row.push('💣');
      else if (game.revealed.has(i)) row.push('💥');
      else row.push('⬛');
    }
    lines.push(row.join(' '));
  }
  return lines.join('\n');
}

function minesEmbed(game) {
  const mult = minesMultiplier(game.total, game.bombCount, game.revealed.size);
  const nextMult = minesMultiplier(game.total, game.bombCount, game.revealed.size + 1);
  const safeTotal = game.total - game.bombCount;
  const safeLeft = safeTotal - game.revealed.size;
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('💣 Mines')
    .setDescription(minesGrid(game, false))
    .addFields(
      { name: '💣 Bombs', value: String(game.bombCount), inline: true },
      { name: '💰 Bet', value: fmt(game.bet), inline: true },
      { name: '💎 Safe left', value: String(safeLeft), inline: true },
      { name: '📈 Current', value: `x${mult.toFixed(2)}`, inline: true },
      { name: '➡️ Next tile', value: `x${nextMult.toFixed(2)}`, inline: true },
      { name: '💵 Cash out', value: fmt(Math.floor(game.bet * mult)), inline: true },
    );
}

function minesResultEmbed(game, outcome, payout, mult, balance) {
  const cfg = {
    cashout: { color: 0x2ecc71, title: '💰 Cashed out!', desc: `You cashed out at **x${mult.toFixed(2)}** and won **${fmt(payout)}**.` },
    allclear: { color: 0x2ecc71, title: '🏆 Cleared the board!', desc: `You revealed every safe tile and won **${fmt(payout)}**!` },
    bust: { color: 0xe74c3c, title: '💥 Boom!', desc: `You hit a bomb and lost **${fmt(game.bet)}**.` },
    timeout: { color: 0xf1c40f, title: '⏱️ Timed out', desc: 'The game timed out.' },
  }[outcome] ?? { color: 0x95a5a6, title: 'Game over', desc: '' };
  return new EmbedBuilder()
    .setColor(cfg.color)
    .setTitle(cfg.title)
    .setDescription(`${cfg.desc}\n\n${minesGrid(game, true)}`)
    .addFields(
      { name: 'Bet', value: fmt(game.bet), inline: true },
      { name: 'Balance', value: fmt(balance), inline: true },
    );
}

function minesComponents(game) {
  const rows = game.total / MINES_COLS;
  const actionRows = [];
  for (let r = 0; r < rows; r++) {
    const row = new ActionRowBuilder();
    for (let c = 0; c < MINES_COLS; c++) {
      const i = r * MINES_COLS + c;
      const revealed = game.revealed.has(i);
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`econ_m:${game.id}:t:${i}`)
          .setLabel(String(i + 1))
          .setStyle(revealed ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setDisabled(revealed)
      );
    }
    actionRows.push(row);
  }
  const mult = minesMultiplier(game.total, game.bombCount, game.revealed.size);
  const cashout = Math.floor(game.bet * mult);
  actionRows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`econ_m:${game.id}:cash`)
      .setLabel(game.revealed.size === 0 ? `↩ Cancel (${fmt(game.bet)})` : `💰 Cash Out (${fmt(cashout)})`)
      .setStyle(ButtonStyle.Primary)
  ));
  return actionRows;
  }
// ---------------------------------------------------------------------------
// Active games
// ---------------------------------------------------------------------------
const activeGames = new Map();

function newGameId() {
  return crypto.randomBytes(6).toString('hex');
}

function scheduleGameTimeout(game, message) {
  game.timer = setTimeout(async () => {
    if (game.finished) return;
    try {
      if (game.type === 'blackjack') {
        const result = resolveBlackjack(game);
        const u = applyBlackjackResult(game, result);
        game.finished = true;
        activeGames.delete(game.id);
        await message.edit({ embeds: [blackjackResultEmbed(game, result, u.balance)], components: [] }).catch(() => {});
      } else if (game.type === 'mines') {
        const u = getUser(game.guildId, game.userId);
        if (game.revealed.size === 0) {
          u.balance += game.bet;
          scheduleSave();
        } else {
          const mult = minesMultiplier(game.total, game.bombCount, game.revealed.size);
          const payout = Math.floor(game.bet * mult);
          u.balance += payout;
          recordGame(u, payout - game.bet);
          scheduleSave();
        }
        game.finished = true;
        activeGames.delete(game.id);
        await message.edit({ embeds: [minesResultEmbed(game, 'timeout', 0, 0, u.balance)], components: [] }).catch(() => {});
      }
    } catch (err) {
      console.error('Game timeout error:', err);
    }
  }, GAME_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// Command definitions
// ---------------------------------------------------------------------------
const balanceCommand = new SlashCommandBuilder()
  .setName('balance')
  .setDescription("Check your (or another member's) balance")
  .addUserOption((o) => o.setName('member').setDescription('Member to check').setRequired(false))
  .setDMPermission(false);

const baltopCommand = new SlashCommandBuilder()
  .setName('baltop')
  .setDescription('Show the richest members in the server')
  .setDMPermission(false);

const dailyCommand = new SlashCommandBuilder()
  .setName('daily')
  .setDescription('Claim your daily reward')
  .setDMPermission(false);

const weeklyCommand = new SlashCommandBuilder()
  .setName('weekly')
  .setDescription('Claim your weekly reward')
  .setDMPermission(false);

const profileCommand = new SlashCommandBuilder()
  .setName('profile')
  .setDescription("View a member's economy profile")
  .addUserOption((o) => o.setName('member').setDescription('Member to view').setRequired(false))
  .setDMPermission(false);

const coinflipCommand = new SlashCommandBuilder()
  .setName('coinflip')
  .setDescription('Bet on a coin flip')
  .addIntegerOption((o) => o.setName('bet').setDescription('Amount to bet').setRequired(true).setMinValue(MIN_BET))
  .addStringOption((o) =>
    o.setName('choice').setDescription('Heads or tails (default heads)').setRequired(false)
      .addChoices({ name: 'Heads', value: 'heads' }, { name: 'Tails', value: 'tails' })
  )
  .setDMPermission(false);

const slotsCommand = new SlashCommandBuilder()
  .setName('slots')
  .setDescription('Spin the slot machine')
  .addIntegerOption((o) => o.setName('bet').setDescription('Amount to bet').setRequired(true).setMinValue(MIN_BET))
  .setDMPermission(false);

const blackjackCommand = new SlashCommandBuilder()
  .setName('blackjack')
  .setDescription('Play a game of blackjack')
  .addIntegerOption((o) => o.setName('bet').setDescription('Amount to bet').setRequired(true).setMinValue(MIN_BET))
  .addStringOption((o) =>
    o.setName('table').setDescription('Table rules (default classic)').setRequired(false)
      .addChoices(
        { name: 'Classic (dealer stands on 17)', value: 'classic' },
        { name: 'European (dealer hits soft 17)', value: 'european' }
      )
  )
  .setDMPermission(false);

const minesCommand = new SlashCommandBuilder()
  .setName('mines')
  .setDescription('Play a game of mines')
  .addIntegerOption((o) => o.setName('bet').setDescription('Amount to bet').setRequired(true).setMinValue(MIN_BET))
  .addIntegerOption((o) =>
    o.setName('bombs').setDescription('Number of bombs (default 3)').setRequired(false).setMinValue(1).setMaxValue(15)
  )
  .setDMPermission(false);

const workCommand = new SlashCommandBuilder()
  .setName('work')
  .setDescription('Do a safe job for a steady paycheck (1 hour cooldown)')
  .setDMPermission(false);

const crimeCommand = new SlashCommandBuilder()
  .setName('crime')
  .setDescription('Commit a risky crime for a big payout — or a big fine (1 hour cooldown)')
  .setDMPermission(false);

const stealCommand = new SlashCommandBuilder()
  .setName('steal')
  .setDescription('Try to steal from another member (2 hour cooldown)')
  .addUserOption((o) => o.setName('member').setDescription('Member to steal from').setRequired(true))
  .setDMPermission(false);
// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------
async function handleBalance(interaction) {
  const targetUser = interaction.options.getUser('member') ?? interaction.user;
  const member = interaction.options.getMember('member');
  const displayName = member?.displayName ?? targetUser.username;
  const u = getUser(interaction.guildId, targetUser.id);
  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(`💰 ${displayName}'s balance`)
    .setDescription(`**${fmt(u.balance)}**`)
    .setThumbnail(targetUser.displayAvatarURL({ size: 128 }));
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleBaltop(interaction) {
  const g = getGuild(interaction.guildId);
  const entries = Object.entries(g.users)
    .map(([id, u]) => ({ id, balance: normalizeUser(u).balance }))
    .sort((a, b) => b.balance - a.balance)
    .slice(0, 10);

  if (!entries.length) {
    await interaction.reply({ content: 'No economy data yet.', flags: MessageFlags.Ephemeral });
    return;
  }

  const medals = ['🥇', '🥈', '🥉'];
  const lines = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const member = interaction.guild.members.cache.get(e.id)
      ?? (await interaction.guild.members.fetch(e.id).catch(() => null));
    const name = member?.displayName ?? 'Unknown';
    const medal = medals[i] ?? `${i + 1}.`;
    lines.push(`${medal} **${name}** — ${fmt(e.balance)}`);
  }

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('🏆 Richest members')
    .setDescription(lines.join('\n'));
  await interaction.reply({ embeds: [embed] });
}

async function handleDaily(interaction) {
  const u = getUser(interaction.guildId, interaction.user.id);
  const now = Date.now();
  const elapsed = now - u.lastDaily;
  if (elapsed < DAILY_COOLDOWN_MS) {
    await interaction.reply({
      content: `⏳ You already claimed your daily. Come back in **${fmtDuration(DAILY_COOLDOWN_MS - elapsed)}**.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  u.lastDaily = now;
  u.balance += DAILY_AMOUNT;
  scheduleSave();
  await interaction.reply({
    content: `💰 You claimed your daily reward: **+${fmt(DAILY_AMOUNT)}**\nNew balance: **${fmt(u.balance)}**`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleWeekly(interaction) {
  const u = getUser(interaction.guildId, interaction.user.id);
  const now = Date.now();
  const elapsed = now - u.lastWeekly;
  if (elapsed < WEEKLY_COOLDOWN_MS) {
    await interaction.reply({
      content: `⏳ You already claimed your weekly. Come back in **${fmtDuration(WEEKLY_COOLDOWN_MS - elapsed)}**.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  u.lastWeekly = now;
  u.balance += WEEKLY_AMOUNT;
  scheduleSave();
  await interaction.reply({
    content: `💰 You claimed your weekly reward: **+${fmt(WEEKLY_AMOUNT)}**\nNew balance: **${fmt(u.balance)}**`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleProfile(interaction) {
  const targetUser = interaction.options.getUser('member') ?? interaction.user;
  const member = interaction.options.getMember('member');
  const displayName = member?.displayName ?? targetUser.username;
  const u = getUser(interaction.guildId, targetUser.id);
  const s = u.stats;
  const winRate = (s.gamesWon + s.gamesLost) > 0
    ? ((s.gamesWon / (s.gamesWon + s.gamesLost)) * 100).toFixed(1)
    : '0.0';
  const net = s.totalWon - s.totalLost;

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle(`📊 ${displayName}'s profile`)
    .setThumbnail(targetUser.displayAvatarURL({ size: 128 }))
    .addFields(
      { name: '💰 Wallet', value: fmt(u.balance), inline: true },
      { name: '💬 Messages', value: String(s.messages), inline: true },
      { name: '🎲 Games played', value: String(s.gamesPlayed), inline: true },
      { name: '🏆 Wins', value: String(s.gamesWon), inline: true },
      { name: '💀 Losses', value: String(s.gamesLost), inline: true },
      { name: '📈 Win rate', value: `${winRate}%`, inline: true },
      { name: '💵 Net betting', value: net >= 0 ? `+${fmt(net)}` : fmt(net), inline: true },
      { name: '🎯 Biggest win', value: fmt(s.biggestWin), inline: true },
    );
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleCoinflip(interaction) {
  const bet = interaction.options.getInteger('bet', true);
  const choice = interaction.options.getString('choice') ?? 'heads';
  const u = getUser(interaction.guildId, interaction.user.id);
  const err = checkBet(u, bet);
  if (err) { await interaction.reply({ content: err, flags: MessageFlags.Ephemeral }); return; }

  const result = Math.random() < 0.5 ? 'heads' : 'tails';
  const won = result === choice;
  const net = won ? bet : -bet;

  u.balance += net;
  recordGame(u, net);
  scheduleSave();

  const embed = new EmbedBuilder()
    .setColor(won ? 0x2ecc71 : 0xe74c3c)
    .setTitle(won ? '🪙 You won!' : '🪙 You lost!')
    .setDescription(`The coin landed on **${result}**. You guessed **${choice}**.`)
    .addFields(
      { name: 'Bet', value: fmt(bet), inline: true },
      { name: 'Net', value: won ? `+${fmt(bet)}` : `-${fmt(bet)}`, inline: true },
      { name: 'Balance', value: fmt(u.balance), inline: true },
    );
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleSlots(interaction) {
  const bet = interaction.options.getInteger('bet', true);
  const u = getUser(interaction.guildId, interaction.user.id);
  const err = checkBet(u, bet);
  if (err) { await interaction.reply({ content: err, flags: MessageFlags.Ephemeral }); return; }

  const reels = [0, 0, 0].map(() => SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)]);

  let mult = 0;
  if (reels[0] === reels[1] && reels[1] === reels[2]) {
    mult = SLOT_TRIPLE_PAYOUTS[reels[0]] ?? 0;
  } else if (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2]) {
    mult = SLOT_PAIR_PAYOUT;
  }

  const won = mult > 0;
  const payout = Math.floor(bet * mult);
  const net = payout - bet;

  u.balance += net;
  recordGame(u, net);
  scheduleSave();

  const embed = new EmbedBuilder()
    .setColor(won ? 0x2ecc71 : 0xe74c3c)
    .setTitle(won ? '🎰 Winner!' : '🎰 No luck')
    .setDescription(`# ${reels.join(' | ')}`)
    .addFields(
      { name: 'Bet', value: fmt(bet), inline: true },
      { name: 'Multiplier', value: `x${mult}`, inline: true },
      { name: 'Net', value: net >= 0 ? `+${fmt(net)}` : fmt(net), inline: true },
      { name: 'Balance', value: fmt(u.balance), inline: true },
    );
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleBlackjack(interaction) {
  const bet = interaction.options.getInteger('bet', true);
  const table = interaction.options.getString('table') ?? 'classic';
  const u = getUser(interaction.guildId, interaction.user.id);
  const err = checkBet(u, bet);
  if (err) { await interaction.reply({ content: err, flags: MessageFlags.Ephemeral }); return; }

  u.balance -= bet;
  scheduleSave();

  const game = {
    id: newGameId(),
    type: 'blackjack',
    userId: interaction.user.id,
    guildId: interaction.guildId,
    bet, table,
    deck: makeDeck(),
    player: [],
    dealer: [],
    finished: false,
  };
  game.player = [game.deck.pop(), game.deck.pop()];
  game.dealer = [game.deck.pop(), game.deck.pop()];

  if (isBlackjack(game.player) || isBlackjack(game.dealer)) {
    const result = resolveBlackjack(game);
    const uu = applyBlackjackResult(game, result);
    game.finished = true;
    await interaction.reply({ embeds: [blackjackResultEmbed(game, result, uu.balance)], flags: MessageFlags.Ephemeral });
    return;
  }

  activeGames.set(game.id, game);
  const msg = await interaction.reply({
    embeds: [blackjackPlayingEmbed(game)],
    components: blackjackComponents(game),
    flags: MessageFlags.Ephemeral,
    fetchReply: true,
  });
  game.messageId = msg.id;
  scheduleGameTimeout(game, msg);
}

async function handleMines(interaction) {
  const bet = interaction.options.getInteger('bet', true);
  const bombs = interaction.options.getInteger('bombs') ?? 3;
  const u = getUser(interaction.guildId, interaction.user.id);
  const err = checkBet(u, bet);
  if (err) { await interaction.reply({ content: err, flags: MessageFlags.Ephemeral }); return; }
  if (bombs < 1 || bombs >= MINES_TOTAL) {
    await interaction.reply({ content: `Bombs must be between 1 and ${MINES_TOTAL - 1}.`, flags: MessageFlags.Ephemeral });
    return;
  }

  u.balance -= bet;
  scheduleSave();

  const positions = [...Array(MINES_TOTAL).keys()];
  for (let i = positions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [positions[i], positions[j]] = [positions[j], positions[i]];
  }
  const bombSet = new Set(positions.slice(0, bombs));

  const game = {
    id: newGameId(),
    type: 'mines',
    userId: interaction.user.id,
    guildId: interaction.guildId,
    bet,
    bombs: bombSet,
    revealed: new Set(),
    total: MINES_TOTAL,
    bombCount: bombs,
    finished: false,
  };
  activeGames.set(game.id, game);

  const msg = await interaction.reply({
    embeds: [minesEmbed(game)],
    components: minesComponents(game),
    flags: MessageFlags.Ephemeral,
    fetchReply: true,
  });
  game.messageId = msg.id;
  scheduleGameTimeout(game, msg);
      }
async function handleWork(interaction) {
  const u = getUser(interaction.guildId, interaction.user.id);
  const now = Date.now();
  const elapsed = now - u.lastWork;
  if (elapsed < WORK_COOLDOWN_MS) {
    await interaction.reply({
      content: `⏳ You need to rest. Come back in **${fmtDuration(WORK_COOLDOWN_MS - elapsed)}**.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const job = JOBS[Math.floor(Math.random() * JOBS.length)];
  const pay = Math.floor(Math.random() * (job.max - job.min + 1)) + job.min;
  u.balance += pay;
  u.lastWork = now;
  u.job = job.name;
  scheduleSave();
  await interaction.reply({
    content: `💼 You worked as a **${job.name}** and earned **+${fmt(pay)}**.\nNew balance: **${fmt(u.balance)}**`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleCrime(interaction) {
  const u = getUser(interaction.guildId, interaction.user.id);
  const now = Date.now();
  const elapsed = now - u.lastCrime;
  if (elapsed < CRIME_COOLDOWN_MS) {
    await interaction.reply({
      content: `⏳ Lay low for a bit. Come back in **${fmtDuration(CRIME_COOLDOWN_MS - elapsed)}**.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  u.lastCrime = now;
  const crime = CRIME_SCENARIOS[Math.floor(Math.random() * CRIME_SCENARIOS.length)];
  const success = Math.random() < 0.55;

  if (success) {
    const pay = Math.floor(Math.random() * 1001) + 500;
    u.balance += pay;
    scheduleSave();
    await interaction.reply({
      content: `🦹 You **${crime}** and got away with **+${fmt(pay)}**!\nNew balance: **${fmt(u.balance)}**`,
      flags: MessageFlags.Ephemeral,
    });
  } else {
    const finePct = 0.1 + Math.random() * 0.15;
    const fine = Math.floor(u.balance * finePct);
    u.balance -= fine;
    scheduleSave();
    await interaction.reply({
      content: `🚔 You tried to **${crime}** but got caught! You paid a fine of **-${fmt(fine)}** (${(finePct * 100).toFixed(1)}% of your balance).\nNew balance: **${fmt(u.balance)}**`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function handleSteal(interaction) {
  const targetUser = interaction.options.getUser('member', true);
  const member = interaction.options.getMember('member');

  if (targetUser.id === interaction.user.id) {
    await interaction.reply({ content: "You can't steal from yourself.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (targetUser.bot) {
    await interaction.reply({ content: "You can't steal from a bot.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!member) {
    await interaction.reply({ content: "That user isn't in this server.", flags: MessageFlags.Ephemeral });
    return;
  }

  const u = getUser(interaction.guildId, interaction.user.id);
  const target = getUser(interaction.guildId, targetUser.id);

  if (target.balance <= 0) {
    await interaction.reply({
      content: 'That member has no money to steal. (Vetoed — no cooldown used.)',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const now = Date.now();
  const elapsed = now - u.lastSteal;
  if (elapsed < STEAL_COOLDOWN_MS) {
    await interaction.reply({
      content: `⏳ You need to wait **${fmtDuration(STEAL_COOLDOWN_MS - elapsed)}** before stealing again.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  u.lastSteal = now;
  const success = Math.random() < 0.5;

  if (success) {
    const pct = 0.1 + Math.random() * 0.15;
    const amount = Math.max(1, Math.floor(target.balance * pct));
    target.balance -= amount;
    u.balance += amount;
    scheduleSave();
    await interaction.reply({
      content: `🕵️ You stole **${fmt(amount)}** from <@${targetUser.id}>!\nYour balance: **${fmt(u.balance)}**`,
      allowedMentions: { users: [targetUser.id] },
    });
  } else {
    const pct = 0.1 + Math.random() * 0.15;
    const fine = Math.max(0, Math.floor(u.balance * pct));
    u.balance -= fine;
    target.balance += fine;
    scheduleSave();
    await interaction.reply({
      content: `🚔 You got caught trying to steal from <@${targetUser.id}>! You paid a fine of **${fmt(fine)}** to them.\nYour balance: **${fmt(u.balance)}**`,
      allowedMentions: { users: [targetUser.id] },
    });
  }
}

// ---------------------------------------------------------------------------
// Button handler (no collectors — full control)
// ---------------------------------------------------------------------------
async function handleBjButton(interaction, game, action) {
  if (game.finished) {
    await interaction.reply({ content: 'This game has already ended.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === 'hit') {
    game.player.push(game.deck.pop());
    const pv = handValue(game.player);
    if (pv >= 21) {
      const result = resolveBlackjack(game);
      const u = applyBlackjackResult(game, result);
      game.finished = true;
      activeGames.delete(game.id);
      if (game.timer) clearTimeout(game.timer);
      await interaction.update({ embeds: [blackjackResultEmbed(game, result, u.balance)], components: [] });
      return;
    }
    await interaction.update({ embeds: [blackjackPlayingEmbed(game)], components: blackjackComponents(game) });
  } else if (action === 'stand') {
    const result = resolveBlackjack(game);
    const u = applyBlackjackResult(game, result);
    game.finished = true;
    activeGames.delete(game.id);
    if (game.timer) clearTimeout(game.timer);
    await interaction.update({ embeds: [blackjackResultEmbed(game, result, u.balance)], components: [] });
  }
}

async function handleMinesTile(interaction, game, index) {
  if (game.finished) {
    await interaction.reply({ content: 'This game has already ended.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (!Number.isInteger(index) || index < 0 || index >= game.total) {
    await interaction.reply({ content: 'Invalid tile.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (game.revealed.has(index)) {
    await interaction.deferUpdate();
    return;
  }

  if (game.bombs.has(index)) {
    game.revealed.add(index);
    game.finished = true;
    activeGames.delete(game.id);
    if (game.timer) clearTimeout(game.timer);
    const u = getUser(game.guildId, game.userId);
    recordGame(u, -game.bet);
    scheduleSave();
    await interaction.update({ embeds: [minesResultEmbed(game, 'bust', 0, 0, u.balance)], components: [] });
    return;
  }

  game.revealed.add(index);
  const safeTotal = game.total - game.bombCount;
  if (game.revealed.size === safeTotal) {
    const mult = minesMultiplier(game.total, game.bombCount, game.revealed.size);
    const payout = Math.floor(game.bet * mult);
    const u = getUser(game.guildId, game.userId);
    u.balance += payout;
    recordGame(u, payout - game.bet);
    scheduleSave();
    game.finished = true;
    activeGames.delete(game.id);
    if (game.timer) clearTimeout(game.timer);
    await interaction.update({ embeds: [minesResultEmbed(game, 'allclear', payout, mult, u.balance)], components: [] });
    return;
  }

  await interaction.update({ embeds: [minesEmbed(game)], components: minesComponents(game) });
}

async function handleMinesCashout(interaction, game) {
  if (game.finished) {
    await interaction.reply({ content: 'This game has already ended.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (game.revealed.size === 0) {
    const u = getUser(game.guildId, game.userId);
    u.balance += game.bet;
    scheduleSave();
    game.finished = true;
    activeGames.delete(game.id);
    if (game.timer) clearTimeout(game.timer);
    await interaction.update({
      embeds: [new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle('💸 Cancelled')
        .setDescription(`You cancelled the game and got your **${fmt(game.bet)}** back.`)],
      components: [],
    });
    return;
  }
  const mult = minesMultiplier(game.total, game.bombCount, game.revealed.size);
  const payout = Math.floor(game.bet * mult);
  const u = getUser(game.guildId, game.userId);
  u.balance += payout;
  recordGame(u, payout - game.bet);
  scheduleSave();
  game.finished = true;
  activeGames.delete(game.id);
  if (game.timer) clearTimeout(game.timer);
  await interaction.update({ embeds: [minesResultEmbed(game, 'cashout', payout, mult, u.balance)], components: [] });
}

async function handleEconomyButton(interaction) {
  const id = interaction.customId;
  if (!id.startsWith('econ_bj:') && !id.startsWith('econ_m:')) return false;

  const parts = id.split(':');
  const prefix = parts[0];
  const gameId = parts[1];
  const game = activeGames.get(gameId);

  if (!game) {
    await interaction.reply({ content: 'This game has expired.', flags: MessageFlags.Ephemeral }).catch(() => {});
    return true;
  }
  if (interaction.user.id !== game.userId) {
    await interaction.reply({ content: "This isn't your game.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return true;
  }

  try {
    if (prefix === 'econ_bj') {
      await handleBjButton(interaction, game, parts[2]);
    } else if (prefix === 'econ_m') {
      if (parts[2] === 'cash') await handleMinesCashout(interaction, game);
      else if (parts[2] === 't') await handleMinesTile(interaction, game, parseInt(parts[3], 10));
    }
  } catch (err) {
    console.error('Economy button error:', err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Command routing
// ---------------------------------------------------------------------------
const ECONOMY_COMMAND_NAMES = new Set([
  'balance', 'baltop', 'daily', 'weekly', 'profile',
  'coinflip', 'slots', 'blackjack', 'mines',
  'work', 'crime', 'steal',
]);

async function handleEconomyCommand(interaction) {
  if (!ECONOMY_COMMAND_NAMES.has(interaction.commandName)) return false;
  try {
    const name = interaction.commandName;
    if (name === 'balance') await handleBalance(interaction);
    else if (name === 'baltop') await handleBaltop(interaction);
    else if (name === 'daily') await handleDaily(interaction);
    else if (name === 'weekly') await handleWeekly(interaction);
    else if (name === 'profile') await handleProfile(interaction);
    else if (name === 'coinflip') await handleCoinflip(interaction);
    else if (name === 'slots') await handleSlots(interaction);
    else if (name === 'blackjack') await handleBlackjack(interaction);
    else if (name === 'mines') await handleMines(interaction);
    else if (name === 'work') await handleWork(interaction);
    else if (name === 'crime') await handleCrime(interaction);
    else if (name === 'steal') await handleSteal(interaction);
    return true;
  } catch (err) {
    console.error('Economy command error:', err);
    const msg = { content: 'Something went wrong with that economy command.', flags: MessageFlags.Ephemeral };
    if (interaction.replied || interaction.deferred) await interaction.editReply(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
    return true;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  EconomyCommands: [
    { command: balanceCommand, category: 'economy' },
    { command: baltopCommand, category: 'economy' },
    { command: dailyCommand, category: 'economy' },
    { command: weeklyCommand, category: 'economy' },
    { command: profileCommand, category: 'economy' },
    { command: coinflipCommand, category: 'economy' },
    { command: slotsCommand, category: 'economy' },
    { command: blackjackCommand, category: 'economy' },
    { command: minesCommand, category: 'economy' },
    { command: workCommand, category: 'economy' },
    { command: crimeCommand, category: 'economy' },
    { command: stealCommand, category: 'economy' },
  ],
  handleEconomyCommand,
  handleEconomyButton,
  trackMessage,
};
