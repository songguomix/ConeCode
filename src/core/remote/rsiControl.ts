export const REMOTE_RSI_ACTION = 'conecode:remote-rsi-action';
export interface RemoteRsiAction {
  conversationId: string;
  action: 'start' | 'stop';
  accept: () => void;
}

/** Delegate to the mounted RSI view's existing permission checks, start lock and stop handler. */
export function requestRsiAction(conversationId: string, action: RemoteRsiAction['action']): boolean {
  let accepted = false;
  window.dispatchEvent(new CustomEvent<RemoteRsiAction>(REMOTE_RSI_ACTION, {
    detail: { conversationId, action, accept: () => { accepted = true; } },
  }));
  return accepted;
}
