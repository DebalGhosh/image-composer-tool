import { useRef, useCallback } from 'react';
import { createQueryStream } from '../api/ai';

export function useSSE() {
  const streamRef = useRef(null);

  const startStream = useCallback((query, sessionId, callbacks) => {
    // Abort any existing stream
    if (streamRef.current) {
      streamRef.current.close();
    }

    streamRef.current = createQueryStream(query, sessionId, callbacks);
    
    return () => {
      if (streamRef.current) {
        streamRef.current.close();
        streamRef.current = null;
      }
    };
  }, []);

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.close();
      streamRef.current = null;
    }
  }, []);

  return { startStream, stopStream };
}
