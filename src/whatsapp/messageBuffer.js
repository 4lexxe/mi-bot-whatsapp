/**
 * Buffer / Debounce de Mensajes para WhatsApp
 * 
 * Evita responder a cada mensaje individual cuando un usuario envía 3 o 4 mensajes rápidos seguidos.
 * Acumula los mensajes durante un tiempo determinado (ej: 3.5s) y los envía todos juntos en una sola petición.
 */

class MessageBuffer {
  constructor(debounceMs = 3500) {
    this.debounceMs = debounceMs;
    this.buffers = new Map(); // chatId -> { messages: string[], timer: Timeout, contactName: string }
  }

  /**
   * Añade un mensaje al buffer de un chat
   * @param {string} chatId ID del chat
   * @param {string} messageContent Texto del mensaje
   * @param {string} contactName Nombre del usuario (opcional)
   * @param {Function} onFlush Callback cuando expira el tiempo de debounce
   */
  addMessage(chatId, messageContent, contactName, onFlush) {
    if (!this.buffers.has(chatId)) {
      this.buffers.set(chatId, {
        messages: [],
        timer: null,
        contactName: contactName || 'Usuario'
      });
    }

    const item = this.buffers.get(chatId);
    item.messages.push(messageContent);
    item.contactName = contactName || item.contactName;

    // Reiniciar el temporizador (debounce)
    if (item.timer) {
      clearTimeout(item.timer);
    }

    item.timer = setTimeout(() => {
      // Al expirar el temporizador, unificar mensajes y ejecutar el callback
      const combinedMessages = item.messages.join('\n');
      const finalContactName = item.contactName;

      // Limpiar buffer del chat
      this.buffers.delete(chatId);

      // Disparar procesamiento
      onFlush(chatId, combinedMessages, finalContactName);
    }, this.debounceMs);
  }
}

export const messageBuffer = new MessageBuffer(
  parseInt(process.env.BOT_DEBOUNCE_MS || '3500', 10)
);
