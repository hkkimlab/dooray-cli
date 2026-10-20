import type { Client } from "../core/client.js";
import { isId, matchByName } from "../core/resolve.js";

export interface ResourceCategory {
  id: string;
  type: string;
  name: string;
}

export interface Resource {
  id: string;
  name: string;
  use?: boolean;
}

export interface Reservation {
  id: string;
  resource?: { id: string; name?: string };
  subject?: string;
  startedAt?: string;
  endedAt?: string;
  wholeDayFlag?: boolean;
}

const R = "/reservation/v1";
const RES = `${R}/resource-reservations`;

export const listCategories = (c: Client, limit = 0): Promise<ResourceCategory[]> => c.list(`${R}/resource-categories`, {}, limit);
/** Resources the member may reserve; the server wants a category or a period. */
export const listReservable = (c: Client, resourceCategoryId?: string, limit = 0): Promise<Resource[]> =>
  c.list(`${R}/reservable-resources`, { resourceCategoryId }, limit);
/** Every resource in use; reservation-manager permission only. */
export const listAllResources = (c: Client, resourceCategoryId?: string, limit = 0): Promise<Resource[]> =>
  c.list(`${R}/resources`, { resourceCategoryId }, limit);
export const getResource = (c: Client, id: string): Promise<Resource> => c.call("GET", `${R}/resources/${id}`);

export const listReservations = (c: Client, timeMin: string, timeMax: string, resourceIds: string[], limit = 0): Promise<Reservation[]> =>
  c.list(RES, { timeMin, timeMax, resourceIds }, limit);
/** Recurring occurrences are addressed as {id}-{yyyyMMddTHHmmssZ}. */
export const getReservation = (c: Client, id: string): Promise<Reservation> => c.call("GET", `${RES}/${id}`);
export const createReservation = (c: Client, body: Record<string, unknown>): Promise<{ id: string; masterResourceReservationId?: string }> =>
  c.call("POST", RES, { body });
export const updateReservation = (c: Client, id: string, body: Record<string, unknown>): Promise<null> => c.call("PUT", `${RES}/${id}`, { body });
/** DELETE with a JSON body; deleteType is "" for non-recurring reservations. */
export const cancelReservation = (c: Client, id: string, deleteType: string): Promise<null> =>
  c.call("DELETE", `${RES}/${id}`, { body: { deleteType } });

export async function resolveCategory(c: Client, ref: string): Promise<string> {
  if (isId(ref)) return ref;
  return matchByName(await listCategories(c), ref, { kind: "resource category", name: (x) => x.name, id: (x) => x.id }).id;
}
