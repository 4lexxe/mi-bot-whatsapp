FROM mcr.microsoft.com/playwright:v1.49.1-noble

WORKDIR /app

# Copiar configuración de dependencias
COPY package*.json ./

# Instalar dependencias del proyecto
RUN npm ci --only=production

# Asegurar la instalación binaria de Chromium coincidente con Playwright
RUN npx playwright install chromium

# Copiar todo el código fuente
COPY . .

# Variables de entorno por defecto
ENV PORT=10000
ENV HEADLESS=true

# Exponer el puerto asignado
EXPOSE 10000

# Comando de arranque optimizado
CMD ["npm", "start"]
