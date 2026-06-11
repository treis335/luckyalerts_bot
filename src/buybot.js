require('dotenv').config();
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs').promises;

// ==================== CONFIGURATION ====================
const RPC_URL = process.env.RPC_URL || 'https://rpc-mainnet.supra.com';
const BUY_CONTRACT = '0xdc694898dff98a1b0447e0992d0413e123ea80da1021d464a4fbaf0265870d8';
const BUY_EVENT_TYPE = `${BUY_CONTRACT}::liquidity_pool::SwapEvent`;
const POLLING_INTERVAL_MS = 5000;
const API_BASE_URL = 'https://rpc-mainnet.supra.com/rpc/v1';
const CURVE_TYPE = '0xdc694898dff98a1b0447e0992d0413e123ea80da1021d464a4fbaf0265870d8::curves::Uncorrelated';
const MODULE_ADDRESS = '0xdc694898dff98a1b0447e0992d0413e123ea80da1021d464a4fbaf0265870d8';
const SUPRA_COIN_TYPE = '0x1::supra_coin::SupraCoin';
const DEXUSDC_TYPE = '0x8f7d16ade319b0fce368ca6cdb98589c4527ce7f5b51e544a9e68e719934458b::hyper_coin::DexlynUSDC';
const SPIKE_TYPE = '0x0fec116479f1fd3cb9732cc768e6061b0e45b178a610b9bc23c2143a6493e794::memecoins::SPIKE';

const SUPRA_DECIMALS = 1e8;
const DEXUSDC_DECIMALS = 1e6;
const DEFAULT_DECIMALS = 1e6;
const SPIKE_DECIMALS = 1e3;
const SUPRA_SUPPLY = 1e11;
const DEFAULT_SUPPLY = 1e9;
const SPIKE_SUPPLY = 13700000000000000;
const PRICE_INTERVAL_MS = 60 * 1000;
const MAX_PROCESSED_EVENTS = 10000; // evitar memory leak no Set

let supraPrice = 0.007186;

const TOKENS = {
  [SUPRA_COIN_TYPE]: { name: 'SUPRA', decimals: SUPRA_DECIMALS, supply: SUPRA_SUPPLY },
  '0x635f53147391781c93bf3e1c68dcea5e2f7234ec371b0f241d150465606a9007::ROBBIE::ROBBIE': { name: 'ROBBIE', decimals: 1e6, supply: DEFAULT_SUPPLY },
  '0xb8e94e7204d8eeb565a653d262ae6f7434a3a452e2aaf624810b33dfa3b64d09::DAWGZ::DAWGZ': { name: 'DAWGZ', decimals: 1e6, supply: DEFAULT_SUPPLY },
  [DEXUSDC_TYPE]: { name: 'dexUSDC', decimals: 1e6, supply: 0 },
  [SPIKE_TYPE]: { name: 'SPIKE', decimals: SPIKE_DECIMALS, supply: SPIKE_SUPPLY }
};

const DEFAULT_IMAGES = {
  [SUPRA_COIN_TYPE]: { fileId: 'AgACAgQAAyEFAASd15G8AAIBR2gerW-DD9wy2RnHjiRfkP4PQ9IBAALkyDEbSOv4UOVVlh9BBwasAQADAgADeAADNgQ', mediaType: 'photo' },
  '0x635f53147391781c93bf3e1c68dcea5e2f7234ec371b0f241d150465606a9007::ROBBIE::ROBBIE': { fileId: 'AgACAgQAAyEFAASd15G8AAIBP2gerNfag7mAMpDqtP8koE_-z0zcAALiyDEbSOv4UGp_2438HgGLAQADAgADeQADNgQ', mediaType: 'photo' },
  '0xb8e94e7204d8eeb565a653d262ae6f7434a3a452e2aaf624810b33dfa3b64d09::DAWGZ::DAWGZ': { fileId: 'AgACAgQAAyEFAASd15G8AAIBQ2gerSklR3gsoLUkyiLGbM8fFcxIAALjyDEbSOv4UHvlML21ZatKAQADAgADeQADNgQ', mediaType: 'photo' },
  '0x4205c82380bff5708cd7c59e0043a45890a457a6cdb60c9191d818958fd7ac26::LUCKY::LUCKY': { fileId: 'CgACAgQAAyEFAASJYr2BAAIHw2iHcD2Ion4UFHFu_vQ7MteLgEDeAALlGgACSOv4UJHF5RmhblWfNgQ', mediaType: 'animation' }
};

