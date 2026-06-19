import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deploy } from '../scripts/deploy.mjs';

function linkedDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dep-'));
  mkdirSync(join(dir, '.vercel'), { recursive: true });
  writeFileSync(join(dir, '.vercel', 'project.json'), '{"projectId":"x","orgId":"y"}');
  return dir;
}

test('fails loudly when token missing', () => {
  const r = deploy({ siteDir: linkedDir(), token: '', run: () => { throw new Error('should not run'); } });
  assert.equal(r.ok, false);
  assert.match(r.error, /VERCEL_TOKEN/);
});

test('fails loudly when project.json missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dep-'));
  const r = deploy({ siteDir: dir, token: 'tok', run: () => { throw new Error('should not run'); } });
  assert.equal(r.ok, false);
  assert.match(r.error, /project\.json/);
});

test('success: parses URL and calls run with cwd, token, arg order', () => {
  const dir = linkedDir();
  const calls = [];
  const run = (args, opts) => {
    calls.push({ args, opts });
    return args[0] === 'whoami'
      ? 'khe618\n'
      : 'Inspect: https://vercel.com/x\nProduction: https://review-digest-abc.vercel.app\n';
  };
  const r = deploy({ siteDir: dir, token: 'tok', run });
  assert.equal(r.ok, true);
  assert.equal(r.url, 'https://review-digest-abc.vercel.app');
  assert.deepEqual(calls[0].args, ['whoami', '--token', 'tok']);
  assert.deepEqual(calls[1].args, ['--prod', '--yes', '--token', 'tok']);
  assert.equal(calls[1].opts.cwd, dir);
});

test('whoami failure → ok:false', () => {
  const run = (args) => { if (args[0] === 'whoami') throw new Error('bad token'); return 'x'; };
  const r = deploy({ siteDir: linkedDir(), token: 'tok', run });
  assert.equal(r.ok, false);
  assert.match(r.error, /whoami/);
});

test('deploy failure → ok:false', () => {
  const run = (args) => { if (args[0] === 'whoami') return 'ok'; throw new Error('build error'); };
  const r = deploy({ siteDir: linkedDir(), token: 'tok', run });
  assert.equal(r.ok, false);
  assert.match(r.error, /deploy failed/);
});

test('non-URL stdout → ok:false (no null-URL success)', () => {
  const run = (args) => (args[0] === 'whoami' ? 'ok' : 'Queued...\nError: something');
  const r = deploy({ siteDir: linkedDir(), token: 'tok', run });
  assert.equal(r.ok, false);
  assert.equal(r.url, null);
  assert.match(r.error, /no deployment URL/);
});

test('parses deployment.url from real JSON stdout, not the API url', () => {
  const json = JSON.stringify({
    status: 'ok',
    deployment: {
      url: 'https://review-digest-qlg0e12md-kenny-hes-projects.vercel.app',
      inspectorUrl: 'https://vercel.com/kenny-hes-projects/review-digest/x',
      deploymentApiUrl: 'https://api.vercel.com/v13/deployments/dpl_x',
    },
  });
  const run = (args) => (args[0] === 'whoami' ? 'ok' : json);
  const r = deploy({ siteDir: linkedDir(), token: 'tok', run });
  assert.equal(r.ok, true);
  assert.equal(r.url, 'https://review-digest-qlg0e12md-kenny-hes-projects.vercel.app');
});
