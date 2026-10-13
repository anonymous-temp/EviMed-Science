// The readers of what OpenViking's Compile writes, first on cases written for them and then on trees real compiles
// left (`fixtures/compiled-knowledge/`, byte-exact from the lab instance of 2026-10-12: a wiki compiled with the
// quotation instruction and the documents it was compiled from, two knowledge graphs, and three states of one wiki
// that was edited by hand and recompiled twice).
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  KNOWLEDGE_PAGE_SUBMIT_LIMIT, applyKnowledgePageEdits, checkPageQuotations, diffKnowledgePageEdit, isKnowledgeMirrorPath, isTypedKnowledgePage,
  knowledgeGraphToGraph, knowledgeMirrorPath, knowledgeMirrorPathOf, knowledgePageUnits, knowledgeSourceIdOfUri, okfMarkdownLinks,
  readKnowledgePage, splitOkfFrontmatter, wikiPagesToGraph,
} from '../index.mjs'
import { quoteIsPresent } from '../src/clinicalEvidence.mjs'

const fixtures = new URL('./fixtures/compiled-knowledge/', import.meta.url).pathname

/** A saved tree as `[{ path, content }]`, hidden sidecars and the listing left out. @param {string} directory */
function loadTree(directory) {
  /** @type {{ path: string, content: string }[]} */
  const files = []
  const walk = (/** @type {string} */ dir, /** @type {string} */ prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name.startsWith('.') || entry.name === '_listing.json') continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel)
      else files.push({ path: rel, content: fs.readFileSync(path.join(dir, entry.name), 'utf8') })
    }
  }
  walk(directory, '')
  return files
}
const digest = (/** @type {string} */ text) => createHash('sha256').update(text).digest('hex').slice(0, 16)

test('front matter: scalars, inline list, block list, wrapped description', () => {
  const { data, body, raw } = splitOkfFrontmatter(
    '---\ntype: entity\nid: 取经队伍\ntitle: "A: B"\ndescription: 由唐三藏率领、\n  以西行取经为目标的行动团体。\naliases: [唐僧师徒, "师徒, 五众"]\nsources:\n  - viking://resources/a.md\n  - viking://resources/b c.md\n---\n\n# 取经队伍\n',
  )
  assert.equal(data.type, 'entity')
  assert.equal(data.title, 'A: B')
  assert.equal(data.description, '由唐三藏率领、 以西行取经为目标的行动团体。')
  assert.deepEqual(data.aliases, ['唐僧师徒', '师徒, 五众'])
  assert.deepEqual(data.sources, ['viking://resources/a.md', 'viking://resources/b c.md'])
  assert.equal(body.trim(), '# 取经队伍')
  assert.ok(raw.startsWith('---\ntype: entity') && raw.endsWith('---\n'))
})

test('front matter: a file without one is all body', () => {
  const parsed = splitOkfFrontmatter('# Title\n\ntext')
  assert.equal(parsed.hasFrontmatter, false)
  assert.equal(parsed.body, '# Title\n\ntext')
})

test('links: destinations with spaces, titles with quotes and parentheses, code and images skipped', () => {
  const links = okfMarkdownLinks([
    'See [Lumen 工作组](Lumen 工作组.md) and [x](../concept/a(b).md).',
    '![img](pic.png) `[no](no.md)` [RE-LY](viking://user/u1/resources/p/x/sources/s.md "relative risk, 0.66; 95% CI (0.53 to 0.82)")',
    '```\n[fenced](fenced.md)\n```',
    '[q](viking://a/b.md "he said \\"yes\\" twice")',
  ].join('\n'))
  assert.deepEqual(links.map((link) => [link.text, link.target, link.title]), [
    ['Lumen 工作组', 'Lumen 工作组.md', null],
    ['x', '../concept/a(b).md', null],
    ['RE-LY', 'viking://user/u1/resources/p/x/sources/s.md', 'relative risk, 0.66; 95% CI (0.53 to 0.82)'],
    ['q', 'viking://a/b.md', 'he said "yes" twice'],
  ])
})

