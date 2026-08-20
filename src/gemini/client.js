import { GoogleGenerativeAI } from '@google/generative-ai';
import { SYSTEM_PROMPT, getSystemPrompt } from '../prompt/systemPrompt.js';
import { memoryManager } from './memory.js';

let genAI = null;

/**
 * Inicializa el cliente de Gemini con la API Key
 */
export function initGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('\n⚠️ [ADVERTENCIA GEMINI]: No se encontró GEMINI_API_KEY en el archivo .env.');
    console.warn('  Obtén una clave 100% gratuita en https://aistudio.google.com/app/apikey e insértala en .env\n');
    return false;
  }

  genAI = new GoogleGenerativeAI(apiKey);
  return true;
}

/**
 * Genera una respuesta de Gemini para un mensaje entrante de WhatsApp
 * @param {string} chatId ID del chat de WhatsApp
 * @param {string} userPrompt Mensaje o conjunto de mensajes del usuario
 * @param {object} metadata Contexto adicional opcional (userName, etc.)
 * @returns {Promise<string>} Respuesta generada
 */
export async function generateGeminiResponse(chatId, userPrompt, metadata = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return '⚠️ *Bot Configuración:* Falta configurar la `GEMINI_API_KEY` en el archivo `.env`. Por favor agrégala para activar las respuestas de Gemini.';
  }

  if (!genAI) {
    initGeminiClient();
  }

  const modelName = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

  try {
    const systemInstruction = getSystemPrompt(metadata);

    // Obtener modelo con instrucciones del sistema
    const model = genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: systemInstruction,
    });

    // Obtener historial previo de la memoria
    const history = memoryManager.getHistory(chatId);

    // Iniciar chat con historial
    const chatSession = model.startChat({
      history: history,
      generationConfig: {
        maxOutputTokens: 1000,
        temperature: 0.7,
      },
    });

    // Enviar el nuevo mensaje del usuario
    const result = await chatSession.sendMessage(userPrompt);
    const responseText = result.response.text();

    // Guardar en la memoria local
    memoryManager.addMessage(chatId, 'user', userPrompt);
    memoryManager.addMessage(chatId, 'model', responseText);

    return responseText;
  } catch (error) {
    console.error(`❌ [Error Gemini API - Chat ${chatId}]:`, error.message);
    
    if (error.message.includes('API_KEY_INVALID')) {
      return '⚠️ La `GEMINI_API_KEY` configurada no es válida. Por favor verifica tu clave en `.env`.';
    }

    return 'Lo siento, tuve un problema procesando tu mensaje en este momento. Inténtalo de nuevo en un instante. 😅';
  }
}
