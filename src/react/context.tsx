import type { ReactNode } from 'react';
import { createContext, useContext, useMemo } from 'react';

import type { ViggleSceneClientOptions } from '../core/client.js';
import { ViggleSceneClient } from '../core/client.js';

const ClientContext = createContext<ViggleSceneClient | null>(null);

export type ViggleSceneProviderProps =
  | { client: ViggleSceneClient; children?: ReactNode }
  | (ViggleSceneClientOptions & { client?: undefined; children?: ReactNode });

/**
 * Makes a scene client available to the hooks and components below. Pass a
 * ready `client`, or the options to build one (`baseUrl`, `apiKey`).
 *
 * Built from options, the client is rebuilt only when `baseUrl` changes; pass
 * `apiKey` as a function to rotate it without a rebuild, or build the client
 * yourself and pass `client` for full control.
 */
export function ViggleSceneProvider(props: ViggleSceneProviderProps) {
  const { children } = props;
  const given = props.client;
  const baseUrl = given ? void 0 : props.baseUrl;
  const options = given ? void 0 : props;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuilt on baseUrl only; see above.
  const built = useMemo(() => (options ? new ViggleSceneClient(options) : null), [baseUrl]);
  return <ClientContext.Provider value={given ?? built}>{children}</ClientContext.Provider>;
}

/** The client from the nearest `ViggleSceneProvider`. */
export function useViggleSceneClient(): ViggleSceneClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error('useViggleSceneClient: wrap the tree in <ViggleSceneProvider>.');
  return client;
}