test('wiki graph: relative, absolute and same-name links; sources kept apart; no self loops or duplicates', () => {
  const root = 'viking://user/u1/resources/p/x/wiki'
  const graph = wikiPagesToGraph([
    { path: 'index.md', content: '---\ntype: index\ntitle: Wiki\ndescription: d\n---\n# Wiki\n- [Alpha](entity/Alpha 协议.md)\n- [Sync](concept/sync.md)\n' },
    {
      path: 'entity/Alpha 协议.md',
      content: `---\ntype: entity\ntitle: Alpha 协议\ndescription: d\ntags: [protocol]\n---\n# Alpha 协议\n[self](Alpha 协议.md) [sync](../concept/sync.md) [again](../concept/sync.md#x) [abs](${root}/index.md) [byname](sync.md)\n\n## 来源\n- [alpha](viking://user/u1/resources/p/x/sources/alpha.md "UDP 端口 4123")\n- [web](https://example.org)\n- [gone](missing.md)\n`,
    },
    { path: 'concept/sync.md', content: '# Time sync\nno frontmatter\n' },
  ], { root })
  assert.deepEqual(graph.nodes.map((node) => [node.id, node.type, node.title]), [
    ['index.md', 'index', 'Wiki'], ['entity/Alpha 协议.md', 'entity', 'Alpha 协议'], ['concept/sync.md', 'concept', 'Time sync'],
  ])
  assert.deepEqual(graph.links.map((link) => `${link.source} -> ${link.target}`), [
    'index.md -> entity/Alpha 协议.md', 'index.md -> concept/sync.md', 'entity/Alpha 协议.md -> concept/sync.md', 'entity/Alpha 协议.md -> index.md',
  ])
  assert.deepEqual(graph.nodes[1].sources, [{ uri: 'viking://user/u1/resources/p/x/sources/alpha.md', text: 'alpha', quote: 'UDP 端口 4123' }])
  assert.deepEqual(graph.unresolved, [{ source: 'entity/Alpha 协议.md', target: 'missing.md', text: 'gone' }])
  assert.equal(graph.nodes.find((node) => node.id === 'concept/sync.md')?.degree, 2)
})

test('knowledge graph: nodes, edges, merged duplicates, and what could not be read is named', () => {
  const graph = knowledgeGraphToGraph([
    { path: 'entities/孙悟空.md', content: '---\ntype: entity\nid: 孙悟空\ntitle: 孙悟空\nentity_type: person\ndescription: 取经队伍成员。\naliases: [行者]\nsources:\n  - viking://resources/s.md\n---\n\n## 概览\n正文\n' },
    { path: 'entities/取经队伍.md', content: '---\ntype: entity\nid: 取经队伍\ntitle: 取经队伍\nentity_type: group\ndescription: 团体。\nsources: [viking://resources/s.md]\n---\n' },
    {
      path: 'relations.jsonl',
      content: [
        '{"from":"孙悟空","relation":"member_of","label":"属于","to":"取经队伍","evidence":["viking://resources/s.md"]}',
        '{"from":"孙悟空","relation":"member_of","label":"属于","to":"取经队伍","evidence":["viking://resources/t.md"]}',
        '{"from":"孙悟空","relation":"knows","label":"认识","to":"猪八戒","evidence":["viking://resources/s.md"]}',
        'not json',
        '{"from":"取经队伍","relation":"Leads","label":"领导","to":"孙悟空","evidence":[]}',
        '',
      ].join('\n'),
    },
    { path: 'index.md', content: 'ignored' },
    { path: 'entities/index.md', content: '---\ntype: index\ntitle: 图谱索引\ndescription: d\n---\n' },
  ])
  assert.deepEqual(graph.nodes.map((node) => [node.id, node.entityType, node.degree]), [['孙悟空', 'person', 2], ['取经队伍', 'group', 2]])
  assert.deepEqual(graph.nodes[0].aliases, ['行者'])
  assert.equal(graph.nodes[0].body, '## 概览\n正文')
  assert.deepEqual(graph.links[0], { source: '孙悟空', target: '取经队伍', relation: 'member_of', label: '属于', evidence: ['viking://resources/s.md', 'viking://resources/t.md'] })
  assert.equal(graph.links.length, 2)
  assert.deepEqual(graph.problems.map((problem) => problem.kind).sort(), [
    'non_entity_file_in_entities', 'relation_duplicate_triple', 'relation_endpoint_unknown', 'relation_line_not_json', 'relation_not_snake_case', 'relation_without_evidence',
  ])
  assert.deepEqual(graph.relationCounts[0], { relation: 'Leads', label: '领导', count: 1 })
})

