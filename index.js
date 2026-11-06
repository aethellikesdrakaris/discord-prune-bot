// index.js
// Discord bot: reposts messages that match a filter list, contain any
// attachment (including GIF and MP4 files), or contain any link (including
// GIF and MP4 links) via a per-channel webhook using the original author's
// name + avatar. Reposts are identical to the original: text, links, and
// attachments. The original is deleted only after the repost succeeds.

const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  AttachmentBuilder,
  SlashCommandBuilder,
  MessageFlags,
  AutoModerationRuleTriggerType,
  EmbedBuilder,
} = require('discord.js');
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { shouldFilter } = require('./filters');
const economy = require('./economy');
const ALLOWED_GUILD_ID = process.env.GUILD_ID;

// Channels inside these categories are never filtered or reposted.
// Replace with your real category IDs (Developer Mode -> long-press category -> Copy ID).
const EXEMPT_CATEGORY_IDS = ['123456789012345678', '987654321098765432'];

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildWebhooks,
    GatewayIntentBits.GuildMembers, // needed for guildMemberAdd (re-quarantine on rejoin)
  ],
  partials: [Partials.Message, Partials.Channel],
});

// Cache webhooks per channel so we don't create a new one on every message.
const webhookCache = new Map(); // channelId -> Webhook

// Remembers the ORIGINAL text and author of every message we repost, keyed by
// the repost's message ID. Replying to a repost then quotes the clean text and
// mentions the real user (the repost's own author is just the webhook).
const repostCache = new Map(); // repostMessageId -> { content, authorId }
const REPOST_CACHE_LIMIT = 5000;

const WEBHOOK_NAME = 'filter-relay';

// Matches any link.
const LINK_PATTERN = /https?:\/\/\S+/i;

/**
 * Removes links from text, used for quoted reply snippets only.
 */
function stripLinks(content) {
  if (!content) return content;
  return content.replace(/https?:\/\/\S+/gi, '').replace(/[ \t]+\n/g, '\n').trim();
}

/**
 * Removes the reply header line (current and older formats) that this bot
 * prepends to reposted replies, so quoting a reply only shows its own text.
 */
