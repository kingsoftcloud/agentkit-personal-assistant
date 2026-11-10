/** Shared limits for cloud-owned attachment receipts; never accepts local paths or URLs. */
export const ASSISTANT_ATTACHMENT_LIMITS = Object.freeze({
  maxAttachmentBytes: 20 * 1024 * 1024,
  maxMessageAttachmentBytes: 32 * 1024 * 1024,
  maxAttachments: 8,
  maxTextLength: 32000,
  maxNameLength: 255,
});
export const ASSISTANT_UPLOAD_BODY_BYTES = Math.ceil(ASSISTANT_ATTACHMENT_LIMITS.maxAttachmentBytes / 3) * 4 + 65536;
// Same authenticated DSH Connection RPC, with a narrow large-body ingress.
// The extra allowance covers the RPC envelope, not additional attachment data.
export const ASSISTANT_UPLOAD_CHANNEL = '/agentkit-assistant-upload';
export const ASSISTANT_UPLOAD_RPC_PATH = `${ASSISTANT_UPLOAD_CHANNEL}/assistant/execute`;
export const ASSISTANT_UPLOAD_RPC_BODY_BYTES = ASSISTANT_UPLOAD_BODY_BYTES + 65536;
export const ASSISTANT_IMAGE_MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const ASSISTANT_ATTACHMENT_CAPABILITIES = Object.freeze({
  upload: 'personal-assistant-attachments/v1',
  content: 'personal-assistant-content/v1',
  read: 'personal-assistant-file-read/v1',
});
