import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

mock.module(new URL('../src/models/_model_map.js', import.meta.url).href, {
    namedExports: { selectAPI() {}, createModel() {} }
});
const { Prompter } = await import('../src/models/prompter.js');
const { setSettings } = await import('../src/agent/settings.js');

test('actual conversation prompt receives bounded memory and human/bot tool guidance', async () => {
    setSettings({ allow_insecure_coding: false });
    let query, received;
    const fake = {
        profile: { conversing: 'Mia operating instructions' }, convo_examples: null,
        checkCooldown: async () => {}, replaceStrings: async p => p, _saveLog: async () => {},
        chat_model: { sendRequest: async (_messages, prompt) => { received = prompt; return 'Hello'; } },
        agent: { name: 'Mia', bot: {}, self_prompter: { isStopped: () => true },
            local_memory: { context: async q => { query = q; return '\nLOCAL MEMORY: verified table near 2,64,3'; } } }
    };
    const result = await Prompter.prototype.promptConvo.call(fake, [
        { role: 'assistant', content: 'I own a diamond palace' },
        { role: 'user', content: 'CaptainNeyo: make a stone axe' }
    ]);
    assert.equal(result, 'Hello');
    assert.equal(query, 'CaptainNeyo: make a stone axe');
    assert.match(received, /LOCAL MEMORY: verified table/);
    assert.match(received, /!startConversation is only for other bots/);
    assert.match(received, /Live inventory and tool results override/);
});
