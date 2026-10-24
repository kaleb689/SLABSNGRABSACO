"use strict";
const {contextBridge,ipcRenderer}=require("electron");
const allowed=[
"license:status","license:activate","vault:overview","jigs:permissions","vault:addCard","vault:addAddress",
"vault:setHardCard","vault:setHardCards","vault:promoteCard","vault:addAccount","vault:import","vault:bulkMove","vault:bulkDelete","vault:removeImportBatch","vault:export","vault:rows","vault:jig","vault:remove","vault:setBank","vault:editRow","vault:backupList","vault:backupRestore","vault:backupExport","vault:backupImport"
];
const api={};
for(const channel of allowed)api[channel.replace(/[:-]/g,"_")]=payload=>ipcRenderer.invoke(channel,payload);
api.onJigPermissions=callback=>{
  if(typeof callback!=="function")throw Error("Jig permission listener must be a function.");
  const listener=(_event,data)=>callback(data);
  ipcRenderer.on("jigs:permissions",listener);
  return ()=>ipcRenderer.removeListener("jigs:permissions",listener);
};
contextBridge.exposeInMainWorld("PrivateStudio",Object.freeze(api));
