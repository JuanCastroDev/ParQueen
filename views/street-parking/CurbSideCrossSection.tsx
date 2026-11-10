import React from 'react';
import type { SideConfirmation } from '../../utils/canonicalCurbClient';
import {
  type CurbCardinal,
  curbScreenPosition,
  obliqueCardinalsMatch,
  OPPOSITE,
} from '../../utils/curbOrientation';
import { streetIntelClientFeaturesEnabled } from '../../utils/streetIntelClientFeatures';

type Props = Readonly<{
  confirmation: SideConfirmation;
  onSelect: (candidateToken: string) => void;
  onCancel: () => void;
  loading: boolean;
  allowDiagonalCurbDrawing?: boolean;
}>;

const AXIS: Readonly<Record<string, string>> = {
  North: 'east-west', South: 'east-west', East: 'north-south', West: 'north-south',
};

export function curbCrossSectionReady(
  confirmation: SideConfirmation,
  options: Readonly<{ allowDiagonalCurbDrawing?: boolean }> = {},
): boolean {
  const [first, second] = confirmation.curbs;
  if (confirmation.orientation.north !== 'up' || first.token === second.token) return false;
  if (OPPOSITE[first.cardinal] !== second.cardinal) return false;
  if (confirmation.orientation.axis === 'oblique') {
    const allowDiagonal = options.allowDiagonalCurbDrawing ?? streetIntelClientFeaturesEnabled();
    const hasDrivingChoice = Boolean(first.drivingSide && second.drivingSide && first.drivingSide !== second.drivingSide);
    if (!allowDiagonal && !hasDrivingChoice) return false;
    return obliqueCardinalsMatch(
      confirmation.orientation.bearingDegrees,
      first.cardinal,
      second.cardinal,
    );
  }
  return AXIS[first.cardinal] === confirmation.orientation.axis
    && AXIS[second.cardinal] === confirmation.orientation.axis;
}

function curbByCardinal(confirmation: SideConfirmation, cardinal: CurbCardinal) {
  return confirmation.curbs.find(curb => curb.cardinal === cardinal) ?? null;
}

function CurbButton({
  curb, place, loading, onSelect, style,
}: Readonly<{
  curb: SideConfirmation['curbs'][number];
  place: 'top' | 'bottom' | 'left' | 'right' | 'oblique';
  loading: boolean;
  onSelect: (candidateToken: string) => void;
  style?: React.CSSProperties;
}>) {
  return (
    <button
      type="button"
      className={`pq-curb-side-choice is-${place}`}
      data-cardinal={curb.cardinal}
      data-place={place}
      style={style}
      disabled={loading}
      onClick={() => { if (!loading) onSelect(curb.token); }}
    >
      <span>{curb.cardinal} curb</span>
    </button>
  );
}

function Fallback({ onCancel }: Readonly<{ onCancel: () => void }>) {
  return (
    <div className="pq-curb-side pq-curb-side-fallback" role="status">
      <p>ParQueen could not distinguish the two curbs here.</p>
      <button type="button" className="pq-curb-side-cancel" onClick={onCancel}>Cancel</button>
    </div>
  );
}

export const CurbSideCrossSection: React.FC<Props> = ({
  confirmation, onSelect, onCancel, loading,
  allowDiagonalCurbDrawing = streetIntelClientFeaturesEnabled(),
}) => {
  const [chosenSide, setChosenSide] = React.useState<'left' | 'right' | null>(null);
  React.useEffect(() => {
    if (!loading) setChosenSide(null);
  }, [loading]);
  if (!curbCrossSectionReady(confirmation, { allowDiagonalCurbDrawing })) return <Fallback onCancel={onCancel} />;

  const left = confirmation.curbs.find(curb => curb.drivingSide === 'left');
  const right = confirmation.curbs.find(curb => curb.drivingSide === 'right');
  if (left && right) {
    const choose = (side: 'left' | 'right', token: string) => {
      if (loading || chosenSide) return;
      setChosenSide(side);
      onSelect(token);
    };
    return (
      <div className="pq-curb-side" aria-label="Which side did you park on?">
        <p className="pq-curb-side-reminder">Which side did you park on?</p>
        <p className="pq-curb-side-orientation">Facing the direction of traffic</p>
        <div className="pq-curb-driving-actions">
          <button
            type="button"
            className="pq-curb-driving-choice"
            data-driving-side="left"
            aria-pressed={chosenSide === 'left'}
            disabled={loading || chosenSide !== null}
            onClick={() => choose('left', left.token)}
          >
            ← Left side
          </button>
          <button
            type="button"
            className="pq-curb-driving-choice"
            data-driving-side="right"
            aria-pressed={chosenSide === 'right'}
            disabled={loading || chosenSide !== null}
            onClick={() => choose('right', right.token)}
          >
            Right side →
          </button>
        </div>
        <button type="button" className="pq-curb-side-cancel" onClick={onCancel}>Cancel</button>
      </div>
    );
  }

  const reminder = (
    <p className="pq-curb-side-reminder">Choose the side where your vehicle is parked.</p>
  );
  const cancel = (
    <button type="button" className="pq-curb-side-cancel" onClick={onCancel} disabled={loading}>
      Cancel
    </button>
  );

  if (confirmation.orientation.axis === 'oblique') {
    if (!allowDiagonalCurbDrawing) return <Fallback onCancel={onCancel} />;
    const bearing = confirmation.orientation.bearingDegrees;
    const placed = confirmation.curbs.map(curb => ({
      curb,
      position: curbScreenPosition(bearing, curb.cardinal),
    }));
    if (placed.some(item => !item.position)) return <Fallback onCancel={onCancel} />;
    return (
      <div className="pq-curb-side" aria-label="Choose the curb where you parked">
        <p className="pq-curb-side-street">{confirmation.streetName}</p>
        <p className="pq-curb-side-orientation">North is up. The road is drawn at its actual angle.</p>
        {reminder}
        <div className="pq-curb-side-stage is-oblique">
          <div className="pq-curb-side-diagram is-oblique" aria-hidden="true">
            <span className="pq-curb-side-north">N</span>
            <span
              className="pq-curb-side-road"
              style={{ transform: `translate(-50%, -50%) rotate(${bearing - 90}deg)` }}
            />
          </div>
          {placed.map(item => (
            <CurbButton
              key={item.curb.cardinal}
              curb={item.curb}
              place="oblique"
              loading={loading}
              onSelect={onSelect}
              style={{
                left: `${item.position!.x}%`,
                top: `${item.position!.y}%`,
                ['--curb-x' as string]: String(item.position!.x),
              }}
            />
          ))}
        </div>
        {cancel}
      </div>
    );
  }

  const axis = confirmation.orientation.axis;
  const north = curbByCardinal(confirmation, 'North');
  const south = curbByCardinal(confirmation, 'South');
  const west = curbByCardinal(confirmation, 'West');
  const east = curbByCardinal(confirmation, 'East');
  const geographic = axis === 'east-west' ? Boolean(north && south) : Boolean(west && east);
  if (!geographic) return <Fallback onCancel={onCancel} />;
  return (
    <div className="pq-curb-side" aria-label="Choose the curb where you parked">
      <p className="pq-curb-side-street">{confirmation.streetName}</p>
      <p className="pq-curb-side-orientation">North is up. The drawing is only a guide.</p>
      {reminder}
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
      {cancel}
    </div>
  );
};
