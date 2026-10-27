/**
 * Small contextual status chip that replaces the old floating "My Ping" / "My Parked Car" CTA.
 * It only carries state the docked nav cannot show (parked-car distance / arrival, active Ping) and,
 * when tapped, runs the same handlePrimaryMapAction branch the CTA ran. Creating a Ping stays on the
 * centre nav Ping, so there is no chip for the "Ping Your Spot" state.
 */
export const ARRIVED_DISTANCE_LABEL = "You're here";

export interface MapContextChipInput {
    signedIn: boolean;
    hasSavedSpot: boolean;
    /** myCarDistanceLabel from StreetParkingView: "You're here" | "N ft away" | "N.N mi away" | null */
    distanceLabel: string | null;
    hasActivePing: boolean;
    labels: { parkedCar: string; arrived: string; myPing: string };
}

export type MapContextChip = { kind: 'car' | 'ping'; text: string; arrived: boolean } | null;

export function getMapContextChip({ signedIn, hasSavedSpot, distanceLabel, hasActivePing, labels }: MapContextChipInput): MapContextChip {
    if (!signedIn) return null;
    // Same precedence as the old CTA: a My Car session wins over an active Ping.
    if (hasSavedSpot) {
        if (distanceLabel === ARRIVED_DISTANCE_LABEL) return { kind: 'car', text: labels.arrived, arrived: true };
        return { kind: 'car', text: distanceLabel ? `${labels.parkedCar} · ${distanceLabel}` : labels.parkedCar, arrived: false };
    }
    if (hasActivePing) return { kind: 'ping', text: labels.myPing, arrived: false };
    return null;
}
