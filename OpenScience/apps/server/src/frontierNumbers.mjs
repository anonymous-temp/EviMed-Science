/**
 * The frontier editor's number check (「数字复核」, plan §10.3.7, review #3).
 *
 * A Chinese title, summary or reason may state a number only if the text the
 * editor model was shown states the same number. The model judges what is
 * worth saying; this code re-verifies the one part of what it said that can be
 * verified mechanically, and an unverifiable number is not softened — the
 * summary is rewritten once with the number named, and dropped if it is still
 * wrong (principles 1 and 5: the model judges, code re-verifies, failed
 * verdicts are dropped).
 *
 * Hidden knowledge:
 *
 * - **Equality, never rounding.** 「近五成」 against a source's 48.7% fails,
 *   and that is the point: a reader of a medical feed must be able to find
 *   every figure in the original. What is normalised is only notation —
 *   thousands separators (`32,000`, `32 000` with a thin space, `32，000`),
 *   full-width digits and signs, the Lancet's raised decimal point (`0·85`),
 *   JAMA's bare decimals (`P = .03`), scale words (`3.2 万`, `1.2 billion`,
 *   `$450M`), percent against proportion (`30%` = `0.30`), and number words.
 * - **Chinese quantities are a closed table, not a pattern over language.** A
 *   numeral run is a quantity only in the forms listed here: 百分之X, X分之Y,
 *   X成, X倍, a run ending in 万/亿, a run followed by a classifier or unit
 *   from `CLASSIFIERS`, 第X, and the fixed words 一半/半数/过半/翻倍/翻番/翻两番.
 *   Anything else — 二甲双胍, 十二指肠, 三阴性, 一线治疗 — is part of a word.
 *   A run in one of those forms that the numeral reader cannot convert
 *   (「三四成」, thirty-to-forty per cent) must appear verbatim in the source.
 * - **「一项」 is an article, not a count.** Chinese writes the indefinite
 *   article with 一 and a classifier (一项研究, 一种新药); checking it would fail
 *   every summary of "a new study". A count of one written that way is not
 *   checked; any other numeral with a classifier is.
 * - **Signs are notation too.** Chinese states direction in words (降低 1.5%
 *   for a source's −1.5%), so values are compared without sign, and a hyphen
 *   between two numbers is read as a range, never as a negative.
 * - **Identifiers are not quantities — on the claim side.** In what the model
 *   wrote, digits glued to Latin letters (GLP-1, COVID-19, HbA1c, SGLT2,
 *   BNT162b2, T2D, Q3, NCT01234567) are names and are not checked. In the
 *   source every digit run counts, so 「2 型糖尿病」 is found in a source that
 *   only says T2D, and 「第三季度」 in one that says Q3. The asymmetry can pass
 *   a number that happens to be the digits of an identifier; it cannot fail a
 *   faithful translation, which is the failure that costs a summary.
 * - **English number words, month names and Roman numerals are source-only.**
 *   A source says "three trials", "September 20", "phase III", "doubled"; the
 *   model is told to write Arabic digits, so 「3 项试验」, 「9 月 20 日」,
 *   「3 期」 and 「2 倍」 must find them. They are closed tables (number words
 *   zero to ninety-nine, twelve months written next to a number, Roman I–XII
 *   after phase/stage/grade/class/type).
 * - **Units are observed, not enforced** (plan §10.3.7): `30%` matched only by
 *   a source's plain 30 passes and is reported in `unitMismatches`, a metric
 *   until a measured distribution says it should refuse.
 *
 * Deletable when the editor model cites the source span of every number it
 * writes and the check becomes a span comparison.
 *
 * @module frontierNumbers
 */

// ───────────────────────── notation ─────────────────────────

