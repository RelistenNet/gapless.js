// The page has more than one player. Starting one pauses the others.

const players = new Map<string, () => void>();

export function registerPlayer(id: string, pause: () => void): () => void {
  players.set(id, pause);
  return () => {
    if (players.get(id) === pause) players.delete(id);
  };
}

export function claimPlayback(id: string): void {
  for (const [otherId, pause] of players) if (otherId !== id) pause();
}
