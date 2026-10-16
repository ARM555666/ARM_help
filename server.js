const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, GatewayIntentBits, Partials, Events } = require('discord.js');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;
let botToken = process.env.DISCORD_BOT_TOKEN || '';
let channelId = process.env.DISCORD_CHANNEL_ID || '';

// In-memory chat history (last 50 messages)
const messageHistory = [];
const MAX_HISTORY = 50;

function addToHistory(msg) {
  messageHistory.push(msg);
  if (messageHistory.length > MAX_HISTORY) {
    messageHistory.shift();
  }
}

// Serve static frontend files
app.use(express.static(__dirname));
app.use(express.json());

// Explicit root route for Vercel Serverless
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/index.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Discord Bot Client
let discordClient = null;
let botStatus = {
  connected: false,
  username: null,
  channelName: null,
  channelId: channelId,
  error: null
};

function initDiscordClient() {
  if (!botToken) {
    botStatus = {
      connected: false,
      username: null,
      channelName: null,
      channelId: channelId,
      error: 'ยังไม่ได้ระบุ Discord Bot Token (กรุณาตั้งค่าใน .env หรือปุ่มการตั้งค่า)'
    };
    io.emit('bot_status', botStatus);
    return;
  }

  if (discordClient) {
    try {
      discordClient.destroy();
    } catch (e) {
      console.error('Error destroying previous discord client:', e);
    }
  }

  discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel, Partials.Message]
  });

  discordClient.once(Events.ClientReady, async (c) => {
    console.log(`[Discord Bot] เข้าสู่ระบบสำเร็จในชื่อ: ${c.user.tag}`);
    botStatus.connected = true;
    botStatus.username = c.user.tag;
    botStatus.error = null;

    if (channelId) {
      try {
        const ch = await c.channels.fetch(channelId);
        botStatus.channelName = ch ? ch.name : 'Unknown Channel';
        console.log(`[Discord Bot] เชื่อมต่อกับห้อง: #${botStatus.channelName} (${channelId})`);
      } catch (err) {
        botStatus.channelName = null;
        botStatus.error = `หาห้อง ID ${channelId} ไม่เจอ หรือบอทไม่มีสิทธิ์เข้าถึง`;
        console.error(`[Discord Bot] ข้อผิดพลาดในการค้นหา Channel:`, err.message);
      }
    } else {
      botStatus.error = 'ยังไม่ได้ระบุ DISCORD_CHANNEL_ID';
    }

    io.emit('bot_status', botStatus);
  });

  // Listen to messages from Discord
  discordClient.on(Events.MessageCreate, async (message) => {
    // Ignore messages from this bot or other bots
    if (message.author.bot) return;

    // Check if the message is from our configured channel
    if (channelId && message.channelId !== channelId) return;

    const attachments = message.attachments.map(att => att.url);
    const msgData = {
      id: message.id,
      sender: 'discord',
      author: message.member?.displayName || message.author.displayName || message.author.username,
      avatar: message.author.displayAvatarURL({ dynamic: true }),
      text: message.content || '',
      attachments: attachments,
      timestamp: message.createdAt.toISOString()
    };

    console.log(`[Discord -> Web] ${msgData.author}: ${msgData.text}`);
    addToHistory(msgData);
    io.emit('chat_message', msgData);
  });

  discordClient.login(botToken).catch((err) => {
    console.error('[Discord Bot] เข้าสู่ระบบล้มเหลว:', err.message);
    botStatus = {
      connected: false,
      username: null,
      channelName: null,
      channelId: channelId,
      error: `เข้าสู่ระบบล้มเหลว: ${err.message}`
    };
    io.emit('bot_status', botStatus);
  });
}

// REST APIs for Messages (Vercel serverless compatible fallback)
app.get('/api/messages', (req, res) => {
  res.json({
    messages: messageHistory,
    botStatus
  });
});