/** @type {Record<string, string>} */
const SUPERSCRIPTS = { "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "⁻": "-", "⁺": "+" };

/**
 * A text with one notation for digits: ASCII digits and signs, `.` as the
 * decimal point, `,` as the only thousands separator, exponents set apart.
 * Applied to both sides, so whatever it does it does to both.
 * @param {unknown} text @returns {string}
 */
export function normalizeNumberText(text) {
  return String(text ?? "")
    .replace(/[\uFF10-\uFF19]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xFF10 + 48))
    .replace(/[％﹪]/g, "%")
    .replace(/．/g, ".")
    .replace(/[＋]/g, "+")
    .replace(/[－−]/g, "-")
    .replace(/[～〜]/g, "~")
    .replace(/[＜]/g, "<")
    .replace(/[＞]/g, ">")
    .replace(/[＝]/g, "=")
    // The Lancet's decimal point is a raised dot: 0·85 (95% CI 0·76–0·95).
    .replace(/(\d)[·∙‧](?=\d)/g, "$1.")
    // A full-width comma or a thin space inside a number groups thousands.
    .replace(/(\d)，(?=\d{3}(?!\d))/g, "$1,")
    .replace(/(\d)[\u00A0\u2009\u202F](?=\d{3}(?!\d))/g, "$1")
    // 10⁻⁸ is two numbers, 10 and 8 — never 108.
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]+/g, (run) => ` ${[...run].map((char) => SUPERSCRIPTS[char]).join("")}`)
    .replace(/[₀-₉]/g, (digit) => String(digit.charCodeAt(0) - 0x2080))
    // Ⅲ期 is phase 3; the numeral characters are unambiguous.
    .replace(/[\u2160-\u216B]/g, (roman) => ` ${roman.charCodeAt(0) - 0x2160 + 1} `)
    .replace(/[\u2170-\u217B]/g, (roman) => ` ${roman.charCodeAt(0) - 0x2170 + 1} `);
}

/**
 * The key two values are compared by: absolute, twelve significant digits (a
 * notation's floating-point residue — 0.1 + 0.2 — is not a different number).
 * @param {number} value
 */
function key(value) {
  return String(Number(Math.abs(value).toPrecision(12)));
}

// ───────────────────────── Chinese numerals ─────────────────────────

