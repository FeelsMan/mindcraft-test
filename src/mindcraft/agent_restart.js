// Register the restart with the child owner BEFORE requesting a graceful exit.
// The parent's exit handler can then distinguish this from an automatic crash.
export function restartRegisteredAgent(name, connections, restart) {
    if (typeof name !== 'string' || !Object.hasOwn(connections, name)) return false;
    const agent = connections[name];
    console.log(`Restart requested for ${name}.`);
    return restart(name, () => {
        if (!agent.socket?.connected) return false;
        agent.socket.emit('restart-agent', name);
        return true;
    });
}

export function releaseAgentSocket(name, connections, socket) {
    if (!Object.hasOwn(connections, name) || connections[name].socket !== socket) return false;
    connections[name].in_game = false;
    connections[name].socket = null;
    return true;
}
