import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { initWhatsAppClient, getChatHistoryPath } from './whatsapp/client.js';
import { initGeminiScraper, queryGeminiWeb } from './gemini/webScraper.js';
import { initGrokScraper, queryGrokWeb } from './grok/webScraper.js';

import http from 'http';

const aiProvider = (process.env.AI_PROVIDER || 'gemini').toLowerCase();
const port = process.env.PORT || 3000;

// Servidor HTTP nativo liviano para que Render detecte la aplicación activa
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`🤖 Bot de WhatsApp + ${aiProvider.toUpperCase()} activo y respondiendo.`);
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.warn(`⚠️ Puerto ${port} en uso, el bot continuará su ejecución de todos modos.`);
  } else {
    console.warn('⚠️ Error en servidor HTTP:', err.message);
  }
}).listen(port, () => {
  console.log(`🌐 Servidor HTTP activo en puerto ${port} (Render Ready).`);
});

console.log(`
=====================================================================
  🤖 WHATSAPP + ${aiProvider.toUpperCase()} BOT (0 APIs - SCRAPING & FI UNJU ASSISTANT) 🤖
=====================================================================
`);

// 1. Inicializar el motor de IA seleccionado (Gemini o Grok)
if (aiProvider === 'grok') {
  await initGrokScraper();
} else {
  await initGeminiScraper();
}

// Breve pausa para asegurar estabilidad entre instancias de navegador (Playwright y Puppeteer)
console.log('⏳ Estabilizando componentes de navegador...');
await new Promise(resolve => setTimeout(resolve, 4000));

// 2. Inicializar Cliente de WhatsApp
await initWhatsAppClient(async ({ chatId, messageText, contactName, reply, senderNumber, chat }) => {
  console.log(`⚡ [Procesando con ${aiProvider.toUpperCase()} para ${contactName} en chat ${chatId}]: "${messageText.replace(/\n/g, ' | ')}"`);

  // Crear el tag del usuario usando su número de teléfono real recibido
  const userTag = senderNumber ? `@${senderNumber}` : `@${contactName}`;

  // Obtener la ruta del archivo de historial exclusivo para este chat especifico
  const specificChatHistoryPath = getChatHistoryPath(chatId);
  const mainChatHistoryPath = path.resolve('./database/historial_chat.txt');

  if (chat && typeof chat.fetchMessages === 'function') {
    try {
      const messages = await chat.fetchMessages({ limit: 50 });
      if (messages && messages.length > 0) {
        const startOfTodaySec = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
        let selectedMsgs = messages.filter(m => m.timestamp >= startOfTodaySec && m.body && m.body.trim());
        if (selectedMsgs.length < 10) {
          selectedMsgs = messages.filter(m => m.body && m.body.trim()).slice(-15);
        }

        const formattedFetched = selectedMsgs.map(m => {
          const timeStr = new Date(m.timestamp * 1000).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
          const name = m.fromMe ? 'Bot' : (m._data?.notifyName || m._data?.pushname || m.sender?.name || (m.author || m.from).split('@')[0]);
          return `[${timeStr}] [${name}]: ${m.body.trim()}`;
        });

        let existingLines = [];
        if (fs.existsSync(specificChatHistoryPath)) {
          const currentText = fs.readFileSync(specificChatHistoryPath, 'utf8');
          existingLines = currentText.split('\n').filter(l => l.startsWith('['));
        }

        const header = `=== HISTORIAL DE CONVERSACIÓN DE ESTE CHAT (HOY ${new Date().toLocaleDateString('es-AR')}) ===\n`;
        const combinedLines = Array.from(new Set([...formattedFetched, ...existingLines]));
        fs.writeFileSync(specificChatHistoryPath, header + combinedLines.join('\n') + '\n', 'utf8');
      }
    } catch (e) {
      console.warn('⚠️ Sincronización finalizada con historial local del chat.');
    }
  }

  // Copiar el historial exclusivo de este chat al archivo que enviamos físicamente a la IA
  if (fs.existsSync(specificChatHistoryPath)) {
    fs.copyFileSync(specificChatHistoryPath, mainChatHistoryPath);
  }

  // Definir la lista de los 3 archivos principales
  const filesToUpload = [];
  
  const promptFile = path.resolve('./database/instrucciones_sistema.txt');
  if (fs.existsSync(promptFile)) {
    filesToUpload.push(promptFile);
  }

  const dbFile = path.resolve('./database/base_datos_completa.txt');
  if (fs.existsSync(dbFile)) {
    filesToUpload.push(dbFile);
  }

  if (fs.existsSync(mainChatHistoryPath)) {
    filesToUpload.push(mainChatHistoryPath);
  }

  // Consultar la IA seleccionada
  let result;
  if (aiProvider === 'grok') {
    result = await queryGrokWeb(messageText, {
      chatId: chatId,
      userName: contactName,
      userTag: userTag,
      files: filesToUpload
    });
  } else {
    result = await queryGeminiWeb(messageText, {
      chatId: chatId,
      userName: contactName,
      userTag: userTag,
      files: filesToUpload
    });
  }

  // Responder en WhatsApp citando al usuario y procesando menciones
  await reply(result);
});