function stripReplyPrefix(content) {
  if (!content) return content;
  let text = content;
  const header = /^\s*(?:-#|Replying to|>)[^\n]*(?:\n|$)/;
  // Keep removing while the first line is a header that contains a mention.
  while (header.test(text) && /<@!?\d+>/.test(text.split('\n')[0])) {
    text = text.replace(header, '');
  }
  return text;
}
/**
 * Get or create the bot's webhook in a given text channel.
 * Threads can't own webhooks, so for a thread the parent channel's webhook is
 * used (callers pass threadId when sending).
 */
async function getWebhook(channel) {
  const base = channel.isThread() ? channel.parent : channel;
  if (!base) return null;

  if (webhookCache.has(base.id)) {
    return webhookCache.get(base.id);
  }

  // Need MANAGE_WEBHOOKS permission in this channel.
  const me = base.guild.members.me;
  if (!base.permissionsFor(me).has(PermissionsBitField.Flags.ManageWebhooks)) {
    console.warn(`Missing Manage Webhooks permission in #${base.name}`);
    return null;
  }

  const existing = await base.fetchWebhooks();
  let webhook = existing.find((wh) => wh.name === WEBHOOK_NAME && wh.owner?.id === client.user.id);

  if (!webhook) {
    webhook = await base.createWebhook({
      name: WEBHOOK_NAME,
      reason: 'Used to relay filtered messages under the original author\'s identity',
    });
  }

  webhookCache.set(base.id, webhook);
  return webhook;
}

/** Stores a repost so replies to it can quote the original text and author. */
function rememberRepost(sent, content, authorId) {
  if (!sent?.id) return;
  repostCache.set(sent.id, { content: content ?? '', authorId });
  if (repostCache.size > REPOST_CACHE_LIMIT) {
    repostCache.delete(repostCache.keys().next().value);
  }
}
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return; // ignore bots/webhooks (avoid loops)
    if (!message.guild) return; // ignore DMs
    if (ALLOWED_GUILD_ID && message.guild.id !== ALLOWED_GUILD_ID) return;

    // Activity tracking for economy profiles.
    economy.trackMessage(message.guild.id, message.author.id);

    // Skip channels (and threads inside channels) in exempt categories.
    const categoryId = message.channel.isThread()
      ? message.channel.parent?.parentId
      : message.channel.parentId;
    if (categoryId && EXEMPT_CATEGORY_IDS.includes(categoryId)) return;

    const attachments = [...message.attachments.values()];
    const hasFilteredText = shouldFilter(message.content);
    const hasAnyAttachment = attachments.length > 0;
    const hasLink = LINK_PATTERN.test(message.content ?? '');

    // Nothing to do unless the text is flagged, the message has any
    // attachment (GIF/MP4 included), or it contains a link (GIF/MP4 included).
    if (!hasFilteredText && !hasAnyAttachment && !hasLink) return;

    const channel = message.channel;

    // Need permission to delete messages in this channel.
    const me = message.guild.members.me;
    if (!channel.permissionsFor(me).has(PermissionsBitField.Flags.ManageMessages)) {
      console.warn(`Missing Manage Messages permission in #${channel.name}`);
      return;
    }

    const webhook = await getWebhook(channel);
    if (!webhook) return;

    const displayName = message.member?.displayName ?? message.author.username;
    const avatarURL = message.author.displayAvatarURL({ extension: 'png', size: 256 });

    // Download every attachment now, before the original is deleted, so the
    // repost contains the real file bytes.
    const files = await Promise.all(
      attachments.map(async (a) => {
        const res = await fetch(a.url);
        if (!res.ok) throw new Error(`Failed to download ${a.name}: HTTP ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        return new AttachmentBuilder(buffer, { name: a.name });
      })
    );

    // Webhooks can't trigger Discord's native "replying to" UI (that's a
    // platform limitation, not a library one). Closest match: a real mention
    // (renders as a blue pill even without pinging) followed by the quoted
    // snippet as a masked link that jumps to the original message.
    let replyPrefix = '';
    let pingUserId = null; // person who gets a ghost ping for this reply
    if (message.reference?.messageId) {
      try {
        const referenced = await message.fetchReference();

        // Drop any reply header the referenced message carries (it may itself
        // be a reposted reply) BEFORE stripping links, so only its own text is quoted.
        const cached = repostCache.get(referenced.id);
        const refAuthorId = cached?.authorId ?? referenced.author.id;
        const refText = cached
          ? cached.content
          : stripReplyPrefix(referenced.content ?? '');
        const rawRefContent = refText.length ? stripLinks(refText) : '';
        let snippet = rawRefContent
          .replace(/<@[!&]?\d+>/g, '')                // no raw mention tokens in the quote
          .replace(/\s*\n+\s*/g, ' ')                 // collapse newlines
          .replace(/([\[\]\\*_~`|])/g, '\\$1');       // escape markdown that would break the link
        if (snippet.length > 60) snippet = `${snippet.slice(0, 60).trimEnd()}…`;

        if (!snippet) {
          const first = referenced.attachments.first();
          const type = first?.contentType ?? '';
          if (type.startsWith('image/')) snippet = '🖼️ Image';
          else if (type.startsWith('video/')) snippet = '🎬 Video';
          else if (first) snippet = '📎 Attachment';
          else snippet = 'Click to see message';
        }

        const jumpUrl = `https://discord.com/channels/${message.reference.guildId ?? message.guild.id}/${message.reference.channelId}/${message.reference.messageId}`;

        replyPrefix = `-# ↩ Replying to <@${refAuthorId}> [${snippet}](${jumpUrl})\n`;

        // Ghost ping the person being replied to. Skip self-replies and replies
        // to bots/webhooks we have no record of (no real user to ping).
        const targetIsRealUser = cached || !referenced.author.bot;
        if (targetIsRealUser && refAuthorId !== message.author.id) {
          pingUserId = refAuthorId;
        }
      } catch (err) {
        console.warn('Could not fetch referenced message (it may have been deleted):', err.message);
      }
    }

    // Repost FIRST, with the original text, links, and attachments. Only
    // delete the original once the repost has succeeded.
    const sent = await webhook.send({
      content: `${replyPrefix}${message.content ?? ''}`.trim() || undefined,
      username: displayName,
      avatarURL,
      files: files.length ? files : undefined,
      // If this channel is a thread, target it explicitly:
      threadId: channel.isThread() ? channel.id : undefined,
      // Render the mention's blue pill but don't actually ping them again.
      allowedMentions: { users: [] },
    });

    rememberRepost(sent, message.content, message.author.id);

    await message.delete();

    // Ghost ping: the repost can't notify the replied-to user (webhook mentions
    // are silenced and the original reply is gone), so ping and delete right away.
    if (pingUserId) {
      try {
        const ping = await channel.send({
          content: `<@${pingUserId}>`,
          allowedMentions: { users: [pingUserId] },
        });
        await ping.delete();
      } catch (err) {
        console.warn('Could not send ghost ping:', err.message);
      }
    }
  } catch (err) {
    console.error('Error handling message:', err);
  }
});
// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

// Members need the "Meowbot Perms" role to use ANY slash command of this bot.
const SLASH_ROLE_ID = '1567533777897660496';

// Blocked /say attempts are reported here, with a ping.
const LOG_CHANNEL_ID = '1566029900144447590';
// Your Discord user ID (Developer Mode -> long-press your profile -> Copy User ID).
// If left empty, the bot pings the owner of the bot application instead.
const LOG_PING_USER_ID = '1431315130725044412';

// /say: posts a message in the current channel through a webhook, using the
// name + avatar of the member who ran the command (so it looks like they sent
// it). Webhook messages skip the filter, so the text is checked against the
// server's AutoMod rules first and refused if it would have been blocked.
const sayCommand = new SlashCommandBuilder()
  .setName('say')
  .setDescription('Send a message in this channel as yourself')
  .addStringOption((option) =>
    option
      .setName('message')
      .setDescription('What to say (optional if you attach a file)')
      .setRequired(false)
      .setMaxLength(2000)
  )
  .addAttachmentOption((option) =>
    option.setName('attachment').setDescription('A file to include').setRequired(false)
  )
  .addAttachmentOption((option) =>
    option.setName('attachment2').setDescription('Another file to include').setRequired(false)
  )
  .addAttachmentOption((option) =>
    option.setName('attachment3').setDescription('Another file to include').setRequired(false)
  )
  .setDMPermission(false);

