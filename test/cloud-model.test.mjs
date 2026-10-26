import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PERSONAL_ASSISTANT_MODEL, cloudModelDefinition } from '../src/cloud-model.mjs';

test('默认模型使用用户指定的准确名称并声明已经实测的图片输入', () => {
  assert.equal(DEFAULT_PERSONAL_ASSISTANT_MODEL, 'deepseek-v4.1-flash-1017');
  assert.deepEqual(cloudModelDefinition().input, ['text', 'image']);
  assert.equal(cloudModelDefinition().id, DEFAULT_PERSONAL_ASSISTANT_MODEL);
  assert.deepEqual(cloudModelDefinition('glm-5.1').input, ['text']);
  assert.equal(cloudModelDefinition('explicit-model').id, 'explicit-model');
});
