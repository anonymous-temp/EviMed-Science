import assert from 'node:assert/strict';
import test from 'node:test';
import { clinicalDocumentWindow, documentReading } from '../src/vcrDocumentWindow.mjs';

test('overlapping Unicode windows preserve source offsets, units and an explicit unread tail', () => {
  const text = '病历'.repeat(15) + '否认😀心梗；肌酐 106 μmol/L。' + '随访'.repeat(60);
  let offset = 0; const windows = [];
  do {
    const window = clinicalDocumentWindow(text, offset, 40);
    assert.equal(window.text, text.slice(window.offset, window.end));
    assert.ok(window.text.isWellFormed());
    assert.equal(window.coverage.extraction, 'unknown');
    windows.push(window);
    offset = window.nextOffset;
  } while (offset != null);
  assert.equal(windows[0].offset, 0);
  assert.equal(windows.at(-1).end, text.length);
  assert.ok(windows.some(v => v.text.includes('否认😀心梗')));
  for (let i = 1; i < windows.length; i++) assert.ok(windows[i].offset < windows[i-1].end);
  assert.equal(clinicalDocumentWindow(text, text.indexOf('😀') + 1, 40).text[0], '😀'[0]);
});

test('what the windows served of a document is the union of their ranges, with what was never served beside it (E-06)', () => {
  const served = (...ranges) => ranges.map(([start, end]) => ({ served: [start, end] }));
  // Overlapping windows count once; a gap is skipped text, not read text.
  assert.deepEqual(documentReading(served([0, 40], [30, 70], [200, 240]), 300), { chars: 300, read: 110, skipped: 190, complete: false, windows: 3 });
  assert.deepEqual(documentReading(served([0, 20], [10, 60]), 60), { chars: 60, read: 60, skipped: 0, complete: true, windows: 2 });
  // Reads by different conversations add up; the same window read twice is one window of text.
  assert.equal(documentReading(served([0, 50], [0, 50], [0, 50]), 100).read, 50);
  // A window past the end of the text, or a malformed one, covers nothing it does not have.
  assert.equal(documentReading(served([0, 500]), 100).read, 100);
  assert.deepEqual(documentReading([{ served: [5, 1] }, { served: null }, {}], 100), { chars: 100, read: 0, skipped: 100, complete: false, windows: 0 });
  // A window records the text's length when it was served; without one the length is the caller's, and without either it is unknown.
  assert.deepEqual(documentReading([{ served: [0, 30], chars: 90 }]), { chars: 90, read: 30, skipped: 60, complete: false, windows: 1 });
  assert.deepEqual(documentReading(served([0, 30])), { chars: null, read: 30, skipped: null, complete: false, windows: 1 });
  // Never read at all.
  assert.deepEqual(documentReading([], 100), { chars: 100, read: 0, skipped: 100, complete: false, windows: 0 });
});