/** @type {Record<string, number>} */
const CN_DIGITS = { "〇": 0, "零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
/** @type {Record<string, number>} */
const CN_UNITS = { "十": 10, "百": 100, "千": 1000 };
/** @type {Record<string, number>} */
const CN_SCALES = { "万": 1e4, "亿": 1e8 };
const CN_RUN = /[〇零一二两三四五六七八九十百千万亿点]+/g;

/**
 * A section below 万: 三千二百零五 → 3205, 十五 → 15, 二十 → 20. Null when the
 * characters are not a numeral in positional order (三四: "three or four").
 * @param {string} text
 */
function cnSection(text) {
  if (!text) return 0;
  const chars = [...text];
  if (!chars.some((char) => char in CN_UNITS)) {
    // No positional character: one digit, or a digit-by-digit reading with a
    // zero in it (二〇二六, a year). Two plain digits side by side (三四, 五六)
    // are an approximation, not a number.
    if (chars.length === 1) return CN_DIGITS[chars[0]] ?? null;
    if (chars.every((char) => char in CN_DIGITS) && chars.some((char) => CN_DIGITS[char] === 0)) {
      return Number(chars.map((char) => CN_DIGITS[char]).join(""));
    }
    return null;
  }
  let total = 0;
  let digit = null;
  let lastUnit = Infinity;
  for (const char of chars) {
    if (char in CN_DIGITS) {
      if (digit !== null && CN_DIGITS[char] !== 0) return null;
      digit = CN_DIGITS[char] === 0 ? null : CN_DIGITS[char];
      continue;
    }
    const unit = CN_UNITS[char];
    if (unit === undefined || unit >= lastUnit) return null;
    total += (digit ?? (unit === 10 ? 1 : NaN)) * unit;
    if (!Number.isFinite(total)) return null;
    digit = null;
    lastUnit = unit;
  }
  return total + (digit ?? 0);
}

/**
 * A Chinese numeral's value, or null when it is not one in positional order.
 * Reads sections separated by 亿 and 万, and a decimal part after 点 written
 * digit by digit, whose scale may follow it (三点二万 = 32000).
 * @param {string} text
 * @returns {number | null}
 */
export function parseChineseNumeral(text) {
  const run = String(text ?? "");
  if (!run || !/[〇零一二两三四五六七八九十]/.test(run)) return null;
  const point = run.indexOf("点");
  if (point >= 0) {
    const whole = parseChineseNumeral(run.slice(0, point));
    const rest = run.slice(point + 1);
    const scaleChar = rest.at(-1) ?? "";
    const scale = CN_SCALES[scaleChar] ?? 1;
    const digits = scale === 1 ? rest : rest.slice(0, -1);
    if (whole === null || !digits || ![...digits].every((char) => char in CN_DIGITS)) return null;
    return Number(`${whole}.${[...digits].map((char) => CN_DIGITS[char]).join("")}`) * scale;
  }
  let total = 0;
  let rest = run;
  for (const scaleChar of ["亿", "万"]) {
    const at = rest.indexOf(scaleChar);
    if (at < 0) continue;
    const section = at === 0 ? null : cnSection(rest.slice(0, at));
    if (section === null) return null;
    total += section * CN_SCALES[scaleChar];
    rest = rest.slice(at + 1);
    if (rest.includes(scaleChar)) return null;
  }
  const tail = cnSection(rest.replace(/^[〇零]/, ""));
  if (tail === null) return null;
  return total + tail;
}

/**
 * Classifiers and units after which a Chinese numeral is a count or a measure.
 * Longest first, so 个月 is not read as 个.
 */
const CLASSIFIERS = [
  "个百分点", "百分点", "个月", "小时", "分钟", "美元", "欧元", "英镑", "日元", "港元", "毫克", "千克", "公斤", "毫升", "毫米", "厘米",
  "公里", "例次", "人次", "项", "种", "个", "名", "例", "位", "次", "家", "款", "篇", "组", "类", "剂", "周", "天", "日", "年", "岁",
  "人", "元", "秒", "月", "期", "批", "份", "所", "座", "台", "条", "件", "支", "片", "粒", "袋", "瓶", "盒", "克", "升", "米", "国", "省",
];

/** What makes the numeral that follows vague (数十, 几百, 上万, 好几, 成千). */
const VAGUE_BEFORE = /[数几上好成]$/;
/** What makes the numeral before it vague (十多, 百余, 十来, 十几). */
const VAGUE_AFTER = /^[多余来几]/;

/** Fixed words that are quantities (review #3: 「翻倍」 escaped the first check). */
const CN_FIXED = /** @type {ReadonlyArray<readonly [string, number[], string]>} */ ([
  ["翻两番", [4], "multiple"],
  ["翻一番", [2], "multiple"],
  ["翻番", [2], "multiple"],
  ["翻倍", [2], "multiple"],
  ["一半", [50, 0.5], "percent"],
  ["半数", [50, 0.5], "percent"],
  ["过半", [50, 0.5], "percent"],
]);

// ───────────────────────── English (source side only) ─────────────────────────

/** @type {Record<string, number>} */
const EN_UNITS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
/** @type {Record<string, number>} */
const EN_TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
/** @type {Record<string, number>} */
const EN_ORDINALS = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, twentieth: 20, thirtieth: 30, hundredth: 100,
};
/** Words that are a number with a unit of their own. */
/** @type {Record<string, Array<[number, NumberUnit]>>} */
const EN_WORDS = {
  once: [[1, "multiple"]], twice: [[2, "multiple"]], thrice: [[3, "multiple"]],
  double: [[2, "multiple"]], doubled: [[2, "multiple"]], doubling: [[2, "multiple"]],
  triple: [[3, "multiple"]], tripled: [[3, "multiple"]], tripling: [[3, "multiple"]],
  quadruple: [[4, "multiple"]], quadrupled: [[4, "multiple"]],
  twofold: [[2, "multiple"]], threefold: [[3, "multiple"]], fourfold: [[4, "multiple"]], fivefold: [[5, "multiple"]],
  tenfold: [[10, "multiple"]], hundredfold: [[100, "multiple"]],
  dozen: [[12, "count"]], hundred: [[100, "count"]], thousand: [[1000, "count"]],
  half: [[0.5, "fraction"], [50, "percent"]], halved: [[0.5, "fraction"], [50, "percent"]],
};
/** Fractions written in words; a numerator word before them multiplies. */
/** @type {Record<string, number>} */
const EN_FRACTIONS = { third: 3, thirds: 3, quarter: 4, quarters: 4, fourth: 4, fourths: 4, fifth: 5, fifths: 5, tenth: 10, tenths: 10 };
/** @type {Record<string, number>} */
const EN_MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
/** @type {Record<string, number>} */
const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10, XI: 11, XII: 12 };
/** @type {Record<string, number>} */
const EN_SCALES = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12, bn: 1e9, mn: 1e6 };