test('quotation labels: present, absent, missing source, list links counted apart, a link that lost its .md', () => {
  const src = 'src_00000000000000000000000000000001'
  const outcome = checkPageQuotations([{
    path: 'entity/a.md',
    content: `---\ntype: entity\ntitle: A\ndescription: d\n---\n# A\nClaim one [s](viking://x/sources/${src}.md "默认同步周期为 64 秒"). Claim two [s](viking://x/sources/${src} "never written"). Claim three [s](viking://x/sources/${src}.md). [t](viking://x/sources/gone.md "q")\n\n## 来源\n- [S](viking://x/sources/${src}.md)\n`,
  }], { sourceText: (_uri, sourceId) => (sourceId === src ? '它使用 UDP 端口 4123，默认同步周期为 64 秒。' : null) })
  assert.deepEqual(outcome.records.map((record) => record.status), ['present', 'absent', 'no_quotation', 'source_missing', 'no_quotation'])
  assert.deepEqual(outcome.records.map((record) => record.sourceId), [src, src, src, null, src])
  assert.deepEqual(outcome.summary, { pages: 1, sourceLinks: 5, inSourceList: 1, besideClaims: 4, besideClaimsWithQuotation: 3, present: 1, absent: 1, noQuotation: 1, sourceMissing: 1 })
  assert.equal(knowledgeSourceIdOfUri('viking://user/u/resources/p/p1/wiki/index.md'), null)
})

// ---- the real trees ------------------------------------------------------------------------------------------------

test('a real wiki: every page is a node with a type and a title, the index reaches the pages, every link joins two nodes', () => {
  const dir = path.join(fixtures, 'mix-wiki')
  const listing = JSON.parse(fs.readFileSync(path.join(dir, '_listing.json'), 'utf8'))
  const files = loadTree(dir)
  const graph = wikiPagesToGraph(files, { root: listing.root })
  const ids = new Set(graph.nodes.map((node) => node.id))
  assert.equal(graph.nodes.length, files.length)
  assert.ok(graph.nodes.length >= 10)
  assert.ok(graph.nodes.every((node) => node.title && node.type))
  assert.ok(graph.nodes.some((node) => node.type === 'index'))
  assert.ok(graph.links.length >= graph.nodes.length - 1)
  assert.ok(graph.links.every((link) => ids.has(link.source) && ids.has(link.target) && link.source !== link.target))
  const linked = new Set(graph.links.flatMap((link) => [link.source, link.target]))
  assert.ok(graph.nodes.every((node) => linked.has(node.id)), 'a page no link reaches')
  assert.deepEqual(graph.unresolved, [])
  // Every typed page counts against the engine's limit, and this tree is well short of where the platform stops.
  assert.ok(files.filter((file) => isTypedKnowledgePage(file.path, file.content)).length < KNOWLEDGE_PAGE_SUBMIT_LIMIT)
})

test('a real wiki: the quotation each source link carries is checked against the document it names', () => {
  const dir = path.join(fixtures, 'mix-wiki')
  const sources = new Map(fs.readdirSync(path.join(fixtures, 'mix-sources')).map((name) => [name.replace(/\.md$/, ''), fs.readFileSync(path.join(fixtures, 'mix-sources', name), 'utf8')]))
  const outcome = checkPageQuotations(loadTree(dir), { sourceText: (_uri, sourceId) => (sourceId ? sources.get(sourceId) ?? null : null) })
  // 119 links beside claims, all carrying a quotation; one is truly not in its document (a CSV row copied with a field
  // missing) and stays ⚠. The other three this tree used to mark ⚠ are list items that begin with a time or a date.
  assert.equal(outcome.summary.besideClaims, 119)
  assert.equal(outcome.summary.besideClaimsWithQuotation, 119)
  assert.equal(outcome.summary.sourceMissing, 0)
  const absent = outcome.records.filter((record) => !record.inSourceList && record.status === 'absent')
  assert.deepEqual(absent.map((record) => record.quote), ['SY10,柯桥店,绍兴,2F,营业,4120,13650,,蓝牙,上次盘点数据丢失'])
  assert.equal(outcome.summary.present, 118)
})