// ==================== INITIALIZATION ====================
const TOKEN = process.env.BUYBOT;
if (!TOKEN) {
  console.error('❌ BUYBOT not defined in .env');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
let botId = null; // FIX: guardamos o ID do bot aqui

// Buscar o ID do bot no startup (resolve o TypeError: Cannot read properties of undefined)
bot.getMe().then(me => {
  botId = me.id;
  console.log(`🤖 Bot ID: ${botId} (@${me.username})`);
}).catch(err => {
  console.error('❌ Failed to get bot info:', err.message);
  process.exit(1);
});

let processedEvents = new Set();
const CHAT_IDS_FILE = './chatIds.json';
let pendingTokenInput = {};
let pendingImageUploads = {};
let pendingSettingsInput = {};

// ==================== PRICE FUNCTIONS ====================
async function callView(fn, typeArgs, args = []) {
  const res = await axios.post(`${API_BASE_URL}/view`, {
    function: `${MODULE_ADDRESS}::router::${fn}`,
    type_arguments: typeArgs,
    arguments: args
  });
  return res.data;
}

async function getReserves(typeArgs) {
  const result = await callView('get_reserves_size', typeArgs);
  if (result && Array.isArray(result.result)) {
    const [rx, ry] = result.result.map(Number);
    return { reserve_x: rx, reserve_y: ry };
  }
  throw new Error('Failed to get reserves');
}

async function getFees(typeArgs) {
  const result = await callView('get_fees_config', typeArgs);
  if (result && Array.isArray(result.result)) {
    const [fee_pct, fee_scale] = result.result.map(Number);
    return { fee_pct, fee_scale };
  }
  throw new Error('Failed to get fees');
}

function getAmountOut(coinIn, reserveIn, reserveOut, fee_pct, fee_scale) {
  const mult = fee_scale - fee_pct;
  const afterFees = (coinIn * mult) / fee_scale;
  const newReserveIn = reserveIn + afterFees;
  return (afterFees * reserveOut) / newReserveIn;
}

async function updateSupraPrice() {
  try {
    const typeArgs = [SUPRA_COIN_TYPE, DEXUSDC_TYPE, CURVE_TYPE];
    const { reserve_x, reserve_y } = await getReserves(typeArgs);
    const { fee_pct, fee_scale } = await getFees(typeArgs);
    const coinIn = 1 * SUPRA_DECIMALS;
    const amountOut = getAmountOut(coinIn, reserve_x, reserve_y, fee_pct, fee_scale);
    supraPrice = amountOut / DEXUSDC_DECIMALS;
    console.log(`💰 SUPRA price: 1 = ${supraPrice.toFixed(6)} dexUSDC`);
  } catch (err) {
    console.error('Price update error:', err.message);
  }
}

function getTokenDetails(typeTag) {
  if (typeTag.includes('SPIKE')) return { name: 'SPIKE', decimals: SPIKE_DECIMALS, supply: SPIKE_SUPPLY, typeTag };
  const t = TOKENS[typeTag];
  if (t) return { ...t, typeTag };
  return { name: typeTag.split('::').pop(), decimals: DEFAULT_DECIMALS, supply: DEFAULT_SUPPLY, typeTag };
}

function formatAmount(amount, decimals) {
  const num = Number(amount);
  if (isNaN(num)) return '0';
  const precision = decimals === SPIKE_DECIMALS ? 3 : decimals === SUPRA_DECIMALS ? 8 : 6;
  return (num / decimals).toFixed(precision);
}

async function getTokenPriceAndMC(typeTag) {
  const token = getTokenDetails(typeTag);
  let price;
  if (typeTag === DEXUSDC_TYPE) price = 1;
  else if (typeTag === SUPRA_COIN_TYPE) price = supraPrice;
  else {
    const isTokenX = typeTag < SUPRA_COIN_TYPE;
    const typeArgs = isTokenX ? [typeTag, SUPRA_COIN_TYPE, CURVE_TYPE] : [SUPRA_COIN_TYPE, typeTag, CURVE_TYPE];
    const { reserve_x, reserve_y } = await getReserves(typeArgs);
    const { fee_pct, fee_scale } = await getFees(typeArgs);
    const reserveIn = isTokenX ? reserve_x : reserve_y;
    const reserveOut = isTokenX ? reserve_y : reserve_x;
    const coinIn = 1 * token.decimals;
    const amountOut = getAmountOut(coinIn, reserveIn, reserveOut, fee_pct, fee_scale);
    const priceInSupra = amountOut / SUPRA_DECIMALS;
    price = priceInSupra * supraPrice;
  }
  const marketCap = token.supply > 0 ? price * token.supply : null;
  return { price, marketCap };
}

function startPriceLoop() {
  updateSupraPrice();
  setInterval(updateSupraPrice, PRICE_INTERVAL_MS);
}

// ==================== SUBSCRIPTIONS MANAGEMENT ====================
async function loadChatIds() {
  try {
    const data = await fs.readFile(CHAT_IDS_FILE, 'utf8');
    if (!data.trim()) return [];
    let configs = JSON.parse(data);
    configs = configs.map(c => ({
      chatId: c.chatId,
      buy: {
        isSubscribed: c.buy?.isSubscribed || false,
        token: c.buy?.token || null,
        imageFileId: c.buy?.imageFileId || null,
        mediaType: c.buy?.mediaType || null,
        lastMessageIds: c.buy?.lastMessageIds || [],
        deletePrevious: c.buy?.deletePrevious !== undefined ? c.buy.deletePrevious : true,
        emoji: c.buy?.emoji || '💎',
        emojiBaseAmount: c.buy?.emojiBaseAmount || 100,
        minBuyUsd: c.buy?.minBuyUsd !== undefined ? c.buy.minBuyUsd : null,
        showSells: c.buy?.showSells || false,
        topicId: c.buy?.topicId || null
      }
    }));
    await saveChatIds(configs);
    return configs;
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    console.error('Error loading chatIds:', err.message);
    return [];
  }
}

async function saveChatIds(configs) {
  await fs.writeFile(CHAT_IDS_FILE, JSON.stringify(configs, null, 2));
}

async function updateChat(chatId, action, token = null, fileId = null, media = null, msgIds = null, delPrev = null, emoji = null, base = null, minUsd = null, showSells = null, topicId = null) {
  const configs = await loadChatIds();
  let cfg = configs.find(c => c.chatId === chatId);
  if (!cfg) {
    cfg = { chatId, buy: { isSubscribed: false, deletePrevious: true, emoji: '💎', emojiBaseAmount: 100, minBuyUsd: null, showSells: false, topicId: null } };
    configs.push(cfg);
  }
  const buy = cfg.buy;
  switch (action) {
    case 'subscribe':
      if (!buy.isSubscribed) {
        buy.isSubscribed = true;
        buy.token = null;
        buy.imageFileId = null;
        buy.mediaType = null;
        buy.lastMessageIds = [];
        buy.deletePrevious = true;
        buy.emoji = '💎';
        buy.emojiBaseAmount = 100;
        buy.minBuyUsd = null;
        buy.showSells = false;
        if (topicId !== undefined) buy.topicId = topicId;
        await saveChatIds(configs);
        return true;
      }
      return false;
    case 'unsubscribe':
      if (buy.isSubscribed) {
        buy.isSubscribed = false;
        await saveChatIds(configs);
        return true;
      }
      return false;
    case 'settoken':
      if (buy.isSubscribed) {
        buy.token = token;
        buy.imageFileId = fileId;
        buy.mediaType = media;
        if (topicId !== undefined) buy.topicId = topicId;
        await saveChatIds(configs);
        return true;
      }
      return false;
    case 'changeimage':
      if (buy.isSubscribed && buy.token) {
        buy.imageFileId = fileId;
        buy.mediaType = media;
        await saveChatIds(configs);
        return true;
      }
      return false;
    case 'updatemessageids':
      if (buy.isSubscribed) {
        buy.lastMessageIds = msgIds || [];
        await saveChatIds(configs);
        return true;
      }
      return false;
    case 'setdeleteprevious':
      if (buy.isSubscribed) {
        buy.deletePrevious = delPrev;
        await saveChatIds(configs);
        return true;
      }
      return false;
    case 'setemoji':
      if (buy.isSubscribed) {
        buy.emoji = emoji;
        await saveChatIds(configs);
        return true;
      }
      return false;
    case 'setemojibase':
      if (buy.isSubscribed) {
        buy.emojiBaseAmount = base;
        await saveChatIds(configs);
        return true;
      }
      return false;
    case 'setminbuyusd':
      if (buy.isSubscribed) {
        buy.minBuyUsd = minUsd;
        await saveChatIds(configs);
        return true;
      }
      return false;
    case 'togglesells':
      if (buy.isSubscribed) {
        buy.showSells = !buy.showSells;
        await saveChatIds(configs);
        return true;
      }
      return false;
    case 'settopic':
      if (buy.isSubscribed) {
        buy.topicId = topicId;
        await saveChatIds(configs);
        return true;
      }
      return false;
    case 'reset':
      if (buy.isSubscribed) {
        buy.token = null;
        buy.imageFileId = null;
        buy.mediaType = null;
        buy.emoji = '💎';
        buy.emojiBaseAmount = 100;
        buy.minBuyUsd = null;
        buy.lastMessageIds = [];
        buy.showSells = false;
        buy.topicId = null;
        await saveChatIds(configs);
        return true;
      }
      return false;
    default: return false;
  }
}

async function getStatusText(chatId) {
  const configs = await loadChatIds();
  const cfg = configs.find(c => c.chatId === chatId);
  if (!cfg || !cfg.buy.isSubscribed) {
    return "❌ <b>Not subscribed</b>\n\nUse the Subscribe button to start.";
  }
  const buy = cfg.buy;
  let text = `✅ <b>Subscribed</b>\n`;
  if (buy.token) {
    const tokenName = getTokenDetails(buy.token).name;
    text += `🔹 <b>Token:</b> <code>${buy.token}</code> (${tokenName})\n`;
    text += `🖼️ <b>Image:</b> ${buy.imageFileId ? '✅ associated' : '❌ none (default if exists)'}\n`;
  } else {
    text += `🔹 <b>Token:</b> <i>not set (all tokens)</i>\n`;
  }
  text += `🗑️ <b>Delete previous:</b> ${buy.deletePrevious ? 'ON' : 'OFF'}\n`;
  text += `😀 <b>Emoji:</b> ${buy.emoji} (base: ${buy.emojiBaseAmount})\n`;
  text += `💵 <b>Min USD:</b> ${buy.minBuyUsd !== null ? `$${buy.minBuyUsd}` : 'disabled'}\n`;
  text += `📈 <b>Show Sells:</b> ${buy.showSells ? 'ON' : 'OFF'}\n`;
  if (buy.topicId) text += `📌 <b>Topic ID:</b> ${buy.topicId}\n`;
  return text;
}

// ==================== ADMIN CHECK ====================
async function isAdmin(chatId, userId) {
  // Em chat privado, sempre permitido
  if (chatId === userId) return true;
  try {
    const member = await bot.getChatMember(chatId, userId);
    return ['creator', 'administrator'].includes(member.status);
  } catch (err) {
    console.error(`isAdmin check failed for ${userId} in ${chatId}:`, err.message);
    return false;
  }
}

// ==================== HELPER FUNCTIONS ====================
async function getEffectiveTopicId(chatId, incomingTopicId = null) {
  const configs = await loadChatIds();
  const cfg = configs.find(c => c.chatId === chatId);
  if (cfg?.buy?.topicId) return cfg.buy.topicId;
  if (incomingTopicId) {
    await updateChat(chatId, 'settopic', null, null, null, null, null, null, null, null, null, incomingTopicId);
    return incomingTopicId;
  }
  return null;
}

async function sendMessage(chatId, text, extra = {}) {
  const incomingTopicId = extra._incomingTopicId || null;
  delete extra._incomingTopicId;
  const topicId = await getEffectiveTopicId(chatId, incomingTopicId);
  if (topicId) extra.message_thread_id = topicId;
  return bot.sendMessage(chatId, text, extra);
}

async function editMessageText(chatId, messageId, text, extra = {}) {
  const incomingTopicId = extra._incomingTopicId || null;
  delete extra._incomingTopicId;
  const topicId = await getEffectiveTopicId(chatId, incomingTopicId);
  if (topicId) extra.message_thread_id = topicId;
  return bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...extra });
}

