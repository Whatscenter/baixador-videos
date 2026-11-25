#!/usr/bin/env python3
"""
Baixador de vídeos - Instagram, Kwai, TikTok, Facebook, YouTube Shorts.

Uso:
  python baixar_videos.py                 -> abre a página no navegador (cole os links e clique em Baixar)
  python baixar_videos.py LINK [LINK...]  -> baixa direto pelo terminal

Os vídeos vão para a pasta "Videos_Baixados" ao lado deste arquivo.
Requer: pip install -U yt-dlp
"""
import html
import json
import os
import re
import sys
import threading
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PASTA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "Videos_Baixados")
PORTA = 8765
UA_CELULAR = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 "
              "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1")
NAVEGADORES = ["chrome", "edge", "firefox", "brave", "opera"]


def nome_seguro(txt, limite=60):
    txt = re.sub(r"[^\w\- ]+", "", txt or "", flags=re.UNICODE).strip().replace(" ", "_")
    return (txt[:limite] or "video")


# ---------------------------------------------------------------- Kwai
def _abrir(url, referer=None):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA_CELULAR,
        "Accept-Language": "pt-BR,pt;q=0.9",
        **({"Referer": referer} if referer else {}),
    })
    return urllib.request.urlopen(req, timeout=30)


def _achar_mp4_kwai(pagina):
    """Procura o link do vídeo no HTML da página do Kwai (vários formatos conhecidos)."""
    texto = pagina.replace("\\u002F", "/").replace("\\/", "/").replace("&amp;", "&")
    candidatos = []
    # 1) meta tags og:video
    for m in re.finditer(r'<meta[^>]+(?:property|name)="og:video(?::secure_url|:url)?"[^>]+content="([^"]+)"', texto):
        candidatos.append(m.group(1))
    for m in re.finditer(r'<meta[^>]+content="([^"]+)"[^>]+(?:property|name)="og:video(?::secure_url|:url)?"', texto):
        candidatos.append(m.group(1))
    # 2) campos JSON usados pelo Kwai/Kuaishou
    for chave in ["srcNoMark", "mainMvUrls", "main_mv_urls", "photoUrl", "videoUrl", "playUrl", "contentUrl", "url"]:
        for m in re.finditer(r'"%s"\s*:\s*(?:\[\s*\{[^\]]*?"url"\s*:\s*)?"(https?://[^"]+)"' % chave, texto):
            candidatos.append(m.group(1))
    # 3) qualquer .mp4 solto na página
    candidatos += re.findall(r'https?://[^\s"\'<>]+?\.mp4[^\s"\'<>]*', texto)

    vistos, bons = set(), []
    for c in candidatos:
        c = html.unescape(c)
        if c in vistos or ".mp4" not in c.lower() and "video" not in c.lower():
            continue
        vistos.add(c)
        bons.append(c)
    # prefere sem marca d'água / mp4 direto
    bons.sort(key=lambda u: (("nomark" not in u.lower()), (".mp4" not in u.lower())))
    titulo = re.search(r'<meta[^>]+property="og:title"[^>]+content="([^"]*)"', texto)
    return bons, (titulo.group(1) if titulo else "")


def baixar_kwai(url, log):
    log(f"Kwai: abrindo a página {url}")
    resp = _abrir(url)
    final = resp.geturl()  # segue links curtos (k.kwai.com/p/...)
    pagina = resp.read().decode("utf-8", "ignore")
    links, titulo = _achar_mp4_kwai(pagina)
    if not links:
        raise RuntimeError("não achei o vídeo na página do Kwai (o vídeo pode ser privado ou o Kwai mudou o site)")
    vid = re.search(r"/video/(\d+)|photoId=(\d+)|/(\d{6,})", final)
    vid = next((g for g in (vid.groups() if vid else []) if g), "")
    destino = os.path.join(PASTA, f"kwai_{nome_seguro(titulo, 40)}_{vid or 'video'}.mp4")
    ultimo_erro = None
    for link in links[:5]:
        try:
            log("Kwai: baixando o arquivo do vídeo...")
            with _abrir(link, referer=final) as r, open(destino, "wb") as f:
                while True:
                    bloco = r.read(1 << 16)
                    if not bloco:
                        break
                    f.write(bloco)
            if os.path.getsize(destino) > 50_000:
                return destino
        except Exception as e:  # tenta o próximo candidato
            ultimo_erro = e
    raise RuntimeError(f"achei o link mas o download falhou ({ultimo_erro})")


