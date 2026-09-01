/**
 * Host bin-packing for Sub8 desks. Pure arithmetic: which host has room for a
 * reservation. No DigitalOcean, no Docker, no billing — the Worker vendors this
 * and the desktop never needs it.
 */

/** A desk host as the placer sees it. Capacities are *usable* (after
 * usableHost), reservations are the sum of what is already placed. */
export interface HostSnapshot {
  id: string;
  ramMb: number;
  diskGb: number;
  milliCpus: number;
  reservedRamMb: number;
  reservedDiskGb: number;
  reservedMilliCpus: number;
  /** One desk per host: never co-tenant, even when empty. */
  dedicated: boolean;
  /** Not compared here; the caller filters hosts by region first. */
  region: string;
}

/** What one desk needs from a host. */
export interface Reservation {
  ramMb: number;
  diskGb: number;
  milliCpus: number;
  dedicated: boolean;
}

/** RAM kept for the host OS, Docker, and the desk agent. */
export const HOST_RAM_RESERVE_MB = 2048;
/** Disk kept for the OS image, Docker layers, and logs. */
export const HOST_DISK_RESERVE_GB = 30;
/** CPU kept for the host itself. */
export const HOST_CPU_RESERVE_MILLI = 200;
/** Desks are bursty; CPU may be promised 1.5× over. RAM and disk never are. */
export const CPU_OVERSUBSCRIBE = 1.5;

/** Raw droplet capacity → what desks may be packed into. */
export function usableHost(
  ramMb: number,
  diskGb: number,
  milliCpus: number,
): { ramMb: number; diskGb: number; milliCpus: number } {
  return {
    ramMb: Math.max(0, ramMb - HOST_RAM_RESERVE_MB),
    diskGb: Math.max(0, diskGb - HOST_DISK_RESERVE_GB),
    milliCpus: Math.max(0, milliCpus - HOST_CPU_RESERVE_MILLI),
  };
}

function isEmpty(host: HostSnapshot): boolean {
  return host.reservedRamMb === 0 && host.reservedDiskGb === 0 && host.reservedMilliCpus === 0;
}

/** Does this host have room for the reservation? Region is the caller's job. */
export function hostFits(host: HostSnapshot, want: Reservation): boolean {
  if (host.dedicated || want.dedicated) {
    // A dedicated pairing is the whole box or nothing: any existing tenant
    // counts, and there is no cpu oversubscription to lean on.
    return (
      isEmpty(host) &&
      host.ramMb >= want.ramMb &&
      host.diskGb >= want.diskGb &&
      host.milliCpus >= want.milliCpus
    );
  }
  return (
    host.reservedRamMb + want.ramMb <= host.ramMb &&
    host.reservedDiskGb + want.diskGb <= host.diskGb &&
    host.reservedMilliCpus + want.milliCpus <= host.milliCpus * CPU_OVERSUBSCRIBE
  );
}

/** Tightest fit: among hosts with room, the one with the least RAM left. */
export function pickHost(hosts: readonly HostSnapshot[], want: Reservation): HostSnapshot | null {
  const fits = hosts.filter((h) => hostFits(h, want));
  if (fits.length === 0) return null;
  const remaining = (h: HostSnapshot) => h.ramMb - h.reservedRamMb;
  fits.sort((a, b) => remaining(a) - remaining(b));
  return fits[0] ?? null;
}
