// Memory categorisation, relevance and graph construction for the Dashboard mind map.
// Everything is computed locally from the owner's own memory text; nothing leaves the server.

export const CATEGORIES = {
  preference: { label: 'Preferences', words: ['like', 'likes', 'prefer', 'prefers', 'preferred', 'love', 'loves', 'hate', 'hates', 'favorite', 'favourite', 'enjoy', 'enjoys', 'dislike', 'always', 'never', 'want', 'wants', 'style', 'tone'] },
  people: { label: 'People', words: ['wife', 'husband', 'mom', 'mother', 'dad', 'father', 'friend', 'friends', 'brother', 'sister', 'son', 'daughter', 'girlfriend', 'boyfriend', 'partner', 'colleague', 'boss', 'family', 'kids', 'child', 'cousin', 'team', 'birthday', 'name'] },
  work: { label: 'Work & projects', words: ['project', 'projects', 'client', 'clients', 'work', 'job', 'office', 'company', 'business', 'meeting', 'deadline', 'repo', 'repository', 'code', 'coding', 'deploy', 'conclave', 'jarvis', 'github', 'product', 'startup', 'aten', 'build'] },
  routine: { label: 'Routines & schedule', words: ['every', 'daily', 'weekday', 'weekdays', 'weekend', 'morning', 'evening', 'night', 'routine', 'schedule', 'appointment', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'wake', 'remind', 'briefing'] },
  health: { label: 'Health', words: ['health', 'doctor', 'medicine', 'medication', 'allergy', 'allergic', 'gym', 'workout', 'exercise', 'sleep', 'diet', 'vegetarian', 'vegan', 'run', 'running', 'weight', 'hospital'] },
  places: { label: 'Places', words: ['live', 'lives', 'home', 'address', 'city', 'manila', 'philippines', 'location', 'travel', 'trip', 'country', 'house', 'apartment', 'street', 'province', 'commute', 'bicycle', 'bike', 'highway', 'route', 'taguig', 'vietnam', 'quezon', 'barangay', 'mobility', 'motorcycle', 'vehicle', 'jeep'] },
  tech: { label: 'Devices & tech', words: ['raspberry', 'laptop', 'phone', 'device', 'devices', 'windows', 'linux', 'android', 'iphone', 'ipad', 'ssh', 'server', 'cloudflare', 'tunnel', 'network', 'wifi', 'computer', 'desktop', 'tablet', 'pc', 'hardware', 'workstation', 'gpu', 'cpu', 'ssd', 'storage', 'ram', 'memory', 'asus', 'proart', 'nvidia', 'rtx', 'monitor', 'software', 'ai', 'model', 'firmware'] },
  finance: { label: 'Finance', words: ['bank', 'pay', 'payment', 'budget', 'salary', 'bill', 'bills', 'money', 'peso', 'pesos', 'php', 'usd', 'invoice', 'subscription', 'expense', 'expenses', 'savings', 'loan', 'credit', 'grant', 'grants', 'allowance', 'cash', 'incentive', 'incentives', 'price', 'cost', 'liquidity', 'fund', 'funds', 'sponsor', 'sponsorship', 'financial', 'portfolio', 'budgeting'] },
  education: { label: 'School & competitions', words: ['school', 'student', 'grade', 'university', 'research', 'competition', 'challenge', 'award', 'medal', 'gold', 'olympiad', 'fair', 'rstf', 'nstf', 'coach', 'teacher', 'class', 'subject', 'exam', 'thesis', 'degree', 'scholarship', 'academic', 'diliman', 'science', 'robotics', 'contest', 'champion'] },
  general: { label: 'General', words: [] }
};
export const categoryIds = Object.keys(CATEGORIES);

const STOP = new Set(`the and for are but not you your with that this from have has had was were will would can could should they them their there here what when where which who whom why how all any each few more most other some such only own same than too very just also into over under again then once about after before because been being both did does doing down during off out per our ours she her hers him his its it’s it's ive i’m i'm myself yourself use used using via get got make made like one two three new old want wants need needs know thing things lot much many day days time times`.split(' '));