test('real knowledge graphs: entities and relations read, every edge joins two nodes and names its evidence', () => {
  for (const name of ['med-kg', 'mix-kg']) {
    const files = loadTree(path.join(fixtures, name))
    const graph = knowledgeGraphToGraph(files)
    const ids = new Set(graph.nodes.map((node) => node.id))
    assert.equal(graph.nodes.length, files.filter((file) => /^entities\/[^/]+\.md$/.test(file.path) && /^---\n(?:.*\n)*?type: entity\n/.test(file.content)).length, name)
    assert.ok(graph.nodes.length > 0 && graph.links.length > 0, name)
    assert.ok(graph.nodes.every((node) => node.title && node.entityType && node.description), name)
    assert.ok(graph.links.every((link) => ids.has(link.source) && ids.has(link.target) && link.label && link.evidence.length > 0), name)
    // Evidence and sources are addresses of pushed documents: the product maps each back to its own document id.
    assert.ok(graph.links.every((link) => link.evidence.every((uri) => knowledgeSourceIdOfUri(uri))), name)
  }
})

// ---- the nine quotations the platform's comparison refused while they stood in their documents -----------------------

test('quoteIsPresent: a quotation that starts at the number a Markdown list item begins with is in the document', () => {
  const read = (/** @type {string} */ id) => fs.readFileSync(path.join(fixtures, 'mix-sources', `${id}.md`), 'utf8')
  const review = read('src_3191c1be80141b92e13d1f3373520072')
  const todo = read('src_b8fc04833ee0661bb88310823ea981b2')
  const minutes = read('src_df149068671ff3e8a5ee48080b0c967a')
  // The nine of 568 (lab/knowledge RESULTS item 7): six distinct quotations, three of them written by two pages.
  const cases = [
    [review, '15:20 设备 B 电量低，店员换了备用机 C 继续，C 的系统时间是 **2026-04-01 15:2x**（慢了整整一天，备用机一直没联网）'],
    [todo, '4/2 演练出事了，见贺川的复盘。5/6 试点压力大，和卢经理打个预防针？'],
    [todo, '4/2 演练出事了，见贺川的复盘。5/6 试点压力大，和卢经理打个预防针？'],
    [minutes, '5/6 试点的 3 家还没定是哪 3 家！！卢经理说「挑生意一般的」。暂定：湖滨店、大学城店、北站店。'],
    [todo, '4/2 演练出事了，见贺川的复盘。5/6 试点压力大，和卢经理打个预防针？'],
    [review, '14:05 设备 A、B 开始离线盘点'],
    [review, '16:10 三台设备回到一楼联网同步'],
    [review, '16:12 看板显示大量 SKU 数量回退'],
    [review, '16:12 看板显示大量 SKU 数量回退'],
  ]
  for (const [text, quote] of cases) assert.equal(quoteIsPresent(text, quote), true, quote)
  // With the marker copied too it always stood, and still does.
  assert.equal(quoteIsPresent(review, '- 14:05 设备 A、B 开始离线盘点'), true)
})

test('quoteIsPresent: a marker before a number is still a sign where nothing says the line is a list item', () => {
  // A wrapped line: the minus belongs to the number, and a quotation without it would change the finding.
  assert.equal(quoteIsPresent('The mean change in systolic pressure was\n- 5.2 mmHg in the treatment arm.', '5.2 mmHg in the treatment arm'), false)
  assert.equal(quoteIsPresent('The mean change in systolic pressure was\n- 5.2 mmHg in the treatment arm.', '- 5.2 mmHg in the treatment arm'), true)
  // Mid-line, and a second such line after the first, are not list items either.
  assert.equal(quoteIsPresent('difference of - 3 points\n- 4 points at week two', '4 points at week two'), false)
  // A list: after a blank line, after a heading, after another item.
  assert.equal(quoteIsPresent('Doses\n\n- 5 mg once daily\n- 10 mg once daily', '10 mg once daily'), true)
  assert.equal(quoteIsPresent('## Timeline\n- 2021 first report', '2021 first report'), true)
  assert.equal(quoteIsPresent('- baseline visit\n* 12 weeks: primary endpoint', '12 weeks: primary endpoint'), true)
  // The number itself is still not to be cut.
  assert.equal(quoteIsPresent('Doses\n\n- 150 mg twice daily', '50 mg twice daily'), false)
})

