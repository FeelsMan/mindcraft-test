import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import settings from './settings.js';


export class History {
    constructor(agent) {
        this.agent = agent;
        this.name = agent.name;
        this.memory_fp = `./bots/${this.name}/memory.json`;
        this.full_history_fp = undefined;

        mkdirSync(`./bots/${this.name}/histories`, { recursive: true });

        this.turns = [];

        // Natural language memory as a summary of recent messages + previous memory
        this.memory = '';
        this.evidence = [];

        // Maximum number of messages to keep in context before saving chunk to memory
        this.max_messages = settings.max_messages;

        // Number of messages to remove from current history and save into memory
        this.summary_chunk_size = 5; 
        // chunking reduces expensive calls to promptMemSaving and appendFullHistory
        // and improves the quality of the memory summary
    }

    getHistory() { // expects an Examples object
        return JSON.parse(JSON.stringify(this.turns));
    }

    async summarizeMemories(turns) {
        const reports = turns.filter(t => t.role === 'system' &&
            typeof t.content === 'string' &&
            !t.content.startsWith('You are self-prompting'));
        for (const report of reports) {
            this.evidence.push(report.content.slice(0, 600));
        }
        this.evidence = this.evidence.slice(-6);
        this.memory = this.evidence.length ?
            'Past system reports (historical; current stats and inventory take priority):\n' +
            this.evidence.join('\n') : '';
    }

    async appendFullHistory(to_store) {
        if (this.full_history_fp === undefined) {
            const string_timestamp = new Date().toLocaleString().replace(/[/:]/g, '-').replace(/ /g, '').replace(/,/g, '_');
            this.full_history_fp = `./bots/${this.name}/histories/${string_timestamp}.json`;
            writeFileSync(this.full_history_fp, '[]', 'utf8');
        }
        try {
            const data = readFileSync(this.full_history_fp, 'utf8');
            let full_history = JSON.parse(data);
            full_history.push(...to_store);
            writeFileSync(this.full_history_fp, JSON.stringify(full_history, null, 4), 'utf8');
        } catch (err) {
            console.error(`Error reading ${this.name}'s full history file: ${err.message}`);
        }
    }

    async add(name, content) {
        let role = 'assistant';
        if (name === 'system') {
            role = 'system';
        }
        else if (name !== this.name) {
            role = 'user';
            content = `${name}: ${content}`;
        }
        this.turns.push({role, content});

        if (this.turns.length >= this.max_messages) {
            let chunk = this.turns.splice(0, this.summary_chunk_size);
            while (this.turns.length > 0 && this.turns[0].role === 'assistant')
                chunk.push(this.turns.shift()); // remove until turns starts with system/user message

            await this.summarizeMemories(chunk);
            await this.appendFullHistory(chunk);
        }
    }

    async save() {
        try {
            const data = {
                memory: this.memory,
                evidence_version: 1,
                evidence: this.evidence,
                memory_scope: this.agent.local_memory?.persistentWorld ? {
                    world: this.agent.local_memory.world, dimension: this.agent.local_memory.dimension
                } : null,
                places: this.agent.memory_bank.getJson(),
                turns: this.turns,
                self_prompting_state: this.agent.self_prompter.state,
                self_prompt: this.agent.self_prompter.isStopped() ? null : this.agent.self_prompter.prompt,
                taskStart: this.agent.task.taskStartTime,
                last_sender: this.agent.last_sender
            };
            writeFileSync(this.memory_fp, JSON.stringify(data, null, 2));
            console.log('Saved memory to:', this.memory_fp);
        } catch (error) {
            console.error('Failed to save history:', error);
            throw error;
        }
    }

    load() {
        try {
            if (!existsSync(this.memory_fp)) {
                console.log('No memory file found.');
                return null;
            }
            const data = JSON.parse(readFileSync(this.memory_fp, 'utf8'));
            // Old generated summaries and turns may contain fabricated facts.
            const currentFormat = data.evidence_version === 1;
            this.evidence = currentFormat && Array.isArray(data.evidence) ?
                data.evidence.filter(x => typeof x === 'string').slice(-6) : [];
            this.memory = this.evidence.length ?
                'Past system reports (historical; current stats and inventory take priority):\n' +
                this.evidence.join('\n') : '';
            this.turns = currentFormat && Array.isArray(data.turns) ? data.turns : [];
            this.agent.memory_bank.loadJson(data.places || {});
            if (!currentFormat) console.log('Ignoring legacy generated summary and turns; goal retained.');
            console.log('Loaded memory:', this.memory);
            return data;
        } catch (error) {
            console.error('Failed to load history:', error);
            throw error;
        }
    }

    clear() {
        this.turns = [];
        this.memory = '';
        this.evidence = [];
    }
}
