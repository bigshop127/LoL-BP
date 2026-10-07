// LoL-BP 的 OP.GG 代轉（Cloudflare Worker）
//
// 瀏覽器不能直接跟 OP.GG 要資料（沒有 CORS），所以由這支 Worker 代為呼叫
// OP.GG 官方開放的資料介面 mcp-api.op.gg，整理成精簡 JSON 後回給網頁。
// 只有網頁開啟創造者模式時才會呼叫。
//
//   GET /meta                                 各路英雄勝率／登場率／禁用率
//   GET /matchup?champ=103&pos=mid&vs=134     該英雄在該路對上各英雄的戰績（用英雄數字 id）

import { parseOpggText } from './opgg-format.js';

const MCP_URL = 'https://mcp-api.op.gg/mcp';
const POSITIONS = ['top', 'jungle', 'mid', 'adc', 'support'];
const META_TTL = 30 * 60;        // 秒
const MATCHUP_TTL = 3 * 60 * 60; // 秒

const ALLOWED_ORIGINS = ['https://bigshop127.github.io'];
const isAllowedOrigin = (origin) =>
  ALLOWED_ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

// 同一個 isolate 內的記憶體快取（workers.dev 上 Cache API 不一定有作用，兩層都用）
const memCache = new Map();

async function callOpgg(name, args) {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  if (!res.ok) throw new Error(`OP.GG 回應 HTTP ${res.status}`);
  const raw = await res.text();
  let payload;
  if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
    const dataLine = raw.split('\n').filter(l => l.startsWith('data:')).pop();
    payload = JSON.parse(dataLine ? dataLine.slice(5) : 'null');
  } else {
    payload = JSON.parse(raw);
  }
  if (!payload) throw new Error('OP.GG 沒有回傳資料');
  if (payload.error) throw new Error(`OP.GG 錯誤：${payload.error.message}`);
  if (payload.result?.isError) throw new Error(`OP.GG 錯誤：${(payload.result.content || []).map(c => c.text).join(' ')}`);
  return (payload.result?.content || []).map(c => c.text).join('');
}

const round = (x, d = 4) => (typeof x === 'number' ? Math.round(x * 10 ** d) / 10 ** d : null);

// OP.GG 的英雄清單混有同名的特殊版本（例如 60103 Jade_Ahri），只留一般英雄（id < 10000）
function champListFrom(text) {
  return (parseOpggText(text)?.data?.champions || [])
    .filter(c => Number.isInteger(c.champion_id) && c.champion_id < 10000 && !String(c.key).includes('_'));
}

async function getChampionList() {
  const text = await callOpgg('lol_list_champions', { lang: 'en_US', desired_output_fields: ['data.champions[].{champion_id,key,name}'] });
  return champListFrom(text);
}

