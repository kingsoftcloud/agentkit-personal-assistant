/**
 * 个人助理面板的样式表与图标（对齐 designs 重新设计 DEMO 与设计规范）。
 *
 * 所有视图只用这里的类名（前缀 pa-），不再写散落的 inline style；
 * 颜色/字体/圆角优先取 DSH 主题变量（--dsw-*），回退值取 ui-theme 浅色实际色值。
 * 样式通过 <style> 节点随外壳一起挂载（themeStyle），同一页面重复挂载无副作用。
 */

export const THEME_STYLE_ID = 'pa-theme';

const tokens = `
.pa{
  --pa-font:var(--dsw-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif);
  --pa-mono:var(--ds-font-family-code, 'SF Mono', 'JetBrains Mono', 'Fira Code', Consolas, 'Liberation Mono', Menlo, Courier, 'PingFang SC', 'Microsoft YaHei');
  --pa-bg:var(--dsw-alias-bg-base, #fff);
  --pa-bg-sunken:var(--dsw-static-neutral-bluish-50, rgb(249,250,251));
  --pa-bg-pop:var(--dsw-alias-bg-layer-1, #fff);
  --pa-fill-1:var(--dsw-static-neutral-bluish-75, rgb(241,243,245));
  --pa-fill-2:var(--dsw-static-neutral-bluish-150, rgb(233,236,242));
  --pa-ink:var(--dsw-alias-label-primary, rgb(15,17,21));
  --pa-ink-2:var(--dsw-alias-label-secondary, rgb(97,102,107));
  --pa-ink-3:var(--dsw-alias-label-tertiary, rgb(129,133,140));
  --pa-ink-4:var(--dsw-alias-label-caption, rgb(173,178,184));
  --pa-on-ink:var(--dsw-alias-label-primary-foreground, #fff);
  --pa-ink-hover:var(--dsw-alias-button-primary-hover, rgb(67,69,74));
  --pa-line:var(--dsw-alias-border-l2, rgba(0,0,0,.1));
  --pa-line-soft:var(--dsw-alias-border-l1, rgba(0,0,0,.06));
  --pa-line-strong:var(--dsw-alias-border-l4, rgba(0,0,0,.16));
  --pa-hover:var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.06));
  --pa-pressed:var(--dsw-alias-interactive-bg-active, rgba(38,49,72,.1));
  --pa-accent:var(--dsw-alias-link, rgb(65,118,230));
  --pa-accent-soft:var(--dsw-alias-state-business-tertiary, rgb(237,243,254));
  --pa-ok:#0a7d4f;--pa-ok-dot:rgb(34,197,94);--pa-ok-soft:rgba(34,197,94,.12);
  --pa-warn:#9a5b00;--pa-warn-dot:#f59e0b;--pa-warn-soft:rgba(245,158,11,.14);
  --pa-danger:rgb(220,28,28);--pa-danger-soft:rgba(236,19,19,.06);--pa-danger-line:rgba(236,19,19,.3);
  --pa-shadow-pop:0 12px 32px rgba(15,17,21,.12),0 2px 6px rgba(15,17,21,.06);
  --pa-mask:var(--dsw-alias-bg-mask-1, rgba(0,0,0,.24));
  --pa-r-sm:var(--dsw-radius-sm, 8px);--pa-r-md:var(--dsw-radius-md, 12px);--pa-r-lg:var(--dsw-radius-lg, 16px);--pa-r-xl:var(--dsw-radius-xl, 20px);
  --pa-ease:cubic-bezier(.4,0,.2,1);
}
:root[data-theme='dark'] .pa,[data-theme='dark'] .pa,.dark .pa{
  --pa-bg-sunken:var(--dsw-static-neutral-bluish-900, rgb(27,27,28));
  --pa-fill-1:var(--dsw-static-neutral-bluish-850, rgb(44,44,46));
  --pa-fill-2:var(--dsw-static-neutral-bluish-800, rgb(53,54,56));
  --pa-ink-4:var(--dsw-static-neutral-bluish-700, rgb(97,102,107));
  --pa-line:rgba(255,255,255,.12);--pa-line-soft:rgba(255,255,255,.07);--pa-line-strong:rgba(255,255,255,.2);
  --pa-hover:rgba(255,255,255,.06);--pa-pressed:rgba(255,255,255,.1);
  --pa-accent:rgb(122,170,255);--pa-accent-soft:rgba(86,134,254,.16);
  --pa-ok:#4ade80;--pa-ok-soft:rgba(34,197,94,.16);--pa-warn:#fbbf24;--pa-warn-soft:rgba(245,158,11,.16);
  --pa-danger:#f87171;--pa-danger-soft:rgba(248,113,113,.1);--pa-danger-line:rgba(248,113,113,.4);
  --pa-shadow-pop:0 12px 32px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.08);
}`;

