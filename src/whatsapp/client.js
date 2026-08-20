import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { shouldBotRespond, setBotLid } from './triggerFilter.js';
import { messageBuffer } from './messageBuffer.js';
import { processSystemActions } from '../system/actionHandler.js';

let client = null;

/**
 * Obtiene la ruta del archivo de historial exclusivo para un chat/grupo específico
 */
export function getChatHistoryPath(chatId) {
  const safeId = (chatId || 'general').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.resolve(`./database/historial_${safeId}.txt`);
}

/**
 * Registra un mensaje entrante en el archivo físico exclusivo de ese chat
 */
export function appendToChatHistory(chatId, senderName, text, timestampMs) {
  try {
    const historyPath = getChatHistoryPath(chatId);
    const dbDir = path.resolve('./database');
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    const date = new Date(timestampMs || Date.now());
    const dateStr = date.toLocaleDateString('es-AR');
    const timeStr = date.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });

    let existingContent = '';
    if (fs.existsSync(historyPath)) {
      existingContent = fs.readFileSync(historyPath, 'utf8');
    }

    const header = `=== HISTORIAL DE CONVERSACIÓN DE ESTE CHAT (HOY ${dateStr}) ===\n`;
    if (!existingContent.startsWith('=== HISTORIAL DE CONVERSACIÓN')) {
      existingContent = header;
    }

    const newLine = `[${timeStr}] [${senderName}]: ${text}\n`;
    fs.writeFileSync(historyPath, existingContent + newLine, 'utf8');
  } catch (err) {
    console.error('⚠️ Error al registrar mensaje en el historial del chat:', err.message);
  }
}

/**
 * Cierre limpio de procesos al terminar
 */
