"use strict";
const {contextBridge,ipcRenderer}=require("electron");
const allowed=[
"license:status","license:activate","vault:overview","vault:addCard","vault:addAddress",
"vault:addAccount","vault:import","vault:export","vault:rows","vault:jig","vault:remove"
];
const api={};
for(const channel of allowed)api[channel.replace(/[:-]/g,"_")]=payload=>ipcRenderer.invoke(channel,payload);
contextBridge.exposeInMainWorld("PrivateStudio",Object.freeze(api));