export function tokens(text) {
  return [...new Set(String(text).toLowerCase().replace(/[`*_#>\[\]()~|]/g, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]{2,}/gu) || [])]
    .map(t => t.replace(/['’]s$/, '')).filter(t => t.length > 2 && !STOP.has(t));
}

export function classify(text) {
  const words = new Set(tokens(text)), lower = String(text).toLowerCase();
  let best = 'general', bestScore = 0;
  for (const [key, { words: list }] of Object.entries(CATEGORIES)) {
    let score = 0; for (const w of list) if (words.has(w)) score += 1;
    if (key === 'routine' && /\b\d{1,2}(:\d\d)?\s?(am|pm)\b/.test(lower)) score += 1.5;
    if (key === 'finance' && /[₱$€£]\s?\d/.test(lower)) score += 1.5;
    if (score > bestScore) { best = key; bestScore = score; }
  }
  return best;
}

export function label(text) {
  const line = String(text).split('\n').map(l => l.replace(/^[#>*\-\s\d.]+/, '').trim()).find(Boolean) || 'Memory';
  return line.length > 52 ? `${line.slice(0, 50)}…` : line;
}

function corpus(db) {
  const rows = db.prepare('SELECT * FROM memories').all();
  const docs = rows.map(r => {
    let metadata = {}; try { metadata = JSON.parse(r.metadata || '{}'); } catch { /* Older imported metadata is optional. */ }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) metadata = {};
    // Repeated section/parent labels describe a node's context, not evidence that every sibling was accessed.
    const phrase = typeof metadata.phrase === 'string' ? metadata.phrase : r.content.split(' › ').at(-1);
    return { ...r, metadata, tokens: new Set(tokens(phrase)) };
  });
  const df = new Map(); for (const d of docs) for (const t of d.tokens) df.set(t, (df.get(t) || 0) + 1);
  const idf = t => Math.log(1 + docs.length / (df.get(t) || 1));
  return { docs, idf };
}

// Rank memories by weighted keyword overlap with arbitrary text (a chat message or answer).
export function relevantMemories(db, text, limit = 8) {
  const query = new Set(tokens(text)); if (!query.size) return [];
  const { docs, idf } = corpus(db), ranked = [];
  for (const d of docs) {
    let score = 0, hits = 0;
    for (const t of query) if (d.tokens.has(t)) { score += idf(t); hits++; }
    if (!hits) continue;
    score /= Math.sqrt(Math.max(4, d.tokens.size)) / 2;
    if (score >= 0.9) ranked.push({ id: d.id, score: Math.round(score * 100) / 100 });
  }
  return ranked.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function recordActivity(db, hits, source) {
  const now = Date.now(), insert = db.prepare('INSERT INTO memory_activity(memory_id, source, score, created_at) VALUES(?,?,?,?)');
  const touch = db.prepare('UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?');
  for (const hit of hits) { insert.run(hit.id, source, hit.score ?? 1, now); touch.run(now, hit.id); }
  if (Math.random() < 0.02) db.prepare('DELETE FROM memory_activity WHERE created_at < ?').run(now - 30 * 864e5);
  return now;
}

export function memoryGraph(db) {
  const { docs, idf } = corpus(db), nodes = [], links = [];
  const used = new Set();
  for (const d of docs) {
    const category = categoryIds.includes(d.category) ? d.category : classify(d.content);
    used.add(category);
    nodes.push({ id: d.id, type: 'memory', category, topic: d.topic || null, source: d.source || null, metadata: d.metadata, label: label(d.metadata.phrase || d.content.split(' › ').at(-1)), content: d.content, access_count: d.access_count, last_accessed: d.last_accessed, updated_at: d.updated_at, auto: !d.category });
  }
  for (const c of used) links.push({ source: 'jarvis', target: `category:${c}`, kind: 'hub' });
  for (const n of nodes) links.push({ source: `category:${n.category}`, target: n.id, kind: 'category' });
  // Related memories: strongest shared-keyword pairs, at most 3 per memory.
  const counts = new Map(), pairs = [], postings = new Map(), candidates = new Map();
  for (let i = 0; i < docs.length; i++) for (const token of docs[i].tokens) {
    if (!postings.has(token)) postings.set(token, []); postings.get(token).push(i);
  }
  // Inverted index avoids comparing every pair of memories. Ubiquitous words add no useful edges.
  for (const [token, positions] of postings) {
    if (positions.length > Math.max(16, docs.length * 0.15)) continue;
    for (let a = 0; a < positions.length; a++) for (let b = a + 1; b < positions.length; b++) {
      const i = positions[a], j = positions[b], key = i * docs.length + j;
      const pair = candidates.get(key) || { i, j, shared: 0, weight: 0 };
      pair.shared++; pair.weight += idf(token); candidates.set(key, pair);
    }
  }
  for (const { i, j, shared, weight } of candidates.values()) {
    if (shared < 2) continue;
    const strength = weight / Math.sqrt(docs[i].tokens.size * docs[j].tokens.size);
    if (strength > 0.18) pairs.push({ a: docs[i].id, b: docs[j].id, strength });
  }
  pairs.sort((x, y) => y.strength - x.strength);
  for (const p of pairs) {
    if ((counts.get(p.a) || 0) >= 3 || (counts.get(p.b) || 0) >= 3) continue;
    counts.set(p.a, (counts.get(p.a) || 0) + 1); counts.set(p.b, (counts.get(p.b) || 0) + 1);
    links.push({ source: p.a, target: p.b, kind: 'related', strength: Math.round(p.strength * 100) / 100 });
  }
  // Topic nodes: the section a phrase was imported from (e.g. "Hardware"), linked to each of its phrases.
  const topics = new Map();
  for (const n of nodes) if (n.topic) { const key = `topic:${n.topic.toLowerCase()}`; if (!topics.has(key)) topics.set(key, { id: key, type: 'topic', label: n.topic.length > 40 ? `${n.topic.slice(0, 38)}…` : n.topic, categories: new Map(), count: 0 }); const t = topics.get(key); t.count++; t.categories.set(n.category, (t.categories.get(n.category) || 0) + 1); links.push({ source: key, target: n.id, kind: 'topic' }); }
  for (const t of topics.values()) { t.category = [...t.categories].sort((a, b) => b[1] - a[1])[0][0]; delete t.categories; links.push({ source: 'jarvis', target: t.id, kind: 'topic-hub' }); }
  const hubs = [{ id: 'jarvis', type: 'jarvis', label: 'JARVIS' }, ...[...used].map(c => ({ id: `category:${c}`, type: 'category', category: c, label: CATEGORIES[c].label, count: nodes.filter(n => n.category === c).length }))];
  return { nodes: [...hubs, ...topics.values(), ...nodes], links, categories: Object.fromEntries(categoryIds.map(c => [c, CATEGORIES[c].label])) };
}

// Split a structured Markdown/plain-text profile into one memory per phrase, keeping the section it came from.
export function parsePhrases(text) {
  const out = [], seen = new Set(), hierarchy = [];
  let topic = null, topTopic = null, subheading = null, template = false;
  const clean = value => value.replace(/\*\*|__|`/g, '').trim();
  const acronyms = new Set(['AI','ASUS','ROG','UP','UPD','DLSU','CPU','GPU','SSD','RAM','RSTF','NSTF','RSPC','NSPC','GITC','ISEF','DOST','NCDA','PR','NAS','PHP','USD','NVME','PCIE','JPMORGAN']);
  const titleCase = title => {
    if (title !== title.toUpperCase()) return title;
    return title.toLowerCase().replace(/[\p{L}\p{N}]+/gu, word => acronyms.has(word.toUpperCase()) ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1));
  };
  const upperHeading = line => {
    const letters = line.match(/\p{L}/gu) || [];
    return letters.length >= 6 && letters.filter(c => c === c.toUpperCase()).length / letters.length > 0.92 && !/:\s+/.test(line) && !/[.!?]$/.test(line);
  };
  const kindOf = value => {
    if (template) return 'template';
    if (/\b(?:scenario|if qualified|if .*qualif|if .*place|if .*wins?|conditional|potential isef)\b/i.test(value)) return 'conditional';
    if (/\b(?:probability|probabilities|odds|estimated?|typically|near certainty|guaranteed|assessment|\d+%.*(?:lock|chance))\b/i.test(value)) return 'estimate';
    if (/\b(?:planned|planning|target|preferred|fallback|objective|upcoming|strategy|roadmap|will |would |aiming|goal|action:|proposal|optional upgrade)\b/i.test(value)) return 'plan';
    return 'statement';
  };
  const abbreviations = /(?:\b(?:e\.g|i\.e|mr|mrs|ms|dr|prof|sr|jr|vs|no|st|inc|co|dept)|\b[A-Z])\.$/i;
  function aspects(value) {
    // Split at real clause boundaries, retaining decimal numbers, thousands separators, abbreviations and parentheticals.
    const property = value.match(/^([^:\n]{1,90}):\s+([\s\S]+)$/);
    const prefix = property ? `${property[1]}: ` : '', body = property ? property[2] : value;
    const parts = []; let start = 0, depth = 0;
    for (let i = 0; i < body.length; i++) {
      const char = body[i]; if ('([{'.includes(char)) depth++; else if (')]}'.includes(char)) depth = Math.max(0, depth - 1);
      if (depth || !/\s/.test(body[i + 1] || '')) continue;
      const rest = body.slice(i + 1).trimStart();
      const sentence = /[.!?]/.test(char) && /^[\p{Lu}\p{N}"“]/u.test(rest) && !abbreviations.test(body.slice(start, i + 1));
      const clause = char === ';' || char === ',' && (property || /^\d+(?:\.\d+)?\s*(?:kg|gb|tb|mm|cm|w|wh|hz|km)\b/i.test(rest));
      if (!sentence && !clause) continue;
      const fragment = body.slice(start, sentence ? i + 1 : i).trim(); if (fragment) parts.push(prefix + fragment);
      start = i + 1;
    }
    const last = body.slice(start).trim(); if (last) parts.push(prefix + last);
    return parts;
  }
  const lines = String(text).replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n');
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const raw = lines[lineIndex], trimmed = raw.trim();
    if (!trimmed || /^[=\-_~*#]{3,}$/.test(trimmed) || /^```/.test(trimmed)) continue;
    if (/^(?:MASTER (?:CONTEXT|STRATEGIC)|END OF (?:MASTER|CONTEXT)|SUBJECT:)\b/i.test(trimmed)) continue;
    const markdown = trimmed.match(/^#{1,6}\s+(.+)$/);
    const numbered = trimmed.match(/^(\d{1,2}|[A-Z])[.)]\s+(.+)$/);
    const templateHeading = trimmed.match(/^\[(TEMPLATE\b[^\]]+)\]$/i);
    if (templateHeading) {
      subheading = clean(templateHeading[1]); template = true; hierarchy.length = 0; continue;
    }
    const isHeading = markdown || numbered && (upperHeading(numbered[2]) || /^[A-Z]$/.test(numbered[1]) && /:$/.test(numbered[2])) || !/^[-*•+]\s/.test(trimmed) && upperHeading(trimmed);
    if (isHeading) {
      const title = titleCase(clean(markdown ? markdown[1] : numbered ? numbered[2] : trimmed).replace(/:$/, ''));
      if (numbered && /^[A-Z]$/.test(numbered[1])) { subheading = title; topic = topTopic ? `${topTopic} / ${title}` : title; }
      else { topic = title; topTopic = title; subheading = null; }
      template = false; hierarchy.length = 0; continue;
    }
    const bullet = raw.match(/^(\s*)(?:[-*•+]|\d{1,2}[.)])\s+(.+)$/);
    const indent = bullet ? bullet[1].replace(/\t/g, '    ').length : 0;
    const original = clean(bullet ? bullet[2] : trimmed); if (original.length < 2) continue;
    if (!bullet && /:\s*$/.test(original)) { subheading = original.replace(/:\s*$/, ''); hierarchy.length = 0; continue; }
    if (bullet) while (hierarchy.length && hierarchy.at(-1).indent >= indent) hierarchy.pop();
    const context = [...(subheading ? [subheading] : []), ...hierarchy.map(p => p.text)];
    const kind = kindOf([topic, ...context, original].filter(Boolean).join(' '));
    const isLabel = /:\s*$/.test(original);
    if (!isLabel) for (const phrase of aspects(original)) {
      // Split oversized clauses at word boundaries. Keep the complete source phrase in metadata.
      const words = phrase.split(/\s+/); let chunk = '';
      const chunks = [];
      for (const word of words) { if (chunk.length + word.length + 1 > 1400 && chunk) { chunks.push(chunk); chunk = ''; } chunk += `${chunk ? ' ' : ''}${word}`; }
      if (chunk) chunks.push(chunk);
      for (const fragment of chunks) {
        const content = [...context, fragment].join(' › ');
        const key = `${kind}\0${content.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()}`;
        if (seen.has(key)) continue; seen.add(key);
        out.push({ topic, content, metadata: { kind, qualification: ['template','conditional'].includes(kind) ? 'hypothetical' : 'imported_unverified', source_line: lineIndex + 1, parent_context: context, topic_path: [topTopic, subheading].filter(Boolean), phrase: fragment, original_phrase: original } });
      }
    }
    if (bullet) hierarchy.push({ indent, text: original.replace(/:\s*$/, '') });
  }
  return out;
}
