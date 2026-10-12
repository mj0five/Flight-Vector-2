# Validation status — 2026-10-12

## Completed

Source review and six synthetic engine assertions passed via `node tests/engine.test.cjs`: zero speed at ideal rest; known constant horizontal acceleration after calibration; missing-attitude speed blocked; missing-axis input rejected; 90-degree yaw rotation; deterministic sensitivity sampling.

The original engine is unchanged. These checks are deliberately limited. Browser UI, actual CSV logs, barometer fusion accuracy, noisy sensors, time gaps and physical flight performance have not been validated in this preparation.

## Required before accuracy claims

1. Specify firmware, sensor frame, handedness, angle/time/acceleration/barometer units; replace ambiguous heuristics with explicit settings.
2. Add synthetic rotated-rest, vertical-motion, bias, noise, invalid-sample and time-gap cases; verify the full output against analytic expectations.
3. Verify calibration stationarity and initial velocity assumptions. Define rejection rules for invalid inputs.
4. Obtain consented, sanitized, time-synchronized IMU/attitude and independent reference ground velocity (for example GNSS with documented quality). Distinguish ground speed from airspeed.
5. Compare each velocity component and speed magnitude over the full trajectory. Report bias, RMSE, percentiles, drift versus duration, reference uncertainty and synchronization error, not just the maximum speed.
6. Use multiple flights and held-out data with different maneuvers; publish failures and parameter sensitivity. Barometer aiding needs a separate vertical reference assessment.

## Historical results

The original Persian README listed a 242,484-sample log and nominal peaks. That dataset is absent from the supplied folder. Those figures cannot be reproduced here and are not included as accuracy evidence in the new README. The original source folder remains unchanged.
