import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import { GoogleGenAI } from '@google/genai';

import { connectDB, isMongoConnected } from './db.js';
import { Settings } from './models/Settings.js';
import { Message } from './models/Message.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Directories & Fallback Files
const CHATS_DIR = path.join(__dirname, 'chats');
const SYSTEM_PROMPT_FILE = path.join(__dirname, 'system_prompt.txt');
const ALLOWED_NUMBERS_FILE = path.join(__dirname, 'allowed_numbers.txt');

if (!fs.existsSync(CHATS_DIR)) {
    fs.mkdirSync(CHATS_DIR, { recursive: true });
}
if (!fs.existsSync(SYSTEM_PROMPT_FILE)) {
    fs.writeFileSync(SYSTEM_PROMPT_FILE, "You are a helpful and polite virtual assistant for WhatsApp.", 'utf8');
}
if (!fs.existsSync(ALLOWED_NUMBERS_FILE)) {
    fs.writeFileSync(ALLOWED_NUMBERS_FILE, "", 'utf8');
}

// In-memory Cached Settings
let cachedSystemPrompt = fs.readFileSync(SYSTEM_PROMPT_FILE, 'utf8');
let cachedAllowedNumbers = fs.readFileSync(ALLOWED_NUMBERS_FILE, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

// App & Client State
let isReady = false;
let latestQrDataUrl = null;
let clientInfo = null;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const PORT = process.env.PORT || 3000;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// Initialize Gemini SDK
const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
});

// Sync with MongoDB
async function syncDatabase() {
    if (!isMongoConnected()) return;
    try {
        let config = await Settings.findOne({ key: 'global_config' });
        if (!config) {
            config = await Settings.create({
                key: 'global_config',
                systemPrompt: cachedSystemPrompt,
                allowedNumbers: cachedAllowedNumbers
            });
            console.log('✅ MongoDB Settings collection initialized.');
        } else {
            cachedSystemPrompt = config.systemPrompt || cachedSystemPrompt;
            cachedAllowedNumbers = config.allowedNumbers || cachedAllowedNumbers;
            // Also sync to local files as offline backup
            fs.writeFileSync(SYSTEM_PROMPT_FILE, cachedSystemPrompt, 'utf8');
            fs.writeFileSync(ALLOWED_NUMBERS_FILE, cachedAllowedNumbers.join('\n'), 'utf8');
            console.log('✅ Synchronized settings with MongoDB Atlas.');
        }
    } catch (err) {
        console.error('⚠️  Failed to sync MongoDB settings:', err.message);
    }
}

// Helper: Check if sender is allowed
function isAllowedUser(phoneNumber) {
    if (!phoneNumber) return false;
    return cachedAllowedNumbers.some(allowedNum => phoneNumber.endsWith(allowedNum));
}

// Helper: Get recent chat history
async function getLastMessages(phoneNumber, limit = 15) {
    if (isMongoConnected()) {
        try {
            const docs = await Message.find({ phoneNumber })
                .sort({ timestamp: -1 })
                .limit(limit)
                .lean();
            return docs.reverse().map(d => {
                const timeStr = new Date(d.timestamp).toISOString().replace('T', ' ').slice(0, 16);
                return `[${timeStr}] ${d.role}: ${d.message}`;
            });
        } catch (e) {
            console.error('Error fetching chat history from MongoDB:', e.message);
        }
    }

    // Fallback: Read local text file
    const filePath = path.join(CHATS_DIR, `${phoneNumber}.txt`);
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n').filter(line => line.trim() !== '');
    return lines.slice(-limit);
}

// Helper: Record message
async function recordMessage(phoneNumber, role, messageText) {
    const cleanMessage = messageText.replace(/\n/g, ' ');

    if (isMongoConnected()) {
        try {
            await Message.create({
                phoneNumber,
                role,
                message: cleanMessage,
                timestamp: new Date()
            });
        } catch (e) {
            console.error('Failed to log message to MongoDB:', e.message);
        }
    }

    // Fallback/mirror local file
    try {
        const filePath = path.join(CHATS_DIR, `${phoneNumber}.txt`);
        const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
        fs.appendFileSync(filePath, `[${timestamp}] ${role}: ${cleanMessage}\n`, 'utf8');
    } catch (e) {
        // ignore
    }
}

// WhatsApp Client Configuration
const puppeteerArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--disable-gpu',
    '--single-process', // Drastically reduces RAM footprint on 512MB hosts
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding'
];

const clientOptions = {
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: puppeteerArgs
    }
};

if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    clientOptions.puppeteer.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
}

const client = new Client(clientOptions);

// WhatsApp Events
client.on('qr', async (qr) => {
    isReady = false;
    try {
        latestQrDataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 8 });
    } catch (err) {
        console.error('Failed to render QR data URL:', err);
    }
    console.log('====================================================');
    console.log('Scan this QR code in WhatsApp or via Admin Dashboard:');
    qrcodeTerminal.generate(qr, { small: true });
    console.log('====================================================');
});

