import os
import re
import sys
import json
import urllib.request
import urllib.parse
import time

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
}

EMOTIONS_QUERIES = {
    'tranquilo_relajado': 'cat sticker relaxed calm chill meme',
    'neutral_indiferente': 'cat sticker neutral poker face meme',
    'picaro_confiado': 'cat sticker smirk confident meme',
    'divertido_tentado': 'cat sticker laughing funny meme',
    'conmovido_sensible': 'cat sticker wholesome crying happy eyes meme',
    'abrumado_dramatico': 'cat sticker dramatic crying meme',
    'decaido_triste': 'cat sticker sad depressed meme',
    'fastidiado_cansado': 'cat sticker annoyed tired meme',
    'molesto_harto': 'cat sticker angry fed up meme',
    'avergonzado_sorprendido': 'cat sticker shocked blush meme',
    'derretido_saturado': 'cat sticker melting overwhelmed meme',
    'desconfiado_esceptico': 'cat sticker skeptical side eye meme',
    'relajado_seguro': 'cat sticker cool sunglasses meme',
    'coqueto_avergonzado': 'cat sticker shy blush giggling meme',
    'aburrido_agotado': 'cat sticker bored sleeping meme',
    'frustrado_indignado': 'cat sticker frustrated rage meme',
    'carinoso_encantado': 'cat sticker loving hearts meme',
    'resignado_dispuesto': 'cat sticker salute fine ok meme',
    'autoburla_ridiculo': 'cat sticker clown foolish meme',
    'muerto_de_risa_shock': 'cat sticker dead laughing shock meme',
    'seriedad_absurda': 'cat sticker stone face moai serious meme',
    'tierno_jugueton': 'cat sticker cute playful meme',
    'felicidad_agridulce': 'cat sticker bittersweet crying smiling meme',
    'incomodo_sin_palabras': 'cat sticker awkward speechless blank meme',
    'desconectado_ausente': 'cat sticker blank stare zoned out meme',
    'alivio_agotamiento': 'cat sticker relief exhausted whew meme',
    'travieso_provocador': 'cat sticker mischievous devil smirk meme',
    'afecto_cercania': 'cat sticker cat hug heart affection meme'
}

BASE_STICKERS_DIR = os.path.abspath('./database/stickers')

def download_image(url, save_path):
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=10) as response:
            content_type = response.headers.get('Content-Type', '')
            data = response.read()
            if len(data) < 3000:  # Evitar archivos corruptos/demasiado pequeños
                return False
            with open(save_path, 'wb') as f:
                f.write(data)
            print(f"  [+] Descargado: {os.path.basename(save_path)} ({len(data)} bytes)")
            return True
    except Exception as e:
        return False

def search_bing_images(query, num_images=5):
    try:
        url = f'https://www.bing.com/images/async?q={urllib.parse.quote(query)}&first=1&count=20'
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=10) as res:
            html = res.read().decode('utf-8', errors='ignore')
        
        matches = re.findall(r'murl&quot;:&quot;(ht[^&]+)&quot;', html)
        valid_urls = []
        for m in matches:
            clean_url = urllib.parse.unquote(m)
            if clean_url.startswith('http') and not clean_url.endswith('.svg'):
                valid_urls.append(clean_url)
            if len(valid_urls) >= num_images * 3:
                break
        return valid_urls
    except Exception as e:
        print(f"  [!] Error buscando en Bing para '{query}': {e}")
        return []

def search_cat_api(num_images=3):
    try:
        url = f'https://api.thecatapi.com/v1/images/search?limit={num_images}'
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=10) as res:
            data = json.loads(res.read().decode('utf-8'))
        return [item['url'] for item in data if 'url' in item]
    except Exception:
        return []

def main():
    print(f"[START] Descargando 3 imagenes de gatos para cada uno de los 28 estados emocionales...")
    print(f"[INFO] Carpeta de destino: {BASE_STICKERS_DIR}\n")

    total_downloaded = 0

    for emotion, query in EMOTIONS_QUERIES.items():
        folder_path = os.path.join(BASE_STICKERS_DIR, emotion)
        os.makedirs(folder_path, exist_ok=True)

        existing_files = [f for f in os.listdir(folder_path) if f.lower().endswith(('.png', '.jpg', '.jpeg', '.webp'))]
        if len(existing_files) >= 3:
            print(f"[OK] [{emotion}] Ya cuenta con {len(existing_files)} imagenes. Saltando...")
            continue

        needed = 3 - len(existing_files)
        print(f"[SEARCH] [{emotion}]: Buscando gatos en Bing para '{query}'...")
        image_urls = search_bing_images(query, num_images=needed)

        if not image_urls:
            print(f"  [!] Fallback a TheCatAPI para [{emotion}]...")
            image_urls = search_cat_api(num_images=needed * 2)

        success_count = 0
        idx = len(existing_files) + 1

        for url in image_urls:
            ext = '.jpg'
            if '.png' in url.lower(): ext = '.png'
            elif '.webp' in url.lower(): ext = '.webp'
            
            save_name = f"gato_{idx}{ext}"
            save_path = os.path.join(folder_path, save_name)

            if download_image(url, save_path):
                success_count += 1
                idx += 1
                total_downloaded += 1
                if success_count >= needed:
                    break
            time.sleep(0.2)

        print(f"[RESULT] [{emotion}]: {success_count}/{needed} nuevas imagenes guardadas.\n")
        time.sleep(0.3)

    print(f"[FINISHED] ¡Proceso de descarga completado! Total imagenes agregadas: {total_downloaded}")

if __name__ == '__main__':
    main()
