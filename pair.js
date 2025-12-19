
  const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    jidNormalizedUser,
    Browsers,
    DisconnectReason,
    jidDecode,
    generateForwardMessageContent,
    generateWAMessageFromContent,
    downloadContentFromMessage,
    getContentType,
    makeInMemoryStore
} = require('@whiskeysockets/baileys');

const config = require('./config');
const events = require('./command');
const { sms } = require('./lib/msg');
const { connectdb } = require('./lib/database');
const { groupEvents } = require('./lib/group-config');
const { handleAntidelete } = require('./lib/antidelete');

const express = require('express');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const crypto = require('crypto');
const FileType = require('file-type');

const axios = require('axios');
const { fromBuffer } = require('file-type');
const bodyparser = require('body-parser');
const os = require('os');

const router = express.Router();

// ==============================================================================
// 1. INITIALIZATION & DATABASE
// ==============================================================================

connectdb();

// Initialize Memory Store (Required for Antidelete)
const store = makeInMemoryStore({ 
    logger: pino().child({ level: 'silent', stream: 'store' }) 
});

const createSerial = (size) => {
    return crypto.randomBytes(size).toString('hex').slice(0, size);
}

// Helper to get Group Admins
const getGroupAdmins = (participants) => {
    let admins = [];
    for (let i of participants) {
        if (i.admin == null) continue;
        admins.push(i.id);
    }
    return admins;
}

// Load Plugins
const pluginsDir = path.join(__dirname, 'plugins');
if (!fs.existsSync(pluginsDir)) {
    fs.mkdirSync(pluginsDir);
}

const files = fs.readdirSync(pluginsDir).filter(file => file.endsWith('.js'));
console.log(`📦 Loading plugins...`);
for (const file of files) {
    try {
        require(path.join(pluginsDir, file));
    } catch (e) {
        console.error(`❌ Failed to load plugin ${file}:`, e);
    }
}

// ==============================================================================
// 2. WEB ROUTES
// ==============================================================================

router.get('/', (req, res) => res.sendFile(path.join(__dirname, 'pair.html')));

router.get('/code', async (req, res) => {
    const number = req.query.number;
    if (!number) return res.json({ error: 'Number required' });
    await startBot(number, res);
});

// ==============================================================================
// 3. BOT LOGIC (BAILEYS)
// ==============================================================================

const activeSockets = new Map();

async function startBot(number, res = null) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const sessionDir = path.join(__dirname, 'session', `session_${sanitizedNumber}`);
        
        if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

        const conn = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
            },
            printQRInTerminal: false,
            usePairingCode: true,
            logger: pino({ level: 'silent' }),
            browser: ["Ubuntu", "Chrome", "20.0.04"],
            syncFullHistory: false,
            getMessage: async (key) => {
                if (store) {
                    const msg = await store.loadMessage(key.remoteJid, key.id);
                    return msg?.message || undefined;
                }
                return { conversation: 'Hello' };
            }
        });

        activeSockets.set(sanitizedNumber, conn);
        store.bind(conn.ev); // Bind Store to Socket

        // --- UTILS ATTACHED TO CONN ---
        conn.decodeJid = jid => {
            if (!jid) return jid;
            if (/:\d+@/gi.test(jid)) {
                let decode = jidDecode(jid) || {};
                return (decode.user && decode.server && decode.user + '@' + decode.server) || jid;
            } else return jid;
        };

        conn.downloadAndSaveMediaMessage = async(message, filename, attachExtension = true) => {
            let quoted = message.msg ? message.msg : message;
            let mime = (message.msg || message).mimetype || '';
            let messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0];
            const stream = await downloadContentFromMessage(quoted, messageType);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk]);
            }
            let type = await FileType.fromBuffer(buffer);
            let trueFileName = attachExtension ? (filename + '.' + type.ext) : filename;
            await fs.writeFileSync(trueFileName, buffer);
            return trueFileName;
        };

        // --- PAIRING CODE GENERATION ---
        if (!conn.authState.creds.registered) {
            setTimeout(async () => {
                try {
                    await delay(1500);
                    const code = await conn.requestPairingCode(sanitizedNumber);
                    console.log(`🔑 Pairing Code: ${code}`);
                    if (res && !res.headersSent) res.json({ code: code });
                } catch (err) {
                    console.error('❌ Pairing Error:', err.message);
                    if (res && !res.headersSent) res.json({ error: 'Failed to generate code.' });
                }
            }, 3000);
        } else {
            if (res && !res.headersSent) res.json({ status: 'already_connected' });
        }

        conn.ev.on('creds.update', saveCreds);

        // --- CONNECTION UPDATE & AUTO-RECONNECT ---
        conn.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === 'open') {
                console.log(`✅ Connected: ${sanitizedNumber}`);
                const userJid = jidNormalizedUser(conn.user.id);
                const connectText = `🕷️ *𝐒𝐇𝐀𝐃𝐎𝐖 𝐁𝐎𝐓 𝐂𝐎𝐍𝐍𝐄𝐂𝐓𝐄𝐃*\n\n✅ *Status:* Online\n🕹️ *Mode:* ${config.WORK_TYPE}\n🔣 *Prefix:* ${config.PREFIX}\n\n> ${config.BOT_FOOTER}`;
                
                // Send startup message to owner (Simple)
                await conn.sendMessage(userJid, {
                    image: { url: config.IMAGE_PATH },
                    caption: connectText
                });
            }

            if (connection === 'close') {
                let reason = lastDisconnect?.error?.output?.statusCode;
                if (reason === DisconnectReason.loggedOut) {
                    console.log(`❌ Session closed: Logged Out.`);
                    activeSockets.delete(sanitizedNumber);
                } else {
                    console.log(`⚠️ Connection lost (${reason}). Auto-reconnecting...`);
                    activeSockets.delete(sanitizedNumber);
                    await delay(5000);
                    startBot(sanitizedNumber);
                }
            }
        })
        
    } catch (err) {
        console.error(err);
        if (res && !res.headersSent) res.json({ error: 'Internal Server Error' });
    }
}

module.exports = router;