// ---- pages as the product reads and keeps them -----------------------------------------------------------------------

test('mirror paths: a compiled file keeps its name in the project, a name that cannot be a file is refused', () => {
  assert.equal(knowledgeMirrorPath('wiki', 'entity/拾页书店库存系统（shiye-inventory）.md'), 'knowledge-base/wiki/entity/拾页书店库存系统（shiye-inventory）.md')
  assert.deepEqual(knowledgeMirrorPathOf('knowledge-base/kg/relations.jsonl'), { tree: 'kg', rel: 'relations.jsonl' })
  assert.deepEqual(knowledgeMirrorPathOf('knowledge-base/wiki/concept/4·2 复盘.md'), { tree: 'wiki', rel: 'concept/4·2 复盘.md' })
  assert.equal(knowledgeMirrorPathOf('knowledge-base/notes/a.md'), null)
  assert.equal(knowledgeMirrorPathOf('knowledge-base/wiki/../notes/a.md'), null)
  for (const bad of ['', '/a.md', 'a/', 'a/../b.md', '.abstract.md', 'entity/.overview.md', 'a\\b.md', 'a\u0000.md', `${'长'.repeat(80)}.md`]) assert.equal(isKnowledgeMirrorPath(bad), false, bad)
})

test('reading a page: its links are to pages, to sources with their quotation, or out of the engine', () => {
  const root = 'viking://user/u1/resources/p/p1/wiki'
  const page = readKnowledgePage(
    `---\ntype: concept\ntitle: 时间同步\ndescription: d\ntags: [a, b]\n---\n\n# 时间同步\n\n默认周期 64 秒 [Alpha](viking://user/u1/resources/p/p1/sources/src_00000000000000000000000000000001.md "默认同步周期为 64 秒")。\n\n- 见 [Alpha 协议](../entity/Alpha 协议.md) 与 [目录](${root}/index.md)\n- [RFC](https://example.org/rfc)\n`,
    { path: 'concept/时间同步.md', root })
  assert.equal(page.title, '时间同步')
  assert.equal(page.type, 'concept')
  assert.deepEqual(page.tags, ['a', 'b'])
  assert.deepEqual(page.links.map((link) => [link.kind, link.path ?? link.uri, link.quote]), [
    ['source', 'viking://user/u1/resources/p/p1/sources/src_00000000000000000000000000000001.md', '默认同步周期为 64 秒'],
    ['page', 'entity/Alpha 协议.md', null], ['page', 'index.md', null], ['external', null, null],
  ])
  assert.deepEqual(page.units.map((unit) => [unit.kind, unit.heading]), [['heading', '时间同步'], ['paragraph', '时间同步'], ['item', '时间同步'], ['item', '时间同步']])
})

test('units: a list item keeps what is indented under it, a table and a fenced block are one unit each', () => {
  const units = knowledgePageUnits('# T\n\n- one\n  more of one\n\n  still one\n- two\n\nPara\nline two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```\n- not an item\n\n# not a heading\n```\n\n## H2\ntext\n')
  assert.deepEqual(units.map((unit) => [unit.kind, unit.text.split('\n').length, unit.heading]), [
    ['heading', 1, 'T'], ['item', 4, 'T'], ['item', 1, 'T'], ['paragraph', 2, 'T'], ['table', 3, 'T'], ['code', 5, 'T'], ['heading', 1, 'H2'], ['paragraph', 1, 'H2'],
  ])
})

