import React from 'react';
import type { SideConfirmation } from '../../utils/canonicalCurbClient';

type Props = Readonly<{
  confirmation: SideConfirmation;
  onSelect: (candidateToken: string) => void;
  onCancel: () => void;
  loading: boolean;
}>;

const OPPOSITE: Readonly<Record<string, string>> = {
  North: 'South', South: 'North', East: 'West', West: 'East',
};
const AXIS: Readonly<Record<string, string>> = {
  North: 'east-west', South: 'east-west', East: 'north-south', West: 'north-south',
};

export function curbCrossSectionReady(confirmation: SideConfirmation): boolean {
  const [first, second] = confirmation.curbs;
  return confirmation.orientation.north === 'up'
    && first.token !== second.token
    && OPPOSITE[first.cardinal] === second.cardinal
    && AXIS[first.cardinal] === confirmation.orientation.axis
    && AXIS[second.cardinal] === confirmation.orientation.axis;
}

function curbByCardinal(confirmation: SideConfirmation, cardinal: 'North' | 'South' | 'East' | 'West') {
  return confirmation.curbs.find(curb => curb.cardinal === cardinal) ?? null;
}

function CurbButton({
  curb, place, loading, onSelect,
}: Readonly<{
  curb: SideConfirmation['curbs'][number];
  place: 'top' | 'bottom' | 'left' | 'right';
  loading: boolean;
  onSelect: (candidateToken: string) => void;
}>) {
  return (
    <button
      type="button"
      className={`pq-curb-side-choice is-${place}`}
      data-cardinal={curb.cardinal}
      data-place={place}
      data-token={curb.token}
      disabled={loading}
      onClick={() => { if (!loading) onSelect(curb.token); }}
    >
      <span>{curb.cardinal} curb</span>
    </button>
  );
}

export const CurbSideCrossSection: React.FC<Props> = ({
  confirmation, onSelect, onCancel, loading,
}) => {
  if (!curbCrossSectionReady(confirmation)) {
    return (
      <div className="pq-curb-side pq-curb-side-fallback" role="status">
        <p>ParQueen could not distinguish the two curbs here.</p>
        <button type="button" className="pq-curb-side-cancel" onClick={onCancel}>Cancel</button>
      </div>
    );
  }

  const axis = confirmation.orientation.axis;
  const north = curbByCardinal(confirmation, 'North');
  const south = curbByCardinal(confirmation, 'South');
  const west = curbByCardinal(confirmation, 'West');
  const east = curbByCardinal(confirmation, 'East');
  const geographic = axis === 'east-west' ? Boolean(north && south) : Boolean(west && east);
  if (!geographic) {
    return (
      <div className="pq-curb-side pq-curb-side-fallback" role="status">
        <p>ParQueen could not distinguish the two curbs here.</p>
        <button type="button" className="pq-curb-side-cancel" onClick={onCancel}>Cancel</button>
      </div>
    );
  }
  return (
    <div className="pq-curb-side" aria-label="Choose the curb where you parked">
      <p className="pq-curb-side-street">{confirmation.streetName}</p>
      <p className="pq-curb-side-orientation">North is up. The drawing is only a guide.</p>
      <div className={`pq-curb-side-stage is-${axis}`}>
        {axis === 'east-west'
          ? <CurbButton curb={north!} place="top" loading={loading} onSelect={onSelect} />
          : <CurbButton curb={west!} place="left" loading={loading} onSelect={onSelect} />}
        <div className={`pq-curb-side-diagram is-${axis}`} aria-hidden="true">
          <span className="pq-curb-side-north">N</span>
          <span className="pq-curb-side-road" />
        </div>
        {axis === 'east-west'
          ? <CurbButton curb={south!} place="bottom" loading={loading} onSelect={onSelect} />
          : <CurbButton curb={east!} place="right" loading={loading} onSelect={onSelect} />}
      </div>
      <button type="button" className="pq-curb-side-cancel" onClick={onCancel} disabled={loading}>
        Cancel
      </button>
    </div>
  );
};