async function sendPhoto(chatId, photo, extra = {}) {
  const incomingTopicId = extra._incomingTopicId || null;
  delete extra._incomingTopicId;
  const topicId = await getEffectiveTopicId(chatId, incomingTopicId);
  if (topicId) extra.message_thread_id = topicId;
  return bot.sendPhoto(chatId, photo, extra);
}

async function sendAnimation(chatId, animation, extra = {}) {
  const incomingTopicId = extra._incomingTopicId || null;
  delete extra._incomingTopicId;
  const topicId = await getEffectiveTopicId(chatId, incomingTopicId);
  if (topicId) extra.message_thread_id = topicId;
  return bot.sendAnimation(chatId, animation, extra);
}

async function sendSticker(chatId, sticker, extra = {}) {
  const incomingTopicId = extra._incomingTopicId || null;
  delete extra._incomingTopicId;
  const topicId = await getEffectiveTopicId(chatId, incomingTopicId);
  if (topicId) extra.message_thread_id = topicId;
  return bot.sendSticker(chatId, sticker, extra);
}

// ==================== KEYBOARDS ====================
const mainMenuKeyboard = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '✅ Subscribe', callback_data: 'subscribe' }, { text: '❌ Unsubscribe', callback_data: 'unsubscribe' }],
      [{ text: '💰 Price', callback_data: 'price' }, { text: '🖼️ Set Token', callback_data: 'settoken_prompt' }],
      [{ text: '⚙️ Settings', callback_data: 'settings' }, { text: 'ℹ️ Help', callback_data: 'help' }]
    ]
  }
};

const settingsKeyboard = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '🎨 Change Image', callback_data: 'changeimage_prompt' }],
      [{ text: '🗑️ Delete Previous Msgs', callback_data: 'toggle_delete' }],
      [{ text: '😀 Set Emoji', callback_data: 'setemoji_prompt' }],
      [{ text: '🔢 Set Emoji Base', callback_data: 'setemojibase_prompt' }],
      [{ text: '💵 Set Min USD', callback_data: 'setminbuy_prompt' }],
      [{ text: '📈 Show Sells', callback_data: 'toggle_sells' }],
      [{ text: '🧹 Reset All', callback_data: 'reset_all' }],
      [{ text: '🔙 Back', callback_data: 'main_menu' }]
    ]
  }
};

// ==================== GROUP WELCOME (FIXED) ====================
bot.on('new_chat_members', async (msg) => {
  // Guard: array deve existir
  if (!msg.new_chat_members || !Array.isArray(msg.new_chat_members)) return;
  // Guard: botId pode ainda não estar pronto
  if (!botId) return;
  // Verifica se o bot está entre os novos membros
  const isBotAdded = msg.new_chat_members.some(member => member && member.id === botId);
  if (!isBotAdded) return;

  const chatId = msg.chat.id;
  const welcomeGroup = `<b>👋 Hello! I'm Lucky Alerts Bot.</b>

I have been added to this group! 🎉

To start receiving <b>buy</b> alerts (and optionally sells) on Supra/Dexlyn, an admin must use the command:

<code>/subscribe_buy</code>

Then you can filter by token, customize emoji, etc.

👉 <b>Main commands:</b>
/subscribe_buy - Enable alerts
/unsubscribe_buy - Disable
/settoken_buy &lt;address&gt; - Filter only one token
/price - See current price
/help - Full list

<i>Tip:</i> To use me inside a specific <b>topic</b>, send any command <i>inside</i> that topic. I will remember it.

🍀 <b>LuckyPowerBots</b> | <a href="https://t.me/lucky_supra">Telegram</a> | <a href="https://x.com/LuckyTokenz">X</a>`;

  await sendMessage(chatId, welcomeGroup, { parse_mode: 'HTML' });
});

