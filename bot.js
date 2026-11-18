import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TikTok } from "tca-js";

import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  ChannelType,
  PermissionFlagsBits
} from "discord.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.chdir(__dirname);

// ======================================================
// FILES
// ======================================================

const FILES = {
  config: "config.json",
  spam: "spam.json",
  ignored: "ignored_users.json",
  database: "database.json",
  stats: "stats.json",
  channels: "channels.json",
  replyMap: "reply_map.json",
  error: "error.log",
  debug: "message_debug.log"
};

function logError(error) {
  const s = error instanceof Error
    ? error.stack || error.message
    : String(error);

  const line = `[${new Date().toISOString()}] ${s}\n`;

  try {
    fs.appendFileSync(FILES.error, line, "utf8");
  } catch {}

  console.error(line);
}

function ensureFile(file, data) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  }
}

function readJSON(file, fallback) {
  try {
    ensureFile(file, fallback);
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    logError(`Lỗi đọc ${file}: ${e.message}`);
    return structuredClone(fallback);
  }
}

function writeJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    logError(`Lỗi ghi ${file}: ${e.message}`);
  }
}

// ======================================================
// AUTO CREATE FILES
// ======================================================

ensureFile(FILES.config, {
  TIKTOK_COOKIES: "YOUR_TIKTOK_COOKIE",
  DISCORD_TOKEN: "YOUR_DISCORD_BOT_TOKEN",
  DISCORD_GUILD_ID: "YOUR_DISCORD_SERVER_ID",
  SPAM_LIMIT: 5,
  SPAM_WINDOW_SECONDS: 2,
  DUPLICATE_LIMIT: 3,
  DEBUG_MESSAGES: false
});

ensureFile(FILES.spam, { users: {} });
ensureFile(FILES.ignored, { users: [] });
ensureFile(FILES.database, { messages: [] });

ensureFile(FILES.stats, {
  totalMessages: 0,
  forwardedMessages: 0,
  discordToTikTok: 0,
  spamDetected: 0,
  ignoredMessages: 0,
  startedAt: new Date().toISOString()
});

ensureFile(FILES.channels, {
  users: {},
  groups: {},
  conversations: {}
});

ensureFile(FILES.replyMap, {
  messages: {}
});

// ======================================================
// CONFIG
// ======================================================

const config = readJSON(FILES.config, {});

const COOKIE = String(config.TIKTOK_COOKIES || "").trim();
const TOKEN = String(config.DISCORD_TOKEN || "").trim();
const GUILD_ID = String(config.DISCORD_GUILD_ID || "").trim();

const SPAM_LIMIT = Math.max(1, Number(config.SPAM_LIMIT) || 5);
const SPAM_WINDOW = Math.max(1, Number(config.SPAM_WINDOW_SECONDS) || 2);
const DUPLICATE_LIMIT = Math.max(1, Number(config.DUPLICATE_LIMIT) || 3);
const DEBUG = config.DEBUG_MESSAGES === true;

if (
  !COOKIE ||
  COOKIE === "YOUR_TIKTOK_COOKIE" ||
  !TOKEN ||
  TOKEN === "YOUR_DISCORD_BOT_TOKEN" ||
  !GUILD_ID ||
  GUILD_ID === "YOUR_DISCORD_SERVER_ID"
) {
  console.error("Hãy cấu hình config.json trước khi chạy bot.");
  process.exit(1);
}

if (!/(^|;\s*)sessionid=/i.test(COOKIE)) {
  console.error("Cookie không có sessionid. Kiểm tra config.json, không chia sẻ cookie.");
  process.exit(1);
}

// ======================================================
// LOAD DATA
// ======================================================

let spamData = readJSON(FILES.spam, { users: {} });
let ignoredData = readJSON(FILES.ignored, { users: [] });
let database = readJSON(FILES.database, { messages: [] });

let channelData = readJSON(FILES.channels, {
  users: {},
  groups: {},
  conversations: {}
});