/** Latin letters glued after digits that make them a measure, not a name. */
const UNIT_SUFFIXES = new Set([
  "mg", "g", "kg", "µg", "μg", "ug", "mcg", "ng", "pg", "ml", "l", "dl", "µl", "μl", "mmol", "µmol", "μmol", "nmol", "pmol", "mol",
  "meq", "iu", "u", "ku", "h", "hr", "hrs", "d", "wk", "wks", "w", "mo", "mos", "y", "yr", "yrs", "min", "mins", "s", "sec", "ms",
  "cm", "mm", "m", "km", "nm", "µm", "μm", "kcal", "cal", "kda", "da", "mmhg", "bpm", "x", "st", "nd", "rd", "th", "k", "b",
  "bn", "mn", "gy", "cgy", "msv", "hz", "khz", "mhz", "ghz", "fold", "ppm", "ppb",
]);

// ───────────────────────── mentions ─────────────────────────

/**
 * @typedef {"count" | "percent" | "fraction" | "multiple"} NumberUnit
 * @typedef {{ value: number, unit: NumberUnit }} NumberCandidate
 * @typedef {{ raw: string, start: number, end: number, candidates: NumberCandidate[], verbatim?: string,
 *             parts?: NumberMention[] }} NumberMention
 *   A number the text states. It is found when any candidate's value is in the
 *   source, or — for `a/b` — when both parts are; `verbatim` is set for a
 *   Chinese quantity no table converts, which must then appear as written.
 */

/** @param {number} value @param {NumberUnit} unit @returns {NumberCandidate} */
const candidate = (value, unit) => ({ value, unit });

/** @param {number} value @param {"percent" | "permille" | "tenths" | "multiple" | "count"} kind @returns {NumberCandidate[]} */
function candidatesFor(value, kind) {
  if (kind === "percent") return [candidate(value, "percent"), candidate(value / 100, "fraction")];
  if (kind === "permille") return [candidate(value / 10, "percent"), candidate(value / 1000, "fraction")];
  if (kind === "tenths") return [candidate(value * 10, "percent"), candidate(value / 10, "fraction")];
  if (kind === "multiple") return [candidate(value, "multiple")];
  return [candidate(value, "count")];
}

const RANGE_SEPARATOR = /^\s*(?:-|–|—|~|至|到|－)\s*$/;

/**
 * Arabic numbers in a normalised text, with the unit that follows each.
 * @param {string} text normalised
 * @param {"claim" | "source"} side
 * @returns {NumberMention[]}
 */
