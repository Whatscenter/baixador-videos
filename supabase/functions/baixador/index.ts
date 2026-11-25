// Baixador de vídeos — função única do Supabase.
// Segredos (Supabase > Edge Functions > Secrets): SCRAPECREATORS_API_KEY e BX_SENHA.
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const SC = "https://api.scrapecreators.com";
const BUCKET = "baixador";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-senha, authorization, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ---------------------------------------------------------------- utilidades
function achar(obj: any, nomes: string[], prof = 0): any {
  if (!obj || prof > 8) return undefined;
  if (Array.isArray(obj)) {
    for (const v of obj) { const r = achar(v, nomes, prof + 1); if (r !== undefined) return r; }
    return undefined;
  }
  if (typeof obj === "object") {
    for (const n of nomes) if (obj[n] !== undefined && obj[n] !== null && obj[n] !== "") return obj[n];
    for (const v of Object.values(obj)) if (v && typeof v === "object") {
      const r = achar(v, nomes, prof + 1); if (r !== undefined) return r;
    }
  }
  return undefined;
}

// acha a lista de posts dentro da resposta, seja qual for o formato
function acharItens(obj: any, prof = 0): any[] {
  if (!obj || prof > 6) return [];
  if (Array.isArray(obj)) {
    const ok = obj.filter((x) => x && typeof x === "object" && (x.code || x.shortcode || x.pk || x.media || x.node));
    if (ok.length) return obj;
    for (const v of obj) { const r = acharItens(v, prof + 1); if (r.length) return r; }
    return [];
  }
  if (typeof obj === "object") for (const v of Object.values(obj)) { const r = acharItens(v, prof + 1); if (r.length) return r; }
  return [];
}

function lerPost(item: any) {
  let m = item;
  for (let i = 0; i < 4 && m && !(m.code || m.shortcode); i++) m = m.media ?? m.node ?? m.data ?? m;
  m = m ?? {};
  const code = m.code ?? m.shortcode;
  const id = String(m.pk ?? m.id ?? code ?? "").split("_")[0];
  const video = m.video_url ?? m.video_versions?.[0]?.url ?? achar(m, ["video_url"]);
  const legenda = typeof m.caption === "string" ? m.caption
    : m.caption?.text ?? m.edge_media_to_caption?.edges?.[0]?.node?.text ?? "";
  const taken = m.taken_at ?? m.taken_at_timestamp;
  return {
    post_id: code ?? id,
    url: code ? `https://www.instagram.com/reel/${code}/` : null,
    autor: m.user?.username ?? m.owner?.username ?? null,
    legenda,
    views: m.play_count ?? m.ig_play_count ?? m.video_play_count ?? m.video_view_count ?? m.view_count ?? null,
    likes: m.like_count ?? m.edge_media_preview_like?.count ?? m.edge_liked_by?.count ?? null,
    publicado_em: taken ? new Date(Number(taken) * 1000).toISOString() : null,
    video_origem: video ?? null,
    thumb_origem: m.image_versions2?.candidates?.[0]?.url ?? m.display_url ?? m.thumbnail_src ?? m.thumbnail_url ?? null,
  };
}