let replyMap = readJSON(FILES.replyMap, {
  messages: {}
});

let stats = readJSON(FILES.stats, {
  totalMessages: 0,
  forwardedMessages: 0,
  discordToTikTok: 0,
  spamDetected: 0,
  ignoredMessages: 0,
  startedAt: new Date().toISOString()
});

spamData.users ||= {};
channelData.users ||= {};
channelData.groups ||= {};
channelData.conversations ||= {};
replyMap.messages ||= {};

if (!Array.isArray(ignoredData.users)) ignoredData.users = [];
if (!Array.isArray(database.messages)) database.messages = [];

function saveAll() {
  writeJSON(FILES.spam, spamData);
  writeJSON(FILES.ignored, ignoredData);
  writeJSON(FILES.database, database);
  writeJSON(FILES.channels, channelData);
  writeJSON(FILES.replyMap, replyMap);
  writeJSON(FILES.stats, stats);
}

// ======================================================
// UTILITIES
// ======================================================

function safeDate(value) {
  const n = Number(value);

  if (!Number.isFinite(n) || n <= 0) {
    return new Date();
  }

  const d = new Date(n < 1e12 ? n * 1000 : n);
  const y = d.getUTCFullYear();

  return Number.isFinite(d.getTime()) && y >= 2000 && y <= 2100
    ? d
    : new Date();
}

function norm(v) {
  return String(v || "").trim().replace(/^@/, "").toLowerCase();
}

function getText(msg) {
  if (msg?.kind === "sticker" || msg?.sticker) {
    return "[Nhãn dán]";
  }

  if (typeof msg?.text === "string") {
    return msg.text.trim();
  }

  if (typeof msg?.content === "string") {
    return msg.content.trim();
  }

  return "";
}

// ======================================================
// DISCORD CLIENT
// ======================================================

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

let discordReady = false;
let guild = null;

let tiktokAPI = null;
let tiktokConnected = false;
let tiktokConnecting = false;

let sendBlocked = false;
let blockReason = "";

const usernameCache = new Map();
const channelLocks = new Map();
const outboundLocks = new Map();
const processed = new Set();

// ======================================================
// IGNORE SYSTEM
// ======================================================

function isIgnored(id, username) {
  return ignoredData.users.some(x => {
    if (typeof x === "string") {
      return norm(x) === norm(id) || norm(x) === norm(username);
    }

    return (
      norm(x.id) === norm(id) ||
      norm(x.username) === norm(username) ||
      norm(x.id) === norm(username) ||
      norm(x.username) === norm(id)
    );
  });
}

function addIgnored(id, username, reason = "manual") {
  if ((!id && !username) || isIgnored(id, username)) {
    return false;
  }

  ignoredData.users.push({
    id: norm(id),
    username: norm(username),
    reason,
    addedAt: new Date().toISOString()
  });

  writeJSON(FILES.ignored, ignoredData);
  return true;
}

function removeIgnored(target) {
  const v = norm(target);
  const before = ignoredData.users.length;

  ignoredData.users = ignoredData.users.filter(x =>
    typeof x === "string"
      ? norm(x) !== v
      : norm(x.id) !== v && norm(x.username) !== v
  );

  writeJSON(FILES.ignored, ignoredData);
  return before !== ignoredData.users.length;
}

// ======================================================
// TIKTOK USERNAME
// ======================================================

async function getUsername(id) {
  id = String(id || "");

  if (!id || id === "unknown") return "unknown";
  if (usernameCache.has(id)) return usernameCache.get(id);

  try {
    const u = (await tiktokAPI.getUsers([id]))?.[0];

    const name = String(
      u?.uniqueId ||
      u?.nickname ||
      "unknown"
    );

    usernameCache.set(id, name);
    return name;
  } catch (e) {
    logError(`Lỗi lấy username ${id}: ${e.message}`);
    return "unknown";
  }
}

// ======================================================
// DETECT DIRECT / GROUP CONVERSATION
// ======================================================