const SAY_ATTACHMENT_OPTIONS = ['attachment', 'attachment2', 'attachment3'];

// Only members with this role ("image perms") can attach files with /say.
const IMAGE_ROLE_ID = '1564693838579372092';

// --- Quarantine -------------------------------------------------------------
// /quarantine removes every role it can from a member and gives them the
// Manual Quarantine role. The removed roles are saved to quarantine.json (next
// to this file) so /unquarantine can put them back, even after a restart.

const QUARANTINE_ROLE_ID = '1564340604975190107';

// --- Command categories -----------------------------------------------------
// Every command belongs to a category, and each category says which roles may
// use it. Anyone holding a denied role is refused, whatever else they have.
// Commands are assigned to a category in the COMMANDS list further down; one
// that isn't listed there falls into "general".

const MODERATION_ROLE_ID = '1564692792754831471';
const MODERATION_BLOCKED_ROLE_ID = '1564340272127676558';

const COMMAND_CATEGORIES = {
  // Open to everyone, no role needed.
  everyone: {
    label: 'Everyone',
    emoji: 'ℹ️',
    public: true,
    allowedRoles: [],
    deniedRoles: [],
  },
  // All-purpose commands: Meowbot Perms role (moderators can use them too).
  general: {
    label: 'General',
    emoji: '💬',
    allowedRoles: [SLASH_ROLE_ID, MODERATION_ROLE_ID],
    deniedRoles: [],
  },
  // Moderation commands: ONLY the moderation role, and never the blocked role.
  moderation: {
    label: 'Moderation',
    emoji: '🛡️',
    allowedRoles: [MODERATION_ROLE_ID],
    deniedRoles: [MODERATION_BLOCKED_ROLE_ID],
  },
  // Economy commands: open to everyone.
  economy: {
    label: 'Economy',
    emoji: '💰',
    public: true,
    allowedRoles: [],
    deniedRoles: [],
  },
};

/** Category of a command, looked up in COMMANDS (unlisted commands count as general). */
function categoryForCommand(commandName) {
  const entry = COMMANDS.find((e) => e.command.name === commandName);
  return COMMAND_CATEGORIES[entry?.category] ?? COMMAND_CATEGORIES.general;
}

/** Whether a member holding `roleIds` may run `commandName`. */
function canUseCommand(roleIds, commandName) {
  const category = categoryForCommand(commandName);
  if (category.public) return true;
  if (roleIds.some((id) => category.deniedRoles.includes(id))) return false;
  return roleIds.some((id) => category.allowedRoles.includes(id));
}
// Quarantine / unquarantine actions are logged here.
const QUARANTINE_LOG_CHANNEL_ID = '1564690800141537390';
const QUARANTINE_FILE = path.join(__dirname, 'quarantine.json');

const quarantineCommand = new SlashCommandBuilder()
  .setName('quarantine')
  .setDescription("Remove all of a member's roles and give them the Manual Quarantine role")
  .addUserOption((option) =>
    option.setName('member').setDescription('Member to quarantine').setRequired(true)
  )
  .addStringOption((option) =>
    option
      .setName('reason')
      .setDescription('Reason (saved in the audit log)')
      .setRequired(false)
      .setMaxLength(400)
  )
  .setDMPermission(false);

const unquarantineCommand = new SlashCommandBuilder()
  .setName('unquarantine')
  .setDescription("Restore a member's saved roles and remove the Manual Quarantine role")
  .addUserOption((option) =>
    option.setName('member').setDescription('Member to release').setRequired(true)
  )
  .addStringOption((option) =>
    option
      .setName('reason')
      .setDescription('Reason (saved in the audit log)')
      .setRequired(false)
      .setMaxLength(400)
  )
  .setDMPermission(false);

