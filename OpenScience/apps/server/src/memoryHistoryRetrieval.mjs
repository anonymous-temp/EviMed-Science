/** Request-local lexical ranking of engine resources. No retained transcript or
 * second index: source authority and privacy checks remain in MemoryHistory. */
export function historyTokens(text) {
  const lower = String(text).normalize('NFKC').toLowerCase();
  const words = [...(lower.replace(/\p{Script=Han}+/gu, ' ').match(/[\p{L}\p{N}_]+/gu) ?? [])];
  for (const run of lower.match(/\p{Script=Han}+/gu) ?? []) {
    const chars = [...run];
    if (chars.length === 1) words.push(run);
    for (let i = 0; i < chars.length - 1; i++) words.push(chars[i] + chars[i + 1]);
  }
  return words;
}

/** Parse only explicit calendar syntax; no inferred dates or model call. */
export function historyPeriods(query) {
  const periods = [...String(query).matchAll(/\b(\d{4})-(\d{2})(?:-(\d{2}))?\b/g)].map(m=>m[0]);
  const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  for (const match of String(query).toLowerCase().matchAll(/\b([a-z]+)\s+(\d{1,2},?\s+)?(\d{4})\b/g)) {
    const month = months.indexOf(match[1]);
    if (month >= 0) periods.push(`${match[3]}-${String(month+1).padStart(2,'0')}${match[2] ? `-${match[2].replace(/\D/g,'').padStart(2,'0')}` : ''}`);
  }
  for (const m of String(query).matchAll(/(\d{4})年(\d{1,2})月(?:(\d{1,2})日)?/g)) periods.push(`${m[1]}-${m[2].padStart(2,'0')}${m[3] ? `-${m[3].padStart(2,'0')}` : ''}`);
  return [...new Set(periods)].slice(0,8);
}

/** Exchanges, including a carried assistant fragment as its own window. */
export function historyWindows(messages) {
  const windows = []; let group = [];
  for (const message of messages) {
    if (message.sourceRole === 'user' && group.length) { windows.push(group); group = []; }
    group.push(message);
  }
  if (group.length) windows.push(group);
  return windows;
}

/** BM25 k1=1.2, b=.75, document frequency over returned chunks. Scoring the
 * best exchange avoids diluting a short match with adjacent carried text. */
export function historyLexicalScorer(records, query) {
  const terms = [...new Set(historyTokens(query))].slice(0,128);
  const documents = records.map(record => historyTokens(record.messages.map(m=>m.text).join('\n')));
  const frequencies = new Map();
  for (const words of documents) for (const word of new Set(words)) frequencies.set(word,(frequencies.get(word)??0)+1);
  const lengths = records.flatMap(record=>historyWindows(record.messages).map(w=>historyTokens(w.map(m=>m.text).join('\n')).length));
  const average = lengths.reduce((a,b)=>a+b,0)/(lengths.length||1)||1;
  const periods = historyPeriods(query);
  const score = messages => {
    const words = historyTokens(messages.map(m=>m.text).join('\n')), counts = new Map();
    for (const word of words) counts.set(word,(counts.get(word)??0)+1);
    let value = 0;
    for (const term of terms) {
      const tf = counts.get(term)??0;
      if (!tf) continue;
      const df = frequencies.get(term)??0;
      value += Math.log(1+(records.length-df+.5)/(df+.5))*tf*2.2/(tf+1.2*(.25+.75*words.length/average));
    }
    if (periods.some(period=>messages.some(m=>m.date?.startsWith(period)))) value *= 1.2;
    return value;
  };
  return { score, rarity: term => Math.log(1+(records.length-(frequencies.get(term)??0)+.5)/((frequencies.get(term)??0)+.5)),
    best: messages => historyWindows(messages).map((window,index)=>({messages:window,index,score:score(window)})).sort((a,b)=>b.score-a.score||a.index-b.index)[0] };
}

/** Prefer two chunks per conversation before filling from the deferred tail.
 * Resource paths group candidates only; registry checks still authorize hits. */
export function diverseHistoryCandidates(candidates, key = candidate => candidate.uri.slice(0,candidate.uri.lastIndexOf('/'))) {
  const counts = new Map(), first = [], rest = [], seen = new Set();
  for (const candidate of candidates) {
    if (typeof candidate?.uri!=='string') continue;
    if (seen.has(candidate.uri)) continue;
    seen.add(candidate.uri);
    const group = key(candidate), count = counts.get(group)??0;
    (count < 2 ? first : rest).push(candidate); counts.set(group,count+1);
  }
  return [...first,...rest];
}

/** Keep an exchange around its matching words inside the old 8*6000 budget.
 * Called only after full-message rejection/provenance checks. */
export function compactHistoryMessages(messages, query, scorer, maxChars, seen) {
  const terms = historyTokens(query);
  const windows = historyWindows(messages).map((window,index)=>({ window,index,score:scorer.score(window) }))
    .sort((a,b)=>b.score-a.score||a.index-b.index);
  const window = windows.find(w=>w.window.some(m=>!seen.has(`${m.index}\0${m.text}`)))?.window ?? [];
  const fresh = window.filter(m=>!seen.has(`${m.index}\0${m.text}`));
  const allowance = Math.max(1,Math.floor(maxChars/(fresh.length||1))-80);
  return fresh.map(message=>{
    seen.add(`${message.index}\0${message.text}`);
    if (message.text.length <= allowance) return message;
    const lower = message.text.toLowerCase();
    const matches = terms.map(term=>({ at:lower.indexOf(term),rarity:scorer.rarity(term) })).filter(m=>m.at>=0).sort((a,b)=>b.rarity-a.rarity);
    const start = Math.max(0,Math.min((matches[0]?.at??0)-Math.floor(allowance/3),message.text.length-allowance));
    return { ...message,text:`${start ? '…' : ''}${message.text.slice(start,start+allowance-2)}${start+allowance-2 < message.text.length ? '…' : ''}` };
  });
}
