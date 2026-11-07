export type Intent = 'accept' | 'complete' | 'cannot' | 'next';
export type Reply = 'yes' | 'no';
export type Parsed = { kind: 'intent'; intent: Intent } | { kind: 'reply'; reply: Reply } | { kind: 'unknown' };

/** Commitments change shared state, so voice must confirm them first. */
export const CONSEQUENTIAL: readonly Intent[] = ['accept', 'complete', 'cannot'];

const norm = (s: string) => s.toLowerCase().replace(/[’`]/g, "'").replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim();

export function parseUtterance(text: string, expectReply = false): Parsed {
  const t = norm(text);
  if (!t) return { kind: 'unknown' };
  if (expectReply) {
    if (/^(yes|yeah|yep|confirm|confirmed|correct|affirmative|go ahead|do it|sure|ok|okay)\b/.test(t)) return { kind: 'reply', reply: 'yes' };
    if (/^(no|nope|cancel|stop|never ?mind|negative|wait|don'?t)\b/.test(t)) return { kind: 'reply', reply: 'no' };
  }
  if (/\b(can'?t|cannot|can not|unable|not able|decline|refuse|no can do)\b/.test(t)) return { kind: 'intent', intent: 'cannot' };
  if (/\b(what'?s next|what is next|what next|next task|next step|what now|what should i do)\b/.test(t)) return { kind: 'intent', intent: 'next' };
  if (/\b(complete|completed|done|finished|finish)\b/.test(t)) return { kind: 'intent', intent: 'complete' };
  if (/\b(accept|accepted|take it|taking it|i'?ll take|i will take|on it|will do)\b/.test(t)) return { kind: 'intent', intent: 'accept' };
  return { kind: 'unknown' };
}

export const INTENT_LABEL: Record<Intent, string> = { accept: 'Accept', complete: 'Done', cannot: "Can't do", next: 'What next' };
