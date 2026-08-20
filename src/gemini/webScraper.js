import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { getFormattedPrompt } from '../prompt/unjuSystemPrompt.js';

let browserContext = null;
let page = null;
let currentChatId = null;
let globalQueue = Promise.resolve();
let inactivityTimer = null;
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos de inactividad

/**
 * Reinicia el temporizador de inactividad de 5 minutos.
 * Si pasan 5 minutos sin consultas, cambia a un nuevo chat/pestaña en Gemini Web.
 */
function resetInactivityTimer() {
  if (inactivityTimer) {
    clearTimeout(inactivityTimer);
  }
  inactivityTimer = setTimeout(() => {
    globalQueue = globalQueue.then(async () => {
      if (page && !page.isClosed()) {
        console.log('⏱️ [Gemini Scraper]: 5 minutos de inactividad detectados. Cambiando de pestaña / abriendo nuevo chat en Gemini Web...');
        await resetToNewChat();
        currentChatId = null;
      }
    }).catch(err => {
      console.warn('⚠️ Error al reiniciar chat por inactividad en Gemini:', err.message);
    });
  }, INACTIVITY_TIMEOUT_MS);
}


/**
 * Inicializa el navegador Playwright para Gemini Web Scraping
 */
export async function initGeminiScraper() {
  const userDataDir = path.resolve(process.env.GEMINI_USER_DATA_DIR || './.gemini_chrome_data');
  const hideWindow = process.env.HEADLESS !== 'false';

  console.log(`🌐 [Gemini Scraper]: Iniciando navegador Chromium (Modo Invisible / Fuera de Pantalla: ${hideWindow})...`);

  try {
    const lockFile = path.join(userDataDir, 'SingletonLock');
    const socketFile = path.join(userDataDir, 'SingletonSocket');
    const cookieFile = path.join(userDataDir, 'SingletonCookie');
    try { fs.rmSync(lockFile, { force: true }); } catch (e) {}
    try { fs.rmSync(socketFile, { force: true }); } catch (e) {}
    try { fs.rmSync(cookieFile, { force: true }); } catch (e) {}

    if (browserContext) {
      try { await browserContext.close(); } catch (e) {}
    }

    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
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
    ];

    if (hideWindow) {
      launchArgs.push('--window-position=-32000,-32000');
      launchArgs.push('--window-size=1280,800');
      launchArgs.push('--start-minimized');
    }

    browserContext = await chromium.launchPersistentContext(userDataDir, {
      headless: hideWindow,
      args: launchArgs,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 }
    });

    await browserContext.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    // Bloquear recursos pesados innecesarios (videos, fuentes, analíticas) para ahorrar RAM
    await browserContext.route('**/*', (route) => {
      const resourceType = route.request().resourceType();
      const url = route.request().url();
      if (['media', 'font'].includes(resourceType) || 
          url.includes('google-analytics.com') || 
          url.includes('googletagmanager.com') || 
          url.includes('doubleclick.net')) {
        return route.abort();
      }
      return route.continue();
    });

    const pages = browserContext.pages();
    page = pages.length > 0 ? pages[0] : await browserContext.newPage();

    console.log('🌐 [Gemini Scraper]: Cargando https://gemini.google.com/app ...');
    await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    const currentUrl = page.url();
    if (currentUrl.includes('accounts.google.com')) {
      console.log('\n======================================================================');
      console.log('⚠️ [ACCIÓN REQUERIDA]: Inicia sesión en tu cuenta de Google en el navegador.');
      console.log('   Una vez iniciada la sesión en gemini.google.com, el bot la guardará.');
      console.log('======================================================================\n');
    } else {
      console.log('✅ [Gemini Scraper Listo]: Sesión de Gemini Web detectada correctamente.');
    }

    resetInactivityTimer();

    process.on('SIGINT', async () => {
      if (browserContext) try { await browserContext.close(); } catch (e) {}
    });

    return true;
  } catch (err) {
    console.error('❌ Error al iniciar el navegador de Gemini Web:', err.message);
    return false;
  }
}

