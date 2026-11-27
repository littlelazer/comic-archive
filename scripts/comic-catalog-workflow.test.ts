// ABOUTME: Pins the comic-catalog CI workflow: it runs the MCP server's Bun tests on pull requests and main.
// ABOUTME: Kept in its own workflow file so upstream changes to ci.yml merge without conflicts.
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Step = { run?: string; uses?: string; with?: Record<string, unknown> };

const workflow = parse(
  readFileSync(new URL('../.github/workflows/comic-catalog.yml', import.meta.url), 'utf8'),
) as {
  on: Record<string, { branches?: string[] }>;
  permissions?: Record<string, string>;
  jobs: Record<string, { steps: Step[] }>;
};

const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);

describe('comic-catalog CI workflow', () => {
  it('runs on pull requests and pushes to main', () => {
    expect(workflow.on.pull_request?.branches).toEqual(['main']);
    expect(workflow.on.push?.branches).toEqual(['main']);
  });

  it('has a read-only token', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
  });

  it('runs the comic-catalog server tests with the pinned Bun', () => {
    const bun = steps.find((s) => s.uses?.startsWith('oven-sh/setup-bun@'));
    expect(bun?.with?.['bun-version']).toBe('1.4.4');
    expect(steps.map((s) => s.run)).toContain('bun test ./templates/comic-catalog/server');
  });
});
