import {
  SIDE_CONFIRMATION_TOKEN_BODY_MIN,
  SIDE_CONFIRMATION_TOKEN_MAC_LENGTH,
} from './sideConfirmationTokenLimits';

export function sampleSideConfirmationToken(label: string): string {
  const marker = label.replace(/[^A-Za-z0-9]/g, 'X') || 'X';
  const body = `A${marker}`.padEnd(SIDE_CONFIRMATION_TOKEN_BODY_MIN, 'A');
  return `sidec1.${body}.${'B'.repeat(SIDE_CONFIRMATION_TOKEN_MAC_LENGTH)}`;
}
