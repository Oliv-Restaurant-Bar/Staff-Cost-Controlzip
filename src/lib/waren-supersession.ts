/** Minimale, persistence-unabhängige Form der revisionssicheren Ersetzung. */
export interface WarenSupersession {
  superseded?: boolean;
  supersededById?: string;
  supersededByReference?: string;
}

/** Ein Lineage-Verweis allein genügt: Der historische Eintrag zählt nicht. */
export function istErsetzt(e: WarenSupersession): boolean {
  return e.superseded === true || Boolean(e.supersededById || e.supersededByReference);
}
