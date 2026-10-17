import { supportedItems } from '../make_goal.js';
import { gatherCommandAllowed, countItem } from '../gather_goal.js';
import { smeltingRecipes } from '../smelting_plan.js';
import { getBlockId, getItemId, getItemCraftingRecipes } from "../../utils/mcdata.js";
import { actionsList } from './actions.js';
import { queryList } from './queries.js';
import settings from '../settings.js';
import { availabilityReason } from '../command_policy.js';

let suppressNoDomainWarning = true;

const commandList = queryList.concat(actionsList);
const commandMap = {};
const disabledCommands = new Set();
for (let command of commandList) {
    commandMap[command.name] = command;
}

export function getCommand(name) {
    return commandMap[name];
}

export function blacklistCommands(commands) {
    const unblockable = ['!stop', '!endGoal', '!stats', '!inventory', '!goal'];
    for (let command_name of commands) {
        if (unblockable.includes(command_name)){
            console.warn(`Command ${command_name} is unblockable`);
            continue;
        }
        disabledCommands.add(command_name);
    }
}

const commandRegex = /!(\w+)(?:\(((?:-?\d+(?:\.\d+)?|true|false|"[^"]*")(?:\s*,\s*(?:-?\d+(?:\.\d+)?|true|false|"[^"]*"))*)\))?/
const argRegex = /-?\d+(?:\.\d+)?|true|false|"[^"]*"/g;

export function containsCommand(message) {
    const commandMatch = message.match(commandRegex);
    if (commandMatch)
        return "!" + commandMatch[1];
    return null;
}

export function commandExists(commandName) {
    if (!commandName.startsWith("!"))
        commandName = "!" + commandName;
    return commandMap[commandName] !== undefined;
}

export function commandUnavailableReason(agent, name) {
    return availabilityReason(name, {
        exists: Boolean(commandMap[name]),
        blocked: disabledCommands.has(name) || (agent.blocked_actions || []).includes(name),
        allowCoding: Boolean(settings.allow_insecure_coding)
    });
}

/**
 * Converts a string into a boolean.
 * @param {string} input
 * @returns {boolean | null} the boolean or `null` if it could not be parsed.
 * */
function parseBoolean(input) {
    switch(input.toLowerCase()) {
        case 'false': //These are interpreted as flase;
        case 'f':
        case '0':
        case 'off':
            return false;
        case 'true': //These are interpreted as true;
        case 't':
        case '1':
        case 'on':
            return true;
        default:
            return null;
    }
}

/**
 * @param {number} value - the value to check
 * @param {number} lowerBound
 * @param {number} upperBound
 * @param {string} endpointType - The type of the endpoints represented as a two character string. `'[)'` `'()'` 
 */
function checkInInterval(number, lowerBound, upperBound, endpointType) {
    switch (endpointType) {
        case '[)':
            return lowerBound <= number && number < upperBound;
        case '()':
            return lowerBound < number && number < upperBound;
        case '(]':
            return lowerBound < number && number <= upperBound;
        case '[]':
            return lowerBound <= number && number <= upperBound;
        default:
            throw new Error('Unknown endpoint type:', endpointType)
    }
}



// todo: handle arrays?
/**
 * Returns an object containing the command, the command name, and the comand parameters.
 * If parsing unsuccessful, returns an error message as a string.
 * @param {string} message - A message from a player or language model containing a command.
 * @returns {string | Object}
 */