client.on('ready', () => {
    isReady = true;
    latestQrDataUrl = null;
    clientInfo = client.info;
    console.log('✅ WhatsApp Client is ready and connected!');
    if (client.info) {
        console.log(`📱 Logged in as: ${client.info.pushname || 'User'} (${client.info.wid.user})`);
    }

    // Presence keep-alive
    setInterval(async () => {
        try {
            await client.sendPresenceAvailable();
        } catch (err) {}
    }, 5 * 60 * 1000);
});

client.on('disconnected', (reason) => {
    console.log('❌ WhatsApp was disconnected:', reason);
    isReady = false;
    latestQrDataUrl = null;
});

// Incoming Message Handler
client.on('message', async (msg) => {
    if (msg.isStatus || (await msg.getChat()).isGroup || msg.fromMe) return;

    // Contact resolution
    const contact = await msg.getContact();
    let phoneNumber = msg.from.replace('@c.us', '').replace('@lid', '');

    if (contact && contact.id && contact.id.user) {
        phoneNumber = contact.id.user;
    } else if (contact && contact.number) {
        phoneNumber = contact.number;
    }

    // Allowed number filter
    if (!isAllowedUser(phoneNumber)) {
        console.log(`🔒 Ignored message from ${phoneNumber} (Not in allowed list)`);
        return;
    }

    const userMessage = msg.body;
    console.log(`\n📩 Received message from ${phoneNumber}: ${userMessage}`);

    // 1. Get Conversation History
    const history = await getLastMessages(phoneNumber, 15);

    // 2. Log incoming message
    await recordMessage(phoneNumber, 'USER', userMessage);

    // 3. Build prompt for Gemini
    let fullPrompt = "";
    if (history.length > 0) {
        fullPrompt += `--- CONTEXT (Last ${history.length} messages) ---\n`;
        fullPrompt += history.join('\n') + `\n-----------------------------------\n\n`;
    }
    fullPrompt += `USER: ${userMessage}\nAI:`;

    try {
        const chat = await msg.getChat();

        // Simulate human reading/thinking time based on incoming length
        const wordCount = userMessage.split(/\s+/).length;
        const readingDelayMs = Math.max(1500, wordCount * 300);
        console.log(`🤔 Reading for ${Math.round(readingDelayMs / 1000)}s...`);
        await new Promise(r => setTimeout(r, readingDelayMs));

        // Display typing state in WhatsApp
        await chat.sendStateTyping();

        // Call Gemini
        const response = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: fullPrompt,
            config: {
                systemInstruction: cachedSystemPrompt,
                temperature: 0.9,
                maxOutputTokens: 60,
            }
        });
        const aiResponse = response.text ? response.text.trim() : '';

        // Simulate typing delay
        const responseWordCount = aiResponse.split(/\s+/).length;
        const typingDelayMs = Math.max(2000, responseWordCount * 500);
        console.log(`⏳ Typing for ${Math.round(typingDelayMs / 1000)}s (${responseWordCount} words)...`);
        await new Promise(r => setTimeout(r, typingDelayMs));

        // Clear typing status and dispatch reply
        await chat.clearState();
        await client.sendMessage(msg.from, aiResponse);
        console.log(`🤖 Replied to ${phoneNumber}: ${aiResponse}`);

        // 4. Log AI response
        await recordMessage(phoneNumber, 'AI', aiResponse);

    } catch (error) {
        console.error('❌ Error handling AI response:', error.message || error);
        try {
            const chat = await msg.getChat();
            await chat.clearState();
        } catch (e) {}
    }
});

// Express Admin Server
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve Admin Dashboard for root and common aliases
app.get(['/', '/admin', '/login', '/dashboard'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Simple Auth Middleware
function authMiddleware(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = authHeader.replace('Bearer ', '').trim();
    if (token !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Invalid admin credentials' });
    }
    next();
}

// 24/7 Keep-Alive Ping Endpoint (for UptimeRobot / cron-job.org)
app.get('/ping', (req, res) => {
    res.status(200).send('OK - Bot Alive');
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptimeSeconds: Math.floor(process.uptime()),
        isWhatsAppReady: isReady,
        isMongoConnected: isMongoConnected(),
        memoryUsageMb: Math.round(process.memoryUsage().rss / 1024 / 1024)
    });
});

// Admin Login
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        return res.json({ success: true, token: ADMIN_PASSWORD });
    }
    return res.status(401).json({ success: false, message: 'Invalid password' });
});

// Status & QR API
app.get('/api/status', authMiddleware, (req, res) => {
    res.json({
        isReady,
        qrCode: latestQrDataUrl,
        phoneNumber: clientInfo?.wid?.user || null,
        pushname: clientInfo?.pushname || null,
        isMongoConnected: isMongoConnected(),
    });
});

// System Prompt API
app.get('/api/prompt', authMiddleware, (req, res) => {
    res.json({ prompt: cachedSystemPrompt });
});

