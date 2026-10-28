// ── Socket loadout merge (pure - the cross-game base⊕override layering) ─────
//
// A character carries a GLOBAL socket loadout ("wear a hat in every game")
// stored on the character record as a socket-name → item-name map. Each
// animation clip may then carry its own per-clip socket overrides
// (`socketItems[]`): an entry can REPLACE the item on a socket for that clip,
// or REMOVE it. The effective set a game renders while a clip plays is:
//
//     RESULT[socket] = override wins if present, else the base loadout item;
//                      a removal entry drops the socket entirely.
//
// This module is the single, dependency-free source of truth for that merge, so
// every app that renders these characters layers sockets identically instead
// of re-deriving it. It does NO bone attachment or asset loading - a game feeds
// the merged result into its own attach driver (bone world matrix × the item's
// socket fit transform, which the host's item manifest supplies).
//
// Removal has two accepted wire forms, normalized here:
//   • `{ socket, hide: true }`   - the canonical form.
//   • `{ socket, item: null }`   - the legacy "reserved/empty slot" form.
// Both mean "remove this socket for the clip". New authoring should emit
// `hide: true`; `item: null` stays supported so existing authored data keeps
// working.

/**
 * A character's global socket loadout: socket name → item name. This is the
 * BASE layer, applied across every game, and is whatever map the host serves
 * alongside the character record.
 */
export type SocketLoadout = Record<string, string>;

/**
 * One per-clip socket override, as authored on an animation's `socketItems[]`.
 * Accepts every in-the-wild shape:
 *   • `{ socket, item }`         - replace the socket's item for this clip.
 *   • `{ socket, hide: true }`   - remove the socket's item (canonical form).
 *   • `{ socket, item: null }`   - remove (legacy form).
 */
export interface SocketOverride {
  socket: string;
  /** Item name to place on the socket; `null`/absent (with no explicit item) reads as a removal. */
  item?: string | null;
  /** When true, remove this socket's item for the clip regardless of `item`. */
  hide?: boolean;
}

/**
 * The resolved item to attach to a socket for the current clip - always a
 * concrete item name (removals are already dropped).
 */
export interface ResolvedSocketItem {
  socket: string;
  item: string;
}

/** True when an override entry means "remove this socket" rather than replace it. */
export function isSocketRemoval(o: SocketOverride): boolean {
  // `item == null` catches both null and undefined; a real replace always
  // carries a non-empty item string.
  return o.hide === true || o.item == null;
}

/**
 * Merge a character's global base loadout with a clip's per-clip socket
 * overrides, returning the effective set of items to attach while that clip
 * plays. Override wins per socket (replace, or remove via `hide:true`/`item:null`);
 * sockets untouched by the clip keep their base item.
 *
 * Order-independent by socket (one item per socket). Passing `base = null`
 * yields the clip's own items minus any removals - a safe drop-in for a game
 * that has no base loadout yet.
 *
 * @example
 * // base: hat on head; clip swaps in a crown and removes the hat's socket via a helmet
 * mergeSocketLoadout(
 *   { head: 'wizard_hat', back: 'cape' },
 *   [{ socket: 'head', item: 'gold_crown' }, { socket: 'hand_r', item: 'sword' }],
 * )
 * // => [{socket:'head',item:'gold_crown'}, {socket:'back',item:'cape'}, {socket:'hand_r',item:'sword'}]
 */
export function mergeSocketLoadout(
  base: SocketLoadout | null | undefined,
  overrides: readonly SocketOverride[] | null | undefined,
): ResolvedSocketItem[] {
  const bySocket = new Map<string, string>(); // socket → item name

  if (base) {
    for (const socket of Object.keys(base)) {
      const item = base[socket];
      if (item) bySocket.set(socket, item);
    }
  }

  if (overrides) {
    for (const o of overrides) {
      if (!o || !o.socket) continue;
      if (isSocketRemoval(o)) {
        bySocket.delete(o.socket);
      } else {
        // `item` is a non-null string here (isSocketRemoval ruled out null/undefined).
        bySocket.set(o.socket, o.item as string);
      }
    }
  }

  const out: ResolvedSocketItem[] = [];
  for (const [socket, item] of bySocket) out.push({ socket, item });
  return out;
}
