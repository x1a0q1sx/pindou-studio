/**
 * check-cjk.mjs - ASCII-only self-audit for CJK corruption in edited files.
 *
 * Background: an editing channel historically corrupted Chinese chars
 * (e.g. U+680F -> U+6805, U+515C -> U+5175, U+515C -> U+514C).
 * This script never contains raw CJK bytes: every expected string is written
 * as unicode escapes, then asserted against the real file content (UTF-8).
 *
 * Usage: node scripts/check-cjk.mjs   (exit 0 = pass, 1 = fail)
 */
import { readFileSync } from 'node:fs';

/** U+FFFD replacement char */
const REPLACEMENT = '\u{FFFD}';
/** Historical corruption markers: U+6805 (mojibake of U+680F), U+5175 (mojibake of U+515C), U+514C (mojibake of U+515C) */
const BAD_CHARS = ['\u{6805}', '\u{5175}', '\u{514C}'];

const FILES = [
  {
    path: '../src/components/layout/AppShell.tsx',
    expect: [
      // new toast (back-to-classic feedback)
      '\u5df2\u8fd4\u56de\u7ecf\u5178\u4e09\u680f\u5e03\u5c40',
      // new aria/tooltip (back-to-classic)
      '\u8fd4\u56de\u7ecf\u5178\u4e09\u680f\u5e03\u5c40',
      // quickbar aria-label
      '\u5e03\u5c40\u5feb\u6377\u5165\u53e3',
      // tooltip: switch-layout / switch-theme
      '\u5207\u6362\u5e03\u5c40',
      '\u5207\u6362\u4e3b\u9898',
      // tooltip: help / start panel (with spaces around the middot)
      '\u5e2e\u52a9 \u00b7 \u5f00\u59cb\u9762\u677f',
      // aria: help and start panel
      '\u5e2e\u52a9\u4e0e\u5f00\u59cb\u9762\u677f',
      // comment (always able to switch back)
      '\u6781\u7b80\u58f3\u91cc\u6c38\u8fdc\u5207\u5f97\u56de\u53bb',
      // comment (exit hatch)
      '\u5207\u56de\u51fa\u53e3',
      // pre-existing strings (must survive edits)
      '\u7ecf\u5178\u4e09\u680f',
      '\u4e13\u6ce8\u62fc\u8c46',
    ],
  },
  {
    path: '../src/components/layout/layout.css',
    expect: [
      // comment (focus quickbar note)
      '\u6781\u7b80\u58f3\u6c38\u8fdc\u7559\u5207\u56de\u51fa\u53e3',
      // comment (below top strip)
      '\u4f4d\u4e8e\u9876\u90e8\u8272\u6761',
      // comment (does not cover swatches)
      '\u4e0d\u906e\u4f4f\u8272\u677f',
      // comment (after M hides the strip)
      '\u952e\u9690\u85cf\u8272\u6761\u540e\u8d34\u56de\u9876\u89d2',
      // pre-existing strings
      '\u9762\u677f',
      '\u753b\u5e03\u533a',
    ],
  },
  {
    path: '../src/io/bridge.ts',
    expect: [
      // comment: U+515C is the historically-corrupted char!
      '\u515c\u5e95\u9879',
      '\u515c\u5e95\u6253\u5f00',
      // comment: legacy files / no forced migration
      '\u5386\u53f2\u9057\u7559',
      '\u5f3a\u5236\u8fc1\u79fb',
      // comment: keep caller-provided extension
      '\u4e0d\u518d\u5f3a\u884c\u6539\u6269\u5c55\u540d',
      // comment: pass-through / both ends consistent / pick any file
      '\u539f\u6837\u900f\u4f20',
      '\u4e24\u7aef\u4e00\u81f4',
      '\u5408\u6cd5\u7684',
      '\u9009\u4e2d\u4efb\u610f\u6587\u4ef6',
      // pre-existing strings (display info / fallback save)
      '\u663e\u793a\u5668\u4fe1\u606f',
      '\u515c\u5e95\u4fdd\u5b58',
    ],
  },
  {
    path: '../src/components/canvas/StageCanvas.tsx',
    expect: [
      // comment: synthetic / stale pointerId
      '\u975e\u771f\u5b9e',
      '\u5408\u6210\u4e8b\u4ef6',
      '\u5df2\u5931\u6548\u6307\u9488',
      // comment: gesture abort / silent degrade
      '\u4e2d\u65ad\u624b\u52bf',
      '\u9759\u9ed8\u964d\u7ea7',
      // comment: capture failure tolerated
      '\u6355\u83b7\u5931\u8d25',
      '\u5e73\u79fb\u4e0d\u53d7\u5f71\u54cd',
      '\u6b63\u5e38\u6d3e\u53d1',
      // pre-existing strings (stage canvas header)
      '\u753b\u5e03\u4e3b\u7ec4\u4ef6',
      '\u6307\u9488\u4e8b\u4ef6',
    ],
  },
];

let failed = false;

for (const file of FILES) {
  const url = new URL(file.path, import.meta.url);
  let text;
  try {
    text = readFileSync(url, 'utf8');
  } catch (err) {
    console.log(`FAIL  ${file.path}: cannot read (${err.message})`);
    failed = true;
    continue;
  }

  const cjkCount = (text.match(/[\u4e00-\u9fff]/gu) || []).length;

  for (const needle of file.expect) {
    if (text.includes(needle)) {
      console.log(`ok    ${file.path}: found ${escapeLabel(needle)}`);
    } else {
      console.log(`FAIL  ${file.path}: MISSING ${escapeLabel(needle)}`);
      failed = true;
    }
  }

  if (text.includes(REPLACEMENT)) {
    console.log(`FAIL  ${file.path}: contains U+FFFD replacement char`);
    failed = true;
  }
  for (const bad of BAD_CHARS) {
    if (text.includes(bad)) {
      console.log(`FAIL  ${file.path}: contains corruption-marker U+${bad.codePointAt(0).toString(16)}`);
      failed = true;
    }
  }
  console.log(`info  ${file.path}: ${cjkCount} CJK chars scanned, no U+FFFD, no corruption markers`);
}

console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
process.exit(failed ? 1 : 0);

/** Render a string as ASCII-safe \\u escapes for logging */
function escapeLabel(s) {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    out += cp > 0x7e ? `\\u${cp.toString(16).padStart(4, '0')}` : ch;
  }
  return out;
}
