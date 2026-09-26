import React, { useEffect, useMemo, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import type { CanonicalCurbCandidate, CanonicalCurbSelector } from '../../utils/canonicalCurbClient';
import { getMapboxToken } from '../../utils/browserCredentials';

type Props = Readonly<{
  selector: CanonicalCurbSelector;
  onSelect: (candidateToken: string) => void;
  loading: boolean;
}>;

const COLORS = ['#4d94ff', '#f5b942'] as const;
const MAX_STROKE_HIT_DISTANCE_PX = 24;
const MIN_WINNING_MARGIN_PX = 4;

function screenSegmentDistance(
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const fraction = lengthSquared === 0 ? 0
    : Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + fraction * dx), point.y - (start.y + fraction * dy));
}

function candidateScreenDistance(
  map: mapboxgl.Map,
  point: { x: number; y: number },
  candidate: CanonicalCurbCandidate,
): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (const line of candidate.stroke.coordinates) {
    for (let index = 1; index < line.length; index += 1) {
      const start = map.project(line[index - 1] as [number, number]);
      const end = map.project(line[index] as [number, number]);
      minimum = Math.min(minimum, screenSegmentDistance(point, start, end));
    }
  }
  return minimum;
}

function distinct(selector: CanonicalCurbSelector): boolean {
  return selector.candidates.length === 2
    && selector.candidates[0].token !== selector.candidates[1].token
    && JSON.stringify(selector.candidates[0].stroke) !== JSON.stringify(selector.candidates[1].stroke);
}

export const VisualCurbSelector: React.FC<Props> = ({ selector, onSelect, loading }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const onSelectRef = useRef(onSelect);
  const loadingRef = useRef(loading);
  onSelectRef.current = onSelect;
  loadingRef.current = loading;
  const usable = useMemo(() => distinct(selector), [selector]);

  useEffect(() => {
    if (!usable || !containerRef.current) return;
    mapboxgl.accessToken = getMapboxToken();
    const dark = typeof document !== 'undefined'
      && document.documentElement.classList.contains('dark');
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: `mapbox://styles/mapbox/${dark ? 'dark' : 'light'}-v11`,
      center: [selector.center.lng, selector.center.lat],
      zoom: 18,
      attributionControl: false,
      interactive: true,
    });
    const click = (event: { point: { x: number; y: number } }) => {
      if (loadingRef.current) return;
      const ranked = selector.candidates
        .map(candidate => ({ candidate, distance: candidateScreenDistance(map, event.point, candidate) }))
        .sort((left, right) => left.distance - right.distance);
      if (ranked[0]
        && ranked[0].distance <= MAX_STROKE_HIT_DISTANCE_PX
        && (!ranked[1] || ranked[1].distance - ranked[0].distance >= MIN_WINNING_MARGIN_PX)) {
        onSelectRef.current(ranked[0].candidate.token);
      }
    };
    const load = () => {
      selector.candidates.forEach((candidate, index) => {
        map.addSource(`curb-candidate-${index}`, {
          type: 'geojson',
          data: { type: 'Feature', properties: {}, geometry: candidate.stroke } as any,
        });
        map.addLayer({
          id: `curb-candidate-${index}`,
          type: 'line',
          source: `curb-candidate-${index}`,
          paint: { 'line-color': COLORS[index], 'line-width': 7, 'line-opacity': 0.92 },
        });
      });
      map.addSource('saved-car', {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: {},
          geometry: { type: 'Point', coordinates: [selector.center.lng, selector.center.lat] },
        },
      });
      map.addLayer({
        id: 'saved-car',
        type: 'circle',
        source: 'saved-car',
        paint: {
          'circle-radius': 7,
          'circle-color': '#ffffff',
          'circle-stroke-width': 3,
          'circle-stroke-color': '#0b182c',
        },
      });
      const bounds = new mapboxgl.LngLatBounds();
      bounds.extend([selector.center.lng, selector.center.lat]);
      selector.candidates.forEach(candidate => candidate.stroke.coordinates
        .forEach(line => line.forEach(point => bounds.extend([point[0], point[1]]))));
      map.fitBounds(bounds, { padding: 30, maxZoom: 19, duration: 0 });
    };
    map.on('load', load);
    map.on('click', click);
    return () => {
      map.off('load', load);
      map.off('click', click);
      map.remove();
    };
  }, [selector, usable]);

  if (!usable) {
    return (
      <div className="pq-curb-selector-fallback" role="status">
        ParQueen could not verify two distinct curbs here.
      </div>
    );
  }

  return (
    <div className="pq-curb-selector" aria-label="Choose the curb where you parked">
      <div ref={containerRef} className="pq-curb-selector-map" aria-hidden="true" />
      <div className="pq-curb-selector-actions">
        {selector.candidates.map((candidate, index) => (
          <button
            type="button"
            key={candidate.token}
            aria-label={`Curb along ${candidate.streetName}`}
            disabled={loading}
            onClick={() => { if (!loading) onSelect(candidate.token); }}
            className="pq-curb-selector-choice"
          >
            <span className={`pq-curb-selector-swatch is-${index}`} aria-hidden="true" />
            <span>{candidate.streetName}</span>
          </button>
        ))}
      </div>
    </div>
  );
};
