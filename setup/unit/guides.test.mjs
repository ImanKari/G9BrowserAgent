/**
 * (3.8) The agent-facing text in layers (mcp/guides.js): the always-sent core stays small enough for every client
 * to send whole, every guide the core names exists, every tool action and argument a guide names is real, every
 * tool points at a guide, and the MCP server serves all of it — as resources and through browser_status guide —
 * with no daemon and no browser.
 */

import assert from 'node:assert/strict';
import { TOOLS, INSTRUCTIONS } from '../../mcp/tools.js';
import { GUIDES, GUIDE_TOPICS, guideIndex, toolReference, readGuide } from '../../mcp/guides.js';
import { createMcpServer } from '../../mcp/server.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const toolByName = new Map(TOOLS.map((t) => [t.name, t]));

test('the core instructions fit the strictest client limit (2,048 characters) and name every guide topic', () => {
  assert.ok(INSTRUCTIONS.length < 2048, `INSTRUCTIONS is ${INSTRUCTIONS.length} characters`);
  for (const topic of GUIDE_TOPICS) assert.ok(INSTRUCTIONS.includes(topic), `the core names the topic "${topic}"`);
  const named = /Topics: ([^.]+)\./.exec(INSTRUCTIONS)?.[1].split(',').map((t) => t.trim()) ?? [];
  assert.deepEqual(named, GUIDE_TOPICS, 'the core lists exactly the topics that exist, in reading order');
});

test('every tool description is short, front-loaded and points at a guide', () => {
  for (const tool of TOOLS) {
    assert.ok(tool.description.length <= 700, `${tool.name}: ${tool.description.length} characters`);
    assert.match(tool.description, /Guides?: |guide:"/, `${tool.name} names its guide`);
    for (const topic of tool.description.match(/Guides?: ([a-z, ]+)\./)?.[1].split(',').map((t) => t.trim()) ?? []) {
      assert.ok(GUIDE_TOPICS.includes(topic), `${tool.name} points at the guide "${topic}", which exists`);
    }
  }
});

test('every tool action a guide names is one the tool has', () => {
  for (const [topic, guide] of Object.entries(GUIDES)) {
    for (const m of guide.text.matchAll(/(browser_\w+)\s+(action|what):"([a-z_]+)"/g)) {
      const tool = toolByName.get(m[1]);
      assert.ok(tool, `guide ${topic} names the tool ${m[1]}`);
      const values = tool.inputSchema.properties[m[2]]?.enum ?? [];
      assert.ok(values.includes(m[3]), `guide ${topic}: ${m[1]} ${m[2]}:"${m[3]}" exists`);
    }
    for (const m of guide.text.matchAll(/\bbrowser_[a-z]+\b/g)) assert.ok(toolByName.has(m[0]), `guide ${topic}: ${m[0]} is a tool`);
  }
});

test('every topic is a readable guide; the reference lists every argument of a tool', () => {
  for (const topic of GUIDE_TOPICS) {
    assert.ok(GUIDES[topic].title && GUIDES[topic].summary, `${topic} has a title and summary`);
    assert.equal(readGuide(topic), GUIDES[topic].text);
    assert.ok(GUIDES[topic].text.length < 4096, `${topic} stays one screenful (${GUIDES[topic].text.length})`);
  }
  for (const tool of TOOLS) {
    const ref = toolReference(tool.name);
    for (const key of Object.keys(tool.inputSchema.properties)) assert.ok(ref.includes(`\`${key}\``), `${tool.name} reference lists ${key}`);
    assert.equal(readGuide(`tool:${tool.name}`), ref);
  }
  assert.equal(readGuide(''), guideIndex());
  assert.match(readGuide('nope'), /^No guide named "nope"[\s\S]*# G9BrowserAgent guides/);
  assert.equal(toolReference('browser_nope'), null);
});

test('the MCP server serves the guides as resources and through browser_status guide, with no daemon', async () => {
  const link = { name: null, welcome: null, call: async () => { throw new Error('no daemon in this test'); } };
  const mcp = createMcpServer(link);
  const rpc = async (method, params = {}) => (await mcp.handle({ jsonrpc: '2.0', id: 1, method, params })).result;

  const init = await rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test' } });
  assert.equal(init.instructions, INSTRUCTIONS);
  const { resources } = await rpc('resources/list');
  const uris = resources.map((r) => r.uri);
  for (const uri of ['g9://guide', 'g9://instructions', 'g9://status', ...GUIDE_TOPICS.map((t) => `g9://guide/${t}`), ...TOOLS.map((t) => `g9://tool/${t.name}`)]) {
    assert.ok(uris.includes(uri), `resource ${uri}`);
  }
  const read = await rpc('resources/read', { uri: 'g9://guide/console' });
  assert.equal(read.contents[0].text, GUIDES.console.text);

  const called = await rpc('tools/call', { name: 'browser_status', arguments: { guide: 'sharing' } });
  assert.ok(!called.isError, 'answered without the daemon');
  assert.equal(called.content[0].text, GUIDES.sharing.text);
  const ref = await rpc('tools/call', { name: 'browser_status', arguments: { guide: 'tool:browser_tabs' } });
  assert.match(ref.content[0].text, /^# browser_tabs/);
  const plain = await rpc('tools/call', { name: 'browser_status', arguments: {} });
  assert.equal(plain.isError, true, 'a status without guide still goes to the daemon');
});

for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (err) {
    console.log(`  FAIL ${name}\n${err?.stack ?? err}`);
    process.exit(1);
  }
}