// ==================== /start ====================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const incomingTopicId = msg.message_thread_id || null;

  if (incomingTopicId) {
    const configs = await loadChatIds();
    const cfg = configs.find(c => c.chatId === chatId);
    if (!cfg || !cfg.buy.topicId) {
      await updateChat(chatId, 'settopic', null, null, null, null, null, null, null, null, null, incomingTopicId);
    }
  }

  const status = await getStatusText(chatId);
  const isSubscribed = (await loadChatIds()).find(c => c.chatId === chatId)?.buy.isSubscribed || false;

  let welcome = `<b>🐂 Lucky Alerts Bot</b> 🐂\n\n`;
  welcome += `I monitor <b>SwapEvents</b> on the Supra blockchain (Dexlyn) and notify you when someone <b>buys</b> (or sells, if enabled) a token.\n\n`;

  if (!isSubscribed) {
    welcome += `<b>📌 Quick start:</b>\n`;
    welcome += `1️⃣ Use the <b>Subscribe</b> button below (or send /subscribe_buy).\n`;
    welcome += `2️⃣ (Optional) Set a token to filter: /settoken_buy &lt;address&gt;\n`;
    welcome += `3️⃣ Customize: emoji, minimum USD, auto‑delete, etc.\n\n`;
  } else {
    welcome += `<b>✅ You are subscribed!</b>\n\n`;
    welcome += `• To filter a specific token: /settoken_buy &lt;address&gt;\n`;
    welcome += `• Change image: /changeimage_buy\n`;
    welcome += `• Settings: use the buttons below.\n\n`;
  }

  welcome += `${status}\n\n`;
  welcome += `Use the buttons below or text commands in groups.`;

  await sendMessage(chatId, welcome, { parse_mode: 'HTML', ...mainMenuKeyboard, _incomingTopicId: incomingTopicId });
});

// ==================== CALLBACK QUERIES ====================
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const msgId = callbackQuery.message.message_id;
  const data = callbackQuery.data;
  const userId = callbackQuery.from.id;
  const incomingTopicId = callbackQuery.message.message_thread_id || null;
  await bot.answerCallbackQuery(callbackQuery.id);

  // Ações de leitura livres; configuração apenas para admins em grupos
  const readOnlyActions = ['price', 'help', 'main_menu'];
  const isGroup = chatId !== userId;
  if (isGroup && !readOnlyActions.includes(data)) {
    if (!(await isAdmin(chatId, userId))) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: '🚫 Only group admins can configure the bot.', show_alert: true }).catch(() => {});
      return;
    }
  }

  if (incomingTopicId) {
    const configs = await loadChatIds();
    const cfg = configs.find(c => c.chatId === chatId);
    if (!cfg || !cfg.buy.topicId) {
      await updateChat(chatId, 'settopic', null, null, null, null, null, null, null, null, null, incomingTopicId);
    }
  }

  const configs = await loadChatIds();
  const cfg = configs.find(c => c.chatId === chatId);
  const isSubscribed = cfg?.buy?.isSubscribed || false;

  async function updateMenu(text, keyboard) {
    try {
      await editMessageText(chatId, msgId, text, { parse_mode: 'HTML', ...keyboard, _incomingTopicId: incomingTopicId });
    } catch (err) {
      if (!err.message.includes('message is not modified')) {
        console.error(`Edit error: ${err.message}`);
        await sendMessage(chatId, text, { parse_mode: 'HTML', ...keyboard, _incomingTopicId: incomingTopicId });
      }
    }
  }

  switch (data) {
    case 'subscribe':
      if (await updateChat(chatId, 'subscribe', null, null, null, null, null, null, null, null, null, incomingTopicId)) {
        const newStatus = await getStatusText(chatId);
        await updateMenu(`<b>🐂 Lucky Alerts Bot</b>\n\n${newStatus}\n\nUse buttons below.`, mainMenuKeyboard);
        await sendMessage(chatId, "✅ Subscribed! Now you can use /settoken_buy &lt;address&gt; to filter a specific token, or keep receiving all tokens.", { _incomingTopicId: incomingTopicId });
      } else {
        await updateMenu('⚠️ Already subscribed.', mainMenuKeyboard);
      }
      break;
    case 'unsubscribe':
      if (await updateChat(chatId, 'unsubscribe')) {
        const newStatus = await getStatusText(chatId);
        await updateMenu(`<b>🐂 Lucky Alerts Bot</b>\n\n${newStatus}\n\nUse buttons below.`, mainMenuKeyboard);
      } else {
        await updateMenu('⚠️ Not subscribed.', mainMenuKeyboard);
      }
      break;
    case 'price':
      if (!isSubscribed || !cfg.buy.token) {
        await updateMenu('⚠️ <b>Please subscribe and set a token first.</b>\n\nUse "Set Token" button.', mainMenuKeyboard);
        break;
      }
      try {
        const { price, marketCap } = await getTokenPriceAndMC(cfg.buy.token);
        const name = getTokenDetails(cfg.buy.token).name;
        let text = `📊 <b>${name} Price</b>\n💸 Price: <b>$${price.toFixed(6)}</b>`;
        if (marketCap !== null) text += `\n🚀 Market Cap: <b>$${marketCap.toFixed(2)}</b>`;
        await updateMenu(text, mainMenuKeyboard);
      } catch (err) {
        await updateMenu('❌ Error fetching price. Try again later.', mainMenuKeyboard);
      }
      break;
    case 'settings':
      await updateMenu('⚙️ <b>Settings</b>\n\nChoose an option:', settingsKeyboard);
      break;
    case 'main_menu': {
      const statusText = await getStatusText(chatId);
      await updateMenu(`<b>🐂 Lucky Alerts Bot</b>\n\n${statusText}\n\nUse buttons below.`, mainMenuKeyboard);
      break;
    }
    case 'toggle_delete': {
      const current = cfg?.buy.deletePrevious ?? true;
      await updateChat(chatId, 'setdeleteprevious', null, null, null, null, !current);
      const newStatusDel = await getStatusText(chatId);
      await updateMenu(`⚙️ <b>Settings</b>\n\n${newStatusDel}\n\nChoose an option:`, settingsKeyboard);
      break;
    }
    case 'toggle_sells':
      if (!isSubscribed) {
        await updateMenu('⚠️ You are not subscribed.', settingsKeyboard);
        break;
      }
      await updateChat(chatId, 'togglesells');
      {
        const newStatusSells = await getStatusText(chatId);
        await updateMenu(`⚙️ <b>Settings</b>\n\n${newStatusSells}\n\nChoose an option:`, settingsKeyboard);
      }
      break;
    case 'reset_all':
      if (!isSubscribed) {
        await updateMenu('⚠️ You are not subscribed. Nothing to reset.', settingsKeyboard);
        break;
      }
      await updateChat(chatId, 'reset');
      {
        const resetStatus = await getStatusText(chatId);
        await updateMenu(`🧹 <b>All settings reset</b>\n\n${resetStatus}\n\nUse buttons below.`, mainMenuKeyboard);
      }
      break;
    case 'settoken_prompt':
      pendingTokenInput[chatId] = true;
      await updateMenu('📝 <b>Set Token</b>\n\nSend the token address as text:\n<code>0x1::supra_coin::SupraCoin</code>\n\nAfter that, send a photo/GIF/sticker to associate.', mainMenuKeyboard);
      break;
    case 'changeimage_prompt':
      if (!isSubscribed || !cfg?.buy.token) {
        await updateMenu('⚠️ Subscribe and set a token first.', settingsKeyboard);
      } else {
        pendingImageUploads[chatId] = { action: 'changeimage', token: cfg.buy.token };
        await updateMenu('🎨 <b>Change Image</b>\n\nSend new photo, GIF, or sticker.', settingsKeyboard);
      }
      break;
    case 'setemoji_prompt':
      pendingSettingsInput[chatId] = 'emoji';
      await updateMenu('😀 <b>Set Emoji</b>\n\nSend the emoji (e.g., ☘️ or 🚀)', settingsKeyboard);
      break;
    case 'setemojibase_prompt':
      pendingSettingsInput[chatId] = 'base';
      await updateMenu('🔢 <b>Set Emoji Base</b>\n\nNumber of tokens per emoji (e.g., 100)', settingsKeyboard);
      break;
    case 'setminbuy_prompt':
      pendingSettingsInput[chatId] = 'minbuy';
      await updateMenu('💵 <b>Set Minimum USD</b>\n\nExample: 20 (or 0 to disable)', settingsKeyboard);
      break;
    case 'help': {
      const helpText = `<b>Lucky Alerts Bot</b>

<b>Buttons (private chat)</b>
• Subscribe / Unsubscribe
• Price
• Set Token (paste address)
• Settings: Change Image, Delete Previous Msgs, Set Emoji, Set Emoji Base, Set Min USD, Show Sells, Reset All

<b>Text commands (groups)</b>
/subscribe_buy
/unsubscribe_buy
/settoken_buy &lt;address&gt;
/changeimage_buy
/deleteprevious_buy on|off
/setemoji_buy &lt;emoji&gt;
/setemojibase_buy &lt;amount&gt;
/setminbuyusd &lt;usd&gt;
/price
/resettopic
/help

<b>Need help?</b> Open private chat for buttons.`;
      await updateMenu(helpText, mainMenuKeyboard);
      break;
    }
    default: break;
  }
});

