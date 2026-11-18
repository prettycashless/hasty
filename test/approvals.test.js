import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ApprovalManager,
  catastrophicReason,
  dangerousCommandReason,
} from '../src/approvals.js';

function fakeRenderer() {
  return {
    error() {},
    warn() {},
    line() {},
    approvalHeader() {},
    approvalLine() {},
    approvalFooter() {},
  };
}

test('catastrophic commands are blocked in every mode', () => {
  assert.match(catastrophicReason('rm -rf /'), /recursive deletion/i);
  assert.match(catastrophicReason('mkfs.ext4 /dev/sda1'), /formatting/i);
  assert.match(catastrophicReason('shutdown -h now'), /shutting down/i);
  assert.match(catastrophicReason('format C:'), /formatting a drive/i);
  assert.equal(catastrophicReason('rm -rf ./dist'), null);
  assert.equal(catastrophicReason('npm test'), null);
});

test('dangerous but legitimate commands are flagged', () => {
  assert.match(dangerousCommandReason('git reset --hard'), /discards/i);
  assert.match(dangerousCommandReason('rm -rf build'), /recursive force delete/i);
  assert.match(dangerousCommandReason('npm install -g typescript'), /global package/i);
  assert.equal(dangerousCommandReason('npm test'), null);
});

test('non-interactive ask mode fails closed', async () => {
  const approvals = new ApprovalManager({
    config: { approvalMode: 'ask' },
    renderer: fakeRenderer(),
    interactive: false,
  });
  const decision = await approvals.request({ category: 'write', tool: 'write_file' });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /non-interactively/);
});

test('auto mode allows workspace writes but asks for risky categories', async () => {
  const approvals = new ApprovalManager({
    config: { approvalMode: 'auto' },
    renderer: fakeRenderer(),
    interactive: false,
  });

  assert.equal((await approvals.request({ category: 'write', tool: 'write_file' })).allowed, true);
  assert.equal((await approvals.request({ category: 'write', tool: 'write_file', outside: true })).allowed, false);
  assert.equal((await approvals.request({ category: 'shell', tool: 'run_command' })).allowed, true);
  assert.equal((await approvals.request({ category: 'shell', tool: 'run_command', danger: true })).allowed, false);
  assert.equal((await approvals.request({ category: 'network', tool: 'web_fetch' })).allowed, false);
  assert.equal((await approvals.request({ category: 'execute', tool: 'create_plugin', danger: true })).allowed, false);
});

test('yolo mode allows almost everything but still respects hard blocks', async () => {
  const approvals = new ApprovalManager({
    config: { approvalMode: 'yolo' },
    renderer: fakeRenderer(),
    interactive: false,
  });
  assert.equal((await approvals.request({ category: 'network', tool: 'web_fetch' })).allowed, true);
  assert.equal((await approvals.request({
    category: 'shell',
    tool: 'run_command',
    danger: true,
  })).allowed, true);
  const blocked = await approvals.request({
    category: 'shell',
    tool: 'run_command',
    blocked: 'Blocked: this command looks like formatting a drive.',
  });
  assert.equal(blocked.allowed, false);
});

test('interactive "always" answers are cached for the session', async () => {
  let asked = 0;
  const prompter = {
    async ask() {
      asked += 1;
      return 'a';
    },
  };
  const approvals = new ApprovalManager({
    config: { approvalMode: 'ask' },
    renderer: fakeRenderer(),
    prompter,
    interactive: true,
  });

  const first = await approvals.request({ category: 'write', tool: 'write_file', alwaysKey: 'write' });
  assert.equal(first.allowed, true);
  assert.equal(first.always, true);
  const second = await approvals.request({ category: 'write', tool: 'write_file', alwaysKey: 'write' });
  assert.equal(second.allowed, true);
  assert.equal(asked, 1);
});

test('interactive denial is reported', async () => {
  const approvals = new ApprovalManager({
    config: { approvalMode: 'ask' },
    renderer: fakeRenderer(),
    prompter: { async ask() { return 'n'; } },
    interactive: true,
  });
  const decision = await approvals.request({ category: 'shell', tool: 'run_command' });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /denied/i);
});
