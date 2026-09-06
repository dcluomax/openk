/* Shared with backend/search.py. All data stays on the NAS/browser, including pinyin. */
(() => {
  'use strict';
  const BOUNDS = ['阿', '八', '嚓', '哒', '蛾', '发', '噶', '哈', '击', '喀', '垃', '妈',
    '拿', '哦', '啪', '期', '然', '撒', '塌', '挖', '昔', '压', '匝'];
  const LETTERS = 'ABCDEFGHJKLMNOPQRSTWXYZ';
  const HAN = /[\u3400-\u9fff\uf900-\ufaff\u{20000}-\u{323af}]/u;
  const SCRIPT_BOUNDARY = /[\u3400-\u9fff\uf900-\ufaff\u{20000}-\u{323af}](?=[a-z0-9])|[a-z0-9](?=[\u3400-\u9fff\uf900-\ufaff\u{20000}-\u{323af}])/gu;
  let collator;
  function pyCollator() {
    if (collator === undefined) {
      try {
        const candidate = new Intl.Collator('zh-Hans-CN-u-co-pinyin');
        collator = candidate.compare('啊', '波') < 0 && candidate.compare('波', '啊') > 0 ? candidate : null;
      } catch { collator = null; }
    }
    return collator;
  }
  function initialsOf(text) {
    const c = pyCollator();
    let result = '';
    for (const char of String(text || '')) {
      if (/[a-z0-9]/i.test(char)) result += char.toUpperCase();
      else if (c && HAN.test(char)) {
        for (let i = BOUNDS.length - 1; i >= 0; i--) {
          if (c.compare(char, BOUNDS[i]) >= 0) { result += LETTERS[i]; break; }
        }
      }
    }
    return result;
  }
  function compareText(a, b) {
    if (a === b) return 0;
    const x = Array.from(a), y = Array.from(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      const difference = x[i].codePointAt(0) - y[i].codePointAt(0);
      if (difference) return difference;
    }
    return x.length - y.length;
  }
  function termScore(fields, term) {
    let best = -1;
    fields.forEach(([text, phonetics, initials], i) => {
      const exact = [120, 115, 105][i];
      if (text && text.includes(term)) {
        best = Math.max(best, text === term ? exact : exact - (text.startsWith(term) ? 40 : 60));
      }
      for (const phonetic of phonetics) {
        if (phonetic && phonetic.includes(term)) {
          best = Math.max(best, phonetic === term ? 35 : phonetic.startsWith(term) ? 30 : 25);
        }
      }
      for (const initial of initials) {
        if (initial && initial.startsWith(term)) best = Math.max(best, initial === term ? 20 : 15);
      }
    });
    return best;
  }
  function score(searchIndex, needle) {
    const { text, terms } = needle;
    if (!text) return 0;
    const fields = searchIndex.f;
    let best = termScore(fields, text);
    const title = fields[0][0], artist = fields[1][0];
    if (title && artist && (text === title + artist || text === artist + title)) best = Math.max(best, 100);
    const scores = terms.map(term => termScore(fields, term));
    if (scores.every(value => value >= 0)) best = Math.max(best, scores.reduce((a, b) => a + b, 0) / scores.length);
    return best;
  }
  function create(mapping = {}) {
    let map = mapping, cache = new WeakMap();
    function fold(value) {
      const text = String(value || '').normalize('NFKC').toLowerCase()
        .replace(/ß/g, 'ss').replace(/ς/g, 'σ').normalize('NFKD').replace(/\p{M}/gu, '');
      return Array.from(text, char => map[char] || char).join('');
    }
    const words = value => fold(value).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const normalize = value => words(value).replace(/ /g, '');
    function query(value) {
      const text = words(value);
      const terms = text.replace(SCRIPT_BOUNDARY, '$& ');
      return { text: text.replace(/ /g, ''), terms: [...new Set(terms ? terms.split(' ') : [])] };
    }
    function index(job) {
      const key = JSON.stringify([job.title, job.track, job.artist]);
      const previous = cache.get(job);
      if (previous?.key === key && previous.source === job.search_index) return previous.index;
      const source = job.search_index;
      // Metadata edits on a mock/local object must not reuse its old server index.
      const useServer = source?.v === 1 && Array.isArray(source.f) && source.f.length === 3
        && !(previous && previous.key !== key && previous.source === source);
      const values = [job.track || job.title, job.artist, job.title];
      // Literal lookup still works if /api/zh-map is temporarily unavailable.
      const result = useServer ? { v: 1, f: source.f.map((field, i) =>
        [normalize(values[i]), field[1], field[2]]) } : { v: 1, f: values.map(value => {
        const text = words(value);
        const han = Array.from(text).filter(char => HAN.test(char)).join('');
        return [normalize(text), [], han ? [...new Set([initialsOf(text).toLowerCase(), initialsOf(han).toLowerCase()])] : []];
      }) };
      cache.set(job, { key, source, index: result, server: useServer });
      return result;
    }
    function compare(a, b, fallback) {
      const x = index(a).f, y = index(b).f;
      // Old/mock jobs have no server phonetics: retain the classic collator fallback.
      if (fallback) {
        const c = pyCollator();
        const result = c ? c.compare(x[0][0], y[0][0]) : compareText(x[0][0], y[0][0]);
        if (result) return result;
      }
      for (let i = 0; i < 2; i++) {
        const result = compareText(x[i][1][0] || x[i][0], y[i][1][0] || y[i][0])
          || compareText(x[i][0], y[i][0]);
        if (result) return result;
      }
      return compareText(String(a.id || ''), String(b.id || ''));
    }
    return {
      normalize, query, index,
      // Artist identity deliberately keeps punctuation and accents.
      artistKey: value => Array.from(String(value || '').normalize('NFKC').toLowerCase(),
        char => map[char] || char).join('').trim().replace(/\s+/g, ' '),
      setMap(value) { map = value || {}; cache = new WeakMap(); },
      search(jobs, value) {
        const needle = typeof value === 'string' ? query(value) : value;
        const matches = jobs.map(job => ({ job, score: score(index(job), needle) }))
          .filter(match => match.score >= 0);
        const fallback = matches.some(({ job }) => !cache.get(job).server);
        return matches.sort((a, b) => b.score - a.score || compare(a.job, b.job, fallback))
          .map(match => match.job);
      },
    };
  }
  const api = { create, score, initialsOf, pyCollator };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.OpenKSearch = api;
})();
