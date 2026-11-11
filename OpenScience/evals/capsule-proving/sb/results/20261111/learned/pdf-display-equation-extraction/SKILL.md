---
{"name":"pdf-display-equation-extraction","license":"internal","metadata":{"role":"functional","not_when":"The source is already machine-readable mathematics (a LaTeX or MathML source, or a text layer that carries the math in order); or the requester wants only a corrected version and not the original transcription; or the request is about the mathematics itself rather than lifting it out of the page.","depends_on":"","applies_when":"A document (typically a paper) must have the expressions it sets on their own lines lifted into a machine-renderable text list, one expression per line, with the page-faithful transcription preserved and any syntax repair added as a separate line.","derived_from":"run:run_cbde99066b8930013815e400ff788a93, feedback:feedback:learning-evidence:91001e4bb8350dc9368e7b27dc22d877","evimed_schema":"method-skill/1"},"whenToUse":"When someone asks for the display equations of a document to be extracted into a machine-renderable text file, with originals kept and syntax repairs reported separately.","description":"Lifts every expression a document sets on its own line into a plain-text list of math strings that render as the page shows them, keeping a byte-identical transcription of each original and printing any syntax repair as a separate added line instead of editing the original in place. Use when a research paper or similar document is handed over for its display equations to be pulled out into a file a renderer can consume, when originals and corrected versions must stay distinguishable, or when the same extraction will run over a batch of documents and the results have to stay comparable.","allowed-tools":""}
---

## Purpose

Turn the displayed mathematics of a document into one plain-text list that a renderer can consume,
without losing the page it came from or the evidence of what was changed. The output keeps a
byte-identical transcription of every expression and, where one will not typeset, adds the repaired
copy as a further line after the block of originals. Whoever renders that file can still tell which
line is the page's and which line is ours.

## When to Use

When a document is handed over and the request is to lift its display expressions out into a text
file of math strings, especially when the request also asks for defects to be found and fixed, or when
the extraction will be repeated across a batch of documents whose outputs must stay comparable. Not
for a document whose mathematics already exists as source, and not as a way to correct the
mathematics itself.

## Inputs

- The source document, read page by page at a resolution that shows sub- and superscripts, stacked
  limits and the heights of delimiter pairs.
- The required output syntax, delimiter form, one-line layout, and the path to write.
- Whether labels, equation numbers and trailing punctuation are to be carried or dropped.
- The renderer the reader will use, when it is stated, so the transcription is checked the way it will
  be parsed later.

## Workflow

1. Walk the pages in order and decide, for each page, whether it carries any expression set on its own
   line, recording the page and the expression's printed label for every hit. A page with none gets
   reported as carrying none.
2. Read each expression as glyphs from the page rather than as characters from an extracted text
   layer: font and position give the sub- and superscripts, the Greek and special operators, the
   stacked or side-set limits, and which delimiter of each pair is sized tall and which is plain. A
   text layer that flattens or reorders the mathematics is not evidence of how the page displays it.
3. Write the transcription between the required delimiters so it renders as displayed: sized
   delimiters where the page sizes them, operator names spelled as operators, limits stacked where the
   page stacks them, and no printed label, comma or full stop carried inside the delimiters.
4. Test each transcription for syntax alone: delimiter pairs that do not balance, a sized delimiter
   without its match, a command left unclosed, a misspelt command name. An expression whose notation
   is unusual but well formed is left as it stands.
5. Emit all originals in page order, one per line. If any defect was found, print a blank line after
   the block, then the repaired copies in the same order, each a complete line that differs from its
   original only in the characters repaired. The original line is never edited, and no repair is
   written for a transcription that was not first written verbatim.
6. Keep the page renders, the per-expression crops and the rendered copies beside the output, so a
   later reader can repeat the comparison that justified each transcription.

## Verification

- Parse every output line with a strict parser for the target math syntax. A line that will not parse
  is a transcription defect, not a matter of rendering taste.
- Audit delimiter balance across all lines. Every line the audit flags must be one a fixed line
  repairs, and no fixed line may be flagged.
- Render each line and compare it side by side with a magnified crop of the region it came from,
  checking structure (fractions, limits, script placement, delimiter heights) rather than exact
  pixels.
- Re-read the originals after the fixed block was added and confirm not one character of them moved.

## Constraints

- Syntax and typographic spelling only. An index that looks wrong, a symbol that disagrees with the
  surrounding text, or anything else about what the mathematics means is content: it goes in the reply
  as an observation and the transcription stays as the page has it.
- Do not improve the display beyond what the page shows. A nicer rendering than the original is a
  change nobody asked for.
- Never let a repaired line stand in for its original, and never drop an expression that will not
  transcribe cleanly without saying so.
- The file carries transcriptions, not conclusions about the mathematics.

## Output

A text file at the requested path, one expression per line: the originals in page order, then, if
there were defects, a blank line and the repaired lines. The reply names the page range read and which
pages carried no display expression, identifies each defective expression and the defect, states what
was deliberately left unchanged and why, gives the path written and where the intermediate material
sits.