function arabicMentions(text, side) {
  /** @type {Array<NumberMention & { kind: string, scale: number, bare: boolean }>} */
  const found = [];
  const pattern = /(?<![\d.])(?:\d{1,3}(?:,\d{3})+(?!\d)(?:\.\d+)?|\d+(?:\.\d+)?|(?<=^|[\s=<>≤≥(（:：~])\.\d+)/g;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const raw = match[0];
    const end = start + raw.length;
    const before = text.slice(Math.max(0, start - 2), start);
    const after = text.slice(end, end + 16);
    const glued = /^[A-Za-zµμ]+/.exec(after)?.[0] ?? "";
    // On the claim side a number glued to letters is a name (GLP-1, HbA1c,
    // 162b2), unless the letters are a unit (5mg, 2x, 3rd).
    if (side === "claim") {
      if (/[A-Za-z]-?$/.test(before)) continue;
      if (/^-[A-Za-z]/.test(after)) continue;
      if (glued && !UNIT_SUFFIXES.has(glued.toLowerCase())) continue;
    }
    let value = Number(raw.replace(/,/g, "").replace(/^\./, "0."));
    if (!Number.isFinite(value)) continue;
    let kind = "count";
    let scale = 1;
    let unitEnd = end;
    const unit = /^\s?(%|‰)/.exec(after)
      ?? /^\s*(万亿|千万|百万|十万|万|亿|千(?!分)|百(?!分))/.exec(after)
      ?? /^\s?(倍|成)/.exec(after)
      ?? /^\s?-?\s?(fold)\b/i.exec(after)
      ?? /^\s?([×xX])(?![A-Za-z])/.exec(after)
      ?? (side === "source" ? /^\s+(times)\b/i.exec(after) : null)
      ?? (side === "source" ? /^\s?(thousand|million|billion|trillion|bn|mn)\b/i.exec(after) : null)
      ?? (/(?:[$€£¥]|US\$|RMB\s?)$/.test(text.slice(Math.max(0, start - 4), start)) ? /^\s?([kKmMbB])\b/.exec(after) : null);
    if (unit) {
      const word = unit[1];
      unitEnd = end + unit[0].length;
      if (word === "%") kind = "percent";
      else if (word === "‰") kind = "permille";
      else if (word === "成") kind = "tenths";
      else if (["倍", "×", "x", "X"].includes(word) || /^(fold|times)$/i.test(word)) kind = "multiple";
      else if (word in CN_SCALES || /^(万亿|千万|百万|十万|千|百)$/.test(word)) {
        scale = { 万亿: 1e12, 千万: 1e7, 百万: 1e6, 十万: 1e5, 万: 1e4, 亿: 1e8, 千: 1e3, 百: 1e2 }[word] ?? 1;
      } else {
        scale = EN_SCALES[word.toLowerCase()] ?? { k: 1e3, m: 1e6, b: 1e9 }[word.toLowerCase()] ?? 1;
      }
    }
    const candidates = candidatesFor(value * scale, /** @type {any} */ (kind));
    // The source also offers the digits as written: "1.2 million" contains 1.2.
    if (side === "source" && scale !== 1) candidates.push(candidate(value, "count"));
    found.push({ raw: text.slice(start, unitEnd).trim(), start, end: unitEnd, candidates, kind, scale, bare: !unit });
    value = 0;
  }
  // A range shares its unit: 10–20% is 10% to 20%, 3 至 5 万 is 30,000 to 50,000.
  for (let index = 0; index < found.length - 1; index += 1) {
    const left = found[index];
    const right = found[index + 1];
    if (!left.bare || right.bare) continue;
    if (!RANGE_SEPARATOR.test(text.slice(left.end, right.start))) continue;
    const base = left.candidates[0].value;
    left.candidates = candidatesFor(base * right.scale, /** @type {any} */ (right.kind));
    if (side === "source") left.candidates.push(candidate(base, "count"));
  }
  // a/b: a fraction, or two counts (18/20 patients, phase 1/2, 9/22).
  /** @type {NumberMention[]} */
  const mentions = [];
  for (let index = 0; index < found.length; index += 1) {
    const current = found[index];
    const next = found[index + 1];
    if (next && text.slice(current.end, next.start) === "/" && current.bare) {
      const ratio = current.candidates[0].value / next.candidates[0].value;
      const parts = [current, next].map(({ raw, start, end, candidates }) => ({ raw, start, end, candidates }));
      mentions.push({
        raw: `${current.raw}/${next.raw}`, start: current.start, end: next.end, parts,
        candidates: Number.isFinite(ratio) ? [candidate(ratio, "fraction"), candidate(ratio * 100, "percent")] : [],
      });
      index += 1;
      continue;
    }
    mentions.push({ raw: current.raw, start: current.start, end: current.end, candidates: current.candidates });
  }
  return mentions;
}