const base = `
.pa,.pa *,.pa *::before,.pa *::after{box-sizing:border-box}
.pa{position:relative;flex:1 1 0px;min-width:0;min-height:0;height:100%;display:flex;flex-direction:column;container-type:inline-size;background:var(--pa-bg);color:var(--pa-ink);font-family:var(--pa-font);font-size:14px;line-height:22px;-webkit-font-smoothing:antialiased}
:where(.pa button,.pa input,.pa textarea,.pa select){font:inherit;color:inherit}
:where(.pa button){cursor:pointer;background:none;border:0;padding:0;text-align:left}
:where(.pa button:disabled){cursor:not-allowed}
:where(.pa h1,.pa h2,.pa h3,.pa p,.pa ul){margin:0;padding:0}
:where(.pa ul){list-style:none}
:where(.pa svg){flex:none;display:block}
.pa :focus-visible{outline:2px solid var(--pa-accent);outline-offset:2px}
@keyframes pa-pulse{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes pa-spin{to{transform:rotate(360deg)}}
@keyframes pa-pop{from{opacity:0;transform:translateY(-4px)}}
@keyframes pa-fade{from{opacity:0}}
@keyframes pa-toast{from{opacity:0;transform:translate(-50%,-8px)}}
@keyframes pa-shimmer{to{background-position:-200% 0}}
@keyframes pa-skeleton{0%,100%{opacity:1}50%{opacity:.45}}
@keyframes pa-awaiting{0%,100%{opacity:.35}50%{opacity:1}}
.pa-spin{animation:pa-spin 1s linear infinite}
.pa-head{flex:none;height:52px;display:flex;align-items:center;gap:12px;padding:0 16px;border-bottom:1px solid var(--pa-line-soft)}
.pa-title{font-size:16px;line-height:24px;font-weight:500;white-space:nowrap}
.pa-tabs{display:flex;align-items:center;gap:2px}
.pa-tab{height:32px;padding:0 12px;border-radius:var(--pa-r-sm);font-size:14px;line-height:22px;font-weight:500;color:var(--pa-ink-3);white-space:nowrap;transition:background .15s var(--pa-ease),color .15s var(--pa-ease)}
.pa-tab:hover{background:var(--pa-hover);color:var(--pa-ink)}
.pa-tab[aria-selected='true']{background:var(--pa-fill-1);color:var(--pa-ink)}
.pa-head-actions{margin-left:auto;display:flex;align-items:center;gap:8px;min-width:0}
.pa-head-sep{width:1px;height:16px;background:var(--pa-line);margin:0 4px}
.pa-body{flex:1 1 0px;min-height:0;min-width:0;display:flex;flex-direction:column;position:relative}
.pa-body[data-dim='true']{opacity:.32;pointer-events:none}
.pa-scrim{position:absolute;inset:0;z-index:20;border:0;background:transparent;cursor:default}
.pa-anchor{position:relative;display:inline-flex}
.pa-anchor.block{display:block}
.pa-grow{flex:1 1 0px;min-width:0}
.pa-ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pa-mono{font-family:var(--pa-mono);font-size:13px}
.pa-sub{font-size:13px;line-height:20px;color:var(--pa-ink-2)}
.pa-cap{font-size:12px;line-height:18px;color:var(--pa-ink-3)}
.pa-strong{font-weight:500}
.pa-num{font-variant-numeric:tabular-nums}
.pa-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 14px;border-radius:16px;font-size:13px;line-height:20px;font-weight:500;white-space:nowrap;transition:background .15s var(--pa-ease),opacity .15s}
.pa-btn-primary{background:var(--pa-ink);color:var(--pa-on-ink)}
.pa-btn-primary:hover:not(:disabled){background:var(--pa-ink-hover)}
.pa-btn-secondary{box-shadow:inset 0 0 0 1px var(--pa-line-strong);color:var(--pa-ink)}
.pa-btn-secondary:hover:not(:disabled),.pa-btn-secondary[aria-pressed='true']{background:var(--pa-hover)}
.pa-btn-ghost{color:var(--pa-ink-2)}
.pa-btn-ghost:hover:not(:disabled){background:var(--pa-hover);color:var(--pa-ink)}
.pa-btn-danger{box-shadow:inset 0 0 0 1px var(--pa-danger-line);color:var(--pa-danger)}
.pa-btn-danger:hover:not(:disabled){background:var(--pa-danger-soft)}
.pa-btn-danger-fill{background:var(--pa-danger);color:#fff}
.pa-btn-sm{height:28px;padding:0 12px;border-radius:14px;font-size:12px;line-height:18px}
.pa-btn-lg{height:40px;padding:0 20px;border-radius:20px;font-size:14px;line-height:22px}
.pa-btn:disabled{opacity:.4}
.pa-icon-btn{flex:none;width:32px;height:32px;display:grid;place-items:center;border-radius:var(--pa-r-sm);color:var(--pa-ink-2);transition:background .15s var(--pa-ease)}
.pa-icon-btn:hover:not(:disabled),.pa-icon-btn[aria-pressed='true']{background:var(--pa-hover);color:var(--pa-ink)}
.pa-icon-btn.sm{width:28px;height:28px}
.pa-icon-btn.xs{width:20px;height:20px}
.pa-icon-btn:disabled{opacity:.4}
.pa-link{display:inline-flex;align-items:center;gap:4px;color:var(--pa-ink-2);font-size:13px;line-height:20px;border-radius:4px;white-space:nowrap}
.pa-link:hover:not(:disabled){color:var(--pa-ink)}
.pa-link.accent{color:var(--pa-accent)}
.pa-link.danger{color:var(--pa-danger)}
.pa-link.underline{text-decoration:underline;font-size:12px}
.pa-link:disabled{opacity:.4}
.pa-tag{flex:none;display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:10px;font-size:12px;line-height:18px;font-weight:400;white-space:nowrap;background:var(--pa-fill-1);color:var(--pa-ink-2)}
.pa-tag.ok{background:var(--pa-ok-soft);color:var(--pa-ok)}
.pa-tag.warn{background:var(--pa-warn-soft);color:var(--pa-warn)}
.pa-tag.danger{background:var(--pa-danger-soft);color:var(--pa-danger)}
.pa-tag.accent{background:var(--pa-accent-soft);color:var(--pa-accent)}
.pa-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--pa-ink-4)}
.pa-dot.ok{background:var(--pa-ok-dot)}
.pa-dot.warn{background:var(--pa-warn-dot);box-shadow:0 0 0 3px var(--pa-warn-soft)}
.pa-dot.accent{background:var(--pa-accent)}
.pa-dot.pulse{animation:pa-pulse 1.6s ease-in-out infinite}
.pa-chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:14px;font-size:12px;line-height:18px;color:var(--pa-ink-2);white-space:nowrap}
.pa-chip:hover:not(:disabled),.pa-chip[aria-expanded='true']{background:var(--pa-hover);color:var(--pa-ink)}
.pa-avatar{flex:none;display:grid;place-items:center;border-radius:30%;background:var(--pa-ink);color:var(--pa-on-ink);font-weight:500;width:36px;height:36px;font-size:15px}
.pa-avatar.soft{background:var(--pa-accent-soft);color:var(--pa-accent)}
.pa-avatar.s16{width:18px;height:18px;font-size:10px;border-radius:5px}
.pa-avatar.s24{width:24px;height:24px;font-size:12px}
.pa-avatar.s48{width:48px;height:48px;font-size:20px}
.pa-input,.pa-textarea{width:100%;border:0;border-radius:var(--pa-r-sm);background:var(--pa-bg);box-shadow:inset 0 0 0 1px var(--pa-line-strong);padding:0 12px;height:36px;font-size:14px;line-height:22px;outline:none;transition:box-shadow .15s var(--pa-ease)}
.pa-input::placeholder,.pa-textarea::placeholder{color:var(--pa-ink-4)}
.pa-input:focus,.pa-textarea:focus{box-shadow:inset 0 0 0 1.5px var(--pa-ink);outline:none}
.pa-input:disabled,.pa-textarea:disabled{opacity:.6}
.pa-input.sm{height:32px}
.pa-textarea{height:auto;padding:10px 12px;resize:vertical;min-height:96px;display:block}
.pa-select{display:flex;align-items:center;height:40px;text-align:left;cursor:pointer}
.pa-switch{flex:none;width:36px;height:20px;border-radius:10px;background:var(--pa-ink-4);position:relative;transition:background .15s var(--pa-ease)}
.pa-switch::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s var(--pa-ease)}
.pa-switch[aria-checked='true']{background:var(--pa-ok-dot)}
.pa-switch[aria-checked='true']::after{transform:translateX(16px)}
.pa-switch:disabled{opacity:.5}
.pa-check{flex:none;width:16px;height:16px;border-radius:5px;box-shadow:inset 0 0 0 1.5px var(--pa-ink-4);display:grid;place-items:center;color:transparent}
.pa-check[aria-checked='true']{background:var(--pa-ink);box-shadow:none;color:var(--pa-on-ink)}
.pa-page{flex:1 1 0px;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-gutter:stable}
.pa-page-inner{max-width:760px;margin:0 auto;padding:28px clamp(20px,4cqw,40px) 56px;display:flex;flex-direction:column;gap:32px}
.pa-sec{display:flex;flex-direction:column;gap:10px}
.pa-sec-head{display:flex;align-items:center;gap:8px;min-height:24px}
.pa-sec-head h2{font-size:13px;line-height:20px;font-weight:500;color:var(--pa-ink-2)}
.pa-sec-head .pa-count{color:var(--pa-ink-4);font-size:13px}
.pa-sec-head .pa-right{margin-left:auto;display:flex;align-items:center;gap:12px}
.pa-group{border:1px solid var(--pa-line);border-radius:var(--pa-r-md);overflow:hidden;background:var(--pa-bg)}
.pa-group.visible{overflow:visible}
.pa-group.danger{border-color:var(--pa-danger-line)}
.pa-row{display:flex;align-items:center;gap:12px;min-height:56px;padding:10px 16px;width:100%;text-align:left;color:inherit;text-decoration:none}
.pa-row+.pa-row,.pa-row+.pa-more,.pa-group>.pa-skel-row+.pa-skel-row{border-top:1px solid var(--pa-line-soft)}
.pa-row.compact{min-height:44px;padding:8px 16px}
.pa-row.sunken{background:var(--pa-bg-sunken)}
button.pa-row:hover,a.pa-row:hover,.pa-row.click:hover{background:var(--pa-hover)}
.pa-row.click{cursor:pointer}
.pa-row.attention{background:var(--pa-warn-soft)}
.pa-row-title{font-size:14px;line-height:22px;font-weight:500;display:flex;align-items:center;gap:8px;min-width:0}
.pa-row-icon{flex:none;width:20px;height:20px;display:grid;place-items:center;color:var(--pa-ink-3)}
.pa-more{display:flex;justify-content:center;width:100%;padding:9px 0;font-size:13px;line-height:20px;color:var(--pa-ink-2)}
.pa-more:hover{background:var(--pa-hover);color:var(--pa-ink)}
.pa-tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.pa-tile{display:flex;align-items:center;gap:12px;padding:14px 16px;border:1px solid var(--pa-line);border-radius:var(--pa-r-md);text-align:left;transition:background .15s var(--pa-ease);color:inherit;text-decoration:none}
.pa-tile:hover{background:var(--pa-hover)}
.pa-tile-ic{flex:none;width:32px;height:32px;border-radius:var(--pa-r-sm);background:var(--pa-fill-1);display:grid;place-items:center;color:var(--pa-ink-2)}
.pa-empty{display:flex;flex-direction:column;align-items:center;gap:4px;padding:28px 16px;text-align:center}
.pa-skeleton{display:block;height:12px;border-radius:6px;background:var(--pa-fill-2);animation:pa-skeleton 1.4s ease-in-out infinite}
.pa-skel-row{display:flex;flex-direction:column;gap:10px;padding:16px}
.pa-confirm{display:flex;flex-direction:column;gap:12px;padding:16px;background:var(--pa-danger-soft)}
.pa-confirm-text{display:flex;gap:8px;color:var(--pa-danger)}
.pa-back{display:inline-flex;align-items:center;gap:4px;margin:-8px 0 -12px -6px;padding:4px 8px 4px 4px;border-radius:var(--pa-r-sm);font-size:13px;line-height:20px;color:var(--pa-ink-2);align-self:flex-start}
.pa-back:hover{background:var(--pa-hover);color:var(--pa-ink)}
.pa-identity{display:flex;align-items:center;gap:16px}
.pa-identity h1{font-size:20px;line-height:28px;font-weight:500;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pa-kv{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}
.pa-kv>div{padding:12px 16px;display:flex;flex-direction:column;gap:2px;min-width:0}
.pa-kv>div+div{border-left:1px solid var(--pa-line-soft)}
.pa-kv-value{display:flex;align-items:center;gap:8px;font-weight:500}
.pa-pop{position:absolute;z-index:30;background:var(--pa-bg-pop);border-radius:var(--pa-r-md);box-shadow:var(--pa-shadow-pop);border:1px solid var(--pa-line-soft);animation:pa-pop .14s var(--pa-ease)}
.pa-menu{padding:6px;min-width:220px}
.pa-menu.right{top:36px;right:0;width:280px}
.pa-menu.up{bottom:36px;left:0;width:280px}
.pa-menu.full{top:44px;left:0;right:0}
.pa-menu.history{top:40px;right:0;width:300px}
.pa-menu-item{display:flex;align-items:center;gap:10px;width:100%;min-height:36px;padding:6px 10px;border-radius:var(--pa-r-sm);text-align:left;font-size:14px;line-height:22px}
.pa-menu-item:hover{background:var(--pa-hover)}
.pa-menu-item.on{background:var(--pa-fill-1)}
.pa-menu-item .pa-ck{margin-left:auto;color:var(--pa-ink)}
.pa-menu-sep{height:1px;background:var(--pa-line-soft);margin:6px 4px}
.pa-menu-label{padding:6px 10px 4px;font-size:12px;line-height:18px;color:var(--pa-ink-3)}
.pa-mask{position:absolute;inset:0;z-index:40;background:var(--pa-mask);display:grid;place-items:center;padding:24px;animation:pa-fade .15s}
.pa-dialog{width:100%;max-width:400px;background:var(--pa-bg-pop);border-radius:var(--pa-r-lg);box-shadow:var(--pa-shadow-pop);padding:24px;display:flex;flex-direction:column;gap:16px}
.pa-dialog h3{font-size:16px;line-height:24px;font-weight:500}
.pa-dialog-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
.pa-toast{position:absolute;left:50%;top:64px;transform:translateX(-50%);z-index:60;max-width:calc(100% - 48px);padding:9px 16px;border-radius:18px;background:var(--pa-ink);color:var(--pa-on-ink);font-size:13px;line-height:20px;box-shadow:var(--pa-shadow-pop);animation:pa-toast .2s var(--pa-ease)}
.pa-toast.danger{background:var(--pa-danger);color:#fff}
.pa-local-pop{top:48px;right:12px;width:340px;padding:16px;display:flex;flex-direction:column;gap:14px}
.pa-local-head{display:flex;align-items:center;gap:12px}
.pa-local-ic{flex:none;width:36px;height:36px;border-radius:var(--pa-r-sm);background:var(--pa-fill-1);display:grid;place-items:center;color:var(--pa-ink-2)}
.pa-switch-row{display:flex;align-items:flex-start;gap:12px}
.pa-scope-list{display:flex;flex-direction:column;gap:2px;padding:6px;border-radius:var(--pa-r-sm);background:var(--pa-bg-sunken)}
.pa-scope{display:flex;align-items:center;gap:10px;width:100%;min-height:32px;padding:4px 8px;border-radius:6px;text-align:left;font-size:13px;line-height:20px}
.pa-scope:not(:disabled):hover{background:var(--pa-hover)}
.pa-scope:disabled{cursor:default}
.pa-between{display:flex;align-items:center;justify-content:space-between;gap:12px}
.pa-center{flex:1 1 0px;min-height:0;overflow-y:auto;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 24px}
.pa-center-col{width:100%;max-width:440px;display:flex;flex-direction:column;align-items:center;gap:24px;text-align:center}
.pa-center-col h1{font-size:20px;line-height:28px;font-weight:500}
.pa-center-col .pa-group{width:100%;text-align:left}
.pa-center-col .pa-lede{margin-top:6px;font-size:14px;line-height:22px;color:var(--pa-ink-2)}
.pa-hero-ic{width:56px;height:56px;border-radius:var(--pa-r-lg);background:var(--pa-fill-1);display:grid;place-items:center;color:var(--pa-ink)}
.pa-step-num{flex:none;width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font-size:12px;line-height:1;box-shadow:inset 0 0 0 1.5px var(--pa-ink-4);color:var(--pa-ink-3)}
.pa-step-num.now{background:var(--pa-ink);color:var(--pa-on-ink);box-shadow:none}
.pa-step-num.done{background:var(--pa-ok-soft);color:var(--pa-ok);box-shadow:none}
.pa-step-num.failed{background:var(--pa-danger-soft);color:var(--pa-danger);box-shadow:none}
.pa-progress{height:3px;background:var(--pa-fill-1)}
.pa-progress i{display:block;height:100%;background:var(--pa-accent);transition:width .4s var(--pa-ease)}
.pa-progress.failed i{background:var(--pa-danger)}
.pa-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;align-items:center}
.pa-links{display:flex;align-items:center;gap:16px}
.pa-banner{flex:none;display:flex;align-items:center;gap:10px;margin:16px auto 0;width:calc(100% - 48px);max-width:760px;padding:10px 12px 10px 16px;border:1px solid var(--pa-line);border-radius:var(--pa-r-md)}
.pa-note{display:flex;align-items:flex-start;gap:8px;font-size:13px;line-height:20px;color:var(--pa-ink-2)}
.pa-note.danger{color:var(--pa-danger)}
.pa-note.ok{color:var(--pa-ok)}
@container (max-width:620px){
  .pa-hide-mid{display:none}
  .pa-tiles{grid-template-columns:1fr}
  .pa-suggest{grid-template-columns:1fr}
  .pa-thread-scroll{padding-inline:16px}
  .pa-hello{padding-inline:16px}
  .pa-composer-wrap{padding-inline:16px 25px}
}
@container (max-width:500px){
  .pa-hide-narrow{display:none}
  .pa-head{gap:4px;padding:0 12px}
}`;