app.post('/api/prompt', authMiddleware, async (req, res) => {
    const { prompt } = req.body;
    if (typeof prompt !== 'string') {
        return res.status(400).json({ error: 'Invalid prompt' });
    }
    cachedSystemPrompt = prompt;
    fs.writeFileSync(SYSTEM_PROMPT_FILE, prompt, 'utf8');

    if (isMongoConnected()) {
        try {
            await Settings.findOneAndUpdate(
                { key: 'global_config' },
                { systemPrompt: prompt, updatedAt: new Date() },
                { upsert: true }
            );
        } catch (err) {
            console.error('Failed to update prompt in MongoDB:', err);
        }
    }
    res.json({ success: true, message: 'System prompt updated' });
});

// Allowed Numbers API
app.get('/api/allowed-numbers', authMiddleware, (req, res) => {
    res.json({ numbers: cachedAllowedNumbers });
});

app.post('/api/allowed-numbers', authMiddleware, async (req, res) => {
    const { number } = req.body;
    const cleanNum = (number || '').trim().replace(/[^0-9]/g, '');
    if (!cleanNum) return res.status(400).json({ error: 'Invalid number' });

    if (!cachedAllowedNumbers.includes(cleanNum)) {
        cachedAllowedNumbers.push(cleanNum);
        fs.writeFileSync(ALLOWED_NUMBERS_FILE, cachedAllowedNumbers.join('\n'), 'utf8');

        if (isMongoConnected()) {
            try {
                await Settings.findOneAndUpdate(
                    { key: 'global_config' },
                    { allowedNumbers: cachedAllowedNumbers, updatedAt: new Date() },
                    { upsert: true }
                );
            } catch (err) {
                console.error('Failed to save number to MongoDB:', err);
            }
        }
    }
    res.json({ success: true, numbers: cachedAllowedNumbers });
});

app.delete('/api/allowed-numbers/:number', authMiddleware, async (req, res) => {
    const target = req.params.number;
    cachedAllowedNumbers = cachedAllowedNumbers.filter(n => n !== target);
    fs.writeFileSync(ALLOWED_NUMBERS_FILE, cachedAllowedNumbers.join('\n'), 'utf8');

    if (isMongoConnected()) {
        try {
            await Settings.findOneAndUpdate(
                { key: 'global_config' },
                { allowedNumbers: cachedAllowedNumbers, updatedAt: new Date() },
                { upsert: true }
            );
        } catch (err) {
            console.error('Failed to remove number in MongoDB:', err);
        }
    }
    res.json({ success: true, numbers: cachedAllowedNumbers });
});

// Chat History API
app.get('/api/chats/contacts', authMiddleware, async (req, res) => {
    let contacts = [];
    if (isMongoConnected()) {
        try {
            contacts = await Message.distinct('phoneNumber');
        } catch (e) {
            console.error('Failed to query distinct contacts from MongoDB:', e);
        }
    }
    // Also include any local chat files
    if (fs.existsSync(CHATS_DIR)) {
        const files = fs.readdirSync(CHATS_DIR)
            .filter(f => f.endsWith('.txt'))
            .map(f => f.replace('.txt', ''));
        contacts = Array.from(new Set([...contacts, ...files]));
    }
    res.json({ contacts });
});

app.get('/api/chats/:number', authMiddleware, async (req, res) => {
    const { number } = req.params;
    let messages = [];

    if (isMongoConnected()) {
        try {
            const docs = await Message.find({ phoneNumber: number }).sort({ timestamp: 1 }).limit(100).lean();
            messages = docs.map(d => ({
                role: d.role,
                message: d.message,
                timestamp: d.timestamp
            }));
        } catch (e) {
            console.error('Failed to query messages from MongoDB:', e);
        }
    }

    if (messages.length === 0) {
        // Fallback local file
        const filePath = path.join(CHATS_DIR, `${number}.txt`);
        if (fs.existsSync(filePath)) {
            const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
            messages = lines.map(line => {
                const match = line.match(/^\[(.*?)\] (USER|AI): (.*)$/);
                if (match) {
                    return {
                        timestamp: match[1],
                        role: match[2],
                        message: match[3]
                    };
                }
                return { timestamp: '', role: 'USER', message: line };
            });
        }
    }
    res.json({ messages });
});

// Restart Session API
app.post('/api/restart', authMiddleware, async (req, res) => {
    try {
        isReady = false;
        latestQrDataUrl = null;
        await client.destroy();
        setTimeout(() => {
            client.initialize();
        }, 3000);
        res.json({ success: true, message: 'WhatsApp client restarting...' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Server Initialization
async function startServer() {
    // 1. Connect MongoDB
    await connectDB(process.env.MONGODB_URI);
    await syncDatabase();

    // 2. Start Web Server
    app.listen(PORT, () => {
        console.log(`\n🌐 Admin Dashboard running at: http://localhost:${PORT}`);
        console.log(`🔑 Admin Password: ${ADMIN_PASSWORD}`);
        console.log(`⏱️  Keep-alive endpoint available at: http://localhost:${PORT}/ping\n`);
    });

    // 3. Initialize WhatsApp Client
    client.initialize().catch(err => {
        console.error('\n❌ Failed to initialize WhatsApp client:', err.message);
    });
}

startServer();

// Graceful Shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down gracefully...');
    try {
        await client.destroy();
    } catch (e) {}
    process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});
