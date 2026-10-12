(function (root) {
  "use strict";

  const G = 9.80665;
  const RAD = Math.PI / 180;

  function splitCsvLine(line, delimiter) {
    const output = [];
    let value = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"') {
        if (quoted && line[i + 1] === '"') {
          value += '"';
          i += 1;
        } else {
          quoted = !quoted;
        }
      } else if (char === delimiter && !quoted) {
        output.push(value.trim());
        value = "";
      } else {
        value += char;
      }
    }
    output.push(value.trim());
    return output;
  }

  function walkLines(text, start, callback) {
    let position = start || 0;
    let lineNumber = 0;
    while (position < text.length) {
      let end = text.indexOf("\n", position);
      if (end < 0) end = text.length;
      const line = text.slice(position, end).replace(/\r$/, "");
      if (callback(line, position, end, lineNumber) === false) return;
      position = end + 1;
      lineNumber += 1;
    }
  }

  function parseNumber(value, decimalComma) {
    if (value === undefined || value === null || value === "") return NaN;
    const normalized = decimalComma ? value.replace(",", ".") : value;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  function findHeader(text) {
    const metadata = {};
    let header = null;
    let delimiter = ",";
    let dataStart = 0;
    let headerLine = "";

    walkLines(text, 0, (line, position, end) => {
      const candidates = [",", ";", "\t"]
        .map((candidate) => ({ delimiter: candidate, fields: splitCsvLine(line, candidate) }))
        .sort((a, b) => b.fields.length - a.fields.length);
      for (const candidate of candidates) {
        const lower = candidate.fields.map((item) => item.trim().toLowerCase());
        const hasTime = lower.some((item) => ["time", "time (us)", "timeus", "timestamp"].includes(item));
        const hasSensor = lower.some((item) => item.startsWith("acc") || item.startsWith("gyro"));
        if (hasTime && hasSensor) {
          header = candidate.fields.map((item) => item.replace(/^"|"$/g, "").trim());
          delimiter = candidate.delimiter;
          dataStart = end + 1;
          headerLine = line;
          return false;
        }
      }

      const metaFields = splitCsvLine(line, ",");
      if (metaFields.length >= 2) {
        const key = metaFields[0].replace(/^"|"$/g, "").trim();
        const value = metaFields.slice(1).join(",").replace(/^"|"$/g, "").trim();
        if (key) metadata[key] = value;
      }
      if (position > 4_000_000) return false;
      return true;
    });

    if (!header) throw new Error("ردیف عنوان داده‌های Blackbox پیدا نشد.");
    return { metadata, header, delimiter, dataStart, headerLine };
  }

  function columnIndex(header, aliases) {
    const normalized = header.map((item) => item.toLowerCase().replace(/\s+/g, ""));
    for (const alias of aliases) {
      const index = normalized.indexOf(alias.toLowerCase().replace(/\s+/g, ""));
      if (index >= 0) return index;
    }
    return -1;
  }

  function countDataLines(text, start) {
    let count = 0;
    walkLines(text, start, (line) => {
      if (line.trim()) count += 1;
    });
    return count;
  }

  function sampleMedian(values) {
    if (!values.length) return NaN;
    const sorted = Array.from(values).filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return NaN;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : 0.5 * (sorted[middle - 1] + sorted[middle]);
  }

  function standardDeviation(values) {
    const finite = values.filter(Number.isFinite);
    if (finite.length < 2) return 0;
    const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
    return Math.sqrt(finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / finite.length);
  }

  function percentile(values, probability) {
    const sorted = Array.from(values).filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return NaN;
    const position = (sorted.length - 1) * probability;
    const lower = Math.floor(position);
    const fraction = position - lower;
    return sorted[lower + 1] === undefined
      ? sorted[lower]
      : sorted[lower] + fraction * (sorted[lower + 1] - sorted[lower]);
  }

  function detectTimeScale(name, rawTime, length) {
    const lower = name.toLowerCase();
    if (lower.includes("us") || lower === "time") return 1e-6;
    const differences = [];
    const stop = Math.min(length, 5000);
    for (let i = 1; i < stop; i += 1) {
      const difference = rawTime[i] - rawTime[i - 1];
      if (difference > 0) differences.push(difference);
    }
    const typical = sampleMedian(differences);
    if (typical > 20) return 1e-6;
    if (typical > 0.2) return 1e-3;
    return 1;
  }

  function bodyToNavigation(x, y, z, roll, pitch, yaw) {
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    return [
      cy * cp * x + (cy * sp * sr - sy * cr) * y + (cy * sp * cr + sy * sr) * z,
      sy * cp * x + (sy * sp * sr + cy * cr) * y + (sy * sp * cr - cy * sr) * z,
      -sp * x + cp * sr * y + cp * cr * z,
    ];
  }

  function firstSustained(condition, required) {
    let run = 0;
    for (let i = 0; i < condition.length; i += 1) {
      run = condition[i] ? run + 1 : 0;
      if (run >= required) return i - required + 1;
    }
    return -1;
  }

  function centeredAverage(values, halfWindow) {
    const prefix = new Float64Array(values.length + 1);
    const counts = new Uint32Array(values.length + 1);
    for (let i = 0; i < values.length; i += 1) {
      const finite = Number.isFinite(values[i]);
      prefix[i + 1] = prefix[i] + (finite ? values[i] : 0);
      counts[i + 1] = counts[i] + (finite ? 1 : 0);
    }
    const output = new Float64Array(values.length);
    output.fill(NaN);
    for (let i = 0; i < values.length; i += 1) {
      const first = Math.max(0, i - halfWindow);
      const last = Math.min(values.length, i + halfWindow + 1);
      const count = counts[last] - counts[first];
      if (count >= Math.max(3, halfWindow)) output[i] = (prefix[last] - prefix[first]) / count;
    }
    return output;
  }

  function peakOf(values, time, endTime) {
    let value = -Infinity;
    let index = -1;
    for (let i = 0; i < values.length && time[i] <= endTime; i += 1) {
      if (Number.isFinite(values[i]) && values[i] > value) {
        value = values[i];
        index = i;
      }
    }
    return { value: index >= 0 ? value : NaN, time: index >= 0 ? time[index] : NaN, index };
  }

  function downsample(time, series, endTime, limit) {
    let endIndex = 0;
    while (endIndex + 1 < time.length && time[endIndex + 1] <= endTime) endIndex += 1;
    const count = Math.min(limit, endIndex + 1);
    const output = [];
    for (let i = 0; i < count; i += 1) {
      const index = count === 1 ? 0 : Math.round((i * endIndex) / (count - 1));
      const point = { t: time[index] };
      for (const [name, values] of Object.entries(series)) {
        point[name] = Number.isFinite(values[index]) ? values[index] : null;
      }
      output.push(point);
    }
    return output;
  }

  function seededRandom(seed) {
    let state = seed >>> 0;
    return function random() {
      state += 0x6d2b79f5;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  }

  function normalRandom(random) {
    const first = Math.max(Number.EPSILON, random());
    const second = random();
    return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
  }

  function buildMonteCarlo(peakKmh, peakTime, sigmaBias, sigmaThetaRad, sigmaV0) {
    const random = seededRandom(0x46564c32);
    const samples = [];
    for (let i = 0; i < 1200; i += 1) {
      const delta = sigmaV0 * normalRandom(random)
        + peakTime * sigmaBias * normalRandom(random)
        + G * peakTime * sigmaThetaRad * normalRandom(random);
      samples.push(Math.max(0, peakKmh + delta * 3.6));
    }
    return {
      p025: percentile(samples, 0.025),
      p50: percentile(samples, 0.5),
      p975: percentile(samples, 0.975),
      samples: samples.length,
      interpretation: "sensitivity distribution; not a measured confidence interval",
    };
  }

  function analyzeCsvText(text, userSettings, progress) {
    const settings = Object.assign({
      calibrationStart: 0.10,
      calibrationEnd: 2.30,
      lowPassHz: 0,
      performanceEnd: null,
      tiltSigmaDeg: 1,
      initialVelocitySigma: 0.5,
      barometerSigma: 2.5,
      acc1GOverride: null,
    }, userSettings || {});

    const notify = (stage, fraction, detail) => {
      if (typeof progress === "function") progress({ stage, fraction, detail });
    };

    notify("parser", 0.02, "یافتن سربرگ و متادیتا");
    const parsedHeader = findHeader(text.replace(/^\uFEFF/, ""));
    const { metadata, header, delimiter, dataStart } = parsedHeader;
    const decimalComma = delimiter === ";";

    const index = {
      time: columnIndex(header, ["time", "time (us)", "timeus", "timestamp"]),
      ax: columnIndex(header, ["accSmooth[0]", "accADC[0]", "acc[0]", "accX"]),
      ay: columnIndex(header, ["accSmooth[1]", "accADC[1]", "acc[1]", "accY"]),
      az: columnIndex(header, ["accSmooth[2]", "accADC[2]", "acc[2]", "accZ"]),
      gx: columnIndex(header, ["gyroADC[0]", "gyroScaled[0]", "gyroUnfilt[0]", "gyro[0]", "gyroX"]),
      gy: columnIndex(header, ["gyroADC[1]", "gyroScaled[1]", "gyroUnfilt[1]", "gyro[1]", "gyroY"]),
      gz: columnIndex(header, ["gyroADC[2]", "gyroScaled[2]", "gyroUnfilt[2]", "gyro[2]", "gyroZ"]),
      roll: columnIndex(header, ["heading[0]", "roll"]),
      pitch: columnIndex(header, ["heading[1]", "pitch"]),
      yaw: columnIndex(header, ["heading[2]", "yaw"]),
      baro: columnIndex(header, ["baroAlt", "baroAltitude", "altitude"]),
      spx: columnIndex(header, ["setpoint[0]"]),
      spy: columnIndex(header, ["setpoint[1]"]),
      spz: columnIndex(header, ["setpoint[2]"]),
      throttle: columnIndex(header, ["rcCommand[3]", "throttle"]),
      rx: columnIndex(header, ["rxSignalReceived"]),
      failsafe: columnIndex(header, ["failsafePhase"]),
    };

    if (index.time < 0 || index.ax < 0 || index.ay < 0 || index.az < 0) {
      throw new Error("ستون‌های زمان و سه محور شتاب‌سنج برای محاسبه موجود نیستند.");
    }

    const capacity = countDataLines(text, dataStart);
    if (!capacity) throw new Error("هیچ ردیف عددی پس از سربرگ پیدا نشد.");
    const raw = {};
    for (const [name, column] of Object.entries(index)) {
      if (column >= 0) raw[name] = new Float64Array(capacity);
    }

    notify("parser", 0.08, "خواندن نمونه‌ها");
    let length = 0;
    walkLines(text, dataStart, (line) => {
      if (!line.trim()) return true;
      const cells = splitCsvLine(line, delimiter);
      const timeValue = parseNumber(cells[index.time], decimalComma);
      if (!Number.isFinite(timeValue)) return true;
      for (const [name, column] of Object.entries(index)) {
        if (column >= 0) raw[name][length] = parseNumber(cells[column], decimalComma);
      }
      length += 1;
      if (length % 50000 === 0) notify("parser", 0.08 + 0.20 * length / capacity, `${length.toLocaleString()} نمونه`);
      return true;
    });
    if (length < 3) throw new Error("تعداد نمونه‌های معتبر برای انتگرال‌گیری کافی نیست.");
    for (const name of Object.keys(raw)) raw[name] = raw[name].subarray(0, length);

    const timeScale = detectTimeScale(header[index.time], raw.time, length);
    const time = new Float64Array(length);
    const firstRawTime = raw.time[0];
    for (let i = 0; i < length; i += 1) time[i] = (raw.time[i] - firstRawTime) * timeScale;
    const duration = time[length - 1];
    const differences = [];
    for (let i = 1; i < Math.min(length, 20000); i += 1) {
      const difference = time[i] - time[i - 1];
      if (difference > 0) differences.push(difference);
    }
    const medianDt = sampleMedian(differences);
    const p99Dt = percentile(differences, 0.99);
    const maxGap = Math.min(0.1, Math.max(0.002, 5 * medianDt));
    const sampleRate = 1 / medianDt;

    let attitudeInDegrees = false;
    const hasAttitude = raw.roll && raw.pitch && raw.yaw;
    if (hasAttitude) {
      let maximum = 0;
      for (let i = 0; i < Math.min(length, 30000); i += 1) {
        maximum = Math.max(maximum, Math.abs(raw.roll[i]), Math.abs(raw.pitch[i]), Math.abs(raw.yaw[i]));
      }
      attitudeInDegrees = maximum > Math.PI * 2 + 0.25;
      if (attitudeInDegrees) {
        for (let i = 0; i < length; i += 1) {
          raw.roll[i] *= RAD;
          raw.pitch[i] *= RAD;
          raw.yaw[i] *= RAD;
        }
      }
    }

    const warnings = [];
    let acc1G = Number(settings.acc1GOverride) || Number(metadata.acc_1G || metadata.acc1G);
    let accScaleSource = "Blackbox metadata";
    if (!Number.isFinite(acc1G) || acc1G <= 0) {
      const magnitudes = [];
      const fallbackEnd = Math.min(length, Math.max(20, Math.round(sampleRate * 2)));
      for (let i = 0; i < fallbackEnd; i += 1) magnitudes.push(Math.hypot(raw.ax[i], raw.ay[i], raw.az[i]));
      acc1G = sampleMedian(magnitudes);
      accScaleSource = "estimated from initial stationary magnitude";
      warnings.push("acc_1G در متادیتا نبود و از ابتدای لاگ برآورد شد؛ برای دفاع مقدار کالیبره‌شده را وارد کنید.");
    }

    notify("calibration", 0.32, "برآورد بایاس سه محور");
    const calibrationIndices = [];
    for (let i = 0; i < length; i += 1) {
      if (time[i] >= settings.calibrationStart && time[i] <= settings.calibrationEnd) calibrationIndices.push(i);
    }
    if (calibrationIndices.length < 20) {
      throw new Error("بازه کالیبراسیون نمونه کافی ندارد؛ زمان شروع و پایان کالیبراسیون را اصلاح کنید.");
    }

    const residual = [[], [], []];
    for (const i of calibrationIndices) {
      const roll = hasAttitude ? raw.roll[i] : 0;
      const pitch = hasAttitude ? raw.pitch[i] : 0;
      const expected = [
        -Math.sin(pitch) * acc1G,
        Math.sin(roll) * Math.cos(pitch) * acc1G,
        Math.cos(roll) * Math.cos(pitch) * acc1G,
      ];
      residual[0].push(raw.ax[i] - expected[0]);
      residual[1].push(raw.ay[i] - expected[1]);
      residual[2].push(raw.az[i] - expected[2]);
    }
    const biasCounts = residual.map(sampleMedian);
    const biasMps2 = biasCounts.map((value) => value * G / acc1G);

    const blockMeans = [[], [], []];
    const blocks = new Map();
    for (let item = 0; item < calibrationIndices.length; item += 1) {
      const sampleIndex = calibrationIndices[item];
      const block = Math.floor((time[sampleIndex] - settings.calibrationStart) / 0.25);
      if (!blocks.has(block)) blocks.set(block, { sum: [0, 0, 0], count: 0 });
      const entry = blocks.get(block);
      entry.sum[0] += residual[0][item];
      entry.sum[1] += residual[1][item];
      entry.sum[2] += residual[2][item];
      entry.count += 1;
    }
    for (const block of blocks.values()) {
      for (let axis = 0; axis < 3; axis += 1) blockMeans[axis].push(block.sum[axis] / block.count * G / acc1G);
    }
    const blockStdMps2 = blockMeans.map(standardDeviation);

    let performanceEnd = Number(settings.performanceEnd);
    let performanceEndSource = "manual";
    let trackingGate = null;
    const hasTracking = raw.gx && raw.gy && raw.gz && raw.spx && raw.spy && raw.spz;
    if (!Number.isFinite(performanceEnd) || performanceEnd <= 0 || performanceEnd > duration) {
      performanceEnd = duration;
      performanceEndSource = "log end";
      if (hasTracking) {
        const condition = new Uint8Array(length);
        const searchStart = duration * 0.80;
        for (let i = 0; i < length; i += 1) {
          if (time[i] < searchStart) continue;
          const error = Math.hypot(raw.gx[i] - raw.spx[i], raw.gy[i] - raw.spy[i], raw.gz[i] - raw.spz[i]);
          condition[i] = error > 300 ? 1 : 0;
        }
        const gateIndex = firstSustained(condition, Math.max(2, Math.round(0.10 / medianDt)));
        if (gateIndex >= 0) {
          trackingGate = time[gateIndex];
          performanceEnd = trackingGate;
          performanceEndSource = "automatic sustained gyro/setpoint divergence";
        }
      }
      if (performanceEnd === duration && raw.rx) {
        for (let i = 0; i < length; i += 1) {
          if (raw.rx[i] === 0) {
            performanceEnd = time[i];
            performanceEndSource = "receiver validity loss";
            break;
          }
        }
      }
    }

    if (!hasAttitude) {
      warnings.push("سه محور attitude موجود نیستند؛ سرعت برداری برای جلوگیری از عدد ساختگی محاسبه نشد.");
    }

    notify("rotation", 0.40, "چرخش شتاب به دستگاه ناوبری");
    const accelNorm = new Float64Array(length);
    const gyroNorm = new Float64Array(length);
    const horizontalSpeed = new Float64Array(length);
    const imuSpeed3d = new Float64Array(length);
    const aidedSpeed3d = new Float64Array(length);
    const verticalAided = new Float64Array(length);
    horizontalSpeed.fill(NaN);
    imuSpeed3d.fill(NaN);
    aidedSpeed3d.fill(NaN);
    verticalAided.fill(NaN);

    let vx = 0, vy = 0, vz = 0;
    let previousAcceleration = null;
    let filteredAcceleration = null;
    let invalidDtCount = 0;
    let wrongScalarSpeed = 0;
    let previousWrong = null;

    let kalmanState = [0, 0, 0];
    let covariance = [4, 0, 0, 0, 25, 0, 0, 0, 1];
    const accelerationNoise = Math.max(0.05, blockStdMps2[2] || 0.05);
    const qAcceleration = accelerationNoise ** 2;
    const qBias = 1e-6;
    const barometerVariance = Math.max(0.25, Number(settings.barometerSigma) || 2.5) ** 2;
    let barometerBase = 0;
    let previousBarometer = NaN;
    let lastBarometerUpdate = -Infinity;
    let barometerUpdates = 0;
    if (raw.baro) {
      barometerBase = sampleMedian(calibrationIndices.map((i) => raw.baro[i])) * 0.01;
    }

    for (let i = 0; i < length; i += 1) {
      const roll = hasAttitude ? raw.roll[i] : 0;
      const pitch = hasAttitude ? raw.pitch[i] : 0;
      const yaw = hasAttitude ? raw.yaw[i] : 0;
      const rawFx = raw.ax[i] * G / acc1G;
      const rawFy = raw.ay[i] * G / acc1G;
      const rawFz = raw.az[i] * G / acc1G;
      const fx = (raw.ax[i] - biasCounts[0]) * G / acc1G;
      const fy = (raw.ay[i] - biasCounts[1]) * G / acc1G;
      const fz = (raw.az[i] - biasCounts[2]) * G / acc1G;
      const specificNorm = Math.hypot(rawFx, rawFy, rawFz);
      const wrongAcceleration = Math.max(specificNorm - G, 0);
      const dt = i ? time[i] - time[i - 1] : 0;
      if (i && dt > 0 && dt <= 0.1 && previousWrong !== null) {
        wrongScalarSpeed += 0.5 * (previousWrong + wrongAcceleration) * dt;
      }
      previousWrong = wrongAcceleration;

      const rotated = bodyToNavigation(fx, fy, fz, roll, pitch, yaw);
      let dynamic = [rotated[0], rotated[1], rotated[2] - G];
      if (Number(settings.lowPassHz) > 0 && i > 0 && dt > 0) {
        const alpha = Math.exp(-2 * Math.PI * Number(settings.lowPassHz) * dt);
        if (!filteredAcceleration) filteredAcceleration = dynamic.slice();
        filteredAcceleration = filteredAcceleration.map((previous, axis) => alpha * previous + (1 - alpha) * dynamic[axis]);
        dynamic = filteredAcceleration.slice();
      }
      accelNorm[i] = Math.hypot(dynamic[0], dynamic[1], dynamic[2]);
      gyroNorm[i] = raw.gx ? Math.hypot(raw.gx[i], raw.gy[i], raw.gz[i]) : 0;

      if (!hasAttitude || time[i] > performanceEnd) continue;
      if (i === 0) {
        horizontalSpeed[i] = 0;
        imuSpeed3d[i] = 0;
        aidedSpeed3d[i] = 0;
        verticalAided[i] = 0;
        previousAcceleration = dynamic;
        continue;
      }
      if (!(dt > 0) || dt > maxGap) {
        invalidDtCount += 1;
        previousAcceleration = dynamic;
        continue;
      }

      vx += 0.5 * (previousAcceleration[0] + dynamic[0]) * dt;
      vy += 0.5 * (previousAcceleration[1] + dynamic[1]) * dt;
      vz += 0.5 * (previousAcceleration[2] + dynamic[2]) * dt;
      previousAcceleration = dynamic;

      if (raw.baro) {
        const [h, vertical, bias] = kalmanState;
        const dt2 = dt * dt;
        kalmanState = [h + vertical * dt + 0.5 * (dynamic[2] - bias) * dt2, vertical + (dynamic[2] - bias) * dt, bias];
        const F = [1, dt, -0.5 * dt2, 0, 1, -dt, 0, 0, 1];
        const temporary = new Array(9).fill(0);
        const predicted = new Array(9).fill(0);
        for (let row = 0; row < 3; row += 1) {
          for (let column = 0; column < 3; column += 1) {
            for (let inner = 0; inner < 3; inner += 1) temporary[row * 3 + column] += F[row * 3 + inner] * covariance[inner * 3 + column];
          }
        }
        for (let row = 0; row < 3; row += 1) {
          for (let column = 0; column < 3; column += 1) {
            for (let inner = 0; inner < 3; inner += 1) predicted[row * 3 + column] += temporary[row * 3 + inner] * F[column * 3 + inner];
          }
        }
        const gainVector = [0.5 * dt2, dt, 0];
        for (let row = 0; row < 3; row += 1) {
          for (let column = 0; column < 3; column += 1) predicted[row * 3 + column] += qAcceleration * gainVector[row] * gainVector[column];
        }
        predicted[8] += qBias * dt;
        covariance = predicted;

        const barometer = raw.baro[i];
        const canUpdate = Number.isFinite(barometer)
          && time[i] - lastBarometerUpdate >= 0.02
          && (barometer !== previousBarometer || time[i] - lastBarometerUpdate >= 0.04);
        if (canUpdate) {
          const measurement = barometer * 0.01 - barometerBase;
          const innovation = measurement - kalmanState[0];
          const denominator = covariance[0] + barometerVariance;
          const gain = [covariance[0] / denominator, covariance[3] / denominator, covariance[6] / denominator];
          kalmanState = kalmanState.map((value, axis) => value + gain[axis] * innovation);
          const firstRow = [covariance[0], covariance[1], covariance[2]];
          for (let row = 0; row < 3; row += 1) {
            for (let column = 0; column < 3; column += 1) covariance[row * 3 + column] -= gain[row] * firstRow[column];
          }
          covariance[3] = covariance[1] = 0.5 * (covariance[1] + covariance[3]);
          covariance[6] = covariance[2] = 0.5 * (covariance[2] + covariance[6]);
          covariance[7] = covariance[5] = 0.5 * (covariance[5] + covariance[7]);
          previousBarometer = barometer;
          lastBarometerUpdate = time[i];
          barometerUpdates += 1;
        }
      } else {
        kalmanState[1] = vz;
      }

      horizontalSpeed[i] = Math.hypot(vx, vy);
      imuSpeed3d[i] = Math.hypot(vx, vy, vz);
      verticalAided[i] = kalmanState[1];
      aidedSpeed3d[i] = Math.hypot(vx, vy, kalmanState[1]);
      if (i % 50000 === 0) notify("integration", 0.45 + 0.30 * i / length, `${i.toLocaleString()} نمونه`);
    }

    notify("uncertainty", 0.80, "محاسبه قله پایدار و حساسیت");
    const halfWindow = Math.max(1, Math.round(0.5 / medianDt));
    const sustainedSpeed = centeredAverage(imuSpeed3d, halfWindow);
    const samplePeak = peakOf(imuSpeed3d, time, performanceEnd);
    const sustainedPeak = peakOf(sustainedSpeed, time, performanceEnd);
    const horizontalPeak = peakOf(horizontalSpeed, time, performanceEnd);
    const aidedPeak = peakOf(aidedSpeed3d, time, performanceEnd);
    const sigmaBias = Math.hypot(blockStdMps2[0], blockStdMps2[1]) / Math.sqrt(2);
    const sigmaThetaRad = Math.max(0, Number(settings.tiltSigmaDeg) || 0) * RAD;
    const peakTime = Number.isFinite(sustainedPeak.time) ? sustainedPeak.time : 0;
    const sigmaVelocity = Math.sqrt(
      Number(settings.initialVelocitySigma) ** 2
      + (peakTime * sigmaBias) ** 2
      + (G * peakTime * sigmaThetaRad) ** 2
    );
    const monteCarlo = buildMonteCarlo((sustainedPeak.value || 0) * 3.6, peakTime, sigmaBias, sigmaThetaRad, Number(settings.initialVelocitySigma));

    let takeoffTime = NaN;
    if (raw.throttle) {
      const condition = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) condition[i] = raw.throttle[i] > 1050 ? 1 : 0;
      const takeoffIndex = firstSustained(condition, Math.max(2, Math.round(0.10 / medianDt)));
      if (takeoffIndex >= 0) takeoffTime = time[takeoffIndex];
    }

    let peakHeight = NaN;
    if (raw.baro) {
      peakHeight = -Infinity;
      for (let i = 0; i < length && time[i] <= performanceEnd; i += 1) {
        peakHeight = Math.max(peakHeight, raw.baro[i] * 0.01 - barometerBase);
      }
    }

    const uncertaintySeries = new Float64Array(length);
    for (let i = 0; i < length; i += 1) {
      uncertaintySeries[i] = Math.sqrt(
        Number(settings.initialVelocitySigma) ** 2
        + (time[i] * sigmaBias) ** 2
        + (G * time[i] * sigmaThetaRad) ** 2
      );
    }

    const chart = downsample(time, {
      acceleration: accelNorm,
      gyro: gyroNorm,
      speed: imuSpeed3d,
      sustained: sustainedSpeed,
      horizontal: horizontalSpeed,
      aided: aidedSpeed3d,
      vertical: verticalAided,
      uncertainty: uncertaintySeries,
    }, performanceEnd, 1400);

    const stages = [
      {
        id: "parser",
        title: "پارسر، زمان و واحد",
        formula: "Δtₖ = (Tₖ − Tₖ₋₁) × timeScale",
        code: "dt = (time[k] - time[k - 1]) * timeScale;",
        reason: "انتگرال فقط با زمان واقعی و واحد سازگار معنا دارد؛ نرخ اسمی نمی‌تواند افت فریم را نشان دهد.",
        input: `${length.toLocaleString()} ردیف CSV`,
        output: `Δt میانه ${(medianDt * 1000).toFixed(3)} ms · ${invalidDtCount} فاصله ردشده`,
        state: "ok",
      },
      {
        id: "calibration",
        title: "کالیبراسیون و حذف بایاس",
        formula: "bₐ = medianₖ∈S(a_raw,ₖ − acc_1G·Rᵀe_z)",
        code: "specificForceBody = (rawAcc - biasCounts) * g / acc1G;",
        reason: "یک بایاس ثابت پس از انتگرال‌گیری متناسب با زمان به خطای سرعت تبدیل می‌شود؛ میانه در برابر ضربه مقاوم‌تر است.",
        input: `${settings.calibrationStart.toFixed(2)} تا ${settings.calibrationEnd.toFixed(2)} s`,
        output: `bias [${biasCounts.map((value) => value.toFixed(3)).join(", ")}] count`,
        state: "ok",
      },
      {
        id: "rotation",
        title: "چرخش نگرش",
        formula: "aⁿ_pre = Rz(ψ)·Ry(θ)·Rx(φ)·fᵇ",
        code: "aNavPre = bodyToNavigation(fBody, roll, pitch, yaw);",
        reason: "گرانش و حرکت باید پیش از تفریق در یک دستگاه مختصات قرار گیرند.",
        input: hasAttitude ? `roll/pitch/yaw (${attitudeInDegrees ? "converted from degrees" : "radian"})` : "attitude unavailable",
        output: hasAttitude ? "بردار شتاب در دستگاه ناوبری" : "سرعت عمداً مسدود شد",
        state: hasAttitude ? "ok" : "blocked",
      },
      {
        id: "gravity",
        title: "حذف گرانش",
        formula: "aⁿ_dyn = aⁿ_pre − [0, 0, g]ᵀ",
        code: "aDynamic = [aNav[0], aNav[1], aNav[2] - 9.80665];",
        reason: "کم‌کردن g از اندازه بردار یا از محور ثابت بدنه، هنگام تغییر وضعیت پهپاد نادرست است.",
        input: "شتاب چرخانده‌شده",
        output: "شتاب دینامیکی علامت‌دار",
        state: hasAttitude ? "ok" : "blocked",
      },
      {
        id: "filter",
        title: "فیلتر و کنترل اعتبار",
        formula: Number(settings.lowPassHz) > 0 ? "α = exp(−2πf_cΔt),  a_f = αa_f,prev + (1−α)a_dyn" : "a_f = a_dyn  (accSmooth already filtered by FC)",
        code: Number(settings.lowPassHz) > 0 ? "alpha = Math.exp(-2 * Math.PI * cutoffHz * dt);" : "filteredAcceleration = dynamicAcceleration;",
        reason: "فیلتر باید نویز پر‌فرکانس را کم کند، بدون آنکه بایاس یا حرکت واقعی را پنهان کند؛ فاصله زمانی نامعتبر حذف می‌شود.",
        input: header[index.ax],
        output: Number(settings.lowPassHz) > 0 ? `پایین‌گذر ${Number(settings.lowPassHz).toFixed(1)} Hz` : "بدون فیلتر اضافه",
        state: "ok",
      },
      {
        id: "integration",
        title: "انتگرال‌گیری مقید",
        formula: "vₖ = vₖ₋₁ + ½(aₖ₋₁ + aₖ)Δtₖ",
        code: "velocity += 0.5 * (aPrev + aNow) * dt;",
        reason: "قاعده ذوزنقه خطای گسسته‌سازی کمتری از اویلر رو به جلو دارد و علامت ترمزگیری را حفظ می‌کند.",
        input: "شتاب دینامیکی و Δt معتبر",
        output: hasAttitude ? `بردار v تا ${performanceEnd.toFixed(3)} s` : "محاسبه نشد",
        state: hasAttitude ? "ok" : "blocked",
      },
      {
        id: "drift",
        title: "تصحیح رانش",
        formula: "x=[h,v_z,b_z]ᵀ;  K=PHᵀ(HPHᵀ+R)⁻¹",
        code: "verticalState = kalmanPredictAndUpdate(aZ, baroAltitude);",
        reason: "بارومتر فقط ارتفاع و سرعت عمودی را مقید می‌کند؛ بدون GPS یا optical flow تصحیح افقی قابل دفاع نیست.",
        input: raw.baro ? `${barometerUpdates.toLocaleString()} به‌روزرسانی بارومتر` : "بدون بارومتر",
        output: raw.baro ? "v_z کمک‌گرفته از بارومتر" : "v_z انتگرالی",
        state: raw.baro ? "ok" : "warning",
      },
      {
        id: "speed",
        title: "سرعت و قله پایدار",
        formula: "s₃D=√(vₓ²+vᵧ²+v_z²),  s_km/h=3.6·s_m/s",
        code: "sustained = centeredMovingAverage(speed3d, 1.0);",
        reason: "قله یک‌ثانیه‌ای اثر تک‌نمونه‌ها را کم می‌کند؛ قله نمونه‌ای برای ممیزی جداگانه نگه داشته می‌شود.",
        input: "بردار سرعت",
        output: hasAttitude ? `${(sustainedPeak.value * 3.6).toFixed(1)} km/h در ${sustainedPeak.time.toFixed(3)} s` : "نامعتبر",
        state: hasAttitude ? "ok" : "blocked",
      },
      {
        id: "uncertainty",
        title: "عدم‌قطعیت و حساسیت",
        formula: "σᵥ² ≈ σᵥ₀² + (tσ_ba)² + (gtσ_θ)²",
        code: "sigmaV = Math.hypot(sigmaV0, t*sigmaBias, g*t*sigmaTheta);",
        reason: "خطای کوچک بایاس یا نگرش در انتگرال بلندمدت رشد می‌کند؛ عدد سرعت بدون این بازه بیش‌ازحد قطعی به نظر می‌رسد.",
        input: `σθ=${Number(settings.tiltSigmaDeg).toFixed(2)}° · σba=${sigmaBias.toFixed(3)} m/s²`,
        output: `±${(sigmaVelocity * 3.6).toFixed(1)} km/h حساسیت یک‌سیگما`,
        state: "warning",
      },
    ];

    const result = {
      version: "2.0.0",
      metadata,
      header,
      columns: index,
      settings,
      constants: { gravity: G, acc1G, accScaleSource, timeScale, maxGap },
      coverage: {
        accelerometer: true,
        gyroscope: Boolean(raw.gx && raw.gy && raw.gz),
        attitude: Boolean(hasAttitude),
        barometer: Boolean(raw.baro),
        setpoint: Boolean(raw.spx && raw.spy && raw.spz),
        throttle: Boolean(raw.throttle),
      },
      timing: { samples: length, duration, medianDt, p99Dt, sampleRate, invalidDtCount },
      calibration: { biasCounts, biasMps2, blockStdMps2, sampleCount: calibrationIndices.length },
      validity: { performanceEnd, performanceEndSource, trackingGate, takeoffTime },
      filter: { source: header[index.ax], lowPassHz: Number(settings.lowPassHz) || 0 },
      drift: {
        horizontalAnchor: false,
        verticalBarometerUpdates: barometerUpdates,
        model: raw.baro ? "3-state vertical Kalman [height, vertical speed, accel bias]" : "unconstrained vertical integration",
      },
      metrics: {
        samplePeakKmh: samplePeak.value * 3.6,
        samplePeakTime: samplePeak.time,
        sustainedPeakKmh: sustainedPeak.value * 3.6,
        sustainedPeakTime: sustainedPeak.time,
        horizontalPeakKmh: horizontalPeak.value * 3.6,
        horizontalPeakTime: horizontalPeak.time,
        aided3dPeakKmh: aidedPeak.value * 3.6,
        aided3dPeakTime: aidedPeak.time,
        peakHeight,
        wrongScalarEndKmh: wrongScalarSpeed * 3.6,
      },
      uncertainty: {
        sigmaBias,
        sigmaThetaDeg: Number(settings.tiltSigmaDeg),
        sigmaVelocityKmh: sigmaVelocity * 3.6,
        tiltOnlyKmh: G * peakTime * Math.sin(sigmaThetaRad) * 3.6,
        monteCarlo,
        confidence: hasAttitude ? "LOW — no independent horizontal reference" : "INVALID — attitude missing",
      },
      stages,
      warnings,
      chart,
    };

    notify("done", 1, "تحلیل کامل شد");
    return result;
  }

  const api = { analyzeCsvText, findHeader, splitCsvLine, bodyToNavigation };
  root.FlightVectorEngine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