// ==================== TEXT HANDLER ====================
bot.on('text', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const rawText = msg.text.trim();
  const incomingTopicId = msg.message_thread_id || null;
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

  // Normaliza comandos com @BotUsername: /cmd@Bot args -> /cmd args
  // Ex: /settoken_buy@LuckyAlerts_Bot 0x... -> /settoken_buy 0x...
  const text = rawText.replace(/^(\/[a-zA-Z0-9_]+)@[a-zA-Z0-9_]+/, '$1');

  // Comandos de leitura liberados; o resto só admins em grupos
  const readOnlyCommands = ['/price', '/help', '/start'];
  const isReadOnly = readOnlyCommands.some(cmd => text === cmd || text.startsWith(cmd + ' '));
  if (isGroup && !isReadOnly && text.startsWith('/')) {
    if (!(await isAdmin(chatId, userId))) {
      await sendMessage(chatId, '🚫 Only group admins can configure the bot.', { _incomingTopicId: incomingTopicId });
      return;
    }
  }

  // Guarda topic se ainda não guardado (exceto /resettopic)
  if (incomingTopicId && text !== '/resettopic') {
    const configs = await loadChatIds();
    const cfg = configs.find(c => c.chatId === chatId);
    if (!cfg || !cfg.buy.topicId) {
      await updateChat(chatId, 'settopic', null, null, null, null, null, null, null, null, null, incomingTopicId);
    }
  }

  // /resettopic
  if (text === '/resettopic') {
    const configs = await loadChatIds();
    const cfg = configs.find(c => c.chatId === chatId);
    if (cfg && cfg.buy.isSubscribed) {
      await updateChat(chatId, 'settopic', null, null, null, null, null, null, null, null, null, null);
      await sendMessage(chatId, '🧹 Topic reset. Future messages will go to the default topic (or use /start in a new topic to set it again).', { _incomingTopicId: incomingTopicId });
    } else {
      await sendMessage(chatId, '⚠️ You are not subscribed. Use /subscribe_buy first.', { _incomingTopicId: incomingTopicId });
    }
    return;
  }

  // Pending token input
  if (pendingTokenInput[chatId]) {
    delete pendingTokenInput[chatId];
    const isValid = /^0x[a-fA-F0-9]+::[a-zA-Z0-9_]+::[a-zA-Z0-9_]+$/.test(text);
    if (!isValid) {
      await sendMessage(chatId, '❌ Invalid token format. Example: <code>0x1::supra_coin::SupraCoin</code>', { parse_mode: 'HTML', _incomingTopicId: incomingTopicId });
      return;
    }
    const ok = await updateChat(chatId, 'settoken', text, null, null, null, null, null, null, null, null, incomingTopicId);
    if (ok) {
      pendingImageUploads[chatId] = { action: 'settoken', token: text };
      await sendMessage(chatId, `✅ Token set: <code>${text}</code>\nNow send a photo, GIF, or sticker.`, { parse_mode: 'HTML', _incomingTopicId: incomingTopicId });
    } else {
      await sendMessage(chatId, '⚠️ Subscribe first using /subscribe_buy or Subscribe button.', { _incomingTopicId: incomingTopicId });
    }
    return;
  }

  // Pending settings input (emoji, base, min)
  const setting = pendingSettingsInput[chatId];
  if (setting) {
    delete pendingSettingsInput[chatId];
    if (setting === 'emoji') {
      const emojiRegex = /\p{Emoji_Presentation}|\p{Emoji}\uFE0F/gu;
      if (!emojiRegex.test(text)) {
        await sendMessage(chatId, '❌ Invalid emoji. Send a single emoji like ☘️', { _incomingTopicId: incomingTopicId });
        return;
      }
      const ok = await updateChat(chatId, 'setemoji', null, null, null, null, null, text);
      if (ok) {
        await sendMessage(chatId, `😀 Emoji set to ${text}`, { _incomingTopicId: incomingTopicId });
        const status = await getStatusText(chatId);
        await sendMessage(chatId, `📋 ${status}`, { parse_mode: 'HTML', _incomingTopicId: incomingTopicId });
      } else {
        await sendMessage(chatId, '⚠️ Error.', { _incomingTopicId: incomingTopicId });
      }
    } else if (setting === 'base') {
      const base = parseInt(text, 10);
      if (isNaN(base) || base <= 0) {
        await sendMessage(chatId, '❌ Positive number required. Example: 100', { _incomingTopicId: incomingTopicId });
        return;
      }
      const ok = await updateChat(chatId, 'setemojibase', null, null, null, null, null, null, base);
      if (ok) {
        await sendMessage(chatId, `🔢 Emoji base set to ${base}`, { _incomingTopicId: incomingTopicId });
        const status = await getStatusText(chatId);
        await sendMessage(chatId, `📋 ${status}`, { parse_mode: 'HTML', _incomingTopicId: incomingTopicId });
      } else {
        await sendMessage(chatId, '⚠️ Error.', { _incomingTopicId: incomingTopicId });
      }
    } else if (setting === 'minbuy') {
      const min = parseFloat(text);
      if (isNaN(min) || min < 0) {
        await sendMessage(chatId, '❌ Non-negative number. Example: 20', { _incomingTopicId: incomingTopicId });
        return;
      }
      const ok = await updateChat(chatId, 'setminbuyusd', null, null, null, null, null, null, null, min);
      if (ok) {
        await sendMessage(chatId, `💵 Minimum USD set to $${min}`, { _incomingTopicId: incomingTopicId });
        const status = await getStatusText(chatId);
        await sendMessage(chatId, `📋 ${status}`, { parse_mode: 'HTML', _incomingTopicId: incomingTopicId });
      } else {
        await sendMessage(chatId, '⚠️ Error.', { _incomingTopicId: incomingTopicId });
      }
    }
    return;
  }

  // Ignora mensagens que não são comandos
  if (!text.startsWith('/')) return;

  const sendCmd = (content, extra = {}) => sendMessage(chatId, content, { ...extra, _incomingTopicId: incomingTopicId });

  if (text === '/subscribe_buy') {
    const ok = await updateChat(chatId, 'subscribe', null, null, null, null, null, null, null, null, null, incomingTopicId);
    if (ok) {
      await sendCmd('✅ Subscribed!');
      await sendCmd('<b>💡 Next step:</b> Use /settoken_buy &lt;address&gt; to filter a specific token, or keep receiving all tokens.', { parse_mode: 'HTML' });
    } else {
      await sendCmd('⚠️ Already subscribed.');
    }
  } else if (text === '/unsubscribe_buy') {
    const ok = await updateChat(chatId, 'unsubscribe');
    await sendCmd(ok ? '❌ Unsubscribed.' : '⚠️ Not subscribed.');
  } else if (text === '/settoken_buy' || text.startsWith('/settoken_buy ')) {
    const token = text.startsWith('/settoken_buy ') ? text.substring(14).trim() : '';
    if (!token) {
      pendingTokenInput[chatId] = true;
      await sendCmd('📝 Send the token address:\n<code>0x1::supra_coin::SupraCoin</code>', { parse_mode: 'HTML' });
      return;
    }
    const isValid = /^0x[a-fA-F0-9]+::[a-zA-Z0-9_]+::[a-zA-Z0-9_]+$/.test(token);
    if (!isValid) {
      await sendCmd('❌ Invalid token format. Example: <code>0x1::supra_coin::SupraCoin</code>', { parse_mode: 'HTML' });
      return;
    }
    const ok = await updateChat(chatId, 'settoken', token, null, null, null, null, null, null, null, null, incomingTopicId);
    if (ok) {
      pendingImageUploads[chatId] = { action: 'settoken', token };
      await sendCmd('✅ Token set. Now send a photo/GIF/sticker.');
    } else {
      await sendCmd('⚠️ Subscribe first.');
    }
  } else if (text === '/changeimage_buy') {
    const configs = await loadChatIds();
    const cfg = configs.find(c => c.chatId === chatId);
    if (!cfg?.buy?.isSubscribed || !cfg.buy.token) {
      await sendCmd('⚠️ Subscribe and set a token first.');
      return;
    }
    pendingImageUploads[chatId] = { action: 'changeimage', token: cfg.buy.token };
    await sendCmd('🎨 Send new image/GIF/sticker.');
  } else if (text.startsWith('/deleteprevious_buy ')) {
    const val = text.substring(20).trim();
    const del = val === 'on';
    const ok = await updateChat(chatId, 'setdeleteprevious', null, null, null, null, del);
    await sendCmd(ok ? `🗑️ Delete previous: ${del ? 'ON' : 'OFF'}` : '⚠️ Error.');
  } else if (text.startsWith('/setemoji_buy ')) {
    const emoji = text.substring(14).trim();
    const ok = await updateChat(chatId, 'setemoji', null, null, null, null, null, emoji);
    if (ok) {
      await sendCmd(`😀 Emoji set to ${emoji}`);
      const status = await getStatusText(chatId);
      await sendCmd(`📋 ${status}`, { parse_mode: 'HTML' });
    } else await sendCmd('⚠️ Error.');
  } else if (text.startsWith('/setemojibase_buy ')) {
    const base = parseInt(text.substring(18).trim(), 10);
    if (isNaN(base) || base <= 0) {
      await sendCmd('❌ Positive number required. Example: 100');
      return;
    }
    const ok = await updateChat(chatId, 'setemojibase', null, null, null, null, null, null, base);
    if (ok) {
      await sendCmd(`🔢 Base set to ${base}`);
      const status = await getStatusText(chatId);
      await sendCmd(`📋 ${status}`, { parse_mode: 'HTML' });
    } else await sendCmd('⚠️ Error.');
  } else if (text.startsWith('/setminbuyusd ')) {
    const min = parseFloat(text.substring(14).trim());
    if (isNaN(min) || min < 0) {
      await sendCmd('❌ Non-negative number. Example: 20');
      return;
    }
    const ok = await updateChat(chatId, 'setminbuyusd', null, null, null, null, null, null, null, min);
    if (ok) {
      await sendCmd(`💵 Min USD set to $${min}`);
      const status = await getStatusText(chatId);
      await sendCmd(`📋 ${status}`, { parse_mode: 'HTML' });
    } else await sendCmd('⚠️ Error.');
  } else if (text === '/price') {
    const configs = await loadChatIds();
    const cfg = configs.find(c => c.chatId === chatId);
    const subscribedToken = cfg?.buy?.isSubscribed ? cfg.buy.token : null;
    // Se tem token definido mostra esse; senão mostra SUPRA por defeito
    const tokenToQuery = subscribedToken || SUPRA_COIN_TYPE;
    try {
      const { price, marketCap } = await getTokenPriceAndMC(tokenToQuery);
      const name = getTokenDetails(tokenToQuery).name;
      let resp = `📊 <b>${name}</b>\n💸 Price: <b>$${price.toFixed(6)}</b>`;
      if (marketCap !== null) resp += `\n🚀 Market Cap: <b>$${marketCap.toFixed(2)}</b>`;
      await sendCmd(resp, { parse_mode: 'HTML' });
    } catch (err) {
      await sendCmd('❌ Error fetching price.');
    }
  } else if (text === '/togglesells') {
    const ok = await updateChat(chatId, 'togglesells');
    if (ok) {
      const configs2 = await loadChatIds();
      const cfg2 = configs2.find(c => c.chatId === chatId);
      const state = cfg2?.buy?.showSells ? 'ON ✅' : 'OFF ❌';
      await sendCmd(`📈 Show Sells: <b>${state}</b>`, { parse_mode: 'HTML' });
    } else {
      await sendCmd('⚠️ Subscribe first.');
    }
  } else if (text === '/help') {
    const help = `<b>Lucky Alerts Bot Commands</b>

/start - main menu
/subscribe_buy
/unsubscribe_buy
/settoken_buy &lt;address&gt;
/changeimage_buy
/deleteprevious_buy on|off
/setemoji_buy &lt;emoji&gt;
/setemojibase_buy &lt;amount&gt;
/setminbuyusd &lt;usd&gt;
/togglesells
/price
/resettopic
/help

<b>Buttons</b> work in private chat.`;
    await sendCmd(help, { parse_mode: 'HTML' });
  }
});