async function sc(caminho: string, params: Record<string, string>) {
  const chave = Deno.env.get("SCRAPECREATORS_API_KEY");
  if (!chave) throw new Error("Falta o segredo SCRAPECREATORS_API_KEY no Supabase");
  const r = await fetch(`${SC}${caminho}?${new URLSearchParams({ ...params, trim: "true" })}`, {
    headers: { "x-api-key": chave },
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`ScrapeCreators ${r.status}: ${t.slice(0, 200)}`);
  return JSON.parse(t);
}

async function config() {
  const { data } = await sb.from("bx_config").select("*").eq("id", 1).single();
  return data!;
}

// ---------------------------------------------------------------- Instagram
async function checarPerfil(p: any, cfg: any) {
  try {
    let uid = p.user_id;
    if (!uid) {
      const perfil = await sc("/v1/instagram/profile", { handle: p.usuario });
      uid = String(achar(perfil, ["id", "pk", "user_id"]) ?? "");
      if (!uid) throw new Error("não achei esse @ no Instagram");
      await sb.from("bx_perfis").update({ user_id: uid }).eq("id", p.id);
    }
    const dados = await sc("/v1/instagram/user/reels", { user_id: uid });
    const itens = acharItens(dados);
    await sb.from("bx_config").update({ debug: { quando: new Date(), perfil: p.usuario, chaves: Object.keys(dados ?? {}), exemplo: JSON.stringify(itens[0] ?? dados).slice(0, 3000) } }).eq("id", 1);

    const posts = itens.map(lerPost).filter((x) => x.post_id && x.video_origem);
    // na primeira checagem, só os mais recentes; depois, tudo que for novo
    const lista = p.ultima_checagem ? posts : posts.slice(0, cfg.max_por_perfil);
    const linhas = lista.map((x) => ({ ...x, autor: x.autor ?? p.usuario, perfil_id: p.id, plataforma: "instagram" }));
    let novos = 0;
    if (linhas.length) {
      const { data } = await sb.from("bx_posts").upsert(linhas, { onConflict: "plataforma,post_id", ignoreDuplicates: true }).select("id");
      novos = data?.length ?? 0;
    }
    await sb.from("bx_perfis").update({ ultima_checagem: new Date().toISOString(), ultimo_erro: null }).eq("id", p.id);
    return { usuario: p.usuario, encontrados: posts.length, novos };
  } catch (e) {
    await sb.from("bx_perfis").update({ ultima_checagem: new Date().toISOString(), ultimo_erro: String(e).slice(0, 300) }).eq("id", p.id);
    return { usuario: p.usuario, erro: String(e) };
  }
}

async function postPorLink(url: string) {
  if (/kwai|kw\.ai/i.test(url)) return await kwaiPorLink(url);
  if (!/instagram\.com/i.test(url)) throw new Error("por enquanto: links do Instagram ou do Kwai");
  const dados = await sc("/v1/instagram/post", { url });
  const item = achar(dados, ["xdt_shortcode_media", "shortcode_media", "media"]) ?? dados?.data ?? dados;
  const x = lerPost(item);
  if (!x.video_origem) throw new Error("esse post não tem vídeo");
  const linha = { ...x, url, plataforma: "instagram" };
  const { data, error } = await sb.from("bx_posts").upsert(linha, { onConflict: "plataforma,post_id" }).select("id").single();
  if (error) throw error;
  return data.id;
}

// ---------------------------------------------------------------- Kwai (por link)
async function kwaiPorLink(url: string) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "pt-BR,pt;q=0.9" }, redirect: "follow" });
  const final = r.url;
  const t = (await r.text()).replaceAll("\\u002F", "/").replaceAll("\\/", "/").replaceAll("&amp;", "&");
  const cands: string[] = [];
  for (const m of t.matchAll(/<meta[^>]+(?:property|name)="og:video(?::secure_url|:url)?"[^>]+content="([^"]+)"/g)) cands.push(m[1]);
  for (const k of ["srcNoMark", "mainMvUrls", "main_mv_urls", "photoUrl", "videoUrl", "playUrl", "contentUrl"]) {
    const re = new RegExp(`"${k}"\\s*:\\s*(?:\\[\\s*\\{[^\\]]*?"url"\\s*:\\s*)?"(https?://[^"]+)"`, "g");
    for (const m of t.matchAll(re)) cands.push(m[1]);
  }
  for (const m of t.matchAll(/https?:\/\/[^\s"'<>]+?\.mp4[^\s"'<>]*/g)) cands.push(m[0]);
  const lista = [...new Set(cands)].sort((a, b) => Number(!/nomark/i.test(a)) - Number(!/nomark/i.test(b)));
  if (!lista.length) throw new Error("não achei o vídeo na página do Kwai");
  const titulo = t.match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/)?.[1] ?? "";
  const desc = t.match(/<meta[^>]+(?:property="og:description"|name="description")[^>]+content="([^"]*)"/)?.[1] ?? "";
  const thumb = t.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/)?.[1] ?? null;
  const pid = final.match(/\/video\/(\d+)/)?.[1] ?? final.match(/photoId=(\d+)/)?.[1] ?? crypto.randomUUID();
  const autor = final.match(/@([\w.\-]+)/)?.[1] ?? null;
  const linha = { plataforma: "kwai", post_id: pid, url: final, autor, legenda: desc || titulo, video_origem: lista[0], thumb_origem: thumb };
  const { data, error } = await sb.from("bx_posts").upsert(linha, { onConflict: "plataforma,post_id" }).select("id").single();
  if (error) throw error;
  return data.id;
}