# ---------------------------------------------------------------- yt-dlp (Insta, TikTok, FB, YT)
def baixar_ytdlp(url, log):
    try:
        import yt_dlp
    except ImportError:
        raise RuntimeError("falta instalar o yt-dlp: rode  pip install -U yt-dlp")

    arquivos = []

    def gancho(d):
        if d.get("status") == "finished":
            arquivos.append(d.get("filename"))

    base = {
        "outtmpl": os.path.join(PASTA, "%(extractor_key)s_%(uploader_id|uploader|)s_%(id)s.%(ext)s"),
        "format": "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
        "merge_output_format": "mp4",
        "quiet": True,
        "no_warnings": True,
        "noplaylist": False,  # carrossel do Insta baixa todos
        "progress_hooks": [gancho],
        "http_headers": {"Accept-Language": "pt-BR,pt;q=0.9"},
    }
    # 1ª tentativa sem login; se falhar, usa o login do seu navegador (Insta costuma exigir)
    tentativas = [None] + NAVEGADORES
    ultimo_erro = None
    for nav in tentativas:
        opts = dict(base)
        if nav:
            opts["cookiesfrombrowser"] = (nav,)
            log(f"Tentando com o login do {nav}...")
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.download([url])
            if arquivos:
                return ", ".join(os.path.basename(a) for a in dict.fromkeys(arquivos))
        except Exception as e:
            msg = str(e).splitlines()[0][:200]
            # erro de "navegador não instalado" não é o motivo real; guarda o primeiro erro de verdade
            if ultimo_erro is None or "cookies" not in msg.lower():
                if ultimo_erro is None or "cookies" in ultimo_erro.lower():
                    ultimo_erro = msg
    raise RuntimeError(f"não consegui baixar ({ultimo_erro}). Se for Instagram, entre na sua conta "
                       "do Instagram no Chrome ou Edge e tente de novo.")


def baixar(url, log=print):
    url = url.strip()
    if not url:
        return None
    os.makedirs(PASTA, exist_ok=True)
    host = urllib.parse.urlparse(url).netloc.lower()
    if "kwai" in host or "kw.ai" in host:
        try:
            return os.path.basename(baixar_kwai(url, log))
        except Exception as e:
            log(f"Leitor do Kwai falhou ({e}); tentando pelo yt-dlp...")
    return baixar_ytdlp(url, log)


# ---------------------------------------------------------------- página no navegador
PAGINA = """<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Baixador de Vídeos</title>
<style>
body{font-family:system-ui,Segoe UI,Arial;background:#0f172a;color:#e2e8f0;margin:0;padding:32px}
.box{max-width:720px;margin:auto}h1{margin:0 0 4px}p{color:#94a3b8;margin:0 0 20px}
textarea{width:100%;height:140px;border-radius:10px;border:1px solid #334155;background:#1e293b;color:#fff;padding:12px;font-size:15px;box-sizing:border-box}
button{margin-top:12px;background:#22c55e;color:#04210f;border:0;border-radius:10px;padding:12px 22px;font-weight:700;font-size:16px;cursor:pointer}
button:disabled{opacity:.5}#log{margin-top:20px;background:#020617;border-radius:10px;padding:14px;white-space:pre-wrap;font-family:ui-monospace,Consolas,monospace;font-size:13px;min-height:60px}
.ok{color:#4ade80}.err{color:#f87171}
</style></head><body><div class="box">
<h1>Baixador de Vídeos</h1>
<p>Instagram (reels, posts, carrossel) · Kwai · TikTok · Facebook · YouTube Shorts. Cole um link por linha.</p>
<textarea id="links" placeholder="https://www.instagram.com/reel/...&#10;https://k.kwai.com/p/..."></textarea>
<button id="btn" onclick="ir()">Baixar</button> <button onclick="fetch('/abrir')" style="background:#334155;color:#fff">Abrir pasta</button>
<div id="log">Os vídeos vão para a pasta Videos_Baixados.</div></div>
<script>
async function ir(){
 const b=document.getElementById('btn'),L=document.getElementById('log');
 const links=document.getElementById('links').value.split(/\\s+/).filter(x=>x.startsWith('http'));
 if(!links.length){L.textContent='Cole pelo menos um link.';return}
 b.disabled=true;L.innerHTML='';
 for(const u of links){
  L.innerHTML+='⏳ '+u+'\\n';
  try{const r=await fetch('/baixar',{method:'POST',body:JSON.stringify({url:u})});const j=await r.json();
   L.innerHTML+=j.ok?'<span class="ok">✔ '+j.arquivo+'</span>\\n':'<span class="err">✖ '+j.erro+'</span>\\n';
  }catch(e){L.innerHTML+='<span class="err">✖ '+e+'</span>\\n'}
 }
 L.innerHTML+='\\nPronto.';b.disabled=false;
}
</script></body></html>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        dados = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(dados)

    def do_GET(self):
        if self.path == "/abrir":
            os.makedirs(PASTA, exist_ok=True)
            if sys.platform.startswith("win"):
                os.startfile(PASTA)
            else:
                os.system(f'{"open" if sys.platform == "darwin" else "xdg-open"} "{PASTA}"')
            return self._json({"ok": True})
        dados = PAGINA.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(dados)

    def do_POST(self):
        tam = int(self.headers.get("Content-Length", 0))
        url = json.loads(self.rfile.read(tam) or b"{}").get("url", "")
        try:
            arq = baixar(url, log=lambda m: print("  ", m))
            print("OK:", arq)
            self._json({"ok": True, "arquivo": arq})
        except Exception as e:
            print("ERRO:", e)
            self._json({"ok": False, "erro": str(e)})


def main():
    links = [a for a in sys.argv[1:] if a.startswith("http")]
    if links:
        for u in links:
            try:
                print("OK:", baixar(u))
            except Exception as e:
                print("ERRO:", u, "->", e)
        return
    srv = ThreadingHTTPServer(("127.0.0.1", PORTA), Handler)
    endereco = f"http://127.0.0.1:{PORTA}"
    print(f"Baixador aberto em {endereco}  (feche esta janela para encerrar)")
    threading.Timer(1, lambda: webbrowser.open(endereco)).start()
    srv.serve_forever()


if __name__ == "__main__":
    main()
