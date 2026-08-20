/**
 * Gestor de Memoria de Conversación por Chat
 * Almacena el historial reciente de mensajes por cada ID de chat (sender) para mantener el contexto.
 */

class MemoryManager {
  constructor(maxTurns = 15) {
    this.maxTurns = maxTurns; // Número máximo de intercambios (pares de mensajes)
    this.histories = new Map(); // chatId -> Array<{ role: 'user' | 'model', parts: [{ text }] }>
  }

  /**
   * Obtiene el historial formateado para la API de Gemini
   * @param {string} chatId 
   * @returns {Array} Array de objetos de mensaje
   */
  getHistory(chatId) {
    if (!this.histories.has(chatId)) {
      this.histories.set(chatId, []);
    }
    return this.histories.get(chatId);
  }

  /**
   * Añade un nuevo mensaje al historial de un chat
   * @param {string} chatId 
   * @param {'user' | 'model'} role 
   * @param {string} text 
   */
  addMessage(chatId, role, text) {
    const history = this.getHistory(chatId);
    
    // Gemini API usa la estructura { role, parts: [{ text }] }
    history.push({
      role: role === 'user' ? 'user' : 'model',
      parts: [{ text }]
    });

    // Mantener la memoria dentro del límite de turnos (2 entradas por turno: 1 user, 1 model)
    const maxEntries = this.maxTurns * 2;
    if (history.length > maxEntries) {
      // Eliminar las entradas más antiguas
      const trimmed = history.slice(history.length - maxEntries);
      // Asegurar que el historial recortado empiece con rol 'user' si es necesario
      if (trimmed.length > 0 && trimmed[0].role !== 'user') {
        trimmed.shift();
      }
      this.histories.set(chatId, trimmed);
    }
  }

  /**
   * Limpia el historial de un chat específico
   * @param {string} chatId 
   */
  clearHistory(chatId) {
    this.histories.delete(chatId);
  }
}

export const memoryManager = new MemoryManager(
  parseInt(process.env.MAX_HISTORY_TURNS || '15', 10)
);
