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
 * Reinicia el temporizador de inactividad de 5 minutos para Grok.
 */
function resetInactivityTimer() {
  if (inactivityTimer) {
    clearTimeout(inactivityTimer);
  }
  inactivityTimer = setTimeout(() => {
    globalQueue = globalQueue.then(async () => {
      if (page && !page.isClosed()) {
        console.log('⏱️ [Grok Scraper]: 5 minutos de inactividad detectados. Cambiando de pestaña / abriendo nuevo chat en Grok Web...');
        await resetToNewChat();
        currentChatId = null;
      }
    }).catch(err => {
      console.warn('⚠️ Error al reiniciar chat por inactividad en Grok:', err.message);
    });
  }, INACTIVITY_TIMEOUT_MS);
}


/**
 * Inicializa el navegador Playwright para Grok Web Scraping (grok.com)
 */
export async function initGrokScraper() {
  const userDataDir = path.resolve(process.env.GROK_USER_DATA_DIR || './.grok_chrome_data');
  const isHeadless = process.env.HEADLESS === 'true';

  console.log(`🚀 [Grok Scraper]: Iniciando navegador Chromium para Grok (Headless: ${isHeadless})...`);

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

    browserContext = await chromium.launchPersistentContext(userDataDir, {
      headless: isHeadless,
      args: launchArgs,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
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

    console.log('🚀 [Grok Scraper]: Cargando https://grok.com ...');
    await page.goto('https://grok.com', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    const currentUrl = page.url();
    console.log(`🌐 [Grok URL Actual]: ${currentUrl}`);

    console.log('\n======================================================================');
    console.log('ℹ️  [GROK WEB LISTO]: Si es tu primera vez, inicia sesión en la ventana abierta.');
    console.log('   Una vez iniciada la sesión en grok.com, quedará guardada permanentemente.');
    console.log('======================================================================\n');

    resetInactivityTimer();

    process.on('SIGINT', async () => {
      if (browserContext) try { await browserContext.close(); } catch (e) {}
    });

    return true;
  } catch (err) {
    console.error('❌ Error al iniciar el navegador de Grok Web:', err.message);
    return false;
  }
}

/**
 * Reinicia la conversación en Grok Web ("Nuevo chat" / "/new")
 */
async function resetToNewChat() {
  try {
    const newChatSelectors = [
      'button[aria-label*="New Chat"]',
      'button[aria-label*="Nuevo chat"]',
      'a[href="/"]',
      'a[href="/chat"]',
      'button:has-text("New Chat")',
      'button:has-text("Nuevo chat")'
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
      await page.goto('https://grok.com', { waitUntil: 'domcontentloaded' });
    }

    await page.waitForTimeout(1500);
  } catch (e) {
    console.warn('⚠️ No se pudo presionar Nuevo Chat en Grok, recargando página...', e.message);
    try {
      await page.goto('https://grok.com', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
    } catch (err) {}
  }
}

/**
 * Consulta de elementos con reintento seguro ante destrucciones de contexto de ejecución por navegación
 */
async function getElementsSafely(targetPage, selectors) {
  for (let i = 0; i < 4; i++) {
    try {
      for (const selector of selectors) {
        const elems = await targetPage.$$(selector);
        if (elems && elems.length > 0) return elems;
      }
      return [];
    } catch (e) {
      if (e.message.includes('Execution context was destroyed') || e.message.includes('navigation') || e.message.includes('detached')) {
        await targetPage.waitForTimeout(800);
      } else {
        return [];
      }
    }
  }
  return [];
}

/**
 * Ejecuta la consulta en la página de Grok Web
 */
async function executeQuery(promptText, extraContext = {}) {
  if (!page || page.isClosed() || !browserContext) {
    const ok = await initGrokScraper();
    if (!ok) return { text: '🤖 *Error:* No se pudo conectar al navegador de Grok Web.' };
  }

  const safePrompt = (promptText && promptText.trim()) ? promptText.trim() : 'Hola';
  const chatId = extraContext.chatId || 'default';

  // Si cambiamos de grupo/chat, reiniciar el hilo
  if (currentChatId !== chatId) {
    console.log(`🔄 [Grok Scraper]: Cambiando al contexto del grupo ${chatId}...`);
    await resetToNewChat();
    currentChatId = chatId;
  }

  // 1. Adjuntar archivos físicos mediante input directo o selector de archivos
  if (extraContext.files && extraContext.files.length > 0) {
    try {
      console.log('📎 [Grok Scraper]: Adjuntando archivos al prompt...');
      let uploaded = false;

      // 1.1 Intentar primero inyectar directamente en el input[type="file"] (sin abrir menú visual)
      let fileInput = await page.$('input[type="file"][name="files"], input[type="file"]');
      if (fileInput) {
        try {
          await fileInput.setInputFiles(extraContext.files);
          console.log(`✅ [Grok Scraper]: ${extraContext.files.length} archivos adjuntados vía input[type="file"].`);
          uploaded = true;
          await page.waitForTimeout(1000);
        } catch (e) {}
      }

      // 1.2 Si no funcionó directo, usar el botón de adjuntar
      if (!uploaded) {
        try {
          const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null);
          
          const attachButtonSelectors = [
            'button[data-testid="attach-button"]',
            'button[aria-label*="Adjuntar"]',
            'button[aria-label*="Attach"]'
          ];

          let attachBtn = null;
          for (const aSel of attachButtonSelectors) {
            attachBtn = await page.$(aSel);
            if (attachBtn && await attachBtn.isVisible()) break;
          }

          if (attachBtn) {
            await attachBtn.click().catch(() => null);
            await page.waitForTimeout(300);
          }

          const fileChooser = await fileChooserPromise;
          if (fileChooser) {
            await fileChooser.setFiles(extraContext.files);
            console.log(`✅ [Grok Scraper]: ${extraContext.files.length} archivos adjuntados vía File Chooser.`);
            uploaded = true;
            await page.waitForTimeout(1000);
          }
        } catch (e) {}
      }

      // Cerrar cualquier modal o menú desplegable residual presionando Escape
      await page.keyboard.press('Escape').catch(() => null);
      await page.waitForTimeout(200);
      await page.keyboard.press('Escape').catch(() => null);

    } catch (uploadErr) {
      console.warn('⚠️ Error al adjuntar archivos en Grok Web:', uploadErr.message);
    }
  }

  const fullPrompt = getFormattedPrompt(safePrompt, extraContext);

  // 2. Obtener la caja de texto fresca de Grok Web
  const inputSelectors = [
    'div[data-testid="chat-input"] div[contenteditable="true"]',
    'div.tiptap.ProseMirror',
    'div[contenteditable="true"][role="textbox"]',
    'textarea[placeholder*="Ask"]',
    'textarea[placeholder*="Pregunt"]',
    'textarea[placeholder*="Grok"]',
    'textarea',
    'div[contenteditable="true"]'
  ];

  let inputElement = null;
  for (const selector of inputSelectors) {
    inputElement = await page.$(selector);
    if (inputElement && await inputElement.isVisible()) break;
  }

  if (!inputElement) {
    console.warn('⚠️ Recargando interfaz de Grok Web...');
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => null);
    await page.waitForTimeout(3000);

    for (const selector of inputSelectors) {
      inputElement = await page.$(selector);
      if (inputElement && await inputElement.isVisible()) break;
    }
  }

  if (!inputElement) {
    return { text: '🤖 *Error:* No se pudo interactuar con la entrada de texto en Grok Web.' };
  }

  const responseSelectors = [
    'div.message-bubble',
    'div.prose',
    'div[data-testid*="response"]',
    'div.markdown',
    'div.items-start div.whitespace-pre-wrap'
  ];

  const initialElems = await getElementsSafely(page, responseSelectors);
  const initialCount = initialElems.length;

  await inputElement.click().catch(() => null);
  await inputElement.fill(fullPrompt).catch(async () => {
    await page.keyboard.type(fullPrompt);
  });
  await page.waitForTimeout(250);

  const sendBtnSelectors = [
    'button[aria-label*="Send"]',
    'button[aria-label*="Submit"]',
    'button[aria-label*="Enviar"]',
    'button[type="submit"]',
    'button:has(svg)'
  ];

  let sent = false;
  for (const btnSelector of sendBtnSelectors) {
    const btn = await page.$(btnSelector);
    if (btn && await btn.isVisible() && !(await btn.isDisabled())) {
      await btn.click().catch(() => null);
      sent = true;
      break;
    }
  }

  if (!sent) {
    await page.keyboard.press('Enter').catch(() => null);
  }

  console.log('⌛ [Grok Web Scraper]: Prompt enviado. Procesando...');

  // Esperar a que la navegación de URL de Grok (/chat/xxxx) se asiente
  await page.waitForTimeout(1500);

  // Esperar a que aparezca un NUEVO elemento de respuesta de forma segura
  await page.waitForFunction((args) => {
    const selectors = [
      'div.message-bubble',
      'div.prose',
      'div[data-testid*="response"]',
      'div.markdown',
      'div.items-start div.whitespace-pre-wrap'
    ];
    for (const s of selectors) {
      const elements = document.querySelectorAll(s);
      if (elements.length > args.prevCount) return true;
    }
    return false;
  }, { prevCount: initialCount }, { timeout: 25000 }).catch(() => null);

  // Esperar a que finalice la generación en Grok
  const stopButtonSelector = 'button[aria-label*="Stop"], button[aria-label*="Detener"], button:has-text("Stop")';
  let isGenerating = true;
  let attempts = 0;
  while (isGenerating && attempts < 35) {
    try {
      const stopBtn = await page.$(stopButtonSelector);
      if (stopBtn && await stopBtn.isVisible()) {
        await page.waitForTimeout(500);
        attempts++;
      } else {
        isGenerating = false;
      }
    } catch (e) {
      await page.waitForTimeout(500);
      isGenerating = false;
    }
  }

  await page.waitForTimeout(1000);

  const responseElements = await getElementsSafely(page, responseSelectors);

  if (responseElements.length === 0) {
    return { text: '🤖 No se pudo extraer la respuesta de Grok Web.' };
  }

  const lastElement = responseElements[responseElements.length - 1];
  let responseText = '';
  try {
    responseText = await lastElement.innerText();
  } catch (e) {
    await page.waitForTimeout(1000);
    const freshElems = await getElementsSafely(page, responseSelectors);
    if (freshElems.length > 0) {
      responseText = await freshElems[freshElems.length - 1].innerText();
    }
  }

  responseText = responseText.replace(/(\n\s*){3,}/g, '\n\n');
  responseText = responseText.trim();

  return {
    text: responseText || '🤖 Mensaje procesado por Grok.'
  };
}

/**
 * Envía un mensaje a Grok Web procesando mediante cola global secuencial
 */
export async function queryGrokWeb(promptText, extraContext = {}) {
  resetInactivityTimer();
  return new Promise((resolve) => {
    globalQueue = globalQueue.then(async () => {
      try {
        const res = await executeQuery(promptText, extraContext);
        resolve(res);
      } catch (err) {
        console.error('❌ Error en queryGrokWeb:', err.message);
        resolve({ text: '🤖 *Error temporal:* Falló la captura de Grok Web.' });
      } finally {
        resetInactivityTimer();
      }
    }).catch((err) => {
      console.error('❌ Cola global de Grok interrumpida:', err.message);
      resolve({ text: '🤖 *Error temporal:* Ocurrió una interrupción de procesamiento.' });
      resetInactivityTimer();
    });
  });
}
