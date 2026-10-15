import { ActiveRoomInfo } from '../types';

const RECENT_KEY = 'wt-recent-rooms';
const CACHED_ROOMS_KEY = 'wt-cached-active-rooms';

export interface RecentRoom {
  code: string;
  name?: string;
  movieTitle?: string;
  visitedAt: number;
}

// In-memory cache of currently known active rooms
let cachedActiveRooms: ActiveRoomInfo[] = [];
try {
  const stored = localStorage.getItem(CACHED_ROOMS_KEY);
  if (stored) {
    cachedActiveRooms = JSON.parse(stored);
  }
} catch {}

const listeners = new Set<(rooms: ActiveRoomInfo[]) => void>();

// BroadcastChannel for instant inter-tab awareness
let channel: BroadcastChannel | null = null;
try {
  if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
    channel = new BroadcastChannel('wt_active_rooms');
    channel.addEventListener('message', (ev) => {
      if (ev.data?.type === 'rooms_updated' && Array.isArray(ev.data.rooms)) {
        updateCachedRooms(ev.data.rooms);
      } else if (ev.data?.type === 'room_active' && ev.data.room) {
        addOrUpdateRoom(ev.data.room);
      } else if (ev.data?.type === 'room_closed' && ev.data.code) {
        removeLocalRoom(ev.data.code);
      }
    });
  }
} catch {}

function updateCachedRooms(rooms: ActiveRoomInfo[]) {
  cachedActiveRooms = rooms;
  try {
    localStorage.setItem(CACHED_ROOMS_KEY, JSON.stringify(rooms));
  } catch {}
  for (const fn of listeners) {
    try {
      fn(cachedActiveRooms);
    } catch {}
  }
}

function addOrUpdateRoom(room: ActiveRoomInfo) {
  const existing = cachedActiveRooms.filter((r) => r.code !== room.code);
  existing.unshift(room);
  updateCachedRooms(existing);
}

function removeLocalRoom(code: string) {
  const filtered = cachedActiveRooms.filter((r) => r.code !== code);
  updateCachedRooms(filtered);
}



export async function fetchActiveRooms(): Promise<ActiveRoomInfo[]> {
  try {
    const res = await fetch('/api/rooms', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.rooms)) {
        updateCachedRooms(data.rooms);
        return data.rooms;
      }
    }
  } catch (err) {
    console.debug('Failed to fetch rooms from API, fallback to cache:', err);
  }
  // Fallback to cache if available
  if (cachedActiveRooms.length > 0) {
    return cachedActiveRooms;
  }
  return [];
}

export async function registerActiveRoom(room: {
  code: string;
  hostName: string;
  movieTitle: string;
  movieUrl?: string;
  viewerCount: number;
}): Promise<void> {
  const cleanCode = room.code.trim().toUpperCase();
  const fullRoom: ActiveRoomInfo = {
    code: cleanCode,
    hostName: room.hostName,
    movieTitle: room.movieTitle,
    viewerCount: room.viewerCount,
    lastSeen: Date.now(),
    createdAt: Date.now(),
  };

  // Immediately update local cache & BroadcastChannel so user and other tabs see it right away!
  addOrUpdateRoom(fullRoom);
  if (channel) {
    try {
      channel.postMessage({ type: 'room_active', room: fullRoom });
    } catch {}
  }

  // Save to recent rooms
  addRecentRoom({
    code: cleanCode,
    name: room.hostName,
    movieTitle: room.movieTitle,
    visitedAt: Date.now(),
  });

  // Post to server
  try {
    await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(room),
      keepalive: true,
    });
  } catch (err) {
    console.debug('Failed to register room to server:', err);
  }
}

export async function removeActiveRoom(code: string): Promise<void> {
  const cleanCode = code.trim().toUpperCase();
  removeLocalRoom(cleanCode);
  if (channel) {
    try {
      channel.postMessage({ type: 'room_closed', code: cleanCode });
    } catch {}
  }
  try {
    await fetch(`/api/rooms/${encodeURIComponent(cleanCode)}`, {
      method: 'DELETE',
      keepalive: true,
    });
  } catch {}
}

export function subscribeToRoomBroadcasts(onUpdate: (rooms: ActiveRoomInfo[]) => void): () => void {
  listeners.add(onUpdate);
  // Send current cache right away
  if (cachedActiveRooms.length > 0) {
    onUpdate(cachedActiveRooms);
  }
  return () => {
    listeners.delete(onUpdate);
  };
}

// Local storage recent rooms
export function getRecentRooms(): RecentRoom[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function addRecentRoom(room: RecentRoom): void {
  try {
    const list = getRecentRooms().filter((r) => r.code !== room.code);
    list.unshift(room);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8)));
  } catch {}
}

export function clearRecentRooms(): void {
  try {
    localStorage.removeItem(RECENT_KEY);
  } catch {}
}