/**
 * Reinicia la conversación en Gemini Web ("Nuevo chat") para cambiar de grupo sin arrastrar contexto anterior
 */
async function resetToNewChat() {
  try {
    const newChatSelectors = [
      'button[aria-label*="Nuevo chat"]',
      'button[aria-label*="New chat"]',
      'a[aria-label*="Nuevo chat"]',
      'a[aria-label*="New chat"]',
      'button:has-text("Nuevo chat")',
      'button:has-text("New chat")',
      '[data-test-id="new-chat-button"]'
    ];

    let clicked = false;
    for (const sel of newChatSelectors) {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) {
        await btn.click();
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      // Si no encuentra el botón directo, recargar a la URL base de nuevo chat
      await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded' });
    }

    await page.waitForTimeout(1500);
  } catch (e) {
    console.warn('⚠️ No se pudo presionar Nuevo Chat, recargando página...', e.message);
    try {
      await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
    } catch (err) {}
  }
}

/**
 * Ejecuta la consulta en la página principal de Gemini Web
 */
async function executeQuery(promptText, extraContext = {}) {
  if (!page || page.isClosed() || !browserContext) {
    const ok = await initGeminiScraper();
    if (!ok) return { text: '🤖 *Error:* No se pudo conectar al navegador de Gemini Web.' };
  }

  const chatId = extraContext.chatId || 'default';

  // Si cambiamos de grupo/chat, presionar "Nuevo chat" para reiniciar el hilo de Gemini
  if (currentChatId !== chatId) {
    console.log(`🔄 [Gemini Scraper]: Cambiando al contexto del grupo ${chatId}...`);
    await resetToNewChat();
    currentChatId = chatId;
  }

  const fullPrompt = getFormattedPrompt(promptText, extraContext);

  // 1. Subir archivos físicos si se proporcionan (primero)
  if (extraContext.files && extraContext.files.length > 0) {
    try {
      console.log('📎 [Gemini Web Scraper]: Intentando adjuntar archivos al prompt...');
      let uploaded = false;
      
      try {
        const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 4000 }).catch(() => null);
        
        const plusBtnSelectors = [
          'button[aria-label*="Subidas y herramientas"]',
          'button[data-test-id*="uploader"]',
          'button:has(mat-icon[fonticon="plus"])',
          'button:has(mat-icon[data-mat-icon-name="plus"])',
          'button[aria-label*="Añadir"]',
          'button[aria-label*="Add"]',
          'button[aria-label*="Subir"]'
        ];
        
        let plusBtn = null;
        for (const selector of plusBtnSelectors) {
          plusBtn = await page.$(selector);
          if (plusBtn && await plusBtn.isVisible()) break;
        }

        if (!plusBtn) {
          const plusIcon = await page.$('mat-icon[fonticon="plus"], mat-icon[data-mat-icon-name="plus"]');
          if (plusIcon) {
            plusBtn = await plusIcon.evaluateHandle(el => el.closest('button'));
          }
        }
        
        if (plusBtn) {
          await plusBtn.click();
          await page.waitForTimeout(600);
          
          const uploadOptionSelectors = [
            'button[data-test-id="local-images-files-uploader-button"]',
            'button[aria-label*="Subir archivos"]',
            '[role="menuitem"]:has-text("Subir archivos")',
            'span.gem-menu-item-label:has-text("Subir archivos")'
          ];
          
          for (const optSelector of uploadOptionSelectors) {
            const opt = await page.$(optSelector);
            if (opt && await opt.isVisible()) {
              await opt.click();
              break;
            }
          }
        }
        
        const fileChooser = await fileChooserPromise;
        if (fileChooser) {
          await fileChooser.setFiles(extraContext.files);
          console.log(`✅ [Gemini Web Scraper]: ${extraContext.files.length} archivos adjuntados vía File Chooser.`);
          uploaded = true;
          await page.waitForTimeout(2000);
        }
      } catch (e) {}

      if (!uploaded) {
        let fileInput = await page.$('input[type="file"]');
        if (!fileInput) {
          fileInput = await page.$('input[accept*="image"], input[accept*="text"], input[accept*="pdf"]');
        }
        
        if (fileInput) {
          await fileInput.setInputFiles(extraContext.files);
          console.log(`✅ [Gemini Web Scraper]: ${extraContext.files.length} archivos adjuntados vía input[type="file"].`);
          uploaded = true;
          await page.waitForTimeout(2000);
        }
      }

      if (!uploaded) {
        console.warn('⚠️ No se pudo adjuntar automáticamente los archivos. Se procederá con la respuesta de texto.');
      }

      // Cerrar cualquier menú desplegable o modal residual presionando Escape
      await page.keyboard.press('Escape').catch(() => null);
      await page.waitForTimeout(200);
      await page.keyboard.press('Escape').catch(() => null);
    } catch (uploadErr) {
      console.warn('⚠️ Error al adjuntar archivos en Gemini Web:', uploadErr.message);
    }
  }

  // 2. Obtener un elemento de entrada de texto FRESCO del DOM después de adjuntar los archivos
  const inputSelectors = [
    'rich-textarea div[contenteditable="true"]',
    'div[contenteditable="true"]',
    'div.ql-editor',
    'textarea'
  ];

  let inputElement = null;
  for (const selector of inputSelectors) {
    inputElement = await page.$(selector);
    if (inputElement && await inputElement.isVisible()) break;
  }

  if (!inputElement) {
    console.warn('⚠️ Recargando interfaz de Gemini Web...');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    
    for (const selector of inputSelectors) {
      inputElement = await page.$(selector);
      if (inputElement && await inputElement.isVisible()) break;
    }
  }

  if (!inputElement) {
    return { text: '🤖 *Error:* No se pudo interactuar con la entrada de texto en Gemini Web.' };
  }

  // Contar cuántas respuestas del modelo existen actualmente antes de enviar la nueva consulta
  const responseSelectors = [
    'model-response message-content',
    'model-response .markdown',
    '.model-response-text',
    'message-content'
  ];

  let initialCount = 0;
  for (const selector of responseSelectors) {
    const elems = await page.$$(selector);
    if (elems.length > 0) {
      initialCount = elems.length;
      break;
    }
  }

  await inputElement.click();
  await inputElement.fill(fullPrompt);
  await page.waitForTimeout(200);

  // Esperar a que el botón Enviar esté habilitado si había archivos subiendo
  await page.waitForFunction(() => {
    const sendBtn = document.querySelector('button[aria-label*="Enviar"], button[aria-label*="Send"], button.send-button');
    return sendBtn && !sendBtn.disabled && sendBtn.getAttribute('aria-disabled') !== 'true';
  }, { timeout: 10000 }).catch(() => null);

  const sendBtnSelectors = [
    'button[aria-label*="Enviar"]',
    'button[aria-label*="Send"]',
    'button.send-button'
  ];

  let sent = false;
  for (const btnSelector of sendBtnSelectors) {
    const btn = await page.$(btnSelector);
    if (btn && await btn.isVisible()) {
      const isEnabled = await btn.isEnabled().catch(() => false);
      if (isEnabled) {
        try {
          await btn.click({ timeout: 3000 });
          sent = true;
          break;
        } catch (e) {
          try {
            await page.evaluate(el => el.click(), btn);
            sent = true;
            break;
          } catch (err) {}
        }
      }
    }
  }

  if (!sent) {
    await page.keyboard.press('Enter').catch(() => null);
  }

  console.log('⌛ [Gemini Web Scraper]: Prompt enviado. Procesando...');

  // Esperar a que aparezca un NUEVO elemento de respuesta
  await page.waitForFunction((prevCount) => {
    const selectors = ['model-response message-content', 'model-response .markdown', '.model-response-text', 'message-content'];
    for (const s of selectors) {
      const elements = document.querySelectorAll(s);
      if (elements.length > prevCount) return true;
    }
    return false;
  }, initialCount, { timeout: 25000 }).catch(() => null);

  // Esperar a que el botón "Detener" desaparezca
  const stopButtonSelector = 'button[aria-label*="Detener"], button[aria-label*="Stop"]';
  let isGenerating = true;
  let attempts = 0;
  while (isGenerating && attempts < 30) {
    const stopBtn = await page.$(stopButtonSelector);
    if (stopBtn && await stopBtn.isVisible()) {
      await page.waitForTimeout(500);
      attempts++;
    } else {
      isGenerating = false;
    }
  }

  await page.waitForTimeout(500);

  let responseElements = [];
  for (const selector of responseSelectors) {
    const found = await page.$$(selector);
    if (found.length > initialCount) {
      responseElements = found;
      break;
    }
  }

  if (responseElements.length === 0) {
    for (const selector of responseSelectors) {
      const found = await page.$$(selector);
      if (found.length > 0) {
        responseElements = found;
        break;
      }
    }
  }

  if (responseElements.length === 0) {
    return { text: '🤖 No se pudo extraer la respuesta de Gemini Web.' };
  }

  const lastElement = responseElements[responseElements.length - 1];
  let responseText = await lastElement.innerText();

  // Limpiar etiquetas/pills de archivos adjuntos (ej: TXT, TXT + 1, + 1)
  responseText = responseText.replace(/\b(TXT|PDF|DOCX|DOC|CSV)\s*\+\s*\d+/gi, '');
  responseText = responseText.replace(/\b(TXT|PDF|DOCX|DOC|CSV)\b/gi, '');
  responseText = responseText.replace(/^\s*\+\s*\d+\s*$/gm, '');
  responseText = responseText.replace(/(\n\s*){3,}/g, '\n\n');
  responseText = responseText.trim();

  // Extraer imágenes si existen
  let imageBuffer = null;
  let imageMime = 'image/png';

  const imageSelectors = ['img[src*="googleusercontent"]', 'img[src*="data:image"]', 'gmp-image-card img', 'img'];
  let allImgs = [];
  for (const imgSel of imageSelectors) {
    const found = await lastElement.$$(imgSel);
    if (found.length > 0) {
      allImgs = found;
      break;
    }
  }

  for (const img of allImgs) {
    const src = await img.getAttribute('src');
    if (src && !src.includes('avatar') && !src.includes('profile') && !src.includes('favicon')) {
      try {
        if (src.startsWith('data:image')) {
          const matches = src.match(/^data:(image\/\w+);base64,(.+)$/);
          if (matches) {
            imageMime = matches[1];
            imageBuffer = Buffer.from(matches[2], 'base64');
          }
        } else if (src.startsWith('http')) {
          const imgRes = await page.request.get(src);
          if (imgRes.ok()) {
            imageBuffer = await imgRes.body();
          }
        }
        if (imageBuffer && imageBuffer.length > 1000) break;
      } catch (e) {
        console.warn('⚠️ No se pudo descargar la imagen generada:', e.message);
      }
    }
  }

  return {
    text: responseText.trim(),
    imageBuffer,
    imageMime
  };
}

/**
 * Envía un mensaje a Gemini Web procesando de forma segura mediante cola global secuencial
 */
export async function queryGeminiWeb(promptText, extraContext = {}) {
  resetInactivityTimer();
  return new Promise((resolve) => {
    globalQueue = globalQueue.then(async () => {
      try {
        const res = await executeQuery(promptText, extraContext);
        resolve(res);
      } catch (err) {
        console.error('❌ Error en queryGeminiWeb:', err.message);
        resolve({ text: '🤖 *Error temporal:* Falló la captura de Gemini Web.' });
      } finally {
        resetInactivityTimer();
      }
    }).catch((err) => {
      console.error('❌ Cola global de Gemini interrumpida:', err.message);
      resolve({ text: '🤖 *Error temporal:* Ocurrió una interrupción de procesamiento.' });
      resetInactivityTimer();
    });
  });
}
