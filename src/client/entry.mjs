import { apply, inject, setClientReactRuntime } from './index.mjs';
import { setClientDockRuntime } from './native-workbench.mjs';
window.__ModuleLoader__.load({
  id: '@kingsoftcloud/agentkit-personal-assistant',
  factory: require => {
    setClientReactRuntime(require('react'));
    setClientDockRuntime(require('@deepseek-ai/dsh-client-ui-dockkit'));
    return { name: 'agentkit-personal-assistant', inject, apply };
  },
});
