/** 同一画面通道内交接控制权；租约确认前只缓冲输入，绝不假装接管成功。 */
export function createDesktopControl({ send, changed = () => {}, failed = () => {}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let available = false, epoch = 0, phase = 'observe', wanted = false, queue = [], text = '', textTimer;
  const notify = () => changed({ phase, readOnly: phase !== 'controlling', controlEpoch: epoch, available });
  const flushText = () => {
    clearTimer(textTimer); textTimer = undefined;
    const value = text; text = '';
    if (value && phase === 'controlling') send({ type: 'input', controlEpoch: epoch, event: { type: 'text', text: value } });
  };
  const transmit = event => {
    if (event.type === 'text') {
      if (text.length + event.text.length > 16384) flushText();
      text += event.text;
      if (!textTimer) textTimer = setTimer(flushText, 30);
    } else { flushText(); send({ type: 'input', controlEpoch: epoch, event }); }
  };
  const start = () => { phase = 'acquiring'; notify(); send({ type: 'control.acquire', controlEpoch: epoch }); };
  const buffer = event => {
    if (event.type === 'pointermove' && queue.at(-1)?.type === 'pointermove') queue[queue.length - 1] = event;
    else if (queue.length < 32) queue.push(event);
    else { api.release(); failed('接管期间输入过快，请重新点击云电脑'); return false; }
    return true;
  };
  const api = {
    get snapshot() { return { phase, readOnly: phase !== 'controlling', controlEpoch: epoch, available }; },
    reset(value = {}) {
      clearTimer(textTimer); textTimer = undefined; text = ''; queue = [];
      available = value.controlAvailable === true; epoch = Number.isSafeInteger(value.controlEpoch) ? value.controlEpoch : 0;
      phase = value.readOnly === false ? 'controlling' : 'observe'; wanted = phase === 'controlling'; notify();
    },
    input(event) {
      if (phase === 'controlling') { transmit(event); return true; }
      if (event.type === 'pointermove' && phase === 'observe') return false;
      if (!available) { if (event.type !== 'pointermove') failed('当前为只读旁观；云端更新后可点击画面接管'); return false; }
      wanted = true;
      if (!buffer(event)) return false;
      if (phase === 'observe') start();
      return true;
    },
    acquire() { if (!available) return false; wanted = true; if (phase === 'observe') start(); return true; },
    release() {
      wanted = false; queue = [];
      if (phase === 'controlling') { flushText(); phase = 'releasing'; notify(); send({ type: 'control.release', controlEpoch: epoch }); }
      // acquire 尚在路上时等待回执，收到后立刻释放，绝不重放已经取消的首击。
    },
    accept(value) {
      if (!Number.isSafeInteger(value.controlEpoch) || value.controlEpoch < epoch) return;
      epoch = value.controlEpoch; available = value.controlAvailable === true;
      if (value.readOnly) {
        if (phase !== 'releasing') { wanted = false; queue = []; }
        phase = 'observe'; notify();
        if (wanted && available) start();
        return;
      }
      if (!wanted) { queue = []; phase = 'releasing'; notify(); send({ type: 'control.release', controlEpoch: epoch }); return; }
      phase = 'controlling'; notify();
      const pending = queue; queue = []; for (const event of pending) transmit(event);
    },
    reject(value) {
      wanted = false; queue = []; clearTimer(textTimer); textTimer = undefined; text = '';
      if (Number.isSafeInteger(value.controlEpoch) && value.controlEpoch >= epoch) epoch = value.controlEpoch;
      phase = value.readOnly === false ? 'controlling' : 'observe'; notify(); failed(value.message || '控制权暂不可用，仍可继续旁观');
    },
    dispose() { api.release(); clearTimer(textTimer); textTimer = undefined; text = ''; queue = []; },
  };
  return api;
}