// ==================== IMAGE HANDLING ====================
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const pending = pendingImageUploads[chatId];
  if (!pending || (pending.action !== 'settoken' && pending.action !== 'changeimage')) return;
  const incomingTopicId = msg.message_thread_id || null;
  const fileId = msg.photo[msg.photo.length - 1].file_id;
  const ok = await updateChat(chatId, pending.action, pending.token, fileId, 'photo');
  if (ok) {
    delete pendingImageUploads[chatId];
    await sendMessage(chatId, '✅ Image associated!', { _incomingTopicId: incomingTopicId });
    const status = await getStatusText(chatId);
    await sendMessage(chatId, `📋 ${status}`, { parse_mode: 'HTML', _incomingTopicId: incomingTopicId });
  } else await sendMessage(chatId, '❌ Error.', { _incomingTopicId: incomingTopicId });
});

bot.on('animation', async (msg) => {
  const chatId = msg.chat.id;
  const pending = pendingImageUploads[chatId];
  if (!pending || (pending.action !== 'settoken' && pending.action !== 'changeimage')) return;
  const incomingTopicId = msg.message_thread_id || null;
  const fileId = msg.animation.file_id;
  const ok = await updateChat(chatId, pending.action, pending.token, fileId, 'animation');
  if (ok) {
    delete pendingImageUploads[chatId];
    await sendMessage(chatId, '✅ GIF associated!', { _incomingTopicId: incomingTopicId });
    const status = await getStatusText(chatId);
    await sendMessage(chatId, `📋 ${status}`, { parse_mode: 'HTML', _incomingTopicId: incomingTopicId });
  } else await sendMessage(chatId, '❌ Error.', { _incomingTopicId: incomingTopicId });
});

