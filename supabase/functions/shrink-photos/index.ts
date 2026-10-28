// Surdejsloggen – skalerer eksisterende billeder ned og laver miniaturer (engangsjob).
// Kaldes kun fra databasen med den hemmelige header. Body: { names: ["<bruger>/<id>.jpg", ...] }
import { Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const MAX = 1080, THUMB = 360;

function fit(img: Image, max: number) {
  const k = Math.min(1, max / Math.max(img.width, img.height));
  return k < 1 ? img.resize(Math.round(img.width * k), Math.round(img.height * k)) : img;
}
function cover(img: Image, side: number) {
  // korteste side = side (miniaturen vises beskåret som firkant)
  const k = Math.min(1, side / Math.min(img.width, img.height));
  return k < 1 ? img.resize(Math.round(img.width * k), Math.round(img.height * k)) : img;
}

Deno.serve(async (req) => {
  const { data: cfg, error } = await sb.rpc("get_push_config");
  if (error || req.headers.get("x-push-secret") !== (cfg as Record<string, string>).push_hook_secret) {
    return new Response("forbidden", { status: 403 });
  }
  const { names } = await req.json() as { names: string[] };
  const out: unknown[] = [];
  for (const name of names || []) {
    if (!/^[0-9a-f-]+\/[0-9a-z_-]+\.jpg$/i.test(name) || name.endsWith(".t.jpg")) { out.push({ name, skip: "name" }); continue; }
    try {
      const { data: blob, error: dErr } = await sb.storage.from("photos").download(name);
      if (dErr || !blob) throw dErr || new Error("no data");
      const before = blob.size;
      const img = await Image.decode(new Uint8Array(await blob.arrayBuffer()));
      const w0 = img.width, h0 = img.height;
      let after = before;
      if (Math.max(w0, h0) > MAX || before > 230_000) {
        const big = await fit(img.clone(), MAX).encodeJPEG(72);
        if (big.length < before) {
          const { error: e1 } = await sb.storage.from("photos").upload(name, big, { contentType: "image/jpeg", upsert: true, cacheControl: "31536000" });
          if (e1) throw e1;
          after = big.length;
        }
      }
      const thumb = await cover(img, THUMB).encodeJPEG(70);
      const { error: e2 } = await sb.storage.from("photos").upload(name.replace(/\.jpg$/i, ".t.jpg"), thumb, { contentType: "image/jpeg", upsert: true, cacheControl: "31536000" });
      if (e2) throw e2;
      out.push({ name, w: w0, h: h0, before, after, thumb: thumb.length });
    } catch (e) {
      out.push({ name, error: String((e as Error)?.message || e) });
    }
  }
  return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json" } });
});
