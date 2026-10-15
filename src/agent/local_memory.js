import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);
const kinds = new Set(['gather', 'craft', 'recover', 'goal_complete', 'goal_failed', 'death']);
const clean = (value, max = 400) => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max);
export const validPosition = p => p && [p.x, p.y, p.z].every(Number.isFinite) &&
    Math.abs(p.x) <= 30000000 && Math.abs(p.z) <= 30000000 && Math.abs(p.y) <= 4096;
export const positionOf = p => validPosition(p) ? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } : null;
export const cellOf = p => validPosition(p) ? [p.x, p.y, p.z].map(n => Math.floor(n / 8)).join(',') : 'unknown';
const decode = value => value ? JSON.parse(value) : null;

// This module has no model or Minecraft dependencies. All writes are bound SQL
// parameters. Callers supply observations, never assistant-generated summaries.
export class LocalMemoryStore {
    constructor(filename, { clock = Date.now, maxRecords = 5000 } = {}) {
        this.clock = clock;
        this.maxRecords = Math.max(10, Math.min(20000, maxRecords));
        this.writes = 0;
        if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
        const { DatabaseSync } = require('node:sqlite');
        this.db = new DatabaseSync(filename);
        try {
            this.db.exec('PRAGMA busy_timeout=100; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
            const version = this.db.prepare('PRAGMA user_version').get().user_version;
            if (version > 1) throw new Error('Memory database was created by a newer version; leaving it untouched.');
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS experiences (
                    id INTEGER PRIMARY KEY, world TEXT NOT NULL, dimension TEXT NOT NULL,
                    kind TEXT NOT NULL, item TEXT NOT NULL, text TEXT NOT NULL,
                    position TEXT, dedupe TEXT NOT NULL, first_seen INTEGER NOT NULL,
                    last_seen INTEGER NOT NULL, observations INTEGER NOT NULL DEFAULT 1,
                    UNIQUE(world, dimension, dedupe)
                );
                CREATE INDEX IF NOT EXISTS experiences_scope ON experiences(world, dimension, last_seen DESC);
                CREATE VIRTUAL TABLE IF NOT EXISTS experience_fts USING fts5(text, item, content='experiences', content_rowid='id');
                CREATE TRIGGER IF NOT EXISTS experience_insert AFTER INSERT ON experiences BEGIN
                    INSERT INTO experience_fts(rowid, text, item) VALUES(new.id, new.text, new.item);
                END;
                CREATE TRIGGER IF NOT EXISTS experience_delete AFTER DELETE ON experiences BEGIN
                    INSERT INTO experience_fts(experience_fts, rowid, text, item) VALUES('delete', old.id, old.text, old.item);
                END;
                CREATE TRIGGER IF NOT EXISTS experience_update AFTER UPDATE ON experiences BEGIN
                    INSERT INTO experience_fts(experience_fts, rowid, text, item) VALUES('delete', old.id, old.text, old.item);
                    INSERT INTO experience_fts(rowid, text, item) VALUES(new.id, new.text, new.item);
                END;
                CREATE TABLE IF NOT EXISTS vectors (
                    experience INTEGER NOT NULL REFERENCES experiences(id) ON DELETE CASCADE,
                    model TEXT NOT NULL, text TEXT NOT NULL, vector TEXT NOT NULL,
                    PRIMARY KEY(experience, model)
                );
                CREATE TABLE IF NOT EXISTS locations (
                    world TEXT NOT NULL, dimension TEXT NOT NULL, name TEXT NOT NULL,
                    kind TEXT NOT NULL, position TEXT NOT NULL, metadata TEXT NOT NULL,
                    updated INTEGER NOT NULL, PRIMARY KEY(world, dimension, name)
                );
                CREATE TABLE IF NOT EXISTS goals (
                    world TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS failures (
                    world TEXT NOT NULL, dimension TEXT NOT NULL, key TEXT NOT NULL,
                    fingerprint TEXT NOT NULL, reason TEXT NOT NULL, expires INTEGER NOT NULL,
                    PRIMARY KEY(world, dimension, key)
                );
                PRAGMA user_version=1;
            `);
        } catch (error) { this.db.close(); this.db = null; throw error; }
    }

    record(world, dimension, { kind, item, text, position = null, verified = false }) {
        if (!verified || !kinds.has(kind)) return null;
        const p = positionOf(position), now = this.clock();
        const key = `${kind}:${clean(item, 80)}:${cellOf(p)}`;
        this.db.prepare(`INSERT INTO experiences(world,dimension,kind,item,text,position,dedupe,first_seen,last_seen)
            VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(world,dimension,dedupe) DO UPDATE SET
            text=excluded.text,position=excluded.position,last_seen=excluded.last_seen,observations=observations+1`)
            .run(world, dimension, kind, clean(item, 80), clean(text), p ? JSON.stringify(p) : null, key, now, now);
        if (++this.writes % 25 === 0) this.prune();
        return this.db.prepare('SELECT id FROM experiences WHERE world=? AND dimension=? AND dedupe=?').get(world, dimension, key)?.id;
    }

    prune() {
        this.db.prepare('DELETE FROM experiences WHERE id NOT IN (SELECT id FROM experiences ORDER BY last_seen DESC,id DESC LIMIT ?)').run(this.maxRecords);
        this.db.prepare('DELETE FROM failures WHERE expires<=?').run(this.clock());
        // Resource areas are a small working map, rather than a log of every block.
        this.db.exec(`DELETE FROM locations WHERE kind='resource' AND rowid NOT IN
            (SELECT rowid FROM locations WHERE kind='resource' ORDER BY updated DESC LIMIT 500)`);
    }

    candidates(world, dimension, query, limit = 50) {
        const count = Math.max(1, Math.min(100, limit));
        const tokens = clean(query, 1000).toLowerCase().match(/[a-z0-9_]{2,40}/g)?.slice(0, 12) || [];
        let matches = [];
        if (tokens.length) {
            const expression = [...new Set(tokens)].map(t => `"${t}"`).join(' OR ');
            matches = this.db.prepare(`SELECT e.*,bm25(experience_fts) AS rank FROM experience_fts
                JOIN experiences e ON e.id=experience_fts.rowid
                WHERE experience_fts MATCH ? AND e.world=? AND e.dimension=?
                ORDER BY rank,e.last_seen DESC LIMIT ?`).all(expression, world, dimension, count);
        }
        const recent = this.db.prepare('SELECT * FROM experiences WHERE world=? AND dimension=? ORDER BY last_seen DESC,id DESC LIMIT ?').all(world, dimension, count);
        const result = new Map(matches.map(r => [r.id, { ...r, lexical: true }]));
        for (const row of recent) if (!result.has(row.id)) result.set(row.id, { ...row, lexical: false });
        return [...result.values()].slice(0, count);
    }

    getVector(id, model, text) {
        const row = this.db.prepare('SELECT vector FROM vectors WHERE experience=? AND model=? AND text=?').get(id, model, text);
        return row ? decode(row.vector) : null;
    }
    putVector(id, model, text, vector) {
        if (!Array.isArray(vector) || !vector.length || vector.length > 8192 || !vector.every(Number.isFinite)) return;
        this.db.prepare('INSERT INTO vectors(experience,model,text,vector) VALUES(?,?,?,?) ON CONFLICT(experience,model) DO UPDATE SET text=excluded.text,vector=excluded.vector')
            .run(id, model, text, JSON.stringify(vector));
    }

    putLocation(world, dimension, name, kind, position, metadata = {}) {
        const p = positionOf(position);
        if (!p) return false;
        this.db.prepare(`INSERT INTO locations(world,dimension,name,kind,position,metadata,updated) VALUES(?,?,?,?,?,?,?)
            ON CONFLICT(world,dimension,name) DO UPDATE SET kind=excluded.kind,position=excluded.position,metadata=excluded.metadata,updated=excluded.updated`)
            .run(world, dimension, clean(name, 80), kind, JSON.stringify(p), JSON.stringify(metadata), this.clock());
        return true;
    }
    getLocation(world, dimension, name) {
        const row = this.db.prepare('SELECT * FROM locations WHERE world=? AND dimension=? AND name=?').get(world, dimension, clean(name, 80));
        return row ? { ...row, position: decode(row.position), metadata: decode(row.metadata) } : null;
    }
    locations(world, dimension, kind = null) {
        return this.db.prepare('SELECT * FROM locations WHERE world=? AND dimension=? AND (? IS NULL OR kind=?) ORDER BY updated DESC LIMIT 100')
            .all(world, dimension, kind, kind).map(r => ({ ...r, position: decode(r.position), metadata: decode(r.metadata) }));
    }
    deleteLocation(world, dimension, name) {
        this.db.prepare('DELETE FROM locations WHERE world=? AND dimension=? AND name=?').run(world, dimension, name);
    }

    setGoal(world, goal) {
        this.db.prepare('INSERT INTO goals(world,data,updated) VALUES(?,?,?) ON CONFLICT(world) DO UPDATE SET data=excluded.data,updated=excluded.updated')
            .run(world, JSON.stringify(goal), this.clock());
    }
    getGoal(world) { return decode(this.db.prepare('SELECT data FROM goals WHERE world=?').get(world)?.data); }
    fail(world, dimension, key, fingerprint, reason, cooldownMs = 120000) {
        this.db.prepare(`INSERT INTO failures(world,dimension,key,fingerprint,reason,expires) VALUES(?,?,?,?,?,?)
            ON CONFLICT(world,dimension,key) DO UPDATE SET fingerprint=excluded.fingerprint,reason=excluded.reason,expires=excluded.expires`)
            .run(world, dimension, key, fingerprint, clean(reason), this.clock() + cooldownMs);
    }
    failure(world, dimension, key, fingerprint) {
        return this.db.prepare('SELECT * FROM failures WHERE world=? AND dimension=? AND key=? AND fingerprint=? AND expires>?')
            .get(world, dimension, key, fingerprint, this.clock()) || null;
    }
    clearFailure(world, dimension, key) { this.db.prepare('DELETE FROM failures WHERE world=? AND dimension=? AND key=?').run(world, dimension, key); }
    activeFailures(world, dimension) {
        return this.db.prepare('SELECT key,reason,expires FROM failures WHERE world=? AND dimension=? AND expires>? ORDER BY expires DESC LIMIT 10').all(world, dimension, this.clock());
    }
    stats(world, dimension) {
        return {
            experiences: this.db.prepare('SELECT COUNT(*) AS n FROM experiences WHERE world=? AND dimension=?').get(world, dimension).n,
            locations: this.locations(world, dimension), goal: this.getGoal(world)
        };
    }
    close() { if (this.db) { this.db.close(); this.db = null; } }
}