/**
 * Chinese quantities in a text, in the closed forms only.
 * @param {string} text normalised
 * @returns {NumberMention[]}
 */
function chineseMentions(text) {
  /** @type {NumberMention[]} */
  const mentions = [];
  /** @type {Array<[number, number]>} */
  const taken = [];
  const overlaps = (/** @type {number} */ start, /** @type {number} */ end) => taken.some(([from, to]) => start < to && end > from);
  for (const [word, values, unit] of CN_FIXED) {
    let at = text.indexOf(word);
    while (at >= 0) {
      if (!overlaps(at, at + word.length)) {
        mentions.push({ raw: word, start: at, end: at + word.length, candidates: values.map((value, index) => candidate(value,
          unit === "percent" ? (index === 0 ? "percent" : "fraction") : /** @type {NumberUnit} */ (unit))) });
        taken.push([at, at + word.length]);
      }
      at = text.indexOf(word, at + word.length);
    }
  }
  for (const match of text.matchAll(CN_RUN)) {
    const run = match[0].replace(/^点+|点+$/g, "");
    const start = (match.index ?? 0) + match[0].indexOf(run);
    if (!run) continue;
    let end = start + run.length;
    if (overlaps(start, end)) continue;
    const before = text.slice(Math.max(0, start - 3), start);
    // 万, 亿, 千万 alone are a scale — of the Arabic number before them (3.2 万)
    // or of nothing (上万, 亿万) — never a numeral of their own.
    if (!/[〇零一二两三四五六七八九十]/.test(run) || /\d\s?$/.test(before)) continue;
    const after = text.slice(end, end + 6);
    // X分之Y (百分之三十, 三分之一): the run before 分之 is the denominator.
    if (after.startsWith("分之")) continue;
    const denominator = /(百|千|[〇零一二两三四五六七八九十百千万]+)分之$/.exec(text.slice(Math.max(0, start - 8), start));
    if (denominator) {
      const over = denominator[1] === "百" ? 100 : denominator[1] === "千" ? 1000 : parseChineseNumeral(denominator[1]);
      const top = parseChineseNumeral(run);
      const raw = `${denominator[0]}${run}`;
      const from = start - denominator[0].length;
      if (over && top !== null) {
        const ratio = top / over;
        mentions.push({ raw, start: from, end, candidates: [candidate(ratio, "fraction"), candidate(ratio * 100, "percent")] });
      } else mentions.push({ raw, start: from, end, candidates: [], verbatim: raw });
      taken.push([from, end]);
      continue;
    }
    if (VAGUE_BEFORE.test(before) || VAGUE_AFTER.test(after)) continue;
    // 三成, 三成五 (thirty-five per cent), 近五成.
    const tenths = /^成([〇零一二两三四五六七八九])?/.exec(after);
    if (tenths) {
      const whole = parseChineseNumeral(run);
      const extra = tenths[1] ? CN_DIGITS[tenths[1]] : 0;
      end += tenths[0].length;
      const raw = `${run}${tenths[0]}`;
      if (whole !== null && whole <= 10) {
        const percent = whole * 10 + extra;
        mentions.push({ raw, start, end, candidates: [candidate(percent, "percent"), candidate(percent / 100, "fraction")] });
      } else mentions.push({ raw, start, end, candidates: [], verbatim: raw });
      taken.push([start, end]);
      continue;
    }
    const value = parseChineseNumeral(run);
    if (after.startsWith("倍")) {
      const raw = `${run}倍`;
      end += 1;
      mentions.push(value !== null ? { raw, start, end, candidates: [candidate(value, "multiple")] } : { raw, start, end, candidates: [], verbatim: raw });
      taken.push([start, end]);
      continue;
    }
    const ordinal = before.endsWith("第");
    const scaled = /[万亿]$/.test(run);
    const classifier = CLASSIFIERS.find((word) => after.startsWith(word)) ?? null;
    // 一项研究 is "a study": the article, not a count.
    if (!ordinal && !scaled && (!classifier || run === "一")) continue;
    const from = ordinal ? start - 1 : start;
    const raw = `${ordinal ? "第" : ""}${run}${classifier ?? ""}`;
    end += classifier ? classifier.length : 0;
    mentions.push(value !== null ? { raw, start: from, end, candidates: [candidate(value, "count")] } : { raw, start: from, end, candidates: [], verbatim: raw });
    taken.push([from, end]);
  }
  return mentions.sort((left, right) => left.start - right.start);
}

