# Street Intelligence field-test checklist

Owner physical validation for the first public freeze. Do not generate synthetic saves. Record each curb from a real parked vehicle.

Command for automated coverage before a field day:

```
npm run test:street-intel
```

For each location below, fill the columns. Leave a cell blank if that source does not apply.

Columns:

- Auto side correct?
- Manual chooser appeared?
- Cleaning correct?
- Meter correct?
- Prohibition correct?
- SAFE UNTIL correct?
- Active-now state correct?
- Physical sign matches?
- Obvious missing rule?
- Latency acceptable?

## 1. Ordinary alternate-side street

- [ ] Auto side correct?
- [ ] Manual chooser appeared?
- [ ] Cleaning correct?
- [ ] Meter correct?
- [ ] Prohibition correct?
- [ ] SAFE UNTIL correct?
- [ ] Active-now state correct?
- [ ] Physical sign matches?
- [ ] Obvious missing rule?
- [ ] Latency acceptable?

## 2. DAILY / EVERYDAY street cleaning

- [ ] Auto side correct?
- [ ] Manual chooser appeared?
- [ ] Cleaning correct?
- [ ] Meter correct?
- [ ] Prohibition correct?
- [ ] SAFE UNTIL correct?
- [ ] Active-now state correct?
- [ ] Physical sign matches?
- [ ] Obvious missing rule?
- [ ] Latency acceptable?

## 3. Meter + cleaning

- [ ] Auto side correct?
- [ ] Manual chooser appeared?
- [ ] Cleaning correct?
- [ ] Meter correct?
- [ ] Prohibition correct?
- [ ] SAFE UNTIL correct? (must ignore meter hours)
- [ ] Active-now state correct?
- [ ] Physical sign matches?
- [ ] Obvious missing rule?
- [ ] Latency acceptable?

## 4. Meter-only curb

- [ ] Auto side correct?
- [ ] Manual chooser appeared?
- [ ] Cleaning correct? (expect “No street-cleaning schedule found”, not a complete-legal claim)
- [ ] Meter correct?
- [ ] Prohibition correct?
- [ ] SAFE UNTIL correct? (no movement clock from meters)
- [ ] Active-now state correct?
- [ ] Physical sign matches?
- [ ] Obvious missing rule?
- [ ] Latency acceptable?

## 5. Scheduled NO PARKING

- [ ] Auto side correct?
- [ ] Manual chooser appeared?
- [ ] Cleaning correct?
- [ ] Meter correct?
- [ ] Prohibition correct? (label must stay No Parking)
- [ ] SAFE UNTIL correct?
- [ ] Active-now state correct?
- [ ] Physical sign matches?
- [ ] Obvious missing rule?
- [ ] Latency acceptable?

## 6. Scheduled NO STANDING

- [ ] Auto side correct?
- [ ] Manual chooser appeared?
- [ ] Cleaning correct?
- [ ] Meter correct?
- [ ] Prohibition correct? (label must stay No Standing)
- [ ] SAFE UNTIL correct?
- [ ] Active-now state correct?
- [ ] Physical sign matches?
- [ ] Obvious missing rule?
- [ ] Latency acceptable?

## 7. NO PARKING ANYTIME

- [ ] Auto side correct?
- [ ] Manual chooser appeared?
- [ ] Cleaning correct?
- [ ] Meter correct?
- [ ] Prohibition correct?
- [ ] SAFE UNTIL correct? (must not invent an end time)
- [ ] Active-now state correct? (Parking restricted · Anytime)
- [ ] Physical sign matches?
- [ ] Obvious missing rule?
- [ ] Latency acceptable?

## 8. NO STOPPING ANYTIME

- [ ] Auto side correct?
- [ ] Manual chooser appeared?
- [ ] Cleaning correct?
- [ ] Meter correct?
- [ ] Prohibition correct? (label must stay No Stopping)
- [ ] SAFE UNTIL correct? (no future clock)
- [ ] Active-now state correct?
- [ ] Physical sign matches?
- [ ] Obvious missing rule?
- [ ] Latency acceptable?

## 9. Cleaning + prohibition

- [ ] Auto side correct?
- [ ] Manual chooser appeared?
- [ ] Cleaning correct?
- [ ] Meter correct?
- [ ] Prohibition correct?
- [ ] SAFE UNTIL correct? (earliest movement restriction wins)
- [ ] Active-now state correct?
- [ ] Physical sign matches?
- [ ] Obvious missing rule?
- [ ] Latency acceptable?

## 10. Meter + prohibition

- [ ] Auto side correct?
- [ ] Manual chooser appeared?
- [ ] Cleaning correct?
- [ ] Meter correct?
- [ ] Prohibition correct?
- [ ] SAFE UNTIL correct? (meter hours must not win)
- [ ] Active-now state correct?
- [ ] Physical sign matches?
- [ ] Obvious missing rule?
- [ ] Latency acceptable?

## 11. Time-limited parking

- [ ] Auto side correct?
- [ ] Manual chooser appeared?
- [ ] Cleaning correct?
- [ ] Meter correct?
- [ ] Prohibition correct?
- [ ] SAFE UNTIL correct? (duration must not become a move-by countdown unless session start is known)
- [ ] Active-now state correct?
- [ ] Physical sign matches?
- [ ] Obvious missing rule?
- [ ] Latency acceptable?

## 12. Street with ambiguous / single-arrow signage

- [ ] Auto side correct?
- [ ] Manual chooser appeared?
- [ ] Cleaning correct?
- [ ] Meter correct?
- [ ] Prohibition correct? (uncertain extent must be omitted, not guessed)
- [ ] SAFE UNTIL correct?
- [ ] Active-now state correct?
- [ ] Physical sign matches?
- [ ] Obvious missing rule? (omission is acceptable; a confident wrong rule is not)
- [ ] Latency acceptable?

## 13. Street with no known supported rule

- [ ] Auto side correct?
- [ ] Manual chooser appeared?
- [ ] Cleaning correct?
- [ ] Meter correct?
- [ ] Prohibition correct?
- [ ] SAFE UNTIL correct?
- [ ] Active-now state correct?
- [ ] Physical sign matches?
- [ ] Obvious missing rule?
- [ ] Latency acceptable?

## Fail immediately if

- The wrong curb side is shown as high-confidence
- An active prohibition is shown that does not match the sign on that curb
- SAFE UNTIL ignores an earlier supported movement restriction
- Mapbox is broken
- The callable is in a 5xx pattern
- A valid cache permanently blocks newly supported rules