// ---------------------------------------------------------------- downloads
async function baixarArquivo(url: string, referer?: string) {
  const r = await fetch(url, { headers: { "User-Agent": UA, ...(referer ? { Referer: referer } : {}) } });
  if (!r.ok) throw new Error(`download ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

async function processarUm(p: any) {
  try {
    const pasta = `${p.plataforma}/${(p.autor ?? "link").replace(/[^\w.\-]/g, "")}`;
    const video = await baixarArquivo(p.video_origem, p.url ?? undefined);
    if (video.length < 30_000) throw new Error("arquivo de vídeo veio vazio");
    const arquivo = `${pasta}/${p.post_id}.mp4`;
    const up = await sb.storage.from(BUCKET).upload(arquivo, video, { contentType: "video/mp4", upsert: true });
    if (up.error) throw up.error;
    let thumb = null;
    if (p.thumb_origem) {
      try {
        const img = await baixarArquivo(p.thumb_origem);
        thumb = `${pasta}/${p.post_id}.jpg`;
        await sb.storage.from(BUCKET).upload(thumb, img, { contentType: "image/jpeg", upsert: true });
      } catch { thumb = null; }
    }
    await sb.from("bx_posts").update({ status: "baixado", arquivo, thumb, erro: null }).eq("id", p.id);
    return true;
  } catch (e) {
    await sb.from("bx_posts").update({
      status: p.tentativas + 1 >= 3 ? "erro" : "pendente", tentativas: p.tentativas + 1, erro: String(e).slice(0, 300),
    }).eq("id", p.id);
    return false;
  }
}

async function processar(limite = 3) {
  const { data } = await sb.from("bx_posts").select("*").eq("status", "pendente").lt("tentativas", 3)
    .order("criado_em", { ascending: true }).limit(limite);
  let baixados = 0;
  for (const p of data ?? []) if (await processarUm(p)) baixados++;
  return { processados: data?.length ?? 0, baixados };
}

async function limpar(cfg: any) {
  const corte = new Date(Date.now() - cfg.dias_guardar * 86400_000).toISOString();
  const { data } = await sb.from("bx_posts").select("id, arquivo, thumb").eq("status", "baixado").eq("guardar", false)
    .lt("criado_em", corte).limit(100);
  for (const p of data ?? []) await apagar(p);
  return data?.length ?? 0;
}

async function apagar(p: any) {
  const arqs = [p.arquivo, p.thumb].filter(Boolean);
  if (arqs.length) await sb.storage.from(BUCKET).remove(arqs);
  await sb.from("bx_posts").update({ status: "apagado", arquivo: null, thumb: null }).eq("id", p.id);
}

async function assinar(caminho: string | null, baixar?: string) {
  if (!caminho) return null;
  const { data } = await sb.storage.from(BUCKET).createSignedUrl(caminho, 3600, baixar ? { download: baixar } : undefined);
  return data?.signedUrl ?? null;
}

// ---------------------------------------------------------------- rotas
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let corpo: any = {};
  try { corpo = await req.json(); } catch { /* vazio */ }
  const acao = corpo.acao as string;
  const cfg = await config();

  // rotinas automáticas (pg_cron)
  if (acao?.startsWith("cron_")) {
    if (corpo.secret !== cfg.cron_secret) return json({ erro: "não autorizado" }, 401);
    if (acao === "cron_checar") {
      const { data: perfis } = await sb.from("bx_perfis").select("*").eq("ativo", true);
      const res = [];
      for (const p of perfis ?? []) res.push(await checarPerfil(p, cfg));
      return json({ ok: true, res });
    }
    if (acao === "cron_processar") return json({ ok: true, ...(await processar(3)), limpos: await limpar(cfg) });
    return json({ erro: "ação desconhecida" }, 400);
  }

  // app (senha)
  const senha = Deno.env.get("BX_SENHA");
  if (!senha) return json({ erro: "Falta o segredo BX_SENHA no Supabase" }, 500);
  if (req.headers.get("x-senha") !== senha) return json({ erro: "senha errada" }, 401);

  try {
    switch (acao) {
      case "entrar": return json({ ok: true });
      case "listar": {
        const { data: perfis } = await sb.from("bx_perfis").select("*").order("usuario");
        const { data: posts } = await sb.from("bx_posts").select("*").neq("status", "apagado")
          .order("criado_em", { ascending: false }).limit(150);
        const comLinks = await Promise.all((posts ?? []).map(async (p) => ({
          ...p,
          thumb_url: await assinar(p.thumb),
          video_url: await assinar(p.arquivo),
          baixar_url: await assinar(p.arquivo, `${p.autor ?? "video"}_${p.post_id}.mp4`),
        })));
        const { data: uso } = await sb.rpc("bx_uso");
        return json({ perfis, posts: comLinks, uso_bytes: uso ?? 0, dias_guardar: cfg.dias_guardar });
      }
      case "add_perfil": {
        const usuario = String(corpo.usuario ?? "").trim().replace(/^@/, "").replace(/.*instagram\.com\//, "").replace(/[/?].*$/, "").toLowerCase();
        if (!/^[\w.]{1,30}$/.test(usuario)) return json({ erro: "@ inválido" }, 400);
        const { data, error } = await sb.from("bx_perfis").upsert({ usuario, plataforma: "instagram", ativo: true }, { onConflict: "plataforma,usuario" }).select("*").single();
        if (error) throw error;
        const res = await checarPerfil(data, cfg);
        const proc = await processar(2);
        return json({ ok: true, res, proc });
      }
      case "del_perfil": {
        await sb.from("bx_perfis").delete().eq("id", corpo.id);
        return json({ ok: true });
      }
      case "pausar_perfil": {
        await sb.from("bx_perfis").update({ ativo: !!corpo.ativo }).eq("id", corpo.id);
        return json({ ok: true });
      }
      case "checar_agora": {
        let q = sb.from("bx_perfis").select("*").eq("ativo", true);
        if (corpo.id) q = sb.from("bx_perfis").select("*").eq("id", corpo.id);
        const { data: perfis } = await q;
        const res = [];
        for (const p of perfis ?? []) res.push(await checarPerfil(p, cfg));
        return json({ ok: true, res, proc: await processar(2) });
      }
      case "link": {
        const id = await postPorLink(String(corpo.url ?? "").trim());
        const { data: p } = await sb.from("bx_posts").select("*").eq("id", id).single();
        if (p.status !== "baixado") { await sb.from("bx_posts").update({ status: "pendente", tentativas: 0 }).eq("id", id); await processarUm({ ...p, tentativas: 0 }); }
        const { data: depois } = await sb.from("bx_posts").select("status, erro").eq("id", id).single();
        return json({ ok: depois?.status === "baixado", ...depois });
      }
      case "processar": return json({ ok: true, ...(await processar(3)) });
      case "marcar": {
        const campos: any = {};
        if ("guardar" in corpo) campos.guardar = !!corpo.guardar;
        if ("postado" in corpo) campos.postado = !!corpo.postado;
        await sb.from("bx_posts").update(campos).eq("id", corpo.id);
        return json({ ok: true });
      }
      case "tentar_de_novo": {
        const { data: p } = await sb.from("bx_posts").update({ status: "pendente", tentativas: 0, erro: null })
          .eq("id", corpo.id).select("*").single();
        const baixou = p ? await processarUm(p) : false;
        return json({ ok: baixou });
      }
      case "apagar": {
        const { data: p } = await sb.from("bx_posts").select("id, arquivo, thumb").eq("id", corpo.id).single();
        if (p) await apagar(p);
        return json({ ok: true });
      }
      case "debug": return json({ debug: cfg.debug });
      default: return json({ erro: "ação desconhecida" }, 400);
    }
  } catch (e) {
    return json({ erro: String((e as Error)?.message ?? e) }, 500);
  }
});
