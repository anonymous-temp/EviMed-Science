/**
 * How an engine's answer is marked on the answer page (plan §5.4): our
 * product's names in bold, each wrong sentence about us underlined, and the
 * correction for a wrong sentence placed right under the paragraph it is in.
 *
 * Pure text work — which sentence is wrong was decided by the judge and
 * re-verified by code on the server; here a sentence is only found where it
 * stands. A wrong sentence the text does not contain verbatim is returned in
 * `unplaced`, so its correction is still shown, below the answer, rather than
 * silently dropped.
 */

export interface AnswerSegment {
  text: string;
  /** One of our product's names. */
  ours: boolean;
  /** Inside a wrong sentence about us: the index into the paragraph's `wrong`. */
  wrong: number | null;
}

export interface AnswerParagraph {
  segments: AnswerSegment[];
  /** The wrong sentences found in this paragraph, in reading order. */
  wrong: string[];
}

interface Range {
  start: number;
  end: number;
}

const TRAILING = /[。．.！!？?；;，,\s]+$/u;

/** Where a sentence stands in a paragraph: verbatim, or without its closing punctuation. */
function locate(paragraph: string, sentence: string): Range | null {
  const whole = sentence.trim();
  if (!whole) return null;
  for (const candidate of [whole, whole.replace(TRAILING, "")]) {
    if (!candidate) continue;
    const start = paragraph.indexOf(candidate);
    if (start >= 0) return { start, end: start + candidate.length };
  }
  return null;
}

function overlaps(range: Range, taken: readonly Range[]): boolean {
  return taken.some((other) => range.start < other.end && other.start < range.end);
}

export function markAnswer(
  text: string,
  { wrong = [], ours = [] }: { wrong?: readonly string[]; ours?: readonly string[] },
): { paragraphs: AnswerParagraph[]; unplaced: string[] } {
  const paragraphs = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const sentences = [...new Set(wrong.map((sentence) => sentence.trim()).filter(Boolean))];
  const names = [...new Set(ours.map((name) => name.trim()).filter((name) => name.length >= 2))].sort((a, b) => b.length - a.length);
  const placed = new Set<string>();

  const marked = paragraphs.map((paragraph): AnswerParagraph => {
    const wrongRanges: Array<Range & { sentence: string }> = [];
    for (const sentence of sentences) {
      if (placed.has(sentence)) continue;
      const range = locate(paragraph, sentence);
      if (range && !overlaps(range, wrongRanges)) {
        wrongRanges.push({ ...range, sentence });
        placed.add(sentence);
      }
    }
    wrongRanges.sort((a, b) => a.start - b.start);

    const nameRanges: Range[] = [];
    for (const name of names) {
      let from = 0;
      for (;;) {
        const start = paragraph.indexOf(name, from);
        if (start < 0) break;
        const range = { start, end: start + name.length };
        if (!overlaps(range, nameRanges)) nameRanges.push(range);
        from = start + name.length;
      }
    }

    const cuts = new Set<number>([0, paragraph.length]);
    for (const range of [...wrongRanges, ...nameRanges]) {
      cuts.add(range.start);
      cuts.add(range.end);
    }
    const points = [...cuts].sort((a, b) => a - b);
    const segments: AnswerSegment[] = [];
    for (let index = 0; index < points.length - 1; index += 1) {
      const start = points[index];
      const end = points[index + 1];
      if (end <= start) continue;
      const wrongIndex = wrongRanges.findIndex((range) => start >= range.start && end <= range.end);
      const ours = nameRanges.some((range) => start >= range.start && end <= range.end);
      const segment = { text: paragraph.slice(start, end), ours, wrong: wrongIndex >= 0 ? wrongIndex : null };
      const previous = segments[segments.length - 1];
      if (previous && previous.ours === segment.ours && previous.wrong === segment.wrong) previous.text += segment.text;
      else segments.push(segment);
    }
    return { segments, wrong: wrongRanges.map((range) => range.sentence) };
  });

  return { paragraphs: marked, unplaced: sentences.filter((sentence) => !placed.has(sentence)) };
}