bot.on('sticker', async (msg) => {
  const chatId = msg.chat.id;
  const pending = pendingImageUploads[chatId];
  if (!pending || (pending.action !== 'settoken' && pending.action !== 'changeimage')) return;
  const incomingTopicId = msg.message_thread_id || null;
  const fileId = msg.sticker.file_id;
  const ok = await updateChat(chatId, pending.action, pending.token, fileId, 'sticker');
  if (ok) {
    delete pendingImageUploads[chatId];
    await sendMessage(chatId, '✅ Sticker associated!', { _incomingTopicId: incomingTopicId });
    const status = await getStatusText(chatId);
    await sendMessage(chatId, `📋 ${status}`, { parse_mode: 'HTML', _incomingTopicId: incomingTopicId });
  } else await sendMessage(chatId, '❌ Error.', { _incomingTopicId: incomingTopicId });
});

// ==================== SWAP MONITORING ====================
async function getLatestBlock() {
  const res = await axios.get(`${API_BASE_URL}/block`);
  return res.data.height;
}

async function fetchSwaps() {
  const height = await getLatestBlock();
  const start = Math.max(1, height - 9);
  const end = height + 1;
  const res = await axios.get(`${API_BASE_URL}/events/${BUY_EVENT_TYPE}`, { params: { start, end } });
  const events = res.data.data || [];

  // Evitar crescimento infinito do Set (memory leak)
  if (processedEvents.size > MAX_PROCESSED_EVENTS) {
    processedEvents.clear();
  }

  const newEvents = events.filter(e => {
    const id = `${e.guid.account_address}:${e.guid.creation_number}:${e.data.timestamp}`;
    if (processedEvents.has(id)) return false;
    processedEvents.add(id);
    return true;
  });
  return newEvents;
}


// Erros fatais: chat inexistente, bot removido, bloqueado, etc.
function isFatalChatError(err) {
  const msg = err.message || '';
  return (
    msg.includes('chat not found') ||
    msg.includes('bot was kicked') ||
    msg.includes('bot was blocked') ||
    msg.includes('user is deactivated') ||
    msg.includes('have no rights to send') ||
    msg.includes('group chat was upgraded') ||
    msg.includes('PEER_ID_INVALID')
  );
}

