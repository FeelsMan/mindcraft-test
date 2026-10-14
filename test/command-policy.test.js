import test from 'node:test';
import assert from 'node:assert/strict';
import { availabilityReason, recordUnavailableAttempt, resetUnavailableAttempts } from '../src/agent/command_policy.js';

test('disabled code generation is unavailable; enabling it changes availability', () => {
    assert.match(availabilityReason('!newAction'), /code generation is disabled/);
    assert.equal(availabilityReason('!newAction', { allowCoding: true }), null);
    assert.match(availabilityReason('!craftRecipe', { blocked: true }), /disabled/);
    assert.match(availabilityReason('!inventCommand', { exists: false }), /does not exist/);
});

test('changing arguments or alternating valid commands does not reset an unavailable retry', () => {
    const agent = {};
    assert.equal(recordUnavailableAttempt(agent, '!newAction').stop, false);
    // Valid commands intentionally do not mutate the unavailable-attempt record.
    assert.equal(availabilityReason('!moveAway'), null);
    assert.equal(recordUnavailableAttempt(agent, '!newAction').stop, true);
    assert.equal(agent.command_failure_epoch, 1);
});

test('different hallucinated command names also have a bounded retry budget', () => {
    const agent = {};
    assert.equal(recordUnavailableAttempt(agent, '!fakeA').stop, false);
    assert.equal(recordUnavailableAttempt(agent, '!fakeB').stop, false);
    assert.equal(recordUnavailableAttempt(agent, '!fakeC').stop, true);
});

test('a new human instruction gets a fresh budget', () => {
    const agent = {};
    recordUnavailableAttempt(agent, '!newAction');
    recordUnavailableAttempt(agent, '!newAction');
    resetUnavailableAttempts(agent);
    assert.equal(recordUnavailableAttempt(agent, '!newAction').stop, false);
});
