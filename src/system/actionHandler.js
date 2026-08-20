import fs from 'fs';
import path from 'path';

const memoryPath = path.resolve('./database/memoria_sistema.json');

/**
 * Carga la memoria persistente del sistema desde base_datos/memoria_sistema.json
 */
function loadMemory() {
  try {
    if (!fs.existsSync(memoryPath)) {
      const initial = { reminders: [], customData: [] };
      fs.writeFileSync(memoryPath, JSON.stringify(initial, null, 2), 'utf8');
      return initial;
    }
    return JSON.parse(fs.readFileSync(memoryPath, 'utf8'));
  } catch (e) {
    return { reminders: [], customData: [] };
  }
}

/**
 * Guarda la memoria persistente del sistema
 */
function saveMemory(data) {
  try {
    const dir = path.resolve('./database');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(memoryPath, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('⚠️ Error al guardar memoria del sistema:', e.message);
  }
}

/**
 * Obtiene un sticker aleatorio dentro de un directorio dado
 */
function getRandomStickerFromDir(dirPath) {
  if (!fs.existsSync(dirPath)) return null;
  try {
    const validExts = ['.webp', '.png', '.jpg', '.jpeg'];
    const files = fs.readdirSync(dirPath).filter(file => {
      const ext = path.extname(file).toLowerCase();
      return validExts.includes(ext);
    });
    if (files.length === 0) return null;
    const randomFile = files[Math.floor(Math.random() * files.length)];
    return path.join(dirPath, randomFile);
  } catch (e) {
    return null;
  }
}

/**
 * Normaliza nombres de estado emocional a slugs de carpetas (ej: "Pícaro / Confiado" -> "picaro_confiado")
 */
function normalizeStateSlug(input) {
  if (!input) return '';
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const chatStickerTracker = new Map();

/**
 * Procesa las acciones enviadas por Gemini en formato [ACTION: NOMBRE | clave: valor | ...]
 * Ejecuta la lógica del lado del servidor Node.js y retorna el texto limpio sin la cabecera.
 */
export function processSystemActions(responseText, extraContext = {}) {
  if (!responseText || typeof responseText !== 'string') {
    return { text: responseText, stickerFile: null, actionType: null };
  }

  const chatId = extraContext.chatId || 'default';
  let count = chatStickerTracker.get(chatId) || 0;
  count++; // Incrementar contador de preguntas transcurridas desde el último sticker

  const actionRegex = /\[ACTION:\s*([^\]]+)\]/i;
  const match = responseText.match(actionRegex);

  let rawActionType = null;
  let params = {};
  let cleanText = responseText;

  if (match) {
    const rawActionStr = match[1];
    console.log(`⚡ [Acción de Gemini detectada]: "${rawActionStr}"`);

    const parts = rawActionStr.split('|').map(p => p.trim());
    rawActionType = parts[0].toUpperCase();

    for (let i = 1; i < parts.length; i++) {
      const kv = parts[i].split(':');
      if (kv.length >= 2) {
        const k = kv[0].trim().toLowerCase();
        const v = kv.slice(1).join(':').trim();
        params[k] = v;
      }
    }

    cleanText = responseText.replace(actionRegex, '').trim();
  }

  const memory = loadMemory();
  let stickerFile = null;
  let isStickerAction = ['ENVIAR_STICKER', 'STICKER', 'ESTADO_EMOCIONAL', 'EMOCION'].includes(rawActionType);

  // 1. Ejecutar Acción: GUARDAR_DATO
  if (rawActionType === 'GUARDAR_DATO') {
    memory.customData.push({
      user: params.usuario || 'Desconocido',
      key: params.clave || 'general',
      val: params.valor || '',
      timestamp: new Date().toISOString()
    });
    saveMemory(memory);
    console.log(`✅ [Sistema Node.js]: Dato guardado en memoria_sistema.json -> ${params.clave}: ${params.valor}`);
  } 
  // 2. Ejecutar Acción: RECORDATORIO
  else if (rawActionType === 'RECORDATORIO') {
    memory.reminders.push({
      user: params.usuario || 'Desconocido',
      date: params.fecha || 'Sin fecha',
      detail: params.detalle || '',
      timestamp: new Date().toISOString()
    });
    saveMemory(memory);
    console.log(`✅ [Sistema Node.js]: Recordatorio registrado -> ${params.usuario}: ${params.fecha} - ${params.detalle}`);
  }

  // 3. LÓGICA DE DECISIÓN DE STICKER (EVITAR SPAM SEGUIDO + OBLIGATORIO TRAS 2 PREGUNTAS)
  const stickersDir = path.resolve('./database/stickers');
  const mustSendSticker = count >= 2; // Si han transcurrido 2 o más preguntas, ES OBLIGATORIO enviar sticker

  let targetState = '';
  if (isStickerAction) {
    targetState = normalizeStateSlug(params.estado || params.emocion || params.nombre || params.sticker || params.id || '');
  }

  // Si no hubo acción de Gemini pero ya pasaron 2 preguntas, elegimos un estado emocional por defecto aleatorio
  if (!targetState && mustSendSticker) {
    const fallbackStates = ['tranquilo_relajado', 'neutral_indiferente', 'relajado_seguro', 'divertido_tentado', 'tierno_jugueton'];
    targetState = fallbackStates[Math.floor(Math.random() * fallbackStates.length)];
    console.log(`⏱️ [Sistema Node.js]: Transcurrieron ${count} preguntas sin sticker -> Forzando sticker estado "${targetState}"`);
  }

  // Determinar si debemos enviar el sticker según el contador
  let shouldSend = false;

  if (mustSendSticker) {
    shouldSend = true; // Cumple la regla de enviar sí o sí tras 2 preguntas
  } else if (isStickerAction) {
    // Si fue mensaje consecutivo (< 2 preguntas) y Gemini sugirió sticker, 35% de probabilidad para no saturar
    shouldSend = Math.random() < 0.35;
    if (!shouldSend) {
      console.log(`🙈 [Sistema Node.js]: Omitiendo sticker consecutivo para no saturar (Contador: ${count}/2 preguntas)`);
    }
  }

  if (shouldSend && targetState && fs.existsSync(stickersDir)) {
    // A) Buscar en subcarpeta de estado emocional
    const subFolderPath = path.join(stickersDir, targetState);
    if (fs.existsSync(subFolderPath) && fs.statSync(subFolderPath).isDirectory()) {
      stickerFile = getRandomStickerFromDir(subFolderPath);
    }

    // B) Si no hay sticker en subcarpeta, buscar archivo directo
    if (!stickerFile) {
      const possibleExts = ['.webp', '.png', '.jpg', '.jpeg'];
      for (const ext of possibleExts) {
        const fullPath = path.join(stickersDir, `${targetState}${ext}`);
        if (fs.existsSync(fullPath)) {
          stickerFile = fullPath;
          break;
        }
      }
    }
  }

  // Actualizar contador del chat
  if (stickerFile) {
    chatStickerTracker.set(chatId, 0); // Resetea contador tras enviar sticker
    console.log(`📤 [Sistema Node.js]: Sticker seleccionado para ${chatId} -> ${stickerFile}`);
  } else {
    chatStickerTracker.set(chatId, count); // Conserva el contador incrementado
  }

  return {
    text: cleanText,
    stickerFile,
    actionType: rawActionType
  };
}


