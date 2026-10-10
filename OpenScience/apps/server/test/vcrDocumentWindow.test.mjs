import assert from 'node:assert/strict';
import test from 'node:test';
import { clinicalDocumentWindow } from '../src/vcrDocumentWindow.mjs';

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
