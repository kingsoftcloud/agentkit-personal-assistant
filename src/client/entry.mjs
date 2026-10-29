import { apply, inject, setClientMarkdownRuntime, setClientReactRuntime } from './index.mjs';

window.__ModuleLoader__.load({
  id: '@kingsoftcloud/agentkit-personal-assistant',
  factory: require => {
    setClientReactRuntime(require('react'));
    // 宿主 DSH 的 ui-primitives 暴露原生 Markdown 渲染器（MarkdownText）；
    // 老宿主没有这个模块时传 undefined，对话视图自动退回自带极简渲染。
    let primitives;
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch {
      primitives = undefined;
    }
    setClientMarkdownRuntime(primitives);
    return { name: 'agentkit-personal-assistant', inject, apply };
  },
});
