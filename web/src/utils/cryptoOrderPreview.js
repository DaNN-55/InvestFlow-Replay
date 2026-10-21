import { errorText } from './cryptoReplayPresentation.js';
export function createCryptoPreviewLoader({ request, changed }) {
  let sequence = 0;
  return {
    cancel() { sequence++; },
    async load(input) {
      const current = ++sequence, key = JSON.stringify(input);
      changed({ busy: true, preview: null, error: '', key });
      try {
        const { sessionId, ...body } = input, { preview } = await request(sessionId, body);
        if (current !== sequence) return;
        if (preview.sessionId !== sessionId || preview.revision !== input.expectedRevision) throw new Error('会话已变化，请重新预览');
        changed({ busy: false, preview, error: '', key });
      } catch (error) {
        if (current === sequence) changed({ busy: false, preview: null, error: errorText(error), key });
      }
    },
  };
}