function registerProcessCleanup() {
  const cleanup = async () => {
    if (client) {
      console.log('\n🛑 Cerrando cliente de WhatsApp...');
      try {
        await client.destroy();
      } catch (e) {}
    }
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

/**
 * Crea e inicializa una nueva instancia de WhatsApp Client
 */
function createClientInstance(onMessageHandler) {
  const newClient = new Client({
    authStrategy: new LocalAuth({
      clientId: 'gemini-whatsapp-bot',
      dataPath: './.wwebjs_auth'
    }),
    puppeteer: {
      executablePath: chromium.executablePath(),
      headless: true,
      protocolTimeout: 300000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--js-flags=--max-old-space-size=256',
        '--disable-extensions',
        '--disable-component-extensions-with-background-pages',
        '--disable-default-apps',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-breakpad',
        '--disable-component-update',
        '--disable-domain-reliability',
        '--disable-hang-monitor',
        '--disable-ipc-flooding-protection',
        '--disable-notifications',
        '--disable-popup-blocking',
        '--disable-print-preview',
        '--disable-speech-api',
        '--disable-sync',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-pings',
        '--password-store=basic'
      ]
    }
  });

  newClient.on('qr', (qr) => {
    console.log('\n======================================================');
    console.log('📱 ESCANEA ESTE CÓDIGO QR CON TU WHATSAPP PARA INICIAR:');
    console.log('======================================================\n');
    qrcode.generate(qr, { small: true });
    console.log('\n(Abre WhatsApp -> Dispositivos vinculados -> Vincular un dispositivo)\n');
  });

  newClient.on('ready', async () => {
    console.log('\n✅ [WHATSAPP LISTO]: Escuchando menciones (@bot) y respuestas a mensajes.\n');
    try {
      const botLid = await newClient.pupPage.evaluate(() => {
        return window.Store?.Conn?.lid?.user || 
               window.Store?.User?.getMaybeMeUser()?.user || 
               window.WWebJS?.getMeUser()?.user || '';
      });
      if (botLid) {
        setBotLid(botLid);
      }
    } catch (e) {}
  });

  newClient.on('authenticated', () => {
    console.log('🔑 Sesión de WhatsApp autenticada correctamente.');
  });

  newClient.on('auth_failure', (msg) => {
    console.error('❌ Error de autenticación en WhatsApp:', msg);
    console.log('🔄 Borrando caché de sesión para regenerar el código QR...');
    try {
      fs.rmSync('./.wwebjs_auth', { recursive: true, force: true });
    } catch (e) {}
  });

  // Registrar y mostrar en consola CADA mensaje de chat en tiempo real
  newClient.on('message_create', (message) => {
    try {
      if (message.isStatus || message.type === 'protocol') return;
      if (!message.body || !message.body.trim()) return;

      // Filtrar avisos de estado temporal del bot para no ensuciar el historial
      if (message.body.includes('¡Procesando consulta') || message.body.includes('Buscando información')) return;

      const senderName = message._data?.notifyName || message._data?.pushname || (message.fromMe ? 'Bot' : (message.author || message.from).split('@')[0]);
      const timeStr = new Date(message.timestamp * 1000).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });

      // Visualizar en la consola del bot cada mensaje en tiempo real
      console.log(`💬 [CHAT ${message.from.split('@')[0]}]: [${timeStr}] [${senderName}]: "${message.body.replace(/\n/g, ' | ')}"`);

      // Almacenar en el archivo de historial de ese chat
      appendToChatHistory(message.from, senderName, message.body.trim(), message.timestamp * 1000);
    } catch (e) {}
  });

  newClient.on('message', async (message) => {
    try {
      if (message.fromMe) return;
      if (message.isStatus || message.type === 'protocol') return;

      let chat = null;
      let contact = null;
      
      try { chat = await message.getChat(); } catch (e) {}
      try { contact = await message.getContact(); } catch (e) {}

      const senderName = contact ? (contact.pushname || contact.name || 'Usuario') : 'Usuario';

      const filterResult = await shouldBotRespond(message, newClient);

      if (!filterResult.shouldRespond) {
        return;
      }

      const chatId = message.from;

      // Obtener emisor JID y número telefónico real (evitando el ID del grupo)
      const senderJid = (contact && contact.id && contact.id._serialized) 
        ? contact.id._serialized 
        : (message.author || (message.from.endsWith('@g.us') ? (message._data?.author || message._data?.participant || '') : message.from));
        
      const senderNumber = (contact && contact.id && contact.id.user)
        ? contact.id.user
        : (senderJid ? senderJid.split('@')[0] : '');

      const effectiveText = (filterResult.cleanText && filterResult.cleanText.trim()) ? filterResult.cleanText.trim() : 'Hola';
      console.log(`🎯 [MENCIÓN/REPLY Detectada de ${senderName}]: "${effectiveText}"`);

      if (chat && typeof chat.sendStateTyping === 'function') {
        try { await chat.sendStateTyping(); } catch (e) {}
      }

      // Procesamiento con buffer para la IA
      messageBuffer.addMessage(chatId, effectiveText, senderName, async (bChatId, combinedMessage, bContactName) => {
        await onMessageHandler({
          chatId: bChatId,
          messageText: combinedMessage,
          contactName: bContactName,
          rawMessage: message,
          senderNumber: senderNumber,
          senderJid: senderJid,
          chat: chat,
          reply: async (result) => {
            if (chat && typeof chat.clearState === 'function') {
              try { await chat.clearState(); } catch (e) {}
            }

            try {
              let rawText = (typeof result === 'string') ? result : (result.text || '🤖 Mensaje procesado.');
              
              // Procesar acciones de sistema enviadas por Gemini Web en Node.js
              const actionProcessed = processSystemActions(rawText, { chatId: bChatId });
              let replyText = (typeof actionProcessed === 'object' && actionProcessed.text !== undefined) ? actionProcessed.text : actionProcessed;
              const stickerFile = (typeof actionProcessed === 'object') ? actionProcessed.stickerFile : null;
              
              // Limpiar bloques de comandos residuales
              replyText = replyText.replace(/^\[(COMANDO|COMMAND|ACTION|ACCION|SECCION|META|INTERNAL)[^\]]*\]\s*/gi, '');
              replyText = replyText.replace(/^```[a-z]*\n?\[(COMANDO|COMMAND|ACTION)[^\]]*\]\n?```\s*/gi, '');
              
              // Limpiar etiquetas/pills de archivos adjuntos (ej: TXT, TXT + 1, + 1) del DOM de Gemini
              replyText = replyText.replace(/\b(TXT|PDF|DOCX|DOC|CSV)\s*\+\s*\d+/gi, '');
              replyText = replyText.replace(/\b(TXT|PDF|DOCX|DOC|CSV)\b/gi, '');
              replyText = replyText.replace(/^\s*\+\s*\d+\s*$/gm, '');
              replyText = replyText.replace(/(\n\s*){3,}/g, '\n\n');
              replyText = replyText.trim();

              // Extraer JIDs de todas las menciones en formato @numero para el resaltado azul
              const mentions = [senderJid];
              const matches = replyText.match(/@\d+/g);
              if (matches) {
                for (const match of matches) {
                  const num = match.replace('@', '');
                  const jid = `${num}@c.us`;
                  if (!mentions.includes(jid)) {
                    mentions.push(jid);
                  }
                }
              }

              // Si Gemini generó una imagen
              if (result && result.imageBuffer) {
                const base64Data = result.imageBuffer.toString('base64');
                const media = new MessageMedia(
                  result.imageMime || 'image/png',
                  base64Data,
                  'gemini_imagen.png'
                );

                // Responder citando directamente el mensaje invocador vía reply nativo
                try {
                  await message.reply(media, undefined, { caption: replyText, mentions });
                } catch (err) {
                  await newClient.sendMessage(bChatId, media, {
                    caption: replyText,
                    quotedMessageId: message.id._serialized,
                    mentions: mentions
                  });
                }
                console.log(`📤 [Foto + Texto citado enviado a ${bContactName}]`);
              } else if (replyText) {
                // Responder citando directamente el mensaje invocador vía reply nativo
                try {
                  await message.reply(replyText, undefined, { mentions });
                } catch (err) {
                  await newClient.sendMessage(bChatId, replyText, {
                    quotedMessageId: message.id._serialized,
                    mentions: mentions
                  });
                }
                console.log(`📤 [Respuesta citada enviada a ${bContactName}]:\n${replyText}\n`);
              }

              // Registrar en el historial para que Gemini vea sus propias respuestas previas
              if (replyText) {
                appendToChatHistory(bChatId, 'Bot', replyText, Date.now());
              }

              // Si se solicitó un sticker en la acción
              if (stickerFile && fs.existsSync(stickerFile)) {
                try {
                  const stickerMedia = MessageMedia.fromFilePath(stickerFile);
                  await newClient.sendMessage(bChatId, stickerMedia, { sendMediaAsSticker: true });
                  console.log(`📤 [Sticker enviado al chat: ${path.basename(stickerFile)}]`);
                } catch (stkErr) {
                  console.warn('⚠️ Error al enviar el sticker:', stkErr.message);
                }
              }
            } catch (replyErr) {
              console.error('❌ Error al enviar la respuesta por WhatsApp:', replyErr.message);
              try {
                const fallbackText = (typeof result === 'string') ? result : (result.text || '');
                if (fallbackText) {
                  await newClient.sendMessage(bChatId, fallbackText);
                }
              } catch (e) {}
            }
          }
        });
      });

    } catch (err) {
      console.error('❌ Error en el manejador de mensajes de WhatsApp:', err.message);
    }
  });

  return newClient;
}

/**
 * Inicializa el cliente de WhatsApp Web
 * @param {Function} onMessageHandler Callback cuando se recibe un mensaje válido
 */
export async function initWhatsAppClient(onMessageHandler) {
  console.log('🔄 Inicializando cliente de WhatsApp Web...');

  registerProcessCleanup();

  client = createClientInstance(onMessageHandler);

  try {
    await client.initialize();
  } catch (err) {
    console.error('⚠️ [WhatsApp Init Error]:', err.message);
    
    try {
      await client.destroy();
    } catch (e) {}

    console.log('🔄 Reintentando arranque de WhatsApp Web con instancia limpia en 3 segundos...');
    await new Promise(r => setTimeout(r, 3000));
    
    client = createClientInstance(onMessageHandler);
    try {
      await client.initialize();
    } catch (retryErr) {
      console.error('❌ Reintento fallido de WhatsApp Web:', retryErr.message);
    }
  }

  return client;
}