// 對位工具要的英雄名稱格式：英文名去掉 ' . &，空白換底線，全大寫（Kai'Sa→KAISA、Dr. Mundo→DR_MUNDO）
export const toOpggName = (name) =>
  String(name).replace(/['.]/g, '').replace(/&/g, ' ').trim().split(/\s+/).join('_').toUpperCase();

export async function getMeta() {
  const posFields = POSITIONS.map(p =>
    `data.positions.${p}[].{champion,play,win_rate,pick_rate,ban_rate,role_rate,tier,rank,is_rip}`);
  const [champList, metaText] = await Promise.all([
    getChampionList(),
    callOpgg('lol_list_lane_meta_champions', { lang: 'en_US', position: 'all', desired_output_fields: posFields }),
  ]);

  const byName = new Map(champList.map(c => [c.name, c]));
  const positions = parseOpggText(metaText)?.data?.positions || {};

  const champions = {};
  const unmatched = [];
  for (const pos of POSITIONS) {
    for (const row of positions[pos] || []) {
      const c = byName.get(row.champion);
      if (!c) { unmatched.push(row.champion); continue; }
      const entry = champions[c.champion_id] || (champions[c.champion_id] = { key: c.key, positions: {} });
      entry.positions[pos] = {
        wr: round(row.win_rate), pr: round(row.pick_rate), br: round(row.ban_rate), rr: round(row.role_rate),
        tier: row.tier, rank: row.rank, play: row.play, rip: !!row.is_rip,
      };
    }
  }
  return { source: 'OP.GG', fetchedAt: new Date().toISOString(), champions, unmatched };
}

// champ / vs 是英雄數字 id（跟 Data Dragon 的 key 相同，例如阿璃 = 103）
export async function getMatchup(champ, pos, vs, champList) {
  const list = champList || await getChampionList();
  const me = list.find(c => c.champion_id === champ);
  const opp = list.find(c => c.champion_id === vs);
  if (!me || !opp) throw new Error('找不到英雄');
  const text = await callOpgg('lol_get_lane_matchup_guide', {
    my_champion: toOpggName(me.name), opponent_champion: toOpggName(opp.name), position: pos, lang: 'en_US',
  });
  const j = JSON.parse(text);
  const d = j.data || {};
  const posStats = (d.summary?.positions || []).find(p => String(p.name).toLowerCase() === pos)?.stats || null;
  return {
    source: 'OP.GG',
    fetchedAt: new Date().toISOString(),
    champ, pos, vs,
    counters: (d.counters || []).map(c => ({ id: c.champion_id, play: c.play, win: c.win })),
    tip: typeof d.opponent_champion_tip === 'string' ? d.opponent_champion_tip.slice(0, 600) : '',
    stats: posStats ? { wr: round(posStats.win_rate), pr: round(posStats.pick_rate), br: round(posStats.ban_rate), play: posStats.play } : null,
  };
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function jsonResponse(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

async function cached(key, ttl, producer, ctx) {
  const now = Date.now();
  const mem = memCache.get(key);
  if (mem && mem.expires > now) return mem.body;

  const edge = typeof caches !== 'undefined' ? caches.default : null;
  const cacheReq = new Request(`https://lol-bp-opgg.cache/${encodeURIComponent(key)}`);
  if (edge) {
    const hit = await edge.match(cacheReq);
    if (hit) {
      const body = await hit.text();
      memCache.set(key, { body, expires: now + ttl * 1000 });
      return body;
    }
  }

  const body = JSON.stringify(await producer());
  memCache.set(key, { body, expires: now + ttl * 1000 });
  if (memCache.size > 300) memCache.delete(memCache.keys().next().value);
  if (edge) {
    const put = edge.put(cacheReq, new Response(body, { headers: { 'Cache-Control': `public, max-age=${ttl}` } }));
    if (ctx?.waitUntil) ctx.waitUntil(put); else await put;
  }
  return body;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    if (!isAllowedOrigin(origin)) return jsonResponse({ error: 'origin not allowed' }, 403);
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return jsonResponse({ error: 'method not allowed' }, 405, cors);

    try {
      if (url.pathname === '/meta') {
        const body = await cached('meta', META_TTL, getMeta, ctx);
        return new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors } });
      }
      if (url.pathname === '/matchup') {
        const idOf = (s) => (/^\d{1,5}$/.test(s || '') ? Number(s) : null);
        const champ = idOf(url.searchParams.get('champ'));
        const vs = idOf(url.searchParams.get('vs'));
        const pos = (url.searchParams.get('pos') || '').toLowerCase();
        if (champ === null || vs === null || !POSITIONS.includes(pos)) {
          return jsonResponse({ error: 'bad params' }, 400, cors);
        }
        const champList = JSON.parse(await cached('champions', META_TTL, getChampionList, ctx));
        const key = `matchup:${champ}:${pos}:${vs}`;
        const body = await cached(key, MATCHUP_TTL, () => getMatchup(champ, pos, vs, champList), ctx);
        return new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors } });
      }
      return jsonResponse({ error: 'not found' }, 404, cors);
    } catch (err) {
      return jsonResponse({ error: String(err?.message || err) }, 502, cors);
    }
  },
};
