import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchGatewayChatModels } from '../src/cloud-model.mjs';

test('runtime uses the inference route’s directory and excludes non-chat and incomplete entries', async () => {
  const chat = { architecture: { input_modalities: ['文字', '图片', '视频'], output_modalities: ['文字'] } };
  const models = await fetchGatewayChatModels({
    baseURL: 'https://gateway.example/inference/v1/', apiKey: 'scoped-key',
    fetchImpl: async (url, options) => {
      assert.equal(url.href, 'https://gateway.example/inference/v1/models');
      assert.equal(options.headers.Authorization, 'Bearer scoped-key');
      return Response.json({ data: [
        { ...chat, id: 'fast-chat', context_length: '1024k', max_completion_tokens: '384k' },
        { id: 'small-chat', context_length: 65_536, max_completion_tokens: '4K', architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
        { id: 'video', context_length: '1024K', max_completion_tokens: '8K', architecture: { input_modalities: ['文字'], output_modalities: ['视频'] } },
        { ...chat, id: 'unreported-window', context_length: '', max_completion_tokens: '8K' },
      ] });
    },
  });
  assert.deepEqual(models.map(({ id, contextWindow, maxTokens, input }) => ({ id, contextWindow, maxTokens, input })), [
    { id: 'fast-chat', contextWindow: 1_048_576, maxTokens: 8192, input: ['text', 'image'] },
    { id: 'small-chat', contextWindow: 65_536, maxTokens: 4096, input: ['text'] },
  ]);
});
