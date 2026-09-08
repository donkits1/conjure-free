let handler = null;
export function onExitRequest(fn) { handler = fn; }
export function requestExit(code, why) { if (!handler)
    return false; handler(code, why); return true; }
//# sourceMappingURL=lifecycle.js.map