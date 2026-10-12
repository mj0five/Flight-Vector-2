# Flight Vector 2

**Experimental · Unvalidated** — a local Betaflight Blackbox CSV analyzer for exploring velocity reconstruction from accelerometer and attitude data. Built by Jey · Vega project family.

This is an offline research prototype. It has not been validated against independent flight velocity measurements. Outputs are model estimates, not verified aircraft speed, airspeed, or flight records. Do not use for flight control or navigation.

## Run

Python 3 and a modern browser are required. No Python packages are needed.

```text
python app.py
```

Open http://127.0.0.1:8766. On Windows, the supplied launcher runs the same server. Analysis runs in a browser worker; the supplied source contains no external data-upload calls.

## Inputs and method

Use a decoded Blackbox CSV with time, three accelerometer axes and three attitude axes. BBL support reads its header and explains conversion; it does not decode flight samples.

The pipeline estimates stationary bias, rotates body-frame specific force using ZYX Euler angles, subtracts gravity, optionally filters acceleration, and integrates with the trapezoidal rule. Optional barometer data constrains vertical motion with a three-state Kalman model. Horizontal velocity remains unanchored. Monte Carlo output is a seeded sensitivity model, not an experimentally calibrated confidence interval.

## Important assumptions and limitations

- Initial velocity is assumed zero. The initial-velocity sigma setting changes sensitivity, not the nominal starting velocity.
- The selected calibration interval must actually be stationary; sample count alone does not establish stationarity.
- A column named `time` is treated as microseconds. Other recognized timestamps use a heuristic.
- Attitude units are inferred from magnitude. Small angles expressed in degrees can be interpreted as radians. Confirm units before interpreting results.
- Axis ordering, handedness, gravity sign and firmware conventions need independent verification.
- `acc_1G` can be supplied or read from metadata; otherwise the initial acceleration magnitude is used as a fallback. This assumes initial stationary data.
- Barometer values are treated as centimeters, including accepted altitude aliases. Barometer aiding does not validate horizontal speed.
- Large or nonpositive time steps are skipped. This is not a reconstruction of missing motion, and results after gaps require caution.
- The automatic end-of-performance rule is a heuristic, not a certified detector of loss of control.
- No public real-flight dataset accompanies this package. Historical numerical outputs from an unavailable log are not presented as validation evidence.

## Tests

With Node.js installed:

```text
node tests/engine.test.cjs
```

These check idealized stationary data, known horizontal acceleration, missing attitude, missing accelerometer axes, a rotation convention and reproducible sensitivity output. Passing them demonstrates limited computational consistency, not real-world accuracy.

See [validation status and plan](docs/VALIDATION.md) and the [Persian project notes](README-fa.md).

## Contributing

Useful contributions include explicit unit configuration, stationary-window detection, input-quality gates, time-gap handling, and time-aligned reference comparisons. Remove private location/device metadata before contributing logs. Describe sensor units, firmware version, orientation conventions and reference uncertainty.

## License

Released under the [MIT License](LICENSE). Copyright (c) 2026 Jey (mj0five). The experimental status and validation limitations documented above remain applicable.

## Why version 2?

I use **2** to mark a software revision, not a second validated flight campaign. In my first implementation, accelerometer bias removal was not handled correctly, and the integrated velocity was substantially overestimated. I chose not to publish that version because I could not defend its results.

During development, I saw a case that the revised pipeline estimated at approximately **269 km/h**, while the first implementation had displayed roughly **Mach 1**. I include this comparison to show the scale of the earlier computational error, not to claim that 269 km/h was the aircraft's verified speed. Mach depends on local speed of sound and atmospheric conditions, so this historical description is not an exact conversion. I have not included the V1 source or the dataset behind this comparison, and I have not independently reproduced it for this release.

For version 2, I revised the calculation pipeline to estimate bias over a stationary interval, rotate body-frame acceleration into the navigation frame, and remove gravity as a vector before integration. These changes address the methodological problems I identified. I still need independent reference data to validate real-flight accuracy.
