import settings from '../settings.js';
import prismarineViewer from 'prismarine-viewer';
const mineflayerViewer = prismarineViewer.mineflayer;

export function addBrowserViewer(bot, count_id) {
    if (bot.protocolVersion >= 777) {
        if (settings.render_bot_view) console.warn('[Native 26.3] Browser viewer assets are not included in this update. Use Minecraft spectator view.');
        return;
    }
    if (settings.render_bot_view)
        mineflayerViewer(bot, { port: 3000+count_id, firstPerson: true, viewDistance: 3 });
}