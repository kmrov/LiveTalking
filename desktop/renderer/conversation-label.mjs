export function conversationLabel(conversation, messages = []) {
  const first = messages.find(item => item?.role === 'user' && typeof item.text === 'string' && item.text.trim());
  const title = typeof conversation?.title === 'string' && conversation.title.trim()
    ? conversation.title : first?.text;
  if (title) {
    const compact = title.replace(/\s+/g, ' ').trim();
    return compact.length > 44 ? `${compact.slice(0, 43).trimEnd()}…` : compact;
  }
  const date = new Date(conversation?.updated_at || conversation?.created_at);
  return Number.isNaN(date.getTime()) ? 'New conversation' : date.toLocaleString('en-US');
}