const chat = `
.pa-chat{flex:1 1 0px;min-height:0;min-width:0;display:flex;flex-direction:column}
.pa-thread-scroll{flex:1 1 0px;min-height:0;min-width:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-gutter:stable;padding:0 24px}
.pa-thread{max-width:760px;margin:0 auto;padding:24px 0 16px;display:flex;flex-direction:column;gap:20px}
.pa-msg-user{align-self:flex-end;max-width:78%;display:flex;flex-direction:column;align-items:flex-end;gap:6px}
.pa-bubble{padding:9px 14px;border-radius:var(--pa-r-lg);background:var(--pa-fill-1);white-space:pre-wrap;overflow-wrap:anywhere}
.pa-bubble.queued{background:transparent;border:1px dashed var(--pa-line-strong);color:var(--pa-ink-2)}
.pa-msg-meta{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px;color:var(--pa-ink-3);flex-wrap:wrap;justify-content:flex-end}
.pa-msg-meta.danger{color:var(--pa-danger)}
.pa-msg-ai{display:flex;flex-direction:column;gap:10px;line-height:24px;overflow-wrap:anywhere;min-width:0}
.pa-msg-ai p{margin:0;white-space:pre-wrap}
.pa-msg-ai ul,.pa-msg-ai ol{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:2px}
.pa-msg-ai ul{list-style:disc}
.pa-msg-ai code{font-family:var(--pa-mono);font-size:13px;padding:1px 5px;border-radius:5px;background:var(--pa-fill-1)}
.pa-msg-ai pre{margin:0;padding:10px 12px;border-radius:var(--pa-r-sm);overflow-x:auto;font-size:13px;line-height:20px;background:var(--pa-bg-sunken);border:1px solid var(--pa-line-soft)}
.pa-msg-ai pre code{padding:0;background:transparent}
.pa-msg-ai blockquote{margin:0;padding-left:10px;border-left:3px solid var(--pa-line);color:var(--pa-ink-2)}
.pa-msg-ai hr{border:0;border-top:1px solid var(--pa-line);margin:2px 0;width:100%}
.pa-msg-ai a{color:var(--pa-accent);text-decoration:none}
.pa-steps{border:1px solid var(--pa-line-soft);border-radius:var(--pa-r-md);background:var(--pa-bg-sunken);overflow:hidden}
.pa-steps-toggle{display:flex;align-items:center;gap:8px;width:100%;height:36px;padding:0 12px;font-size:13px;line-height:20px;color:var(--pa-ink-2);text-align:left}
.pa-steps-toggle:hover{color:var(--pa-ink)}
.pa-steps-toggle .pa-chev{margin-left:auto;transition:transform .15s var(--pa-ease)}
.pa-steps[data-open='true'] .pa-chev{transform:rotate(90deg)}
.pa-steps-list{display:flex;flex-direction:column;padding:0 12px 8px}
.pa-steps[data-open='false'] .pa-steps-list{display:none}
.pa-step{display:flex;align-items:flex-start;gap:8px;min-height:28px;padding:4px 0;font-size:13px;line-height:20px;color:var(--pa-ink-2);overflow-wrap:anywhere}
.pa-step.failed{color:var(--pa-danger)}
.pa-working{display:flex;align-items:center;gap:8px;font-size:13px;line-height:20px;color:var(--pa-ink-2)}
.pa-working .pa-txt{animation:pa-awaiting 1.2s ease-in-out infinite}
.pa-sys-note{display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-radius:var(--pa-r-md);background:var(--pa-warn-soft);color:var(--pa-warn);font-size:13px;line-height:20px}
.pa-alert{display:flex;align-items:center;gap:8px;padding:8px 24px;font-size:13px;line-height:20px;color:var(--pa-warn);background:var(--pa-warn-soft)}
.pa-composer-wrap{flex:0 0 auto;min-width:0;padding:0 33px 16px 24px}
.pa-composer{max-width:760px;margin:0 auto;border-radius:var(--pa-r-xl);background:var(--pa-bg);box-shadow:inset 0 0 0 1px var(--pa-line-strong),0 2px 12px rgba(15,17,21,.04);padding:12px 12px 10px 16px;display:flex;flex-direction:column;gap:8px;position:relative;transition:box-shadow .15s var(--pa-ease)}
.pa-composer:focus-within{box-shadow:inset 0 0 0 1px var(--pa-ink-3),0 2px 12px rgba(15,17,21,.06)}
.pa-composer textarea{border:0;outline:0;resize:none;background:transparent;width:100%;min-width:0;min-height:44px;max-height:160px;padding:0;font-size:14px;line-height:22px;color:inherit}
.pa-composer textarea::placeholder{color:var(--pa-ink-4)}
.pa-composer-bar{display:flex;align-items:center;gap:6px;margin-left:-6px}
.pa-attach-row{display:flex;flex-wrap:wrap;gap:8px}
.pa-attach{display:inline-flex;align-items:center;gap:8px;height:32px;padding:0 6px 0 10px;border-radius:var(--pa-r-sm);background:var(--pa-fill-1);font-size:13px;line-height:20px;max-width:240px}
.pa-attach img{width:20px;height:20px;border-radius:4px;object-fit:cover;flex:none}
.pa-send{flex:none;width:32px;height:32px;border-radius:50%;display:grid;place-items:center;background:var(--pa-ink);color:var(--pa-on-ink);transition:background .15s var(--pa-ease)}
.pa-send:disabled{background:var(--pa-fill-2);color:var(--pa-ink-4);cursor:default}
.pa-send.queued{background:transparent;box-shadow:inset 0 0 0 1px dashed;border:1px dashed var(--pa-ink);color:var(--pa-ink)}
.pa-queue-notice{max-width:760px;margin:0 auto 6px;font-size:12px;line-height:18px;color:var(--pa-warn)}
.pa-hello{flex:1 1 0px;min-height:0;overflow-y:auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px;text-align:center}
.pa-hello h1{font-size:20px;line-height:28px;font-weight:500;margin-top:8px}
.pa-suggest{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;width:100%;max-width:560px;margin-top:20px}
.pa-suggest button{padding:12px 14px;border:1px solid var(--pa-line);border-radius:var(--pa-r-md);text-align:left;font-size:13px;line-height:20px;color:var(--pa-ink-2);transition:background .15s var(--pa-ease)}
.pa-suggest button:hover{background:var(--pa-hover);color:var(--pa-ink)}
.pa-session-row{display:flex;align-items:center;gap:10px;width:100%;min-height:40px;padding:6px 10px;border-radius:var(--pa-r-sm);text-align:left}
.pa-session-row:hover{background:var(--pa-hover)}
.pa-session-row.on{background:var(--pa-fill-1)}
.pa-skel-thread{display:flex;flex-direction:column;gap:14px;padding-top:8px}
.pa-skel-thread .pa-skel-user{display:flex;flex-direction:column;align-items:flex-end;gap:6px}
.pa-skel-thread .pa-skel-ai{display:flex;flex-direction:column;align-items:flex-start;gap:6px}
.pa-cc{flex:1 1 0px;min-height:0;min-width:0;display:flex;flex-direction:column;position:relative}
.pa-cc-bar{flex:none;height:38px;display:flex;align-items:center;gap:8px;padding:0 8px 0 16px}
.pa-cc-bar h2{font-size:14px;line-height:22px;font-weight:500;white-space:nowrap}
.pa-cc-stage-wrap{flex:1 1 0px;min-height:0;min-width:0;overflow:hidden;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:12px;padding:4px 16px 16px}
.pa-cc-stack{width:100%;max-width:1280px;min-height:0;flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px}
.pa-stage{position:relative;flex:none;min-width:0;border-radius:var(--pa-r-md);overflow:hidden;background:var(--pa-fill-1);box-shadow:0 0 0 1px var(--pa-line),0 8px 28px rgba(16,24,40,.08);transition:box-shadow .2s var(--pa-ease)}
.pa-stage[data-phase='control']{box-shadow:0 0 0 2px var(--pa-accent),0 8px 28px rgba(16,24,40,.12)}
.pa-stage-cover{position:absolute;inset:0;z-index:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:16px;text-align:center;background:color-mix(in srgb,var(--pa-bg) 86%,transparent);color:var(--pa-ink)}
.pa-stage-cover h3{font-size:16px;line-height:24px;font-weight:500}
.pa-stage-cover p{max-width:380px;font-size:13px;line-height:20px;color:var(--pa-ink-2)}
.pa-capsule{flex:none;display:inline-flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:10px;min-height:40px;max-width:100%;padding:4px 6px 4px 14px;border-radius:20px;background:var(--pa-bg-pop);box-shadow:inset 0 0 0 1px var(--pa-line),0 2px 8px rgba(15,17,21,.05);font-size:13px;line-height:20px;color:var(--pa-ink-2)}
.pa-capsule.plain{padding-right:14px}
.pa-cc-diag{right:8px;top:44px;width:260px;padding:12px 14px;display:flex;flex-direction:column;gap:4px}
.pa-cc-diag div{display:flex;justify-content:space-between;gap:12px;font-size:12px;line-height:20px;color:var(--pa-ink-2)}
.pa-cc-diag div span:last-child{color:var(--pa-ink);font-family:var(--pa-mono);font-size:11px;overflow-wrap:anywhere;text-align:right}
.pa-cc-alert{flex:none;padding:8px 16px;font-size:13px;line-height:20px;background:var(--pa-warn-soft);color:var(--pa-warn)}
.pa-page-panel{display:flex;flex-direction:column;flex:1 1 0px;min-height:0}
.pa-page-panel .pa-cc-stage-wrap{padding:16px}
.pa-page-panel .pa-stage{flex:1 1 0px;width:100%;min-height:240px}
.pa-page-panel .pa-stage canvas{width:100%;height:100%;display:block}
.pa-footer{flex:none;display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:8px 16px;font-size:12px;line-height:18px;color:var(--pa-ink-3);border-top:1px solid var(--pa-line-soft)}
.pa-footer summary{cursor:pointer}
.pa-footer details div{padding-top:6px;overflow-wrap:anywhere}`;

