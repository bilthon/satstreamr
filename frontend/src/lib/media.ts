import { PeerConnection } from './peer-connection.js';

export async function startMedia(
  peer: PeerConnection,
  localVideoEl: HTMLVideoElement | null,
  showError: (msg: string) => void,
): Promise<MediaStream | null> {
  try {
    const stream = await peer.initMedia();
    if (localVideoEl !== null) {
      localVideoEl.srcObject = stream;
    }
    return stream;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    showError(message);
    return null;
  }
}