async function sendNotification(chatId, buyConfig, type, primaryToken, primaryAmount, secondaryToken, secondaryAmount, usdValue) {
  const amountNum = parseFloat(primaryAmount);
  const emojiCount = Math.min(Math.floor(amountNum / buyConfig.emojiBaseAmount), 35);
  const emojiStr = emojiCount > 0 ? buyConfig.emoji.repeat(emojiCount) : '';

  let marketCapStr = '';
  if (primaryToken.supply > 0) {
    try {
      const { marketCap } = await getTokenPriceAndMC(primaryToken.typeTag);
      if (marketCap !== null) {
        // Format market cap with commas, no decimals if >= 1
        marketCapStr = marketCap >= 1
          ? Math.round(marketCap).toLocaleString('en-US')
          : marketCap.toFixed(2);
      }
    } catch (e) {}
  }

  let message = '';
  if (type === 'BUY') {
    message += `🟢 A new buy of <b>${primaryToken.name}</b> has been detected !\n\n ${emojiStr}\n\n`;
    message += `💸 <b>Spent:</b> ${secondaryAmount} ${secondaryToken.name}\n\n`;
    message += `💰 <b>Bought:</b> ${primaryAmount} ${primaryToken.name}\n\n`;
    if (marketCapStr) message += `🏦 <b>Market Cap:</b> ${marketCapStr} USD\n\n`;
  } else {
    message += `🔴 A new sell of <b>${primaryToken.name}</b> has been detected !${emojiStr}\n\n`;
    message += `💰 <b>Sold:</b> ${primaryAmount} ${primaryToken.name}\n\n`;
    message += `💸 <b>Received:</b> ${secondaryAmount} ${secondaryToken.name}\n\n`;
    if (marketCapStr) message += `🏦 <b>Market Cap:</b> ${marketCapStr} USD\n\n`;
  }

  message += `<i>LuckyPowerBots</i> 🍀`;

  const inlineKeyboard = {
    inline_keyboard: [[
      { text: '📱 Telegram', url: 'https://t.me/lucky_supra' },
      { text: '🐦 X', url: 'https://x.com/LuckyTokenz' }
    ]]
  };

  if (buyConfig.deletePrevious && buyConfig.lastMessageIds.length) {
    for (const mid of buyConfig.lastMessageIds) {
      try { await bot.deleteMessage(chatId, mid); } catch (e) {}
    }
  }

  let newMsgIds = [];
  let imageId = null, mediaType = null;
  if (buyConfig.token === primaryToken.typeTag && buyConfig.imageFileId) {
    imageId = buyConfig.imageFileId;
    mediaType = buyConfig.mediaType;
  } else if (DEFAULT_IMAGES[primaryToken.typeTag]) {
    imageId = DEFAULT_IMAGES[primaryToken.typeTag].fileId;
    mediaType = DEFAULT_IMAGES[primaryToken.typeTag].mediaType;
  }

  try {
    if (imageId) {
      if (mediaType === 'photo') {
        const sent = await sendPhoto(chatId, imageId, { caption: message, parse_mode: 'HTML', reply_markup: inlineKeyboard });
        newMsgIds.push(sent.message_id);
      } else if (mediaType === 'animation') {
        const sent = await sendAnimation(chatId, imageId, { caption: message, parse_mode: 'HTML', reply_markup: inlineKeyboard });
        newMsgIds.push(sent.message_id);
      } else if (mediaType === 'sticker') {
        const stickerMsg = await sendSticker(chatId, imageId);
        const textMsg = await sendMessage(chatId, message, { parse_mode: 'HTML', reply_markup: inlineKeyboard });
        newMsgIds.push(stickerMsg.message_id, textMsg.message_id);
      }
    } else {
      const sent = await sendMessage(chatId, message, { parse_mode: 'HTML', reply_markup: inlineKeyboard });
      newMsgIds.push(sent.message_id);
    }
  } catch (err) {
    console.error(`Send error to ${chatId}:`, err.message);
    // Se o chat não existe ou o bot foi removido, dessubscrever automaticamente
    if (isFatalChatError(err)) {
      console.warn(`⚠️  Chat ${chatId} unreachable — auto-unsubscribing.`);
      await updateChat(chatId, 'unsubscribe');
      return;
    }
    try {
      const sent = await sendMessage(chatId, message, { parse_mode: 'HTML', reply_markup: inlineKeyboard });
      newMsgIds.push(sent.message_id);
    } catch (e) {
      console.error(`Fallback send also failed for ${chatId}:`, e.message);
      if (isFatalChatError(e)) {
        console.warn(`⚠️  Chat ${chatId} unreachable on fallback — auto-unsubscribing.`);
        await updateChat(chatId, 'unsubscribe');
        return;
      }
    }
  }

  await updateChat(chatId, 'updatemessageids', null, null, null, newMsgIds);
}

async function processSwaps() {
  try {
    const events = await fetchSwaps();
    if (!events.length) return;

    for (const ev of events) {
      const { pair_x, pair_y, x_in, x_out, y_in, y_out } = ev.data;
      const tokenX = getTokenDetails(pair_x);
      const tokenY = getTokenDetails(pair_y);

      if (pair_y !== SUPRA_COIN_TYPE && pair_x !== SUPRA_COIN_TYPE) continue;

      let type = null;
      let primaryToken, primaryAmount, secondaryToken, secondaryAmount, usdValue = null;

      if (pair_y === SUPRA_COIN_TYPE) {
        if (x_out > 0 && y_in > 0) {
          type = 'BUY';
          primaryToken = tokenX;
          primaryAmount = formatAmount(x_out, tokenX.decimals);
          secondaryToken = tokenY;
          secondaryAmount = formatAmount(y_in, tokenY.decimals);
          usdValue = (y_in / SUPRA_DECIMALS) * supraPrice;
        } else if (y_out > 0 && x_in > 0) {
          type = 'SELL';
          primaryToken = tokenX;
          primaryAmount = formatAmount(x_in, tokenX.decimals);
          secondaryToken = tokenY;
          secondaryAmount = formatAmount(y_out, tokenY.decimals);
          usdValue = (y_out / SUPRA_DECIMALS) * supraPrice;
        }
      } else if (pair_x === SUPRA_COIN_TYPE) {
        if (y_out > 0 && x_in > 0) {
          type = 'BUY';
          primaryToken = tokenY;
          primaryAmount = formatAmount(y_out, tokenY.decimals);
          secondaryToken = tokenX;
          secondaryAmount = formatAmount(x_in, tokenX.decimals);
          usdValue = (x_in / SUPRA_DECIMALS) * supraPrice;
        } else if (x_out > 0 && y_in > 0) {
          type = 'SELL';
          primaryToken = tokenY;
          primaryAmount = formatAmount(y_in, tokenY.decimals);
          secondaryToken = tokenX;
          secondaryAmount = formatAmount(x_out, tokenX.decimals);
          usdValue = (x_out / SUPRA_DECIMALS) * supraPrice;
        }
      }

      if (!type) continue;

      console.log(`${type}: ${primaryAmount} ${primaryToken.name} for ${secondaryAmount} ${secondaryToken.name} ($${usdValue?.toFixed(2)})`);

      const configs = await loadChatIds();
      for (const cfg of configs) {
        const buy = cfg.buy;
        if (!buy.isSubscribed) continue;
        if (buy.token && buy.token !== primaryToken.typeTag) continue;
        if (type === 'BUY' && buy.minBuyUsd !== null && usdValue < buy.minBuyUsd) {
          console.log(`Ignored buy $${usdValue.toFixed(2)} (min $${buy.minBuyUsd}) for ${cfg.chatId}`);
          continue;
        }
        if (type === 'SELL' && !buy.showSells) continue;
        await sendNotification(cfg.chatId, buy, type, primaryToken, primaryAmount, secondaryToken, secondaryAmount, usdValue);
      }
    }
  } catch (err) {
    console.error('processSwaps error:', err.message);
  }
}

// ==================== GLOBAL ERROR HANDLERS ====================
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
});

// ==================== START ====================
startPriceLoop();
setInterval(processSwaps, POLLING_INTERVAL_MS);
console.log('🚀 Lucky Alerts Bot started (HTML mode). Monitoring swaps...');