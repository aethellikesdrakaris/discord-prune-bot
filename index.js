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
} = require('discord.js');
require('dotenv').config();

const { BLACKLIST } = require('./filters');
const ALLOWED_GUILD_ID = process.env.GUILD_ID;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildWebhooks,
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
 * Whole-word, case-insensitive check for whether any word in `words`
 * appears in `text`.
 */
function containsBlacklistedWord(text, words) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return words.some((word) => {
    const escaped = word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escaped}\\b`, 'i');
    return pattern.test(lower);
  });
}

/**
 * Returns true if the message content contains any blacklisted word.
 */
function isFiltered(content) {
  return containsBlacklistedWord(content, BLACKLIST);
}

/**
 * Get or create the bot's webhook in a given text channel.
 */
async function getWebhook(channel) {
  if (webhookCache.has(channel.id)) {
    return webhookCache.get(channel.id);
  }

  // Need MANAGE_WEBHOOKS permission in this channel.
  const me = channel.guild.members.me;
  if (!channel.permissionsFor(me).has(PermissionsBitField.Flags.ManageWebhooks)) {
    console.warn(`Missing Manage Webhooks permission in #${channel.name}`);
    return null;
  }

  const existing = await channel.fetchWebhooks();
  let webhook = existing.find((wh) => wh.name === WEBHOOK_NAME && wh.owner?.id === client.user.id);

  if (!webhook) {
    webhook = await channel.createWebhook({
      name: WEBHOOK_NAME,
      reason: 'Used to relay filtered messages under the original author\'s identity',
    });
  }

  webhookCache.set(channel.id, webhook);
  return webhook;
}

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return; // ignore bots/webhooks (avoid loops)
    if (!message.guild) return; // ignore DMs
    if (ALLOWED_GUILD_ID && message.guild.id !== ALLOWED_GUILD_ID) return;

    const attachments = [...message.attachments.values()];
    const hasFilteredText = isFiltered(message.content);
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

    if (sent?.id) {
      repostCache.set(sent.id, {
        content: message.content ?? '',
        authorId: message.author.id,
      });
      if (repostCache.size > REPOST_CACHE_LIMIT) {
        repostCache.delete(repostCache.keys().next().value);
      }
    }

    await message.delete();
  } catch (err) {
    console.error('Error handling message:', err);
  }
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log('Build: reply-v4 (jump link + "Replying to" + nested-reply fix)');
});

client.login(process.env.DISCORD_TOKEN);