app.post('/api/send', async (req, res) => {
  const text = (req.body.text || '').trim();
  const author = (req.body.author || 'เพื่อนจากเว็บ (Web User)').trim();

  if (!text) {
    return res.status(400).json({ success: false, error: 'ข้อความว่างเปล่า' });
  }

  const msgData = {
    id: 'web_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
    sender: 'web',
    author: author,
    avatar: null,
    text: text,
    attachments: [],
    timestamp: new Date().toISOString()
  };

  addToHistory(msgData);
  io.emit('chat_message', msgData);

  let discordSent = false;
  let discordError = null;

  if (discordClient && discordClient.isReady() && channelId) {
    try {
      const channel = await discordClient.channels.fetch(channelId);
      if (channel && channel.isTextBased()) {
        await channel.send({ content: `💬 **[${author}]**: ${text}` });
        discordSent = true;
      }
    } catch (err) {
      discordError = err.message;
    }
  }

  res.json({ success: true, discordSent, discordError, msgData });
});

// REST APIs for Status and Settings
app.get('/api/status', (req, res) => {
  res.json({
    botStatus,
    activeSockets: io.engine.clientsCount
  });
});

app.post('/api/config', async (req, res) => {
  const { token, channel } = req.body;
  if (token !== undefined) botToken = token.trim();
  if (channel !== undefined) channelId = channel.trim();

  // Save to .env
  const envContent = `PORT=${PORT}\nDISCORD_BOT_TOKEN=${botToken}\nDISCORD_CHANNEL_ID=${channelId}\n`;
  fs.writeFileSync(path.join(__dirname, '.env'), envContent, 'utf8');

  initDiscordClient();

  res.json({
    success: true,
    message: 'บันทึกการตั้งค่าเรียบร้อยแล้ว กำลังเชื่อมต่อบอทใหม่...',
    botStatus
  });
});

// Socket.IO handling
io.on('connection', (socket) => {
  console.log(`[Web Socket] ผู้ใช้เชื่อมต่อ: ${socket.id}`);

  // Send initial data to client
  socket.emit('bot_status', botStatus);
  socket.emit('history', messageHistory);

  // Send message from Web to Discord
  socket.on('send_message', async (data, callback) => {
    const text = (data.text || '').trim();
    const author = (data.author || 'เพื่อนจากเว็บ (Web User)').trim();

    if (!text) {
      if (callback) callback({ success: false, error: 'ข้อความว่างเปล่า' });
      return;
    }

    const msgData = {
      id: 'web_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
      sender: 'web',
      author: author,
      avatar: null,
      text: text,
      attachments: [],
      timestamp: new Date().toISOString()
    };

    addToHistory(msgData);
    // Broadcast to all web clients
    io.emit('chat_message', msgData);

    // Forward to Discord
    let discordSent = false;
    let discordError = null;

    if (discordClient && discordClient.isReady() && channelId) {
      try {
        const channel = await discordClient.channels.fetch(channelId);
        if (channel && channel.isTextBased()) {
          // Send format in Discord
          await channel.send({
            content: `💬 **[${author}]**: ${text}`
          });
          discordSent = true;
          console.log(`[Web -> Discord] ${author}: ${text}`);
        } else {
          discordError = 'ห้องใน Discord ไม่ใช่ Text Channel';
        }
      } catch (err) {
        discordError = err.message;
        console.error('[Web -> Discord] ข้อผิดพลาดในการส่งไปยัง Discord:', err.message);
      }
    } else {
      discordError = 'Discord Bot ยังไม่ได้เชื่อมต่อ หรือไม่ได้ใส่ Channel ID';
    }

    if (callback) {
      callback({
        success: true,
        discordSent,
        discordError
      });
    }
  });

  socket.on('disconnect', () => {
    console.log(`[Web Socket] ผู้ใช้ตัดการเชื่อมต่อ: ${socket.id}`);
  });
});

// Start Discord client
initDiscordClient();

// Start HTTP server
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`=================================================`);
    console.log(`🚀 Chat Server ทำงานแล้วที่ http://localhost:${PORT}`);
    console.log(`🌐 สามารถเปิดใช้งานได้จากเบราว์เซอร์`);
    console.log(`=================================================`);
  });
}

module.exports = app;
