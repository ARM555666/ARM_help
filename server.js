const express = require('express');
const http = require('http');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const server = http.createServer(app);

// Enable JSON and URL-encoded body
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const botToken = (process.env.DISCORD_BOT_TOKEN || '').trim();
const channelId = (process.env.DISCORD_CHANNEL_ID || '').trim();

// Cache for Discord API to prevent rate limits
let cachedChannelInfo = null;
let lastChannelFetchTime = 0;
let cachedMessages = [];
let lastMessageFetchTime = 0;
let cachedBotUser = null;

// Helper: Fetch Bot User Info
async function getBotUser() {
  if (cachedBotUser) return cachedBotUser;
  if (!botToken) return null;
  try {
    const res = await fetch('https://discord.com/api/v10/users/@me', {
      headers: {
        'Authorization': `Bot ${botToken}`,
        'User-Agent': 'DiscordWebBridge (https://vercel.app, 1.0.0)'
      }
    });
    if (res.ok) {
      cachedBotUser = await res.json();
      return cachedBotUser;
    }
  } catch (e) {
    console.error('Error fetching bot user:', e.message);
  }
  return null;
}

// Helper: Fetch Channel Info
async function getChannelInfo() {
  const now = Date.now();
  if (cachedChannelInfo && (now - lastChannelFetchTime < 60000)) {
    return cachedChannelInfo;
  }
  if (!botToken || !channelId) return null;

  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}`, {
      headers: {
        'Authorization': `Bot ${botToken}`,
        'User-Agent': 'DiscordWebBridge (https://vercel.app, 1.0.0)'
      }
    });
    if (res.ok) {
      cachedChannelInfo = await res.json();
      lastChannelFetchTime = now;
      return cachedChannelInfo;
    }
  } catch (e) {
    console.error('Error fetching channel info:', e.message);
  }
  return null;
}

// Helper: Fetch Recent Messages from Discord Channel
async function fetchDiscordMessages() {
  const now = Date.now();
  // 1.2 second cache to prevent hitting rate limits
  if (cachedMessages.length > 0 && (now - lastMessageFetchTime < 1200)) {
    return cachedMessages;
  }
  if (!botToken || !channelId) return [];

  try {
    const botUser = await getBotUser();
    const botId = botUser ? botUser.id : null;

    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=35`, {
      headers: {
        'Authorization': `Bot ${botToken}`,
        'User-Agent': 'DiscordWebBridge (https://vercel.app, 1.0.0)'
      }
    });

    if (res.ok) {
      const data = await res.json();
      const formatted = data.reverse().map(m => {
        const isBotMsg = botId && m.author && m.author.id === botId;
        const isWebFormat = isBotMsg && m.content && m.content.startsWith('💬 **[');

        let author = m.author ? (m.author.global_name || m.author.username) : 'Discord User';
        let text = m.content || '';
        let sender = 'discord';

        if (isWebFormat) {
          sender = 'web';
          const match = m.content.match(/^💬 \*\*\[(.*?)\]\*\*:\s*([\s\S]*)$/);
          if (match) {
            author = match[1];
            text = match[2];
          }
        }

        let avatar = null;
        if (m.author && m.author.avatar) {
          avatar = `https://cdn.discordapp.com/avatars/${m.author.id}/${m.author.avatar}.png`;
        }

        const attachments = (m.attachments || []).map(a => a.url);

        return {
          id: m.id,
          sender: sender,
          author: author,
          avatar: avatar,
          text: text,
          attachments: attachments,
          timestamp: m.timestamp
        };
      });

      cachedMessages = formatted;
      lastMessageFetchTime = now;
      return formatted;
    }
  } catch (e) {
    console.error('Error fetching messages:', e.message);
  }
  return cachedMessages;
}

// Send Message directly to Discord Channel via REST API
async function sendDiscordMessage(author, text) {
  if (!botToken || !channelId) {
    throw new Error('Bot Token หรือ Channel ID ยังไม่ได้ตั้งค่า');
  }

  const content = `💬 **[${author}]**: ${text}`;
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bot ${botToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'DiscordWebBridge (https://vercel.app, 1.0.0)'
    },
    body: JSON.stringify({ content })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Discord API Error: ${errText}`);
  }

  return await res.json();
}

// API Routes
app.get('/api/status', async (req, res) => {
  const bot = await getBotUser();
  const channel = await getChannelInfo();

  if (bot && channel) {
    res.json({
      botStatus: {
        connected: true,
        username: bot.username,
        channelName: channel.name,
        channelId: channelId,
        error: null
      }
    });
  } else {
    res.json({
      botStatus: {
        connected: false,
        username: null,
        channelName: null,
        channelId: channelId,
        error: !botToken ? 'ยังไม่ได้ระบุ DISCORD_BOT_TOKEN' : 'ไม่สามารถเข้าถึงห้องใน Discord ได้'
      }
    });
  }
});

app.get('/api/messages', async (req, res) => {
  const bot = await getBotUser();
  const channel = await getChannelInfo();
  const messages = await fetchDiscordMessages();

  res.json({
    botStatus: {
      connected: !!(bot && channel),
      username: bot ? bot.username : null,
      channelName: channel ? channel.name : null,
      channelId: channelId
    },
    messages: messages
  });
});

app.post('/api/send', async (req, res) => {
  const text = (req.body.text || '').trim();
  const author = (req.body.author || 'เพื่อน').trim();

  if (!text) {
    return res.status(400).json({ success: false, error: 'ข้อความว่างเปล่า' });
  }

  try {
    const sentMsg = await sendDiscordMessage(author, text);
    // Invalidate message cache so it shows immediately
    lastMessageFetchTime = 0;

    const msgData = {
      id: sentMsg.id,
      sender: 'web',
      author: author,
      avatar: null,
      text: text,
      attachments: [],
      timestamp: sentMsg.timestamp || new Date().toISOString()
    };

    res.json({ success: true, msgData });
  } catch (err) {
    console.error('Send error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/index.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use(express.static(__dirname));

// Listen locally if not in Vercel Serverless
if (!process.env.VERCEL) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Chat Server ทำงานแล้วที่ http://localhost:${PORT}`);
  });
}

module.exports = app;