test("a person's edits: what they added is put back after a recompile that dropped it, what they took out stays out", () => {
  const read = (/** @type {string} */ version, /** @type {string} */ page) => fs.readFileSync(path.join(fixtures, 'accumulation', version, page), 'utf8')
  // Three real pages: a paragraph added, a paragraph added, a section with a table added. The engine kept all three
  // through the first recompile and dropped all three in the second (`v3`).
  for (const [page, words] of [
    ['concept/盘点差异率.md', '重新整理时请保留本段'], ['concept/离线盘点与同步冲突合并.md', '阅读提示：新同事先读这一页'], ['entity/0402盘点演练数据错乱事故.md', '备用机台账'],
  ]) {
    const { edits, added } = diffKnowledgePageEdit(read('v1', page), read('v1-after-hand-edits', page), null, { digest })
    assert.ok(added >= 1, page)
    assert.ok(edits.blocks.some((block) => block.text.includes(words)), page)
    const recompiled = read('v3-after-source-delete-no-instruction', page)
    assert.equal(recompiled.includes(words), false, `${page}: the fixture is the recompile that dropped the edit`)
    const applied = applyKnowledgePageEdits(recompiled, edits)
    assert.equal(applied.changed, true, page)
    assert.equal(applied.restored.length, edits.blocks.length, page)
    for (const block of edits.blocks) assert.ok(applied.markdown.includes(block.text), page)
    // The front matter is the engine's, byte for byte, and applying twice changes nothing more.
    assert.equal(splitOkfFrontmatter(applied.markdown).raw, splitOkfFrontmatter(recompiled).raw)
    assert.equal(applyKnowledgePageEdits(applied.markdown, edits).changed, false, page)
  }
  // A sentence the person deleted from a paragraph: the paragraph as they left it is theirs, and takes the place of the
  // engine's when a recompile writes the engine's back.
  const before = read('v1', 'entity/拾页书店.md')
  const after = read('v1-after-hand-edits', 'entity/拾页书店.md')
  const { edits } = diffKnowledgePageEdit(before, after, null, { digest })
  assert.equal(edits.blocks.length, 1)
  assert.ok(edits.blocks[0].replaces)
  assert.equal(applyKnowledgePageEdits(before, edits).markdown, after)
})

test("a person's edits: rewording a block of their own keeps one block, taking it out forgets it, the title is theirs", () => {
  const compiled = '---\ntype: concept\ntitle: A\ndescription: engine words\n---\n\n# A\n\nEngine paragraph one.\n\n## Notes\n\n- engine item\n'
  const first = compiled.replace('- engine item\n', '- engine item\n- my item\n').replace('title: A', 'title: My title')
  const one = diffKnowledgePageEdit(compiled, first, null, { digest })
  assert.deepEqual(one.edits.blocks.map((block) => [block.text, block.heading, block.after, block.replaces]), [['- my item', 'Notes', '- engine item', null]])
  assert.deepEqual(one.edits.frontmatter, { title: 'My title' })
  const second = first.replace('- my item', '- my item, reworded').replace('Engine paragraph one.', 'My version of paragraph one.')
  const two = diffKnowledgePageEdit(first, second, one.edits, { digest })
  assert.deepEqual(two.edits.blocks.map((block) => [block.text, block.replaces]).sort(), [['- my item, reworded', null], ['My version of paragraph one.', 'Engine paragraph one.']])
  // The engine writes its own page again: the reworded paragraph takes the place of the engine's, the item goes back under its neighbour, the title is set.
  const applied = applyKnowledgePageEdits(compiled, two.edits)
  assert.equal(applied.markdown, '---\ntype: concept\ntitle: "My title"\ndescription: engine words\n---\n\n# A\n\nMy version of paragraph one.\n\n## Notes\n\n- engine item\n- my item, reworded\n')
  const third = second.replace('- my item, reworded\n', '').replace('- engine item\n', '')
  const three = diffKnowledgePageEdit(second, third, two.edits, { digest })
  assert.deepEqual(three.edits.blocks.map((block) => block.text), ['My version of paragraph one.'])
  // An engine unit the person took out is remembered, and taken out again when the engine writes it back.
  assert.deepEqual(three.edits.removed.map((entry) => entry.text), ['- engine item'])
  assert.equal(applyKnowledgePageEdits(compiled, three.edits).markdown.includes('- engine item'), false)
})