function detectConversation(msg) {
  const c =
    msg.conversation ||
    msg.conversationInfo ||
    msg.conversation_info ||
    {};

  const raw = String(
    msg.conversationType ??
    msg.conversation_type ??
    msg.chatType ??
    msg.chat_type ??
    c.type ??
    c.conversationType ??
    ""
  ).toLowerCase();

  const groupId =
    msg.groupId ??
    msg.group_id ??
    msg.roomId ??
    msg.room_id ??
    c.groupId ??
    c.group_id ??
    c.roomId;

  const groupFlag = [
    msg.isGroup,
    msg.isGroupChat,
    msg.is_group,
    c.isGroup,
    c.is_group
  ].some(v => v === true || v === 1 || v === "true");

  const groupType =
    raw.includes("group") ||
    raw === "2" ||
    raw.includes("多人");

  if (groupId || groupFlag || groupType) {
    const id = String(
      groupId ??
      msg.conversationId ??
      msg.conversation_id ??
      c.conversationId ??
      c.conversation_id ??
      ""
    );

    if (!id) return { type: "unknown" };

    return {
      type: "groups",
      id,
      name: String(
        msg.groupName ??
        msg.group_name ??
        msg.roomName ??
        c.name ??
        c.title ??
        `group-${id}`
      )
    };
  }

  const direct =
    raw.includes("direct") ||
    raw.includes("private") ||
    ["single", "personal", "1", "0"].includes(raw);

  if (
    msg.senderId &&
    (msg.conversationId || msg.conversation_id || direct)
  ) {
    return {
      type: "users",
      id: String(msg.senderId),
      name: "unknown"
    };
  }

  return { type: "unknown" };
}

// ======================================================
// CHANNEL MANAGEMENT
// ======================================================