export function parseCommandMessage(message) {
    const commandMatch = message.match(commandRegex);
    if (!commandMatch) return `Command is incorrectly formatted`;

    const commandName = "!"+commandMatch[1];

    let args;
    if (commandMatch[2]) args = commandMatch[2].match(argRegex);
    else args = [];

    const command = getCommand(commandName);
    if(!command) return `${commandName} is not a command.`

    const params = commandParams(command);
    const paramNames = commandParamNames(command);
    
    if (args.length !== params.length)
        return `Command ${command.name} was given ${args.length} args, but requires ${params.length} args.`;

    
    for (let i = 0; i < args.length; i++) {
        const param = params[i];
        //Remove any extra characters
        let arg = args[i].trim();
        if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
            arg = arg.substring(1, arg.length-1);
        }
        
        //Convert to the correct type
        switch(param.type) {
            case 'int':
                arg = Number.parseInt(arg); break;
            case 'float':
                arg = Number.parseFloat(arg); break;
            case 'boolean':
                arg = parseBoolean(arg); break;
            case 'BlockName':
            case 'BlockOrItemName':
            case 'ItemName':
                if (arg.endsWith('plank') || arg.endsWith('seed'))
                    arg += 's'; // add 's' to for common mistakes like "oak_plank" or "wheat_seed"
            case 'string':
                break;
            default:
                throw new Error(`Command '${commandName}' parameter '${paramNames[i]}' has an unknown type: ${param.type}`);
        }
        if(arg === null || Number.isNaN(arg))
            return `Error: Param '${paramNames[i]}' must be of type ${param.type}.`

        if(typeof arg === 'number') { //Check the domain of numbers
            const domain = param.domain;
            if(domain) {
                /**
                 * Javascript has a built in object for sets but not intervals.
                 * Currently the interval (lowerbound,upperbound] is represented as an Array: `[lowerbound, upperbound, '(]']`
                 */
                if (!domain[2]) domain[2] = '[)'; //By default, lower bound is included. Upper is not.

                if(!checkInInterval(arg, ...domain)) {
                    return `Error: Param '${paramNames[i]}' must be an element of ${domain[2][0]}${domain[0]}, ${domain[1]}${domain[2][1]}.`;
                    //Alternatively arg could be set to the nearest value in the domain.
                }
            } else if (!suppressNoDomainWarning) {
                console.warn(`Command '${commandName}' parameter '${paramNames[i]}' has no domain set. Expect any value [-Infinity, Infinity].`)
                suppressNoDomainWarning = true; //Don't spam console. Only give the warning once.
            }
        } else if(param.type === 'BlockName') { //Check that there is a block with this name
            if(getBlockId(arg) == null) return  `Invalid block type: ${arg}.`
        } else if(param.type === 'ItemName') { //Check that there is an item with this name
            if(getItemId(arg) == null) return `Invalid item type: ${arg}.`
        } else if(param.type === 'BlockOrItemName') {
            if(getBlockId(arg) == null && getItemId(arg) == null) return  `Invalid block or item type: ${arg}.`
        }
        args[i] = arg;
    }
    
    return { commandName, args };
}

export function truncCommandMessage(message) {
    const commandMatch = message.match(commandRegex);
    if (commandMatch) {
        return message.substring(0, commandMatch.index + commandMatch[0].length);
    }
    return message;
}

export function isAction(name) {
    return actionsList.find(action => action.name === name) !== undefined;
}

/**
 * @param {Object} command
 * @returns {Object[]} The command's parameters.
 */
function commandParams(command) {
    if (!command.params)
        return [];
    return Object.values(command.params);
}

/**
 * @param {Object} command
 * @returns {string[]} The names of the command's parameters.
 */
function commandParamNames(command) {
    if (!command.params)
        return [];
    return Object.keys(command.params);
}

function numParams(command) {
    return commandParams(command).length;
}

