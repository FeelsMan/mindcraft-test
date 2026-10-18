import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Vec3 from 'vec3';
import minecraftData from 'minecraft-data';
import prismarineBlock from 'prismarine-block';
import prismarineWorld from 'prismarine-world';
import pf from 'mineflayer-pathfinder';
import AStar from 'mineflayer-pathfinder/lib/astar.js';
import Move from 'mineflayer-pathfinder/lib/move.js';
import { ActionManager } from '../../src/agent/action_manager.js';

export function shelterWorld(version = '1.21.4', initial = {}) {
    const data = minecraftData(version), Block = prismarineBlock(version), World = prismarineWorld(version);
    assert(data, 'Install the pinned native data overlay before running the 26.3 regression.');
    const bot = new EventEmitter(), blocks = new Map(), stock = { ...initial }, calls = [], policies = [], controls = {};
    bot.registry = data; bot.entities = {};
    bot.entity = { position: new Vec3(2.5, 64, 2.5), height: 1.8, width: 0.6, effects: {}, onGround: true };
    bot.game = { dimension: 'overworld', minY: -64 }; bot.output = ''; bot.interrupt_code = false;
    bot.modes = { getActiveModes: () => [] };
    const make = (p, name, props) => {
        if (name === null) return null;
        let block = Block.fromStateId(data.blocksByName[name].defaultState ?? data.blocksByName[name].minStateId, 0);
        if (props) block = Block.fromProperties(name, { ...block.getProperties(), ...props }, 0);
        block.position = p.floored(); return block;
    };
    const set = (p, name, props) => blocks.set(p.floored().toString(), make(p, name, props));
    bot.blockAt = p => blocks.has(p.floored().toString()) ? blocks.get(p.floored().toString()) : make(p, p.y < 64 ? 'stone' : 'air');
    bot.world = new World().sync; bot.world.getBlock = bot.blockAt;
    bot.inventory = { items: () => Object.entries(stock).filter(([, count]) => count > 0)
        .map(([name, count]) => ({ name, count, type: data.itemsByName[name]?.id })) };
    bot.clearControlStates = () => {};
    bot.getControlState = name => Boolean(controls[name]);
    bot.setControlState = (name, value) => { controls[name] = value; };
    bot.equip = async item => { bot.heldItem = item; calls.push(['equip', item.name]); };
    bot.lookAt = async position => { bot.lastLook = position; };
    bot.placeBlock = async (support, face) => {
        const p = support.position.plus(face), name = bot.heldItem.name;
        assert.equal(bot.blockAt(p).name, 'air', 'A survival placement must target observed air.');
        assert(stock[name] > 0);
        if (name === 'oak_door') {
            assert.equal(bot.blockAt(p.offset(0, 1, 0)).name, 'air');
            const facing = bot.lastLook.z < bot.entity.position.z ? 'north' : 'south';
            set(p, name, { half: 'lower', open: false, facing, powered: false });
            set(p.offset(0, 1, 0), name, { half: 'upper', open: false, facing, powered: false });
        } else set(p, name);
        stock[name]--; calls.push(['place', name, p.clone()]);
        await bot.afterPlace?.(name, p);
    };
    bot.dig = async block => { calls.push(['dig', block.name, block.position]); set(block.position, 'air'); };
    bot.activateBlock = async block => {
        const open = !block.getProperties().open, p = block.position;
        for (const dy of [0, 1]) set(p.offset(0, dy, 0), 'oak_door', { ...bot.blockAt(p.offset(0, dy, 0)).getProperties(), open });
        calls.push(['door', open]);
    };
    let movement;
    const search = function* (moves, start, goal, options = {}) {
        const p = start.floored(), astar = new AStar(new Move(p.x, p.y, p.z, moves.countScaffoldingItems(), 0),
            moves, goal, options.timeout ?? 250, options.tickTimeout ?? 25);
        let result;
        do { result = astar.compute(); yield { result }; } while (result.status === 'partial');
    };
    bot.pathfinder = {
        getPathFromTo: search,
        getPathTo: (moves, goal, timeout) => {
            let result;
            for (const next of search(moves, bot.entity.position, goal, { timeout })) result = next.result;
            return result;
        },
        setMovements: value => { movement = value; policies.push(value); },
        setGoal(value) { this.goal = value; },
        async goto(goal) {
            const route = this.getPathTo(movement, goal, 300);
            assert.equal(route.status, 'success', 'Actual upstream pathfinder must prove the route.');
            for (const node of route.path) {
                assert.equal(node.toBreak.length + node.toPlace.length, 0, 'No mining/scaffolding during building travel.');
                bot.entity.position = new Vec3(node.x + 0.5, node.y, node.z + 0.5);
            }
            assert(goal.isEnd(bot.entity.position.floored()));
            calls.push(['move', bot.entity.position.clone()]);
        }
    };
    const travel = {
        movements: () => { const moves = new pf.Movements(bot); moves.allowEntityDetection = false; return moves; },
        log: message => calls.push(['log', message])
    };
    const recipes = name => (data.recipes[data.itemsByName[name]?.id] || []).map(r => {
        const ingredients = {};
        for (const id of r.ingredients || r.inShape?.flat() || []) {
            const item = data.items[id];
            if (item) ingredients[item.name] = (ingredients[item.name] || 0) + 1;
        }
        return [ingredients, { craftedCount: r.result.count }];
    });
    const agent = {
        name: 'Mia', bot, blocked_actions: [], memory_bank: {}, prompter: { profile: {} }, messages: [],
        history: { add: async () => {}, save: async () => {} },
        self_prompter: { stop: async () => { await agent.actions.stop(); }, isActive: () => false },
        requestInterrupt: () => { bot.interrupt_code = true; },
        clearBotLogs: () => { bot.interrupt_code = false; bot.output = ''; },
        cleanKill: message => assert.fail(message), isIdle: () => !agent.actions.executing,
        openChat: message => agent.messages.push(message)
    };
    agent.actions = new ActionManager(agent);
    const api = {
        recipes, navigation: () => travel, hasTable: () => true, verifyTimeoutMs: 10,
        collect: async (_bot, item, count) => {
            assert.equal(item, 'oak_log'); assert.equal(count, 1);
            stock[item] = (stock[item] || 0) + count; calls.push(['gather', item, count]);
        },
        craft: async (_bot, name) => {
            const [ingredients, output] = recipes(name).find(([items]) =>
                Object.keys(items).length && Object.keys(items).every(k => ['oak_log', 'oak_planks'].includes(k)));
            for (const [item, quantity] of Object.entries(ingredients)) { assert(stock[item] >= quantity); stock[item] -= quantity; }
            stock[name] = (stock[name] || 0) + output.craftedCount; calls.push(['craft', name, output.craftedCount]);
        }
    };
    const record = { version: 1, origin: { x: 0, y: 64, z: 0 } };
    return { bot, agent, stock, set, make, data, calls, api, travel, controls, blocks, policies, record };
}
