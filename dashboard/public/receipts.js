// Decides which unconfirmed submissions the agent's history proves as delivered.
// Only an authoritative page may prove delivery: a cached page is a guess and must
// neither settle nor drop a receipt (otherwise a resend of a real failure is hidden,
// or a delivered message is re-offered).
export function settleReceipts(receipts, messages, { authoritative }) {
  if (!authoritative) return { pending: receipts, delivered: [] };
  const unmatched = messages.filter(message => message.role === 'user');
  const pending = [], delivered = [];
  for (const receipt of receipts) {
    const index = unmatched.findIndex(message => message.text === receipt.text && !receipt.previousIds.includes(message.id));
    if (index < 0) { pending.push(receipt); continue; }
    unmatched.splice(index, 1);
    delivered.push(receipt);
  }
  return { pending, delivered };
}
