#!/usr/bin/env node
// server.mjs — job-radar as an MCP server (stdio), so an AI agent such as
// Claude Code, Claude Desktop or Cursor can call the scanner as tools.
//
//   claude mcp add job-radar -- node /path/to/job-radar/src/mcp/server.mjs
//
// Tools:
//   run_scan           one scan; free sources only by default, dry run by default
//   check_job_link     is this employer posting live, how old, eligible for me?
//   check_eligibility  eligibility + fit for pasted job text
//
// Guardrail: a connected agent cannot spend money by itself. Apify (paid)
// runs only when this server was started with RADAR_MCP_ALLOW_APIFY=1 AND
// the call asks for it; the per-scan cost caps still apply.
// stdout carries the protocol; all logging goes to stderr.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadEnv } from '../env.mjs';
import { runScanTool, checkJobLinkTool, checkEligibilityTool } from '../tools.mjs';

loadEnv();
const allowPaid = process.env.RADAR_MCP_ALLOW_APIFY === '1';

const server = new McpServer({ name: 'job-radar', version: '0.1.0' });

const asResult = (data) => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  structuredContent: data,
});
const asError = (err) => ({ isError: true, content: [{ type: 'text', text: `job-radar error: ${err.message}` }] });

server.registerTool('run_scan', {
  title: 'Scan for fresh jobs',
  description: 'Find jobs first posted in the last 24 hours that match the configured profile, verified live on the employer\'s own careers site, never reposts. Takes 30-120 seconds. By default it is a dry run (nothing saved) and uses free sources only.',
  inputSchema: {
    preset: z.string().default('run').describe('Scan preset: run, faang, staffing, startup, remote, local, "company <name>", or one from profile.yml'),
    include_apify: z.boolean().default(false).describe('Also search LinkedIn/Indeed through Apify (paid, up to $0.10). Ignored unless the server allows paid scans.'),
    dry_run: z.boolean().default(true).describe('true: do not mark jobs as seen. false: record them so they are not reported again.'),
  },
  annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: false },
}, async ({ preset, include_apify, dry_run }) => {
  try {
    return asResult(await runScanTool({ preset, includeApify: include_apify, dryRun: dry_run, allowPaid }));
  } catch (err) { return asError(err); }
});

server.registerTool('check_job_link', {
  title: 'Check a job posting link',
  description: 'For a posting URL on an employer ATS (Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Oracle, iCIMS): is it live, when was it first posted, and does it pass the profile\'s eligibility rules? LinkedIn/Indeed links are not accepted.',
  inputSchema: {
    url: z.string().url().describe('The job posting URL on the employer\'s careers site or ATS'),
    title: z.string().optional().describe('Job title, if known (used for the seniority check)'),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ url, title }) => {
  try { return asResult(await checkJobLinkTool({ url, title })); } catch (err) { return asError(err); }
});

server.registerTool('check_eligibility', {
  title: 'Check eligibility and fit for job text',
  description: 'Run the deterministic eligibility gate (sponsorship, citizenship, clearance, years, salary floor) and fit score on pasted job text, using the configured profile. No network access.',
  inputSchema: {
    description: z.string().min(1).describe('The full job description text'),
    title: z.string().optional().describe('Job title'),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ description, title }) => {
  try { return asResult(checkEligibilityTool({ title, description })); } catch (err) { return asError(err); }
});

await server.connect(new StdioServerTransport());
console.error(`[job-radar] MCP server ready (paid scans ${allowPaid ? 'allowed' : 'disabled'})`);
