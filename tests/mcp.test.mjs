// MCP server: starts the real server over stdio and talks to it with the
// official MCP client. Only the offline tool is called (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { checkJobLinkTool } from '../src/tools.mjs';

const SERVER = fileURLToPath(new URL('../src/mcp/server.mjs', import.meta.url));

test('mcp: lists the three tools and answers check_eligibility', async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], stderr: 'ignore' });
  const client = new Client({ name: 'job-radar-test', version: '0.0.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['check_eligibility', 'check_job_link', 'run_scan']);
    const scan = tools.find((t) => t.name === 'run_scan');
    assert.equal(scan.inputSchema.properties.dry_run.default, true, 'scans are dry runs unless asked');
    assert.equal(scan.inputSchema.properties.include_apify.default, false, 'paid sources are off unless asked');

    const pad = ' Build data pipelines and ML models in Python and SQL for analytics teams.'.repeat(5);
    const res = await client.callTool({ name: 'check_eligibility', arguments: { title: 'Data Scientist', description: `We will not sponsor visas now or in the future.${pad}` } });
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.eligibility, 'BLOCKED');
    assert.match(res.structuredContent.blocked[0].reason, /sponsorship/);
  } finally {
    await client.close();
  }
});

test('check_job_link: aggregator links are refused; ATS postings report age and eligibility', async () => {
  const li = await checkJobLinkTool({ url: 'https://www.linkedin.com/jobs/view/123' });
  assert.equal(li.supported, false);

  const now = Date.parse('2026-10-22T12:00:00Z');
  const fetchImpl = async (url) => ({
    ok: true, status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ first_published: '2026-10-22T06:00:00Z', absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/42', content: '&lt;p&gt;Python, SQL and PyTorch. Visa sponsorship available.&lt;/p&gt;'.repeat(10) }),
    text: async () => '',
    url,
  });
  const r = await checkJobLinkTool({ url: 'https://job-boards.greenhouse.io/acme/jobs/42', title: 'ML Engineer' }, { fetchImpl, now });
  assert.equal(r.supported, true);
  assert.equal(r.ats, 'greenhouse');
  assert.equal(r.live, true);
  assert.equal(r.ageHours, 6);
  assert.equal(r.postedWithin24h, true);
  assert.ok(['OK', 'VERIFY'].includes(r.eligibility));
});