function loadQuarantineStore() {
  try {
    return JSON.parse(fs.readFileSync(QUARANTINE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveQuarantineStore(store) {
  fs.writeFileSync(QUARANTINE_FILE, JSON.stringify(store, null, 2));
}

/** Posts a quarantine/unquarantine entry in the log channel (no pings). */
async function logModAction(interaction, title, color, target, details) {
  try {
    const logChannel = await interaction.guild.channels.fetch(QUARANTINE_LOG_CHANNEL_ID);
    if (!logChannel?.isTextBased()) return;
    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(title)
      .setThumbnail(target.user.displayAvatarURL({ extension: 'png', size: 128 }))
      .addFields(
        { name: '👤 Member', value: `<@${target.id}>\n\`${target.id}\``, inline: true },
        { name: '🛠️ Moderator', value: `<@${interaction.user.id}>`, inline: true },
        { name: '📝 Details', value: details.slice(0, 1000) }
      )
      .setFooter({ text: 'Meowbot • quarantine log' })
      .setTimestamp();
    await logChannel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (err) {
    console.warn('Could not log quarantine action:', err.message);
  }
}

/** Posts a quarantine event in the quarantine log channel (no pings). */
async function logQuarantineEvent(guild, title, color, user, details, moderatorId = null) {
  try {
    const logChannel = await guild.channels.fetch(QUARANTINE_LOG_CHANNEL_ID);
    if (!logChannel?.isTextBased()) return;

    const fields = [{ name: '👤 Member', value: `<@${user.id}>\n\`${user.id}\``, inline: true }];
    if (moderatorId) fields.push({ name: '🛠️ Moderator', value: `<@${moderatorId}>`, inline: true });
    fields.push({ name: '📝 Details', value: details.slice(0, 1000) });

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(title)
      .addFields(fields)
      .setFooter({ text: 'Meowbot • quarantine log' })
      .setTimestamp();
    await logChannel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (err) {
    console.warn('Could not log quarantine event:', err.message);
  }
}
async function handleQuarantine(interaction, quarantining) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const guild = interaction.guild;
    const target = interaction.options.getMember('member');
    const reason = interaction.options.getString('reason') ?? 'No reason given';

    if (!target) {
      // Not in the server. A quarantine still on record can be released now:
      // their roles are restored when they rejoin.
      const targetUser = interaction.options.getUser('member');
      const absentKey = `${guild.id}:${targetUser.id}`;
      const absentStore = loadQuarantineStore();

      if (!quarantining && absentStore[absentKey]) {
        absentStore[absentKey].pendingRelease = true;
        saveQuarantineStore(absentStore);
        await interaction.editReply(
          `<@${targetUser.id}> isn't in the server. Their roles will be restored when they rejoin.`
        );
        await logQuarantineEvent(
          guild,
          '🔓 Quarantine released (not in server)',
          0x57f287,
          targetUser,
          `Reason: ${reason}\nRoles will be restored when they rejoin.`,
          interaction.user.id
        );
        return;
      }

      await interaction.editReply(
        quarantining
          ? "That user isn't in this server, so I can't quarantine them."
          : "That user isn't in this server and isn't quarantined."
      );
      return;
    }
    if (target.id === interaction.user.id) {
      await interaction.editReply("You can't do that to yourself.");
      return;
    }
    if (target.id === client.user.id || target.id === guild.ownerId) {
      await interaction.editReply("I can't do that to that member.");
      return;
    }

    const me = guild.members.me;
    const invoker = await guild.members.fetch(interaction.user.id);
    const isOwner = interaction.user.id === guild.ownerId;
    const botTop = me.roles.highest.position;

    if (target.roles.highest.position >= botTop) {
      await interaction.editReply("That member's highest role is at or above mine, so I can't change their roles.");
      return;
    }
    if (!isOwner && target.roles.highest.position >= invoker.roles.highest.position) {
      await interaction.editReply("That member's highest role is at or above yours.");
      return;
    }

    const quarantineRole =
      guild.roles.cache.get(QUARANTINE_ROLE_ID) ?? (await guild.roles.fetch(QUARANTINE_ROLE_ID));
    if (!quarantineRole) {
      await interaction.editReply("I can't find the Manual Quarantine role. Check QUARANTINE_ROLE_ID.");
      return;
    }
    if (quarantineRole.position >= botTop) {
      await interaction.editReply('Move my role above the Manual Quarantine role so I can assign it.');
      return;
    }

    const store = loadQuarantineStore();
    const key = `${guild.id}:${target.id}`;

    if (quarantining) {
      if (store[key]) {
        await interaction.editReply('That member is already quarantined.');
        return;
      }

      const removable = [];
      const kept = [];
      for (const role of target.roles.cache.values()) {
        if (role.id === guild.id || role.id === QUARANTINE_ROLE_ID) continue; // @everyone / already has it
        // Managed roles (boosters, bot/integration roles) can't be removed by hand.
        if (role.managed || role.position >= botTop) kept.push(role);
        else removable.push(role);
      }

      // Save BEFORE changing anything so the roles can never be lost.
      store[key] = { roles: removable.map((r) => r.id), at: Date.now(), by: interaction.user.id };
      saveQuarantineStore(store);

      try {
        await target.roles.set(
          [...kept.map((r) => r.id), QUARANTINE_ROLE_ID],
          `Quarantined by ${interaction.user.tag}: ${reason}`
        );
      } catch (err) {
        delete store[key];
        saveQuarantineStore(store);
        throw err;
      }

      const keptNote = kept.length ? ` (couldn't remove: ${kept.map((r) => r.name).join(', ')})` : '';
      await interaction.editReply(
        `Quarantined <@${target.id}>. Removed ${removable.length} role(s) and gave them Manual Quarantine${keptNote}.`
      );
      await logModAction(
        interaction,
        '🔒 Member quarantined',
        0xed4245,
        target,
        `Reason: ${reason}\nRemoved roles: ${removable.length ? removable.map((r) => `<@&${r.id}>`).join(' ') : 'none'}`
      );
      return;
    }

    // --- unquarantine ---
    const entry = store[key];
    const hasRole = target.roles.cache.has(QUARANTINE_ROLE_ID);
    if (!entry && !hasRole) {
      await interaction.editReply("That member isn't quarantined.");
      return;
    }

    const restorable = [];
    const skipped = [];
    for (const id of entry?.roles ?? []) {
      const role = guild.roles.cache.get(id);
      if (!role) continue; // role was deleted since
      // Don't let anyone hand out roles above their own or above mine.
      if (role.managed || role.position >= botTop || (!isOwner && role.position >= invoker.roles.highest.position)) {
        skipped.push(role);
      } else {
        restorable.push(role);
      }
    }

    const current = target.roles.cache
      .filter((r) => r.id !== guild.id && r.id !== QUARANTINE_ROLE_ID)
      .map((r) => r.id);

    await target.roles.set(
      [...new Set([...current, ...restorable.map((r) => r.id)])],
      `Unquarantined by ${interaction.user.tag}: ${reason}`
    );

    if (entry) {
      delete store[key];
      saveQuarantineStore(store);
    }

    const skippedNote = skipped.length
      ? ` Couldn't restore: ${skipped.map((r) => r.name).join(', ')} (above your role or mine).`
      : '';
    await interaction.editReply(
      entry
        ? `Unquarantined <@${target.id}>. Restored ${restorable.length} role(s) and removed Manual Quarantine.${skippedNote}`
        : `Removed Manual Quarantine from <@${target.id}>. I had no saved roles for them, so nothing was restored.`
    );
    await logModAction(
      interaction,
      '🔓 Member unquarantined',
      0x57f287,
      target,
      `Reason: ${reason}\nRestored roles: ${restorable.length ? restorable.map((r) => `<@&${r.id}>`).join(' ') : 'none'}`
    );
  } catch (err) {
    console.error('Error handling quarantine command:', err);
    await interaction
      .editReply("I couldn't do that. Check that I have Manage Roles and that my role is above the roles involved.")
      .catch(() => {});
  }
}

/** Role IDs of the member who ran an interaction. */
function memberRoleIds(member) {
  const roles = member?.roles;
  if (!roles) return [];
  return Array.isArray(roles) ? roles : [...roles.cache.keys()];
}
// --- AutoMod sync -----------------------------------------------------------
// Reads the server's enabled keyword AutoMod rules (needs the bot to have the
// Manage Server permission) and checks /say text against them. Rules are cached
// for a minute so every command doesn't hit the API.

const AUTOMOD_CACHE_MS = 60 * 1000;
let automodCache = { at: 0, rules: [] };

async function getKeywordAutoModRules(guild) {
  if (Date.now() - automodCache.at < AUTOMOD_CACHE_MS) return automodCache.rules;
  const fetched = await guild.autoModerationRules.fetch();
  automodCache = {
    at: Date.now(),
    rules: [...fetched.values()].filter(
      (rule) => rule.enabled && rule.triggerType === AutoModerationRuleTriggerType.Keyword
    ),
  };
  return automodCache.rules;
}

/**
 * Converts an AutoMod keyword (supports *word, word*, *word*) into a RegExp.
 * Without wildcards the keyword must match as a whole word.
 */
function keywordToRegex(keyword, flags = 'iu') {
  const core = keyword.replace(/^\*+|\*+$/g, '');
  if (!core) return null;
  const escaped = core.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Whole-word boundaries only make sense where the keyword edge is a word character.
  const before = keyword.startsWith('*') || !/^[\p{L}\p{N}_]/u.test(core) ? '' : '(?<![\\p{L}\\p{N}_])';
  const after = keyword.endsWith('*') || !/[\p{L}\p{N}_]$/u.test(core) ? '' : '(?![\\p{L}\\p{N}_])';
  return new RegExp(`${before}${escaped}${after}`, flags);
}

/** AutoMod regexes are Rust-flavored; JS has no inline (?i), so strip it. */
function safeRegex(pattern) {
  try {
    return new RegExp(pattern.replace(/^\(\?i\)/, ''), 'i');
  } catch {
    return null;
  }
}

/** Returns the first AutoMod rule the text would trigger, or null. */
async function findAutoModViolation(interaction, text) {
  const rules = await getKeywordAutoModRules(interaction.guild);
  const roleIds = memberRoleIds(interaction.member);

  for (const rule of rules) {
    if (rule.exemptChannels.has(interaction.channelId)) continue;
    if (roleIds.some((id) => rule.exemptRoles.has(id))) continue;

    const meta = rule.triggerMetadata ?? {};

    // Remove allow-listed phrases before matching.
    let testText = text;
    for (const allowed of meta.allowList ?? []) {
      const re = keywordToRegex(allowed, 'giu');
      if (re) testText = testText.replace(re, ' ');
    }

    const keywordHit = (meta.keywordFilter ?? []).some((keyword) => {
      const re = keywordToRegex(keyword);
      return re && re.test(testText);
    });
    const regexHit = (meta.regexPatterns ?? []).some((pattern) => {
      const re = safeRegex(pattern);
      return re && re.test(testText);
    });

    if (keywordHit || regexHit) return rule;
  }
  return null;
}

async function getLogPingUserId() {
  if (LOG_PING_USER_ID) return LOG_PING_USER_ID;
  try {
    const app = await client.application.fetch();
    // A team-owned app has ownerId; a user-owned app's owner is the user.
    return app.owner?.ownerId ?? app.owner?.id ?? null;
  } catch {
    return null;
  }
}

/** Reports a blocked /say attempt in the log channel and pings the owner. */
async function logBlockedSay(interaction, text, rule, commandLabel = '/say') {
  try {
    const logChannel = await interaction.guild.channels.fetch(LOG_CHANNEL_ID);
    if (!logChannel?.isTextBased()) return;

    const pingId = await getLogPingUserId();
    // Keep the quoted text from breaking out of its code block or the field limit.
    const attempted = text.replace(/```/g, '`\u200b``').slice(0, 900);

    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle(`🚫 Blocked ${commandLabel} attempt`)
      .setDescription(
        `<@${interaction.user.id}> tried to send a message through ${commandLabel} that breaks an AutoMod rule.`
      )
      .setThumbnail(interaction.user.displayAvatarURL({ extension: 'png', size: 128 }))
      .addFields(
        { name: '👤 User', value: `<@${interaction.user.id}>\n\`${interaction.user.id}\``, inline: true },
        { name: '💬 Channel', value: `<#${interaction.channelId}>`, inline: true },
        { name: '🛡️ AutoMod rule', value: rule.name, inline: true },
        { name: '📝 Attempted message', value: `\`\`\`\n${attempted}\n\`\`\`` }
      )
      .setFooter({ text: `Meowbot • ${commandLabel} log` })
      .setTimestamp();

    await logChannel.send({
      // Mentions inside embeds never ping, so the ping goes in the content.
      content: pingId ? `<@${pingId}>` : undefined,
      embeds: [embed],
      allowedMentions: { users: pingId ? [pingId] : [] },
    });
  } catch (err) {
    console.warn('Could not log blocked /say attempt:', err.message);
  }
}
// --- /help ------------------------------------------------------------------
// Lists every command grouped by category with its description. Open to
// everyone; commands the member can't use are marked with a lock.

const helpCommand = new SlashCommandBuilder()
  .setName('help')
  .setDescription('See all of Meowbot\'s commands, grouped by category')
  .setDMPermission(false);

const pingCommand = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Check that Meowbot is online and see its response time')
  .setDMPermission(false);

const serverinfoCommand = new SlashCommandBuilder()
  .setName('serverinfo')
  .setDescription("Show the server's member count, creation date, and boost level")
  .setDMPermission(false);

const trollsayCommand = new SlashCommandBuilder()
  .setName('trollsay')
  .setDescription('Make the bot say something as another member')
  .addUserOption((option) =>
    option.setName('member').setDescription('The member to speak as').setRequired(true)
  )
  .addStringOption((option) =>
    option
      .setName('message')
      .setDescription('What to say')
      .setRequired(true)
      .setMaxLength(2000)
  )
  .setDMPermission(false);

/**
 * THE command registry. To add a command: build it with SlashCommandBuilder,
 * add one line here with its category (a key of COMMAND_CATEGORIES), and write
 * its handler. That one line registers it with Discord, applies the category's
 * role rules, and lists it in /help.
 */
const COMMANDS = [
  { command: helpCommand, category: 'everyone' },
  { command: pingCommand, category: 'everyone' },
  { command: serverinfoCommand, category: 'everyone' },
  { command: sayCommand, category: 'general' },
  { command: trollsayCommand, category: 'general' },
  { command: quarantineCommand, category: 'moderation' },
  { command: unquarantineCommand, category: 'moderation' },
  ...economy.EconomyCommands,
];

const ALL_COMMANDS = COMMANDS.map((e) => e.command);

/** "/say [message] [attachment]" style usage line (<required> / [optional]). */
function commandUsage(cmd) {
  const opts = cmd.options.map((o) => (o.required ? `<${o.name}>` : `[${o.name}]`)).join(' ');
  return `/${cmd.name}${opts ? ` ${opts}` : ''}`;
}

async function handleHelp(interaction) {
  const roleIds = memberRoleIds(interaction.member);

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📖 Meowbot commands')
    .setDescription('🔒 means you don\'t have the role needed for that command.')
    .setFooter({ text: '<required> • [optional]' });

  for (const category of Object.values(COMMAND_CATEGORIES)) {
    const inCategory = ALL_COMMANDS.filter((cmd) => categoryForCommand(cmd.name) === category);
    if (!inCategory.length) continue;

    const blocks = inCategory.map((cmd) => {
      const lock = canUseCommand(roleIds, cmd.name) ? '' : '🔒 ';
      return `${lock}\`${commandUsage(cmd)}\`\n${cmd.description}`;
    });

    let chunk = '';
    let part = 0;
    const flush = () => {
      if (!chunk) return;
      embed.addFields({
        name: part === 0
          ? `${category.emoji} ${category.label}`
          : `${category.emoji} ${category.label} (cont.)`,
        value: chunk,
      });
      chunk = '';
      part += 1;
    };
    for (const block of blocks) {
      const next = chunk ? `${chunk}\n\n${block}` : block;
      if (next.length > 1024) { flush(); chunk = block; }
      else chunk = next;
    }
    flush();
  }

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
async function handlePing(interaction) {
  const sent = await interaction.reply({ content: 'Pinging…', fetchReply: true });
  const roundTrip = sent.createdTimestamp - interaction.createdTimestamp;
  await interaction.editReply(
    `🏓 Pong!\nRound trip: ${roundTrip}ms\nGateway heartbeat: ${client.ws.ping}ms`
  );
}

async function handleServerInfo(interaction) {
  const guild = interaction.guild;
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(guild.name)
    .addFields(
      { name: '👥 Members', value: String(guild.memberCount), inline: true },
      { name: '📅 Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>`, inline: true },
      {
        name: '🚀 Boost level',
        value: `Level ${guild.premiumTier} (${guild.premiumSubscriptionCount ?? 0} boosts)`,
        inline: true,
      }
    )
    .setFooter({ text: `Server ID: ${guild.id}` });

  const icon = guild.iconURL({ size: 256 });
  if (icon) embed.setThumbnail(icon);

  await interaction.reply({ embeds: [embed] });
}

/** Logs every successful /trollsay to the log channel (no pings). */
async function logTrollSay(interaction, target, text, channel) {
  try {
    const logChannel = await interaction.guild.channels.fetch(LOG_CHANNEL_ID);
    if (!logChannel?.isTextBased()) return;

    const safe = text.replace(/```/g, '`\u200b``').slice(0, 900);
    const embed = new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle('🎭 /trollsay used')
      .setThumbnail(interaction.user.displayAvatarURL({ extension: 'png', size: 128 }))
      .addFields(
        { name: '👤 Used by', value: `<@${interaction.user.id}>\n\`${interaction.user.id}\``, inline: true },
        { name: '🎭 Spoke as', value: `<@${target.id}>\n\`${target.id}\``, inline: true },
        { name: '💬 Channel', value: `<#${channel.id}>`, inline: true },
        { name: '📝 Message', value: `\`\`\`\n${safe}\n\`\`\`` }
      )
      .setFooter({ text: 'Meowbot • /trollsay log' })
      .setTimestamp();

    await logChannel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (err) {
    console.warn('Could not log /trollsay:', err.message);
  }
}

async function handleTrollSay(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const target = interaction.options.getMember('member');
  const text = interaction.options.getString('message', true);

  if (!target) {
    await interaction.editReply("That user isn't in this server.");
    return;
  }
  if (target.id === client.user.id) {
    await interaction.editReply("I can't speak as myself.");
    return;
  }

  // Same AutoMod check as /say, since webhook messages skip the filter.
  let violated;
  try {
    violated = await findAutoModViolation(interaction, text);
  } catch (err) {
    console.error('Could not read AutoMod rules:', err);
    await interaction.editReply(
      "I couldn't check the server's AutoMod rules, so I didn't send that. Make sure I have the Manage Server permission."
    );
    return;
  }
  if (violated) {
    await interaction.editReply(`Blocked: that message breaks the AutoMod rule "${violated.name}".`);
    await logBlockedSay(interaction, text, violated, '/trollsay');
    return;
  }

  const channel =
    interaction.channel ?? (await interaction.guild.channels.fetch(interaction.channelId));
  const webhook = await getWebhook(channel);
  if (!webhook) {
    await interaction.editReply(
      "I couldn't send that. Make sure I have the Manage Webhooks permission in this channel."
    );
    return;
  }

  // Posted with the target's server nickname and avatar. Deliberately NOT added
  // to repostCache, so replies to it don't ping the member being impersonated.
  await webhook.send({
    content: text,
    username: target.displayName,
    avatarURL: target.user.displayAvatarURL({ extension: 'png', size: 256 }),
    threadId: channel.isThread() ? channel.id : undefined,
    allowedMentions: { parse: ['users'] },
  });

  await logTrollSay(interaction, target, text, channel);
  await interaction.editReply('Sent.');
}
// Quarantine persists across leaving: if a quarantined member rejoins, they get
// the quarantine role again. If /unquarantine was run while they were away, their
// saved roles are restored instead.
client.on('guildMemberAdd', async (member) => {
  try {
    if (ALLOWED_GUILD_ID && member.guild.id !== ALLOWED_GUILD_ID) return;

    const store = loadQuarantineStore();
    const key = `${member.guild.id}:${member.id}`;
    const entry = store[key];
    if (!entry) return;

    const guild = member.guild;
    const botTop = guild.members.me.roles.highest.position;
    // Managed roles (boosters, integrations) stay as they are; the bot can't change them.
    const managedKept = member.roles.cache.filter((r) => r.managed).map((r) => r.id);

    if (entry.pendingRelease) {
      const restorable = entry.roles.filter((id) => {
        const role = guild.roles.cache.get(id);
        return role && !role.managed && role.position < botTop;
      });

      await member.roles.set(
        [...new Set([...managedKept, ...restorable])],
        'Restored: unquarantined while away from the server'
      );
      delete store[key];
      saveQuarantineStore(store);

      await logQuarantineEvent(
        guild,
        '🔓 Quarantine restored on rejoin',
        0x57f287,
        member.user,
        `Restored ${restorable.length} role(s).`
      );
      return;
    }

    const quarantineRole = guild.roles.cache.get(QUARANTINE_ROLE_ID);
    if (!quarantineRole || quarantineRole.position >= botTop) {
      console.warn(`Cannot re-quarantine ${member.user.tag}: quarantine role missing or above my role.`);
      return;
    }

    await member.roles.set(
      [...managedKept, QUARANTINE_ROLE_ID],
      'Re-quarantined: rejoined while still quarantined'
    );

    await logQuarantineEvent(
      guild,
      '🔒 Re-quarantined on rejoin',
      0xed4245,
      member.user,
      'Rejoined while still quarantined. Quarantine role reapplied.'
    );
  } catch (err) {
    console.error('Error handling guildMemberAdd quarantine check:', err);
  }
});
client.on('interactionCreate', async (interaction) => {
  try {
    // Button interactions (blackjack / mines).
    if (interaction.isButton()) {
      if (ALLOWED_GUILD_ID && interaction.guildId && interaction.guildId !== ALLOWED_GUILD_ID) return;
      await economy.handleEconomyButton(interaction);
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    if (!interaction.inGuild()) return;
    if (ALLOWED_GUILD_ID && interaction.guildId !== ALLOWED_GUILD_ID) return;

    // Access is decided per category (see COMMAND_CATEGORIES).
    const roleIds = memberRoleIds(interaction.member);
    if (!canUseCommand(roleIds, interaction.commandName)) {
      await interaction.reply({
        content: "You don't have permission to use this command.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Economy commands (handled by economy.js).
    if (await economy.handleEconomyCommand(interaction)) return;

    if (interaction.commandName === 'ping') {
      await handlePing(interaction);
      return;
    }

    if (interaction.commandName === 'serverinfo') {
      await handleServerInfo(interaction);
      return;
    }

    if (interaction.commandName === 'help') {
      await handleHelp(interaction);
      return;
    }

    if (interaction.commandName === 'quarantine' || interaction.commandName === 'unquarantine') {
      await handleQuarantine(interaction, interaction.commandName === 'quarantine');
      return;
    }

    if (interaction.commandName === 'trollsay') {
      await handleTrollSay(interaction);
      return;
    }

    if (interaction.commandName !== 'say') return;

    const text = interaction.options.getString('message') ?? '';
    const sayAttachments = SAY_ATTACHMENT_OPTIONS
      .map((name) => interaction.options.getAttachment(name))
      .filter(Boolean);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!text && !sayAttachments.length) {
      await interaction.editReply('Give me a message, an attachment, or both.');
      return;
    }

    // Attachments require the image perms role.
    if (sayAttachments.length && !memberRoleIds(interaction.member).includes(IMAGE_ROLE_ID)) {
      await interaction.editReply("You don't have image perms, so you can't send attachments with /say.");
      return;
    }

    // Same rules as the server's AutoMod. If the rules can't be read, refuse
    // rather than let the command become a way around them.
    let violated;
    try {
      violated = await findAutoModViolation(interaction, text);
    } catch (err) {
      console.error('Could not read AutoMod rules:', err);
      await interaction.editReply(
        "I couldn't check the server's AutoMod rules, so I didn't send that. Make sure I have the Manage Server permission."
      );
      return;
    }

    if (violated) {
      await interaction.editReply(`Blocked: that message breaks the AutoMod rule "${violated.name}".`);
      await logBlockedSay(interaction, text, violated);
      return;
    }

    const channel =
      interaction.channel ?? (await interaction.guild.channels.fetch(interaction.channelId));

    const webhook = await getWebhook(channel);
    if (!webhook) {
      await interaction.editReply(
        "I couldn't send that. Make sure I have the Manage Webhooks permission in this channel."
      );
      return;
    }

    // Download the attachments so the webhook can re-upload them as real files.
    const files = await Promise.all(
      sayAttachments.map(async (a) => {
        const res = await fetch(a.url);
        if (!res.ok) throw new Error(`Failed to download ${a.name}: HTTP ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        return new AttachmentBuilder(buffer, { name: a.name, description: a.description ?? undefined });
      })
    );

    // Post as the member who ran the command: their server nickname and avatar.
    const sent = await webhook.send({
      content: text || undefined,
      files: files.length ? files : undefined,
      username: interaction.member?.displayName ?? interaction.user.username,
      avatarURL: interaction.user.displayAvatarURL({ extension: 'png', size: 256 }),
      threadId: channel.isThread() ? channel.id : undefined,
      // Users can be mentioned, but @everyone/@here and roles never ping.
      allowedMentions: { parse: ['users'] },
    });

    // So replies to this message quote the text and mention the real user.
    rememberRepost(sent, text, interaction.user.id);

    await interaction.editReply('Sent.');
  } catch (err) {
    console.error('Error handling slash command:', err);
    const reply = {
      content: "I couldn't send that. Check that I have Manage Webhooks in this channel, and that the file(s) are small enough to upload here.",
      flags: MessageFlags.Ephemeral,
    };
    if (interaction.replied || interaction.deferred) await interaction.editReply(reply.content).catch(() => {});
    else await interaction.reply(reply).catch(() => {});
  }
});
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Register /say. Guild commands appear instantly; global ones can take a while.
  try {
    await client.application.commands.set(
      ALL_COMMANDS.map((cmd) => cmd.toJSON()),
      ALLOWED_GUILD_ID || undefined
    );
    console.log(`Registered ${ALL_COMMANDS.length} commands: ${ALL_COMMANDS.map((c) => '/' + c.name).join(', ')}`);
  } catch (err) {
    console.error('Failed to register commands:', err);
  }

  console.log('Build: reply-v21 (economy: balance/baltop/daily/weekly/profile/coinflip/slots/blackjack/mines/work/crime/steal + tiered filter + quarantine persists across leaving + /trollsay + /ping + /serverinfo + /help + command categories + jump link + ghost ping + category exemptions + /say via user webhook + AutoMod sync + block log embed)');
});

client.login(process.env.DISCORD_TOKEN);