export const THEME_CSS = `${tokens}${base}${chat}`;

/** 挂载样式节点；视图树里放一次即可（React 会按 key 去重）。 */
export function themeStyle(h) {
  return h('style', { key: THEME_STYLE_ID, 'data-pa-theme': 'true' }, THEME_CSS);
}

/** 拼类名：忽略 falsy 片段。 */
export const cx = (...parts) => parts.filter(Boolean).join(' ');

const ICON_PATHS = {
  chat: ['M3 4.4c0-.8.6-1.4 1.4-1.4h7.2c.8 0 1.4.6 1.4 1.4v5.2c0 .8-.6 1.4-1.4 1.4H7.2L4.4 13.2V11c-.8 0-1.4-.6-1.4-1.4V4.4Z'],
  monitor: ['M1.8 2.8h12.4v8.4H1.8z', 'M5.6 13.6h4.8M8 11.2v2.4'],
  clock: ['M8 2a6 6 0 1 1 0 12A6 6 0 0 1 8 2Z', 'M8 4.8V8l2.2 1.4'],
  compose: ['M7.6 3H4.5A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13h7a1.5 1.5 0 0 0 1.5-1.5V8.4', 'm11.6 2.6 1.8 1.8-4.6 4.6-2.2.4.4-2.2 4.6-4.6Z'],
  plus: ['M8 3.2v9.6M3.2 8h9.6'],
  check: ['m3.4 8.3 2.9 2.9 6.3-6.6'],
  chevR: ['m6 3.6 4.4 4.4L6 12.4'],
  chevD: ['m3.6 6 4.4 4.4L12.4 6'],
  chevL: ['M10 3.6 5.6 8l4.4 4.4'],
  close: ['m4 4 8 8M12 4l-8 8'],
  warn: ['M8 2.6 14.2 13.4H1.8L8 2.6Z', 'M8 6.6v3.1M8 11.5v.1'],
  info: ['M8 1.8a6.2 6.2 0 1 1 0 12.4A6.2 6.2 0 0 1 8 1.8Z', 'M8 7.2v3.4M8 5.2v.1'],
  sliders: ['M2.5 5h5.5M11.5 5h2M2.5 11h2M8 11h5.5', 'M9.7 3.3a1.7 1.7 0 1 1 0 3.4 1.7 1.7 0 0 1 0-3.4ZM6.2 9.3a1.7 1.7 0 1 1 0 3.4 1.7 1.7 0 0 1 0-3.4Z'],
  folder: ['M1.9 4.6c0-.8.6-1.4 1.4-1.4h2.6l1.3 1.6h5.5c.8 0 1.4.6 1.4 1.4v5.2c0 .8-.6 1.4-1.4 1.4H3.3c-.8 0-1.4-.6-1.4-1.4V4.6Z'],
  calendar: ['M2 3.2h12v10.6H2z', 'M2 6.6h12M5.4 1.8v2.6M10.6 1.8v2.6'],
  star: ['M8 2.2 9.6 6l4 .3-3.1 2.6 1 3.9L8 10.6l-3.5 2.2 1-3.9L2.4 6.3l4-.3L8 2.2Z'],
  file: ['M4.4 1.8h4.8l3 3v8a1.4 1.4 0 0 1-1.4 1.4H4.4A1.4 1.4 0 0 1 3 12.8V3.2c0-.8.6-1.4 1.4-1.4Z', 'M9 1.9V5h3.1'],
  terminal: ['M1.8 2.8h12.4v10.4H1.8z', 'm4.6 6.4 2 1.8-2 1.8M8.4 10.2h3'],
  globe: ['M8 1.8a6.2 6.2 0 1 1 0 12.4A6.2 6.2 0 0 1 8 1.8Z', 'M1.8 8h12.4M8 1.8c1.8 1.8 2.6 3.9 2.6 6.2S9.8 12.4 8 14.2C6.2 12.4 5.4 10.3 5.4 8S6.2 3.6 8 1.8Z'],
  arrowUp: ['M8 13V3.4M3.8 7.4 8 3.2l4.2 4.2'],
  refresh: ['M13.2 8a5.2 5.2 0 1 1-1.6-3.8', 'M13.4 2.4v2.9h-2.9'],
  trash: ['M2.8 4.4h10.4M6.2 4.4V2.9h3.6v1.5M4.2 4.4l.6 8.2c0 .7.6 1.2 1.3 1.2h3.8c.7 0 1.3-.5 1.3-1.2l.6-8.2'],
  download: ['M8 2.6v7.6M4.6 7.2 8 10.4l3.4-3.2M3 13.2h10'],
  spinner: ['M8 1.8a6.2 6.2 0 1 0 6.2 6.2'],
  spark: ['M8 1.8 9.4 6.6 14.2 8 9.4 9.4 8 14.2 6.6 9.4 1.8 8l4.8-1.4L8 1.8Z'],
  laptop: ['M3 3h10v7.2H3z', 'M1.6 12.8h12.8'],
  bolt: ['M8.8 1.8 3.6 9h3.8l-.6 5.2L12.4 7H8.4l.4-5.2Z'],
  lock: ['M3 7h10v6.6H3z', 'M5.2 7V5.2a2.8 2.8 0 0 1 5.6 0V7'],
  stop: ['M4 4h8v8H4z'],
};

/** 线性图标：统一 16 视口、1.5 描边；size 为渲染尺寸。 */
export function icon(h, name, { size = 16, className = '', style = null, color = null } = {}) {
  const paths = ICON_PATHS[name] || [];
  return h('svg', {
    'aria-hidden': 'true', width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', className: className || undefined,
    style: { ...(style || {}), ...(color ? { color } : {}) },
  }, paths.map((d, index) => h('path', { key: index, d })));
}
