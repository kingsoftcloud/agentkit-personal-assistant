/** 个人助理新建声明的默认模型；显式指定其他模型时仍尊重声明。 */
export const DEFAULT_PERSONAL_ASSISTANT_MODEL = 'deepseek-v4.1-flash-1017';

export function cloudModelDefinition(model = DEFAULT_PERSONAL_ASSISTANT_MODEL) {
  return {
    id: model, name: model, contextWindow: 131072, maxTokens: 8192,
    // 只有经云网关实际图像输入验证的默认模型声明视觉能力。
    input: model === DEFAULT_PERSONAL_ASSISTANT_MODEL ? ['text', 'image'] : ['text'],
  };
}