export async function executeCommand(agent, message, requestContext = null) {
    const name = containsCommand(message);
    if (name) {
        const unavailable = commandUnavailableReason(agent, name);
        if (unavailable) return unavailable;
    }
    let parsed = parseCommandMessage(message);
    if (typeof parsed === 'string')
        return parsed; //The command was incorrectly formatted or an invalid input was given.
    else {
        if (!gatherCommandAllowed(agent, parsed.commandName))
            return 'A managed goal is active. Other action commands are blocked. Use !endGoal to cancel it first.';
        console.log('parsed command:', parsed);
        const command = getCommand(parsed.commandName);
        let numArgs = 0;
        if (parsed.args) {
            numArgs = parsed.args.length;
        }
        if (numArgs !== numParams(command))
            return `Command ${command.name} was given ${numArgs} args, but requires ${numParams(command)} args.`;
        else {
            // Old examples still select smeltItem. Route supported inputs before
            // taking an action slot: starting a goal inside runAsAction would
            // wait for that same action to stop. Preserve its ADDITIONAL count.
            if (parsed.commandName === '!smeltItem') {
                const output = Object.keys(smeltingRecipes).find(item => smeltingRecipes[item] === parsed.args[0]);
                if (output) {
                    const unavailable = commandUnavailableReason(agent, '!makeGoal');
                    if (unavailable) return unavailable;
                    const count = parsed.args[1];
                    const target = countItem(agent.bot, output) + count;
                    if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(target) || target > 64)
                        return 'Managed smelting supports at most 64 total output items. Use !makeGoal with a total target from 1 to 64.';
                    console.log(`Managed smelting: ${count} additional ${output}; inventory target ${target}.`);
                    return commandMap['!makeGoal'].perform(agent, output, target, requestContext);
                }
            }
            // Keep legacy recipe BATCH semantics, but let the same managed
            // controller reserve prerequisites and verify the output. Start it
            // before runAsAction so startup cannot wait on its own action slot.
            if (parsed.commandName === '!craftRecipe') {
                const [item, batches] = parsed.args;
                const craftable = supportedItems.has(item) &&
                    !smeltingRecipes[item] && !['cobblestone', 'raw_iron'].includes(item);
                if (craftable) {
                    const unavailable = commandUnavailableReason(agent, '!makeGoal');
                    if (unavailable) return unavailable;
                    const recipes = getItemCraftingRecipes(item) || [];
                    const recipe = recipes.find(([, result]) =>
                        Number.isSafeInteger(result?.craftedCount) && result.craftedCount > 0);
                    if (!recipe) return 'Cannot determine the recipe output for ' + item + '. No crafting started.';
                    const outputPerBatch = recipe[1].craftedCount;
                    const target = countItem(agent.bot, item) + batches * outputPerBatch;
                    if (!Number.isSafeInteger(batches) || batches < 1 ||
                        !Number.isSafeInteger(target) || target > 64)
                        return 'Managed crafting supports at most 64 total output items. Use !makeGoal with a TOTAL target from 1 to 64.';
                    console.log('Managed crafting: ' + batches + ' recipe batch(es), ' +
                        outputPerBatch + ' ' + item + ' per batch; total inventory target ' + target + '.');
                    return commandMap['!makeGoal'].perform(agent, item, target, requestContext);
                }
            }
            const args = [...parsed.args];
            if (parsed.commandName === '!makeGoal' || parsed.commandName === '!resumeGoal')
                args.push(requestContext);
            const result = await command.perform(agent, ...args);
            return result;
        }
    }
}

export function getCommandDocs(agent) {
    const typeTranslations = {
        //This was added to keep the prompt the same as before type checks were implemented.
        //If the language model is giving invalid inputs changing this might help.
        'float':             'number',
        'int':               'number',
        'BlockName':         'string',
        'ItemName':          'string',
        'BlockOrItemName':   'string',
        'boolean':           'bool'
    }
    let docs = `\n*COMMAND DOCS\n You can use the following commands to perform actions and get information about the world. 
    Use the commands with the syntax: !commandName or !commandName("arg1", 1.2, ...) if the command takes arguments.\n
    Do not use codeblocks. Use double quotes for strings. Only use one command in each response, trailing commands and comments will be ignored.\n`;
    for (let command of commandList) {
        if (commandUnavailableReason(agent, command.name)) {
            continue;
        }
        docs += command.name + ': ' + command.description + '\n';
        if (command.params) {
            docs += 'Params:\n';
            for (let param in command.params) {
                docs += `${param}: (${typeTranslations[command.params[param].type]??command.params[param].type}) ${command.params[param].description}\n`;
            }
        }
    }
    return docs + '*\n';
}
