import test from 'node:test';
import assert from 'node:assert/strict';
import { turnErrorText } from '../src/client/conversation.mjs';

/**
 * 云端 turns 里的 error 字段既可能是字符串，也可能是 { code, message } 对象。
 * 用户实测曾看到「任务失败：[object Object]」——那等于完全没有失败原因，所以这里把
 * 各种形态都钉死：永远不能把对象直接字符串化给用户看。
 */

test('对象形态的 turn.error 不再渲染成 [object Object]', () => {
  const text = turnErrorText({ code: 'RUNTIME_PROCESS_INTERRUPTED', message: 'runtime restarted' });
  assert.equal(text, '云电脑重启，任务被中断');
  assert.ok(!text.includes('[object Object]'));
});

test('只有 message 的对象按原文展示', () => {
  assert.equal(turnErrorText({ message: '云端拒绝执行这一轮' }), '云端拒绝执行这一轮');
});

test('未知错误码退化成可读中文，而不是大写码或对象', () => {
  assert.equal(turnErrorText({ code: 'SOME_UNKNOWN_CODE' }), '云端没有完成这一轮，请重试');
  assert.equal(turnErrorText('SOME_UNKNOWN_CODE'), '云端没有完成这一轮，请重试');
});

test('字符串形态保持原有行为', () => {
  assert.equal(turnErrorText('DSH_SESSION_NOT_FOUND'), '会话不存在或已被删除');
  assert.equal(turnErrorText('云端超时'), '云端超时');
});

test('空值与异常形态都有兜底文案', () => {
  for (const value of [null, undefined, '', {}, 0, false, []]) {
    const text = turnErrorText(value);
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 0);
    assert.ok(!text.includes('[object Object]'), `不应出现 [object Object]，实际：${text}`);
  }
  assert.equal(turnErrorText(null), '请检查任务状态后重试');
  assert.equal(turnErrorText({}), '请检查任务状态后重试');
});

test('嵌套对象也能取到可读文案', () => {
  assert.equal(turnErrorText({ error: { message: '嵌套原因' } }), '嵌套原因');
  assert.equal(turnErrorText({ reason: '显式原因' }), '显式原因');
});

test('过长的错误文案截断到 160 字符以内', () => {
  const text = turnErrorText('x'.repeat(500));
  assert.equal(text.length, 160);
});
