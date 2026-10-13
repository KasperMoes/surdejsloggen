// Surdejsloggen – sender push-beskeder ved venneanmodninger, nye bagninger, kommentarer,
// "Sprødt!" og når nogen tagger dig (@brugernavn) i en bagning eller en kommentar.
// Kaldes kun af databasen (trigger) med en hemmelig header; ingen bruger-login.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
let cfg: Record<string, string> | null = null;

async function config() {
  if (!cfg) {
    const { data, error } = await sb.rpc("get_push_config");
    if (error) throw error;
    cfg = data as Record<string, string>;
    webpush.setVapidDetails("mailto:" + cfg.push_contact, cfg.vapid_public, cfg.vapid_private);
  }
  return cfg;
}

async function nameOf(id: string) {
  const { data } = await sb.from("profiles").select("username,display_name").eq("id", id).maybeSingle();
  return (data && (data.display_name || data.username)) || "En ven";
}

const short = (t: string, n = 120) => { t = String(t || "").trim(); return t.length > n ? t.slice(0, n - 3) + "…" : t; };

// @brugernavn i en tekst → sæt af brugernavne (små bogstaver)
function mentions(text: string | null | undefined): Set<string> {
  const out = new Set<string>();
  const re = /(^|[^a-z0-9_.@])@([a-z0-9_.]{3,24})/gi;
  let m;
  while ((m = re.exec(String(text || "")))) out.add(m[2].replace(/\.+$/, "").toLowerCase());
  return out;
}

async function friendsOf(uid: string): Promise<string[]> {
  const { data } = await sb.from("friendships").select("requester,addressee")
    .eq("status", "accepted").or(`requester.eq.${uid},addressee.eq.${uid}`);
  return (data || []).map((f) => (f.requester === uid ? f.addressee : f.requester));
}

// Nye tags (ikke dem der stod der før) → bruger-id'er, der må se bagningen, og ikke er forfatteren selv.
async function taggedIds(text: string, oldText: string | null, author: string, bakeOwner: string): Promise<string[]> {
  const before = mentions(oldText);
  const names = [...mentions(text)].filter((n) => !before.has(n));
  if (!names.length) return [];
  const { data } = await sb.from("profiles").select("id,username").in("username", names);
  const canSee = new Set([bakeOwner, ...(await friendsOf(bakeOwner))]);
  return (data || []).map((p) => p.id).filter((id) => id !== author && canSee.has(id));
}

type Msg = { targets: string[]; title: string; body: string; url: string; tag?: string };

Deno.serve(async (req) => {
  try {
    const c = await config();
    if (req.headers.get("x-push-secret") !== c.push_hook_secret) return new Response("forbidden", { status: 403 });
    const ev = await req.json();
    const r = ev.record || {};
    const msgs: Msg[] = [];

    if (ev.table === "friendships") {
      if (ev.type === "INSERT" && r.status === "pending") {
        msgs.push({ targets: [r.addressee], title: "Ny venneanmodning", body: `${await nameOf(r.requester)} vil være venner med dig.`, url: "./#venner" });
      } else if (ev.type === "UPDATE" && r.status === "accepted" && ev.old?.status !== "accepted") {
        msgs.push({ targets: [r.requester], title: "I er nu venner", body: `${await nameOf(r.addressee)} har godkendt din venneanmodning.`, url: "./#feed" });
      }
    } else if (ev.table === "bakes" && (ev.type === "INSERT" || ev.type === "UPDATE")) {
      const who = await nameOf(r.user_id), url = "./#bake-" + r.id;
      const tagged = await taggedIds(r.caption, ev.type === "UPDATE" ? ev.old?.caption : null, r.user_id, r.user_id);
      if (tagged.length) msgs.push({ targets: tagged, title: `${who} har tagget dig`, body: `${r.name || "En bagning"}${r.caption ? ": " + short(r.caption, 100) : ""}`, url, tag: "tag-bake-" + r.id });
      if (ev.type === "INSERT") {
        const friends = (await friendsOf(r.user_id)).filter((id) => !tagged.includes(id));
        msgs.push({ targets: friends, title: `${who} har bagt`, body: `${r.name || "En ny bagning"}${r.overall ? ` · ${r.overall}/5 ★` : ""}`, url });
      }
    } else if (ev.table === "comments" && (ev.type === "INSERT" || ev.type === "UPDATE")) {
      const { data: bake } = await sb.from("bakes").select("id,user_id,name").eq("id", r.bake_id).maybeSingle();
      if (bake) {
        const who = await nameOf(r.user_id), url = "./#bake-" + bake.id;
        const tagged = await taggedIds(r.body, ev.type === "UPDATE" ? ev.old?.body : null, r.user_id, bake.user_id);
        if (tagged.length) msgs.push({ targets: tagged, title: `${who} har tagget dig i en kommentar`, body: short(r.body), url });
        if (ev.type === "INSERT" && bake.user_id !== r.user_id && !tagged.includes(bake.user_id)) {
          msgs.push({ targets: [bake.user_id], title: `${who} kommenterede ${bake.name || "din bagning"}`, body: short(r.body), url });
        }
      }
    } else if (ev.table === "bake_likes" && ev.type === "INSERT") {
      const { data: bake } = await sb.from("bakes").select("id,user_id,name").eq("id", r.bake_id).maybeSingle();
      if (bake && bake.user_id !== r.user_id) {
        msgs.push({ targets: [bake.user_id], title: "Sprødt!", body: `${await nameOf(r.user_id)} synes, dit ${bake.name || "bagværk"} er sprødt.`, url: "./#bake-" + bake.id, tag: "sprodt-" + bake.id });
      }
    }

    let sent = 0;
    for (const m of msgs) {
      if (!m.targets.length) continue;
      const { data: subs } = await sb.from("push_subscriptions").select("*").in("user_id", m.targets);
      const payload = JSON.stringify({ title: m.title, body: m.body, url: m.url, tag: m.tag });
      await Promise.all((subs || []).map(async (s) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 60 * 60 * 24 });
          sent++;
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) await sb.from("push_subscriptions").delete().eq("id", s.id);
          else console.error("push failed", code, (e as Error).message);
        }
      }));
    }
    return new Response("sent " + sent);
  } catch (e) {
    console.error(e);
    return new Response("error", { status: 500 });
  }
});