/**
 * English words for numbers in a source (three, twice, one-third, September
 * 20, phase III). Source side only: they widen what a claim may be matched
 * against, never what is checked.
 * @param {string} text normalised
 * @returns {NumberCandidate[]}
 */
function englishCandidates(text) {
  /** @type {NumberCandidate[]} */
  const found = [];
  const words = [...text.toLowerCase().matchAll(/[a-z]+/g)].map((match) => ({
    word: match[0], start: match.index ?? 0, end: (match.index ?? 0) + match[0].length,
  }));
  for (const [index, { word, end }] of words.entries()) {
    const next = words[index + 1];
    // A pair is two words joined by one space or one hyphen: twenty-five, two thirds.
    const pair = next && /^[\s-]$/.test(text.slice(end, next.start)) ? next.word : null;
    if (word in EN_UNITS) found.push(candidate(EN_UNITS[word], "count"));
    if (word in EN_TENS) {
      found.push(candidate(EN_TENS[word], "count"));
      if (pair && pair in EN_UNITS && EN_UNITS[pair] > 0 && EN_UNITS[pair] < 10) found.push(candidate(EN_TENS[word] + EN_UNITS[pair], "count"));
      if (pair && pair in EN_ORDINALS && EN_ORDINALS[pair] < 10) found.push(candidate(EN_TENS[word] + EN_ORDINALS[pair], "count"));
    }
    if (word in EN_ORDINALS) found.push(candidate(EN_ORDINALS[word], "count"));
    if (word in EN_WORDS) for (const [value, unit] of EN_WORDS[word]) found.push(candidate(value, unit));
    // one-third, two thirds, a quarter, three-fourths.
    const numerator = word === "a" || word === "an" ? 1 : EN_UNITS[word];
    if (pair && numerator !== undefined && pair in EN_FRACTIONS) {
      const ratio = numerator / EN_FRACTIONS[pair];
      found.push(candidate(ratio, "fraction"), candidate(ratio * 100, "percent"));
    }
    // five-fold, ten fold.
    if (pair === "fold" && (word in EN_UNITS || word in EN_TENS)) found.push(candidate(EN_UNITS[word] ?? EN_TENS[word], "multiple"));
  }
  // A month is a number only next to a date's other numbers: "September 20",
  // "20 Sept 2026", "May 2026" — never the modal verb.
  for (const match of text.matchAll(/(?<![A-Za-z])([A-Z][a-z]{2,8})\.?(?=\s?\d)|(?<=\d\s?)([A-Z][a-z]{2,8})\b/g)) {
    const month = EN_MONTHS[(match[1] ?? match[2]).toLowerCase()];
    if (month !== undefined) found.push(candidate(month, "count"));
  }
  // Roman numerals where medicine writes them: phase III, stage IV, class I
  // recall, type II diabetes, phase I/II, phase IIb.
  for (const match of text.matchAll(/\b(?:phase|stage|grade|class|type|tier|level|part|step|cohort|arm)\s+([IVX]{1,4}[ab]?(?:\s*\/\s*[IVX]{1,4}[ab]?)?)(?![A-Za-z])/gi)) {
    for (const part of match[1].split("/")) {
      const numeral = part.trim().replace(/[ab]$/i, "").toUpperCase();
      if (numeral in ROMAN) found.push(candidate(ROMAN[numeral], "count"));
    }
  }
  return found;
}

