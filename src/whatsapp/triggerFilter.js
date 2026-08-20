/**
 * Filtro de Activación Estricto para el Bot de WhatsApp
 * 
 * Evalúa de forma ultra robusta si el bot fue mencionado o citado,
 * solucionando diferencias de prefijos telefónicos en Argentina (ej: con o sin el 9 de celular).
 */

/**
 * Compara dos números de teléfono o IDs para ver si corresponden al mismo bot
 * usando los últimos 8 dígitos para evitar discrepancias de país o prefijo 9.
 */
let dynamicBotLid = '';

/**
 * Registra dinámicamente el LID del bot capturado desde WhatsApp Web
 */
export function setBotLid(lid) {
  if (lid) {
    dynamicBotLid = String(lid).replace(/\D/g, '');
    console.log(`🔑 [TriggerFilter]: LID de WhatsApp del Bot registrado correctamente -> @${dynamicBotLid}`);
  }
}

function isBotNumberMatch(targetIdOrNumber, botNumber) {
  if (!targetIdOrNumber || !botNumber) return false;
  
  const cleanTarget = targetIdOrNumber.replace(/\D/g, '');
  const cleanBot = botNumber.replace(/\D/g, '');

  if (cleanTarget === cleanBot) return true;

  // Comparación por sufijo de los últimos 8 dígitos (ej: "3883116484" y "93883116484")
  if (cleanTarget.length >= 8 && cleanBot.length >= 8) {
    return cleanTarget.slice(-8) === cleanBot.slice(-8);
  }

  return false;
}

export async function shouldBotRespond(message, client) {
  if (!client || !client.info || !client.info.wid) {
    return { shouldRespond: false, cleanText: '' };
  }

  const botId = client.info.wid?._serialized || ''; 
  const botNumber = client.info.wid?.user || '';     
  const botLid = dynamicBotLid || client.info.lid?.user || client.info.lid?._serialized?.split('@')[0] || '';

  const isMatch = (targetIdOrNumber) => {
    if (!targetIdOrNumber) return false;
    if (isBotNumberMatch(targetIdOrNumber, botNumber)) return true;
    if (botLid && isBotNumberMatch(targetIdOrNumber, botLid)) return true;
    return false;
  };

  const messageText = message.body ? message.body.trim() : '';
  const lowerText = messageText.toLowerCase();

  let isMention = false;
  let isReply = false;

  // 1. Verificar menciones nativas de WhatsApp (etiquetas del sistema / LID)
  const allMentionedIds = [
    ...(message.mentionedIds || []),
    ...(message._data?.mentionedJidList || [])
  ];

  if (allMentionedIds.length > 0) {
    for (const mentionedId of allMentionedIds) {
      if (isMatch(mentionedId)) {
        isMention = true;
        break;
      }
      // Auto-aprendizaje: Si se detecta un ID de tipo @lid o @c.us en las menciones del sistema y el bot no tiene LID registrado
      if (!dynamicBotLid && (mentionedId.endsWith('@lid') || mentionedId.endsWith('@c.us'))) {
        const extractedId = mentionedId.replace(/\D/g, '');
        if (extractedId && extractedId.length >= 10) {
          setBotLid(extractedId);
          isMention = true;
          break;
        }
      }
    }
  }

  // 2. Verificar menciones en texto por Nombre (@Devs Project, @Gemini, etc.)
  const customBotName = (process.env.BOT_NAME || 'Devs Project').toLowerCase();
  const nameTriggers = [
    `@${customBotName}`,
    '@devs project',
    '@devsproject',
    '@devs',
    '@gemini',
    '@bot'
  ];

  for (const trigger of nameTriggers) {
    if (lowerText.includes(trigger)) {
      isMention = true;
      break;
    }
  }

  // 3. Verificar menciones de números/LID en texto libre (ej: @47524551385195 o @+54 9 388 311-6484)
  if (!isMention) {
    const matches = messageText.match(/@\+?\d{10,20}/g);
    if (matches) {
      for (const match of matches) {
        const digitsOnly = match.replace(/\D/g, '');
        if (digitsOnly) {
          if (isMatch(digitsOnly)) {
            isMention = true;
            break;
          }
          // Si es un número largo (ej: 47524551385195 LID de 14 dígitos) y el bot aún no tiene LID registrado
          if (!dynamicBotLid && digitsOnly.length >= 12) {
            setBotLid(digitsOnly);
            isMention = true;
            break;
          }
        }
      }
    }
  }

  // 4. Verificar Respuestas (Quoted Messages / Reply)
  if (message.hasQuotedMsg) {
    try {
      const quotedData = message._data?.quotedMsg;
      const quotedParticipant = message._data?.quotedParticipant || (quotedData ? quotedData.from : null);

      // Si los datos internos indican que es un mensaje propio del bot
      if (quotedData && (quotedData.fromMe || isMatch(quotedParticipant))) {
        isReply = true;
      }

      // Si falla, consultar por Puppeteer
      if (!isReply) {
        const quoted = await message.getQuotedMessage();
        if (quoted && (quoted.fromMe || isMatch(quoted.author) || isMatch(quoted.from))) {
          isReply = true;
        }
      }
    } catch (e) {
      if (message._data?.quotedMsg?.fromMe || isMatch(message._data?.quotedParticipant)) {
        isReply = true;
      }
    }
  }

  const respondToAll = process.env.RESPOND_TO_ALL === 'true';
  const shouldRespond = respondToAll || isMention || isReply;

  // 5. Limpieza del texto: Remover los tags de mención
  let cleanText = messageText;
  if (isMention) {
    cleanText = cleanText.replace(/@devs\s+project/gi, '');
    cleanText = cleanText.replace(/@devsproject/gi, '');
    cleanText = cleanText.replace(/@devs/gi, '');
    cleanText = cleanText.replace(/@gemini/gi, '');
    cleanText = cleanText.replace(/@bot/gi, '');

    if (customBotName) {
      cleanText = cleanText.replace(new RegExp(`@${customBotName}`, 'gi'), '');
    }

    // Remover menciones numéricas y LIDs
    cleanText = cleanText.replace(/@\+?[\d\s\-]{7,20}/g, '');
    if (botNumber) cleanText = cleanText.replace(new RegExp(`@${botNumber}`, 'g'), '');
    if (botLid) cleanText = cleanText.replace(new RegExp(`@${botLid}`, 'g'), '');
    cleanText = cleanText.trim();
  }

  return {
    shouldRespond,
    cleanText,
    isReply,
    isMention
  };
}
