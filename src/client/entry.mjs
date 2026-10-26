import { apply, inject, setClientReactRuntime } from './index.mjs';
window.__ModuleLoader__.load({
  id: '@kingsoftcloud/agentkit-personal-assistant',
  factory: require => {
    setClientReactRuntime(require('react'));
    return { name: 'agentkit-personal-assistant', inject, apply };
  },
});