/**
 * Every number a text states, in the order it states them.
 * @param {unknown} text
 * @param {{ side?: "claim" | "source" }} [options]
 *   `claim`: what the model wrote (identifiers skipped); `source`: what it was
 *   shown (every digit run).
 * @returns {NumberMention[]}
 */
export function numberMentions(text, { side = "claim" } = {}) {
  const normalized = normalizeNumberText(text);
  const chinese = chineseMentions(normalized);
  const arabic = arabicMentions(normalized, side).filter((mention) => !chinese.some((cn) => mention.start < cn.end && mention.end > cn.start));
  return [...arabic, ...chinese].sort((left, right) => left.start - right.start);
}

/**
 * What a source offers a claim to be matched against.
 * @typedef {{ values: Map<string, Set<NumberUnit>>, text: string }} NumberSource
 */

/**
 * @param {unknown} sourceText the text the model was shown
 * @returns {NumberSource}
 */
export function numberSource(sourceText) {
  const text = normalizeNumberText(sourceText);
  /** @type {Map<string, Set<NumberUnit>>} */
  const values = new Map();
  /** @param {NumberCandidate} entry */
  const add = (entry) => {
    const id = key(entry.value);
    const units = values.get(id) ?? new Set();
    units.add(entry.unit);
    values.set(id, units);
  };
  for (const mention of numberMentions(sourceText, { side: "source" })) {
    for (const entry of mention.candidates) add(entry);
    for (const part of mention.parts ?? []) for (const entry of part.candidates) add(entry);
  }
  for (const entry of englishCandidates(text)) add(entry);
  return { values, text };
}

/**
 * Whether a source states a mention's number, and whether it states it in the
 * same unit.
 * @param {NumberMention} mention @param {NumberSource} source
 * @returns {{ found: boolean, sameUnit: boolean }}
 */
function lookup(mention, source) {
  if (mention.verbatim) {
    const found = source.text.includes(mention.verbatim);
    return { found, sameUnit: found };
  }
  let found = false;
  let sameUnit = false;
  for (const entry of mention.candidates) {
    const units = source.values.get(key(entry.value));
    if (!units) continue;
    found = true;
    if (units.has(entry.unit)) sameUnit = true;
  }
  if (!found && mention.parts?.length) {
    const parts = mention.parts.map((part) => lookup(part, source));
    if (parts.every((part) => part.found)) return { found: true, sameUnit: parts.every((part) => part.sameUnit) };
  }
  return { found, sameUnit };
}

/**
 * The check: every number in each claimed text must be a number of the source.
 *
 * @param {Record<string, unknown>} claims field name → what the model wrote
 *   (title_zh, summary_zh; a digest, an AI minute, an abstract)
 * @param {unknown} sourceText exactly what the model was shown
 * @returns {{ ok: boolean, checked: number, missing: Array<{ field: string, raw: string }>,
 *             unitMismatches: Array<{ field: string, raw: string }> }}
 */
export function checkNumbers(claims, sourceText) {
  const source = numberSource(sourceText);
  let checked = 0;
  /** @type {Array<{ field: string, raw: string }>} */
  const missing = [];
  /** @type {Array<{ field: string, raw: string }>} */
  const unitMismatches = [];
  for (const [field, text] of Object.entries(claims)) {
    if (typeof text !== "string" || !text) continue;
    for (const mention of numberMentions(text, { side: "claim" })) {
      checked += 1;
      const result = lookup(mention, source);
      if (!result.found) missing.push({ field, raw: mention.raw });
      else if (!result.sameUnit) unitMismatches.push({ field, raw: mention.raw });
    }
  }
  return { ok: missing.length === 0, checked, missing, unitMismatches };
}
