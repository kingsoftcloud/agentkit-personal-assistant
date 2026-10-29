import test from 'node:test';
import assert from 'node:assert/strict';
import { fitDesktopBox, mapDisplayPoint } from '../src/client/desktop-view.mjs';

const near = (actual, expected, tolerance = 0.01) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

test('宽高都够时按宽度铺满，卡片正好等于可用宽度', () => {
  assert.deepEqual(fitDesktopBox({ availableWidth: 1187, availableHeight: 900 }), { width: 1187, height: 741.88 });
});

test('全屏高度不够时按高度反推宽度，远端画面整体缩小而不是被裁', () => {
  // 可用区 1187x741.88 的 1280:800 恰好等于按宽度铺满，这里用更矮的可用区验证高度分支。
  const box = fitDesktopBox({ availableWidth: 1187, availableHeight: 600 });
  assert.deepEqual(box, { width: 960, height: 600 });
  assert.ok(box.height <= 600 + 0.01);
});

test('maxWidth 参与取小：宽屏全屏时桌面不会被拉过 1280', () => {
  assert.deepEqual(fitDesktopBox({ availableWidth: 2400, availableHeight: 2000, maxWidth: 1280 }), { width: 1280, height: 800 });
});

test('非 16:10 的远端桌面按自己的比例含入，不强行套 1280/800', () => {
  const box = fitDesktopBox({ availableWidth: 1000, availableHeight: 500, display: { width: 1024, height: 768 } });
  near(box.width, 666.67); near(box.height, 500);
  near(box.width / box.height, 1024 / 768, 0.001);
});

test('可用区量不出来时返回 0x0，由调用方退回 CSS 等比', () => {
  assert.deepEqual(fitDesktopBox({ availableWidth: 0, availableHeight: 800 }), { width: 0, height: 0 });
  assert.deepEqual(fitDesktopBox({ availableWidth: 1200, availableHeight: 0 }), { width: 0, height: 0 });
  assert.deepEqual(fitDesktopBox({ availableWidth: Number.NaN, availableHeight: Number.NaN }), { width: 0, height: 0 });
  assert.deepEqual(fitDesktopBox({ availableWidth: -10, availableHeight: -10 }), { width: 0, height: 0 });
  assert.deepEqual(fitDesktopBox(), { width: 0, height: 0 });
});

test('任意可用区都不会超出边界，并且至少铺满一条边', () => {
  const displays = [{ width: 1280, height: 800 }, { width: 1024, height: 768 }, { width: 1920, height: 1080 }];
  for (const display of displays) {
    for (const availableWidth of [320, 640, 900, 1187, 1600, 2400]) {
      for (const availableHeight of [180, 400, 600, 741, 823, 1400]) {
        const box = fitDesktopBox({ availableWidth, availableHeight, display, maxWidth: 1280 });
        assert.ok(box.width > 0 && box.height > 0);
        assert.ok(box.width <= Math.min(availableWidth, 1280) + 0.01, `宽度超界 ${box.width} > ${availableWidth}`);
        assert.ok(box.height <= availableHeight + 0.01, `高度超界 ${box.height} > ${availableHeight}`);
        near(box.width / box.height, display.width / display.height, 0.002);
        const fillsWidth = Math.abs(box.width - Math.min(availableWidth, 1280)) <= 0.5;
        const fillsHeight = Math.abs(box.height - availableHeight) <= 0.5;
        assert.ok(fillsWidth || fillsHeight, `既没铺满宽也没铺满高：${box.width}x${box.height}`);
      }
    }
  }
});

test('按 fitDesktopBox 得到的卡片尺寸做点击映射，四角仍落在远端桌面四角', () => {
  const stage = { left: 116, top: 57, ...fitDesktopBox({ availableWidth: 1187, availableHeight: 600 }) };
  const display = { width: 1280, height: 800 };
  assert.deepEqual(mapDisplayPoint({ clientX: stage.left, clientY: stage.top, rect: stage, display }), { x: 0, y: 0 });
  assert.deepEqual(mapDisplayPoint({ clientX: stage.left + stage.width, clientY: stage.top + stage.height, rect: stage, display }), { x: 1279, y: 799 });
  const center = mapDisplayPoint({ clientX: stage.left + stage.width / 2, clientY: stage.top + stage.height / 2, rect: stage, display });
  assert.deepEqual(center, { x: 640, y: 400 });
});
