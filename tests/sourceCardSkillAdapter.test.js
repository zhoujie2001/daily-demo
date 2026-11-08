import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { sourceCardFixture } from './fixtures/source-card-manifest.js';
import { normalizeBatchDispatchIngest } from '../lib/dispatch/ingest.js';
import { sourceCardCanonicalJson, sourceCardManifestHash, validateSourceCardManifest } from '../lib/dispatch/source-card-manifest.js';

const document = readFileSync(new URL('../docs/ad-game-source-card-skill-adapter-v1.md', import.meta.url), 'utf8');
const exampleSection = document.split('## 3. 完整可校验 JSON 示例')[1]?.split('## 4.')[0];
const exampleText = exampleSection?.match(/```json\n([\s\S]*?)\n```/)?.[1];
const pythonImplementation = document.match(/```python\n(import hashlib[\s\S]*?)\n```/)?.[1];

function runPython(cases) {
  assert.ok(pythonImplementation, 'formal adapter must contain executable Python canonical/hash implementation');
  const runner = `
import sys
results = []
for case in json.load(sys.stdin):
    try:
        if case["mode"] == "manifest":
            manifest = case["value"]
            validate_manifest(manifest)
            content = {k: v for k, v in manifest.items() if k != "manifest_hash"}
            results.append({"ok": True, "canonical": canonical_json(content), "hash": manifest_hash(manifest)})
        else:
            results.append({"ok": True, "canonical": canonical_json(case["value"])})
    except (TypeError, ValueError, UnicodeError) as error:
        results.append({"ok": False, "error": type(error).__name__})
print(json.dumps(results, ensure_ascii=True))
`;
  const result = spawnSync('python3', ['-c', `${pythonImplementation}\n${runner}`], {
    input: JSON.stringify(cases), encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('正式Skill适配说明的完整JSON直接通过中台normalize，Python输出精确示例hash', () => {
  assert.ok(exampleText, 'formal adapter must contain complete JSON, not an abbreviated shape');
  const body = JSON.parse(exampleText);
  const normalized = normalizeBatchDispatchIngest(body, { splitCards: true });
  assert.equal(normalized.sourceCardManifest.total_item_count, 21);
  assert.equal(normalized.fieldsList[0].sourceCardBinding.chunk_index, 2);
  const [result] = runPython([{ mode: 'manifest', value: body.source_card_manifest }]);
  assert.equal(result.ok, true);
  assert.equal(result.hash, '96f1ef5c3a4a438322c87a6ab5c815aaba276784adb0de60e37817c84cf6b131');
  assert.equal(result.hash, sourceCardManifestHash(body.source_card_manifest));
  const { manifest_hash: _hash, ...content } = body.source_card_manifest;
  assert.equal(result.canonical, sourceCardCanonicalJson(content));
});

test('文档Python与JS的78/21/20清单及Unicode/UTF16排序/字符串转义字节一致', () => {
  const manifests = [78, 21, 20].map((total) => sourceCardFixture(total).manifest);
  // Reverse insertion order at both levels: canonical ordering must not depend on construction order.
  const reversed = Object.fromEntries(Object.entries(manifests[0]).reverse());
  reversed.chunks = reversed.chunks.map((chunk) => Object.fromEntries(Object.entries(chunk).reverse()));
  const values = [
    { '\uE000': 'private BMP key', '😀': 'astral key', a: '中文\n\t"\\/\u2028\u2029', z: [0, -1, 9007199254740991, true, false, null] },
    { b: { z: ['first', 'second'], a: 'literal \\u4e2d' }, a: [] },
  ];
  const results = runPython([
    ...[...manifests, reversed].map((value) => ({ mode: 'manifest', value })),
    ...values.map((value) => ({ mode: 'canonical', value })),
  ]);
  [...manifests, reversed].forEach((manifest, index) => {
    const { manifest_hash: _hash, ...content } = manifest;
    assert.equal(results[index].ok, true);
    assert.equal(results[index].canonical, sourceCardCanonicalJson(content));
    assert.equal(results[index].hash, sourceCardManifestHash(manifest));
  });
  values.forEach((value, index) => {
    assert.equal(results[index + 4].ok, true);
    assert.equal(results[index + 4].canonical, sourceCardCanonicalJson(value));
  });
});

test('文档Python拒绝重签结构错误、未知字段/版本、CODE无关字段、错误hash及非v1数字域', () => {
  const mutators = [
    (m) => { m.version = 2; },
    (m) => { m.future = 'not allowed'; },
    (m) => { m.chunks[0].future = 'not allowed'; },
    (m) => { m.reject_reason_codes = ['1000676']; },
    (m) => { m.total_item_count = 77; },
    (m) => { m.chunk_count = 3; },
    (m) => { m.chunks.pop(); },
    (m) => { m.chunks[0].item_count = 19; },
    (m) => { m.chunks[1].chunk_index = 1; },
    (m) => { m.chunks[1].batch_id = m.chunks[0].batch_id; },
    (m) => { m.chunks[1].request_ids[0] = m.chunks[0].request_ids[0]; },
    (m) => { m.dispatch_profile = 'test_default'; },
    (m) => { m.target_category = 'ad'; },
    (m) => { m.chat_id = 'invalid-chat'; },
    (m) => { m.chunks[0].request_ids[0] = 12; },
    (m) => { m.version = true; },
  ];
  const invalid = mutators.map((mutate) => {
    const manifest = sourceCardFixture().manifest;
    mutate(manifest); manifest.manifest_hash = sourceCardManifestHash(manifest);
    assert.throws(() => validateSourceCardManifest(manifest));
    return manifest;
  });
  invalid.push({ ...sourceCardFixture().manifest, manifest_hash: '0'.repeat(64) });
  invalid.push({ ...sourceCardFixture().manifest, manifest_hash: sourceCardFixture().manifest.manifest_hash.toUpperCase() });
  const results = runPython([
    ...invalid.map((value) => ({ mode: 'manifest', value })),
    { mode: 'canonical', value: 0.5 },
    { mode: 'canonical', value: 9007199254740992 },
    { mode: 'canonical', value: '\uD800' },
  ]);
  assert.equal(results.length, 21);
  results.forEach((result) => assert.equal(result.ok, false));
});
