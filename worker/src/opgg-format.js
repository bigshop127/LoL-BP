// OP.GG 資料介面（mcp-api.op.gg）回傳的精簡文字格式解析器。
//
// 格式長這樣：
//   class LolListChampions: data
//   class Data: champions
//   class Champion: champion_id,key,name
//
//   LolListChampions(Data([Champion(1,"Annie","Annie"),Champion(2,"Olaf","Olaf")]))
//
// 前面幾行 class 宣告欄位順序，最後一行是「類別名(參數…)」的巢狀呼叫。
// 解析成一般 JS 物件：Champion(1,"Annie","Annie") → { champion_id: 1, key: "Annie", name: "Annie" }

export function parseOpggText(text) {
  const lines = String(text).split('\n');
  const classes = {};
  const bodyLines = [];
  for (const line of lines) {
    const m = /^class\s+(\w+):\s*(.*)$/.exec(line);
    if (m) {
      classes[m[1]] = m[2].split(',').map(s => s.trim()).filter(Boolean);
    } else if (line.trim()) {
      bodyLines.push(line);
    }
  }
  const src = bodyLines.join('\n');
  let pos = 0;

  const fail = (msg) => { throw new Error(`OP.GG 格式解析失敗：${msg}（位置 ${pos}）`); };
  const skipWs = () => { while (pos < src.length && /\s/.test(src[pos])) pos++; };

  function parseString() {
    const start = pos;
    pos++; // 開頭的 "
    while (pos < src.length) {
      const ch = src[pos];
      if (ch === '\\') { pos += 2; continue; }
      if (ch === '"') { pos++; return JSON.parse(src.slice(start, pos)); }
      pos++;
    }
    fail('字串沒有結尾');
  }

  function parseList() {
    pos++; // [
    const out = [];
    skipWs();
    if (src[pos] === ']') { pos++; return out; }
    for (;;) {
      out.push(parseValue());
      skipWs();
      if (src[pos] === ',') { pos++; continue; }
      if (src[pos] === ']') { pos++; return out; }
      fail('清單缺少 , 或 ]');
    }
  }

  function parseValue() {
    skipWs();
    const ch = src[pos];
    if (ch === '"') return parseString();
    if (ch === '[') return parseList();
    const num = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(src.slice(pos, pos + 40));
    if (num) { pos += num[0].length; return Number(num[0]); }
    const word = /^[A-Za-z_]\w*/.exec(src.slice(pos, pos + 200));
    if (!word) fail(`看不懂的字元 ${JSON.stringify(ch)}`);
    pos += word[0].length;
    if (word[0] === 'true') return true;
    if (word[0] === 'false') return false;
    if (word[0] === 'null' || word[0] === 'None') return null;
    skipWs();
    if (src[pos] !== '(') fail(`${word[0]} 後面應該是 (`);
    pos++;
    const args = [];
    skipWs();
    if (src[pos] === ')') {
      pos++;
    } else {
      for (;;) {
        args.push(parseValue());
        skipWs();
        if (src[pos] === ',') { pos++; continue; }
        if (src[pos] === ')') { pos++; break; }
        fail('參數缺少 , 或 )');
      }
    }
    const fields = classes[word[0]];
    if (!fields) return args;
    const obj = {};
    fields.forEach((f, i) => { obj[f] = i < args.length ? args[i] : null; });
    return obj;
  }

  const result = parseValue();
  skipWs();
  if (pos < src.length) fail('結尾有多餘內容');
  return result;
}