function safeChannelName(name, id, group = false) {
  let s = String(name || "")
    .toLowerCase()
    .replace(/^@/, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (!s || s === "unknown") {
    s = `tiktok-${String(id).slice(-8)}`;
  }

  return `${group ? "nhom-" : ""}${s}`.slice(0, 95);
}

async function getOrCreateChannel(type, key, name) {
  const lock = `${type}:${key}`;

  if (channelLocks.has(lock)) {
    return channelLocks.get(lock);
  }

  const task = (async () => {
    if (!guild) {
      guild = await discord.guilds.fetch(GUILD_ID);
    }

    channelData[type] ||= {};

    const saved = channelData[type][String(key)];

    const savedId = typeof saved === "string"
      ? saved
      : saved?.channelId;

    if (savedId) {
      const old = await guild.channels.fetch(savedId).catch(() => null);

      if (old?.type === ChannelType.GuildText) {
        return old;
      }

      delete channelData[type][String(key)];
    }

    const ch = await guild.channels.create({
      name: safeChannelName(name, key, type === "groups"),
      type: ChannelType.GuildText,
      topic: `TikTok ${type === "groups" ? "group" : "user"} conversation: ${key}`
    });

    channelData[type][String(key)] = ch.id;
    writeJSON(FILES.channels, channelData);

    console.log(`Đã tạo kênh #${ch.name}`);

    return ch;
  })();

  channelLocks.set(lock, task);

  try {
    return await task;
  } finally {
    channelLocks.delete(lock);
  }
}

function findChannel(channelId) {
  for (const [key, value] of Object.entries(channelData.users)) {
    const id = typeof value === "string" ? value : value?.channelId;

    if (id === channelId) {
      return { type: "users", key };
    }
  }

  for (const [key, value] of Object.entries(channelData.groups)) {
    const id = typeof value === "string" ? value : value?.channelId;

    if (id === channelId) {
      return { type: "groups", key };
    }
  }

  return null;
}

// ======================================================
// REPLY MAP
// Discord Message ID -> TikTok Conversation
// ======================================================

function saveReplyMapping(discordMessageId, data) {
  if (
    !discordMessageId ||
    !data?.conversationId ||
    !data?.conversationShortId
  ) {
    return;
  }

  replyMap.messages[String(discordMessageId)] = {
    ...data,
    savedAt: new Date().toISOString()
  };

  const entries = Object.entries(replyMap.messages);

  if (entries.length > 10000) {
    const sorted = entries.sort((a, b) =>
      new Date(a[1].savedAt || 0) -
      new Date(b[1].savedAt || 0)
    );

    for (const [id] of sorted.slice(0, entries.length - 10000)) {
      delete replyMap.messages[id];
    }
  }

  writeJSON(FILES.replyMap, replyMap);
}

function getReplyMapping(discordMessageId) {
  return replyMap.messages[String(discordMessageId)] || null;
}

// ======================================================
// SPAM DETECTION
// ======================================================

function checkSpam(id, text) {
  const now = Date.now();
  const windowMs = SPAM_WINDOW * 1000;

  spamData.users[id] ||= {
    timestamps: [],
    duplicateTimes: {}
  };

  const u = spamData.users[id];

  if (!Array.isArray(u.timestamps)) {
    u.timestamps = [];
  }

  if (!u.duplicateTimes || typeof u.duplicateTimes !== "object") {
    u.duplicateTimes = {};
  }

  u.timestamps = u.timestamps.filter(t => now - t <= windowMs);
  u.timestamps.push(now);

  const key = String(text).trim().toLowerCase();

  u.duplicateTimes[key] ||= [];

  u.duplicateTimes[key] = u.duplicateTimes[key].filter(
    t => now - t <= windowMs
  );

  u.duplicateTimes[key].push(now);

  for (const k of Object.keys(u.duplicateTimes)) {
    if (!u.duplicateTimes[k].length) {
      delete u.duplicateTimes[k];
    }
  }

  writeJSON(FILES.spam, spamData);

  const dup = u.duplicateTimes[key].length >= DUPLICATE_LIMIT;
  const flood = u.timestamps.length >= SPAM_LIMIT;

  return {
    spam: dup || flood,
    reason: dup
      ? "Gửi tin trùng lặp"
      : "Gửi quá nhiều tin"
  };
}

// ======================================================
// FORWARD TIKTOK -> DISCORD
// ======================================================

async function forwardToDiscord(msg, senderId, username, text, conv) {
  if (!discordReady || !guild) {
    return null;
  }

  try {
    const isGroup = conv.type === "groups";

    const channel = await getOrCreateChannel(
      isGroup ? "groups" : "users",
      isGroup ? conv.id : senderId,
      isGroup ? conv.name : username
    );

    const embed = new EmbedBuilder()
      .setColor(isGroup ? 0x9B59B6 : 0x00B8A9)
      .setTitle(
        isGroup
          ? "Tin nhắn nhóm TikTok"
          : "Tin nhắn cá nhân TikTok"
      )
      .addFields(
        {
          name: isGroup ? "Nhóm" : "Người gửi",
          value: (
            isGroup ? conv.name : `@${username}`
          ).slice(0, 1024),
          inline: true
        },
        {
          name: "TikTok ID người gửi",
          value: String(senderId).slice(0, 1024),
          inline: true
        },
        {
          name: "Nội dung",
          value: text.slice(0, 4000) || "(Trống)"
        }
      )
      .setFooter({
        text: "Reply tin nhắn này để trả lời đúng cuộc trò chuyện TikTok"
      })
      .setTimestamp(safeDate(msg.createdAt));

    const sentMessage = await channel.send({
      embeds: [embed],
      allowedMentions: { parse: [] }
    });

    return sentMessage;
  } catch (e) {
    logError(`Lỗi chuyển tiếp sang Discord: ${e.message}`);
    return null;
  }
}

// ======================================================
// HANDLE TIKTOK MESSAGE
// ======================================================

async function handleTikTokMessage(msg) {
  try {
    if (!msg || typeof msg !== "object" || msg.isSelf === true) {
      return;
    }

    if (DEBUG) {
      fs.appendFileSync(
        FILES.debug,
        JSON.stringify(msg, null, 2) + "\n\n",
        "utf8"
      );
    }

    const messageId = String(
      msg.serverMessageId ||
      msg.messageId ||
      ""
    );

    if (messageId) {
      if (processed.has(messageId)) return;

      processed.add(messageId);

      if (processed.size > 1500) {
        processed.delete(processed.values().next().value);
      }
    }

    const conv = detectConversation(msg);

    if (conv.type === "unknown") {
      logError(
        "Không xác định được loại hội thoại TikTok. Bật DEBUG_MESSAGES trong config.json và xem message_debug.log."
      );
      return;
    }

    const senderId = String(
      msg.senderId ||
      msg.userId ||
      "unknown"
    );

    if (senderId === "unknown") return;

    const conversationId =
      msg.conversationId ??
      msg.conversation_id;

    const conversationShortId =
      msg.conversationShortId ??
      msg.conversation_short_id;

    if (conversationId && conversationShortId) {
      const key = conv.type === "groups"
        ? `group:${conv.id}`
        : `user:${senderId}`;

      channelData.conversations[key] = {
        conversationId: String(conversationId),
        conversationShortId: String(conversationShortId),
        type: conv.type,
        updatedAt: new Date().toISOString()
      };
    }

    const text = getText(msg);

    if (!text) return;

    stats.totalMessages = (stats.totalMessages || 0) + 1;

    const username = await getUsername(senderId);

    if (isIgnored(senderId, username)) {
      stats.ignoredMessages = (stats.ignoredMessages || 0) + 1;
      saveAll();
      return;
    }

    const spam = checkSpam(senderId, text);

    if (spam.spam) {
      stats.spamDetected = (stats.spamDetected || 0) + 1;

      addIgnored(senderId, username, "auto_spam");

      console.log(`Đã bỏ qua @${username}: ${spam.reason}`);

      saveAll();
      return;
    }

    const discordMessage = await forwardToDiscord(
      msg,
      senderId,
      username,
      text,
      conv
    );

    const sent = Boolean(discordMessage);

    if (sent) {
      stats.forwardedMessages =
        (stats.forwardedMessages || 0) + 1;

      const conversationKey = conv.type === "groups"
        ? `group:${conv.id}`
        : `user:${senderId}`;

      const savedConversation =
        channelData.conversations[conversationKey];

      if (savedConversation) {
        saveReplyMapping(discordMessage.id, {
          conversationId: savedConversation.conversationId,
          conversationShortId: savedConversation.conversationShortId,
          conversationType: conv.type,
          conversationKey,
          senderId,
          username,
          tiktokMessageId: messageId || null,
          discordChannelId: discordMessage.channel.id
        });
      }
    }

    database.messages.push({
      id: messageId,
      userId: senderId,
      username,
      conversationType: conv.type,
      conversationId: conv.id || null,
      text,
      type: msg.kind || "other",
      createdAt: msg.createdAt ?? null,
      receivedAt: new Date().toISOString(),
      forwarded: sent
    });

    if (database.messages.length > 5000) {
      database.messages = database.messages.slice(-5000);
    }

    saveAll();

    console.log(`[TikTok ${conv.type}] @${username}: ${text}`);
  } catch (e) {
    logError(e);
  }
}

// ======================================================
// SESSION BLOCKED
// ======================================================

function isSessionBlocked(error) {
  const s = String(error?.message || error).toLowerCase();

  return (
    s.includes("session blocked") ||
    s.includes("status_code 7")
  );
}

function pauseSending(error) {
  sendBlocked = true;

  blockReason =
    "TikTok từ chối phiên gửi tin (session blocked). Bot đã tạm dừng gửi.";

  logError(
    `Tạm dừng Discord -> TikTok: ${error?.message || error}`
  );
}

// ======================================================
// DISCORD -> TIKTOK
// REPLY ROUTING
// ======================================================

discord.on("messageCreate", async message => {
  try {
    if (
      message.author.bot ||
      message.webhookId ||
      !message.guild ||
      message.guild.id !== GUILD_ID
    ) {
      return;
    }

    if (!message.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
      return;
    }

    const text = String(message.content || "").trim();

    if (!text) return;

    const entry = findChannel(message.channel.id);

    if (!entry) return;

    if (sendBlocked) {
      await message.reply({
        content: blockReason,
        allowedMentions: { repliedUser: false }
      });
      return;
    }

    let conv = null;
    let replyInfo = null;

    // --------------------------------------------------
    // REPLY TO A FORWARDED TIKTOK MESSAGE
    // --------------------------------------------------

    if (message.reference?.messageId) {
      replyInfo = getReplyMapping(message.reference.messageId);

      if (!replyInfo) {
        await message.reply({
          content:
            "Không tìm thấy liên kết TikTok của tin nhắn được Reply. Hãy Reply trực tiếp vào tin nhắn TikTok do bot chuyển tiếp.",
          allowedMentions: { repliedUser: false }
        });
        return;
      }

      if (replyInfo.discordChannelId !== message.channel.id) {
        await message.reply({
          content: "Tin nhắn Reply không thuộc kênh TikTok hiện tại.",
          allowedMentions: { repliedUser: false }
        });
        return;
      }

      conv = {
        conversationId: replyInfo.conversationId,
        conversationShortId: replyInfo.conversationShortId
      };
    }

    // --------------------------------------------------
    // NORMAL MESSAGE: USE CHANNEL CONVERSATION
    // --------------------------------------------------

    else {
      const convKey = entry.type === "groups"
        ? `group:${entry.key}`
        : `user:${entry.key}`;

      const savedConv = channelData.conversations[convKey];

      if (!savedConv?.conversationId || !savedConv?.conversationShortId) {
        await message.reply({
          content:
            "Chưa có dữ liệu cuộc trò chuyện TikTok. Hãy đợi cuộc trò chuyện gửi tin nhắn mới.",
          allowedMentions: { repliedUser: false }
        });
        return;
      }

      conv = {
        conversationId: savedConv.conversationId,
        conversationShortId: savedConv.conversationShortId
      };
    }

    // --------------------------------------------------
    // CHECK TIKTOK CONNECTION
    // --------------------------------------------------

    if (!tiktokAPI || !tiktokConnected) {
      await message.reply({
        content: "TikTok chưa kết nối; tin nhắn chưa được gửi.",
        allowedMentions: { repliedUser: false }
      });
      return;
    }

    if (outboundLocks.has(message.channel.id)) {
      await message.reply({
        content: "Đang gửi tin trước đó, hãy thử lại sau.",
        allowedMentions: { repliedUser: false }
      });
      return;
    }

    outboundLocks.set(message.channel.id, true);

    try {
      await tiktokAPI.sendMessage(
        {
          conversationId: conv.conversationId,
          conversationShortId: conv.conversationShortId
        },
        text
      );

      stats.discordToTikTok =
        (stats.discordToTikTok || 0) + 1;

      writeJSON(FILES.stats, stats);

      if (replyInfo) {
        console.log(
          `[Discord Reply -> TikTok] @${replyInfo.username}: ${text}`
        );

        await message.react("✅").catch(() => {});
      } else {
        console.log(
          `[Discord -> TikTok ${entry.type}] ${entry.key}: ${text}`
        );
      }
    } catch (e) {
      if (isSessionBlocked(e)) {
        pauseSending(e);

        await message.reply({
          content:
            "TikTok từ chối phiên gửi tin. Bot đã tạm dừng gửi để tránh thử lại liên tục.",
          allowedMentions: { repliedUser: false }
        }).catch(() => {});

        return;
      }

      throw e;
    } finally {
      outboundLocks.delete(message.channel.id);
    }
  } catch (e) {
    logError(`Lỗi gửi Discord sang TikTok: ${e.message}`);

    await message.reply({
      content: "Không gửi được tin sang TikTok. Kiểm tra error.log.",
      allowedMentions: { repliedUser: false }
    }).catch(() => {});
  }
});

// ======================================================
// SLASH COMMANDS
// ======================================================

const commands = [
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Kiểm tra trạng thái bot"),

  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Xem thống kê bot"),

  new SlashCommandBuilder()
    .setName("ignored")
    .setDescription("Xem danh sách bỏ qua"),

  new SlashCommandBuilder()
    .setName("ignore")
    .setDescription("Bỏ qua người dùng TikTok")
    .addStringOption(o =>
      o.setName("user")
        .setDescription("Username hoặc ID")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("unignore")
    .setDescription("Bỏ người dùng khỏi danh sách bỏ qua")
    .addStringOption(o =>
      o.setName("user")
        .setDescription("Username hoặc ID")
        .setRequired(true)
    )
].map(x => x.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(
      discord.application.id,
      GUILD_ID
    ),
    { body: commands }
  );

  console.log("Đã đăng ký slash commands.");
}

// ======================================================
// INTERACTION HANDLER
// ======================================================

discord.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    const cmd = interaction.commandName;

    if (cmd === "status" || cmd === "stats") {
      const embed = new EmbedBuilder()
        .setColor(sendBlocked ? 0xE74C3C : 0x00B8A9)
        .setTitle(cmd === "status" ? "Bot Status" : "Thống kê Bot")
        .addFields(
          {
            name: "Discord",
            value: discordReady ? "Đã kết nối" : "Chưa kết nối",
            inline: true
          },
          {
            name: "TikTok Listener",
            value: tiktokConnected ? "Đã kết nối" : "Chưa kết nối",
            inline: true
          },
          {
            name: "Gửi TikTok",
            value: sendBlocked ? "Tạm dừng" : "Sẵn sàng",
            inline: true
          },
          {
            name: "Tổng tin TikTok",
            value: String(stats.totalMessages || 0),
            inline: true
          },
          {
            name: "Đã chuyển tiếp",
            value: String(stats.forwardedMessages || 0),
            inline: true
          },
          {
            name: "Discord → TikTok",
            value: String(stats.discordToTikTok || 0),
            inline: true
          },
          {
            name: "Spam",
            value: String(stats.spamDetected || 0),
            inline: true
          },
          {
            name: "Tin bỏ qua",
            value: String(stats.ignoredMessages || 0),
            inline: true
          },
          {
            name: "Kênh cá nhân",
            value: String(Object.keys(channelData.users).length),
            inline: true
          },
          {
            name: "Kênh nhóm",
            value: String(Object.keys(channelData.groups).length),
            inline: true
          },
          {
            name: "Liên kết Reply",
            value: String(Object.keys(replyMap.messages).length),
            inline: true
          }
        );

      if (sendBlocked) {
        embed.addFields({
          name: "Lý do",
          value: blockReason
        });
      }

      await interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
    }

    else if (cmd === "ignored") {
      if (!ignoredData.users.length) {
        await interaction.reply({
          content: "Danh sách bỏ qua đang trống.",
          flags: MessageFlags.Ephemeral
        });
      } else {
        const lines = ignoredData.users.slice(0, 40).map((x, i) =>
          typeof x === "string"
            ? `${i + 1}. ${x}`
            : `${i + 1}. @${x.username || "unknown"} | ID: ${x.id || "N/A"} | ${x.reason || "manual"}`
        );

        await interaction.reply({
          content: `**Danh sách bỏ qua (${ignoredData.users.length})**\n${lines.join("\n")}`,
          flags: MessageFlags.Ephemeral
        });
      }
    }

    else if (cmd === "ignore" || cmd === "unignore") {
      const target = interaction.options.getString("user", true);

      if (cmd === "ignore") {
        const n = norm(target);

        let id = "";
        let username = n;

        for (const [uid, cached] of usernameCache) {
          if (norm(cached) === n) {
            id = uid;
            username = cached;
            break;
          }
        }

        const added = addIgnored(id, username, "manual");

        await interaction.reply({
          content: added
            ? `Đã thêm **${target}** vào danh sách bỏ qua cục bộ.`
            : `**${target}** đã có trong danh sách bỏ qua.`,
          flags: MessageFlags.Ephemeral
        });
      } else {
        let removed = removeIgnored(target);

        if (!removed) {
          for (const [uid, username] of usernameCache) {
            if (norm(username) === norm(target) && removeIgnored(uid)) {
              removed = true;
              break;
            }
          }
        }

        await interaction.reply({
          content: removed
            ? `Đã xóa **${target}** khỏi danh sách bỏ qua.`
            : `Không tìm thấy **${target}**.`,
          flags: MessageFlags.Ephemeral
        });
      }
    }
  } catch (e) {
    logError(e);

    const payload = {
      content: "Lỗi khi thực hiện lệnh.",
      flags: MessageFlags.Ephemeral
    };

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

// ======================================================
// DISCORD READY
// ======================================================

discord.once("ready", async () => {
  try {
    console.log(`Discord đăng nhập: ${discord.user.tag}`);

    guild = await discord.guilds.fetch(GUILD_ID);
    discordReady = true;

    console.log(`Đã kết nối server: ${guild.name}`);
  } catch (e) {
    discordReady = false;
    logError(e);
  }
});

discord.on("error", logError);

// ======================================================
// CONNECT TIKTOK
// ======================================================

async function connectTikTok() {
  if (tiktokConnecting || tiktokConnected) return;

  tiktokConnecting = true;

  try {
    console.log("Đang kết nối TikTok...");

    const client = new TikTok();

    tiktokAPI = await client.login({
      cookies: COOKIE
    });

    if (!tiktokAPI?.listener) {
      throw new Error("Không lấy được TikTok listener.");
    }

    const ownId = tiktokAPI.getOwnId();

    console.log(`TikTok đăng nhập thành công. Account ID: ${ownId}`);

    const listener = tiktokAPI.listener;

    listener.on("connected", () => {
      tiktokConnected = true;
      console.log("TikTok WebSocket đã kết nối.");
    });

    listener.on("closed", () => {
      tiktokConnected = false;
      console.log("TikTok WebSocket đã đóng.");
    });

    listener.on("error", e => {
      tiktokConnected = false;
      logError(e);
    });

    listener.on("message", msg => {
      handleTikTokMessage(msg).catch(logError);
    });

    listener.start();

    console.log("Đã khởi động TikTok listener.");
  } catch (e) {
    tiktokConnected = false;
    tiktokAPI = null;

    logError(`Lỗi kết nối TikTok: ${e.message}`);
  } finally {
    tiktokConnecting = false;
  }
}

// ======================================================
// START BOT
// ======================================================

async function startBot() {
  console.log("==================================");
  console.log("       TIKTOK DISCORD BOT");
  console.log("==================================");

  await discord.login(TOKEN);

  if (!discord.isReady()) {
    await new Promise(resolve => discord.once("ready", resolve));
  }

  if (!guild) {
    guild = await discord.guilds.fetch(GUILD_ID);
  }

  await registerCommands();
  await connectTikTok();

  saveAll();

  console.log("Bot đã khởi động.");
}

process.on("unhandledRejection", logError);
process.on("uncaughtException", logError);

// ======================================================
// SHUTDOWN
// ======================================================

let stopping = false;

async function shutdown() {
  if (stopping) return;

  stopping = true;

  console.log("Đang tắt bot...");

  saveAll();

  try {
    tiktokAPI?.listener?.stop();
  } catch (e) {
    logError(e);
  }

  discord.destroy();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

startBot().catch(e => {
  logError(e);
  process.exit(1);
});