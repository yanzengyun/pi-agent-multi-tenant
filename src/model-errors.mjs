export const QUOTA_NOTICE = '⚠️ 模型服务额度已用完，本次聊天或总结未能完成。请等待额度恢复、补充用量，或联系管理员切换可用服务后重试。';

export function isQuotaFailure(error) {
  if (error?.code === 'model_quota_exhausted') return true;
  const text = typeof error === 'string' ? error : error?.message || '';
  return /已达到\s*Token Plan\s*用量上限|(?:额度|配额|用量).{0,12}(?:耗尽|用完|不足)|insufficient_quota|quota_exceeded|\(2056\)/i.test(text);
}
