// 同步窗口（RedNote / 抖音 网页）的 preload：页面脚本不能自己关掉窗口（window.close），否则同步会中断
const { contextBridge, webFrame } = require('electron');
const code = '(function(){try{var f=function(){try{console.warn("[favsync] 已阻止页面关闭窗口 window.close()");}catch(e){}};' +
  'Object.defineProperty(window,"close",{value:f,configurable:false,writable:false});}catch(e){}})();';
try {
  if (contextBridge && typeof contextBridge.executeInMainWorld === 'function') contextBridge.executeInMainWorld({ func: new Function(code) });
  else webFrame.executeJavaScript(code);
} catch (e) { try { webFrame.executeJavaScript(code); } catch (e2) {} }
